/**
 * services/icecream.service.ts - shared parts of the Ice Cream services and the read side: the Funds summary, the fund
 * ledger and the warnings (Phase 10).
 *
 * Layer: service (route -> SERVICE -> repository -> database). The write services live in icecream-days.service.ts,
 * icecream-payments.service.ts and icecream-moves.service.ts; they all use the helpers here so every response has the
 * same `funds` block and the same warning shapes. BUSINESS_RULES section 10:
 *  - 10.1  two measures side by side, never mixed: FUND BALANCES (they add up to the Ice Cream cash book) and
 *          RECOGNIZED PROFIT (changes only through the 10.3 events). `getFunds` returns both in separate blocks.
 *  - 10.4  Charged / Settled / Unspent per line and the profit-eligible limits are DERIVED from the posted rows by the pure
 *          module (icecream-rules.ts); nothing here stores a running total.
 *  - 10.5  excess cost (D3): official profit is never reduced automatically; whenever Unspent < 0 a clear warning plus
 *          the three period-flow lines are shown.
 *  - 10.6  `asOf` / `from` / `to` are BUSINESS dates; balances are as of the end date, flows use only the movements dated
 *          inside the period. (Limits, splits and guards, by contrast, follow the saving order - they use every posted row.)
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate } from '../lib/dates.ts';
import { formatLKR } from '../lib/money.ts';
import { cashBalance } from '../repositories/cash-entries.repo.ts';
import type { IceFund } from '../repositories/cash-entries.repo.ts';
import { ICE_FUNDS } from '../repositories/icecream-funds.repo.ts';
import type { FundEntryRow } from '../repositories/icecream-funds.repo.ts';
import { fundBalancesAsOf, iceCashBalanceAsOf, listFundEntries, loadFacts } from '../repositories/icecream.repo.ts';
import { FUND_LABEL, negativeCashWarnings, negativeFundWarning } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { validationError } from './validation.ts';
import { outstandingExcess, periodReport, standing } from './icecream-rules.ts';
import type { LineState, Recognition } from './icecream-rules.ts';

/** Largest amount (cents) any single Ice Cream record may carry; the same bound is a CHECK in migration 014. */
export const MAX_CENTS = 1_000_000_000_000;

/** Longest free-text description of a payment. */
export const DESCRIPTION_MAX_LENGTH = 200;

/** The extra warning of 10.5 (D3): real spending exceeded the allocations. Official profit is NOT reduced. */
export interface ExcessCostWarning {
  code: 'EXCESS_COST_OUTSTANDING'; message: string; book: 'icecream'; outstandingExcessCostCents: number; asOf: string;
}
/** Every warning an Ice Cream response may carry. */
export type IceWarning = CashWarning | ExcessCostWarning;

/** The Funds block returned by `GET /icecream/funds` and by every write (shape of API_CONTRACTS P10 plus the details below). */
export interface FundsSummary {
  asOf: string | null;
  funds: Record<IceFund, { balanceCents: number }>;
  totalCents: number;
  cashBookBalanceCents: number;
  /** True when Cost + Electricity + Profit equals the Ice Cream cash book (10.1 invariant). */
  reconciled: boolean;
  lines: { materials: LineState; electricity: LineState };
  unspentAllocationCents: number;
  outstandingExcessCostCents: number;
  recognizedProfitToDateCents: number;
  profitAfterExcessCostToDateCents: number;
  /** Components of recognized profit to date (signed contributions, 10.3). */
  recognition: Recognition;
  /** The three period-flow lines of 10.6 for `from..asOf` (from = start of history when not given). */
  period: {
    from: string | null; to: string | null; recognizedProfitCents: number; excessCostNotChargedCents: number;
    profitAfterExcessCostCents: number;
  };
  warnings: IceWarning[];
}

/**
 * The plain-language D3 warning (10.5): "Rs X excess cost outstanding as of <date>". Official profit is unchanged until
 * the owner re-allocates (a Profit -> Cost/Electricity move charges the excess).
 */
export function excessCostWarning(outstandingCents: number, asOf: string, profitAfterCents: number): ExcessCostWarning {
  return {
    code: 'EXCESS_COST_OUTSTANDING', book: 'icecream', outstandingExcessCostCents: outstandingCents, asOf,
    message: `${formatLKR(outstandingCents)} excess cost outstanding as of ${asOf}: more was actually spent than was set aside in the daily allocations. `
      + `Official profit is not reduced automatically; after this excess cost it would be ${formatLKR(profitAfterCents)}. `
      + 'Move money from Profit back to Cost or Electricity to charge it.',
  };
}

/**
 * The Funds summary at a business date (10.1, 10.4, 10.5, 10.6).
 *
 * @param asOf Business date the balances are as of (omitted = everything saved). Never rejected for being in the future (R-FD is for transactions).
 * @param from Optional period start for the three period-flow lines (omitted = from the beginning).
 */
export function fundsSummary(conn: DatabaseSync, asOf?: string, from?: string): FundsSummary {
  const facts = loadFacts(conn);
  const st = standing(facts, asOf);
  const toDate = periodReport(facts, undefined, asOf);
  const period = from === undefined ? toDate : periodReport(facts, from, asOf);
  const bal = fundBalancesAsOf(conn, asOf);
  const total = bal.cost + bal.electricity + bal.profit;
  const cashBook = iceCashBalanceAsOf(conn, asOf);
  const outstanding = outstandingExcess(st);
  const warnings: IceWarning[] = [];
  for (const fund of ICE_FUNDS) if (bal[fund] < 0) warnings.push(negativeFundWarning(fund, bal[fund]));
  if (outstanding > 0) warnings.push(excessCostWarning(outstanding, asOf ?? todayBusinessDate(), toDate.recognizedProfitCents - outstanding));
  if (total !== cashBook) {
    warnings.push({
      code: 'ICECREAM_FUNDS_MISMATCH', book: 'icecream', balanceCents: cashBook - total,
      message: `The Ice Cream funds (${formatLKR(total)}) do not add up to the Ice Cream cash book (${formatLKR(cashBook)}). Please contact support.`,
    });
  }
  return {
    asOf: asOf ?? null,
    funds: { cost: { balanceCents: bal.cost }, electricity: { balanceCents: bal.electricity }, profit: { balanceCents: bal.profit } },
    totalCents: total, cashBookBalanceCents: cashBook, reconciled: total === cashBook,
    lines: { materials: st.materials, electricity: st.electricity },
    unspentAllocationCents: st.unspentCents, outstandingExcessCostCents: outstanding,
    recognizedProfitToDateCents: toDate.recognizedProfitCents,
    // 10.6: over any span, profit after excess cost = recognized - (outstanding excess at end - at start); from the beginning start = 0
    profitAfterExcessCostToDateCents: toDate.recognizedProfitCents - outstanding,
    recognition: toDate.recognition,
    period: {
      from: from ?? null, to: asOf ?? null, recognizedProfitCents: period.recognizedProfitCents,
      excessCostNotChargedCents: period.excessCostNotChargedCents, profitAfterExcessCostCents: period.profitAfterExcessCostCents,
    },
    warnings,
  };
}

/**
 * Warnings after a WRITE (current state, all dates): the shared cash/fund warnings for the books the write touched
 * (R13, 10.2: negative balances warn, never block) plus the excess-cost warning when Unspent < 0 (10.5).
 *
 * @param cashMoved false for a fund move: it moves no cash, so only the fund warnings are relevant.
 */
export function writeWarnings(conn: DatabaseSync, cashMoved: boolean): IceWarning[] {
  const out: IceWarning[] = negativeCashWarnings(conn, ['icecream'])
    .filter((w) => cashMoved || w.code === 'NEGATIVE_FUND_BALANCE');
  const facts = loadFacts(conn);
  const outstanding = outstandingExcess(standing(facts));
  if (outstanding > 0) {
    out.push(excessCostWarning(outstanding, todayBusinessDate(), periodReport(facts).recognizedProfitCents - outstanding));
  }
  return out;
}

/** The `{ funds, warnings }` pair every write returns (funds = the summary of the whole book as it is now). */
export function writeExtras(conn: DatabaseSync, cashMoved: boolean): { funds: FundsSummary; warnings: IceWarning[] } {
  return { funds: fundsSummary(conn), warnings: writeWarnings(conn, cashMoved) };
}

/** Sum of the three fund balances equals the Ice Cream book - used by callers that only need the check. */
export function fundsReconcile(conn: DatabaseSync): boolean {
  const b = fundBalancesAsOf(conn);
  return b.cost + b.electricity + b.profit === cashBalance(conn, 'icecream');
}

/** Funds summary for the API (`GET /icecream/funds?asOf=&from=`). */
export function getFunds(ctx: AppContext, q: { asOf?: string; from?: string }): FundsSummary {
  if (q.asOf !== undefined && q.from !== undefined && q.from > q.asOf) {
    throw validationError({ from: 'The start date cannot be after the end date.' });
  }
  return fundsSummary(ctx.database.conn, q.asOf, q.from);
}

/** One fund ledger row as returned by the API. */
export type FundLedgerItem = FundEntryRow;

/**
 * The complete fund ledger, reversals included (10.7), oldest business date first.
 *
 * @throws AppError 400 VALIDATION_ERROR when `from` is after `to`.
 */
export function getFundLedger(ctx: AppContext, q: { fund?: IceFund; from?: string; to?: string; limit: number; offset: number }): {
  items: FundLedgerItem[]; total: number; totals: { inCents: number; outCents: number; netCents: number };
} {
  if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
    throw validationError({ to: 'The end date cannot be before the start date.' });
  }
  const r = listFundEntries(ctx.database.conn, q);
  return { items: r.items, total: r.total, totals: { inCents: r.inCents, outCents: r.outCents, netCents: r.inCents - r.outCents } };
}

/** Plain-language fund name for messages ("Cost", "Electricity", "Profit"). */
export const fundName = (f: IceFund): string => FUND_LABEL[f];
