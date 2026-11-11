import { expect } from 'vitest';
import type { AppContext } from '../../app.ts';
import { issueStock } from '../../services/inventory.service.ts';
import { get, post, put } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';

export const FUTURE_MSG = 'Future-dated transactions are not allowed. Please select today or an earlier date.';

export const err = (r: { body: any }): any => r.body.error;

export const sql = (s: { ctx: AppContext }, q: string, ...p: any[]): Array<Record<string, any>> =>
  s.ctx.database.conn.prepare(q).all(...p) as unknown as Array<Record<string, any>>;

export const num = (s: { ctx: AppContext }, q: string, ...p: any[]): number =>
  Number(Object.values(sql(s, q, ...p)[0]!)[0]);

/** Pool of a product straight from the database cache. */
export function poolOf(s: { ctx: AppContext }, id: number): { qty: number; value: number } {
  const r = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
}

/** Pool of a product as the sum of its movements (the independent ledger view). */
export function ledgerOf(s: { ctx: AppContext }, id: number): { qty: number; value: number } {
  const r = sql(s, 'SELECT COALESCE(SUM(qty_delta),0) AS q, COALESCE(SUM(value_delta_cents),0) AS v FROM stock_movements WHERE product_id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
}

export interface Mv {
  id: number; productId: number; type: string; qty: number; value: number; unit: number | null; date: string;
  refTable: string | null; refId: number | null; reason: string; postedAt: string;
}
export function mvs(s: { ctx: AppContext }, where = '1=1', ...p: any[]): Mv[] {
  return sql(s, `SELECT * FROM stock_movements WHERE ${where} ORDER BY id`, ...p).map((m) => ({
    id: Number(m.id), productId: Number(m.product_id), type: m.type, qty: Number(m.qty_delta),
    value: Number(m.value_delta_cents), unit: m.unit_cost_cents === null ? null : Number(m.unit_cost_cents),
    date: m.business_date, refTable: m.ref_table, refId: m.ref_id === null ? null : Number(m.ref_id),
    reason: m.reason, postedAt: m.posted_at,
  }));
}
export const mvsOf = (s: { ctx: AppContext }, productId: number): Mv[] => mvs(s, 'product_id = ?', productId);
export const mvsByRef = (s: { ctx: AppContext }, table: string, id: number): Mv[] =>
  mvs(s, 'ref_table = ? AND ref_id = ?', table, id);

/** Reconciliation through the API must be ok after every step. */
export async function reconOk(s: ApiBase): Promise<void> {
  const r = await get(s.app, '/inventory/reconciliation');
  expect(r.status).toBe(200);
  expect(r.body.ok, JSON.stringify(r.body.mismatches)).toBe(true);
  // plus the physical invariants: no negative qty / value, no value without quantity
  expect(num(s, 'SELECT COUNT(*) FROM products WHERE qty_on_hand < 0 OR stock_value_cents < 0 OR (qty_on_hand = 0 AND stock_value_cents <> 0)')).toBe(0);
}

/** Engine sale (what Phase 5 will do): outflow at the weighted average. */
export const engineSell = (s: ApiBase, productId: number, qty: number, businessDate = today()) =>
  s.ctx.database.tx((c) => issueStock(c, { productId, businessDate, type: 'sale', qty, refTable: null, refId: null, reason: 'test sale' }));

/** Row counts of every table a Phase 4 write may touch. */
const TABLES = ['stocktakes', 'stocktake_items', 'stock_losses', 'owner_drawings', 'stock_movements', 'cash_entries', 'audit_logs'];
export function snap(s: ApiBase): Record<string, number> {
  return Object.fromEntries(TABLES.map((t) => [t, num(s, `SELECT COUNT(*) FROM ${t}`)]));
}
export const productsSnap = (s: ApiBase): string =>
  JSON.stringify(sql(s, 'SELECT id, qty_on_hand, stock_value_cents FROM products ORDER BY id'));

// ---------- stocktake ----------
export const stNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/stocktakes', { businessDate: today(), book: 'shop', clientRef: ref(), ...over });
export async function stDraft(s: ApiBase, items: Array<{ productId: number; countedQty: number; gainUnitCostCents?: number }>, over: Record<string, unknown> = {}): Promise<any> {
  const r = await stNew(s, { items, ...over });
  if (r.status !== 201) throw new Error(`stocktake create failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}
export const stComplete = (s: ApiBase, id: number) => post(s.app, `/stocktakes/${id}/complete`, {});
export const stVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/stocktakes/${id}/void`, { reason });
export const stPut = (s: ApiBase, id: number, body: unknown) => put(s.app, `/stocktakes/${id}`, body);

// ---------- losses ----------
export const lossNew = (s: ApiBase, productId: number, qty: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/stock-losses', { businessDate: today(), productId, qty, reason: 'damaged', clientRef: ref(), ...over });
export const lossVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/stock-losses/${id}/void`, { reason });

// ---------- drawings ----------
export const drawNew = (s: ApiBase, productId: number, qty: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/drawings', { kind: 'goods', businessDate: today(), productId, qty, clientRef: ref(), ...over });
export const drawVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/drawings/${id}/void`, { reason });
