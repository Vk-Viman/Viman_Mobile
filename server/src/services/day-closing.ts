/**
 * services/day-closing.ts - the ONE place that enforces "closed days refuse new entries" (R9).
 *
 * Layer: service helper used by EVERY financial write service (purchases, sales, returns, stock losses, stocktakes,
 * goods drawings, opening stock, telecom, printing, expenses, opening balances, cash counts). BUSINESS_RULES
 * section 8: a daily closing locks one cash book for one business date; edits to a closed day need a reopen
 * (audited) and are then made as reversal + new rows (R9, R1).
 *
 * How it is used (API_CONTRACTS "DAY_CLOSED enforcement"):
 *  - every create AND every void (and every return) calls `assertDayOpen(conn, books, date)` inside its transaction;
 *  - `books` = every cash book the write touches (purchases/sales -> the document's book; stock-only writes ->
 *    the book of each product involved; telecom -> telecom; printing -> shop);
 *  - `date` = the record's business date; a void's reversal copies that date, a return is judged on the return's date;
 *  - validation order: schema -> R-FD -> (returns: lookup, R-RD) -> DAY_CLOSED -> other business rules.
 * The `trg_cash_entries_day_closed` trigger (migration 012) is the database backstop; `mapCashAbort` turns its
 * abort into the same 409 for a write that somehow skipped the service check.
 */
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../lib/errors.ts';
import type { CashBook } from '../repositories/cash-entries.repo.ts';
import { isDayClosed } from '../repositories/daily-closings.repo.ts';
import { validationError } from './validation.ts';

/** Owner-facing book names. */
export const BOOK_LABEL: Record<CashBook, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };

/** The three books in their display order (also the order in which a multi-book write reports the first closed one). */
export const BOOKS: readonly CashBook[] = ['shop', 'telecom', 'icecream'];

/** 409 DAY_CLOSED for one book and date, with `error.book` and `error.businessDate` (API contract wording). */
export function dayClosedError(book: CashBook, businessDate: string): AppError {
  return new AppError(409, 'DAY_CLOSED',
    `That day is closed for the ${BOOK_LABEL[book]} cash book. Reopen it first (it will be recorded in the audit log).`,
    undefined, { book, businessDate });
}

/**
 * R9: refuses the write when `date` is closed for ANY of the given books.
 *
 * @param conn  The connection of the write's transaction (reads the live closing state).
 * @param books Every cash book the write touches (duplicates allowed).
 * @param date  The record's business date (the return's date for a return).
 * @throws AppError 409 DAY_CLOSED naming the first closed book (shop, telecom, icecream order).
 */
export function assertDayOpen(conn: DatabaseSync, books: Iterable<CashBook>, date: string): void {
  const touched = new Set(books);
  for (const book of BOOKS) {
    if (touched.has(book) && isDayClosed(conn, book, date)) throw dayClosedError(book, date);
  }
}

/**
 * Safety net for database aborts that belong to this phase: `DAY_CLOSED` (the cash entry trigger) and
 * `INVALID_BUSINESS_DATE` (the date-check follow-up triggers). Throws the matching API error, otherwise returns.
 * Called by every service's own abort mapper so a missed service check still ends in a clean message, not a 500.
 */
export function mapCashAbort(err: unknown): void {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('DAY_CLOSED')) {
    throw new AppError(409, 'DAY_CLOSED',
      'That day is closed for the cash book. Reopen it first (it will be recorded in the audit log).');
  }
  if (msg.includes('INVALID_BUSINESS_DATE')) {
    throw validationError({ businessDate: 'Enter a valid date (YYYY-MM-DD).' });
  }
}
