/**
 * services/sales-return-void.ts - voids ONE sales return (BUSINESS_RULES section 4, rule R-VR, approved 2026-11-13).
 *
 * Layer: service (route -> SERVICE -> repository -> database). `POST /sales/:saleId/returns/:returnId/void`.
 *
 * Everything happens in ONE database transaction; nothing that exists is edited or deleted (R1, C6): the original return,
 * its movements, its refund entry and its audit row stay, and NEW reversal rows are added.
 *
 * Validation order: schema (reason) -> lookups 404 (sale, then the return of THAT sale) -> 409 ALREADY_VOID ->
 * 409 RETURN_NOT_NEWEST (R-VR 1) -> closed-day checks on the RETURN's business date (R9 + closed-day ordering, `assertDayOpen`)
 * -> 409 RETURN_STOCK_NOT_AVAILABLE (R-VR 3, nothing written) -> writes.
 *
 * Writes, in order (each step may fail and then the whole transaction rolls back):
 *  1. the return becomes `void` (voided_at/void_reason). From here the DATABASE (migration 017 triggers) lowers each line's
 *     `returned_qty` by exactly the returned quantity (R-VR 7) and voids the damaged-return loss row (R-VR 6, it has no movement).
 *  2. for every RESALABLE line: the units that came back leave stock again (`sale_return` reversal movement, dated like the
 *     return). Value removed = the value the return restored (the line's cost portion), limited to the pool value (R4). If that
 *     empties the pool with value left over, the residue is swept first by a value-only `adjustment` movement (the database
 *     refuses quantity 0 with value > 0). See `removeRestockedUnits`.
 *  3. the refund is paid back in: one cash entry of the same type and book, +refund, with the return's ORIGINAL business date and a
 *     link to the original refund row (`reverseCash`). No entry when the refund was 0.
 *  4. one audit row (entity `sale_return` like the create row, action `void`, business date and backdated flag).
 * Cost and extra cost stand again in full and revenue is back because every report reads POSTED returns only (R-VR 4, 5, 8).
 * The stock-value difference (value restored - value removed) is reported as the Stock adjustments component
 * `salesReturnVoidGainCents` (reports/fin-queries.ts), so profit still reconciles with cash + stock.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { findCashEntriesByRef } from '../repositories/cash-entries.repo.ts';
import {
  getSale as getSaleRow, getSaleReturn, listSaleReturnItems, markSaleReturnVoid, newerPostedReturn,
} from '../repositories/sales.repo.ts';
import type { SaleReturnItemRow } from '../repositories/sales.repo.ts';
import { insertMovement } from '../repositories/stock-movements.repo.ts';
import { logAudit } from './audit.service.ts';
import { reverseCash } from './cash-posting.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { getPool } from './inventory.service.ts';
import { REFUND_CASH_TYPE, loadSale, runSalesWrite, toSaleReturn } from './sales-common.ts';
import type { Sale, SaleReturn } from './sales-common.ts';
import {
  REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, isBackdatedToday, notFound, trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/**
 * R-VR 3: takes `qty` units back out of a product's pool after the return that restocked them is voided.
 * Removes `min(restoredValueCents, pool value)`; when the pool quantity reaches 0 with value left, sweeps the residue first
 * (value-only `adjustment`, Stock adjustments line) so every intermediate state is valid. The two movements carry the return's
 * business date and point at the return (`ref sales_returns`), so the return's period carries the whole correction.
 *
 * @returns value removed and value swept (both cents); `restored - removed` is the "void gain" of the Stock adjustments line.
 */
export function removeRestockedUnits(conn: DatabaseSync, p: {
  productId: number; businessDate: string; qty: number; restoredValueCents: number; returnId: number;
}): { removedCents: number; sweptCents: number } {
  const pool = getPool(conn, p.productId);
  if (p.qty > pool.qty) {
    throw new AppError(409, 'RETURN_STOCK_NOT_AVAILABLE', 'The returned units are no longer in stock.', undefined,
      { productId: p.productId, onHand: pool.qty, needed: p.qty });
  }
  const removedCents = Math.min(p.restoredValueCents, pool.valueCents);
  let sweptCents = 0;
  if (pool.qty - p.qty === 0 && pool.valueCents - removedCents > 0) {
    sweptCents = pool.valueCents - removedCents;
    insertMovement(conn, {
      productId: p.productId, businessDate: p.businessDate, type: 'adjustment', qtyDelta: 0, valueDeltaCents: -sweptCents,
      unitCostCents: null, refTable: 'sales_returns', refId: p.returnId, reason: `Residual value swept (void of sales return #${p.returnId})`,
    });
  }
  insertMovement(conn, {
    productId: p.productId, businessDate: p.businessDate, type: 'sale_return', qtyDelta: -p.qty, valueDeltaCents: -removedCents,
    unitCostCents: mulDivRound(removedCents, 1, p.qty), refTable: 'sales_returns', refId: p.returnId,
    reason: `Void of sales return #${p.returnId}`,
  });
  return { removedCents, sweptCents };
}

/** R-VR 3 pre-check: every product must still have at least the returned units (summed over the return's resalable lines). */
function assertStockAvailable(conn: DatabaseSync, lines: SaleReturnItemRow[]): void {
  const needed = new Map<number, number>();
  for (const l of lines) needed.set(l.productId, (needed.get(l.productId) ?? 0) + l.qty);
  for (const [productId, qty] of needed) {
    const pool = getPool(conn, productId);
    if (pool.qty < qty) {
      throw new AppError(409, 'RETURN_STOCK_NOT_AVAILABLE',
        `This return cannot be voided: ${qty} unit(s) came back into stock but only ${pool.qty} are on hand now.`,
        undefined, { productId, onHand: pool.qty, needed: qty });
    }
  }
}

/**
 * Voids a sales return (R-VR). See the file header for the order of checks and writes.
 *
 * @param saleId   The sale the return belongs to (a return of another sale is 404).
 * @param returnId The return to void.
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID, 409 RETURN_NOT_NEWEST (`newerReturnId`),
 *   409 DAY_CLOSED / BACKDATE_BEFORE_CLOSED_DAY, 409 RETURN_STOCK_NOT_AVAILABLE (`productId`, `onHand`, `needed`).
 * @returns The voided return, the updated sale and the negative-cash warnings (R13, never blocking).
 */
export function voidSaleReturn(
  ctx: AppContext, saleId: number, returnId: number, body: { reason: string },
): { item: SaleReturn; sale: Sale; warnings: CashWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runSalesWrite(ctx, (conn) => {
    const sale = getSaleRow(conn, saleId);
    if (!sale) throw notFound('Sale');
    const ret = getSaleReturn(conn, returnId);
    if (!ret || ret.saleId !== saleId) throw notFound('Sales return');
    if (ret.status === 'void') throw alreadyVoid('return');

    const newer = newerPostedReturn(conn, returnId);
    if (newer) {
      throw new AppError(409, 'RETURN_NOT_NEWEST',
        `Return #${newer.id} was made after this one on the same item(s). Void return #${newer.id} first.`,
        undefined, { newerReturnId: newer.id });
    }
    assertDayOpen(conn, [sale.book], ret.businessDate); // R9 + closed-day ordering: judged on the RETURN's date

    const before = toSaleReturn(conn, ret);
    const resalable = listSaleReturnItems(conn, returnId).filter((l) => l.resalable);
    assertStockAvailable(conn, resalable);

    // 1. status (the database lowers returned_qty and voids the damaged-return loss row)
    markSaleReturnVoid(conn, returnId, reason);
    // 2. stock leaves again
    for (const l of resalable) {
      removeRestockedUnits(conn, {
        productId: l.productId, businessDate: ret.businessDate, qty: l.qty, restoredValueCents: l.cogsCents, returnId,
      });
    }
    // 3. the refund comes back (no entry existed for a zero refund)
    if (ret.refundCents > 0) {
      const original = findCashEntriesByRef(conn, 'sales_returns', returnId)
        .find((e) => e.reversesEntryId === null && e.type === REFUND_CASH_TYPE[sale.book]);
      if (!original) throw new Error(`Sales return #${returnId} has no refund entry to reverse`);
      reverseCash(conn, original, `Void of sales return #${returnId}`);
    }

    const after = toSaleReturn(conn, getSaleReturn(conn, returnId) as NonNullable<ReturnType<typeof getSaleReturn>>);
    logAudit(conn, 'sale_return', String(returnId), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return {
      item: after, sale: loadSale(conn, saleId),
      warnings: ret.refundCents > 0 ? negativeCashWarnings(conn, [sale.book]) : [],
    };
  });
}
