import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate } from '../lib/dates.ts';
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
import { checkBusinessDate, isBackdated, notFound, runWrite, trimmed, validationError } from './stock-common.ts';
import type { Fields } from './stock-common.ts';

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

export function getStockLoss(ctx: AppContext, id: number): StockLoss {
  return loadLoss(ctx.database.conn, id);
}

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

export function createStockLoss(ctx: AppContext, body: StockLossCreate): { item: StockLoss; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, 500);
  if (Object.keys(fields).length > 0) throw validationError(fields);
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
    if (out.valueRemovedCents !== costCents) throw new Error(`Stock loss #${id}: cost ${costCents} differs from value removed ${out.valueRemovedCents}`);

    const item = loadLoss(conn, id);
    logAudit(conn, 'stock_loss', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

export function voidStockLoss(ctx: AppContext, id: number, body: { reason: string }): StockLoss {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, 200);
  if (Object.keys(fields).length > 0) throw validationError(fields);

  return runWrite(ctx, (conn) => {
    const row = getStockLossRow(conn, id);
    if (!row) throw notFound('Stock loss');
    if (row.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'This stock loss is already void.');
    const before = toLoss(row);

    const movements = listMovementsByRef(conn, 'stock_losses', id);
    if (movements.length !== 1) throw new Error(`Stock loss #${id} has ${movements.length} movements, expected 1`);
    reverseMovements(conn, movements.map((m) => m.id), `Void of stock loss #${id}`);

    markStockLossVoid(conn, id, reason);
    const after = loadLoss(conn, id);
    logAudit(conn, 'stock_loss', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: after.businessDate < todayBusinessDate() });
    return after;
  });
}
