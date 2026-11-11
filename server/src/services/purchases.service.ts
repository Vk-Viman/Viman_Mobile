import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { todayBusinessDate, isIsoDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { findCashEntriesByRef, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import { getProduct } from '../repositories/products.repo.ts';
import type { ProductRow } from '../repositories/products.repo.ts';
import {
  addReturnedUnits, getPurchase as getPurchaseRow, getPurchaseByClientRef, getPurchaseReturn,
  getPurchaseReturnByClientRef, insertPurchase, insertPurchaseItem, insertPurchaseReturn,
  insertPurchaseReturnItem, listPurchaseItems, listPurchaseReturnItems, listPurchaseReturns, listPurchases as listPurchaseRows,
  markPurchaseVoid, returnedValueSoFar,
} from '../repositories/purchases.repo.ts';
import type {
  PurchaseBook, PurchaseHeaderRow, PurchaseReturnRow, PurchaseStatus,
} from '../repositories/purchases.repo.ts';
import { getSupplier } from '../repositories/suppliers.repo.ts';
import { logAudit } from './audit.service.ts';
import { issueStockCapped, receiveStock } from './inventory.service.ts';

type Fields = Record<string, string>;

export interface PurchaseItem {
  id: number; productId: number; productName: string; packs: number; packSize: number; units: number;
  lineTotalCents: number; unitCostCents: number; returnedUnits: number;
}
export interface PurchaseReturnLine {
  id: number; purchaseItemId: number; productId: number; productName: string; units: number; valueCents: number;
}
export interface PurchaseReturn {
  id: number; purchaseId: number; businessDate: string; postedAt: string; backdated: boolean;
  refundCents: number; note: string; clientRef: string; items: PurchaseReturnLine[];
}
export interface Purchase {
  id: number; businessDate: string; postedAt: string; backdated: boolean;
  supplierId: number | null; supplierName: string | null; billNo: string; book: PurchaseBook;
  totalCents: number; status: PurchaseStatus; notes: string; voidedAt: string | null; voidReason: string | null;
  clientRef: string; items: PurchaseItem[]; returns: PurchaseReturn[];
}

export const FUTURE_DATE_MESSAGE = 'Future-dated transactions are not allowed. Please select today or an earlier date.';

function returnBeforeOriginalMessage(originalDate: string): string {
  return `The return date cannot be earlier than the original purchase date (${originalDate}). `
    + `Please select ${originalDate} or a later date (not after today).`;
}

// ---------- helpers ----------

function validationError(fields: Fields): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
}

function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`);
}

function futureDateError(): AppError {
  return new AppError(400, 'FUTURE_DATE_NOT_ALLOWED', FUTURE_DATE_MESSAGE, { businessDate: FUTURE_DATE_MESSAGE });
}

function returnBeforeOriginalError(originalDate: string): AppError {
  const message = returnBeforeOriginalMessage(originalDate);
  return new AppError(400, 'RETURN_BEFORE_ORIGINAL_DATE', message, { businessDate: message }, { originalDate });
}

/** Real-calendar-date check (400 VALIDATION_ERROR) then R-FD (400 FUTURE_DATE_NOT_ALLOWED). */
function checkBusinessDate(date: string): void {
  if (!isIsoDate(date)) throw validationError({ businessDate: 'Enter a valid date (YYYY-MM-DD).' });
  if (date > todayBusinessDate()) throw futureDateError();
}

/** `backdated` = business date earlier than the Colombo date of the posting time. */
function isBackdated(businessDate: string, postedAt: string): boolean {
  return businessDate < todayBusinessDate(new Date(postedAt));
}

/** Safety net: maps database trigger / constraint aborts to the contract's error envelopes. */
function mapDbAbort(err: unknown, originalDate?: string): never {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('FUTURE_DATE_NOT_ALLOWED')) throw futureDateError();
  if (msg.includes('RETURN_BEFORE_ORIGINAL_DATE')) {
    if (originalDate !== undefined) throw returnBeforeOriginalError(originalDate);
    throw new AppError(400, 'RETURN_BEFORE_ORIGINAL_DATE',
      'The return date cannot be earlier than the original purchase date.');
  }
  if (msg.includes('PURCHASE_VOID')) {
    throw new AppError(409, 'PURCHASE_VOID', 'This purchase has been voided, so it cannot be returned.');
  }
  if (msg.includes('STOCK_VALUE_WITHOUT_QTY') || /CHECK constraint failed: .*(qty_on_hand|stock_value_cents)/.test(msg)) {
    throw new AppError(422, 'INSUFFICIENT_STOCK', 'Not enough stock for this operation.');
  }
  throw err;
}

function runWrite<T>(ctx: AppContext, fn: (conn: DatabaseSync) => T, originalDate?: () => string | undefined): T {
  try {
    return ctx.database.tx(fn);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return mapDbAbort(err, originalDate?.());
  }
}

function trimmed(fields: Fields, key: string, label: string, value: string | undefined, min: number, max: number): string {
  const v = (value ?? '').trim();
  if (v.length < min) fields[key] = `${label} is required.`;
  else if (v.length > max) fields[key] = `${label} must be at most ${max} characters.`;
  return v;
}

// ---------- DTO assembly ----------

function toReturn(conn: DatabaseSync, r: PurchaseReturnRow): PurchaseReturn {
  return {
    id: r.id, purchaseId: r.purchaseId, businessDate: r.businessDate, postedAt: r.postedAt,
    backdated: isBackdated(r.businessDate, r.postedAt), refundCents: r.refundCents, note: r.note,
    clientRef: r.clientRef,
    items: listPurchaseReturnItems(conn, r.id).map((i) => ({
      id: i.id, purchaseItemId: i.purchaseItemId, productId: i.productId, productName: i.productName,
      units: i.units, valueCents: i.valueCents,
    })),
  };
}

function toPurchase(conn: DatabaseSync, h: PurchaseHeaderRow): Purchase {
  return {
    id: h.id, businessDate: h.businessDate, postedAt: h.postedAt, backdated: isBackdated(h.businessDate, h.postedAt),
    supplierId: h.supplierId, supplierName: h.supplierName, billNo: h.billNo, book: h.book,
    totalCents: h.totalCents, status: h.status, notes: h.notes, voidedAt: h.voidedAt, voidReason: h.voidReason,
    clientRef: h.clientRef,
    items: listPurchaseItems(conn, h.id).map((i) => ({
      id: i.id, productId: i.productId, productName: i.productName, packs: i.packs, packSize: i.packSize,
      units: i.units, lineTotalCents: i.lineTotalCents, unitCostCents: mulDivRound(i.lineTotalCents, 1, i.units),
      returnedUnits: i.returnedUnits,
    })),
    returns: listPurchaseReturns(conn, h.id).map((r) => toReturn(conn, r)),
  };
}

function loadPurchase(conn: DatabaseSync, id: number): Purchase {
  const h = getPurchaseRow(conn, id);
  if (!h) throw notFound('Purchase');
  return toPurchase(conn, h);
}

// ---------- reads ----------

export function getPurchase(ctx: AppContext, id: number): Purchase {
  return loadPurchase(ctx.database.conn, id);
}

export function listPurchases(ctx: AppContext, q: {
  from?: string; to?: string; book?: PurchaseBook; supplierId?: number; status?: PurchaseStatus; q?: string;
  limit: number; offset: number;
}): { items: Purchase[]; total: number } {
  const conn = ctx.database.conn;
  const { items, total } = listPurchaseRows(conn, q);
  return { items: items.map((h) => toPurchase(conn, h)), total };
}

// ---------- create ----------

export interface PurchaseCreate {
  businessDate: string; supplierId?: number; billNo?: string;
  items: Array<{ productId: number; packs: number; packSize: number; lineTotalCents: number }>;
  notes?: string; clientRef: string;
}

export function createPurchase(ctx: AppContext, body: PurchaseCreate): { item: Purchase; created: boolean } {
  const fields: Fields = {};
  const billNo = trimmed(fields, 'billNo', 'Bill number', body.billNo, 0, 40);
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, 500);
  if (!isIsoDate(body.businessDate)) fields.businessDate = 'Enter a valid date (YYYY-MM-DD).';
  if (Object.keys(fields).length > 0) throw validationError(fields);
  checkBusinessDate(body.businessDate);

  return runWrite(ctx, (conn) => {
    const existing = getPurchaseByClientRef(conn, body.clientRef);
    if (existing) return { item: toPurchase(conn, existing), created: false };

    const bad: Fields = {};
    const products: ProductRow[] = [];
    body.items.forEach((line, i) => {
      const p = getProduct(conn, line.productId);
      if (!p) bad[`items.${i}.productId`] = 'Product not found.';
      else products.push(p);
    });
    if (body.supplierId !== undefined) {
      const s = getSupplier(conn, body.supplierId);
      if (!s) bad.supplierId = 'Supplier not found.';
      else if (!s.active) bad.supplierId = 'This supplier is inactive.';
    }
    if (Object.keys(bad).length > 0) throw validationError(bad);

    const notStockable: Fields = {};
    products.forEach((p, i) => {
      if (p.kind !== 'stock') notStockable[`items.${i}.productId`] = 'Only stock products can be purchased.';
      else if (!p.active) notStockable[`items.${i}.productId`] = 'This product is inactive.';
    });
    if (Object.keys(notStockable).length > 0) {
      throw new AppError(400, 'PRODUCT_NOT_STOCKABLE', 'Only active stock products can be purchased.', notStockable);
    }
    const books = new Set(products.map((p) => p.book));
    if (books.size > 1) {
      throw new AppError(400, 'MIXED_BOOKS', 'Shop and Telecom items cannot be on one bill — please split into two bills.');
    }
    const book = (products[0] as ProductRow).book;

    let totalCents = 0;
    const lines = body.items.map((line) => {
      const units = line.packs * line.packSize;
      totalCents += line.lineTotalCents;
      return { ...line, units };
    });
    if (!Number.isSafeInteger(totalCents)) throw validationError({ items: 'The bill total is too large.' });

    const purchaseId = insertPurchase(conn, {
      businessDate: body.businessDate, supplierId: body.supplierId ?? null, billNo, book, totalCents,
      notes, clientRef: body.clientRef,
    });
    for (const line of lines) {
      insertPurchaseItem(conn, {
        purchaseId, productId: line.productId, packs: line.packs, packSize: line.packSize,
        units: line.units, lineTotalCents: line.lineTotalCents,
      });
      receiveStock(conn, {
        productId: line.productId, businessDate: body.businessDate, type: 'purchase', qty: line.units,
        valueCents: line.lineTotalCents, refTable: 'purchases', refId: purchaseId, reason: `Purchase #${purchaseId}`,
      });
    }
    if (totalCents > 0) {
      insertCashEntry(conn, {
        book, businessDate: body.businessDate, type: 'purchase_payment', amountCents: -totalCents,
        refTable: 'purchases', refId: purchaseId,
      });
    }
    const item = loadPurchase(conn, purchaseId);
    logAudit(conn, 'purchase', String(purchaseId), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

// ---------- void ----------

export function voidPurchase(ctx: AppContext, id: number, body: { reason: string }): Purchase {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, 200);
  if (Object.keys(fields).length > 0) throw validationError(fields);

  return runWrite(ctx, (conn) => {
    const header = getPurchaseRow(conn, id);
    if (!header) throw notFound('Purchase');
    if (header.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'This purchase is already void.');
    const before = toPurchase(conn, header);
    if (before.returns.length > 0 || before.items.some((i) => i.returnedUnits > 0)) {
      throw new AppError(409, 'HAS_RETURNS', 'This purchase has returns, so it cannot be voided.');
    }

    // Stock check with live pool state (the same product may be on several lines).
    const avail = new Map<number, number>();
    const short: Fields = {};
    const shortLines: Array<{ index: number; productId: number; onHand: number; units: number }> = [];
    before.items.forEach((line, i) => {
      let onHand = avail.get(line.productId);
      if (onHand === undefined) {
        const p = getProduct(conn, line.productId);
        onHand = p ? p.qtyOnHand : 0;
      }
      if (line.units > onHand) {
        short[`items.${i}`] = `${line.productName}: only ${onHand} of ${line.units} units are on hand.`;
        shortLines.push({ index: i, productId: line.productId, onHand, units: line.units });
      } else {
        onHand -= line.units;
      }
      avail.set(line.productId, onHand);
    });
    if (shortLines.length > 0) {
      throw new AppError(422, 'INSUFFICIENT_STOCK', 'Some of this purchase has already been sold or removed.', short,
        { onHand: (shortLines[0] as { onHand: number }).onHand, lines: shortLines });
    }

    for (const line of before.items) {
      issueStockCapped(conn, {
        productId: line.productId, businessDate: before.businessDate, type: 'purchase_void', qty: line.units,
        maxValueCents: line.lineTotalCents, refTable: 'purchases', refId: id, reason: `Void of purchase #${id}`,
      });
    }

    if (before.totalCents > 0) {
      const original = findCashEntriesByRef(conn, 'purchases', id)
        .find((e) => e.type === 'purchase_payment' && e.reversesEntryId === null && e.amountCents < 0);
      if (!original) throw new Error(`Purchase #${id} has no payment cash entry to reverse`);
      insertCashEntry(conn, {
        book: before.book, businessDate: before.businessDate, type: 'purchase_payment',
        amountCents: before.totalCents, refTable: 'purchases', refId: id, reversesEntryId: original.id,
        note: `Void of purchase #${id}`,
      });
    }

    markPurchaseVoid(conn, id, reason);
    const after = loadPurchase(conn, id);
    logAudit(conn, 'purchase', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: after.businessDate < todayBusinessDate() });
    return after;
  });
}

// ---------- return ----------

export interface PurchaseReturnCreate {
  businessDate: string; items: Array<{ purchaseItemId: number; units: number }>; note?: string; clientRef: string;
}

export function createPurchaseReturn(
  ctx: AppContext, purchaseId: number, body: PurchaseReturnCreate,
): { item: PurchaseReturn; purchase: Purchase; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, 500);
  if (Object.keys(fields).length > 0) throw validationError(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  let originalDate: string | undefined;
  return runWrite(ctx, (conn) => {
    const existing = getPurchaseReturnByClientRef(conn, body.clientRef);
    if (existing) {
      if (existing.purchaseId !== purchaseId) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different purchase.');
      }
      return { item: toReturn(conn, existing), purchase: loadPurchase(conn, purchaseId), created: false };
    }

    const header = getPurchaseRow(conn, purchaseId);
    if (!header) throw notFound('Purchase');
    originalDate = header.businessDate;
    if (body.businessDate < header.businessDate) throw returnBeforeOriginalError(header.businessDate); // R-RD
    if (header.status === 'void') {
      throw new AppError(409, 'PURCHASE_VOID', 'This purchase has been voided, so it cannot be returned.');
    }

    const purchase = toPurchase(conn, header);
    const bad: Fields = {};
    const seen = new Set<number>();
    const lines = body.items.map((req, i) => {
      const item = purchase.items.find((it) => it.id === req.purchaseItemId);
      if (!item) bad[`items.${i}.purchaseItemId`] = 'This item does not belong to the purchase.';
      else if (seen.has(item.id)) bad[`items.${i}.purchaseItemId`] = 'Each item can appear only once per return.';
      else seen.add(item.id);
      return { index: i, item, units: req.units };
    });
    if (Object.keys(bad).length > 0) throw validationError(bad);

    const over: Fields = {};
    for (const l of lines) {
      const item = l.item as PurchaseItem;
      const remaining = item.units - item.returnedUnits;
      if (l.units < 1) over[`items.${l.index}.units`] = 'Units must be at least 1.';
      else if (l.units > remaining) {
        over[`items.${l.index}.units`] = `Only ${remaining} unit(s) of ${item.productName} can still be returned.`;
      }
    }
    if (Object.keys(over).length > 0) {
      throw new AppError(422, 'RETURN_EXCEEDS_PURCHASED', 'You cannot return more units than were purchased.', over);
    }

    // C7: proportional value, except the return that completes the item takes the remaining value.
    const priced = lines.map((l) => {
      const item = l.item as PurchaseItem;
      const returnedValue = returnedValueSoFar(conn, item.id);
      const remainingValue = Math.max(0, item.lineTotalCents - returnedValue);
      const valueCents = item.returnedUnits + l.units === item.units
        ? remainingValue
        : Math.min(mulDivRound(item.lineTotalCents, l.units, item.units), remainingValue);
      return { ...l, item, valueCents };
    });
    const refundCents = priced.reduce((sum, l) => sum + l.valueCents, 0);

    const returnId = insertPurchaseReturn(conn, {
      purchaseId, businessDate: body.businessDate, refundCents, note, clientRef: body.clientRef,
    });
    for (const l of priced) {
      insertPurchaseReturnItem(conn, {
        purchaseReturnId: returnId, purchaseItemId: l.item.id, units: l.units, valueCents: l.valueCents,
      });
      try {
        issueStockCapped(conn, {
          productId: l.item.productId, businessDate: body.businessDate, type: 'purchase_return', qty: l.units,
          maxValueCents: l.valueCents, refTable: 'purchase_returns', refId: returnId,
          reason: `Purchase return #${returnId} (purchase #${purchaseId})`,
        });
      } catch (err) {
        if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') {
          throw new AppError(422, 'INSUFFICIENT_STOCK', 'Not enough stock on hand to return these units.',
            { [`items.${l.index}.units`]: `${l.item.productName}: not enough stock on hand to return ${l.units} unit(s).` },
            err.extra);
        }
        throw err;
      }
      addReturnedUnits(conn, l.item.id, l.units);
    }
    if (refundCents > 0) {
      insertCashEntry(conn, {
        book: header.book, businessDate: body.businessDate, type: 'purchase_refund', amountCents: refundCents,
        refTable: 'purchase_returns', refId: returnId,
      });
    }

    const row = getPurchaseReturn(conn, returnId) as PurchaseReturnRow;
    const item = toReturn(conn, row);
    logAudit(conn, 'purchase_return', String(returnId), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, purchase: loadPurchase(conn, purchaseId), created: true };
  }, () => originalDate);
}
