import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type MovementType =
  | 'opening' | 'purchase' | 'purchase_return' | 'purchase_void' | 'sale' | 'sale_return' | 'sale_void'
  | 'personal_use' | 'loss' | 'stocktake_gain' | 'stocktake_loss' | 'adjustment';

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

function map(r: Raw): MovementRow {
  return {
    id: Number(r.id), productId: Number(r.product_id), businessDate: r.business_date, postedAt: r.posted_at,
    type: r.type, qtyDelta: Number(r.qty_delta), valueDeltaCents: Number(r.value_delta_cents),
    unitCostCents: r.unit_cost_cents === null ? null : Number(r.unit_cost_cents),
    refTable: r.ref_table, refId: r.ref_id === null ? null : Number(r.ref_id), reason: r.reason,
  };
}

/** Appends a movement; the database cache trigger updates products.qty_on_hand / stock_value_cents. */
export function insertMovement(conn: DatabaseSync, m: {
  productId: number; businessDate: string; type: MovementType; qtyDelta: number; valueDeltaCents: number;
  unitCostCents: number | null; refTable: string | null; refId: number | null; reason: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.productId, m.businessDate, m.type, m.qtyDelta, m.valueDeltaCents, m.unitCostCents, m.refTable, m.refId, m.reason);
  return Number(res.lastInsertRowid);
}

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
    `SELECT id, product_id, business_date, posted_at, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason
     FROM stock_movements${w} ORDER BY posted_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total };
}

/** Movements written for one source record (e.g. refTable 'stocktakes'), in posting order. */
export function listMovementsByRef(conn: DatabaseSync, refTable: string, refId: number): MovementRow[] {
  const rows = conn.prepare(
    `SELECT id, product_id, business_date, posted_at, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason
     FROM stock_movements WHERE ref_table = ? AND ref_id = ? ORDER BY id ASC`,
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
