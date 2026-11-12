// Helpers for Phase 9 tests: cash transfers between books, cash drawings, capital (BUSINESS_RULES sections 8, 9, 10.2, 10.7; R1, R9, R13).
// Three groups: (1) API request builders so each test reads as a business action (trNew, drawCash, capNew ...);
// (2) readers that look at the ledgers directly (books, funds, the two invariants);
// (3) snapshots that prove a write changed NO profit-relevant table.
// Money in tests is written in CENTS; the rupee value is given in a comment where it helps.

import { post } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { num, sql } from './phase4.ts';
import { bookBal, fundBal, openNew } from './phase8.ts';
import type { Book, Fund } from './phase8.ts';

/** Exact, sorted field list of a transfer in API responses. */
export const TRANSFER_KEYS = ['amountCents', 'backdated', 'businessDate', 'clientRef', 'fromBook', 'fromFund', 'id', 'note', 'postedAt', 'status',
  'toBook', 'toFund', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a capital entry in API responses. */
export const CAPITAL_KEYS = ['amountCents', 'backdated', 'book', 'businessDate', 'clientRef', 'fund', 'id', 'kind', 'note', 'postedAt', 'status',
  'voidReason', 'voidedAt'];

// ---------- API builders ----------

/**
 * Transfers money between books (default: Shop -> Telecom, Rs 100.00, today). Pass `fromFund` / `toFund` for Ice Cream sides.
 * Raw response.
 */
export const trNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/cash-transfers', { businessDate: today(), fromBook: 'shop', toBook: 'telecom', amountCents: 10000, clientRef: ref(), ...over });
/** Transfer with short arguments: `tr(s, 'shop', 'icecream', 5000, { toFund: 'profit' })`. Raw response. */
export const tr = (s: ApiBase, fromBook: Book, toBook: Book, amountCents: number, over: Record<string, unknown> = {}) =>
  trNew(s, { fromBook, toBook, amountCents, ...over });
/** Voids a transfer. */
export const trVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/cash-transfers/${id}/void`, { reason });

/** Records a cash drawing (default: Shop, Rs 100.00, today). Raw response. */
export const drawCash = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/drawings', { kind: 'cash', businessDate: today(), book: 'shop', amountCents: 10000, clientRef: ref(), ...over });
/** Records capital (default: Shop, Rs 100.00, today; Ice Cream defaults to the Cost fund). Raw response. */
export const capNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/capital', {
    businessDate: today(), book: 'shop', amountCents: 10000, ...(over.book === 'icecream' ? { fund: 'cost' } : {}), clientRef: ref(), ...over,
  });

/**
 * Gives every book and fund a starting balance through the real opening-balance endpoint, dated `date`.
 * Shop and Telecom take one amount each; Ice Cream takes one per fund.
 */
export async function seedBooks(s: ApiBase, a: { shop?: number; telecom?: number; cost?: number; electricity?: number; profit?: number }, date = today()): Promise<void> {
  const put = async (book: Book, amountCents: number | undefined, fund?: Fund) => {
    if (amountCents === undefined) return;
    const r = await openNew(s, book, { businessDate: date, amountCents, ...(fund ? { fund } : {}) });
    if (r.status !== 201) throw new Error(`seed failed: ${r.status} ${JSON.stringify(r.body)}`);
  };
  await put('shop', a.shop);
  await put('telecom', a.telecom);
  await put('icecream', a.cost, 'cost');
  await put('icecream', a.electricity, 'electricity');
  await put('icecream', a.profit, 'profit');
}

// ---------- ledger readers ----------

/** All three book balances straight from the ledger. */
export const books = (s: ApiBase): Record<Book, number> => ({ shop: bookBal(s, 'shop'), telecom: bookBal(s, 'telecom'), icecream: bookBal(s, 'icecream') });

/** Book balances plus the three fund balances in one object, handy for `toEqual` against a hand-calculated state. */
export function state(s: ApiBase): { shop: number; telecom: number; icecream: number; cost: number; electricity: number; profit: number } {
  return { ...books(s), ...fundBal(s) };
}

/**
 * The two Ice Cream invariants (10.1, 10.7): Cost + Electricity + Profit = the Ice Cream cash book, and the sum of all fund
 * rows = the sum of all Ice Cream cash rows. Returns the numbers so a failing test shows them.
 */
export function iceInvariant(s: ApiBase): { funds: number; book: number; fundRows: number; cashRows: number } {
  const f = fundBal(s);
  return {
    funds: f.cost + f.electricity + f.profit, book: bookBal(s, 'icecream'),
    fundRows: num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries'),
    cashRows: num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'icecream'"),
  };
}

/** Sum of every cash row of one type in one book (e.g. all `transfer_out` rows of Shop). */
export const cashOfType = (s: ApiBase, book: Book, type: string): number =>
  num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND type = ?', book, type);

/** Ledger rows that carry a transfer id, oldest first. */
export const legsOf = (s: ApiBase, transferId: number): Array<Record<string, any>> =>
  sql(s, 'SELECT * FROM cash_entries WHERE transfer_id = ? ORDER BY id', transferId);

// ---------- "no profit table changed" proof ----------

/**
 * Every table whose rows feed revenue, cost or profit (sales, purchases, stock, expenses, losses, telecom, printing) plus the
 * product stock cache. A transfer, cash drawing or capital entry must leave ALL of them byte-for-byte untouched.
 */
const PNL_TABLES = ['sales', 'sale_items', 'sales_returns', 'sales_return_items', 'purchases', 'purchase_items', 'purchase_returns',
  'stock_movements', 'stock_losses', 'stocktakes', 'expenses', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales',
  'printing_supplies', 'opening_stock_batches', 'products', 'cash_counts'];

/** A fingerprint (full row content) of every profit-relevant table; equal before and after = nothing in P&L changed. */
export function pnlSnapshot(s: ApiBase): Record<string, string> {
  return Object.fromEntries(PNL_TABLES.map((t) => [t, JSON.stringify(sql(s, `SELECT * FROM ${t} ORDER BY 1`))]));
}
