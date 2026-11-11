/**
 * services/sales-common.ts - API shapes, DTO assembly and the write wrapper shared by the Phase 5 sales services
 * (`sales.service.ts` for sales / voids and `sales-returns.service.ts` for returns).
 *
 * Layer: service helper (route -> SERVICE -> repository -> database).
 * Business rules reflected here:
 *  - C5: a sale line's `cogsCents` is the stock value removed when it was sold and is only ever READ here;
 *        `unitCostCents` is the display-only snapshot `mulDivRound(cogs, 1, qty)`.
 *  - Section 4: `grossProfitCents = totalCents - cogsCents`, before returns (returns are listed on their own).
 *  - Section 12: every record carries `businessDate`, the server `postedAt` and the `backdated` flag.
 *  - R-FD / R-RD / R1 safety net: `runSalesWrite` runs one transaction and turns database trigger aborts into the
 *        contract's error envelopes should a service check ever be missed.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import {
  getSale, listSaleItems, listSaleReturnItems, listSaleReturns,
} from '../repositories/sales.repo.ts';
import type {
  SaleBook, SaleItemRow, SaleLineType, SaleReturnRow, SaleRow, SaleStatus,
} from '../repositories/sales.repo.ts';
import { returnBeforeOriginalError } from './return-rules.ts';
import { runWrite } from './stock-common.ts';
import { futureDateError, isBackdated, notFound } from './validation.ts';

/** One sold line as returned by the API. */
export interface SaleItem {
  id: number; lineNo: number; lineType: SaleLineType; productId: number; productName: string;
  productCode: string | null; qty: number; unitPriceCents: number; unitCostCents: number;
  revenueCents: number; cogsCents: number; returnedQty: number;
}
/** One returned line: the revenue and cost portions reversed (C5) and whether the goods went back on the shelf. */
export interface SaleReturnLine {
  id: number; saleItemId: number; productId: number; productName: string; qty: number; resalable: boolean;
  revenueCents: number; cogsCents: number;
}
/** A customer return as returned by the API. */
export interface SaleReturn {
  id: number; saleId: number; businessDate: string; postedAt: string; backdated: boolean; refundCents: number;
  cogsReversedCents: number; note: string; clientRef: string; items: SaleReturnLine[];
}
/** A sale with its lines and returns, as returned by the API. */
export interface Sale {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: SaleBook; totalCents: number;
  cogsCents: number; grossProfitCents: number; status: SaleStatus; notes: string; voidedAt: string | null;
  voidReason: string | null; clientRef: string; items: SaleItem[]; returns: SaleReturn[];
}

/** Cash-ledger type of the money taken for a sale, per book (BUSINESS_RULES section 2). */
export const SALE_CASH_TYPE: Record<SaleBook, string> = { shop: 'sale_goods', telecom: 'card_sale' };
/** Cash-ledger type of a refund for a returned sale, per book. */
export const REFUND_CASH_TYPE: Record<SaleBook, string> = { shop: 'sale_refund', telecom: 'card_refund' };
/** Sale line type per book: Shop sells goods, Telecom sells scratch cards. */
export const LINE_TYPE: Record<SaleBook, SaleLineType> = { shop: 'goods', telecom: 'card' };
/** Order in which the books are processed and listed: Shop first, then Telecom. */
export const BOOK_ORDER: readonly SaleBook[] = ['shop', 'telecom'];

// ---------- DTO assembly ----------

function toItem(i: SaleItemRow): SaleItem {
  return {
    id: i.id, lineNo: i.lineNo, lineType: i.lineType, productId: i.productId, productName: i.productName,
    productCode: i.productCode, qty: i.qty, unitPriceCents: i.unitPriceCents, unitCostCents: i.unitCostCents,
    revenueCents: i.revenueCents, cogsCents: i.cogsCents, returnedQty: i.returnedQty,
  };
}

/** Builds the API shape of a return (adds its lines and the `backdated` flag). */
export function toSaleReturn(conn: DatabaseSync, r: SaleReturnRow): SaleReturn {
  return {
    id: r.id, saleId: r.saleId, businessDate: r.businessDate, postedAt: r.postedAt,
    backdated: isBackdated(r.businessDate, r.postedAt), refundCents: r.refundCents,
    cogsReversedCents: r.cogsReversedCents, note: r.note, clientRef: r.clientRef,
    items: listSaleReturnItems(conn, r.id).map((i) => ({
      id: i.id, saleItemId: i.saleItemId, productId: i.productId, productName: i.productName, qty: i.qty,
      resalable: i.resalable, revenueCents: i.revenueCents, cogsCents: i.cogsCents,
    })),
  };
}

/** Builds the API shape of a sale (adds lines, returns, gross profit and the `backdated` flag). */
export function toSale(conn: DatabaseSync, h: SaleRow): Sale {
  return {
    id: h.id, businessDate: h.businessDate, postedAt: h.postedAt, backdated: isBackdated(h.businessDate, h.postedAt),
    book: h.book, totalCents: h.totalCents, cogsCents: h.cogsCents, grossProfitCents: h.totalCents - h.cogsCents,
    status: h.status, notes: h.notes, voidedAt: h.voidedAt, voidReason: h.voidReason, clientRef: h.clientRef,
    items: listSaleItems(conn, h.id).map(toItem),
    returns: listSaleReturns(conn, h.id).map((r) => toSaleReturn(conn, r)),
  };
}

/** Loads a full sale or throws 404 NOT_FOUND. */
export function loadSale(conn: DatabaseSync, id: number): Sale {
  const h = getSale(conn, id);
  if (!h) throw notFound('Sale');
  return toSale(conn, h);
}

// ---------- write wrapper ----------

/**
 * Safety net for the sales tables (migration 006 triggers). The services check every rule first, so these only
 * fire when a check was missed or lost a race; the user still gets the contract's envelope instead of a 500.
 *
 * @param originalDate The sale's date when known, so the R-RD message can name it.
 */
function mapSalesAbort(err: unknown, originalDate?: string): never {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('FUTURE_DATE_NOT_ALLOWED')) throw futureDateError();
  if (msg.includes('RETURN_BEFORE_ORIGINAL_DATE')) {
    if (originalDate !== undefined) throw returnBeforeOriginalError('sale', originalDate);
    throw new AppError(400, 'RETURN_BEFORE_ORIGINAL_DATE',
      'The return date cannot be earlier than the original sale date.');
  }
  if (msg.includes('SALE_VOID')) {
    throw new AppError(409, 'SALE_VOID', 'This sale has been voided, so it cannot be returned.');
  }
  if (msg.includes('RETURN_EXCEEDS_SOLD')) {
    throw new AppError(422, 'RETURN_EXCEEDS_SOLD', 'You cannot return more than was sold.');
  }
  if (msg.includes('RETURN_ITEM_MISMATCH')) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.',
      { items: 'An item does not belong to this sale.' });
  }
  throw err;
}

/**
 * Runs `fn` in ONE database transaction (all-or-nothing). `AppError`s from the service pass through (and roll
 * the transaction back); the generic stock aborts are mapped by `runWrite` (stock-common) and the sales-specific
 * trigger aborts by `mapSalesAbort`.
 *
 * @param originalDate Lazy getter: the original sale's date is only known once it was read inside the transaction.
 */
export function runSalesWrite<T>(ctx: AppContext, fn: (conn: DatabaseSync) => T, originalDate?: () => string | undefined): T {
  try {
    return runWrite(ctx, fn);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return mapSalesAbort(err, originalDate?.());
  }
}

/** Rounded unit cost of a snapshot (display only). */
export function unitCostOf(cogsCents: number, qty: number): number {
  return mulDivRound(cogsCents, 1, qty);
}
