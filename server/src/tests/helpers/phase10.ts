// Helpers for Phase 10 tests: Ice Cream daily entries, payments, fund moves, funds (BUSINESS_RULES section 10, D1-D4, E1-E5).
// Three groups: (1) API request builders so each test reads as a business action (dayNew, payNew, moveNew ...); (2) readers that
// look at the ledgers directly (cash book, fund ledger, record tables) and the section 10.1 invariant check; (3) the section 10.8
// worked example as plain data so the pure-module tests and the API tests quote the SAME numbers from the document.
// Money in tests is written in CENTS via `rs()` (rupees -> cents) so the document's "Rs 5,000" reads as rs(5000).

import { expect } from 'vitest';
import type { AppContext } from '../../app.ts';
import { get, post, put } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { num, sql } from './phase4.ts';
import { bookBal, fundBal } from './phase8.ts';
import type { Fund } from './phase8.ts';

export type { Fund } from './phase8.ts';

/** Rupees to cents: `rs(5000)` is Rs 5,000.00. */
export const rs = (rupees: number): number => Math.round(rupees * 100);

/** Exact, sorted field list of a daily entry in API responses. */
export const DAY_KEYS = ['backdated', 'businessDate', 'clientRef', 'costAllocCents', 'electricityAllocCents', 'id', 'items', 'negativeConfirmed',
  'notes', 'postedAt', 'profitShareCents', 'salesCents', 'status', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a payment in API responses. */
export const PAYMENT_KEYS = ['amountCents', 'backdated', 'businessDate', 'category', 'clientRef', 'description', 'fund', 'id', 'kind',
  'pnlTreatment', 'postedAt', 'status', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a fund move in API responses. */
export const MOVE_KEYS = ['amountCents', 'backdated', 'businessDate', 'cashOnlyCents', 'chargeRelabelCents', 'clientRef', 'fromFund', 'id', 'kind',
  'note', 'postedAt', 'profitEffectCents', 'status', 'toFund', 'voidReason', 'voidedAt'];

// ---------- API builders ----------

/** Records a daily entry (default: today, sales Rs 1,000 = cost 600 + electricity 100 + profit 300). Raw response. */
export const dayNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/icecream/days', {
    businessDate: today(), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100), clientRef: ref(), ...over,
  });
/** Records a daily entry and returns it (throws unless 201). */
export async function dayOk(s: ApiBase, over: Record<string, unknown> = {}): Promise<any> {
  const r = await dayNew(s, over);
  if (r.status !== 201) throw new Error(`day failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.day;
}
/** Replaces the posted entry of a date (PUT). Raw response. */
export const dayReplace = (s: ApiBase, date: string, over: Record<string, unknown> = {}) =>
  put(s.app, `/icecream/days/${date}`, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100), clientRef: ref(), ...over });
/** Voids the posted entry of a date. */
export const dayVoid = (s: ApiBase, date: string, reason = 'test void') => post(s.app, `/icecream/days/${date}/void`, { reason });

/** Records a payment (raw response). Fund defaults to the section 10.2 preset of the kind. */
export const payNew = (s: ApiBase, kind: 'materials' | 'electricity_bill' | 'other_cost', amountCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/icecream/payments', {
    businessDate: today(), kind, fund: kind === 'electricity_bill' ? 'electricity' : 'cost', amountCents,
    description: `Test ${kind}`, clientRef: ref(), ...over,
  });
/** Records a payment and returns it (throws unless 201). */
export async function payOk(s: ApiBase, kind: 'materials' | 'electricity_bill' | 'other_cost', amountCents: number, over: Record<string, unknown> = {}): Promise<any> {
  const r = await payNew(s, kind, amountCents, over);
  if (r.status !== 201) throw new Error(`payment failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.payment;
}
/** Voids a payment. */
export const payVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/icecream/payments/${id}/void`, { reason });

/** Posts a fund move (raw response). */
export const moveNew = (s: ApiBase, fromFund: Fund, toFund: Fund, amountCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/icecream/fund-moves', { businessDate: today(), fromFund, toFund, amountCents, clientRef: ref(), ...over });
/** Posts a fund move; when the server asks for the D4 confirmation it confirms the split it was shown. Returns the move (throws unless 201). */
export async function moveOk(s: ApiBase, fromFund: Fund, toFund: Fund, amountCents: number, over: Record<string, unknown> = {}): Promise<any> {
  const body = { businessDate: today(), fromFund, toFund, amountCents, clientRef: ref(), ...over };
  let r = await post(s.app, '/icecream/fund-moves', body);
  if (r.status === 409 && r.body.error.code === 'SPLIT_CONFIRMATION_REQUIRED') {
    r = await post(s.app, '/icecream/fund-moves', { ...body, confirmSplit: true, confirmedProfitEligibleCents: r.body.error.profitEligibleCents });
  }
  if (r.status !== 201) throw new Error(`move failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.move;
}
/** The move preview (no write). */
export const movePreview = (s: ApiBase, fromFund: Fund, toFund: Fund, amountCents: number) =>
  post(s.app, '/icecream/fund-moves/preview', { fromFund, toFund, amountCents });
/** Voids a fund move. */
export const moveVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/icecream/fund-moves/${id}/void`, { reason });

/** The Funds summary (`qs` such as `?asOf=2026-11-01`). */
export const fundsGet = (s: ApiBase, qs = '') => get(s.app, `/icecream/funds${qs}`);
/** The fund ledger (`qs` such as `?fund=cost&limit=5`). */
export const fundLedgerGet = (s: ApiBase, qs = '') => get(s.app, `/icecream/funds/entries${qs}`);

// ---------- readers ----------

/** Sum of every Ice Cream cash entry. */
export const iceCash = (s: { ctx: AppContext }): number => bookBal(s, 'icecream');
/** Sum of every fund-ledger row (all funds). */
export const fundSum = (s: { ctx: AppContext }): number => num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries');
/** Fund-ledger rows of one source record. */
export const fundRowsOf = (s: { ctx: AppContext }, table: string, id: number): Array<Record<string, any>> =>
  sql(s, 'SELECT * FROM icecream_fund_entries WHERE ref_table = ? AND ref_id = ? ORDER BY id', table, id);

/**
 * BUSINESS_RULES 10.1/10.7 invariant: Cost + Electricity + Profit = the Ice Cream cash book = sum of the Ice Cream cash entries =
 * sum of the fund entries. Also checks the API's own reconciliation flag.
 */
export async function expectBooksAgree(s: ApiBase): Promise<void> {
  const f = fundBal(s);
  const total = f.cost + f.electricity + f.profit;
  expect(total, 'fund balances vs Ice Cream cash book').toBe(iceCash(s));
  expect(fundSum(s), 'sum of fund entries vs sum of cash entries').toBe(iceCash(s));
  const api = (await fundsGet(s)).body;
  expect(api.totalCents).toBe(total);
  expect(api.cashBookBalanceCents).toBe(total);
  expect(api.funds.cost.balanceCents).toBe(f.cost);
  expect(api.funds.electricity.balanceCents).toBe(f.electricity);
  expect(api.funds.profit.balanceCents).toBe(f.profit);
}

/** Row counts of every table a Phase 10 write may touch. Equal snapshots before/after a failed request prove nothing was half-saved. */
const TABLES10 = ['icecream_days', 'icecream_sales', 'icecream_payments', 'icecream_fund_moves', 'icecream_fund_entries', 'cash_entries', 'audit_logs',
  'capital_entries', 'cash_counts', 'daily_closings'];
export const snap10 = (s: { ctx: AppContext }): Record<string, number> =>
  Object.fromEntries(TABLES10.map((t) => [t, num(s, `SELECT COUNT(*) FROM ${t}`)]));

/** Money values straight from the document's worked example: used by the pure-module and the API tests (BUSINESS_RULES 10.8). */
export interface Step {
  name: string;
  /** Fund balances after the step (rupees): Cost, Electricity, Profit. */
  funds: [number, number, number];
  /** Charged Materials / Electricity. */
  charged: [number, number];
  /** Settled Materials / Electricity. */
  settled: [number, number];
  /** Recognized profit. */
  recognized: number;
}

/** The table of BUSINESS_RULES 10.8, row by row (rupees). Expected values come from the document, never from the code under test. */
export const WORKED_EXAMPLE: Step[] = [
  { name: 'Opening 5,000 -> Cost', funds: [5000, 0, 0], charged: [0, 0], settled: [0, 0], recognized: 0 },
  { name: 'Daily entries (sales 100,000: 60,000 / 10,000 / 30,000)', funds: [65000, 10000, 30000], charged: [60000, 10000], settled: [0, 0], recognized: 30000 },
  { name: 'Materials 55,000 (Cost)', funds: [10000, 10000, 30000], charged: [60000, 10000], settled: [55000, 0], recognized: 30000 },
  { name: 'Bill 12,000 (Electricity)', funds: [10000, -2000, 30000], charged: [60000, 10000], settled: [55000, 12000], recognized: 30000 },
  { name: 'Cost -> Electricity 2,000 (re-label 2,000)', funds: [8000, 0, 30000], charged: [58000, 12000], settled: [55000, 12000], recognized: 30000 },
  { name: 'Cost -> Profit 3,000 (eligible 3,000)', funds: [5000, 0, 33000], charged: [55000, 12000], settled: [55000, 12000], recognized: 33000 },
  { name: 'Cups 1,000 from Profit', funds: [5000, 0, 32000], charged: [55000, 12000], settled: [55000, 12000], recognized: 32000 },
  { name: 'Withdrawal 20,000 + transfer 5,000 (Profit)', funds: [5000, 0, 7000], charged: [55000, 12000], settled: [55000, 12000], recognized: 32000 },
];
