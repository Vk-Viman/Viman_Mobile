/**
 * services/daily-closings.service.ts - closing and reopening a cash book's day (Phase 8, R9).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 8, 12; R9, R6):
 *  - Sec 8  a daily closing locks ONE cash book for ONE business date. Closing optionally includes the drawer count:
 *           when `countedCents` is given, the count and its over/short adjustment are posted FIRST (same rules as a
 *           cash count, C4), then the day is marked closed - so the closing's own adjustment is never blocked by itself.
 *           `expected` = the book's ledger balance as of the end of that date, BEFORE any adjustment.
 *  - R9     once closed, every financial write dated that day in that book is refused with `DAY_CLOSED` (see
 *           day-closing.ts) until the day is REOPENED. A reopen needs a reason (at least 3 characters), is audited, and
 *           later edits are made as reversal + new rows (R1); the day is then closed again (a re-close updates the same
 *           row with the new figures; the audit log keeps every close and reopen).
 *  - R-FD   a future date cannot be closed (reopening carries no business date and is never refused for it).
 *  - Idempotency: a day can only be closed once, so the natural key (book, date) protects against a double click:
 *           `409 DAY_ALREADY_CLOSED`. A retry that carries the `clientRef` of the count it already saved returns that
 *           closing with `created: false`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { cashBalanceAsOf } from '../repositories/cash-entries.repo.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import { getCashCountByClientRef } from '../repositories/cash-counts.repo.ts';
import {
  getClosing, getClosingByDay, insertClosing, isDayClosed, listClosings as listClosingRows, recloseClosing, reopenClosing,
} from '../repositories/daily-closings.repo.ts';
import type { ClosingRow } from '../repositories/daily-closings.repo.ts';
import { logAudit } from './audit.service.ts';
import { checkCountFund, postCashCount } from './cash-counts.service.ts';
import type { CashCount } from './cash-counts.service.ts';
import type { CashWarning } from './cash-warnings.ts';
import { BOOK_LABEL } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, assertNoFieldErrors, checkBusinessDate, isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** Shortest accepted reopen reason (after trimming). */
export const REOPEN_REASON_MIN = 3;
/** Longest accepted reopen reason. */
export const REOPEN_REASON_MAX = 200;

/** A daily closing as returned by the API. */
export interface DailyClosing {
  id: number; book: CashBook; businessDate: string; postedAt: string; closedAt: string; reopenedAt: string | null;
  reopenReason: string | null; expectedCents: number; countedCents: number | null; overShortCents: number;
  cashCountId: number | null; isClosed: boolean;
}

function toClosing(r: ClosingRow): DailyClosing {
  return {
    id: r.id, book: r.book, businessDate: r.businessDate, postedAt: r.postedAt, closedAt: r.closedAt, reopenedAt: r.reopenedAt,
    reopenReason: r.reopenReason, expectedCents: r.expectedCents, countedCents: r.countedCents, overShortCents: r.overShortCents,
    cashCountId: r.cashCountId, isClosed: r.isClosed,
  };
}

function loadClosing(conn: DatabaseSync, id: number): DailyClosing {
  const r = getClosing(conn, id);
  if (!r) throw notFound('Daily closing');
  return toClosing(r);
}

/** Closings (open or closed), newest date first, with `isClosed` on each. */
export function listDailyClosings(ctx: AppContext, q: { book?: CashBook; from?: string; to?: string }): { items: DailyClosing[] } {
  return { items: listClosingRows(ctx.database.conn, q).map(toClosing) };
}

/** Whether the book's day is closed right now (the screen uses it to show the closed badge and disable forms). */
export function dayStatus(ctx: AppContext, book: CashBook, businessDate: string): { isClosed: boolean } {
  return { isClosed: isDayClosed(ctx.database.conn, book, businessDate) };
}

/** Request body of a closing. */
export interface DailyClosingCreate {
  book: CashBook; businessDate: string; countedCents?: number; fund?: IceFund; note?: string; clientRef: string;
}

/**
 * Closes the book's day (see the file header): optional count + adjustment first, then the closed row.
 *
 * Validation order: fields -> fund rule -> R-FD -> clientRef repeat -> DAY_ALREADY_CLOSED -> DAY_CLOSED (inside the
 * count, cannot fire here) -> NOTE_REQUIRED / FUND_REQUIRED (only when counted differs).
 *
 * @throws AppError 400 VALIDATION_ERROR / FUND_NOT_ALLOWED / FUND_REQUIRED / NOTE_REQUIRED / FUTURE_DATE_NOT_ALLOWED,
 *   409 DAY_ALREADY_CLOSED / CLIENT_REF_CONFLICT.
 * @returns The closing, the count it posted (null when no count was given) and the negative-cash warnings of a short.
 */
export function closeDay(ctx: AppContext, body: DailyClosingCreate): {
  item: DailyClosing; count: CashCount | null; warnings: CashWarning[]; created: boolean;
} {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkCountFund(body.book, body.fund);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  return runWrite(ctx, (conn) => {
    // A retry of a close that already saved its count returns that closing instead of an error.
    if (body.countedCents !== undefined) {
      const saved = getCashCountByClientRef(conn, body.clientRef);
      if (saved) {
        const closing = getClosingByDay(conn, saved.book, saved.businessDate);
        if (!closing || saved.book !== body.book || saved.businessDate !== body.businessDate || closing.cashCountId !== saved.id) {
          throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different record.');
        }
        return { item: toClosing(closing), count: null, warnings: [], created: false };
      }
    }
    const existing = getClosingByDay(conn, body.book, body.businessDate);
    if (existing?.isClosed) {
      throw new AppError(409, 'DAY_ALREADY_CLOSED',
        `That day is already closed for the ${BOOK_LABEL[body.book]} cash book.`, undefined,
        { book: body.book, businessDate: body.businessDate });
    }

    const expectedCents = cashBalanceAsOf(conn, body.book, body.businessDate); // before any adjustment
    let count: CashCount | null = null;
    let warnings: CashWarning[] = [];
    if (body.countedCents !== undefined) {
      const posted = postCashCount(conn, {
        businessDate: body.businessDate, book: body.book, countedCents: body.countedCents,
        ...(body.fund !== undefined ? { fund: body.fund } : {}), clientRef: body.clientRef,
      }, note);
      count = posted.item;
      warnings = posted.warnings;
    }
    const figures = {
      expectedCents, countedCents: count ? count.countedCents : null, overShortCents: count ? count.differenceCents : 0,
      cashCountId: count ? count.id : null,
    };
    let id: number;
    if (existing) {
      recloseClosing(conn, existing.id, existing.reopenedAt as string, figures); // R9: a reopened day is closed again
      id = existing.id;
    } else {
      id = insertClosing(conn, { book: body.book, businessDate: body.businessDate, ...figures });
    }
    const item = loadClosing(conn, id);
    logAudit(conn, 'daily_closing', String(id), 'close', existing ? toClosing(existing) : null, item, undefined,
      { businessDate: item.businessDate, backdated: isBackdatedToday(item.businessDate) });
    return { item, count, warnings, created: true };
  });
}

/**
 * Reopens a closed day (R9): from now on writes dated that day are accepted again. The reason is mandatory and the
 * reopen is audited with the day's business date. The day must be closed again afterwards.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason shorter than 3 characters), 404 NOT_FOUND, 409 DAY_NOT_CLOSED.
 */
export function reopenDay(ctx: AppContext, id: number, body: { reason: string }): DailyClosing {
  const reason = (body.reason ?? '').trim();
  if (reason.length < REOPEN_REASON_MIN || reason.length > REOPEN_REASON_MAX) {
    throw validationError({ reason: `Enter a reason of ${REOPEN_REASON_MIN} to ${REOPEN_REASON_MAX} characters.` });
  }
  return runWrite(ctx, (conn) => {
    const row = getClosing(conn, id);
    if (!row) throw notFound('Daily closing');
    if (!row.isClosed) {
      throw new AppError(409, 'DAY_NOT_CLOSED', `That day is not closed for the ${BOOK_LABEL[row.book]} cash book.`);
    }
    const before = toClosing(row);
    reopenClosing(conn, id, reason);
    const after = loadClosing(conn, id);
    logAudit(conn, 'daily_closing', String(id), 'reopen', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
