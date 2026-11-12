/**
 * services/icecream-days.service.ts - the Ice Cream daily entry: create, void, void-and-replace, read (Phase 10).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 10, 12):
 *  - 10.2  a daily entry of sales S, cost allocation C and electricity allocation E allocates Cost +C, Electricity +E and
 *          Profit +(S - C - E). It writes ONE `icecream_sale` cash entry per non-zero fund share (each naming exactly one
 *          fund, so the three always sum to S), each with its fund-ledger row (kind `daily_allocation`, via `postCash`).
 *  - 10.3  recognized profit grows by the day's profit share; a NEGATIVE share needs `confirmNegativeProfit: true`
 *          (`422 NEGATIVE_PROFIT_UNCONFIRMED`). The server computes the share; the client never sends it.
 *  - D2    voiding a daily entry - and replacing it, judged on the FINAL state - is blocked (`422 VOID_BREAKS_RELEASE`)
 *          when profit already released depends on it (10.4).
 *  - C9    an entry is edited by void-and-replace (PUT): the old entry's cash and fund rows are reversed (R1), the new
 *          ones are written, in one transaction. One POSTED entry per business date (`409 DAY_EXISTS`).
 *  - R9    a closed Ice Cream day refuses create, replace and void. R-FD: no future dates (also for the replacement, which
 *          carries the date of the entry it replaces); backdating is allowed and audited (section 12).
 *  - 10.7  business record + cash entries + fund rows + audit row are ONE transaction; idempotent by `clientRef`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { isIsoDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { formatLKR } from '../lib/money.ts';
import { findCashEntriesByRef } from '../repositories/cash-entries.repo.ts';
import type { IceFund } from '../repositories/cash-entries.repo.ts';
import {
  getDay, getDayByClientRef, getPostedDayByDate, insertDay, insertDayItems, listDayItems, listDays as listDayRows, loadFacts,
  markDayVoid,
} from '../repositories/icecream.repo.ts';
import type { DayItemRow, DayRow, IceStatus } from '../repositories/icecream.repo.ts';
import { logAudit } from './audit.service.ts';
import { postCash, reverseCash } from './cash-posting.ts';
import { assertDayOpen } from './day-closing.ts';
import { voidGuard, standing, withReplacedDay, withoutDay } from './icecream-rules.ts';
import { MAX_CENTS, writeExtras } from './icecream.service.ts';
import type { FundsSummary, IceWarning } from './icecream.service.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday, notFound, trimmed,
  validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** Longest item name on a daily entry line. */
export const ITEM_NAME_MAX_LENGTH = 100;

/** One item line as returned by the API. */
export interface IceDayItem { id: number; itemName: string; qty: number; unitPriceCents: number; lineTotalCents: number }

/** A daily entry as returned by the API (adds `backdated` and the item lines). */
export interface IceDay {
  id: number; businessDate: string; postedAt: string; backdated: boolean; salesCents: number; costAllocCents: number;
  electricityAllocCents: number; profitShareCents: number; negativeConfirmed: boolean; notes: string; status: IceStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string; items: IceDayItem[];
}

function toItem(r: DayItemRow): IceDayItem {
  return { id: r.id, itemName: r.itemName, qty: r.qty, unitPriceCents: r.unitPriceCents, lineTotalCents: r.lineTotalCents };
}

function toDay(r: DayRow, items: DayItemRow[]): IceDay {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    salesCents: r.salesCents, costAllocCents: r.costAllocCents, electricityAllocCents: r.electricityAllocCents,
    profitShareCents: r.profitShareCents, negativeConfirmed: r.negativeConfirmed, notes: r.notes, status: r.status,
    voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef, items: items.map(toItem),
  };
}

function loadDay(conn: DatabaseSync, id: number): IceDay {
  const r = getDay(conn, id);
  if (!r) throw notFound('Daily entry');
  return toDay(r, listDayItems(conn, id));
}

/** The 422 of the D2 guard (10.4), worded for the record being voided or replaced. */
export function voidBreaksRelease(noun: string): AppError {
  return new AppError(422, 'VOID_BREAKS_RELEASE',
    `Profit already released depends on this ${noun} — reverse the release first.`);
}

/** Request body of an item line. */
export interface IceDayItemInput { itemName: string; qty: number; unitPriceCents: number }

/** The editable fields of a daily entry (the same for create and replace). */
export interface IceDayInput {
  salesCents: number; costAllocCents: number; electricityAllocCents: number; items?: IceDayItemInput[];
  confirmNegativeProfit?: boolean; notes?: string; clientRef: string;
}
/** Request body of a new daily entry. */
export interface IceDayCreate extends IceDayInput { businessDate: string }

/** The checked, trimmed values of an `IceDayInput` (everything that needs no database). */
interface CleanDay {
  salesCents: number; costAllocCents: number; electricityAllocCents: number; notes: string;
  items: Array<{ itemName: string; qty: number; unitPriceCents: number; lineTotalCents: number }>;
  confirmNegativeProfit: boolean; clientRef: string;
}

/** Checks text fields and bounds; computes each item's line total. @throws AppError 400 VALIDATION_ERROR. */
function cleanInput(body: IceDayInput): CleanDay {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  const items = (body.items ?? []).map((it, i) => {
    const itemName = trimmed(fields, `items.${i}.itemName`, 'Item name', it.itemName, 1, ITEM_NAME_MAX_LENGTH);
    const lineTotalCents = it.qty * it.unitPriceCents;
    if (lineTotalCents > MAX_CENTS) fields[`items.${i}.unitPriceCents`] = 'This line total is too large.';
    return { itemName, qty: it.qty, unitPriceCents: it.unitPriceCents, lineTotalCents };
  });
  assertNoFieldErrors(fields);
  return {
    salesCents: body.salesCents, costAllocCents: body.costAllocCents, electricityAllocCents: body.electricityAllocCents, notes, items,
    confirmNegativeProfit: body.confirmNegativeProfit === true, clientRef: body.clientRef,
  };
}

/**
 * Business rules on the entry itself (after DAY_CLOSED): the optional items must add up exactly to the sales
 * (`422 ITEMS_TOTAL_MISMATCH`) and a negative profit share must be confirmed (`422 NEGATIVE_PROFIT_UNCONFIRMED`, 10.3).
 *
 * @returns The server-computed profit share S - C - E.
 */
function checkEntry(c: CleanDay): number {
  if (c.items.length > 0) {
    const sum = c.items.reduce((t, i) => t + i.lineTotalCents, 0);
    if (sum !== c.salesCents) {
      throw new AppError(422, 'ITEMS_TOTAL_MISMATCH',
        `The item lines add up to ${formatLKR(sum)} but the sales total is ${formatLKR(c.salesCents)}. They must be equal.`,
        { items: 'The item lines must add up to the sales total.' }, { itemsTotalCents: sum, salesCents: c.salesCents });
    }
  }
  const profitShare = c.salesCents - c.costAllocCents - c.electricityAllocCents;
  if (profitShare < 0 && !c.confirmNegativeProfit) {
    throw new AppError(422, 'NEGATIVE_PROFIT_UNCONFIRMED',
      `The cost and electricity allocations are more than the sales, so this day's profit share would be negative (${formatLKR(profitShare)}). `
      + 'Confirm that you want to record a negative profit.',
      { confirmNegativeProfit: 'Confirm the negative profit to continue.' }, { profitShareCents: profitShare });
  }
  return profitShare;
}

/**
 * Writes a daily entry: the record, its items, one `icecream_sale` cash entry (+ fund row) per non-zero fund share
 * (10.2: Cost C, Electricity E, Profit S - C - E - negative only when confirmed). Returns the new day's id.
 */
function writeDay(conn: DatabaseSync, businessDate: string, c: CleanDay, profitShare: number): number {
  const id = insertDay(conn, {
    businessDate, salesCents: c.salesCents, costAllocCents: c.costAllocCents, electricityAllocCents: c.electricityAllocCents,
    profitShareCents: profitShare, negativeConfirmed: profitShare < 0, notes: c.notes, clientRef: c.clientRef,
  });
  if (c.items.length > 0) insertDayItems(conn, id, c.items);
  const shares: Array<[IceFund, number]> = [['cost', c.costAllocCents], ['electricity', c.electricityAllocCents], ['profit', profitShare]];
  for (const [fund, cents] of shares) {
    if (cents === 0) continue; // 10.2: a zero share writes nothing
    postCash(conn, {
      book: 'icecream', fund, businessDate, type: 'icecream_sale', amountCents: cents, refTable: 'icecream_days', refId: id,
      fundKind: 'daily_allocation', note: `Daily entry ${businessDate}`,
    });
  }
  return id;
}

/** Reverses every not-yet-reversed cash entry (and its fund row) written for one record (R1). */
export function reverseRefCash(conn: DatabaseSync, refTable: string, refId: number, note: string): void {
  const entries = findCashEntriesByRef(conn, refTable, refId);
  for (const e of entries) {
    if (e.reversesEntryId !== null) continue;
    if (entries.some((x) => x.reversesEntryId === e.id)) continue;
    reverseCash(conn, e, note);
  }
}

/** Result of a daily-entry write: the entry plus the funds block and warnings every Ice Cream write returns. */
export interface DayWrite { day: IceDay; funds: FundsSummary; warnings: IceWarning[]; created: boolean }

/**
 * Creates the daily entry of a business date.
 *
 * Validation order: schema -> fields -> R-FD -> clientRef repeat -> DAY_CLOSED (R9) -> DAY_EXISTS -> items total ->
 * negative profit confirmation. Idempotent by `clientRef`.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED, 409 DAY_CLOSED / DAY_EXISTS, 422 ITEMS_TOTAL_MISMATCH /
 *   NEGATIVE_PROFIT_UNCONFIRMED.
 */
export function createDay(ctx: AppContext, body: IceDayCreate): DayWrite {
  const clean = cleanInput(body);
  checkBusinessDate(body.businessDate);

  return runWrite(ctx, (conn) => {
    const existing = getDayByClientRef(conn, body.clientRef);
    if (existing) return { day: toDay(existing, listDayItems(conn, existing.id)), ...writeExtras(conn, false), created: false };

    assertDayOpen(conn, ['icecream'], body.businessDate); // R9
    const posted = getPostedDayByDate(conn, body.businessDate);
    if (posted) {
      throw new AppError(409, 'DAY_EXISTS',
        `A daily entry already exists for ${body.businessDate}. Edit it (replace) instead of adding a second one.`,
        undefined, { businessDate: body.businessDate, existingId: posted.id, replaceWith: `PUT /icecream/days/${body.businessDate}` });
    }
    const profitShare = checkEntry(clean);
    const id = writeDay(conn, body.businessDate, clean, profitShare);
    const day = loadDay(conn, id);
    logAudit(conn, 'icecream_day', String(id), 'create', null, day, undefined, { businessDate: day.businessDate, backdated: day.backdated });
    return { day, ...writeExtras(conn, true), created: true };
  });
}

/**
 * Replaces the posted daily entry of a date (C9 void-and-replace, one transaction): the old entry's cash and fund rows
 * are reversed, the new entry is written with the SAME business date. The D2 guard (10.4) is judged on the FINAL state
 * (old entry out, new entry in), so lowering an allocation that released profit depends on is refused, raising one is fine.
 *
 * @param date   Business date of the entry to replace (path parameter); R-FD applies to it as to every dated write.
 * @param reason Why the entry was replaced (stored as the old entry's void reason; default "Replaced by a corrected entry").
 * @throws AppError 404 NOT_FOUND (no posted entry for the date), 409 DAY_CLOSED, 422 VOID_BREAKS_RELEASE and the create errors.
 */
export function replaceDay(ctx: AppContext, date: string, body: IceDayInput & { reason?: string }): DayWrite {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason ?? 'Replaced by a corrected entry', 1, REASON_MAX_LENGTH);
  const clean = cleanInput(body);
  assertNoFieldErrors(fields);
  checkBusinessDate(date);

  return runWrite(ctx, (conn) => {
    const existing = getDayByClientRef(conn, body.clientRef);
    if (existing) return { day: toDay(existing, listDayItems(conn, existing.id)), ...writeExtras(conn, false), created: false };

    const old = getPostedDayByDate(conn, date);
    if (!old) throw notFound('Daily entry');
    assertDayOpen(conn, ['icecream'], date); // R9
    const profitShare = checkEntry(clean);

    // D2 on the FINAL state: the old entry is gone and the replacement is in.
    const facts = loadFacts(conn);
    const replacement = {
      id: -1, businessDate: date, salesCents: clean.salesCents, costCents: clean.costAllocCents,
      electricityCents: clean.electricityAllocCents, profitShareCents: profitShare,
    };
    if (voidGuard(standing(facts), standing(withReplacedDay(facts, old.id, replacement))).blocked) throw voidBreaksRelease('entry');

    const before = loadDay(conn, old.id);
    reverseRefCash(conn, 'icecream_days', old.id, `Replaced daily entry #${old.id}`);
    markDayVoid(conn, old.id, reason);
    const voided = loadDay(conn, old.id);
    logAudit(conn, 'icecream_day', String(old.id), 'void', before, voided, reason,
      { businessDate: voided.businessDate, backdated: isBackdatedToday(voided.businessDate) });

    const id = writeDay(conn, date, clean, profitShare);
    const day = loadDay(conn, id);
    logAudit(conn, 'icecream_day', String(id), 'replace', before, day, `Replaces daily entry #${old.id}`,
      { businessDate: day.businessDate, backdated: day.backdated });
    return { day, ...writeExtras(conn, true), created: true };
  });
}

/**
 * Voids the posted daily entry of a date (R1): its cash entries and fund rows are reversed (same business date) and it is
 * marked `void`. Blocked by the D2 guard when released profit depends on it.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason / date), 404 NOT_FOUND, 409 DAY_CLOSED, 422 VOID_BREAKS_RELEASE.
 */
export function voidDay(ctx: AppContext, date: string, body: { reason: string }): { day: IceDay; funds: FundsSummary; warnings: IceWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);
  if (!isIsoDate(date)) throw validationError({ date: 'Enter a valid date (YYYY-MM-DD).' });

  return runWrite(ctx, (conn) => {
    const row = getPostedDayByDate(conn, date);
    if (!row) throw notFound('Daily entry');
    assertDayOpen(conn, ['icecream'], row.businessDate); // R9: judged on the entry's own date (the reversal copies it)
    const facts = loadFacts(conn);
    if (voidGuard(standing(facts), standing(withoutDay(facts, row.id))).blocked) throw voidBreaksRelease('entry'); // D2

    const before = loadDay(conn, row.id);
    reverseRefCash(conn, 'icecream_days', row.id, `Void of daily entry #${row.id}`);
    markDayVoid(conn, row.id, reason);
    const day = loadDay(conn, row.id);
    logAudit(conn, 'icecream_day', String(row.id), 'void', before, day, reason,
      { businessDate: day.businessDate, backdated: isBackdatedToday(day.businessDate) });
    return { day, ...writeExtras(conn, true) };
  });
}

/** The posted daily entry of a date with its items. @throws AppError 404 NOT_FOUND. */
export function getDayByDate(ctx: AppContext, date: string): IceDay {
  const r = getPostedDayByDate(ctx.database.conn, date);
  if (!r) throw notFound('Daily entry');
  return toDay(r, listDayItems(ctx.database.conn, r.id));
}

/** Lists daily entries (posted and void), newest first; `totals` sum only POSTED entries. */
export function listDays(ctx: AppContext, q: { from?: string; to?: string; status?: IceStatus; limit: number; offset: number }): {
  items: IceDay[]; total: number; totals: { salesCents: number; costAllocCents: number; electricityAllocCents: number; profitShareCents: number };
} {
  const conn = ctx.database.conn;
  const r = listDayRows(conn, q);
  return { items: r.items.map((d) => toDay(d, listDayItems(conn, d.id))), total: r.total, totals: r.totals };
}
