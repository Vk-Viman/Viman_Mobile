/**
 * services/drawings.service.ts - owner drawings: the owner taking goods or cash for personal use.
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES section 9):
 *  - A GOODS drawing removes stock at the weighted-average cost (movement type `personal_use`). The drawing is
 *    recorded at that COST, never at the selling price, and creates no revenue, no COGS, no expense and no
 *    cash entry: it is "below the line" (not part of P&L).
 *  - A CASH drawing (Phase 9) is money out of a chosen book (cash type `drawing_cash`, -amount). It is the owner's
 *    withdrawal: never an expense, never part of P&L (sec 9). Ice Cream names the fund the money leaves (10.2) and its
 *    fund row is written in the same transaction (10.7); the other books refuse a fund. A cash-out that leaves the
 *    book or fund below zero returns the shared warning, never a block (R13). R9: a closed day of the book refuses it.
 *  - R-FD: no future dates. Section 12: idempotent by `clientRef`; every write is audited.
 *  - R1 / C6: a void writes the exact negation of the stock movement (stock returns at its original value) - or, for a
 *    cash drawing, a reversing cash entry (and fund row) - and marks the drawing `void`; nothing is edited or deleted.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { findCashEntriesByRef } from '../repositories/cash-entries.repo.ts';
import {
  getDrawing as getDrawingRow, getDrawingByClientRef, insertDrawing, listDrawings as listDrawingRows, markDrawingVoid,
} from '../repositories/drawings.repo.ts';
import type { DrawingBook, DrawingFund, DrawingKind, DrawingRow, DrawingStatus } from '../repositories/drawings.repo.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import { logAudit } from './audit.service.ts';
import { postCash, reverseCash } from './cash-posting.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { issueStock, outflowValue, reverseMovements } from './inventory.service.ts';
import { assertDayOpen } from './day-closing.ts';
import { assertFundMatchesBook } from './fund-rules.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** A drawing as returned by the API (adds the `backdated` flag). */
export interface Drawing {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: DrawingBook; fund: DrawingFund | null;
  kind: DrawingKind; amountCents: number; productId: number | null; productName: string | null; qty: number | null; note: string;
  status: DrawingStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

function toDrawing(r: DrawingRow): Drawing {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    book: r.book, fund: r.fund, kind: r.kind, amountCents: r.amountCents, productId: r.productId, productName: r.productName,
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

/**
 * Lists drawings (both kinds) newest first. `totalAmountCents` sums only POSTED drawings that match the filters;
 * `totals` splits that sum into the stock cost of goods drawings and the money of cash drawings.
 */
export function listDrawings(ctx: AppContext, q: {
  kind?: DrawingKind; from?: string; to?: string; book?: DrawingBook; productId?: number; status?: DrawingStatus;
  limit: number; offset: number;
}): { items: Drawing[]; total: number; totalAmountCents: number; totals: { amountCents: number; goodsCents: number; cashCents: number } } {
  const r = listDrawingRows(ctx.database.conn, q);
  return {
    items: r.items.map(toDrawing), total: r.total, totalAmountCents: r.totalAmountCents,
    totals: { amountCents: r.totalAmountCents, goodsCents: r.goodsCents, cashCents: r.cashCents },
  };
}

/**
 * Request body of a drawing. Goods: `productId` + `qty` (the book comes from the product). Cash: `book`, `amountCents` and,
 * for Ice Cream only, `fund`.
 */
export interface DrawingCreate {
  kind: DrawingKind; businessDate: string; productId?: number; qty?: number; book?: DrawingBook; fund?: DrawingFund;
  amountCents?: number; note?: string; clientRef: string;
}


/**
 * Records a drawing. Goods: stock out at average cost, no cash and no P&L (section 9). Cash: money out of a book (see the
 * file header). Idempotent by `clientRef`: a repeat returns the saved drawing with `created: false` and no warnings.
 *
 * Validation order: fields (note, kind-specific fields) -> fund rule -> R-FD -> clientRef repeat -> DAY_CLOSED (R9) -> rules.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUND_REQUIRED / FUND_NOT_ALLOWED / FUTURE_DATE_NOT_ALLOWED /
 *   PRODUCT_NOT_STOCKABLE (a service cannot be taken), 409 DAY_CLOSED, 422 INSUFFICIENT_STOCK (more than on hand).
 */
export function createDrawing(ctx: AppContext, body: DrawingCreate): { item: Drawing; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  return body.kind === 'cash' ? createCashDrawing(ctx, body, note) : createGoodsDrawing(ctx, body, note);
}

/** Goods drawing: see `createDrawing`. The book is the product's book, so `book`, `fund` and `amountCents` are refused. */
function createGoodsDrawing(ctx: AppContext, body: DrawingCreate, note: string): { item: Drawing; warnings: CashWarning[]; created: boolean } {
  const bad: Fields = {};
  if (body.book !== undefined) bad.book = 'A goods drawing takes its book from the product.';
  if (body.fund !== undefined) bad.fund = 'A goods drawing has no fund.';
  if (body.amountCents !== undefined) bad.amountCents = 'A goods drawing is recorded at the stock cost, not at an amount you enter.';
  assertNoFieldErrors(bad);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const missing: Fields = {};
  if (body.productId === undefined) missing.productId = 'Product is required.';
  if (body.qty === undefined) missing.qty = 'Quantity is required.';
  assertNoFieldErrors(missing);
  const productId = body.productId as number;
  const qty = body.qty as number;

  return runWrite(ctx, (conn) => {
    const existing = getDrawingByClientRef(conn, body.clientRef);
    if (existing) return { item: toDrawing(existing), warnings: [], created: false };

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
    return { item, warnings: [], created: true };
  });
}

/**
 * Cash drawing: `drawing_cash` -amount in the chosen book (+ the fund row for Ice Cream), audited, in one transaction.
 * Warnings (R13): the book - and its funds - when now below zero; the drawing is saved anyway.
 */
function createCashDrawing(ctx: AppContext, body: DrawingCreate, note: string): { item: Drawing; warnings: CashWarning[]; created: boolean } {
  const bad: Fields = {};
  if (body.book === undefined) bad.book = 'Book is required.';
  if (body.amountCents === undefined) bad.amountCents = 'Amount is required.';
  if (body.productId !== undefined) bad.productId = 'A cash drawing has no product.';
  if (body.qty !== undefined) bad.qty = 'A cash drawing has no quantity.';
  assertNoFieldErrors(bad);
  const book = body.book as DrawingBook;
  const amountCents = body.amountCents as number;
  assertFundMatchesBook(book, body.fund);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const fund = book === 'icecream' ? (body.fund as DrawingFund) : null;

  return runWrite(ctx, (conn) => {
    const existing = getDrawingByClientRef(conn, body.clientRef);
    if (existing) {
      if (existing.kind !== 'cash' || existing.book !== book) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different record.');
      }
      return { item: toDrawing(existing), warnings: [], created: false };
    }

    assertDayOpen(conn, [book], body.businessDate); // R9
    const id = insertDrawing(conn, {
      businessDate: body.businessDate, book, fund, kind: 'cash', amountCents, note, clientRef: body.clientRef,
    });
    postCash(conn, {
      book, fund, businessDate: body.businessDate, type: 'drawing_cash', amountCents: -amountCents,
      refTable: 'owner_drawings', refId: id, fundKind: 'drawing', note: note || null,
    });
    const item = loadDrawing(conn, id);
    logAudit(conn, 'drawing', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, warnings: negativeCashWarnings(conn, [book]), created: true }; // R13: warn, never block
  });
}

/**
 * Voids a drawing (R1, C6). Goods: the stock movement is negated (units return at their original value). Cash: the
 * cash-out (and, for Ice Cream, its fund row) is cancelled by a reversing entry. Either way the drawing is marked `void`
 * and the reversal keeps the drawing's business date (section 12).
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID,
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

    if (row.kind === 'cash') {
      const original = findCashEntriesByRef(conn, 'owner_drawings', id).find((e) => e.reversesEntryId === null);
      if (!original) throw new Error(`Cash drawing #${id} has no cash entry to reverse`);
      reverseCash(conn, original, `Void of cash drawing #${id}`);
    } else {
      const movements = listMovementsByRef(conn, 'owner_drawings', id);
      if (movements.length !== 1) throw new Error(`Drawing #${id} has ${movements.length} movements, expected 1`);
      reverseMovements(conn, movements.map((m) => m.id), `Void of personal use #${id}`);
    }

    markDrawingVoid(conn, id, reason);
    const after = loadDrawing(conn, id);
    logAudit(conn, 'drawing', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
