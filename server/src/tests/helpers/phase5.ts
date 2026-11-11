// Helpers for Phase 5 tests: POS sales, sales returns, sale voids and damaged-return losses
// (BUSINESS_RULES sections 2, 3, 4, R1, R5/C5, C6, R13, R-FD, R-RD, 12).
// Three groups: (1) raw-SQL builders for database-level tests (sqlSale, sqlSaleItem, sqlReturn, sqlReturnItem);
// (2) request builders for API tests (sellNew/sellOk, returnNew/returnOk, voidSaleNew) plus fixtures and row readers;
// (3) an INDEPENDENT BigInt model of the C5 split (mdr, splitModel) so tests can check the server's return
//     portions without copying its code.
// Everything else (pool/ledger readers, reconOk, today(), ref() ...) is reused from helpers/inventory.ts and phase4.ts.

import { expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../../app.ts';
import { post } from './catalog.ts';
import { buy, ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { num, sql } from './phase4.ts';

// ---------------------------------------------------------------------------------------------
// Exact field lists of the API shapes (contract check: a field may not appear or vanish silently).
// ---------------------------------------------------------------------------------------------
/** Sorted keys of a Sale in API responses. */
export const SALE_KEYS = [
  'backdated', 'book', 'businessDate', 'clientRef', 'cogsCents', 'grossProfitCents', 'id', 'items', 'notes', 'postedAt',
  'returns', 'status', 'totalCents', 'voidReason', 'voidedAt',
].sort();
/** Sorted keys of a SaleItem (one sold line). */
export const SALE_ITEM_KEYS = [
  'cogsCents', 'id', 'lineNo', 'lineType', 'productCode', 'productId', 'productName', 'qty', 'returnedQty', 'revenueCents',
  'unitCostCents', 'unitPriceCents',
].sort();
/** Sorted keys of a SaleReturn. */
export const RETURN_KEYS = [
  'backdated', 'businessDate', 'clientRef', 'cogsReversedCents', 'id', 'items', 'note', 'postedAt', 'refundCents', 'saleId',
].sort();
/** Sorted keys of one returned line. */
export const RETURN_ITEM_KEYS = ['cogsCents', 'id', 'productId', 'productName', 'qty', 'resalable', 'revenueCents', 'saleItemId'].sort();
/** Sorted keys of a StockLoss (Phase 5 adds `salesReturnId`). */
export const LOSS_KEYS = [
  'backdated', 'book', 'businessDate', 'clientRef', 'costCents', 'id', 'note', 'postedAt', 'productId', 'productName', 'qty',
  'reason', 'salesReturnId', 'source', 'status', 'unitCostCents', 'voidReason', 'voidedAt',
].sort();

let seq5 = 0;
/** A unique clientRef-like text for raw SQL rows (the unique columns need a new value every time). */
export const uniq5 = (): string => `p5-${seq5++}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------------------------
// (1) Raw SQL builders (database-level tests; no business logic, no stock movements).
// ---------------------------------------------------------------------------------------------
/**
 * Inserts a sales row directly. Defaults: shop, today, total 300000, posted, fresh client_ref.
 * @param o date, book, total, status ('posted'|'void'), ref, voidedAt, voidReason, notes
 * @returns the new sale id
 */
export function sqlSale(c: DatabaseSync, o: Record<string, any> = {}): number {
  return Number(c.prepare(
    `INSERT INTO sales (business_date, book, total_cents, status, notes, client_ref, voided_at, void_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.date ?? today(), o.book ?? 'shop', o.total ?? 300000, o.status ?? 'posted', o.notes ?? '', o.ref ?? uniq5(),
    o.voidedAt ?? null, o.voidReason ?? null).lastInsertRowid);
}

/**
 * Inserts a sale line directly. Defaults: line number 1, qty 3, unit price 100000, cogs 70000, unit cost 23333,
 * revenue = qty x price, line type goods (shop sale) or card (telecom sale), returned_qty 0.
 * @param o lineNo, qty, price, cost, cogs, revenue, type, returned, description
 * @returns the new sale item id
 */
export function sqlSaleItem(c: DatabaseSync, saleId: number, productId: number, o: Record<string, any> = {}): number {
  const book = (c.prepare('SELECT book FROM sales WHERE id = ?').get(saleId) as { book: string } | undefined)?.book ?? 'shop';
  const qty = o.qty ?? 3;
  const price = o.price ?? 100000;
  return Number(c.prepare(
    `INSERT INTO sale_items (sale_id, line_no, line_type, product_id, description, qty, unit_price_cents, unit_cost_cents,
                             revenue_cents, cogs_cents, returned_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(saleId, o.lineNo ?? 1, o.type ?? (book === 'shop' ? 'goods' : 'card'), productId, o.description ?? 'Item', qty, price,
    o.cost ?? 23333, o.revenue ?? qty * price, o.cogs ?? 70000, o.returned ?? 0).lastInsertRowid);
}

/**
 * Inserts a sales_returns header directly. Defaults: today, refund 100000, cogs 23333, fresh client_ref.
 * @param o date, refund, cogs, note, ref
 * @returns the new return id
 */
export function sqlReturn(c: DatabaseSync, saleId: number, o: Record<string, any> = {}): number {
  return Number(c.prepare(
    `INSERT INTO sales_returns (sale_id, business_date, refund_cents, cogs_reversed_cents, note, client_ref)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(saleId, o.date ?? today(), o.refund ?? 100000, o.cogs ?? 23333, o.note ?? '', o.ref ?? uniq5()).lastInsertRowid);
}

/**
 * Inserts a sales_return_items row directly. Defaults: resalable, revenue 100000, cogs 23333.
 * @returns the new row id
 */
export function sqlReturnItem(c: DatabaseSync, returnId: number, saleItemId: number, qty: number, o: Record<string, any> = {}): number {
  return Number(c.prepare(
    `INSERT INTO sales_return_items (sales_return_id, sale_item_id, qty, resalable, revenue_cents, cogs_cents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(returnId, saleItemId, qty, o.resalable ?? 1, o.revenue ?? 100000, o.cogs ?? 23333).lastInsertRowid);
}

// ---------------------------------------------------------------------------------------------
// (2) API request builders, fixtures and readers.
// ---------------------------------------------------------------------------------------------
/** One cart line of POST /sales. */
export const cl = (productId: number, qty: number, unitPriceCents: number) => ({ productId, qty, unitPriceCents });

/**
 * POST /sales (raw response). Defaults: dated today, fresh clientRef. `over` can replace or add any body field.
 */
export const sellNew = (s: ApiBase, items: unknown[], over: Record<string, unknown> = {}) =>
  post(s.app, '/sales', { businessDate: today(), items, clientRef: ref(), ...over });

/**
 * POST /sales that must answer 201; returns the body `{ sales, warnings }`. Fails loudly otherwise so a broken
 * set-up never hides behind a later assertion.
 */
export async function sellOk(s: ApiBase, items: unknown[], over: Record<string, unknown> = {}): Promise<{ sales: any[]; warnings: any[] }> {
  const r = await sellNew(s, items, over);
  if (r.status !== 201) throw new Error(`sale failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Sells a single line and returns that one sale (throws unless 201). */
export async function sellOne(s: ApiBase, productId: number, qty: number, unitPriceCents: number, over: Record<string, unknown> = {}): Promise<any> {
  return (await sellOk(s, [cl(productId, qty, unitPriceCents)], over)).sales[0];
}

/** One return line of POST /sales/:id/returns. */
export const rl = (saleItemId: number, qty: number, resalable: boolean) => ({ saleItemId, qty, resalable });

/**
 * POST /sales/:id/returns (raw response). Defaults: dated today, fresh clientRef.
 */
export const returnNew = (s: ApiBase, saleId: number, items: unknown[], over: Record<string, unknown> = {}) =>
  post(s.app, `/sales/${saleId}/returns`, { businessDate: today(), items, clientRef: ref(), ...over });

/** POST /sales/:id/returns that must answer 201; returns `{ item, sale }`. */
export async function returnOk(s: ApiBase, saleId: number, items: unknown[], over: Record<string, unknown> = {}): Promise<{ item: any; sale: any }> {
  const r = await returnNew(s, saleId, items, over);
  if (r.status !== 201) throw new Error(`return failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** POST /sales/:id/void (raw response). */
export const voidSaleNew = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/sales/${id}/void`, { reason });

/**
 * Fixture: a product (made by `mk`, default via the caller) holding exactly `units` units worth `value` cents.
 * @param mk product factory, e.g. mkProduct or mkTelecom
 */
export async function stocked(s: ApiBase, mk: (s: ApiBase, o?: Record<string, unknown>) => Promise<any>, units: number, value: number,
  over: Record<string, unknown> = {}): Promise<any> {
  const p = await mk(s, over);
  await buy(s, [{ productId: p.id, packs: 1, packSize: units, lineTotalCents: value }]);
  return p;
}

/** Fixture: stocked product with 10 @ Rs 3,000 and 10 @ Rs 4,000 -> pool 20 / 700000 (average 35000). */
export async function stocked20(s: ApiBase, mk: (s: ApiBase, o?: Record<string, unknown>) => Promise<any>, over: Record<string, unknown> = {}): Promise<any> {
  const p = await mk(s, over);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 300000 }]);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 400000 }]);
  return p;
}

/** Row counts of every table a Phase 5 write may touch; equal before/after a failed request = nothing half-saved. */
const TABLES5 = ['sales', 'sale_items', 'sales_returns', 'sales_return_items', 'stock_losses', 'stock_movements', 'cash_entries', 'audit_logs'];
export function snap5(s: { ctx: AppContext }): Record<string, number> {
  return Object.fromEntries(TABLES5.map((t) => [t, num(s, `SELECT COUNT(*) FROM ${t}`)]));
}

/** Balance of a cash book (sum of its ledger rows). */
export const cashBal = (s: { ctx: AppContext }, book: string): number =>
  num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', book);

/** Cash rows written for one source document (`refTable` 'sales' or 'sales_returns'), oldest first. */
export const cashOfRef = (s: { ctx: AppContext }, refTable: string, refId: number): Array<Record<string, any>> =>
  sql(s, 'SELECT * FROM cash_entries WHERE ref_table = ? AND ref_id = ? ORDER BY id', refTable, refId);

/** All stock_losses rows straight from the database, oldest first. */
export const lossRows = (s: { ctx: AppContext }): Array<Record<string, any>> => sql(s, 'SELECT * FROM stock_losses ORDER BY id');

/** Installs a trigger that makes any cash_entries insert of the given type abort (forces a failure late in a write). */
export function breakCash(ctx: AppContext, type: string): void {
  ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries
    WHEN NEW.type = '${type}' BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
}

/** Installs a trigger that makes any stock_losses insert abort (forces a failure inside a damaged return). */
export function breakLoss(ctx: AppContext): void {
  ctx.database.conn.exec(`CREATE TRIGGER test_break_loss BEFORE INSERT ON stock_losses
    BEGIN SELECT RAISE(ABORT, 'loss boom'); END`);
}

/** Asserts that two row-count snapshots are equal (a failed request left every Phase 5 table untouched). */
export function expectUnchanged(before: Record<string, number>, after: Record<string, number>): void {
  expect(after).toEqual(before);
}

// ---------------------------------------------------------------------------------------------
// (3) Independent BigInt model of the money rules (written from BUSINESS_RULES, not from the server code).
// ---------------------------------------------------------------------------------------------
/** round(a x b / c), half away from zero, for non-negative operands, in BigInt. */
export function mdr(a: bigint, b: bigint, c: bigint): bigint {
  const n = a * b;
  const q = n / c;
  return (n % c) * 2n >= c ? q + 1n : q;
}

/**
 * C5 split of a line's amount over successive returns.
 * Each return takes round(total x q / lineQty) (never more than what is left), except the return that brings the
 * cumulative returned quantity to the whole line, which takes EXACTLY what is left. So the parts always add up to total.
 * @param total   amount of the whole line (revenue or cogs), cents
 * @param lineQty units on the line
 * @param seq     units returned by each successive return (sum must not exceed lineQty)
 * @returns one amount per return
 */
export function splitModel(total: number, lineQty: number, seq: number[]): number[] {
  const out: bigint[] = [];
  let given = 0n;
  let units = 0;
  for (const q of seq) {
    const left = BigInt(total) - given;
    units += q;
    let part = units === lineQty ? left : mdr(BigInt(total), BigInt(q), BigInt(lineQty));
    if (part > left) part = left;
    given += part;
    out.push(part);
  }
  return out.map(Number);
}
