/**
 * services/drawings.service.ts - owner drawings: the owner taking goods (or, later, cash) for personal use.
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES section 9):
 *  - A GOODS drawing removes stock at the weighted-average cost (movement type `personal_use`). The drawing is
 *    recorded at that COST, never at the selling price, and creates no revenue, no COGS, no expense and no
 *    cash entry: it is "below the line" (not part of P&L).
 *  - Cash drawings (cash out of a chosen book) arrive with the cash books in a later phase; until then
 *    `kind = 'cash'` is answered with 400 NOT_AVAILABLE_YET.
 *  - R-FD: no future dates. Section 12: idempotent by `clientRef`; every write is audited.
 *  - R1 / C6: a void writes the exact negation of the stock movement (stock returns at its original value)
 *    and marks the drawing `void`; nothing is edited or deleted.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import {
  getDrawing as getDrawingRow, getDrawingByClientRef, insertDrawing, listDrawings as listDrawingRows, markDrawingVoid,
} from '../repositories/drawings.repo.ts';
import type { DrawingBook, DrawingKind, DrawingRow, DrawingStatus } from '../repositories/drawings.repo.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import { logAudit } from './audit.service.ts';
import { issueStock, outflowValue, reverseMovements } from './inventory.service.ts';
import { assertDayOpen } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** A drawing as returned by the API (adds the `backdated` flag). */
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

/** One drawing by id. @throws AppError 404 NOT_FOUND. */
export function getDrawing(ctx: AppContext, id: number): Drawing {
  return loadDrawing(ctx.database.conn, id);
}

/** Lists drawings newest first; `totalAmountCents` sums only POSTED drawings that match the filters. */
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

/**
 * Records a goods drawing: stock out at average cost, no cash and no P&L (section 9).
 * Idempotent by `clientRef`: a repeat returns the saved drawing with `created: false`.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED / NOT_AVAILABLE_YET (cash kind) /
 *   PRODUCT_NOT_STOCKABLE (a service cannot be taken), 422 INSUFFICIENT_STOCK (more than on hand).
 */
export function createDrawing(ctx: AppContext, body: DrawingCreate): { item: Drawing; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  if (body.kind !== 'goods') {
    throw new AppError(400, 'NOT_AVAILABLE_YET',
      'Cash drawings are not available yet. They arrive with the cash books.', { kind: 'Only goods drawings are available.' });
  }
  const missing: Fields = {};
  if (body.productId === undefined) missing.productId = 'Product is required.';
  if (body.qty === undefined) missing.qty = 'Quantity is required.';
  assertNoFieldErrors(missing);
  const productId = body.productId as number;
  const qty = body.qty as number;

  return runWrite(ctx, (conn) => {
    const existing = getDrawingByClientRef(conn, body.clientRef);
    if (existing) return { item: toDrawing(existing), created: false };

    const product = getProduct(conn, productId);
    if (!product) throw validationError({ productId: 'Product not found.' });
    assertDayOpen(conn, [product.book], body.businessDate); // R9: the product's book
    if (product.kind !== 'stock') {
      throw new AppError(400, 'PRODUCT_NOT_STOCKABLE', 'Only stock products can be taken for personal use.',
        { productId: 'Only stock products can be taken for personal use.' });
    }

    // amount = the stock cost removed (never the selling price); no revenue, COGS, expense or cash entry.
    // The drawing row is written first because the stock movement refers to its id, so its amount is worked
    // out beforehand with the same formula the movement will use (`outflowValue` = what `issueStock` removes).
    const amountCents = outflowValue(conn, product.id, qty);
    const id = insertDrawing(conn, {
      businessDate: body.businessDate, book: product.book, kind: 'goods', amountCents, productId: product.id, qty,
      note, clientRef: body.clientRef,
    });
    const out = issueStock(conn, {
      productId: product.id, businessDate: body.businessDate, type: 'personal_use', qty,
      refTable: 'owner_drawings', refId: id, reason: `Personal use #${id}`,
    });
    // Internal consistency guard: the recorded amount must equal the value the movement removed.
    if (out.valueRemovedCents !== amountCents) throw new Error(`Drawing #${id}: amount ${amountCents} differs from value removed ${out.valueRemovedCents}`);

    const item = loadDrawing(conn, id);
    logAudit(conn, 'drawing', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

/**
 * Voids a drawing (R1, C6): the stock movement is negated (units return at their original value) and the
 * drawing is marked `void`. The reversal keeps the drawing's business date (section 12).
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID,
 *   422 INSUFFICIENT_STOCK (cannot occur for a goods drawing in practice; returned stock only adds).
 */
export function voidDrawing(ctx: AppContext, id: number, body: { reason: string }): Drawing {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getDrawingRow(conn, id);
    if (!row) throw notFound('Drawing');
    assertDayOpen(conn, [row.book], row.businessDate); // R9: a void is judged on the drawing's own date
    if (row.status === 'void') throw alreadyVoid('drawing');
    const before = toDrawing(row);

    const movements = listMovementsByRef(conn, 'owner_drawings', id);
    if (movements.length !== 1) throw new Error(`Drawing #${id} has ${movements.length} movements, expected 1`);
    reverseMovements(conn, movements.map((m) => m.id), `Void of personal use #${id}`);

    markDrawingVoid(conn, id, reason);
    const after = loadDrawing(conn, id);
    logAudit(conn, 'drawing', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
