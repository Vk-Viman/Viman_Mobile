import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { getProduct, listProducts } from '../repositories/products.repo.ts';
import { insertMovement, listMovements, sumMovements } from '../repositories/stock-movements.repo.ts';
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
