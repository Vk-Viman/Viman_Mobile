/**
 * services/stock-losses.service.ts - stock losses (damaged / lost / expired / other).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules:
 *  - R2/R3, section 11: a loss removes stock at the weighted-average cost (movement type `loss`) and appears in
 *    the "Stock adjustments (net)" line of the product's book. There is no cash entry (nothing was paid).
 *  - The cost is frozen on the loss record when it is saved, so later purchases never change it (section 3).
 *  - Outflows larger than the quantity on hand are blocked (422 INSUFFICIENT_STOCK).
 *  - R-FD: no future dates. Section 12: idempotent by `clientRef`; every write is audited.
 *  - R1 / C6: a void writes the exact negation of the movement and marks the loss `void`; nothing is deleted.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import {
  getStockLoss as getStockLossRow, getStockLossByClientRef, insertStockLoss, listStockLosses as listStockLossRows,
  markStockLossVoid,
} from '../repositories/stock-losses.repo.ts';
import type { LossBook, LossReason, LossSource, LossStatus, StockLossRow } from '../repositories/stock-losses.repo.ts';
import { logAudit } from './audit.service.ts';
import { issueStock, outflowValue, reverseMovements } from './inventory.service.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** A stock loss as returned by the API (adds `backdated` and the rounded `unitCostCents`). */
export interface StockLoss {
  id: number; businessDate: string; postedAt: string; backdated: boolean; productId: number; productName: string;
  book: LossBook; qty: number; costCents: number; unitCostCents: number; reason: LossReason; note: string;
  source: LossSource; status: LossStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

function toLoss(r: StockLossRow): StockLoss {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    productId: r.productId, productName: r.productName, book: r.book, qty: r.qty, costCents: r.costCents,
    unitCostCents: mulDivRound(r.costCents, 1, r.qty), reason: r.reason, note: r.note, source: r.source,
    status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadLoss(conn: DatabaseSync, id: number): StockLoss {
  const r = getStockLossRow(conn, id);
  if (!r) throw notFound('Stock loss');
  return toLoss(r);
}

/** One stock loss by id. @throws AppError 404 NOT_FOUND. */
export function getStockLoss(ctx: AppContext, id: number): StockLoss {
  return loadLoss(ctx.database.conn, id);
}

/** Lists losses newest first; `totalCostCents` sums only POSTED losses that match the filters. */
export function listStockLosses(ctx: AppContext, q: {
  from?: string; to?: string; productId?: number; book?: LossBook; reason?: LossReason; status?: LossStatus;
  limit: number; offset: number;
}): { items: StockLoss[]; total: number; totalCostCents: number } {
  const { items, total, totalCostCents } = listStockLossRows(ctx.database.conn, q);
  return { items: items.map(toLoss), total, totalCostCents };
}

export interface StockLossCreate {
  businessDate: string; productId: number; qty: number; reason: LossReason; note?: string; clientRef: string;
}

/**
 * Records a stock loss and removes the units from stock at average cost.
 * Idempotent by `clientRef`: a repeat returns the saved loss with `created: false`.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED / PRODUCT_NOT_STOCKABLE (services hold no
 *   stock), 422 INSUFFICIENT_STOCK (more than on hand).
 */
export function createStockLoss(ctx: AppContext, body: StockLossCreate): { item: StockLoss; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  return runWrite(ctx, (conn) => {
    const existing = getStockLossByClientRef(conn, body.clientRef);
    if (existing) return { item: toLoss(existing), created: false };

    const product = getProduct(conn, body.productId);
    if (!product) throw validationError({ productId: 'Product not found.' });
    if (product.kind !== 'stock') {
      throw new AppError(400, 'PRODUCT_NOT_STOCKABLE', 'Only stock products can be written off.',
        { productId: 'Only stock products can be written off.' });
    }

    // The cost is the value the weighted-average outflow will remove; the record is written first (the
    // movement refers to it) and the movement must remove exactly that value.
    const costCents = outflowValue(conn, product.id, body.qty);
    const id = insertStockLoss(conn, {
      businessDate: body.businessDate, productId: product.id, book: product.book, qty: body.qty, costCents,
      reason: body.reason, note, clientRef: body.clientRef,
    });
    const out = issueStock(conn, {
      productId: product.id, businessDate: body.businessDate, type: 'loss', qty: body.qty,
      refTable: 'stock_losses', refId: id, reason: `Stock loss #${id} (${body.reason})`,
    });
    // Internal consistency guard: the frozen cost must equal what the movement removed.
    if (out.valueRemovedCents !== costCents) throw new Error(`Stock loss #${id}: cost ${costCents} differs from value removed ${out.valueRemovedCents}`);

    const item = loadLoss(conn, id);
    logAudit(conn, 'stock_loss', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

/**
 * Voids a stock loss (R1, C6): negates the stock movement (units return at the original cost) and marks the
 * loss `void`. The reversal keeps the loss's business date so it lands in the same report period.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID.
 */
export function voidStockLoss(ctx: AppContext, id: number, body: { reason: string }): StockLoss {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getStockLossRow(conn, id);
    if (!row) throw notFound('Stock loss');
    if (row.status === 'void') throw alreadyVoid('stock loss');
    const before = toLoss(row);

    const movements = listMovementsByRef(conn, 'stock_losses', id);
    if (movements.length !== 1) throw new Error(`Stock loss #${id} has ${movements.length} movements, expected 1`);
    reverseMovements(conn, movements.map((m) => m.id), `Void of stock loss #${id}`);

    markStockLossVoid(conn, id, reason);
    const after = loadLoss(conn, id);
    logAudit(conn, 'stock_loss', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
