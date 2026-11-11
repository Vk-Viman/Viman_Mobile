/**
 * repositories/stocktakes.repo.ts - SQL for `stocktakes` and `stocktake_items` (physical stock counts).
 *
 * Layer: repository. A stocktake starts as a `draft` (counted quantities can be edited freely), then is
 * `completed` (the differences become stock movements, written by `stocktake.service.ts`) or `void`.
 * The status rules are guarded by the triggers of migration 005: items change only while the stocktake is a
 * draft, only stock products of the stocktake's book may be counted, and only the transitions
 * draft -> completed | void and completed -> void are allowed. No business rules live in this file.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC, numberOrNull } from './sql-helpers.ts';

export type StocktakeBook = 'shop' | 'telecom';
export type StocktakeStatus = 'draft' | 'completed' | 'void';

/** Stocktake header. */
export interface StocktakeRow {
  id: number; businessDate: string; postedAt: string; book: StocktakeBook; status: StocktakeStatus;
  notes: string; clientRef: string; completedAt: string | null; voidedAt: string | null; voidReason: string | null;
}
/** One counted product; the `expected*`/`difference*`/`valueDelta` columns are filled only when completed. */
export interface StocktakeItemRow {
  id: number; stocktakeId: number; productId: number; productName: string; productCode: string | null;
  countedQty: number; expectedQty: number | null; differenceQty: number | null;
  valueDeltaCents: number | null; gainUnitCostCents: number | null;
}

type N = number | bigint;
interface Raw {
  id: N; business_date: string; posted_at: string; book: StocktakeBook; status: StocktakeStatus;
  notes: string; client_ref: string; completed_at: string | null; voided_at: string | null; void_reason: string | null;
}
interface RawItem {
  id: N; stocktake_id: N; product_id: N; product_name: string; product_code: string | null; counted_qty: N;
  expected_qty: N | null; difference_qty: N | null; value_delta_cents: N | null; gain_unit_cost_cents: N | null;
}

const SELECT = `SELECT id, business_date, posted_at, book, status, notes, client_ref, completed_at, voided_at, void_reason FROM stocktakes`;

function map(r: Raw): StocktakeRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, book: r.book, status: r.status,
    notes: r.notes, clientRef: r.client_ref, completedAt: r.completed_at, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
}

/** Inserts an empty draft stocktake and returns its id. */
export function insertStocktake(conn: DatabaseSync, s: {
  businessDate: string; book: StocktakeBook; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO stocktakes (business_date, book, notes, client_ref) VALUES (?, ?, ?, ?)`,
  ).run(s.businessDate, s.book, s.notes, s.clientRef);
  return Number(res.lastInsertRowid);
}

/** One stocktake by id, or undefined. */
export function getStocktake(conn: DatabaseSync, id: number): StocktakeRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The stocktake already saved under this client reference (idempotent retry), or undefined. */
export function getStocktakeByClientRef(conn: DatabaseSync, ref: string): StocktakeRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE client_ref = ?`).get(ref) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Lists stocktakes, newest business date first, with the total number of matches. */
export function listStocktakes(conn: DatabaseSync, q: {
  from?: string; to?: string; book?: StocktakeBook; status?: StocktakeStatus; limit: number; offset: number;
}): { items: StocktakeRow[]; total: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.book !== undefined) { where.push('book = ?'); params.push(q.book); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((conn.prepare(`SELECT COUNT(*) AS n FROM stocktakes${w}`).get(...params) as unknown as { n: N }).n);
  const rows = conn.prepare(`${SELECT}${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total };
}

/** Replaces the whole item list (deletes then inserts). Draft only: the database triggers enforce it. */
export function replaceStocktakeItems(conn: DatabaseSync, stocktakeId: number, items: Array<{
  productId: number; countedQty: number; gainUnitCostCents?: number | null;
}>): void {
  conn.prepare('DELETE FROM stocktake_items WHERE stocktake_id = ?').run(stocktakeId);
  const ins = conn.prepare(
    `INSERT INTO stocktake_items (stocktake_id, product_id, counted_qty, gain_unit_cost_cents) VALUES (?, ?, ?, ?)`,
  );
  for (const i of items) ins.run(stocktakeId, i.productId, i.countedQty, i.gainUnitCostCents ?? null);
}

/** Notes may change only while the stocktake is a draft (trigger). */
export function updateStocktakeNotes(conn: DatabaseSync, id: number, notes: string): void {
  conn.prepare('UPDATE stocktakes SET notes = ? WHERE id = ?').run(notes, id);
}

/** The counted lines of one stocktake in entry order, with product name and code. */
export function listStocktakeItems(conn: DatabaseSync, stocktakeId: number): StocktakeItemRow[] {
  const rows = conn.prepare(
    `SELECT i.id, i.stocktake_id, i.product_id, p.name AS product_name, p.code AS product_code, i.counted_qty,
            i.expected_qty, i.difference_qty, i.value_delta_cents, i.gain_unit_cost_cents
     FROM stocktake_items i JOIN products p ON p.id = i.product_id WHERE i.stocktake_id = ? ORDER BY i.id`,
  ).all(stocktakeId) as unknown as RawItem[];
  return rows.map((r) => ({
    id: Number(r.id), stocktakeId: Number(r.stocktake_id), productId: Number(r.product_id),
    productName: r.product_name, productCode: r.product_code, countedQty: Number(r.counted_qty),
    expectedQty: numberOrNull(r.expected_qty), differenceQty: numberOrNull(r.difference_qty),
    valueDeltaCents: numberOrNull(r.value_delta_cents), gainUnitCostCents: numberOrNull(r.gain_unit_cost_cents),
  }));
}

/** Stores the completion figures of one item (parent must still be draft; call before markStocktakeCompleted). */
export function completeStocktakeItem(conn: DatabaseSync, itemId: number, v: {
  expectedQty: number; differenceQty: number; valueDeltaCents: number; gainUnitCostCents: number | null;
}): void {
  conn.prepare(
    `UPDATE stocktake_items SET expected_qty = ?, difference_qty = ?, value_delta_cents = ?, gain_unit_cost_cents = ? WHERE id = ?`,
  ).run(v.expectedQty, v.differenceQty, v.valueDeltaCents, v.gainUnitCostCents, itemId);
}

/** draft -> completed; completed_at is the database clock. */
export function markStocktakeCompleted(conn: DatabaseSync, id: number): void {
  conn.prepare(
    `UPDATE stocktakes SET status = 'completed', completed_at = ${SQL_NOW_UTC} WHERE id = ?`,
  ).run(id);
}

/** draft -> void or completed -> void; voided_at is the database clock. */
export function markStocktakeVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(
    `UPDATE stocktakes SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`,
  ).run(reason, id);
}
