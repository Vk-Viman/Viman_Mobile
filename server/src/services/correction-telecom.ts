/**
 * services/correction-telecom.ts - "correct this entry" for reload sales and EZCash sales (API_CONTRACTS "Correction contract, Phase 2").
 *
 * Layer: service. It owns only the glue between the shared helper (`correction.ts`) and the EXISTING void/create services:
 * `voidReloadSale` + `createReloadSale` and `voidEzCashSale` + `createEzCashSale` run unchanged inside the one transaction of
 * `applyCorrection`, so the closed-day rule (R9), backdating, R-FD, provider-active, the rounding extra and the negative-cash
 * warning all decide exactly as for a manual void followed by a manual create. Nothing here re-implements a rule.
 *
 * Commission rate (owner rule): the ORIGINAL rate (basis points) is kept on the replacement, so the commission formulas of section 5
 * run with the original rate. It is recalculated (the rate a normal create uses today) only when the request says
 * `recalculateCommission: true`, or when the replacement changes the reload provider (that provider's current rate applies).
 * The preserved rate is handed to the create through its optional internal parameter; the public create body is unchanged.
 * `comparison` = `{ originalCommissionBp, replacementCommissionBp, originalCommissionCents, replacementCommissionCents, rateRecalculated }`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getEzCashSale as getEzCashRow, getReloadSale as getReloadRow } from '../repositories/telecom.repo.ts';
import { applyCorrection, checkCorrectable, previewCorrection } from './correction.ts';
import type { CorrectionLink, Eligibility } from './correction.ts';
import type { CashWarning } from './cash-warnings.ts';
import {
  createEzCashSale, createReloadSale, getEzCashSale, getReloadSale, voidEzCashSale, voidReloadSale,
} from './telecom.service.ts';
import type { EzCashSale, EzCashSaleCreate, ReloadSale, ReloadSaleCreate } from './telecom.service.ts';
import { notFound } from './validation.ts';

type WithOptionalDate<T extends { businessDate: string }> = Omit<T, 'businessDate'> & { businessDate?: string };

/** Request body of correct / correct-preview. `recalculateCommission` defaults to false (keep the original rate). */
export interface TelecomCorrectionRequest<B extends { businessDate: string }> {
  reason: string; replacement: WithOptionalDate<B>; recalculateCommission?: boolean;
}

/** JSON schema of the replacement: the normal create schema with `businessDate` no longer required (G5). */
export function optionalDate(createSchema: { required: readonly string[]; [k: string]: unknown }): object {
  return { ...createSchema, required: createSchema.required.filter((k) => k !== 'businessDate') };
}

/** What a route sends back: HTTP status and JSON body. */
export interface CorrectionReply { status: 200 | 201; body: Record<string, unknown> }

/** The commission part of the response. */
export interface CommissionComparison {
  originalCommissionBp: number; replacementCommissionBp: number;
  originalCommissionCents: number; replacementCommissionCents: number; rateRecalculated: boolean;
}

interface Rec { id: number; businessDate: string; providerId: number; commissionBp: number; commissionCents: number }

interface Adapter<R extends Rec, B extends { businessDate: string; clientRef: string }> {
  entity: 'reload_sales' | 'ezcash_sales';
  statusOf: (conn: DatabaseSync, id: number) => 'posted' | 'void' | null;
  notFound: () => never;
  load: (ctx: AppContext, id: number) => R;
  voidIt: (ctx: AppContext, id: number, reason: string) => { item: R; warnings: CashWarning[] };
  /** The existing create, given the rate to store (undefined = the create looks the rate up itself, as always). */
  createIt: (ctx: AppContext, body: B, commissionBp: number | undefined) => { item: R; created: boolean };
}

function mergeWarnings(...lists: unknown[][]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const w of lists.flat()) {
    const key = JSON.stringify(w);
    if (!seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

interface Captured<R> { original?: R; voidWarnings: CashWarning[]; recalculated: boolean }
interface Made<R> { item: R; recalculated: boolean }

function comparisonOf(original: Rec, replacement: Rec, rateRecalculated: boolean): CommissionComparison {
  return {
    originalCommissionBp: original.commissionBp, replacementCommissionBp: replacement.commissionBp,
    originalCommissionCents: original.commissionCents, replacementCommissionCents: replacement.commissionCents, rateRecalculated,
  };
}

function stepsOf<R extends Rec, B extends { businessDate: string; clientRef: string; providerId?: number }>(
  ctx: AppContext, a: Adapter<R, B>, id: number, req: TelecomCorrectionRequest<B>, cap: Captured<R>,
) {
  return {
    entity: a.entity,
    originalId: id,
    reason: req.reason,
    replacementClientRef: req.replacement.clientRef,
    statusOf: a.statusOf,
    notFound: a.notFound,
    voidOriginal: (reason: string) => {
      const r = a.voidIt(ctx, id, reason);
      cap.original = r.item;
      cap.voidWarnings = r.warnings;
      return r;
    },
    createReplacement: (): Made<R> => {
      const original = a.load(ctx, id); // the void keeps the date and the rate snapshot
      const date = req.replacement.businessDate ?? original.businessDate; // G5
      // The original rate is kept for the same provider unless a recalculation was asked for; a provider change (reloads only,
      // EZCash is always Dialog) uses that provider's current rate.
      const sameProvider = req.replacement.providerId === undefined || req.replacement.providerId === original.providerId;
      const recalculated = req.recalculateCommission === true || !sameProvider;
      const made = a.createIt(ctx, { ...req.replacement, businessDate: date } as unknown as B, recalculated ? undefined : original.commissionBp);
      if (!made.created) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
      }
      cap.recalculated = recalculated;
      return { item: made.item, recalculated };
    },
    replacementIdOf: (m: Made<R>) => m.item.id,
  };
}

function check<R extends Rec, B extends { businessDate: string; clientRef: string }>(ctx: AppContext, a: Adapter<R, B>, id: number): Eligibility {
  return checkCorrectable(ctx, {
    originalId: id, statusOf: a.statusOf, notFound: a.notFound, voidOriginal: (reason: string) => a.voidIt(ctx, id, reason),
  });
}

function preview<R extends Rec, B extends { businessDate: string; clientRef: string; providerId?: number }>(
  ctx: AppContext, a: Adapter<R, B>, id: number, req: TelecomCorrectionRequest<B>,
): Record<string, unknown> {
  const cap: Captured<R> = { voidWarnings: [], recalculated: false };
  const { replacement } = previewCorrection(ctx, stepsOf(ctx, a, id, req, cap));
  const original = cap.original as R;
  return {
    original, replacement: replacement.item, warnings: mergeWarnings(cap.voidWarnings),
    comparison: comparisonOf(original, replacement.item, replacement.recalculated),
  };
}

function correct<R extends Rec, B extends { businessDate: string; clientRef: string; providerId?: number }>(
  ctx: AppContext, a: Adapter<R, B>, id: number, req: TelecomCorrectionRequest<B>,
): CorrectionReply {
  const cap: Captured<R> = { voidWarnings: [], recalculated: false };
  const res = applyCorrection(ctx, stepsOf(ctx, a, id, req, cap));
  const link: CorrectionLink = res.correction;
  if (res.replayed || res.replacement === null) {
    // Replay (G7): the stored result, no second void. The rate flag is derived from the stored rows and the request.
    const original = a.load(ctx, link.originalId);
    const replacement = a.load(ctx, link.replacementId);
    const recalculated = req.recalculateCommission === true || replacement.providerId !== original.providerId
      || replacement.commissionBp !== original.commissionBp;
    return {
      status: 200,
      body: { original, replacement, correction: link, warnings: [], comparison: comparisonOf(original, replacement, recalculated) },
    };
  }
  const original = cap.original as R;
  return {
    status: 201,
    body: {
      original, replacement: res.replacement.item, correction: link, warnings: mergeWarnings(cap.voidWarnings),
      comparison: comparisonOf(original, res.replacement.item, res.replacement.recalculated),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Adapters (the void/create calls are the existing services, nothing more)
// ---------------------------------------------------------------------------------------------

type ReloadBody = ReloadSaleCreate;
type EzBody = EzCashSaleCreate & { providerId?: number };

const reloadAdapter: Adapter<ReloadSale, ReloadBody> = {
  entity: 'reload_sales',
  statusOf: (conn, id) => getReloadRow(conn, id)?.status ?? null,
  notFound: () => { throw notFound('Reload sale'); },
  load: (ctx, id) => getReloadSale(ctx, id),
  voidIt: (ctx, id, reason) => voidReloadSale(ctx, id, { reason }),
  createIt: (ctx, body, bp) => createReloadSale(ctx, body, bp === undefined ? undefined : { commissionBp: bp }),
};

const ezcashAdapter: Adapter<EzCashSale, EzBody> = {
  entity: 'ezcash_sales',
  statusOf: (conn, id) => getEzCashRow(conn, id)?.status ?? null,
  notFound: () => { throw notFound('EZCash entry'); },
  load: (ctx, id) => getEzCashSale(ctx, id),
  voidIt: (ctx, id, reason) => voidEzCashSale(ctx, id, { reason }),
  createIt: (ctx, body, bp) => createEzCashSale(ctx, body, bp === undefined ? undefined : { commissionBp: bp }),
};

export const checkReloadCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, reloadAdapter, id);
export const previewReloadCorrection = (ctx: AppContext, id: number, req: TelecomCorrectionRequest<ReloadSaleCreate>) =>
  preview(ctx, reloadAdapter, id, req);
export const correctReload = (ctx: AppContext, id: number, req: TelecomCorrectionRequest<ReloadSaleCreate>) =>
  correct(ctx, reloadAdapter, id, req);

export const checkEzCashCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, ezcashAdapter, id);
export const previewEzCashCorrection = (ctx: AppContext, id: number, req: TelecomCorrectionRequest<EzCashSaleCreate>) =>
  preview(ctx, ezcashAdapter, id, req as TelecomCorrectionRequest<EzBody>);
export const correctEzCash = (ctx: AppContext, id: number, req: TelecomCorrectionRequest<EzCashSaleCreate>) =>
  correct(ctx, ezcashAdapter, id, req as TelecomCorrectionRequest<EzBody>);
