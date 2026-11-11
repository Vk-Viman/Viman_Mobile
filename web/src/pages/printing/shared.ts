/**
 * Constants and small helpers shared by the Printing screens (print sales, service types, supplies).
 * Generic pieces live elsewhere: components/Pager.tsx, components/VoidRecordDialog.tsx, lib/errors.ts.
 */
import type { PrintWarning } from '../../types/printing';

/** Longest note / free-text field the server accepts (matches the server's limit). */
export const MAX_NOTE = 500;
/** Longest service name or supplies description the server accepts. */
export const MAX_NAME = 100;
/** Most pages in one sale (matches the server's limit). */
export const MAX_QTY = 1_000_000;
/** Largest price / standard cost per page in cents (Rs 10,000,000.00; matches the server's limit). */
export const MAX_UNIT_CENTS = 1_000_000_000;
/** Largest single supplies purchase in cents (matches the server's limit). */
export const MAX_SUPPLY_CENTS = 1_000_000_000_000;

/** Plain-English text of the advisory notices (R13) the server may return with a saved record. */
export const WARNING_TEXT: Record<PrintWarning, string> = {
  PRICE_BELOW_COST: 'The price is below the standard cost, so this sale makes a loss.',
  NEGATIVE_CASH_BALANCE: 'The Shop cash book is now below zero. Check that the opening balance and sales are recorded.',
};

/** Joins the texts of several warnings into one sentence block ('' when none). */
export function warningsText(warnings: PrintWarning[]): string {
  return warnings.map((w) => WARNING_TEXT[w]).join(' ');
}
