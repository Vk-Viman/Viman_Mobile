/**
 * services/sales-returns.service.ts - customer returns against a sale (full or partial, resalable or damaged).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules implemented here:
 *  - R5 / C5 / C13: the revenue, cost (COGS) and extra cost of a returned line are split proportionally; the return
 *         that brings the line's cumulative returned quantity to its full quantity takes the exact remainder of ALL
 *         THREE, so the
 *         returns of a line always add up to the line with no rounding gap (`returnPortion`).
 *  - Resalable goods go back on the shelf at the ORIGINAL snapshot cost (`sale_return` movement, value = COGS
 *         portion; the extra cost never entered stock, so it is not restocked), so the pool value rises by exactly the cost that left it.
 *  - Damaged goods write NO stock movement (nothing goes back on the shelf). Instead exactly ONE `stock_losses`
 *         row per damaged line records the written-off cost, so the loss is counted once (section 4, R2) - the
 *         revenue and COGS reversal alone would otherwise hide it.
 *  - Section 2: one cash refund entry (`sale_refund` Shop / `card_refund` Telecom) dated the return's date.
 *  - R-FD: no future dates. R-RD: a return may not be dated before its sale. A voided sale cannot be returned.
 *  - R9: a closed day of the sale's book refuses the return (judged on the RETURN's date); R13: the refund is a
 *         cash-out, so it returns the shared negative-cash warning.
 *  - Section 12: `clientRef` makes a repeat return the saved return; the whole return is audited.
 * Validation order (contract): schema -> R-FD -> sale lookup 404 -> R-RD -> DAY_CLOSED -> SALE_VOID -> quantities.
 * Write order (the DB trigger RETURN_EXCEEDS_SOLD compares against `returned_qty` at insert time): return header,
 * return lines, `addReturnedQty` per line, then stock/loss effects, cash, audit - all in one transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { insertCashEntry } from '../repositories/cash-entries.repo.ts';
import { getProduct } from '../repositories/products.repo.ts';
import {
  addReturnedQty, getSale as getSaleRow, getSaleItem, getSaleReturn, getSaleReturnByClientRef, insertSaleReturn,
  insertSaleReturnItem, returnedAmountsSoFar,
} from '../repositories/sales.repo.ts';
import type { SaleItemRow, SaleRow } from '../repositories/sales.repo.ts';
import { insertStockLoss } from '../repositories/stock-losses.repo.ts';
import { logAudit } from './audit.service.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { receiveStock } from './inventory.service.ts';
import { returnBeforeOriginalError, returnPortion } from './return-rules.ts';
import { REFUND_CASH_TYPE, loadSale, runSalesWrite, toSaleReturn } from './sales-common.ts';
import type { Sale, SaleReturn } from './sales-common.ts';
import {
  NOTE_MAX_LENGTH, assertNoFieldErrors, checkBusinessDate, notFound, trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** One requested return line. `resalable: false` means damaged (written off, not restocked). */
export interface SaleReturnRequestLine { saleItemId: number; qty: number; resalable: boolean }
/** Body of `POST /sales/:id/returns`. */
export interface SaleReturnCreate {
  businessDate: string; items: SaleReturnRequestLine[]; note?: string; clientRef: string;
}

/** A requested line matched to its sale line, with the C5 portions worked out. */
interface PricedLine {
  index: number; item: SaleItemRow; qty: number; resalable: boolean; revenueCents: number; cogsCents: number;
  extraCostCents: number;
}

/**
 * Matches each requested line to a line of THIS sale. Rejects unknown or foreign lines and a line that appears
 * twice in one request (400 VALIDATION_ERROR, `fields["items.N.saleItemId"]`).
 */
function matchSaleItems(conn: DatabaseSync, saleId: number, req: SaleReturnRequestLine[]) {
  const bad: Fields = {};
  const seen = new Set<number>();
  const matched = req.map((r, index) => {
    const item = getSaleItem(conn, r.saleItemId);
    if (!item || item.saleId !== saleId) bad[`items.${index}.saleItemId`] = 'This item does not belong to the sale.';
    else if (seen.has(item.id)) bad[`items.${index}.saleItemId`] = 'Each item can appear only once per return.';
    else seen.add(item.id);
    return { index, item: item as SaleItemRow, qty: r.qty, resalable: r.resalable };
  });
  assertNoFieldErrors(bad);
  return matched;
}

/** 422 RETURN_EXCEEDS_SOLD when a line asks for more than `sold - already returned` (`fields["items.N.qty"]`). */
function assertWithinSold(lines: ReturnType<typeof matchSaleItems>): void {
  const over: Fields = {};
  for (const l of lines) {
    const remaining = l.item.qty - l.item.returnedQty;
    if (l.qty > remaining) {
      over[`items.${l.index}.qty`] = `Only ${remaining} unit(s) of ${l.item.productName} can still be returned.`;
    }
  }
  if (Object.keys(over).length > 0) {
    throw new AppError(422, 'RETURN_EXCEEDS_SOLD', 'You cannot return more than was sold.', over);
  }
}

/** C5 / C13: works out the revenue, COGS and extra-cost portion of every line from what earlier returns already took back. */
function priceLines(conn: DatabaseSync, lines: ReturnType<typeof matchSaleItems>): PricedLine[] {
  return lines.map((l) => {
    const so = returnedAmountsSoFar(conn, l.item.id);
    return {
      ...l,
      revenueCents: returnPortion(l.item.revenueCents, l.qty, l.item.qty, so.qty, so.revenueCents),
      cogsCents: returnPortion(l.item.cogsCents, l.qty, l.item.qty, so.qty, so.cogsCents),
      extraCostCents: returnPortion(l.item.extraCostCents, l.qty, l.item.qty, so.qty, so.extraCostCents),
    };
  });
}

/**
 * Writes the stock side of one returned line: a resalable line restocks at the AUTOMATIC cost portion only; a
 * damaged line writes NO movement and one `damaged_return` loss row (automatic cost only) instead. The C13 extra
 * cost never entered stock, so it never comes back to it.
 *
 * @param lossNo 1-based number of this damaged line within the return (makes the loss `clientRef` unique).
 */
function applyStockEffect(
  conn: DatabaseSync, sale: SaleRow, returnId: number, businessDate: string, clientRef: string,
  line: PricedLine, lossNo: number,
): void {
  if (line.resalable) {
    receiveStock(conn, {
      productId: line.item.productId, businessDate, type: 'sale_return', qty: line.qty, valueCents: line.cogsCents,
      refTable: 'sales_returns', refId: returnId, reason: `Sales return #${returnId} (sale #${sale.id})`,
    });
    return;
  }
  const product = getProduct(conn, line.item.productId);
  if (!product) throw new Error(`Product #${line.item.productId} of sale #${sale.id} is missing`);
  insertStockLoss(conn, {
    businessDate, productId: product.id, book: product.book, qty: line.qty, costCents: line.cogsCents,
    reason: 'damaged', note: `Damaged return #${returnId} (sale #${sale.id})`, clientRef: `${clientRef}-loss-${lossNo}`,
    source: 'damaged_return', salesReturnId: returnId,
  });
}

/** Writes header, lines and counters (in the order the trigger needs) and then the stock effects. */
function writeReturn(
  conn: DatabaseSync, sale: SaleRow, body: SaleReturnCreate, note: string, lines: PricedLine[],
): number {
  const refundCents = lines.reduce((sum, l) => sum + l.revenueCents, 0);
  const cogsReversedCents = lines.reduce((sum, l) => sum + l.cogsCents, 0);
  const extraCostReversedCents = lines.reduce((sum, l) => sum + l.extraCostCents, 0);
  const returnId = insertSaleReturn(conn, {
    saleId: sale.id, businessDate: body.businessDate, refundCents, cogsReversedCents, extraCostReversedCents, note,
    clientRef: body.clientRef,
  });
  // The DB trigger compares a new return line with (qty - returned_qty), so the lines go in BEFORE the counter moves.
  for (const l of lines) {
    insertSaleReturnItem(conn, {
      salesReturnId: returnId, saleItemId: l.item.id, qty: l.qty, resalable: l.resalable,
      revenueCents: l.revenueCents, cogsCents: l.cogsCents, extraCostCents: l.extraCostCents,
    });
    addReturnedQty(conn, l.item.id, l.qty);
  }
  let lossNo = 0;
  for (const l of lines) {
    if (!l.resalable) lossNo += 1;
    applyStockEffect(conn, sale, returnId, body.businessDate, body.clientRef, l, lossNo);
  }
  // No cash entry for a zero refund (e.g. a free item came back).
  if (refundCents > 0) {
    insertCashEntry(conn, {
      book: sale.book, businessDate: body.businessDate, type: REFUND_CASH_TYPE[sale.book], amountCents: -refundCents,
      refTable: 'sales_returns', refId: returnId,
    });
  }
  return returnId;
}

/**
 * Returns goods from a sale (full or partial). See the file header for the C5 split, the resalable / damaged
 * handling, the cash refund and the write order.
 *
 * Idempotent by `clientRef`: a repeat returns the saved return (`created: false`); the same reference used on a
 * different sale is 409 CLIENT_REF_CONFLICT.
 *
 * @throws AppError 400 VALIDATION_ERROR (fields; a line not in this sale; a duplicate line),
 *   400 FUTURE_DATE_NOT_ALLOWED (R-FD), 404 NOT_FOUND, 400 RETURN_BEFORE_ORIGINAL_DATE (R-RD, with `originalDate`),
 *   409 SALE_VOID, 409 CLIENT_REF_CONFLICT, 422 RETURN_EXCEEDS_SOLD.
 * @returns The return, the updated sale and whether the return was newly created.
 */
export function createSaleReturn(
  ctx: AppContext, saleId: number, body: SaleReturnCreate,
): { item: SaleReturn; sale: Sale; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  // Filled in once the sale has been read, so a trigger abort can still name the original date (R-RD).
  let originalDate: string | undefined;
  return runSalesWrite(ctx, (conn) => {
    const existing = getSaleReturnByClientRef(conn, body.clientRef);
    if (existing) {
      if (existing.saleId !== saleId) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different sale.');
      }
      return { item: toSaleReturn(conn, existing), sale: loadSale(conn, saleId), warnings: [], created: false };
    }

    const sale = getSaleRow(conn, saleId);
    if (!sale) throw notFound('Sale');
    originalDate = sale.businessDate;
    if (body.businessDate < sale.businessDate) throw returnBeforeOriginalError('sale', sale.businessDate); // R-RD
    assertDayOpen(conn, [sale.book], body.businessDate); // R9: judged on the RETURN's date
    if (sale.status === 'void') {
      throw new AppError(409, 'SALE_VOID', 'This sale has been voided, so it cannot be returned.');
    }

    const matched = matchSaleItems(conn, saleId, body.items);
    assertWithinSold(matched);
    const lines = priceLines(conn, matched);

    const returnId = writeReturn(conn, sale, body, note, lines);
    const item = toSaleReturn(conn, getSaleReturn(conn, returnId) as NonNullable<ReturnType<typeof getSaleReturn>>);
    logAudit(conn, 'sale_return', String(returnId), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, sale: loadSale(conn, saleId), warnings: item.refundCents > 0 ? negativeCashWarnings(conn, [sale.book]) : [], created: true };
  }, () => originalDate);
}
