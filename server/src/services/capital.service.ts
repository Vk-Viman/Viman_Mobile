/**
 * services/capital.service.ts - capital the owner puts into a book (Phase 9).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 8, 9, 10.2, 10.4, 12):
 *  - Sec 8/9  capital is cash IN (type `capital`) in the chosen book. It is the owner's own money going into the
 *             business, so it is NEVER revenue and NEVER profit.
 *  - 10.2     the Ice Cream book is divided into funds: the owner names the destination fund each time (required for Ice
 *             Cream, refused for the other books). The cash entry and its fund row are ONE transaction (10.7).
 *  - 10.4     money added to the Profit fund as capital is not profit-eligible (it is not a daily profit share).
 *  - R9       a closed day refuses a new entry. R-FD no future dates. Idempotent by `clientRef`. Audited with the
 *             business date and `backdated` flag.
 * Voiding a capital entry uses the existing `POST /capital-entries/:id/void` (`voidCapitalEntry`, shared with opening balances).
 */
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import { getCapitalByClientRef, insertCapital } from '../repositories/capital.repo.ts';
import { listCapitalEntries } from '../repositories/capital-list.repo.ts';
import type { RecordStatus } from '../repositories/expenses.repo.ts';
import { logAudit } from './audit.service.ts';
import { postCash } from './cash-posting.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { assertFundMatchesBook } from './fund-rules.ts';
import { getCapitalEntry } from './opening-balance.service.ts';
import type { CapitalEntry } from './opening-balance.service.ts';
import { runWrite } from './stock-common.ts';
import { NOTE_MAX_LENGTH, assertNoFieldErrors, checkBusinessDate, trimmed } from './validation.ts';
import type { Fields } from './validation.ts';

export type { CapitalEntry };
export { getCapitalEntry };

/** Request body of a capital entry. */
export interface CapitalCreate {
  businessDate: string; book: CashBook; fund?: IceFund; amountCents: number; note?: string; clientRef: string;
}

/**
 * Lists capital and/or opening-balance entries, newest first. `kind` defaults to every kind. `totals.amountCents` sums only
 * POSTED entries that match the filters.
 */
export function listCapital(ctx: AppContext, q: {
  kind?: 'capital' | 'opening_balance'; book?: CashBook; from?: string; to?: string; status?: RecordStatus; limit: number; offset: number;
}): { items: CapitalEntry[]; total: number; totals: { amountCents: number } } {
  const r = listCapitalEntries(ctx.database.conn, q);
  return { items: r.ids.map((id) => getCapitalEntry(ctx, id)), total: r.total, totals: { amountCents: r.amountCents } };
}

/**
 * Records capital: cash IN `capital` (+ the fund row for Ice Cream), audited, in one transaction. Idempotent by
 * `clientRef`: a repeat returns the saved entry with `created: false` (the same reference used for a different kind of
 * record, or another book, is 409 CLIENT_REF_CONFLICT).
 *
 * Validation order: fields -> fund rule -> R-FD -> clientRef repeat -> DAY_CLOSED.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUND_REQUIRED / FUND_NOT_ALLOWED / FUTURE_DATE_NOT_ALLOWED, 409 DAY_CLOSED / CLIENT_REF_CONFLICT.
 */
export function createCapital(ctx: AppContext, body: CapitalCreate): { item: CapitalEntry; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  assertFundMatchesBook(body.book, body.fund);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const fund = body.book === 'icecream' ? (body.fund as IceFund) : null;

  return runWrite(ctx, (conn) => {
    const existing = getCapitalByClientRef(conn, body.clientRef);
    if (existing) {
      if (existing.kind !== 'capital' || existing.book !== body.book) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different record.');
      }
      return { item: getCapitalEntry(ctx, existing.id), warnings: [], created: false };
    }

    assertDayOpen(conn, [body.book], body.businessDate); // R9
    const id = insertCapital(conn, {
      businessDate: body.businessDate, book: body.book, fund, kind: 'capital', amountCents: body.amountCents, note,
      clientRef: body.clientRef,
    });
    postCash(conn, {
      book: body.book, fund, businessDate: body.businessDate, type: 'capital', amountCents: body.amountCents,
      refTable: 'capital_entries', refId: id, fundKind: 'capital', note: note || null,
    });
    const item = getCapitalEntry(ctx, id);
    logAudit(conn, 'capital_entry', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, warnings: [], created: true }; // cash IN: nothing to warn about (R13)
  });
}
