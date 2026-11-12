/**
 * services/reports/icecream-funds-report.ts - the Ice Cream fund statement: per fund per period how the balance moved,
 * with recognized profit and excess cost in a SEPARATE block (BUSINESS_RULES 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, C4).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only).
 *
 * The two measures are never mixed (10.1):
 *  - FUND BALANCES come from the append-only fund ledger (`icecream_fund_entries`): per fund
 *      closing = opening + allocations + opening/capital/transfers in + moves in - moves out - payments - drawings
 *                - transfers out +/- cash over/short.
 *    The three closings add up to the Ice Cream cash book (checked per row: `reconciled`).
 *  - RECOGNIZED PROFIT, excess cost not yet charged and profit after excess cost come from the pure rules module
 *    (`periodReport`, 10.3/10.6) and are returned in `profit`, apart from the balances. A fund balance is never income.
 * How ledger rows are classified: a reversal row (a void, R1) takes the kind of the row it reverses, and a reversed
 * internal move keeps its original direction, so a voided record nets to zero inside its own period.
 * Fund moves into Profit also report the profit-eligible and cash-only parts of the move records (D4, 10.4); they come
 * from the move records the server saved (posted ones only) - the split is never recalculated here.
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import type { IceFund } from '../../repositories/cash-entries.repo.ts';
import { ICE_FUNDS } from '../../repositories/icecream-funds.repo.ts';
import { loadFacts } from '../../repositories/icecream.repo.ts';
import { FUND_LABEL } from '../cash-warnings.ts';
import type { ExcessCostWarning } from '../icecream.service.ts';
import type { IceFacts } from '../icecream-rules.ts';
import { periodReport } from '../icecream-rules.ts';
import type { PeriodReport } from '../icecream-rules.ts';
import { sumByPeriod, sumByPeriodAndGroup, wholePeriod } from './fin-common.ts';
import type { PeriodRow } from './fin-common.ts';
import { excessWarnings } from './pnl-icecream.ts';
import type { PeriodQuery } from './pnl-shop.ts';

type N = number | bigint;

/** How one fund's balance moved in a period. Outflows are positive magnitudes; over/short is signed. */
export interface FundStatement {
  openingCents: number; allocationsCents: number;
  openingBalanceCents: number; capitalCents: number; transfersInCents: number;
  /** Internal moves INTO this fund; for Profit, `profitEligibleCents + cashOnlyCents` = the part that came from releases (D4). */
  movesIn: { totalCents: number; profitEligibleCents: number; cashOnlyCents: number };
  movesOutCents: number; paymentsCents: number; drawingsCents: number; transfersOutCents: number; overShortCents: number;
  closingCents: number;
}

/** The figures of one funds report row. */
export interface FundsFigures {
  funds: Record<IceFund, FundStatement>;
  /** The three funds added up. */
  total: FundStatement;
  /** Ice Cream cash book balance at the period end, and whether Cost + Electricity + Profit equals it (10.1). */
  cashBookClosingCents: number; reconciled: boolean;
  /** Recognized profit and the excess-cost lines of the same period: a separate measure, never part of the balances. */
  profit: PeriodReport;
}

/** The full answer of `GET /reports/icecream-funds`. */
export interface IceCreamFundsReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<FundsFigures>>; totals: FundsFigures;
  table: ReportTable; profitTable: ReportTable; warnings: ExcessCostWarning[];
}

const zeroStatement = (): FundStatement => ({
  openingCents: 0, allocationsCents: 0, openingBalanceCents: 0, capitalCents: 0, transfersInCents: 0,
  movesIn: { totalCents: 0, profitEligibleCents: 0, cashOnlyCents: 0 }, movesOutCents: 0, paymentsCents: 0, drawingsCents: 0,
  transfersOutCents: 0, overShortCents: 0, closingCents: 0,
});

/** Adds statement `b` into `a` (used for the all-funds total). */
function addInto(a: FundStatement, b: FundStatement): void {
  a.openingCents += b.openingCents; a.allocationsCents += b.allocationsCents; a.openingBalanceCents += b.openingBalanceCents;
  a.capitalCents += b.capitalCents; a.transfersInCents += b.transfersInCents;
  a.movesIn.totalCents += b.movesIn.totalCents; a.movesIn.profitEligibleCents += b.movesIn.profitEligibleCents;
  a.movesIn.cashOnlyCents += b.movesIn.cashOnlyCents; a.movesOutCents += b.movesOutCents; a.paymentsCents += b.paymentsCents;
  a.drawingsCents += b.drawingsCents; a.transfersOutCents += b.transfersOutCents; a.overShortCents += b.overShortCents;
  a.closingCents += b.closingCents;
}

/** Figures for each period; opening balances are the fund ledger balances before the first period and are carried forward. */
export function fundsFigures(conn: DatabaseSync, facts: IceFacts, periods: readonly Period[]): FundsFigures[] {
  const from = periods[0]!.from;
  const to = periods[periods.length - 1]!.to;
  const opening: Record<IceFund, number> = { cost: 0, electricity: 0, profit: 0 };
  for (const r of conn.prepare('SELECT fund, COALESCE(SUM(amount_cents), 0) AS t FROM icecream_fund_entries WHERE business_date < ? GROUP BY fund')
    .all(from) as unknown as Array<{ fund: IceFund; t: N }>) opening[r.fund] = Number(r.t);
  // Group key "fund|class": the class is the kind of the row (or of the row it reverses); internal moves also carry their direction.
  const ledger = sumByPeriodAndGroup(conn, periods,
    `SELECT e.business_date AS d,
            e.fund || '|' || CASE WHEN COALESCE(o.kind, e.kind) = 'fund_move'
                                  THEN CASE WHEN COALESCE(o.amount_cents, e.amount_cents) > 0 THEN 'move_in' ELSE 'move_out' END
                                  ELSE COALESCE(o.kind, e.kind) END AS g,
            SUM(e.amount_cents) AS amt
       FROM icecream_fund_entries e LEFT JOIN icecream_fund_entries o ON o.id = e.reverses_entry_id
      WHERE e.business_date BETWEEN ? AND ? GROUP BY e.business_date, g`, [from, to], ['amt'] as const);
  const splits = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(profit_effect_cents) AS eligible, SUM(cash_only_cents) AS cashonly FROM icecream_fund_moves
      WHERE status = 'posted' AND to_fund = 'profit' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
    [from, to], ['eligible', 'cashonly'] as const);
  const cashBookBefore = Number((conn.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM cash_entries WHERE book = 'icecream' AND business_date < ?")
    .get(from) as unknown as { t: N }).t);
  const cashBook = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(amount_cents) AS amt FROM cash_entries WHERE book = 'icecream' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
    [from, to], ['amt'] as const);

  const running = { ...opening };
  let cashRunning = cashBookBefore;
  return periods.map((p, i) => {
    const amt = (fund: IceFund, cls: string): number => ledger.get(`${fund}|${cls}`)?.[i]?.amt ?? 0;
    const funds = {} as Record<IceFund, FundStatement>;
    const total = zeroStatement();
    for (const f of ICE_FUNDS) {
      const s: FundStatement = {
        openingCents: running[f], allocationsCents: amt(f, 'daily_allocation'),
        openingBalanceCents: amt(f, 'opening_balance'), capitalCents: amt(f, 'capital'), transfersInCents: amt(f, 'transfer_in'),
        movesIn: {
          totalCents: amt(f, 'move_in'),
          profitEligibleCents: f === 'profit' ? splits[i]!.eligible : 0, cashOnlyCents: f === 'profit' ? splits[i]!.cashonly : 0,
        },
        movesOutCents: 0 - amt(f, 'move_out'), paymentsCents: 0 - amt(f, 'payment'), drawingsCents: 0 - amt(f, 'drawing'),
        transfersOutCents: 0 - amt(f, 'transfer_out'), overShortCents: amt(f, 'cash_over_short'), closingCents: 0,
      };
      s.closingCents = s.openingCents + s.allocationsCents + s.openingBalanceCents + s.capitalCents + s.transfersInCents
        + s.movesIn.totalCents - s.movesOutCents - s.paymentsCents - s.drawingsCents - s.transfersOutCents + s.overShortCents;
      running[f] = s.closingCents;
      funds[f] = s; addInto(total, s);
    }
    cashRunning += cashBook[i]!.amt;
    return { funds, total, cashBookClosingCents: cashRunning, reconciled: total.closingCents === cashRunning, profit: periodReport(facts, p.from, p.to) };
  });
}

const STATEMENT_COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' }, { key: 'fund', label: 'Fund', kind: 'text' },
  { key: 'opening', label: 'Opening', kind: 'money' }, { key: 'allocations', label: '+ Daily allocations', kind: 'money' },
  { key: 'inflows', label: '+ Opening / capital / transfers in', kind: 'money' }, { key: 'movesIn', label: '+ Moves in', kind: 'money' },
  { key: 'movesOut', label: '- Moves out', kind: 'money' }, { key: 'payments', label: '- Payments', kind: 'money' },
  { key: 'drawings', label: '- Drawings', kind: 'money' }, { key: 'transfersOut', label: '- Transfers out', kind: 'money' },
  { key: 'overShort', label: '+/- Cash over / short', kind: 'money' }, { key: 'closing', label: 'Closing balance', kind: 'money' },
];

function statementRow(period: string, fund: string, s: FundStatement): Record<string, ReportCell> {
  return {
    period, fund, opening: s.openingCents, allocations: s.allocationsCents, inflows: s.openingBalanceCents + s.capitalCents + s.transfersInCents,
    movesIn: s.movesIn.totalCents, movesOut: s.movesOutCents, payments: s.paymentsCents, drawings: s.drawingsCents,
    transfersOut: s.transfersOutCents, overShort: s.overShortCents, closing: s.closingCents,
  };
}

const PROFIT_COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' }, { key: 'dailyShare', label: 'Daily profit shares', kind: 'money' },
  { key: 'releases', label: '+ Profit-eligible releases', kind: 'money' }, { key: 'reallocations', label: '- Re-allocations', kind: 'money' },
  { key: 'other', label: '- Other costs from Profit Fund', kind: 'money' }, { key: 'overShort', label: '+/- Cash over / short', kind: 'money' },
  { key: 'recognized', label: 'Recognized profit', kind: 'money' }, { key: 'excess', label: 'Excess cost not yet charged', kind: 'money' },
  { key: 'afterExcess', label: 'Profit after excess cost', kind: 'money' }, { key: 'outstanding', label: 'Outstanding excess cost at period end', kind: 'money' },
];

function profitRow(period: string, p: PeriodReport): Record<string, ReportCell> {
  return {
    period, dailyShare: p.recognition.dailyProfitShareCents, releases: p.recognition.profitEligibleReleasesCents,
    reallocations: p.recognition.reallocationsCents, other: p.recognition.otherExpensesCents, overShort: p.recognition.cashOverShortCents,
    recognized: p.recognizedProfitCents, excess: p.excessCostNotChargedCents, afterExcess: p.profitAfterExcessCostCents,
    outstanding: p.balancesAsOfPeriodEnd.outstandingExcessCostCents,
  };
}

/**
 * The Ice Cream fund statement for a date range.
 * Totals row: opening = balance before `from`, flows over the whole range, closing = balance at `to`; `profit` holds the
 * recognized-profit block of the whole range (its balances are as of `to`).
 */
export function icecreamFundsReport(conn: DatabaseSync, q: PeriodQuery): IceCreamFundsReport {
  const facts = loadFacts(conn);
  const periods = listPeriods(q.from, q.to, q.granularity);
  const figs = fundsFigures(conn, facts, periods);
  const totals = fundsFigures(conn, facts, [wholePeriod(q.from, q.to)])[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));
  const tableRows: Array<Record<string, ReportCell>> = [];
  for (const r of rows) {
    for (const f of ICE_FUNDS) tableRows.push(statementRow(r.period.label, FUND_LABEL[f], r.funds[f]));
    tableRows.push(statementRow(r.period.label, 'All funds (= cash book)', r.total));
  }
  const table: ReportTable = {
    title: 'Ice Cream fund statement', columns: STATEMENT_COLUMNS, rows: tableRows, totals: statementRow('Total', 'All funds (= cash book)', totals.total),
    notes: [
      'Fund balances are an internal split of the Ice Cream cash book: Cost + Electricity + Profit = the cash book. A fund balance is never income.',
      'Moves between funds move cash allocation only (no cash entry). Only a move INTO Profit can add profit, and only its profit-eligible part (shown in the profit block).',
    ],
  };
  const profitTable: ReportTable = {
    title: 'Recognized profit and excess cost', columns: PROFIT_COLUMNS, rows: rows.map((r) => profitRow(r.period.label, r.profit)),
    totals: profitRow('Total', totals.profit),
    notes: [
      'Recognized profit changes only through the recognition events (daily profit share, profit-eligible releases, re-allocations, other costs from the Profit Fund, over/short).',
      'Outstanding excess cost is a balance at the period end and is not added up; excess cost not yet charged is the change during the period.',
    ],
  };
  return { from: q.from, to: q.to, granularity: q.granularity, rows, totals, table, profitTable, warnings: excessWarnings(facts, q.to) };
}
