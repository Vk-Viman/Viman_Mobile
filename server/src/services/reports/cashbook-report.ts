/**
 * services/reports/cashbook-report.ts - the cash book report: per period opening, money in, money out and closing,
 * per-entry-type totals and, for the Ice Cream book, the same per fund (BUSINESS_RULES 0, 8, 10.1, 10.2, 10.7, R9, R14).
 *
 * Layer: report service (pure function `(conn, book, query) => figures`, read-only).
 *
 * How the figures are built (the same definitions as the cash book screen, services/cashbooks.service.ts):
 *  - closing = opening + in - out; "in" is the sum of the positive ledger rows of the period, "out" the sum of the
 *    negative ones (a void shows as the opposite row, never as an edit, R1). The opening of a period is the ledger
 *    balance of everything dated BEFORE the period, so every row's opening is the previous row's closing and the last
 *    row's closing equals the ledger balance as of the end date (`ledgerBalanceAsOfToCents`, queried separately).
 *  - Per entry type: in / out / net per cash-entry type (section 2 lists the types).
 *  - Ice Cream funds (10.1, 10.2): taken from the FUND LEDGER, so internal fund moves (no cash) show up as `movesNetCents`
 *    and each fund's closing is its real balance; the three closings add up to the Ice Cream book. A fund's in/out
 *    here are the real cash movements only (internal moves are shown apart), so Σ funds in/out = the book's in/out.
 * A report date is a business date and may be in the future (it just shows today's figures, R-FD is for writes).
 * The Telecom book is not expected to reconcile to Telecom profit (R14); this report is about cash, not profit.
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import { ICE_FUNDS } from '../../repositories/icecream-funds.repo.ts';
import type { CashBook, IceFund } from '../../repositories/cash-entries.repo.ts';
import { FUND_LABEL, negativeBalanceWarning, negativeFundWarning } from '../cash-warnings.ts';
import type { CashWarning } from '../cash-warnings.ts';
import { sumByPeriod, sumByPeriodAndGroup, wholePeriod } from './fin-common.ts';
import type { PeriodRow } from './fin-common.ts';
import type { PeriodQuery } from './pnl-shop.ts';

/** Plain-language names of the cash entry types (BUSINESS_RULES section 2). */
export const ENTRY_TYPE_LABEL: Record<string, string> = {
  sale_goods: 'Goods sales', sale_service: 'Print / service sales', sale_refund: 'Sales refunds', card_sale: 'Scratch-card sales',
  card_refund: 'Scratch-card refunds', reload_collection: 'Reload collections', ezcash_collection: 'EZCash collections',
  provider_topup: 'Provider top-ups', wallet_topup: 'Wallet top-ups', purchase_payment: 'Purchase payments',
  purchase_refund: 'Purchase refunds', expense: 'Expenses', expense_refund: 'Expense refunds', icecream_sale: 'Ice Cream daily sales',
  icecream_materials_payment: 'Materials payments', icecream_electricity_payment: 'Electricity bill payments',
  icecream_other_cost: 'Other ice-cream costs', printing_supplies: 'Printing supplies', cash_adjustment: 'Cash over / short',
  opening_balance: 'Opening balance', capital: 'Capital', drawing_cash: 'Cash drawings', transfer_out: 'Transfers out', transfer_in: 'Transfers in',
};

/** In / out / net of one entry type in a period. */
export interface TypeTotal { type: string; label: string; inCents: number; outCents: number; netCents: number }

/** One fund of the Ice Cream book in a period (from the fund ledger). */
export interface FundPeriod { openingCents: number; inCents: number; outCents: number; movesNetCents: number; closingCents: number }

/** The figures of one cash book report row. */
export interface CashbookFigures {
  openingCents: number; inCents: number; outCents: number; closingCents: number;
  /** Only the types that had activity in the period, in a fixed order. */
  byType: TypeTotal[];
  /** Ice Cream only. */
  funds?: Record<IceFund, FundPeriod>;
}

/** The full answer of `GET /reports/cashbook/:book`. */
export interface CashbookReport {
  book: CashBook; from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<CashbookFigures>>; totals: CashbookFigures;
  /** The book's ledger balance as of `to`, summed independently: always equals the last row's closing. */
  ledgerBalanceAsOfToCents: number;
  table: ReportTable; typeTable: ReportTable; fundTable?: ReportTable; warnings: CashWarning[];
}

type N = number | bigint;

/** Ledger balance of a book of all entries dated BEFORE `date` (0 for an empty book). */
function balanceBefore(conn: DatabaseSync, book: CashBook, date: string): number {
  const r = conn.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM cash_entries WHERE book = ? AND business_date < ?').get(book, date) as unknown as { t: N };
  return Number(r.t);
}

function balanceThrough(conn: DatabaseSync, book: CashBook, date: string): number {
  const r = conn.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM cash_entries WHERE book = ? AND business_date <= ?').get(book, date) as unknown as { t: N };
  return Number(r.t);
}

const TYPE_ORDER = Object.keys(ENTRY_TYPE_LABEL);

function typeTotals(groups: Map<string, Array<{ i: number; o: number }>>, idx: number): TypeTotal[] {
  const out: TypeTotal[] = [];
  for (const type of [...TYPE_ORDER, ...[...groups.keys()].filter((k) => !TYPE_ORDER.includes(k))]) {
    const v = groups.get(type)?.[idx];
    if (!v || (v.i === 0 && v.o === 0)) continue;
    out.push({ type, label: ENTRY_TYPE_LABEL[type] ?? type, inCents: v.i, outCents: v.o, netCents: v.i - v.o });
  }
  return out;
}

/** Per-fund figures for each period from the fund ledger (see the file header). */
function fundsByPeriod(conn: DatabaseSync, periods: readonly Period[]): Array<Record<IceFund, FundPeriod>> {
  const from = periods[0]!.from;
  const to = periods[periods.length - 1]!.to;
  const opening: Record<IceFund, number> = { cost: 0, electricity: 0, profit: 0 };
  for (const r of conn.prepare('SELECT fund, COALESCE(SUM(amount_cents), 0) AS t FROM icecream_fund_entries WHERE business_date < ? GROUP BY fund')
    .all(from) as unknown as Array<{ fund: IceFund; t: N }>) opening[r.fund] = Number(r.t);
  // A reversal row takes the kind of the row it reverses, so a voided internal move still counts as a move (net zero).
  const groups = sumByPeriodAndGroup(conn, periods,
    `SELECT e.business_date AS d, e.fund AS g,
            SUM(CASE WHEN COALESCE(o.kind, e.kind) = 'fund_move' THEN 0 WHEN e.amount_cents > 0 THEN e.amount_cents ELSE 0 END) AS i,
            SUM(CASE WHEN COALESCE(o.kind, e.kind) = 'fund_move' THEN 0 WHEN e.amount_cents < 0 THEN -e.amount_cents ELSE 0 END) AS o,
            SUM(CASE WHEN COALESCE(o.kind, e.kind) = 'fund_move' THEN e.amount_cents ELSE 0 END) AS mv
       FROM icecream_fund_entries e LEFT JOIN icecream_fund_entries o ON o.id = e.reverses_entry_id
      WHERE e.business_date BETWEEN ? AND ? GROUP BY e.business_date, e.fund`, [from, to], ['i', 'o', 'mv'] as const);
  const running = { ...opening };
  return periods.map((_, idx) => {
    const row = {} as Record<IceFund, FundPeriod>;
    for (const f of ICE_FUNDS) {
      const v = groups.get(f)?.[idx] ?? { i: 0, o: 0, mv: 0 };
      const open = running[f];
      const close = open + v.i - v.o + v.mv;
      row[f] = { openingCents: open, inCents: v.i, outCents: v.o, movesNetCents: v.mv, closingCents: close };
      running[f] = close;
    }
    return row;
  });
}

/** Figures for each period (opening carried forward from the ledger balance before the first period). */
export function cashbookFigures(conn: DatabaseSync, book: CashBook, periods: readonly Period[]): CashbookFigures[] {
  const from = periods[0]!.from;
  const to = periods[periods.length - 1]!.to;
  const sums = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS i,
            SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS o
       FROM cash_entries WHERE book = ? AND business_date BETWEEN ? AND ? GROUP BY business_date`, [book, from, to], ['i', 'o'] as const);
  const types = sumByPeriodAndGroup(conn, periods,
    `SELECT business_date AS d, type AS g, SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS i,
            SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS o
       FROM cash_entries WHERE book = ? AND business_date BETWEEN ? AND ? GROUP BY business_date, type`, [book, from, to], ['i', 'o'] as const);
  const funds = book === 'icecream' ? fundsByPeriod(conn, periods) : null;
  let opening = balanceBefore(conn, book, from);
  return periods.map((_, i) => {
    const closing = opening + sums[i]!.i - sums[i]!.o;
    const fig: CashbookFigures = { openingCents: opening, inCents: sums[i]!.i, outCents: sums[i]!.o, closingCents: closing, byType: typeTotals(types, i) };
    if (funds) fig.funds = funds[i]!;
    opening = closing;
    return fig;
  });
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'opening', label: 'Opening balance', kind: 'money' },
  { key: 'in', label: 'Money in', kind: 'money' },
  { key: 'out', label: 'Money out', kind: 'money' },
  { key: 'closing', label: 'Closing balance', kind: 'money' },
];

const FUND_COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  ...ICE_FUNDS.flatMap((f): ReportColumn[] => [
    { key: `${f}Opening`, label: `${FUND_LABEL[f]} opening`, kind: 'money' },
    { key: `${f}In`, label: `${FUND_LABEL[f]} in`, kind: 'money' },
    { key: `${f}Out`, label: `${FUND_LABEL[f]} out`, kind: 'money' },
    { key: `${f}Moves`, label: `${FUND_LABEL[f]} internal moves (net)`, kind: 'money' },
    { key: `${f}Closing`, label: `${FUND_LABEL[f]} closing`, kind: 'money' },
  ]),
];

function flatFunds(label: string, f: Record<IceFund, FundPeriod>): Record<string, ReportCell> {
  const out: Record<string, ReportCell> = { period: label };
  for (const k of ICE_FUNDS) {
    out[`${k}Opening`] = f[k].openingCents; out[`${k}In`] = f[k].inCents; out[`${k}Out`] = f[k].outCents;
    out[`${k}Moves`] = f[k].movesNetCents; out[`${k}Closing`] = f[k].closingCents;
  }
  return out;
}

/**
 * The cash book report of one book for a date range.
 *
 * @param q.granularity `day` or `month` rows; the totals row spans the whole range (opening = balance before `from`).
 */
export function cashbookReport(conn: DatabaseSync, book: CashBook, q: PeriodQuery): CashbookReport {
  const periods = listPeriods(q.from, q.to, q.granularity);
  const figs = cashbookFigures(conn, book, periods);
  const totals = cashbookFigures(conn, book, [wholePeriod(q.from, q.to)])[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));
  const table: ReportTable = {
    title: `${book === 'icecream' ? 'Ice Cream' : book === 'shop' ? 'Shop' : 'Telecom'} cash book`, columns: COLUMNS,
    rows: rows.map((r) => ({ period: r.period.label, opening: r.openingCents, in: r.inCents, out: r.outCents, closing: r.closingCents })),
    totals: { period: 'Total', opening: totals.openingCents, in: totals.inCents, out: totals.outCents, closing: totals.closingCents },
    notes: [
      'Closing = opening + money in - money out. Each period opens with the previous period\'s closing; the last closing equals the cash book balance at the end date.',
      'A voided record appears as an opposite row on the original date, so it nets to zero in its own period.',
      ...(book === 'telecom' ? ['The Telecom cash book is not expected to match Telecom profit (reload float is not tracked, R14).'] : []),
    ],
  };
  const typeTable: ReportTable = {
    title: 'Totals by entry type',
    columns: [
      { key: 'type', label: 'Entry type', kind: 'text' }, { key: 'in', label: 'Money in', kind: 'money' },
      { key: 'out', label: 'Money out', kind: 'money' }, { key: 'net', label: 'Net', kind: 'money' },
    ],
    rows: totals.byType.map((t) => ({ type: t.label, in: t.inCents, out: t.outCents, net: t.netCents })),
    totals: { type: 'Total', in: totals.inCents, out: totals.outCents, net: totals.inCents - totals.outCents },
  };
  const report: CashbookReport = {
    book, from: q.from, to: q.to, granularity: q.granularity, rows, totals,
    ledgerBalanceAsOfToCents: balanceThrough(conn, book, q.to), table, typeTable, warnings: [],
  };
  if (book === 'icecream') {
    report.fundTable = {
      title: 'Ice Cream funds', columns: FUND_COLUMNS,
      rows: rows.map((r) => flatFunds(r.period.label, r.funds!)), totals: flatFunds('Total', totals.funds!),
      notes: [
        'Fund in/out are real cash movements; internal moves between funds (no cash) are shown on their own and net to zero across the three funds.',
        'The three fund closings add up to the Ice Cream cash book closing.',
      ],
    };
  }
  if (report.ledgerBalanceAsOfToCents < 0) {
    report.warnings.push(negativeBalanceWarning(book, report.ledgerBalanceAsOfToCents)); // R13: a warning, never an error
  }
  if (book === 'icecream') {
    for (const f of ICE_FUNDS) {
      const closing = totals.funds![f].closingCents;
      if (closing < 0) report.warnings.push(negativeFundWarning(f, closing)); // 10.2: a negative fund is a warning, never blocked
    }
  }
  return report;
}
