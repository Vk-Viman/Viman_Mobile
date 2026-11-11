// Helpers for Phase 4 tests: stocktakes, stock losses and owner drawings (BUSINESS_RULES sections 3, 9, 11).
// Three groups: (1) read helpers that look at the database directly (pool cache, movement ledger, row counts);
// (2) invariant helpers (reconOk, snap) that prove nothing changed or everything still adds up;
// (3) thin request builders (stNew/lossNew/drawNew ...) so each test reads as a business action.
// The pool vs ledger pair is the heart of the model: the pool is a cache, the ledger (movements) is the truth,
// and the two must always agree (R1/R2/R3, section 3).

import { expect } from 'vitest';
import type { AppContext } from '../../app.ts';
import { issueStock } from '../../services/inventory.service.ts';
import { get, post, put } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';

/**
 * The exact owner-facing message the server must return for a future-dated entry (R-FD).
 */
export const FUTURE_MSG = 'Future-dated transactions are not allowed. Please select today or an earlier date.';

/**
 * Shortcut for the error object of a failed response (body.error: code, message, fields...).
 */
export const err = (r: { body: any }): any => r.body.error;

/**
 * Runs a SELECT on the app's database and returns the rows (for checks the API cannot answer directly).
 */
export const sql = (s: { ctx: AppContext }, q: string, ...p: any[]): Array<Record<string, any>> =>
  s.ctx.database.conn.prepare(q).all(...p) as unknown as Array<Record<string, any>>;

/**
 * Runs a SELECT and returns the first column of the first row as a number (COUNT/SUM helper).
 */
export const num = (s: { ctx: AppContext }, q: string, ...p: any[]): number =>
  Number(Object.values(sql(s, q, ...p)[0]!)[0]);

/**
 * Pool of a product straight from the database cache (products.qty_on_hand / stock_value_cents).
 * @returns { qty, value in cents }
 */
export function poolOf(s: { ctx: AppContext }, id: number): { qty: number; value: number } {
  const r = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
}

/**
 * Pool of a product as the sum of its movements (the independent ledger view).
 * Compared against poolOf(): the two must always be equal (BUSINESS_RULES section 3 invariant).
 * @returns { qty, value in cents }
 */
export function ledgerOf(s: { ctx: AppContext }, id: number): { qty: number; value: number } {
  const r = sql(s, 'SELECT COALESCE(SUM(qty_delta),0) AS q, COALESCE(SUM(value_delta_cents),0) AS v FROM stock_movements WHERE product_id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
}

/**
 * A stock_movements row in friendly form (qty/value deltas, unit-cost snapshot, business date, source document,
 * reason and posting timestamp).
 */
export interface Mv {
  id: number; productId: number; type: string; qty: number; value: number; unit: number | null; date: string;
  refTable: string | null; refId: number | null; reason: string; postedAt: string;
}
/**
 * Reads stock movements with an optional trusted WHERE clause, in posting (id) order.
 */
export function mvs(s: { ctx: AppContext }, where = '1=1', ...p: any[]): Mv[] {
  return sql(s, `SELECT * FROM stock_movements WHERE ${where} ORDER BY id`, ...p).map((m) => ({
    id: Number(m.id), productId: Number(m.product_id), type: m.type, qty: Number(m.qty_delta),
    value: Number(m.value_delta_cents), unit: m.unit_cost_cents === null ? null : Number(m.unit_cost_cents),
    date: m.business_date, refTable: m.ref_table, refId: m.ref_id === null ? null : Number(m.ref_id),
    reason: m.reason, postedAt: m.posted_at,
  }));
}
/**
 * All movements of one product, oldest first.
 */
export const mvsOf = (s: { ctx: AppContext }, productId: number): Mv[] => mvs(s, 'product_id = ?', productId);
/**
 * All movements created by one source document (e.g. table 'stocktakes', id 5): shows what one action wrote.
 */
export const mvsByRef = (s: { ctx: AppContext }, table: string, id: number): Mv[] =>
  mvs(s, 'ref_table = ? AND ref_id = ?', table, id);

/**
 * Reconciliation through the API must be ok after every step.
 * Asserts GET /inventory/reconciliation reports ok (cache = ledger for every product) and, separately, that no
 * product has negative quantity/value or value without quantity (section 3 "Blocked" rules).
 * Call it at the end of a test, and after each step in longer scenarios.
 */
export async function reconOk(s: ApiBase): Promise<void> {
  const r = await get(s.app, '/inventory/reconciliation');
  expect(r.status).toBe(200);
  expect(r.body.ok, JSON.stringify(r.body.mismatches)).toBe(true);
  // plus the physical invariants: no negative qty / value, no value without quantity
  expect(num(s, 'SELECT COUNT(*) FROM products WHERE qty_on_hand < 0 OR stock_value_cents < 0 OR (qty_on_hand = 0 AND stock_value_cents <> 0)')).toBe(0);
}

/**
 * Engine sale (what Phase 5 will do): outflow at the weighted average.
 * There is no sales API yet, so tests call the stock engine directly to create stock that "was sold".
 * @param productId product to take stock from
 * @param qty units sold
 * @param businessDate defaults to today
 */
export const engineSell = (s: ApiBase, productId: number, qty: number, businessDate = today()) =>
  s.ctx.database.tx((c) => issueStock(c, { productId, businessDate, type: 'sale', qty, refTable: null, refId: null, reason: 'test sale' }));

/**
 * Row counts of every table a Phase 4 write may touch.
 * Take a snapshot before a request that should FAIL and another after: equal snapshots prove nothing was
 * half-saved (stock movements, cash, audit and the documents themselves all roll back together).
 * @returns { tableName: rowCount }
 */
const TABLES = ['stocktakes', 'stocktake_items', 'stock_losses', 'owner_drawings', 'stock_movements', 'cash_entries', 'audit_logs'];
export function snap(s: ApiBase): Record<string, number> {
  return Object.fromEntries(TABLES.map((t) => [t, num(s, `SELECT COUNT(*) FROM ${t}`)]));
}
/**
 * A text snapshot of every product's qty and value; two equal snapshots prove a failed request left stock untouched.
 */
export const productsSnap = (s: ApiBase): string =>
  JSON.stringify(sql(s, 'SELECT id, qty_on_hand, stock_value_cents FROM products ORDER BY id'));

// Request builders for stocktakes: create a draft, complete it, void it, edit it.
// ---------- stocktake ----------
/**
 * Creates a stocktake draft (POST /stocktakes), defaults: today, shop book, fresh clientRef. Returns the raw response.
 */
export const stNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/stocktakes', { businessDate: today(), book: 'shop', clientRef: ref(), ...over });
/**
 * Creates a stocktake draft and returns the created item (throws unless 201).
 * @param items counted lines: { productId, countedQty, gainUnitCostCents? }
 * @param over extra request fields, e.g. { book: 'telecom' }
 */
export async function stDraft(s: ApiBase, items: Array<{ productId: number; countedQty: number; gainUnitCostCents?: number }>, over: Record<string, unknown> = {}): Promise<any> {
  const r = await stNew(s, { items, ...over });
  if (r.status !== 201) throw new Error(`stocktake create failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}
/**
 * Completes a draft: this is the moment gains/losses are valued and posted to stock.
 */
export const stComplete = (s: ApiBase, id: number) => post(s.app, `/stocktakes/${id}/complete`, {});
/**
 * Voids a completed stocktake (R1): writes exact reversal movements (C6).
 */
export const stVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/stocktakes/${id}/void`, { reason });
/**
 * Edits a draft stocktake (PUT /stocktakes/:id); completed ones cannot be edited.
 */
export const stPut = (s: ApiBase, id: number, body: unknown) => put(s.app, `/stocktakes/${id}`, body);

// Request builders for stock losses (damaged / lost / expired / other).
// ---------- losses ----------
/**
 * Records a stock loss of qty units (default reason 'damaged', dated today). Returns the raw response.
 */
export const lossNew = (s: ApiBase, productId: number, qty: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/stock-losses', { businessDate: today(), productId, qty, reason: 'damaged', clientRef: ref(), ...over });
/**
 * Voids a stock loss (R1); stock comes back at the original cost (C6).
 */
export const lossVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/stock-losses/${id}/void`, { reason });

// Request builders for owner drawings; the default kind is 'goods' (stock taken for personal use, below the line).
// ---------- drawings ----------
/**
 * Records a goods drawing of qty units of a product (dated today). Returns the raw response.
 */
export const drawNew = (s: ApiBase, productId: number, qty: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/drawings', { kind: 'goods', businessDate: today(), productId, qty, clientRef: ref(), ...over });
/**
 * Voids a drawing (R1); the goods return to stock at the original cost.
 */
export const drawVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/drawings/${id}/void`, { reason });
