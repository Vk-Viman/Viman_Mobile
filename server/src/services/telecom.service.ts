/**
 * services/telecom.service.ts - mobile reloads, EZCash bill payments and top-ups (BUSINESS_RULES section 5).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Rules implemented here:
 *  - Revenue in Telecom is the COMMISSION only. The FULL collection (reload sales, EZCash bill total) goes into the
 *    Telecom cash book; the commission itself is NOT a cash entry (the provider keeps it inside what we pay it).
 *  - Reload commission = mulDivRound(sales, rateBp, 10000) + extra (extra >= 0, the owner's rounding top-up).
 *    EZCash commission = mulDivRound(billTotal, rateBp, 10000). All maths goes through `mulDivRound` (section 0).
 *  - The rate is SNAPSHOTTED on every sale: the provider's own rate, else the shop default from Settings. Changing
 *    a rate later never rewrites history (R12 spirit; the schema stores `commission_bp` per row).
 *  - Top-ups are cash OUTFLOWS with no P&L effect: `provider_topup` names a provider, `wallet_topup` is the EZCash
 *    wallet and names none. No float or balance is tracked (R14): the Telecom cash book is not meant to reconcile
 *    to Telecom profit.
 *  - R-FD: no future dates (the DB triggers repeat the check). Section 12: every write is idempotent by `clientRef`
 *    and audited with its business date and the `backdated` flag.
 *  - R1 / C9: a void marks the row `void` and appends a reversal cash entry (opposite sign, same business date,
 *    `reverses_entry_id` set). Nothing is edited or deleted. A balance may go negative: that is a warning elsewhere,
 *    never a block (R13).
 * Every write = business row + cash entry + audit row in ONE transaction (`runWrite`), or nothing at all.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { findCashEntriesByRef, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import {
  getEzCashSale as getEzCashRow, getEzCashSaleByClientRef, getProvider, getProviderByName, getReloadSale as getReloadRow,
  getReloadSaleByClientRef, getTopup as getTopupRow, getTopupByClientRef, insertEzCashSale, insertReloadSale, insertTopup,
  listEzCashSales as listEzCashRows, listProviders as listProviderRows, listReloadSales as listReloadRows,
  listTopups as listTopupRows, markEzCashSaleVoid, markReloadSaleVoid, markTopupVoid, summaryTotals,
  updateProvider as updateProviderRow,
} from '../repositories/telecom.repo.ts';
import type {
  EzCashSaleRow, ProviderRow, ReloadSaleRow, TelecomStatus, TopupKind, TopupRow,
} from '../repositories/telecom.repo.ts';
import { logAudit } from './audit.service.ts';
import { getSettings } from './settings.service.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** Largest single amount accepted (cents); matches the database CHECKs so a bad value is a clean 400. */
export const MAX_TELECOM_CENTS = 1_000_000_000_000;

// ---------------------------------------------------------------------------------------------
// Commission maths (pure, exported so tests and the web preview formula have one definition)
// ---------------------------------------------------------------------------------------------

/**
 * Reload commission in cents: `mulDivRound(sales, rateBp, 10000) + extra` (section 5).
 * Example: Rs 50,000 at 600 bp with Rs 50 extra -> 3,000 + 50 = Rs 3,050 (5,000,000 cents -> 305,000 cents).
 */
export function reloadCommission(salesCents: number, rateBp: number, extraCents: number): number {
  return mulDivRound(salesCents, rateBp, 10000) + extraCents;
}

/** EZCash commission in cents: `mulDivRound(billTotal, rateBp, 10000)` (section 5), no extra. */
export function ezcashCommission(billTotalCents: number, rateBp: number): number {
  return mulDivRound(billTotalCents, rateBp, 10000);
}

// ---------------------------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------------------------

/** A provider as returned by the API: `commissionBp` is the EFFECTIVE rate, `ownCommissionBp` null = shop default. */
export interface Provider { id: number; name: string; commissionBp: number; ownCommissionBp: number | null; active: boolean }

/** A reload entry (adds the `backdated` flag). `commissionCents` already includes `extraCents`. */
export interface ReloadSale {
  id: number; businessDate: string; postedAt: string; backdated: boolean; providerId: number; providerName: string;
  salesCents: number; commissionBp: number; extraCents: number; commissionCents: number; notes: string;
  status: TelecomStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

/** An EZCash entry (provider is always Dialog). */
export interface EzCashSale {
  id: number; businessDate: string; postedAt: string; backdated: boolean; providerId: number; providerName: string;
  billTotalCents: number; commissionBp: number; commissionCents: number; notes: string;
  status: TelecomStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

/** A top-up; `providerId`/`providerName` are null for a wallet top-up. */
export interface Topup {
  id: number; businessDate: string; postedAt: string; backdated: boolean; kind: TopupKind; providerId: number | null;
  providerName: string | null; amountCents: number; notes: string; status: TelecomStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}

function toReload(r: ReloadSaleRow): ReloadSale {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    providerId: r.providerId, providerName: r.providerName, salesCents: r.salesCents, commissionBp: r.commissionBp,
    extraCents: r.extraCents, commissionCents: r.commissionCents, notes: r.notes, status: r.status,
    voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function toEz(r: EzCashSaleRow): EzCashSale {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    providerId: r.providerId, providerName: r.providerName, billTotalCents: r.billTotalCents, commissionBp: r.commissionBp,
    commissionCents: r.commissionCents, notes: r.notes, status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason,
    clientRef: r.clientRef,
  };
}

function toTopup(r: TopupRow): Topup {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    kind: r.kind, providerId: r.providerId, providerName: r.providerName, amountCents: r.amountCents, notes: r.notes,
    status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function toProvider(r: ProviderRow, defaultBp: number): Provider {
  return { id: r.id, name: r.name, commissionBp: r.ownCommissionBp ?? defaultBp, ownCommissionBp: r.ownCommissionBp, active: r.active };
}

// ---------------------------------------------------------------------------------------------
// Shared write helpers
// ---------------------------------------------------------------------------------------------

/** Checks an amount field is a whole number of cents inside the supported range (the schema checks the type). */
function checkAmount(fields: Fields, key: string, label: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) fields[key] = `${label} must be a whole number of cents, at least ${min}.`;
  else if (value > MAX_TELECOM_CENTS) fields[key] = `${label} is too large.`;
}

/**
 * Voids a business row's cash entry: appends the exact opposite entry (same book, type, business date) that points
 * back at the original via `reverses_entry_id` (R1). Exactly one live original entry must exist.
 *
 * @param refTable The business table the original entry refers to (e.g. 'reload_sales').
 * @param label    Text for the ledger note, e.g. 'reload sale'.
 */
function reverseCashEntry(conn: DatabaseSync, refTable: string, id: number, label: string): void {
  const entries = findCashEntriesByRef(conn, refTable, id);
  const original = entries.find((e) => e.reversesEntryId === null);
  if (!original) throw new Error(`${label} #${id} has no cash entry to reverse`);
  if (entries.some((e) => e.reversesEntryId === original.id)) throw new Error(`${label} #${id} was already reversed`);
  insertCashEntry(conn, {
    book: original.book, businessDate: original.businessDate, type: original.type, amountCents: -original.amountCents,
    refTable, refId: id, reversesEntryId: original.id, note: `Void of ${label} #${id}`,
  });
}

/** The shop-wide default rates from Settings (a section never saved falls back to the documented defaults). */
function defaultRates(ctx: AppContext): { reloadCommissionBp: number; ezcashCommissionBp: number } {
  return getSettings(ctx).rates;
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

/** All four providers with their effective rates (own rate, else the shop default). */
export function listProviders(ctx: AppContext): { items: Provider[] } {
  const bp = defaultRates(ctx).reloadCommissionBp;
  return { items: listProviderRows(ctx.database.conn).map((r) => toProvider(r, bp)) };
}

/**
 * Changes a provider's own commission rate (null = use the shop default) and/or its active flag. Never alters
 * existing sales because each sale holds its own rate snapshot. Audited with before/after.
 *
 * @throws AppError 404 NOT_FOUND.
 */
export function updateProvider(ctx: AppContext, id: number, body: { commissionBp: number | null; active: boolean }): Provider {
  const bp = defaultRates(ctx).reloadCommissionBp;
  return runWrite(ctx, (conn) => {
    const row = getProvider(conn, id);
    if (!row) throw notFound('Provider');
    const before = toProvider(row, bp);
    updateProviderRow(conn, id, body);
    const after = toProvider(getProvider(conn, id) as ProviderRow, bp);
    logAudit(conn, 'reload_provider', String(id), 'update', before, after);
    return after;
  });
}

// ---------------------------------------------------------------------------------------------
// Reload sales
// ---------------------------------------------------------------------------------------------

function loadReload(conn: DatabaseSync, id: number): ReloadSale {
  const r = getReloadRow(conn, id);
  if (!r) throw notFound('Reload sale');
  return toReload(r);
}

/** One reload entry by id. @throws AppError 404 NOT_FOUND. */
export function getReloadSale(ctx: AppContext, id: number): ReloadSale {
  return loadReload(ctx.database.conn, id);
}

/** Lists reload entries newest first; `totals` add up POSTED entries that match the filters only. */
export function listReloadSales(ctx: AppContext, q: {
  from?: string; to?: string; providerId?: number; status?: TelecomStatus; limit: number; offset: number;
}): { items: ReloadSale[]; total: number; totals: { salesCents: number; commissionCents: number; extraCents: number } } {
  const { items, total, totals } = listReloadRows(ctx.database.conn, q);
  return { items: items.map(toReload), total, totals };
}

export interface ReloadSaleCreate {
  businessDate: string; providerId: number; salesCents: number; extraCents?: number; notes?: string; clientRef: string;
}

/**
 * Records a day's reload collection for one provider: the full amount comes into the Telecom cash book and the
 * commission (+ extra) is the revenue. Idempotent by `clientRef` (a repeat returns the saved entry, `created: false`).
 *
 * @throws AppError 400 VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED, 409 PROVIDER_INACTIVE.
 */
export function createReloadSale(ctx: AppContext, body: ReloadSaleCreate): { item: ReloadSale; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  const extraCents = body.extraCents ?? 0;
  checkAmount(fields, 'salesCents', 'Sales', body.salesCents, 1);
  checkAmount(fields, 'extraCents', 'Extra', extraCents, 0);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const defaults = defaultRates(ctx);

  return runWrite(ctx, (conn) => {
    const existing = getReloadSaleByClientRef(conn, body.clientRef);
    if (existing) return { item: toReload(existing), created: false };

    assertDayOpen(conn, ['telecom'], body.businessDate); // R9
    const provider = getProvider(conn, body.providerId);
    if (!provider) throw validationError({ providerId: 'Provider not found.' });
    if (!provider.active) {
      throw new AppError(409, 'PROVIDER_INACTIVE', `${provider.name} is switched off. Turn it on to record reloads.`,
        { providerId: `${provider.name} is switched off.` });
    }

    // Rate snapshot: the provider's own rate, else the shop default (section 5; C11 range is checked at save time).
    const commissionBp = provider.ownCommissionBp ?? defaults.reloadCommissionBp;
    const commissionCents = reloadCommission(body.salesCents, commissionBp, extraCents);
    const id = insertReloadSale(conn, {
      businessDate: body.businessDate, providerId: provider.id, salesCents: body.salesCents, commissionBp, extraCents,
      commissionCents, notes, clientRef: body.clientRef,
    });
    // The FULL collection is cash in; commission is not a cash entry (R14 - no float tracking).
    insertCashEntry(conn, {
      book: 'telecom', businessDate: body.businessDate, type: 'reload_collection', amountCents: body.salesCents,
      refTable: 'reload_sales', refId: id,
    });

    const item = loadReload(conn, id);
    logAudit(conn, 'reload_sale', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

/**
 * Voids a reload entry (R1): status `void` plus a reversal cash entry. The commission leaves the totals because
 * totals count posted rows only.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID.
 */
export function voidReloadSale(ctx: AppContext, id: number, body: { reason: string }): { item: ReloadSale; warnings: CashWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);
  return runWrite(ctx, (conn) => {
    const row = getReloadRow(conn, id);
    if (!row) throw notFound('Reload sale');
    assertDayOpen(conn, ['telecom'], row.businessDate); // R9: a void is judged on the entry's own date
    if (row.status === 'void') throw alreadyVoid('reload sale');
    const before = toReload(row);
    reverseCashEntry(conn, 'reload_sales', id, 'reload sale');
    markReloadSaleVoid(conn, id, reason);
    const after = loadReload(conn, id);
    logAudit(conn, 'reload_sale', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return { item: after, warnings: negativeCashWarnings(conn, ['telecom']) }; // R13: warn, never block
  });
}

// ---------------------------------------------------------------------------------------------
// EZCash
// ---------------------------------------------------------------------------------------------

function loadEz(conn: DatabaseSync, id: number): EzCashSale {
  const r = getEzCashRow(conn, id);
  if (!r) throw notFound('EZCash entry');
  return toEz(r);
}

/** One EZCash entry by id. @throws AppError 404 NOT_FOUND. */
export function getEzCashSale(ctx: AppContext, id: number): EzCashSale {
  return loadEz(ctx.database.conn, id);
}

/** Lists EZCash entries newest first; `totals` add up POSTED entries that match the filters only. */
export function listEzCashSales(ctx: AppContext, q: {
  from?: string; to?: string; status?: TelecomStatus; limit: number; offset: number;
}): { items: EzCashSale[]; total: number; totals: { billTotalCents: number; commissionCents: number } } {
  const { items, total, totals } = listEzCashRows(ctx.database.conn, q);
  return { items: items.map(toEz), total, totals };
}

export interface EzCashSaleCreate { businessDate: string; billTotalCents: number; notes?: string; clientRef: string }

/**
 * Records EZCash bills collected: the full bill total comes into the Telecom cash book, the commission is the
 * revenue. The provider is always Dialog and the rate is the shop's EZCash rate from Settings (the provider's own
 * rate is its RELOAD rate and does not apply here). Idempotent by `clientRef`.
 *
 * @throws AppError 400 VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED.
 */
export function createEzCashSale(ctx: AppContext, body: EzCashSaleCreate): { item: EzCashSale; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  checkAmount(fields, 'billTotalCents', 'Bill total', body.billTotalCents, 1);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate);
  const commissionBp = defaultRates(ctx).ezcashCommissionBp;

  return runWrite(ctx, (conn) => {
    const existing = getEzCashSaleByClientRef(conn, body.clientRef);
    if (existing) return { item: toEz(existing), created: false };

    assertDayOpen(conn, ['telecom'], body.businessDate); // R9
    const dialog = getProviderByName(conn, 'Dialog');
    if (!dialog) throw new Error('The Dialog provider is missing from reload_providers');
    const commissionCents = ezcashCommission(body.billTotalCents, commissionBp);
    const id = insertEzCashSale(conn, {
      businessDate: body.businessDate, providerId: dialog.id, billTotalCents: body.billTotalCents, commissionBp,
      commissionCents, notes, clientRef: body.clientRef,
    });
    insertCashEntry(conn, {
      book: 'telecom', businessDate: body.businessDate, type: 'ezcash_collection', amountCents: body.billTotalCents,
      refTable: 'ezcash_sales', refId: id,
    });

    const item = loadEz(conn, id);
    logAudit(conn, 'ezcash_sale', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, created: true };
  });
}

/** Voids an EZCash entry (R1): status `void` plus a reversal cash entry. @throws AppError 400, 404, 409 ALREADY_VOID. */
export function voidEzCashSale(ctx: AppContext, id: number, body: { reason: string }): { item: EzCashSale; warnings: CashWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);
  return runWrite(ctx, (conn) => {
    const row = getEzCashRow(conn, id);
    if (!row) throw notFound('EZCash entry');
    assertDayOpen(conn, ['telecom'], row.businessDate); // R9
    if (row.status === 'void') throw alreadyVoid('EZCash entry');
    const before = toEz(row);
    reverseCashEntry(conn, 'ezcash_sales', id, 'EZCash entry');
    markEzCashSaleVoid(conn, id, reason);
    const after = loadEz(conn, id);
    logAudit(conn, 'ezcash_sale', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return { item: after, warnings: negativeCashWarnings(conn, ['telecom']) }; // R13: warn, never block
  });
}

// ---------------------------------------------------------------------------------------------
// Top-ups
// ---------------------------------------------------------------------------------------------

function loadTopup(conn: DatabaseSync, id: number): Topup {
  const r = getTopupRow(conn, id);
  if (!r) throw notFound('Top-up');
  return toTopup(r);
}

/** One top-up by id. @throws AppError 404 NOT_FOUND. */
export function getTopup(ctx: AppContext, id: number): Topup {
  return loadTopup(ctx.database.conn, id);
}

/** Lists top-ups newest first; `totals` add up POSTED top-ups that match the filters, split by kind. */
export function listTopups(ctx: AppContext, q: {
  from?: string; to?: string; kind?: TopupKind; providerId?: number; status?: TelecomStatus; limit: number; offset: number;
}): { items: Topup[]; total: number; totals: { providerTopupCents: number; walletTopupCents: number; totalCents: number } } {
  const { items, total, totals } = listTopupRows(ctx.database.conn, q);
  return { items: items.map(toTopup), total, totals };
}

export interface TopupCreate {
  businessDate: string; kind: TopupKind; providerId?: number; amountCents: number; notes?: string; clientRef: string;
}

/**
 * Records cash paid out to refill a provider (`provider_topup`, provider required) or the EZCash wallet
 * (`wallet_topup`, no provider). It is a cash-out with no P&L effect (section 2). Idempotent by `clientRef`.
 *
 * @throws AppError 400 VALIDATION_ERROR (provider missing / not allowed for the kind) / FUTURE_DATE_NOT_ALLOWED,
 *   409 PROVIDER_INACTIVE.
 */
export function createTopup(ctx: AppContext, body: TopupCreate): { item: Topup; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  checkAmount(fields, 'amountCents', 'Amount', body.amountCents, 1);
  if (body.kind === 'provider_topup' && body.providerId === undefined) fields.providerId = 'Choose the provider you topped up.';
  if (body.kind === 'wallet_topup' && body.providerId !== undefined) fields.providerId = 'A wallet top-up has no provider.';
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate);

  return runWrite(ctx, (conn) => {
    const existing = getTopupByClientRef(conn, body.clientRef);
    if (existing) return { item: toTopup(existing), warnings: [], created: false };

    assertDayOpen(conn, ['telecom'], body.businessDate); // R9
    let providerId: number | null = null;
    if (body.kind === 'provider_topup') {
      const provider = getProvider(conn, body.providerId as number);
      if (!provider) throw validationError({ providerId: 'Provider not found.' });
      if (!provider.active) {
        throw new AppError(409, 'PROVIDER_INACTIVE', `${provider.name} is switched off. Turn it on to record top-ups.`,
          { providerId: `${provider.name} is switched off.` });
      }
      providerId = provider.id;
    }
    const id = insertTopup(conn, {
      businessDate: body.businessDate, kind: body.kind, providerId, amountCents: body.amountCents, notes, clientRef: body.clientRef,
    });
    // Top-ups are cash OUT (negative); same cash-entry type name as the topup kind (section 2).
    insertCashEntry(conn, {
      book: 'telecom', businessDate: body.businessDate, type: body.kind, amountCents: -body.amountCents,
      refTable: 'telecom_topups', refId: id,
    });

    const item = loadTopup(conn, id);
    logAudit(conn, 'telecom_topup', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, warnings: negativeCashWarnings(conn, ['telecom']), created: true }; // R13: warn, never block
  });
}

/** Voids a top-up (R1): status `void` plus a reversal cash entry (cash back in). @throws AppError 400, 404, 409 ALREADY_VOID. */
export function voidTopup(ctx: AppContext, id: number, body: { reason: string }): Topup {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);
  return runWrite(ctx, (conn) => {
    const row = getTopupRow(conn, id);
    if (!row) throw notFound('Top-up');
    assertDayOpen(conn, ['telecom'], row.businessDate); // R9
    if (row.status === 'void') throw alreadyVoid('top-up');
    const before = toTopup(row);
    reverseCashEntry(conn, 'telecom_topups', id, 'top-up');
    markTopupVoid(conn, id, reason);
    const after = loadTopup(conn, id);
    logAudit(conn, 'telecom_topup', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

/** Posted telecom figures of one provider for the period (cents). `topupsCents` = provider top-ups. */
export interface ProviderSummary {
  providerId: number; name: string; reloadSalesCents: number; reloadCommissionCents: number; ezcashBillCents: number;
  ezcashCommissionCents: number; topupsCents: number; commissionRevenueCents: number;
}

/** Whole-period totals. `topupsCents` = provider + wallet top-ups; `reloadCommissionCents` includes the extras. */
export interface TelecomSummary {
  from: string | null; to: string | null; providers: ProviderSummary[];
  totals: {
    reloadSalesCents: number; reloadCommissionCents: number; reloadExtraCents: number; ezcashBillCents: number;
    ezcashCommissionCents: number; providerTopupsCents: number; walletTopupsCents: number; topupsCents: number;
    commissionRevenueCents: number;
  };
}

/**
 * Period summary of posted telecom activity. Telecom revenue = commission only (section 5): `commissionRevenueCents`
 * = reload commission (incl. extras) + EZCash commission. Collections and top-ups are shown for information; they
 * are cash movements, not revenue or expense. Voided rows never count (R1).
 */
export function telecomSummary(ctx: AppContext, q: { from?: string; to?: string }): TelecomSummary {
  const { providers, wallet } = summaryTotals(ctx.database.conn, q);
  const rows: ProviderSummary[] = providers.map((p) => ({
    providerId: p.providerId, name: p.name, reloadSalesCents: p.reloadSalesCents, reloadCommissionCents: p.reloadCommissionCents,
    ezcashBillCents: p.ezcashBillCents, ezcashCommissionCents: p.ezcashCommissionCents, topupsCents: p.providerTopupsCents,
    commissionRevenueCents: p.reloadCommissionCents + p.ezcashCommissionCents,
  }));
  const sum = (f: (p: (typeof providers)[number]) => number): number => providers.reduce((a, p) => a + f(p), 0);
  const providerTopups = sum((p) => p.providerTopupsCents);
  const reloadCommission = sum((p) => p.reloadCommissionCents);
  const ezCommission = sum((p) => p.ezcashCommissionCents);
  return {
    from: q.from ?? null, to: q.to ?? null, providers: rows,
    totals: {
      reloadSalesCents: sum((p) => p.reloadSalesCents), reloadCommissionCents: reloadCommission,
      reloadExtraCents: sum((p) => p.reloadExtraCents), ezcashBillCents: sum((p) => p.ezcashBillCents),
      ezcashCommissionCents: ezCommission, providerTopupsCents: providerTopups, walletTopupsCents: wallet.walletTopupsCents,
      topupsCents: providerTopups + wallet.walletTopupsCents, commissionRevenueCents: reloadCommission + ezCommission,
    },
  };
}
