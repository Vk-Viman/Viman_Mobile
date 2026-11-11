import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { getProduct, listProducts } from '../repositories/products.repo.ts';
import { insertMovement, listMovements, sumMovements, sumMovementsAsOf } from '../repositories/stock-movements.repo.ts';
import type { MovementRow } from '../repositories/stock-movements.repo.ts';
import { getProductItem } from './catalog.service.ts';
import type { Product } from './catalog.service.ts';

export type MovementType =
  | 'opening' | 'purchase' | 'purchase_return' | 'purchase_void' | 'sale' | 'sale_return' | 'sale_void'
  | 'personal_use' | 'loss' | 'stocktake_gain' | 'stocktake_loss' | 'adjustment';

export const MOVEMENT_TYPES: readonly MovementType[] = [
  'opening', 'purchase', 'purchase_return', 'purchase_void', 'sale', 'sale_return', 'sale_void',
  'personal_use', 'loss', 'stocktake_gain', 'stocktake_loss', 'adjustment',
];

export interface PoolState { qty: number; valueCents: number }

export type StockMovement = MovementRow;

function assertInt(n: number, name: string, min: number): void {
  if (!Number.isSafeInteger(n) || n < min) {
    throw new RangeError(`${name} must be a safe integer >= ${min}`);
  }
}

/** Current pool (quantity and value) of a product, from the DB-maintained cache. Throws 404 NOT_FOUND. */
export function getPool(conn: DatabaseSync, productId: number): PoolState {
  const p = getProduct(conn, productId);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found.');
  return { qty: p.qtyOnHand, valueCents: p.stockValueCents };
}

function insufficient(productId: number, onHand: number, needed: number): AppError {
  return new AppError(422, 'INSUFFICIENT_STOCK',
    `Not enough stock: ${onHand} on hand, ${needed} needed.`, undefined, { onHand, productId });
}

/** Inflow: adds the quantity and the exact value to the pool (BUSINESS_RULES section 3). */
export function receiveStock(conn: DatabaseSync, p: {
  productId: number; businessDate: string; type: MovementType; qty: number; valueCents: number;
  refTable: string | null; refId: number | null; reason: string;
}): { movementId: number; unitCostCents: number } {
  assertInt(p.qty, 'qty', 1);
  assertInt(p.valueCents, 'valueCents', 0);
  const pool = getPool(conn, p.productId);
  assertInt(pool.qty + p.qty, 'resulting quantity', 0);
  assertInt(pool.valueCents + p.valueCents, 'resulting value', 0);
  const unitCostCents = mulDivRound(p.valueCents, 1, p.qty);
  const movementId = insertMovement(conn, {
    productId: p.productId, businessDate: p.businessDate, type: p.type,
    qtyDelta: p.qty, valueDeltaCents: p.valueCents, unitCostCents,
    refTable: p.refTable, refId: p.refId, reason: p.reason,
  });
  return { movementId, unitCostCents };
}

/** Outflow at the weighted average. Removing the whole pool removes its whole value (no residue). */
export function issueStock(conn: DatabaseSync, p: {
  productId: number; businessDate: string; type: MovementType; qty: number;
  refTable: string | null; refId: number | null; reason: string;
}): { movementId: number; valueRemovedCents: number; unitCostCents: number } {
  assertInt(p.qty, 'qty', 1);
  const pool = getPool(conn, p.productId);
  if (p.qty > pool.qty) throw insufficient(p.productId, pool.qty, p.qty);
  const valueRemovedCents = p.qty === pool.qty ? pool.valueCents : mulDivRound(pool.valueCents, p.qty, pool.qty);
  const unitCostCents = mulDivRound(valueRemovedCents, 1, p.qty);
  const movementId = insertMovement(conn, {
    productId: p.productId, businessDate: p.businessDate, type: p.type,
    qtyDelta: -p.qty, valueDeltaCents: -valueRemovedCents, unitCostCents,
    refTable: p.refTable, refId: p.refId, reason: p.reason,
  });
  return { movementId, unitCostCents, valueRemovedCents };
}

/**
 * R4 removal for a purchase return / void: removes `qty` at min(maxValueCents, pool value). When the pool
 * quantity reaches 0 with value left, the leftover is first swept by a value-only 'adjustment' movement
 * (so that every intermediate database state is valid), then the removal is written.
 */
export function issueStockCapped(conn: DatabaseSync, p: {
  productId: number; businessDate: string; type: 'purchase_return' | 'purchase_void'; qty: number;
  maxValueCents: number; refTable: string | null; refId: number | null; reason: string;
}): { movementId: number; valueRemovedCents: number; sweepMovementId: number | null; sweptCents: number } {
  assertInt(p.qty, 'qty', 1);
  assertInt(p.maxValueCents, 'maxValueCents', 0);
  const pool = getPool(conn, p.productId);
  if (p.qty > pool.qty) throw insufficient(p.productId, pool.qty, p.qty);
  const valueRemovedCents = Math.min(p.maxValueCents, pool.valueCents);
  let sweepMovementId: number | null = null;
  let sweptCents = 0;
  if (pool.qty - p.qty === 0 && pool.valueCents - valueRemovedCents > 0) {
    sweptCents = pool.valueCents - valueRemovedCents;
    sweepMovementId = insertMovement(conn, {
      productId: p.productId, businessDate: p.businessDate, type: 'adjustment',
      qtyDelta: 0, valueDeltaCents: -sweptCents, unitCostCents: null,
      refTable: p.refTable, refId: p.refId, reason: 'Residual value swept (R4)',
    });
  }
  const movementId = insertMovement(conn, {
    productId: p.productId, businessDate: p.businessDate, type: p.type,
    qtyDelta: -p.qty, valueDeltaCents: -valueRemovedCents, unitCostCents: mulDivRound(valueRemovedCents, 1, p.qty),
    refTable: p.refTable, refId: p.refId, reason: p.reason,
  });
  return { movementId, valueRemovedCents, sweepMovementId, sweptCents };
}

/** Compares the products cache with the sums of the movements; must always be ok. */
export function reconcileStock(conn: DatabaseSync): {
  ok: boolean; checkedProducts: number;
  mismatches: Array<{
    productId: number; name: string; cacheQty: number; movementQty: number;
    cacheValueCents: number; movementValueCents: number;
  }>;
} {
  const sums = new Map<number, { qty: number; valueCents: number }>();
  for (const s of sumMovements(conn)) sums.set(s.productId, { qty: s.qty, valueCents: s.valueCents });
  const products = listProducts(conn, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }).items;
  const mismatches = [];
  for (const p of products) {
    const s = sums.get(p.id) ?? { qty: 0, valueCents: 0 };
    if (p.qtyOnHand !== s.qty || p.stockValueCents !== s.valueCents) {
      mismatches.push({
        productId: p.id, name: p.name, cacheQty: p.qtyOnHand, movementQty: s.qty,
        cacheValueCents: p.stockValueCents, movementValueCents: s.valueCents,
      });
    }
  }
  return { ok: mismatches.length === 0, checkedProducts: products.length, mismatches };
}

export function reconciliation(ctx: AppContext) {
  return reconcileStock(ctx.database.conn);
}

export function listProductMovements(
  ctx: AppContext, productId: number,
  q: { from?: string; to?: string; type?: MovementType; limit: number; offset: number },
): { items: StockMovement[]; total: number; product: Product } {
  const product = getProductItem(ctx, productId); // 404 for an unknown product
  const query: { productId: number; from?: string; to?: string; type?: MovementType; limit: number; offset: number } = {
    productId, limit: q.limit, offset: q.offset,
  };
  if (q.from !== undefined) query.from = q.from;
  if (q.to !== undefined) query.to = q.to;
  if (q.type !== undefined) query.type = q.type;
  const { items, total } = listMovements(ctx.database.conn, query);
  return { items, total, product };
}

// ---------- Phase 4 additions ----------

/** Pool (quantity and value) of every product as the sum of movements dated on or before `asOf` (business-date basis). */
export function poolsAsOf(conn: DatabaseSync, asOf: string): Map<number, PoolState> {
  const pools = new Map<number, PoolState>();
  for (const s of sumMovementsAsOf(conn, asOf)) pools.set(s.productId, { qty: s.qty, valueCents: s.valueCents });
  return pools;
}

/**
 * Value of a stocktake / opening gain (BUSINESS_RULES C10): the current average (`mulDivRound(value, gain, qty)`)
 * when the pool has both quantity and value; otherwise `gainQty x gainUnitCostCents`, which is then required.
 */
export function gainValue(pool: PoolState, gainQty: number, gainUnitCostCents: number | null): number {
  assertInt(gainQty, 'gainQty', 1);
  if (pool.qty > 0 && pool.valueCents > 0) return mulDivRound(pool.valueCents, gainQty, pool.qty);
  if (gainUnitCostCents === null) {
    throw new AppError(422, 'UNIT_COST_REQUIRED',
      'This product has no stock value to average from. Enter a unit cost for the extra units.');
  }
  assertInt(gainUnitCostCents, 'gainUnitCostCents', 0);
  return mulDivRound(gainQty, gainUnitCostCents, 1);
}

/**
 * The value `issueStock` would remove for `qty` units right now (same formula), so a source record can be
 * written with its exact cost before its movement. Throws 422 INSUFFICIENT_STOCK when qty exceeds the pool.
 */
export function outflowValue(conn: DatabaseSync, productId: number, qty: number): number {
  assertInt(qty, 'qty', 1);
  const pool = getPool(conn, productId);
  if (qty > pool.qty) throw insufficient(productId, pool.qty, qty);
  return qty === pool.qty ? pool.valueCents : mulDivRound(pool.valueCents, qty, pool.qty);
}

function loadMovementsById(conn: DatabaseSync, ids: number[]): MovementRow[] {
  const stmt = conn.prepare(
    `SELECT id, product_id, business_date, posted_at, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason
     FROM stock_movements WHERE id = ?`,
  );
  const out: MovementRow[] = [];
  for (const id of ids) {
    const r = stmt.get(id) as unknown as {
      id: number | bigint; product_id: number | bigint; business_date: string; posted_at: string; type: MovementType;
      qty_delta: number | bigint; value_delta_cents: number | bigint; unit_cost_cents: number | bigint | null;
      ref_table: string | null; ref_id: number | bigint | null; reason: string;
    } | undefined;
    if (!r) throw new Error(`Stock movement #${id} not found`);
    out.push({
      id: Number(r.id), productId: Number(r.product_id), businessDate: r.business_date, postedAt: r.posted_at,
      type: r.type, qtyDelta: Number(r.qty_delta), valueDeltaCents: Number(r.value_delta_cents),
      unitCostCents: r.unit_cost_cents === null ? null : Number(r.unit_cost_cents),
      refTable: r.ref_table, refId: r.ref_id === null ? null : Number(r.ref_id), reason: r.reason,
    });
  }
  return out;
}

/**
 * Reversal (C6): inserts the exact negation of each given movement (same type, business date, ref and unit cost),
 * returning the new ids. Rows are processed newest-first so every intermediate state is valid, and each
 * negation is checked against the live pool first: 422 INSUFFICIENT_STOCK when it would drive the quantity or
 * the value below 0 (or leave value in an empty pool). Run inside the caller's transaction.
 */
export function reverseMovements(conn: DatabaseSync, movementIds: number[], reason: string): number[] {
  const originals = loadMovementsById(conn, movementIds).sort((a, b) => b.id - a.id);
  const created: number[] = [];
  for (const m of originals) {
    const qtyDelta = m.qtyDelta === 0 ? 0 : -m.qtyDelta;
    const valueDeltaCents = m.valueDeltaCents === 0 ? 0 : -m.valueDeltaCents;
    const pool = getPool(conn, m.productId);
    const qty = pool.qty + qtyDelta;
    const value = pool.valueCents + valueDeltaCents;
    if (qty < 0 || value < 0 || (qty === 0 && value !== 0)) {
      throw insufficient(m.productId, pool.qty, Math.max(0, -qtyDelta));
    }
    created.push(insertMovement(conn, {
      productId: m.productId, businessDate: m.businessDate, type: m.type, qtyDelta, valueDeltaCents,
      unitCostCents: m.unitCostCents, refTable: m.refTable, refId: m.refId, reason,
    }));
  }
  return created;
}

export interface ValuationItem {
  productId: number; code: string | null; name: string; categoryId: number; categoryName: string;
  book: 'shop' | 'telecom'; active: boolean; qty: number; valueCents: number; avgUnitCostCents: number | null;
}
export interface Valuation {
  asOf: string | null;
  items: ValuationItem[];
  totals: {
    qty: number; valueCents: number;
    byBook: { shop: { qty: number; valueCents: number }; telecom: { qty: number; valueCents: number } };
  };
}

/** Stock on hand and value per stock product: live cache, or Σ movements dated <= asOf (earlier than today). */
export function valuation(ctx: AppContext, q: {
  book?: 'shop' | 'telecom'; categoryId?: number; asOf?: string; includeZero?: boolean; includeInactive?: boolean;
}): Valuation {
  const conn = ctx.database.conn;
  const includeZero = q.includeZero === true;
  const includeInactive = q.includeInactive !== false;
  const historical = q.asOf !== undefined && q.asOf < todayBusinessDate();
  const pools = historical ? poolsAsOf(conn, q.asOf as string) : null;

  const query: Parameters<typeof listProducts>[1] = { limit: Number.MAX_SAFE_INTEGER, offset: 0 };
  if (q.book !== undefined) query.book = q.book;
  if (q.categoryId !== undefined) query.categoryId = q.categoryId;
  if (!includeInactive) query.active = true;

  const items: ValuationItem[] = [];
  const totals = {
    qty: 0, valueCents: 0,
    byBook: { shop: { qty: 0, valueCents: 0 }, telecom: { qty: 0, valueCents: 0 } },
  };
  for (const p of listProducts(conn, query).items) {
    if (p.kind !== 'stock') continue;
    const pool = pools ? (pools.get(p.id) ?? { qty: 0, valueCents: 0 }) : { qty: p.qtyOnHand, valueCents: p.stockValueCents };
    if (!includeZero && pool.qty === 0 && pool.valueCents === 0) continue;
    items.push({
      productId: p.id, code: p.code, name: p.name, categoryId: p.categoryId, categoryName: p.categoryName,
      book: p.book, active: p.active, qty: pool.qty, valueCents: pool.valueCents,
      avgUnitCostCents: pool.qty > 0 ? mulDivRound(pool.valueCents, 1, pool.qty) : null,
    });
    totals.qty += pool.qty;
    totals.valueCents += pool.valueCents;
    totals.byBook[p.book].qty += pool.qty;
    totals.byBook[p.book].valueCents += pool.valueCents;
  }
  return { asOf: q.asOf ?? null, items, totals };
}
