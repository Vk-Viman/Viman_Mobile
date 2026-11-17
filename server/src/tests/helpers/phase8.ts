// Helpers for Phase 8 tests: expenses, cash books, opening balances, cash counts, daily closings (BUSINESS_RULES sections 7, 8, 10; R9).
// Two groups: (1) API request builders so each test reads as a business action (expNew, openNew, countNew, closeNew ...);
// (2) readers that look at the ledgers directly (balances, fund balances, rows) and an independent seeded random generator.
// Money in tests is written in CENTS; the rupee value is given in a comment where it helps.

import type { AppContext } from '../../app.ts';
import { get, post } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { num, sql } from './phase4.ts';
import { withSeg } from './segments.ts';

export type Book = 'shop' | 'telecom' | 'icecream';
export type Fund = 'cost' | 'electricity' | 'profit';

/** Exact, sorted field list of an expense in API responses (13D: `segment`, null outside Telecom). */
export const EXPENSE_KEYS = ['amountCents', 'backdated', 'book', 'businessDate', 'category', 'clientRef', 'description', 'id', 'notes',
  'postedAt', 'segment', 'status', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a cash count in API responses. */
export const COUNT_KEYS = ['backdated', 'book', 'businessDate', 'cashEntryId', 'clientRef', 'countedCents', 'differenceCents', 'expectedCents',
  'fund', 'id', 'note', 'postedAt', 'segment', 'status', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a daily closing in API responses. */
export const CLOSING_KEYS = ['book', 'businessDate', 'cashCountId', 'closedAt', 'countedCents', 'expectedCents', 'id', 'isClosed', 'overShortCents',
  'postedAt', 'reopenReason', 'reopenedAt', 'segment'];

// ---------- API builders ----------
// Telecom (13D): every builder below that takes a book adds `segment: 'dialog_reloads'` for book 'telecom' unless the test passes its own
// `segment` (see helpers/segments.ts). Shop and Ice Cream bodies are unchanged.

/** Records an expense (default: shop rent Rs 500.00, today; a Telecom expense defaults to segment dialog_reloads). Raw response. */
export const expNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/expenses', {
    businessDate: today(), book: 'shop', category: 'rent', amountCents: 50000, description: 'Shop rent', clientRef: ref(),
    ...withSeg(over.book, over), ...over,
  });
/** Voids an expense. */
export const expVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/expenses/${id}/void`, { reason });

/**
 * Sets the opening balance of a book (default Rs 10,000.00, today; Ice Cream defaults to the Cost fund; Telecom defaults to the
 * segment dialog_reloads: one opening balance per scope). Raw response.
 */
export const openNew = (s: ApiBase, book: Book, over: Record<string, unknown> = {}) =>
  post(s.app, `/cashbooks/${book}/opening`, {
    businessDate: today(), amountCents: 1000000, ...(book === 'icecream' ? { fund: 'cost' } : {}), clientRef: ref(),
    ...withSeg(book, over), ...over,
  });
/** Voids an opening balance / capital entry. */
export const capVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/capital-entries/${id}/void`, { reason });

/** Records a cash count (dated today unless overridden; Telecom: the drawer of `over.segment`, default dialog_reloads). Raw response. */
export const countNew = (s: ApiBase, book: Book, countedCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/cash-counts', { businessDate: today(), book, countedCents, clientRef: ref(), ...withSeg(book, over), ...over });
/** Voids a cash count. */
export const countVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/cash-counts/${id}/void`, { reason });

/**
 * Closes a book's day (default today). Telecom closes ONE segment (`over.segment`, default dialog_reloads): the other seven stay
 * open (use `seg.closeAll` to close the whole Telecom day). Raw response.
 */
export const closeNew = (s: ApiBase, book: Book, businessDate = today(), over: Record<string, unknown> = {}) =>
  post(s.app, '/daily-closings', { book, businessDate, clientRef: ref(), ...withSeg(book, over), ...over });
/** Closes a day and returns the closing (throws unless 201). */
export async function closeOk(s: ApiBase, book: Book, businessDate = today(), over: Record<string, unknown> = {}): Promise<any> {
  const r = await closeNew(s, book, businessDate, over);
  if (r.status !== 201) throw new Error(`close failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
}
/** Reopens a closed day. */
export const reopenNew = (s: ApiBase, id: number, reason = 'fix a mistake') => post(s.app, `/daily-closings/${id}/reopen`, { reason });

/** The ledger of a book (`qs` such as `?from=2026-01-01&limit=2`; Telecom: add `segment=dialog_reloads`, or none for the total ledger). */
export const ledgerGet = (s: ApiBase, book: Book, qs = '') => get(s.app, `/cashbooks/${book}${qs}`);

// ---------- ledger readers ----------

/** Balance of a cash book straight from the ledger (sum of every row; Telecom: the total of all segments). */
export const bookBal = (s: { ctx: AppContext }, book: Book): number =>
  num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', book);

/** Fund balances straight from the Ice Cream fund ledger. */
export function fundBal(s: { ctx: AppContext }): Record<Fund, number> {
  const out: Record<Fund, number> = { cost: 0, electricity: 0, profit: 0 };
  for (const r of sql(s, 'SELECT fund, COALESCE(SUM(amount_cents),0) AS t FROM icecream_fund_entries GROUP BY fund')) out[r.fund as Fund] = Number(r.t);
  return out;
}

/** Cash rows written for one source record, oldest first. */
export const cashOfRef = (s: { ctx: AppContext }, refTable: string, refId: number): Array<Record<string, any>> =>
  sql(s, 'SELECT * FROM cash_entries WHERE ref_table = ? AND ref_id = ? ORDER BY id', refTable, refId);

/** Fund rows written for one source record, oldest first. */
export const fundOfRef = (s: { ctx: AppContext }, refTable: string, refId: number): Array<Record<string, any>> =>
  sql(s, 'SELECT * FROM icecream_fund_entries WHERE ref_table = ? AND ref_id = ? ORDER BY id', refTable, refId);

/** Row counts of every table a Phase 8 write may touch. Equal snapshots before/after a failed request prove nothing was half-saved. */
const TABLES8 = ['expenses', 'capital_entries', 'cash_counts', 'daily_closings', 'icecream_fund_entries', 'cash_entries', 'audit_logs',
  'purchases', 'sales', 'stock_movements', 'stock_losses', 'owner_drawings', 'stocktakes', 'reload_sales', 'ezcash_sales', 'telecom_topups',
  'print_sales', 'printing_supplies', 'opening_stock_batches', 'sales_returns', 'purchase_returns'];
export const snap8 = (s: { ctx: AppContext }): Record<string, number> =>
  Object.fromEntries(TABLES8.map((t) => [t, num(s, `SELECT COUNT(*) FROM ${t}`)]));

// ---------- seeded random numbers (reproducible randomized tests) ----------

/** mulberry32: a tiny seeded generator, so a failing randomized run can be replayed exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
