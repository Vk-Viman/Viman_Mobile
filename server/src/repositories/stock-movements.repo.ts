/**
 * repositories/stock-movements.repo.ts - SQL for `stock_movements`, the append-only inventory ledger.
 *
 * Layer: repository. Every change of a product's quantity or stock value is exactly one row here
 * (BUSINESS_RULES section 3). The products cache (`qty_on_hand`, `stock_value_cents`) is updated by the
 * database trigger `trg_stock_movements_cache` on insert, never by this code, so SUM(movements) = cache.
 * Rows are never edited or deleted; a void/reversal inserts the negated movement (C6). The costing rules
 * (weighted average, R4 sweep) live in `services/inventory.service.ts`.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { numberOrNull } from './sql-helpers.ts';

/** Why stock changed (BUSINESS_RULES section 3); also restricted by a CHECK in migration 004. */
export type MovementType =
  | 'opening' | 'purchase' | 'purchase_return' | 'purchase_void' | 'sale' | 'sale_return' | 'sale_void'
  | 'personal_use' | 'loss' | 'stocktake_gain' | 'stocktake_loss' | 'adjustment';

/** One ledger row. Inflows have positive deltas, outflows negative; `adjustment` may be value-only (qty 0). */
export interface MovementRow {
  id: number; productId: number; businessDate: string; postedAt: string; type: MovementType;
  qtyDelta: number; valueDeltaCents: number; unitCostCents: number | null;
  refTable: string | null; refId: number | null; reason: string;
}

interface Raw {
  id: number | bigint; product_id: number | bigint; business_date: string; posted_at: string; type: MovementType;
  qty_delta: number | bigint; value_delta_cents: number | bigint; unit_cost_cents: number | bigint | null;
  ref_table: string | null; ref_id: number | bigint | null; reason: string;
}

const SELECT = `SELECT id, product_id, business_date, posted_at, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason
     FROM stock_movements`;

function map(r: Raw): MovementRow {
  return {
    id: Number(r.id), productId: Number(r.product_id), businessDate: r.business_date, postedAt: r.posted_at,
    type: r.type, qtyDelta: Number(r.qty_delta), valueDeltaCents: Number(r.value_delta_cents),
    unitCostCents: numberOrNull(r.unit_cost_cents),
    refTable: r.ref_table, refId: numberOrNull(r.ref_id), reason: r.reason,
  };
}

/**
 * Appends a movement; the database cache trigger updates products.qty_on_hand / stock_value_cents.
 * The database may refuse it (negative quantity/value, value left in an empty pool, future date, R-FD).
 *
 * @returns The new movement id.
 */
export function insertMovement(conn: DatabaseSync, m: {
  productId: number; businessDate: string; type: MovementType; qtyDelta: number; valueDeltaCents: number;
  unitCostCents: number | null; refTable: string | null; refId: number | null; reason: string;
  /** Migration 020: the original movement this row reverses (void paths only); at most one reversal per original. */
  reversesMovementId?: number | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason, reverses_movement_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.productId, m.businessDate, m.type, m.qtyDelta, m.valueDeltaCents, m.unitCostCents, m.refTable, m.refId, m.reason,
    m.reversesMovementId ?? null);
  return Number(res.lastInsertRowid);
}

/**
 * The oldest ORIGINAL movement of a record (not itself a reversal) for one product and quantity that has no reversal yet.
 * Void paths use it to link each reversal row to the exact row it cancels (migration 020), also for records posted before
 * the link column existed. `qty` is the signed quantity of the original (positive for an inflow).
 */
export function findUnreversedMovement(conn: DatabaseSync, refTable: string, refId: number, productId: number, qty: number): MovementRow | undefined {
  const r = conn.prepare(
    `${SELECT} WHERE ref_table = ? AND ref_id = ? AND product_id = ? AND qty_delta = ? AND reverses_movement_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x.reverses_movement_id = stock_movements.id)
      ORDER BY id ASC LIMIT 1`,
  ).get(refTable, refId, productId, qty) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** One movement by id, or undefined. */
export function getMovement(conn: DatabaseSync, id: number): MovementRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Movement history of one product, newest posting first, with the total number of matches. */
export function listMovements(conn: DatabaseSync, q: {
  productId: number; from?: string; to?: string; type?: MovementType; limit: number; offset: number;
}): { items: MovementRow[]; total: number } {
  const where: string[] = ['product_id = ?'];
  const params: SQLInputValue[] = [q.productId];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.type !== undefined) { where.push('type = ?'); params.push(q.type); }
  const w = ` WHERE ${where.join(' AND ')}`;
  const total = Number((conn.prepare(`SELECT COUNT(*) AS n FROM stock_movements${w}`).get(...params) as unknown as { n: number | bigint }).n);
  const rows = conn.prepare(
    `${SELECT}${w} ORDER BY posted_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total };
}

/** Movements written for one source record (e.g. refTable 'stocktakes'), in posting order. */
export function listMovementsByRef(conn: DatabaseSync, refTable: string, refId: number): MovementRow[] {
  const rows = conn.prepare(
    `${SELECT} WHERE ref_table = ? AND ref_id = ? ORDER BY id ASC`,
  ).all(refTable, refId) as unknown as Raw[];
  return rows.map(map);
}

/** Per-product SUM of movements dated on or before asOf (business-date basis), for valuation. */
export function sumMovementsAsOf(conn: DatabaseSync, asOf: string): Array<{ productId: number; qty: number; valueCents: number }> {
  const rows = conn.prepare(
    `SELECT product_id, SUM(qty_delta) AS qty, SUM(value_delta_cents) AS value_cents
     FROM stock_movements WHERE business_date <= ? GROUP BY product_id ORDER BY product_id`,
  ).all(asOf) as unknown as Array<{ product_id: number | bigint; qty: number | bigint; value_cents: number | bigint }>;
  return rows.map((r) => ({ productId: Number(r.product_id), qty: Number(r.qty), valueCents: Number(r.value_cents) }));
}

/** Per-product SUM of movements (for reconciliation against the products cache). */
export function sumMovements(conn: DatabaseSync): Array<{ productId: number; qty: number; valueCents: number }> {
  const rows = conn.prepare(
    `SELECT product_id, SUM(qty_delta) AS qty, SUM(value_delta_cents) AS value_cents
     FROM stock_movements GROUP BY product_id ORDER BY product_id`,
  ).all() as unknown as Array<{ product_id: number | bigint; qty: number | bigint; value_cents: number | bigint }>;
  return rows.map((r) => ({ productId: Number(r.product_id), qty: Number(r.qty), valueCents: Number(r.value_cents) }));
}
