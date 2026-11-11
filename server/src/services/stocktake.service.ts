/**
 * services/stocktake.service.ts - physical stock counts (stocktakes).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Life cycle of a stocktake:
 *   draft  -> (counted quantities can be edited freely, nothing is posted yet)
 *   completed -> the differences between counted and expected quantity are posted as stock movements
 *   void   -> a completed stocktake can be undone by reversing those movements (R1, C6)
 *
 * Business rules (BUSINESS_RULES sections 3 and 11):
 *  - Shortage (counted < on hand): stock is removed at the weighted average (`stocktake_loss`); it counts in
 *    the "Stock adjustments (net)" line of the book as a loss.
 *  - Surplus (counted > on hand): stock is added (`stocktake_gain`) at the CURRENT average
 *    (`mulDivRound(value, gain, qty)`); if the pool has no quantity or no value (C10) the owner must enter a
 *    unit cost for the extra units (422 UNIT_COST_REQUIRED).
 *  - Only stock products of the stocktake's book can be counted (segments are disjoint).
 *  - R-FD: no future dates. Section 12: idempotent by `clientRef`; every write is audited.
 *  - Expected quantity is read at completion time (the live pool), so sales made while counting are respected.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import {
  completeStocktakeItem, getStocktake as getStocktakeRow, getStocktakeByClientRef, insertStocktake,
  listStocktakeItems, listStocktakes as listStocktakeRows, markStocktakeCompleted, markStocktakeVoid,
  replaceStocktakeItems, updateStocktakeNotes,
} from '../repositories/stocktakes.repo.ts';
import type {
  StocktakeBook, StocktakeItemRow, StocktakeRow, StocktakeStatus,
} from '../repositories/stocktakes.repo.ts';
import { logAudit } from './audit.service.ts';
import { gainValue, getPool, issueStock, receiveStock, reverseMovements } from './inventory.service.ts';
import { assertDayOpen } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** One counted product as returned by the API. For a draft, `expectedQty`/`differenceQty` are shown live. */
export interface StocktakeItem {
  id: number; productId: number; productName: string; productCode: string | null; countedQty: number;
  expectedQty: number | null; differenceQty: number | null; valueDeltaCents: number | null;
  gainUnitCostCents: number | null;
}
export interface Stocktake {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: StocktakeBook;
  status: StocktakeStatus; notes: string; completedAt: string | null; voidedAt: string | null;
  voidReason: string | null; clientRef: string; items: StocktakeItem[];
}

/** One counted line sent by the client; `gainUnitCostCents` is only needed for a surplus with no average (C10). */
export interface StocktakeItemInput { productId: number; countedQty: number; gainUnitCostCents?: number }

// ---------- DTO assembly ----------

/** Builds the API shape of a stocktake. A draft shows live expected quantities; completed ones show stored values. */
function toStocktake(conn: DatabaseSync, h: StocktakeRow): Stocktake {
  const items = listStocktakeItems(conn, h.id).map((i): StocktakeItem => {
    let expectedQty = i.expectedQty;
    let differenceQty = i.differenceQty;
    if (h.status === 'draft') {
      // A draft shows the live quantity; nothing is stored until completion.
      expectedQty = getProduct(conn, i.productId)?.qtyOnHand ?? 0;
      differenceQty = i.countedQty - expectedQty;
    }
    return {
      id: i.id, productId: i.productId, productName: i.productName, productCode: i.productCode,
      countedQty: i.countedQty, expectedQty, differenceQty, valueDeltaCents: i.valueDeltaCents,
      gainUnitCostCents: i.gainUnitCostCents,
    };
  });
  return {
    id: h.id, businessDate: h.businessDate, postedAt: h.postedAt, backdated: isBackdated(h.businessDate, h.postedAt),
    book: h.book, status: h.status, notes: h.notes, completedAt: h.completedAt, voidedAt: h.voidedAt,
    voidReason: h.voidReason, clientRef: h.clientRef, items,
  };
}

function loadStocktake(conn: DatabaseSync, id: number): Stocktake {
  const h = getStocktakeRow(conn, id);
  if (!h) throw notFound('Stocktake');
  return toStocktake(conn, h);
}

// ---------- reads ----------

/** One stocktake with its lines. @throws AppError 404 NOT_FOUND. */
export function getStocktake(ctx: AppContext, id: number): Stocktake {
  return loadStocktake(ctx.database.conn, id);
}

/** Lists stocktakes newest first. */
export function listStocktakes(ctx: AppContext, q: {
  from?: string; to?: string; book?: StocktakeBook; status?: StocktakeStatus; limit: number; offset: number;
}): { items: Stocktake[]; total: number } {
  const conn = ctx.database.conn;
  const { items, total } = listStocktakeRows(conn, q);
  return { items: items.map((h) => toStocktake(conn, h)), total };
}

// ---------- items validation ----------

/**
 * Checks the counted lines: every product must exist, appear once, be a STOCK product, and belong to the
 * stocktake's book (segments are disjoint). The database triggers repeat the book/kind check as a backstop.
 *
 * @throws AppError 400 VALIDATION_ERROR (unknown/duplicate product) or PRODUCT_NOT_IN_BOOK.
 */
function checkItems(conn: DatabaseSync, book: StocktakeBook, items: StocktakeItemInput[]): void {
  const bad: Fields = {};
  const wrongBook: Fields = {};
  const seen = new Set<number>();
  items.forEach((it, i) => {
    const key = `items.${i}.productId`;
    const p = getProduct(conn, it.productId);
    if (!p) bad[key] = 'Product not found.';
    else if (seen.has(p.id)) bad[key] = 'Each product can appear only once.';
    else {
      seen.add(p.id);
      if (p.kind !== 'stock') wrongBook[key] = 'Only stock products can be counted.';
      else if (p.book !== book) wrongBook[key] = `This product belongs to the ${p.book} book, not ${book}.`;
    }
  });
  assertNoFieldErrors(bad);
  if (Object.keys(wrongBook).length > 0) {
    throw new AppError(400, 'PRODUCT_NOT_IN_BOOK', 'Every counted product must be a stock product of the stocktake\'s book.', wrongBook);
  }
}

/** The business date / backdated pair that every audit entry of a financial record carries (section 12). */
function financialInfo(s: Stocktake): { businessDate: string; backdated: boolean } {
  return { businessDate: s.businessDate, backdated: s.backdated };
}

// ---------- create / update ----------

export interface StocktakeCreate {
  businessDate: string; book: StocktakeBook; notes?: string; items?: StocktakeItemInput[]; clientRef: string;
}

/**
 * Creates a draft stocktake (optionally with its first counted lines). Nothing is posted to stock yet.
 * Idempotent by `clientRef`: a repeat returns the saved stocktake with `created: false`.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED / PRODUCT_NOT_IN_BOOK.
 */
export function createStocktake(ctx: AppContext, body: StocktakeCreate): { item: Stocktake; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  return runWrite(ctx, (conn) => {
    const existing = getStocktakeByClientRef(conn, body.clientRef);
    if (existing) return { item: toStocktake(conn, existing), created: false };

    const items = body.items ?? [];
    checkItems(conn, body.book, items);
    const id = insertStocktake(conn, {
      businessDate: body.businessDate, book: body.book, notes, clientRef: body.clientRef,
    });
    if (items.length > 0) replaceStocktakeItems(conn, id, items);
    const item = loadStocktake(conn, id);
    logAudit(conn, 'stocktake', String(id), 'create', null, item, undefined, financialInfo(item));
    return { item, created: true };
  });
}

/**
 * Changes a DRAFT stocktake: replaces its counted lines and/or its notes. The whole line list is replaced
 * (delete + insert) so the screen can simply send what it shows.
 *
 * @throws AppError 404 NOT_FOUND, 409 NOT_DRAFT, 400 VALIDATION_ERROR / PRODUCT_NOT_IN_BOOK.
 */
export function updateStocktake(
  ctx: AppContext, id: number, body: { notes?: string; items?: StocktakeItemInput[] },
): Stocktake {
  const fields: Fields = {};
  const notes = body.notes === undefined ? undefined : trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const header = getStocktakeRow(conn, id);
    if (!header) throw notFound('Stocktake');
    if (header.status !== 'draft') {
      throw new AppError(409, 'NOT_DRAFT', 'Only a draft stocktake can be changed.');
    }
    const before = toStocktake(conn, header);
    if (body.items !== undefined) {
      checkItems(conn, header.book, body.items);
      replaceStocktakeItems(conn, id, body.items);
    }
    if (notes !== undefined) updateStocktakeNotes(conn, id, notes);
    const after = loadStocktake(conn, id);
    logAudit(conn, 'stocktake', String(id), 'update', before, after, undefined, financialInfo(after));
    return after;
  });
}

// ---------- complete ----------

/**
 * Posts the stock movement for one counted line (if counted differs from the live pool) and returns the
 * figures to store on the line: value change and the unit cost used for a gain (null when the average was used).
 * Must run inside the completing transaction.
 *
 * @param index Position of the line, used to point a UNIT_COST_REQUIRED error at the right input.
 */
function postCountDifference(
  conn: DatabaseSync, header: StocktakeRow, row: StocktakeItemRow, index: number, reason: string,
): { expectedQty: number; differenceQty: number; valueDeltaCents: number; gainUnitCostCents: number | null } {
  const pool = getPool(conn, row.productId); // live pool at this moment
  const differenceQty = row.countedQty - pool.qty;
  let valueDeltaCents = 0;
  let gainUnitCostCents: number | null = null;
  if (differenceQty < 0) {
    // Shortage: remove the missing units at the weighted average.
    const out = issueStock(conn, {
      productId: row.productId, businessDate: header.businessDate, type: 'stocktake_loss',
      qty: -differenceQty, refTable: 'stocktakes', refId: header.id, reason,
    });
    valueDeltaCents = -out.valueRemovedCents;
  } else if (differenceQty > 0) {
    // Surplus: add the extra units at the current average (C10: or at the entered unit cost when none exists).
    const averageUsable = pool.qty > 0 && pool.valueCents > 0;
    let valueCents: number;
    try {
      valueCents = gainValue(pool, differenceQty, row.gainUnitCostCents);
    } catch (err) {
      if (err instanceof AppError && err.code === 'UNIT_COST_REQUIRED') {
        throw new AppError(422, 'UNIT_COST_REQUIRED',
          `${row.productName}: there is no stock value to average from, so a unit cost is required for the extra units.`,
          { [`items.${index}.gainUnitCostCents`]: 'Enter the unit cost of the extra units.' });
      }
      throw err;
    }
    receiveStock(conn, {
      productId: row.productId, businessDate: header.businessDate, type: 'stocktake_gain', qty: differenceQty,
      valueCents, refTable: 'stocktakes', refId: header.id, reason,
    });
    valueDeltaCents = valueCents;
    // Only remember the entered unit cost when it was actually used (not when the average applied).
    gainUnitCostCents = averageUsable ? null : row.gainUnitCostCents;
  }
  return { expectedQty: pool.qty, differenceQty, valueDeltaCents, gainUnitCostCents };
}

/**
 * Completes a draft stocktake: posts a stock movement for every line whose count differs from the live pool,
 * stores the expected/difference/value figures on each line, then marks the stocktake `completed`.
 * One transaction: either every line posts or none does.
 *
 * Order matters: the item figures are stored while the parent is still a draft, because the database trigger
 * (`trg_stocktake_items_update_draft`) refuses item changes after completion.
 *
 * @throws AppError 404 NOT_FOUND, 409 NOT_DRAFT, 400 VALIDATION_ERROR (no lines),
 *   422 UNIT_COST_REQUIRED (surplus with no stock value, C10), 422 INSUFFICIENT_STOCK.
 */
export function completeStocktake(ctx: AppContext, id: number): Stocktake {
  return runWrite(ctx, (conn) => {
    const header = getStocktakeRow(conn, id);
    if (!header) throw notFound('Stocktake');
    assertDayOpen(conn, [header.book], header.businessDate); // R9: completing is the moment stock is posted
    if (header.status !== 'draft') {
      throw new AppError(409, 'NOT_DRAFT', 'Only a draft stocktake can be completed.');
    }
    const before = toStocktake(conn, header);
    const rows = listStocktakeItems(conn, id);
    if (rows.length === 0) throw validationError({ items: 'Add at least one counted product before completing.' });

    const reason = `Stocktake #${id}`;
    rows.forEach((row, index) => {
      completeStocktakeItem(conn, row.id, postCountDifference(conn, header, row, index, reason));
    });
    markStocktakeCompleted(conn, id);
    const after = loadStocktake(conn, id);
    logAudit(conn, 'stocktake', String(id), 'complete', before, after, undefined, financialInfo(after));
    return after;
  });
}

// ---------- void ----------

/**
 * Voids a stocktake (R1, C6). A draft is simply marked void (nothing was posted). A completed one has its
 * stock movements negated; if some of the stock it added has since been used, the void is refused
 * (422 INSUFFICIENT_STOCK) rather than leaving negative stock.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID, 422 INSUFFICIENT_STOCK.
 */
export function voidStocktake(ctx: AppContext, id: number, body: { reason: string }): Stocktake {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const header = getStocktakeRow(conn, id);
    if (!header) throw notFound('Stocktake');
    // R9: a draft has posted nothing, so only a completed stocktake's void touches a (closed) day.
    if (header.status === 'completed') assertDayOpen(conn, [header.book], header.businessDate);
    if (header.status === 'void') throw alreadyVoid('stocktake');
    const before = toStocktake(conn, header);

    if (header.status === 'completed') {
      const ids = listMovementsByRef(conn, 'stocktakes', id).map((m) => m.id);
      try {
        reverseMovements(conn, ids, `Void of stocktake #${id}`);
      } catch (err) {
        if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') {
          throw new AppError(422, 'INSUFFICIENT_STOCK',
            'Some of the stock added by this stocktake has already been used.', err.fields, err.extra);
        }
        throw err;
      }
    }
    markStocktakeVoid(conn, id, reason);
    const after = loadStocktake(conn, id);
    logAudit(conn, 'stocktake', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
