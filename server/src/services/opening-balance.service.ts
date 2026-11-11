/**
 * services/opening-balance.service.ts - the cash each book started with at go-live (Phase 8).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 0, 8, 9, 10.2):
 *  - Sec 0/8  go-live = opening stock + an opening balance per cash book. It is cash IN (type `opening_balance`) and
 *             never revenue or profit (sec 9; Ice Cream: never profit-eligible, 10.4).
 *  - Sec 10.2 the Ice Cream book is divided into funds: the owner names the destination fund each time, so Ice Cream
 *             can hold one opening balance per fund. The Ice Cream cash entry and its fund row are ONE transaction (10.7).
 *  - Design   at most one POSTED opening balance per book (per fund for Ice Cream); a wrong one is voided (R1) and
 *             entered again. `409 OPENING_BALANCE_EXISTS`.
 *  - R9       a closed day refuses create and void. R-FD: not future dated; backdating (the go-live date) is allowed
 *             and audited. Idempotent by `clientRef`. Audited with business date and `backdated`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { findCashEntriesByRef } from '../repositories/cash-entries.repo.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import {
  findPostedOpening, getCapital, getCapitalByClientRef, insertCapital, listCapital, markCapitalVoid,
} from '../repositories/capital.repo.ts';
import type { CapitalRow } from '../repositories/capital.repo.ts';
import type { RecordStatus } from '../repositories/expenses.repo.ts';
import { logAudit } from './audit.service.ts';
import { postCash, reverseCash } from './cash-posting.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { BOOK_LABEL, assertDayOpen } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday,
  notFound, trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** An opening balance / capital entry as returned by the API (adds the `backdated` flag). */
export interface CapitalEntry {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: CashBook; fund: IceFund | null;
  kind: 'opening_balance' | 'capital'; amountCents: number; note: string; status: RecordStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}

function toEntry(r: CapitalRow): CapitalEntry {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    book: r.book, fund: r.fund, kind: r.kind, amountCents: r.amountCents, note: r.note, status: r.status,
    voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadEntry(conn: DatabaseSync, id: number): CapitalEntry {
  const r = getCapital(conn, id);
  if (!r) throw notFound('Capital entry');
  return toEntry(r);
}

/**
 * The fund rule shared by every money write that can touch Ice Cream (10.2): the Ice Cream book REQUIRES a fund,
 * the other books FORBID one.
 *
 * @throws AppError 400 FUND_REQUIRED / FUND_NOT_ALLOWED (with `fields.fund`).
 */
export function checkFundForBook(book: CashBook, fund: IceFund | undefined): void {
  if (book === 'icecream' && fund === undefined) {
    throw new AppError(400, 'FUND_REQUIRED', 'Choose which Ice Cream fund this money belongs to (Cost, Electricity or Profit).',
      { fund: 'Choose a fund.' });
  }
  if (book !== 'icecream' && fund !== undefined) {
    throw new AppError(400, 'FUND_NOT_ALLOWED', 'Only the Ice Cream book has funds.', { fund: 'Funds exist only for the Ice Cream book.' });
  }
}

/** The opening balances of a book, oldest first (voided ones included, marked by `status`). */
export function listOpeningBalances(ctx: AppContext, book: CashBook): { items: CapitalEntry[] } {
  return { items: listCapital(ctx.database.conn, book, 'opening_balance').map(toEntry) };
}

/** One capital / opening-balance entry by id. @throws AppError 404 NOT_FOUND. */
export function getCapitalEntry(ctx: AppContext, id: number): CapitalEntry {
  return loadEntry(ctx.database.conn, id);
}

/** Request body of an opening balance. */
export interface OpeningBalanceCreate {
  businessDate: string; amountCents: number; fund?: IceFund; note?: string; clientRef: string;
}

/**
 * Records the opening balance of a cash book: cash IN `opening_balance` (+ the fund row for Ice Cream), audited, in one
 * transaction. Idempotent by `clientRef` (a repeat returns the saved entry with `created: false`; the same reference
 * used for another book is 409 CLIENT_REF_CONFLICT).
 *
 * Validation order: fields -> fund rule -> R-FD -> clientRef repeat -> DAY_CLOSED -> OPENING_BALANCE_EXISTS.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUND_REQUIRED / FUND_NOT_ALLOWED / FUTURE_DATE_NOT_ALLOWED, 409 DAY_CLOSED /
 *   OPENING_BALANCE_EXISTS / CLIENT_REF_CONFLICT.
 */
export function setOpeningBalance(
  ctx: AppContext, book: CashBook, body: OpeningBalanceCreate,
): { item: CapitalEntry; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkFundForBook(book, body.fund);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const fund = book === 'icecream' ? (body.fund as IceFund) : null;

  return runWrite(ctx, (conn) => {
    const existing = getCapitalByClientRef(conn, body.clientRef);
    if (existing) {
      if (existing.book !== book || existing.kind !== 'opening_balance') {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different record.');
      }
      return { item: toEntry(existing), warnings: [], created: false };
    }

    assertDayOpen(conn, [book], body.businessDate); // R9
    const already = findPostedOpening(conn, book, fund);
    if (already) {
      const where = fund === null ? `the ${BOOK_LABEL[book]} cash book` : `the Ice Cream ${fund} fund`;
      throw new AppError(409, 'OPENING_BALANCE_EXISTS',
        `An opening balance is already recorded for ${where} (dated ${already.businessDate}). Void it first if it was wrong.`,
        undefined, { existingId: already.id });
    }
    const id = insertCapital(conn, {
      businessDate: body.businessDate, book, fund, kind: 'opening_balance', amountCents: body.amountCents, note, clientRef: body.clientRef,
    });
    postCash(conn, {
      book, fund, businessDate: body.businessDate, type: 'opening_balance', amountCents: body.amountCents,
      refTable: 'capital_entries', refId: id, fundKind: 'opening_balance', note: note || null,
    });
    const item = loadEntry(conn, id);
    logAudit(conn, 'capital_entry', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, warnings: [], created: true }; // cash IN: nothing to warn about (R13)
  });
}

/**
 * Voids an opening balance / capital entry (R1): the cash-in is cancelled by a reversing entry (and, for Ice Cream, a
 * fund reversal row) dated like the original; the entry is marked `void`. A void takes cash out of the book, so it
 * may return the negative-cash warning (R13).
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID.
 */
export function voidCapitalEntry(ctx: AppContext, id: number, body: { reason: string }): { item: CapitalEntry; warnings: CashWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getCapital(conn, id);
    if (!row) throw notFound('Capital entry');
    assertDayOpen(conn, [row.book], row.businessDate); // R9: judged on the entry's own date
    if (row.status === 'void') throw alreadyVoid('entry');
    const before = toEntry(row);

    const original = findCashEntriesByRef(conn, 'capital_entries', id).find((e) => e.reversesEntryId === null);
    if (!original) throw new Error(`Capital entry #${id} has no cash entry to reverse`);
    reverseCash(conn, original, `Void of ${row.kind === 'opening_balance' ? 'opening balance' : 'capital'} #${id}`);
    markCapitalVoid(conn, id, reason);
    const after = loadEntry(conn, id);
    logAudit(conn, 'capital_entry', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return { item: after, warnings: negativeCashWarnings(conn, [row.book]) };
  });
}
