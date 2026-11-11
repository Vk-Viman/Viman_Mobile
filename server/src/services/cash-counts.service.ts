/**
 * services/cash-counts.service.ts - the owner counts the drawer; the difference becomes cash over/short (Phase 8).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 8, 10.2, C4, R6):
 *  - Sec 8    expected = the ledger balance of the book AS OF THE END of the count's business date (every cash entry
 *             dated on or before it; Ice Cream: the whole book, never one fund). difference = counted - expected (C4).
 *  - C4/R6    a non-zero difference REQUIRES a note (`NOTE_REQUIRED`) and posts ONE `cash_adjustment` cash entry of the
 *             signed difference dated the count's date: positive = cash over (income), negative = cash short (cost) in
 *             that book's segment. A zero difference posts no cash entry.
 *  - Sec 10.2 the Ice Cream book names the fund the over/short belongs to (`FUND_REQUIRED`, default shown by the screen:
 *             Profit); the matching `icecream_fund_entries` row (`cash_over_short`) is written in the same transaction.
 *             It never changes Charged/Settled/Unspent (those are derived from daily entries, payments and moves).
 *  - R9       a closed day of the book refuses create and void. R-FD: no future dates. Idempotent by `clientRef`.
 *  - R1       a void reverses the adjustment (cash + fund row) and marks the count `void`. R13: a short may leave the
 *             book or a fund negative: shared warning, never a block.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { cashBalanceAsOf, getCashEntry } from '../repositories/cash-entries.repo.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import {
  getCashCount, getCashCountByClientRef, insertCashCount, linkCashEntry, listCashCounts as listCashCountRows, markCashCountVoid,
} from '../repositories/cash-counts.repo.ts';
import type { CashCountRow } from '../repositories/cash-counts.repo.ts';
import type { RecordStatus } from '../repositories/expenses.repo.ts';
import { logAudit } from './audit.service.ts';
import { postCash, reverseCash } from './cash-posting.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday,
  notFound, trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** A cash count as returned by the API (adds the `backdated` flag). */
export interface CashCount {
  id: number; book: CashBook; fund: IceFund | null; businessDate: string; postedAt: string; backdated: boolean;
  expectedCents: number; countedCents: number; differenceCents: number; note: string; status: RecordStatus;
  voidedAt: string | null; voidReason: string | null; cashEntryId: number | null; clientRef: string;
}

function toCount(r: CashCountRow): CashCount {
  return {
    id: r.id, book: r.book, fund: r.fund, businessDate: r.businessDate, postedAt: r.postedAt,
    backdated: isBackdated(r.businessDate, r.postedAt), expectedCents: r.expectedCents, countedCents: r.countedCents,
    differenceCents: r.differenceCents, note: r.note, status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason,
    cashEntryId: r.cashEntryId, clientRef: r.clientRef,
  };
}

function loadCount(conn: DatabaseSync, id: number): CashCount {
  const r = getCashCount(conn, id);
  if (!r) throw notFound('Cash count');
  return toCount(r);
}

/**
 * The balance the drawer SHOULD hold at the end of `date`: every cash entry of the book dated on or before it (sec 8).
 * Read-only; also used by the screen to show the expected amount before the owner types the counted one.
 */
export function expectedCashAsOf(ctx: AppContext, book: CashBook, date: string): { expectedCents: number } {
  return { expectedCents: cashBalanceAsOf(ctx.database.conn, book, date) };
}

/** One count by id. @throws AppError 404 NOT_FOUND. */
export function getCashCountById(ctx: AppContext, id: number): CashCount {
  return loadCount(ctx.database.conn, id);
}

/** Lists counts, newest business date first. */
export function listCashCounts(ctx: AppContext, q: {
  book?: CashBook; from?: string; to?: string; status?: RecordStatus; limit: number; offset: number;
}): { items: CashCount[]; total: number } {
  const r = listCashCountRows(ctx.database.conn, q);
  return { items: r.items.map(toCount), total: r.total };
}

/** What a count needs from the caller (the route body, or the closing that includes a count). */
export interface CashCountInput {
  businessDate: string; book: CashBook; countedCents: number; fund?: IceFund; note?: string; clientRef: string;
}

/**
 * The request-level checks of a count that need no database: a fund may only be named for the Ice Cream book.
 * @throws AppError 400 FUND_NOT_ALLOWED.
 */
export function checkCountFund(book: CashBook, fund: IceFund | undefined): void {
  if (book !== 'icecream' && fund !== undefined) {
    throw new AppError(400, 'FUND_NOT_ALLOWED', 'Only the Ice Cream book has funds.', { fund: 'Funds exist only for the Ice Cream book.' });
  }
}

/**
 * Posts a count INSIDE the caller's transaction: R9 check, expected-as-of-date, difference, the adjustment cash entry
 * (+ fund row for Ice Cream) and the audit row. The caller handles idempotency (`clientRef` repeats) and R-FD.
 * Shared by `createCashCount` and the daily closing (which counts, then closes).
 *
 * @throws AppError 409 DAY_CLOSED, 400 NOTE_REQUIRED / FUND_REQUIRED.
 */
export function postCashCount(conn: DatabaseSync, body: CashCountInput, note: string): { item: CashCount; warnings: CashWarning[] } {
  assertDayOpen(conn, [body.book], body.businessDate); // R9
  const expectedCents = cashBalanceAsOf(conn, body.book, body.businessDate);
  const differenceCents = body.countedCents - expectedCents; // C4: counted - expected
  if (differenceCents !== 0) {
    if (note.length === 0) {
      throw new AppError(400, 'NOTE_REQUIRED', 'The count does not match the books. Please write a note to explain the difference.',
        { note: 'A note is required when the count differs from the books.' });
    }
    if (body.book === 'icecream' && body.fund === undefined) {
      throw new AppError(400, 'FUND_REQUIRED', 'Choose which Ice Cream fund the over/short belongs to (Cost, Electricity or Profit).',
        { fund: 'Choose a fund.' });
    }
  }
  const fund = body.book === 'icecream' && differenceCents !== 0 ? (body.fund as IceFund) : null;
  const id = insertCashCount(conn, {
    book: body.book, fund, businessDate: body.businessDate, expectedCents, countedCents: body.countedCents, differenceCents,
    note, clientRef: body.clientRef,
  });
  let touched = false;
  if (differenceCents !== 0) {
    const entryId = postCash(conn, {
      book: body.book, fund, businessDate: body.businessDate, type: 'cash_adjustment', amountCents: differenceCents,
      refTable: 'cash_counts', refId: id, fundKind: 'cash_over_short', note: `Cash count #${id}: ${note}`,
    });
    linkCashEntry(conn, id, entryId);
    touched = true;
  }
  const item = loadCount(conn, id);
  logAudit(conn, 'cash_count', String(id), 'create', null, item, undefined,
    { businessDate: item.businessDate, backdated: item.backdated });
  // R13: only a SHORT takes cash out; an over (or an exact count) can never newly push a book negative.
  return { item, warnings: touched && differenceCents < 0 ? negativeCashWarnings(conn, [body.book]) : [] };
}

/**
 * Records a cash count (see the file header). Idempotent by `clientRef`: a repeat returns the saved count with
 * `created: false`; the same reference used for another book or date is 409 CLIENT_REF_CONFLICT.
 *
 * Validation order: fields -> fund rule -> R-FD -> clientRef repeat -> DAY_CLOSED -> NOTE_REQUIRED / FUND_REQUIRED.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUND_NOT_ALLOWED / FUND_REQUIRED / NOTE_REQUIRED / FUTURE_DATE_NOT_ALLOWED,
 *   409 DAY_CLOSED / CLIENT_REF_CONFLICT.
 */
export function createCashCount(ctx: AppContext, body: CashCountInput): { item: CashCount; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkCountFund(body.book, body.fund);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  return runWrite(ctx, (conn) => {
    const existing = getCashCountByClientRef(conn, body.clientRef);
    if (existing) {
      if (existing.book !== body.book || existing.businessDate !== body.businessDate) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different count.');
      }
      return { item: toCount(existing), warnings: [], created: false };
    }
    return { ...postCashCount(conn, body, note), created: true };
  });
}

/**
 * Voids a count (R1): its adjustment (if any) is cancelled by a reversing cash entry dated like the count (and an Ice
 * Cream fund reversal row) and the count is marked `void`. Reversing an "over" takes cash out, so the shared negative-cash
 * warning may come back.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID.
 */
export function voidCashCount(ctx: AppContext, id: number, body: { reason: string }): { item: CashCount; warnings: CashWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getCashCount(conn, id);
    if (!row) throw notFound('Cash count');
    assertDayOpen(conn, [row.book], row.businessDate); // R9: judged on the count's own date
    if (row.status === 'void') throw alreadyVoid('cash count');
    const before = toCount(row);

    if (row.cashEntryId !== null) {
      const original = getCashEntry(conn, row.cashEntryId);
      if (!original) throw new Error(`Cash count #${id} points at a missing cash entry`);
      reverseCash(conn, original, `Void of cash count #${id}`);
    }
    markCashCountVoid(conn, id, reason);
    const after = loadCount(conn, id);
    logAudit(conn, 'cash_count', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return { item: after, warnings: row.cashEntryId !== null ? negativeCashWarnings(conn, [row.book]) : [] };
  });
}
