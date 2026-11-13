/**
 * repositories/daily-closings.repo.ts - SQL for `daily_closings` (migration 012): one row per cash book per date.
 *
 * Layer: repository (SQL only, no business rules). A day is CLOSED while `reopened_at IS NULL OR closed_at >
 * reopened_at` (R9); the same expression is the DAY_CLOSED backstop trigger on `cash_entries`. The only updates the
 * database allows are REOPEN (sets `reopened_at` and the reason) and RE-CLOSE (sets a newer `closed_at` and the new
 * figures). Timestamps are chosen here so that a re-close is always strictly later than the reopen (even within one
 * millisecond), because the "closed" test compares them.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CashBook } from './cash-entries.repo.ts';
import { SQL_NOW_UTC, numberOrNull } from './sql-helpers.ts';

type N = number | bigint;

/** The SQL condition "this daily_closings row is currently closed" (column prefix `d.` is not used: single table). */
export const CLOSED_SQL = '(reopened_at IS NULL OR closed_at > reopened_at)';

/** One daily closing row with its derived `isClosed`. */
export interface ClosingRow {
  id: number; book: CashBook; businessDate: string; postedAt: string; closedAt: string; reopenedAt: string | null;
  reopenReason: string | null; expectedCents: number; countedCents: number | null; overShortCents: number;
  cashCountId: number | null; isClosed: boolean;
}
interface Raw {
  id: N; book: CashBook; business_date: string; posted_at: string; closed_at: string; reopened_at: string | null;
  reopen_reason: string | null; expected_cents: N; counted_cents: N | null; over_short_cents: N; cash_count_id: N | null;
  is_closed: N;
}

const SELECT = `SELECT id, book, business_date, posted_at, closed_at, reopened_at, reopen_reason, expected_cents, counted_cents,
  over_short_cents, cash_count_id, ${CLOSED_SQL} AS is_closed FROM daily_closings`;

function map(r: Raw): ClosingRow {
  return {
    id: Number(r.id), book: r.book, businessDate: r.business_date, postedAt: r.posted_at, closedAt: r.closed_at,
    reopenedAt: r.reopened_at, reopenReason: r.reopen_reason, expectedCents: Number(r.expected_cents),
    countedCents: numberOrNull(r.counted_cents), overShortCents: Number(r.over_short_cents),
    cashCountId: numberOrNull(r.cash_count_id), isClosed: Number(r.is_closed) === 1,
  };
}

/** True when the book's day is closed right now. */
export function isDayClosed(conn: DatabaseSync, book: CashBook, date: string): boolean {
  const r = conn.prepare(`SELECT 1 AS x FROM daily_closings WHERE book = ? AND business_date = ? AND ${CLOSED_SQL}`)
    .get(book, date) as unknown as { x: N } | undefined;
  return r !== undefined;
}

/**
 * Closed-day ordering probe (R9 + section 8 ordering protection), ONE indexed query for one book:
 * `latest` = the latest business date currently closed on or after `date` (null when there is none) and `onDay` =
 * whether `date` itself is closed. `latest > date` means "a LATER day is closed"; `onDay` is the exact-day case.
 * (Equivalent to MAX(business_date) over the currently closed days restricted to `>= date`, because the maximum
 * of the whole set is >= date exactly when this restricted maximum exists.)
 */
export function closedDayProbe(conn: DatabaseSync, book: CashBook, date: string): { latest: string | null; onDay: boolean } {
  const r = conn.prepare(
    `SELECT MAX(business_date) AS latest, COALESCE(MAX(business_date = ?), 0) AS on_day
       FROM daily_closings WHERE book = ? AND business_date >= ? AND ${CLOSED_SQL}`,
  ).get(date, book, date) as unknown as { latest: string | null; on_day: N };
  return { latest: r.latest, onDay: Number(r.on_day) === 1 };
}

/** One closing by id, or undefined. */
export function getClosing(conn: DatabaseSync, id: number): ClosingRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The closing row of (book, date), or undefined. */
export function getClosingByDay(conn: DatabaseSync, book: CashBook, date: string): ClosingRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE book = ? AND business_date = ?`).get(book, date) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** First closing of a day; returns the new id. */
export function insertClosing(conn: DatabaseSync, c: {
  book: CashBook; businessDate: string; expectedCents: number; countedCents: number | null; overShortCents: number;
  cashCountId: number | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO daily_closings (book, business_date, expected_cents, counted_cents, over_short_cents, cash_count_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(c.book, c.businessDate, c.expectedCents, c.countedCents, c.overShortCents, c.cashCountId);
  return Number(res.lastInsertRowid);
}

/** Reopens a closed day. `reopened_at` = the DB clock, but never earlier than `closed_at` (so the day is surely open). */
export function reopenClosing(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE daily_closings SET reopened_at = max(${SQL_NOW_UTC}, closed_at), reopen_reason = ? WHERE id = ?`).run(reason, id);
}

/** Closes a reopened day again with its new figures; `closed_at` is strictly later than `reopened_at`. */
export function recloseClosing(conn: DatabaseSync, id: number, reopenedAt: string, c: {
  expectedCents: number; countedCents: number | null; overShortCents: number; cashCountId: number | null;
}): void {
  const now = new Date().toISOString();
  const minimum = new Date(Date.parse(reopenedAt) + 1).toISOString();
  const closedAt = now > minimum ? now : minimum;
  conn.prepare(
    `UPDATE daily_closings SET closed_at = ?, expected_cents = ?, counted_cents = ?, over_short_cents = ?, cash_count_id = ?
      WHERE id = ?`,
  ).run(closedAt, c.expectedCents, c.countedCents, c.overShortCents, c.cashCountId, id);
}

/** Closings (any state) newest date first, optionally filtered by book and date range. */
export function listClosings(conn: DatabaseSync, q: { book?: CashBook; from?: string; to?: string }): ClosingRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.book !== undefined) { where.push('book = ?'); params.push(q.book); }
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = conn.prepare(`${SELECT}${w} ORDER BY business_date DESC, id DESC`).all(...params) as unknown as Raw[];
  return rows.map(map);
}

/** The dates of a book that are closed right now inside the (optional) range, oldest first. */
export function closedDates(conn: DatabaseSync, book: CashBook, from?: string, to?: string): string[] {
  const where = ['book = ?', CLOSED_SQL];
  const params: SQLInputValue[] = [book];
  if (from !== undefined) { where.push('business_date >= ?'); params.push(from); }
  if (to !== undefined) { where.push('business_date <= ?'); params.push(to); }
  const rows = conn.prepare(`SELECT business_date FROM daily_closings WHERE ${where.join(' AND ')} ORDER BY business_date`)
    .all(...params) as unknown as Array<{ business_date: string }>;
  return rows.map((r) => r.business_date);
}

/** The latest date currently closed for a book, or null. */
export function lastClosedDate(conn: DatabaseSync, book: CashBook): string | null {
  const r = conn.prepare(`SELECT MAX(business_date) AS d FROM daily_closings WHERE book = ? AND ${CLOSED_SQL}`)
    .get(book) as unknown as { d: string | null };
  return r.d;
}
