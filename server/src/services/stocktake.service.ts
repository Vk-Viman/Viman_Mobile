import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import {
  completeStocktakeItem, getStocktake as getStocktakeRow, getStocktakeByClientRef, insertStocktake,
  listStocktakeItems, listStocktakes as listStocktakeRows, markStocktakeCompleted, markStocktakeVoid,
  replaceStocktakeItems, updateStocktakeNotes,
} from '../repositories/stocktakes.repo.ts';
import type { StocktakeBook, StocktakeRow, StocktakeStatus } from '../repositories/stocktakes.repo.ts';
import { logAudit } from './audit.service.ts';
import { gainValue, getPool, issueStock, receiveStock, reverseMovements } from './inventory.service.ts';
import { checkBusinessDate, isBackdated, notFound, runWrite, trimmed, validationError } from './stock-common.ts';
import type { Fields } from './stock-common.ts';

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

export interface StocktakeItemInput { productId: number; countedQty: number; gainUnitCostCents?: number }

// ---------- DTO assembly ----------

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

export function getStocktake(ctx: AppContext, id: number): Stocktake {
  return loadStocktake(ctx.database.conn, id);
}

export function listStocktakes(ctx: AppContext, q: {
  from?: string; to?: string; book?: StocktakeBook; status?: StocktakeStatus; limit: number; offset: number;
}): { items: Stocktake[]; total: number } {
  const conn = ctx.database.conn;
  const { items, total } = listStocktakeRows(conn, q);
  return { items: items.map((h) => toStocktake(conn, h)), total };
}

// ---------- items validation ----------

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
  if (Object.keys(bad).length > 0) throw validationError(bad);
  if (Object.keys(wrongBook).length > 0) {
    throw new AppError(400, 'PRODUCT_NOT_IN_BOOK', 'Every counted product must be a stock product of the stocktake\'s book.', wrongBook);
  }
}

function financialInfo(s: Stocktake): { businessDate: string; backdated: boolean } {
  return { businessDate: s.businessDate, backdated: s.backdated };
}

// ---------- create / update ----------

export interface StocktakeCreate {
  businessDate: string; book: StocktakeBook; notes?: string; items?: StocktakeItemInput[]; clientRef: string;
}

export function createStocktake(ctx: AppContext, body: StocktakeCreate): { item: Stocktake; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, 500);
  if (Object.keys(fields).length > 0) throw validationError(fields);
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

export function updateStocktake(
  ctx: AppContext, id: number, body: { notes?: string; items?: StocktakeItemInput[] },
): Stocktake {
  const fields: Fields = {};
  const notes = body.notes === undefined ? undefined : trimmed(fields, 'notes', 'Notes', body.notes, 0, 500);
  if (Object.keys(fields).length > 0) throw validationError(fields);

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

export function completeStocktake(ctx: AppContext, id: number): Stocktake {
  return runWrite(ctx, (conn) => {
    const header = getStocktakeRow(conn, id);
    if (!header) throw notFound('Stocktake');
    if (header.status !== 'draft') {
      throw new AppError(409, 'NOT_DRAFT', 'Only a draft stocktake can be completed.');
    }
    const before = toStocktake(conn, header);
    const rows = listStocktakeItems(conn, id);
    if (rows.length === 0) throw validationError({ items: 'Add at least one counted product before completing.' });

    const reason = `Stocktake #${id}`;
    rows.forEach((row, index) => {
      const pool = getPool(conn, row.productId); // live pool at this moment
      const differenceQty = row.countedQty - pool.qty;
      let valueDeltaCents = 0;
      let gainUnitCostCents: number | null = null;
      if (differenceQty < 0) {
        const out = issueStock(conn, {
          productId: row.productId, businessDate: header.businessDate, type: 'stocktake_loss',
          qty: -differenceQty, refTable: 'stocktakes', refId: id, reason,
        });
        valueDeltaCents = -out.valueRemovedCents;
      } else if (differenceQty > 0) {
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
          valueCents, refTable: 'stocktakes', refId: id, reason,
        });
        valueDeltaCents = valueCents;
        gainUnitCostCents = averageUsable ? null : row.gainUnitCostCents;
      }
      completeStocktakeItem(conn, row.id, {
        expectedQty: pool.qty, differenceQty, valueDeltaCents, gainUnitCostCents,
      });
    });
    markStocktakeCompleted(conn, id);
    const after = loadStocktake(conn, id);
    logAudit(conn, 'stocktake', String(id), 'complete', before, after, undefined, financialInfo(after));
    return after;
  });
}

// ---------- void ----------

export function voidStocktake(ctx: AppContext, id: number, body: { reason: string }): Stocktake {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, 200);
  if (Object.keys(fields).length > 0) throw validationError(fields);

  return runWrite(ctx, (conn) => {
    const header = getStocktakeRow(conn, id);
    if (!header) throw notFound('Stocktake');
    if (header.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'This stocktake is already void.');
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
      { businessDate: after.businessDate, backdated: after.businessDate < todayBusinessDate() });
    return after;
  });
}
