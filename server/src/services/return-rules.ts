/**
 * services/return-rules.ts - rules shared by purchase returns and sales returns.
 *
 * Layer: service helper (pure functions, no database access). Business rules implemented here:
 *  - R-RD: a return may not be dated before the document it returns; the owner-approved message names the
 *          original date and the document kind ("sale" / "purchase").
 *  - C5 / C7: the money of a partly returned line is split proportionally, and the return that completes the
 *          line takes the exact remainder, so all returns of a line always add up to the line with no rounding gap.
 * Both `purchases.service.ts` and `sales-returns.service.ts` use these, so the two documents cannot drift apart.
 */
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';

/** The kind of document being returned; it appears in the R-RD message. */
export type ReturnedDocument = 'sale' | 'purchase';

/**
 * R-RD: 400 RETURN_BEFORE_ORIGINAL_DATE. The message is attached to the `businessDate` field and the original
 * date is also returned as `originalDate` in the error body, so the screen can limit its date picker.
 *
 * @param document     'sale' or 'purchase' (wording of the message).
 * @param originalDate The business date of the original document (YYYY-MM-DD).
 */
export function returnBeforeOriginalError(document: ReturnedDocument, originalDate: string): AppError {
  const message = `The return date cannot be earlier than the original ${document} date (${originalDate}). `
    + `Please select ${originalDate} or a later date (not after today).`;
  return new AppError(400, 'RETURN_BEFORE_ORIGINAL_DATE', message, { businessDate: message }, { originalDate });
}

/**
 * C5 / C7: the part of a line's money (revenue, cost or purchase value) that belongs to this return.
 *
 * Normal case: `mulDivRound(total, qty, itemQty)`, never more than what is still unreturned. The return that
 * brings the cumulative returned quantity up to the full line quantity takes EXACTLY the remainder instead, so
 * the pieces of a line always add up to the line total (e.g. 100000 over 3 units -> 33333 + 33333 + 33334).
 *
 * @param totalCents    The full amount of the line (all units).
 * @param qty           Units returned now.
 * @param itemQty       Units on the line.
 * @param returnedQty   Units returned by earlier returns.
 * @param returnedCents Amount already taken back by earlier returns.
 * @returns The amount, in cents, for this return.
 */
export function returnPortion(
  totalCents: number, qty: number, itemQty: number, returnedQty: number, returnedCents: number,
): number {
  const remaining = Math.max(0, totalCents - returnedCents);
  // Completing the line: take whatever is left, whatever rounding did before.
  if (returnedQty + qty === itemQty) return remaining;
  return Math.min(mulDivRound(totalCents, qty, itemQty), remaining);
}
