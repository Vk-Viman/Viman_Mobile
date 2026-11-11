/**
 * Names, labels and small pure helpers shared by the Cash Books screens (pages/cashbooks/*).
 * Display and input convenience only: the server calculates every figure (balances, running balances, expected, over/short).
 */
import type { CashBook, IceFund } from '../../types/cashbooks';

/** Owner-facing book names (the same words the server uses in its messages). */
export const CASHBOOK_LABEL: Record<CashBook, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };
/** The books in display order. */
export const CASHBOOKS: readonly CashBook[] = ['shop', 'telecom', 'icecream'];

/** Owner-facing fund names (BUSINESS_RULES section 10). */
export const FUND_LABEL: Record<IceFund, string> = { cost: 'Cost', electricity: 'Electricity', profit: 'Profit' };
/** The funds in display order. */
export const FUNDS: readonly IceFund[] = ['cost', 'electricity', 'profit'];

/** The default fund of a cash over/short (C4): Profit; the owner may choose another and it is audited. */
export const DEFAULT_OVER_SHORT_FUND: IceFund = 'profit';

/** Plain-English label of a cash ledger entry type (BUSINESS_RULES section 2). */
const ENTRY_LABEL: Record<string, string> = {
  sale_goods: 'Sale', sale_service: 'Service sale', sale_refund: 'Sale refund', card_sale: 'Card sale', card_refund: 'Card refund',
  reload_collection: 'Reload collection', ezcash_collection: 'EZCash collection', provider_topup: 'Provider top-up',
  wallet_topup: 'Wallet top-up', purchase_payment: 'Purchase payment', purchase_refund: 'Purchase refund', expense: 'Expense',
  expense_refund: 'Expense refund', icecream_sale: 'Ice cream sales', icecream_materials_payment: 'Materials payment',
  icecream_electricity_payment: 'Electricity bill', icecream_other_cost: 'Other cost', printing_supplies: 'Printing supplies',
  cash_adjustment: 'Cash over / short', opening_balance: 'Opening balance', capital: 'Capital', drawing_cash: 'Cash drawing',
  transfer_out: 'Transfer out', transfer_in: 'Transfer in',
};

/** Label for a ledger entry type; an unknown type is shown as written. */
export function entryLabel(type: string): string {
  return ENTRY_LABEL[type] ?? type;
}

/** The first day of the month of a `YYYY-MM-DD` date: "2026-11-11" -> "2026-11-01". */
export function monthStart(date: string): string {
  return `${date.slice(0, 8)}01`;
}

/**
 * Over/short preview of a count, for the form only (the server decides): difference = counted - expected (C4).
 * Positive = cash over (income), negative = cash short (cost), 0 = the drawer matches the books.
 */
export function countDifference(expectedCents: number, countedCents: number): number {
  return countedCents - expectedCents;
}
