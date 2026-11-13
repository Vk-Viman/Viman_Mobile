/**
 * services/day-closing.ts - the ONE place that enforces "closed days refuse new entries" (R9) and the closed-day
 * ordering protection (BUSINESS_RULES section 8).
 *
 * Layer: service helper used by EVERY financial write service (purchases, sales, returns, stock losses, stocktakes,
 * goods drawings, opening stock, telecom, printing, expenses, opening balances, cash counts, transfers, capital, Ice
 * Cream records). A daily closing locks one cash book for one business date; edits to a closed day need a reopen
 * (audited) and are then made as reversal + new rows (R9, R1).
 *
 * How it is used (API_CONTRACTS "DAY_CLOSED enforcement" and "Approved-decisions contract" part A):
 *  - every create AND every void (and every return) calls `assertDayOpen(conn, books, date)` inside its transaction;
 *  - `books` = every cash book the write touches (purchases/sales -> the document's book; stock-only writes ->
 *    the book of each product involved; telecom -> telecom; printing -> shop; transfers -> both books);
 *  - `date` = the record's business date; a void's reversal copies that date, a return is judged on the return's date;
 *  - validation order: schema -> R-FD -> (returns: lookup, R-RD) -> closed-day checks -> other business rules.
 * The helper refuses two things: a date that IS closed (`DAY_CLOSED`) and a date EARLIER than the book's latest
 * closed day (`BACKDATE_BEFORE_CLOSED_DAY`, so a closed snapshot can never drift). The `trg_cash_entries_day_closed`
 * trigger (012, replaced by 016) and the Ice Cream record triggers (014, replaced by 016) are the database backstop;
 * `mapCashAbort` turns their aborts into the same 409s for a write that somehow skipped the service check.
 */
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../lib/errors.ts';
import type { CashBook } from '../repositories/cash-entries.repo.ts';
import { closedDayProbe } from '../repositories/daily-closings.repo.ts';
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
 * 409 BACKDATE_BEFORE_CLOSED_DAY: `businessDate` is earlier than `closedDate`, the latest closed day of the book.
 * Carries `error.book`, `error.closedDate` and `error.businessDate` (API contract wording).
 */
export function backdateBeforeClosedError(book: CashBook, closedDate: string, businessDate: string): AppError {
  return new AppError(409, 'BACKDATE_BEFORE_CLOSED_DAY',
    `A later day (${closedDate}) is already closed for the ${BOOK_LABEL[book]} cash book. Entries dated before it would change a closed day. Reopen that day first, or use a date after it.`,
    undefined, { book, closedDate, businessDate });
}

/**
 * R9 + closed-day ordering protection: refuses the write when, for ANY of the given books,
 *  - `date` is itself closed -> 409 DAY_CLOSED (code and message unchanged), or
 *  - a LATER day is currently closed (the book's latest closed day is after `date`) -> 409 BACKDATE_BEFORE_CLOSED_DAY
 *    naming that latest closed day.
 * A date after every closed day, or a book without closed days, passes; a reopened day no longer counts as closed.
 * Precedence: DAY_CLOSED of any touched book beats BACKDATE_BEFORE_CLOSED_DAY; within each kind the first book in
 * shop, telecom, icecream order is named. One indexed query per touched book.
 *
 * @param conn  The connection of the write's transaction (reads the live closing state).
 * @param books Every cash book the write touches (duplicates allowed).
 * @param date  The record's business date (the return's date for a return; a void passes the record's own date).
 * @throws AppError 409 DAY_CLOSED or BACKDATE_BEFORE_CLOSED_DAY.
 */
export function assertDayOpen(conn: DatabaseSync, books: Iterable<CashBook>, date: string): void {
  const touched = new Set(books);
  let backdate: AppError | undefined;
  for (const book of BOOKS) {
    if (!touched.has(book)) continue;
    const probe = closedDayProbe(conn, book, date);
    if (probe.onDay) throw dayClosedError(book, date);
    if (probe.latest !== null && backdate === undefined) backdate = backdateBeforeClosedError(book, probe.latest, date);
  }
  if (backdate) throw backdate;
}

/**
 * Only the exact-day half of {@link assertDayOpen}: refuses (DAY_CLOSED) when `date` itself is closed for a touched
 * book. For writes that move no money and change no balance (a zero-difference count and its void), which the
 * ordering protection deliberately lets through (section 8: closing without a cash entry stays allowed).
 */
export function assertDayNotClosed(conn: DatabaseSync, books: Iterable<CashBook>, date: string): void {
  const touched = new Set(books);
  for (const book of BOOKS) {
    if (touched.has(book) && closedDayProbe(conn, book, date).onDay) throw dayClosedError(book, date);
  }
}

/**
 * Safety net for database aborts that belong to this phase: `DAY_CLOSED` and `BACKDATE_BEFORE_CLOSED_DAY` (the cash
 * entry and Ice Cream record triggers, migrations 012/014/016) and `INVALID_BUSINESS_DATE` (the date-check follow-up
 * triggers). Throws the matching API error, otherwise returns. Called by every service's own abort mapper so a
 * missed service check still ends in a clean message, not a 500.
 */
export function mapCashAbort(err: unknown): void {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('DAY_CLOSED')) {
    throw new AppError(409, 'DAY_CLOSED',
      'That day is closed for the cash book. Reopen it first (it will be recorded in the audit log).');
  }
  if (msg.includes('BACKDATE_BEFORE_CLOSED_DAY')) {
    // A trigger message cannot carry the dates; the service check (which runs first) names them. Generic backstop.
    throw new AppError(409, 'BACKDATE_BEFORE_CLOSED_DAY',
      'A later day is already closed for the cash book. Entries dated before it would change a closed day. Reopen that day first, or use a date after it.');
  }
  if (msg.includes('INVALID_BUSINESS_DATE')) {
    throw validationError({ businessDate: 'Enter a valid date (YYYY-MM-DD).' });
  }
}
