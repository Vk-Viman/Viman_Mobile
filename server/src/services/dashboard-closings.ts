/**
 * services/dashboard-closings.ts - the dashboard's "daily closings" block: last closed date and days not yet closed.
 *
 * Layer: dashboard helper (read-only SQL on `daily_closings` and `cash_entries`; no writes, no audit rows).
 * BUSINESS_RULES section 8 / R9: a day is closed per cash book; a closing that was reopened and not closed again is NOT closed
 * (`CLOSED_SQL`, the same expression every other closing query uses).
 *
 * Decisions (the contract says "dates up to 7 days back not yet closed"):
 *  - The window is the 7 days BEFORE the dashboard date (asOf-7 .. asOf-1). The dashboard day itself is still in progress, so it is
 *    never listed as "behind".
 *  - A day before the book's first ever cash entry is not listed: the book did not exist yet, so there was nothing to close
 *    (a brand-new shop must not open to a list of "unclosed" days).
 *  - `lastClosedByBook` is the latest closed date on or before the dashboard date (so a past dashboard date shows what was true then).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CashBook } from '../repositories/cash-entries.repo.ts';
import { CLOSED_SQL, closedDates } from '../repositories/daily-closings.repo.ts';
import { addDays } from './dashboard-dates.ts';
import { BOOKS } from './day-closing.ts';

/** Days back that count as "behind" (the contract's seven). */
export const OPEN_DAYS_WINDOW = 7;

/** The closings block of the dashboard. */
export interface ClosingsBlock {
  lastClosedByBook: Record<CashBook, string | null>;
  /** One entry per book (always all three, in book order); `dates` is oldest first and empty when the book is up to date. */
  openDaysBehind: Array<{ book: CashBook; dates: string[] }>;
}

function lastClosedOnOrBefore(conn: DatabaseSync, book: CashBook, asOf: string): string | null {
  const r = conn.prepare(`SELECT MAX(business_date) AS d FROM daily_closings WHERE book = ? AND ${CLOSED_SQL} AND business_date <= ?`)
    .get(book, asOf) as unknown as { d: string | null };
  return r.d;
}

function firstActivity(conn: DatabaseSync, book: CashBook): string | null {
  const r = conn.prepare('SELECT MIN(business_date) AS d FROM cash_entries WHERE book = ?').get(book) as unknown as { d: string | null };
  return r.d;
}

/** Builds the closings block for `asOf`. */
export function closingsBlock(conn: DatabaseSync, asOf: string): ClosingsBlock {
  const lastClosedByBook = { shop: null, telecom: null, icecream: null } as Record<CashBook, string | null>;
  const openDaysBehind: ClosingsBlock['openDaysBehind'] = [];
  const windowFrom = addDays(asOf, -OPEN_DAYS_WINDOW);
  const windowTo = addDays(asOf, -1);
  for (const book of BOOKS) {
    lastClosedByBook[book] = lastClosedOnOrBefore(conn, book, asOf);
    const first = firstActivity(conn, book);
    const dates: string[] = [];
    if (first !== null) {
      const closed = new Set(closedDates(conn, book, windowFrom, windowTo));
      for (let d = windowFrom < first ? first : windowFrom; d <= windowTo; d = addDays(d, 1)) if (!closed.has(d)) dates.push(d);
    }
    openDaysBehind.push({ book, dates });
  }
  return { lastClosedByBook, openDaysBehind };
}
