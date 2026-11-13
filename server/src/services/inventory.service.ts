/**
 * services/inventory.service.ts - the stock engine: quantity + value per product, weighted-average costing.
 *
 * Layer: service (route -> SERVICE -> repository -> database). This is where the "pool" rules of
 * BUSINESS_RULES section 3 live:
 *  - A product's pool is (quantity on hand, stock value). Average cost = value / quantity (display only).
 *  - INFLOWS (`receiveStock`) add quantity and the exact value: purchases, opening stock, stocktake gains.
 *  - OUTFLOWS (`issueStock`) remove `mulDivRound(value, q, qty)`; when q = qty the WHOLE remaining value goes,
 *    so no stray cents are ever left behind (sale, personal use, loss, stocktake loss).
 *  - R4 (`issueStockCapped`): a purchase return/void removes min(purchase cost, pool value) and, if the
 *    quantity reaches 0 with value left, sweeps that residue into the "Stock adjustments" line.
 *  - C6 (`reverseMovements`): a void writes the exact negation of the original movements.
 *  - Every change writes exactly ONE `stock_movements` row; the database trigger then updates the products
 *    cache, so "sum of movements = cache" always holds (`reconcileStock` double-checks it).
 *  - Outflows larger than the quantity on hand are blocked (422 INSUFFICIENT_STOCK).
 * All functions that take `conn` must be called inside the caller's transaction (`AppDatabase.tx`).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { getProduct, listProducts } from '../repositories/products.repo.ts';
import {
  getMovement, insertMovement, listMovements, sumMovements, sumMovementsAsOf,
} from '../repositories/stock-movements.repo.ts';
import type { MovementRow, MovementType as RepoMovementType } from '../repositories/stock-movements.repo.ts';
import { getProductItem } from './catalog.service.ts';
import type { Product } from './catalog.service.ts';

/** Why stock changed (section 3). Same list as the database CHECK on `stock_movements.type`. */
export type MovementType = RepoMovementType;

/** Every movement type, for validating the `type` query parameter. */
export const MOVEMENT_TYPES: readonly MovementType[] = [
  'opening', 'purchase', 'purchase_return', 'purchase_void', 'sale', 'sale_return', 'sale_void',
  'personal_use', 'loss', 'stocktake_gain', 'stocktake_loss', 'adjustment',
];

/** A product's pool: units on hand and the total value of those units, in cents. */
export interface PoolState { qty: number; valueCents: number }

export type StockMovement = MovementRow;

/** Guards the arithmetic: `n` must be a safe integer of at least `min` (else a RangeError, mapped to 400 upstream). */
function assertInt(n: number, name: string, min: number): void {
  if (!Number.isSafeInteger(n) || n < min) {
    throw new RangeError(`${name} must be a safe integer >= ${min}`);
  }
}

/**
 * Current pool (quantity and value) of a product, from the DB-maintained cache.
 * @throws AppError 404 NOT_FOUND for an unknown product.
 */
export function getPool(conn: DatabaseSync, productId: number): PoolState {
  const p = getProduct(conn, productId);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found.');
  return { qty: p.qtyOnHand, valueCents: p.stockValueCents };
}

/** 422 INSUFFICIENT_STOCK carrying `onHand` and `productId` so the screen can say "Only 3 in stock". */
function insufficient(productId: number, onHand: number, needed: number): AppError {
  return new AppError(422, 'INSUFFICIENT_STOCK',
    `Not enough stock: ${onHand} on hand, ${needed} needed.`, undefined, { onHand, productId });
}

/**
 * Inflow: adds the quantity and the exact value to the pool (BUSINESS_RULES section 3).
 * Pack size is already multiplied out by the caller (units = packs x pack size) and `valueCents` is the exact
 * line total, so no per-unit rounding loss enters the books; the unit cost returned is only informational.
 *
 * @param p.type     'purchase', 'opening', 'stocktake_gain', 'sale_return' ...
 * @param p.qty      Units added (>= 1).
 * @param p.valueCents Total value added (>= 0).
 * @returns The movement id and the rounded unit cost.
 * @throws RangeError when qty/value are invalid or the pool would exceed safe-integer range.
 */
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

/**
 * Outflow at the weighted average: removes `mulDivRound(value, qty, poolQty)`. Removing the whole pool removes
 * its whole value (no residue). Used for sales, personal use, losses and stocktake losses.
 *
 * @throws AppError 422 INSUFFICIENT_STOCK when qty exceeds the quantity on hand (section 3: outflows are blocked).
 * @returns The movement id, the value removed (the COGS-style cost) and the rounded unit cost.
 */
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
 *
 * Why min(): the pool may already be worth less than the purchase cost (a later cheaper purchase lowered the
 * average, or some units were sold), and the books must never remove more value than the pool holds.
 * Why sweep first: the database refuses a state with quantity 0 but value > 0 (`STOCK_VALUE_WITHOUT_QTY`),
 * so the residue is cleared while the quantity is still above 0.
 *
 * @param p.maxValueCents The purchase cost of these units (the cap).
 * @throws AppError 422 INSUFFICIENT_STOCK when qty exceeds the quantity on hand.
 * @returns The removal movement id, the value removed, and the sweep movement id / amount (null / 0 if none).
 */
export function issueStockCapped(conn: DatabaseSync, p: {
  productId: number; businessDate: string; type: 'purchase_return' | 'purchase_void'; qty: number;
  maxValueCents: number; refTable: string | null; refId: number | null; reason: string;
  /** Void path: the original (purchase) movement this removal cancels (migration 020 link); omitted for returns. */
  reversesMovementId?: number | null;
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
    refTable: p.refTable, refId: p.refId, reason: p.reason, reversesMovementId: p.reversesMovementId ?? null,
  });
  return { movementId, valueRemovedCents, sweepMovementId, sweptCents };
}

/**
 * Compares the products cache with the sums of the movements; must always be ok.
 * A mismatch would mean stock was changed without a movement (a bug or manual database edit).
 */
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
    // A product with no movements at all must have an empty pool.
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

/** API wrapper for `GET /inventory/reconciliation` (see `reconcileStock`). */
export function reconciliation(ctx: AppContext) {
  return reconcileStock(ctx.database.conn);
}

/**
 * Movement history of one product, newest first, plus the product itself.
 *
 * @throws AppError 404 NOT_FOUND for an unknown product.
 */
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
 *
 * @throws AppError 422 UNIT_COST_REQUIRED when there is no average to use and no unit cost was supplied.
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

/** Loads movements by id (in the given order); a missing id is a programming error, not a user error. */
function loadMovementsById(conn: DatabaseSync, ids: number[]): MovementRow[] {
  return ids.map((id) => {
    const m = getMovement(conn, id);
    if (!m) throw new Error(`Stock movement #${id} not found`);
    return m;
  });
}

/**
 * Reversal (C6): inserts the exact negation of each given movement (same type, business date, ref and unit cost),
 * returning the new ids. Rows are processed newest-first so every intermediate state is valid, and each
 * negation is checked against the live pool first: 422 INSUFFICIENT_STOCK when it would drive the quantity or
 * the value below 0 (or leave value in an empty pool). Run inside the caller's transaction.
 *
 * Why the check: undoing a purchase or stocktake gain removes stock; if those units were already sold, the
 * negation cannot be applied and the user must be told, not given a database error.
 */
export function reverseMovements(conn: DatabaseSync, movementIds: number[], reason: string): number[] {
  const originals = loadMovementsById(conn, movementIds).sort((a, b) => b.id - a.id);
  const created: number[] = [];
  for (const m of originals) {
    // `=== 0 ? 0` avoids -0 when negating a zero delta.
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
      unitCostCents: m.unitCostCents, refTable: m.refTable, refId: m.refId, reason, reversesMovementId: m.id,
    }));
  }
  return created;
}

/** One row of the stock valuation report. */
export interface ValuationItem {
  productId: number; code: string | null; name: string; categoryId: number; categoryName: string;
  book: 'shop' | 'telecom'; active: boolean; qty: number; valueCents: number; avgUnitCostCents: number | null;
}
/** Stock valuation: items plus totals overall and per book. Totals are of the shown items. */
export interface Valuation {
  asOf: string | null;
  items: ValuationItem[];
  totals: {
    qty: number; valueCents: number;
    byBook: { shop: { qty: number; valueCents: number }; telecom: { qty: number; valueCents: number } };
  };
}

/**
 * Stock on hand and value per stock product: live cache, or the sum of movements dated <= asOf when `asOf`
 * is earlier than today. (Reports follow the BUSINESS date, R7; an `asOf` of today or later shows live figures
 * because nothing can be dated later than today, R-FD.)
 *
 * @param q.includeZero     Also list products with nothing in stock (default off).
 * @param q.includeInactive Also list inactive products (default on).
 */
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
    if (p.kind !== 'stock') continue; // services hold no stock
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
