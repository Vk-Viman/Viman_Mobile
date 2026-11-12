/**
 * services/cash-transfers.service.ts - cash transfers between the three books (Phase 9).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 8, 9, 10.2, 10.7, 12):
 *  - Sec 8   a transfer moves cash from one book to another: ONE `cash_transfers` record and TWO ledger rows that share
 *            its id in `cash_entries.transfer_id` - `transfer_out` (-amount, source book) and `transfer_in` (+amount,
 *            destination book). Both rows are written in one transaction, so the two books can never disagree.
 *  - Sec 9   a transfer is never revenue, cost or profit. It touches no P&L table at all.
 *  - 10.2    the Ice Cream side of a transfer names its fund (`fromFund` / `toFund`); the other books never have one.
 *  - 10.7    an Ice Cream leg writes its fund row in the same transaction (kinds `transfer_out` / `transfer_in`), so
 *            "sum of fund rows = sum of Ice Cream cash entries" always holds. Money that arrives in the Profit fund by
 *            transfer is NOT profit-eligible (10.4): a transfer never changes recognized profit.
 *  - R9      BOTH books must have the date open, for create and for void.
 *  - R13     a transfer that leaves the source book (or fund) below zero is saved with a warning, never blocked.
 *  - R-FD, Sec 12  no future dates; idempotent by `clientRef`; every write is audited with its business date and
 *            `backdated` flag.
 *  - R1      a void adds a reversing row for each leg (same book, fund and business date) and marks the transfer `void`.
 *
 * WHY the legs are written here and not with `postCash` / `reverseCash`: the ledger is append-only, so the shared
 * `transfer_id` can only be given when a row is inserted, and `postCash` has no such parameter (and Phase 9 may not
 * change it). The fund row is still written with the shared `insertFundEntry`, in the same way `postCash` does.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { findCashEntriesByRef } from '../repositories/cash-entries.repo.ts';
import type { CashBook, CashEntryRow, IceFund } from '../repositories/cash-entries.repo.ts';
import {
  getTransfer as getTransferRow, getTransferByClientRef, insertTransfer, insertTransferLeg, listTransfers as listTransferRows,
  markTransferVoid,
} from '../repositories/cash-transfers.repo.ts';
import type { TransferRow } from '../repositories/cash-transfers.repo.ts';
import type { RecordStatus } from '../repositories/expenses.repo.ts';
import { findFundEntriesByRef, insertFundEntry } from '../repositories/icecream-funds.repo.ts';
import { logAudit } from './audit.service.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { assertFundMatchesBook } from './fund-rules.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday,
  notFound, trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** A transfer as returned by the API (adds the `backdated` flag). */
export interface Transfer {
  id: number; businessDate: string; postedAt: string; backdated: boolean; fromBook: CashBook; toBook: CashBook;
  fromFund: IceFund | null; toFund: IceFund | null; amountCents: number; note: string; status: RecordStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}

function toTransfer(r: TransferRow): Transfer {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    fromBook: r.fromBook, toBook: r.toBook, fromFund: r.fromFund, toFund: r.toFund, amountCents: r.amountCents, note: r.note,
    status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadTransfer(conn: DatabaseSync, id: number): Transfer {
  const r = getTransferRow(conn, id);
  if (!r) throw notFound('Transfer');
  return toTransfer(r);
}

/** One transfer by id. @throws AppError 404 NOT_FOUND. */
export function getTransfer(ctx: AppContext, id: number): Transfer {
  return loadTransfer(ctx.database.conn, id);
}

/**
 * Lists transfers, newest first. `book` matches EITHER side. `totals.amountCents` sums only POSTED transfers that match
 * the filters (a voided transfer is listed, greyed out, but not counted).
 */
export function listTransfers(ctx: AppContext, q: {
  from?: string; to?: string; book?: CashBook; status?: RecordStatus; limit: number; offset: number;
}): { items: Transfer[]; total: number; totals: { amountCents: number } } {
  const r = listTransferRows(ctx.database.conn, q);
  return { items: r.items.map(toTransfer), total: r.total, totals: { amountCents: r.amountCents } };
}

/** Request body of a transfer. */
export interface TransferCreate {
  businessDate: string; fromBook: CashBook; toBook: CashBook; fromFund?: IceFund; toFund?: IceFund; amountCents: number;
  note?: string; clientRef: string;
}

/**
 * Writes one ledger leg and, for the Ice Cream book, its fund row (10.7). `amountCents` is signed.
 * @returns The new cash entry id.
 */
function postLeg(conn: DatabaseSync, e: {
  transferId: number; book: CashBook; fund: IceFund | null; businessDate: string; type: 'transfer_out' | 'transfer_in';
  amountCents: number;
}): number {
  const id = insertTransferLeg(conn, e);
  if (e.book === 'icecream') {
    if (e.fund === null) throw new Error('An Ice Cream transfer leg must name its fund');
    insertFundEntry(conn, {
      businessDate: e.businessDate, fund: e.fund, amountCents: e.amountCents, kind: e.type, refTable: 'cash_transfers',
      refId: e.transferId,
    });
  }
  return id;
}

/**
 * Cancels one posted leg (R1): a negated twin with the same type, book, fund and business date that points back at it and
 * keeps the transfer link; for Ice Cream the fund row is cancelled by a `reversal` row (same rule as `reverseCash`).
 */
function reverseLeg(conn: DatabaseSync, original: CashEntryRow, note: string): void {
  if (original.transferId === null) throw new Error(`Cash entry #${original.id} is not a transfer leg`);
  insertTransferLeg(conn, {
    transferId: original.transferId, book: original.book, fund: original.fund, businessDate: original.businessDate,
    type: original.type as 'transfer_out' | 'transfer_in', amountCents: -original.amountCents, reversesEntryId: original.id, note,
  });
  if (original.book !== 'icecream') return;
  const funds = findFundEntriesByRef(conn, 'cash_transfers', original.transferId);
  const mine = funds.find((f) => f.kind !== 'reversal' && f.fund === original.fund && f.amountCents === original.amountCents
    && !funds.some((r) => r.reversesEntryId === f.id));
  if (!mine) throw new Error(`Cash entry #${original.id} has no fund row to reverse`);
  insertFundEntry(conn, {
    businessDate: mine.businessDate, fund: mine.fund, amountCents: -mine.amountCents, kind: 'reversal', refTable: 'cash_transfers',
    refId: original.transferId, reversesEntryId: mine.id, note,
  });
}

/**
 * Records a transfer: `transfer_out` from the source book/fund and `transfer_in` into the destination, audited, in one
 * transaction. Idempotent by `clientRef`: a repeat returns the saved transfer with `created: false` and no warnings.
 *
 * Validation order: fields -> SAME_BOOK -> fund rules (from, then to) -> R-FD -> clientRef repeat -> DAY_CLOSED on both books.
 * Warnings (R13): the SOURCE book - and its fund - when it is now below zero. Receiving cash can only lift a balance.
 *
 * @throws AppError 400 VALIDATION_ERROR / SAME_BOOK / FUND_REQUIRED / FUND_NOT_ALLOWED / FUTURE_DATE_NOT_ALLOWED,
 *   409 DAY_CLOSED (either book).
 */
export function createTransfer(ctx: AppContext, body: TransferCreate): { item: Transfer; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  if (body.fromBook === body.toBook) {
    throw new AppError(400, 'SAME_BOOK', 'Choose two different books. Money is moved from one book to another.',
      { toBook: 'Choose a different book from the one the money comes from.' });
  }
  assertFundMatchesBook(body.fromBook, body.fromFund, 'fromFund');
  assertFundMatchesBook(body.toBook, body.toFund, 'toFund');
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const fromFund = body.fromBook === 'icecream' ? (body.fromFund as IceFund) : null;
  const toFund = body.toBook === 'icecream' ? (body.toFund as IceFund) : null;

  return runWrite(ctx, (conn) => {
    const existing = getTransferByClientRef(conn, body.clientRef);
    if (existing) return { item: toTransfer(existing), warnings: [], created: false };

    assertDayOpen(conn, [body.fromBook, body.toBook], body.businessDate); // R9: both books
    const id = insertTransfer(conn, {
      businessDate: body.businessDate, fromBook: body.fromBook, toBook: body.toBook, fromFund, toFund,
      amountCents: body.amountCents, note, clientRef: body.clientRef,
    });
    postLeg(conn, {
      transferId: id, book: body.fromBook, fund: fromFund, businessDate: body.businessDate, type: 'transfer_out',
      amountCents: -body.amountCents,
    });
    postLeg(conn, {
      transferId: id, book: body.toBook, fund: toFund, businessDate: body.businessDate, type: 'transfer_in',
      amountCents: body.amountCents,
    });
    const item = loadTransfer(conn, id);
    logAudit(conn, 'cash_transfer', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, warnings: negativeCashWarnings(conn, [body.fromBook]), created: true }; // R13: warn, never block
  });
}

/**
 * Voids a transfer (R1): both legs are cancelled by reversing rows that keep the transfer's business date and the
 * transfer is marked `void`. Judged on the transfer's own date for BOTH books (R9). Returning the money takes cash out of
 * the destination book, so that book (and its fund) may return the negative-balance warning (R13).
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID.
 */
export function voidTransfer(ctx: AppContext, id: number, body: { reason: string }): { item: Transfer; warnings: CashWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getTransferRow(conn, id);
    if (!row) throw notFound('Transfer');
    assertDayOpen(conn, [row.fromBook, row.toBook], row.businessDate); // R9: the reversals copy the transfer's date
    if (row.status === 'void') throw alreadyVoid('transfer');
    const before = toTransfer(row);

    const originals = findCashEntriesByRef(conn, 'cash_transfers', id).filter((e) => e.reversesEntryId === null);
    if (originals.length !== 2) throw new Error(`Transfer #${id} has ${originals.length} ledger rows, expected 2`);
    for (const original of originals) reverseLeg(conn, original, `Void of transfer #${id}`);
    markTransferVoid(conn, id, reason);
    const after = loadTransfer(conn, id);
    logAudit(conn, 'cash_transfer', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return { item: after, warnings: negativeCashWarnings(conn, [row.toBook]) };
  });
}
