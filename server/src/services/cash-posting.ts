/**
 * services/cash-posting.ts - writes a cash entry together with its Ice Cream fund row, and reverses both (R1, 10.7).
 *
 * Layer: service helper used by every Phase 8 write that moves cash outside the existing typed services (opening
 * balances, cash over/short; Phase 9 and 10 will reuse it). BUSINESS_RULES section 10.7: every fund movement writes,
 * in ONE database transaction, its business record, its fund-ledger row(s), its Ice Cream cash-book entry and an audit
 * entry. These helpers do the middle two steps so the invariant "sum of fund rows = sum of Ice Cream cash entries"
 * cannot be broken by forgetting one of them. Callers must already be inside `ctx.database.tx()`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { findCashEntriesByRef, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import type { CashBook, CashEntryRow, IceFund } from '../repositories/cash-entries.repo.ts';
import { findFundEntriesByRef, insertFundEntry } from '../repositories/icecream-funds.repo.ts';
import type { FundEntryKind } from '../repositories/icecream-funds.repo.ts';

/**
 * Appends one cash entry and, for the Ice Cream book, the matching fund row of the same signed amount.
 *
 * @param e.fund      Required for `icecream` (the CHECKs refuse an Ice Cream entry without a fund), null otherwise.
 * @param e.fundKind  Why the fund row exists (e.g. 'opening_balance', 'cash_over_short'); used only for Ice Cream.
 * @returns The id of the new cash entry.
 */
export function postCash(conn: DatabaseSync, e: {
  book: CashBook; fund: IceFund | null; businessDate: string; type: string; amountCents: number; refTable: string; refId: number;
  fundKind: FundEntryKind; note?: string | null;
}): number {
  const cashId = insertCashEntry(conn, {
    book: e.book, fund: e.fund, businessDate: e.businessDate, type: e.type, amountCents: e.amountCents,
    refTable: e.refTable, refId: e.refId, note: e.note ?? null,
  });
  if (e.book === 'icecream') {
    if (e.fund === null) throw new Error('An Ice Cream cash entry must name its fund');
    insertFundEntry(conn, {
      businessDate: e.businessDate, fund: e.fund, amountCents: e.amountCents, kind: e.fundKind, refTable: e.refTable,
      refId: e.refId, note: e.note ?? null,
    });
  }
  return cashId;
}

/**
 * Cancels one cash entry (R1, C6): a negated twin of the same type, book and fund, dated like the original (so the
 * correction lands in the same report period) and pointing back at it. For Ice Cream the fund row of the original is
 * cancelled by a `reversal` row of the opposite amount.
 *
 * @throws Error when the entry was already reversed (callers check the record's status first).
 */
export function reverseCash(conn: DatabaseSync, original: CashEntryRow, note: string): number {
  const twin = findCashEntriesByRef(conn, original.refTable ?? '', original.refId ?? -1)
    .some((e) => e.reversesEntryId === original.id);
  if (twin) throw new Error(`Cash entry #${original.id} was already reversed`);
  const reversalId = insertCashEntry(conn, {
    book: original.book, fund: original.fund, businessDate: original.businessDate, type: original.type,
    amountCents: -original.amountCents, refTable: original.refTable, refId: original.refId,
    reversesEntryId: original.id, note,
  });
  if (original.book === 'icecream' && original.refTable !== null && original.refId !== null) {
    const funds = findFundEntriesByRef(conn, original.refTable, original.refId);
    const mine = funds.find((f) => f.kind !== 'reversal' && f.fund === original.fund && f.amountCents === original.amountCents
      && !funds.some((r) => r.reversesEntryId === f.id));
    if (!mine) throw new Error(`Cash entry #${original.id} has no fund row to reverse`);
    insertFundEntry(conn, {
      businessDate: mine.businessDate, fund: mine.fund, amountCents: -mine.amountCents, kind: 'reversal',
      refTable: mine.refTable, refId: mine.refId, reversesEntryId: mine.id, note,
    });
  }
  return reversalId;
}
