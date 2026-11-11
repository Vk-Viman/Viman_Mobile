import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import {
  getDrawing as getDrawingRow, getDrawingByClientRef, insertDrawing, listDrawings as listDrawingRows, markDrawingVoid,
} from '../repositories/drawings.repo.ts';
import type { DrawingBook, DrawingKind, DrawingRow, DrawingStatus } from '../repositories/drawings.repo.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import { logAudit } from './audit.service.ts';
import { issueStock, outflowValue, reverseMovements } from './inventory.service.ts';
import { checkBusinessDate, isBackdated, notFound, runWrite, trimmed, validationError } from './stock-common.ts';
import type { Fields } from './stock-common.ts';

export interface Drawing {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: DrawingBook; kind: DrawingKind;
  amountCents: number; productId: number | null; productName: string | null; qty: number | null; note: string;
  status: DrawingStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

function toDrawing(r: DrawingRow): Drawing {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    book: r.book, kind: r.kind, amountCents: r.amountCents, productId: r.productId, productName: r.productName,
    qty: r.qty, note: r.note, status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadDrawing(conn: DatabaseSync, id: number): Drawing {
  const r = getDrawingRow(conn, id);
  if (!r) throw notFound('Drawing');
  return toDrawing(r);
}

export function getDrawing(ctx: AppContext, id: number): Drawing {
  return loadDrawing(ctx.database.conn, id);
}

export function listDrawings(ctx: AppContext, q: {
  kind?: DrawingKind; from?: string; to?: string; book?: DrawingBook; productId?: number; status?: DrawingStatus;
  limit: number; offset: number;
}): { items: Drawing[]; total: number; totalAmountCents: number } {
  const { items, total, totalAmountCents } = listDrawingRows(ctx.database.conn, q);
  return { items: items.map(toDrawing), total, totalAmountCents };
}

export interface DrawingCreate {
  kind: DrawingKind; businessDate: string; productId?: number; qty?: number; note?: string; clientRef: string;
}

export function createDrawing(ctx: AppContext, body: DrawingCreate): { item: Drawing; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, 500);
  if (Object.keys(fields).length > 0) throw validationError(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  if (body.kind !== 'goods') {
    throw new AppError(400, 'NOT_AVAILABLE_YET',
      'Cash drawings are not available yet. They arrive with the cash books.', { kind: 'Only goods drawings are available.' });
  }
  const missing: Fields = {};
  if (body.productId === undefined) missing.productId = 'Product is required.';
  if (body.qty === undefined) missing.qty = 'Quantity is required.';
  if (Object.keys(missing).length > 0) throw validationError(missing);
  const productId = body.productId as number;
  const qty = body.qty as number;

  return runWrite(ctx, (conn) => {
    const existing = getDrawingByClientRef(conn, body.clientRef);
    if (existing) return { item: toDrawing(existing), created: false };

    const product = getProduct(conn, productId);
    if (!product) throw validationError({ productId: 'Product not found.' });
    if (product.kind !== 'stock') {
      throw new AppError(400, 'PRODUCT_NOT_STOCKABLE', 'Only stock products can be taken for personal use.',
        { productId: 'Only stock products can be taken for personal use.' });
    }

    // amount = the stock cost removed (never the selling price); no revenue, COGS, expense or cash entry.
    const amountCents = outflowValue(conn, product.id, qty);
    const id = insertDrawing(conn, {
      businessDate: body.businessDate, book: product.book, kind: 'goods', amountCents, productId: product.id, qty,
      note, clientRef: body.clientRef,
    });
    const out = issueStock(conn, {
      productId: product.id, businessDate: body.businessDate, type: 'personal_use', qty,
      refTable: 'owner_drawings', refId: id, reason: `Personal use #${id}`,
    });
    if (out.valueRemovedCents !== amountCents) throw new Error(`Drawing #${id}: amount ${amountCents} differs from value removed ${out.valueRemovedCents}`);

    const item = loadDrawing(conn, id);
    logAudit(conn, 'drawing', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

export function voidDrawing(ctx: AppContext, id: number, body: { reason: string }): Drawing {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, 200);
  if (Object.keys(fields).length > 0) throw validationError(fields);

  return runWrite(ctx, (conn) => {
    const row = getDrawingRow(conn, id);
    if (!row) throw notFound('Drawing');
    if (row.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'This drawing is already void.');
    const before = toDrawing(row);

    const movements = listMovementsByRef(conn, 'owner_drawings', id);
    if (movements.length !== 1) throw new Error(`Drawing #${id} has ${movements.length} movements, expected 1`);
    reverseMovements(conn, movements.map((m) => m.id), `Void of personal use #${id}`);

    markDrawingVoid(conn, id, reason);
    const after = loadDrawing(conn, id);
    logAudit(conn, 'drawing', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: after.businessDate < todayBusinessDate() });
    return after;
  });
}
