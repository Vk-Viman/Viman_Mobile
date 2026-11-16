/**
 * services/correction-other.ts - "correct this entry" for top-ups, printing supplies, Ice Cream payments, Ice Cream fund moves and
 * stock losses (API_CONTRACTS "Correction contract, Phase 1").
 *
 * Layer: service. It owns only the glue between the shared helper (`correction.ts`) and the EXISTING void/create services of each type:
 * nothing here re-implements an accounting rule. `voidTopup`, `createTopup`, `voidSupply`, `createSupply`, `voidPayment`,
 * `createPayment`, `voidMove`, `createMove`, `voidStockLoss` and `createStockLoss` are called unchanged inside the one transaction
 * of `applyCorrection`, so closed days (R9), backdating, D2 `VOID_BREAKS_RELEASE`, D4 split confirmation, E4 electricity, fund
 * warnings, stock availability and the average cost all keep deciding exactly as for a manual void followed by a manual create.
 *
 * Response shape of every type: `original` (the record, now void), `replacement` (the new record), `warnings` (those of the void and
 * of the create, de-duplicated), `correction` (the link, real call only) and, for Ice Cream records, `funds` (the funds summary after).
 * `replacement.businessDate` is optional and defaults to the original's business date (G5).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getMove, getPayment } from '../repositories/icecream.repo.ts';
import { getSupply as getSupplyRow } from '../repositories/printing.repo.ts';
import { getStockLoss as getStockLossRow } from '../repositories/stock-losses.repo.ts';
import { getTopup as getTopupRow } from '../repositories/telecom.repo.ts';
import { applyCorrection, checkCorrectable, previewCorrection } from './correction.ts';
import type { CorrectionEntity, CorrectionLink, Eligibility } from './correction.ts';
import { createMove, voidMove } from './icecream-moves.service.ts';
import type { IceMove, IceMoveCreate } from './icecream-moves.service.ts';
import { createPayment, voidPayment } from './icecream-payments.service.ts';
import type { IcePayment, IcePaymentCreate } from './icecream-payments.service.ts';
import { writeExtras } from './icecream.service.ts';
import type { FundsSummary } from './icecream.service.ts';
import { createSupply, getSupply, voidSupply } from './printing.service.ts';
import type { PrintingSupply } from './printing.service.ts';
import { createStockLoss, getStockLoss, voidStockLoss } from './stock-losses.service.ts';
import type { StockLoss, StockLossCreate } from './stock-losses.service.ts';
import { createTopup, getTopup, voidTopup } from './telecom.service.ts';
import type { Topup, TopupCreate } from './telecom.service.ts';
import { moveKind, pnlTreatment } from './icecream-rules.ts';
import { isBackdated, notFound } from './validation.ts';
import type { MoveRow, PaymentRow } from '../repositories/icecream.repo.ts';

type WithOptionalDate<T extends { businessDate: string }> = Omit<T, 'businessDate'> & { businessDate?: string };

/** Request body of correct / correct-preview, given the normal create body of the type. */
export interface CorrectionRequest<B extends { businessDate: string }> { reason: string; replacement: WithOptionalDate<B> }

/** JSON schema of the replacement: the normal create schema with `businessDate` no longer required (G5). */
export function optionalDate(createSchema: { required: readonly string[]; [k: string]: unknown }): object {
  return { ...createSchema, required: createSchema.required.filter((k) => k !== 'businessDate') };
}

/** What a route sends back: HTTP status and JSON body. */
export interface CorrectionReply { status: 200 | 201; body: Record<string, unknown> }

interface Adapter<Rec extends { id: number; businessDate: string }, B extends { businessDate: string; clientRef: string }> {
  entity: CorrectionEntity;
  /** Status of the original; null when missing. May refuse an unsupported variant with 409 CORRECTION_NOT_SUPPORTED. */
  statusOf: (conn: DatabaseSync, id: number) => 'posted' | 'void' | null;
  notFound: () => never;
  load: (ctx: AppContext, id: number) => Rec;
  voidIt: (ctx: AppContext, id: number, reason: string) => { record: Rec; warnings: unknown[] };
  createIt: (ctx: AppContext, body: B) => { record: Rec; created: boolean; warnings: unknown[]; funds?: FundsSummary };
  /** Ice Cream only: the current funds summary (used for a replayed request). */
  fundsNow?: (ctx: AppContext) => FundsSummary;
}

/** Warnings of the void followed by those of the create, without duplicates. */
function mergeWarnings(...lists: unknown[][]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const w of lists.flat()) {
    const key = JSON.stringify(w);
    if (!seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

interface Captured<Rec> { original?: Rec; voidWarnings: unknown[]; funds?: FundsSummary }
interface Made<Rec> { record: Rec; warnings: unknown[]; funds?: FundsSummary }

function stepsOf<Rec extends { id: number; businessDate: string }, B extends { businessDate: string; clientRef: string }>(
  ctx: AppContext, a: Adapter<Rec, B>, id: number, req: CorrectionRequest<B>, cap: Captured<Rec>,
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
      cap.original = r.record;
      cap.voidWarnings = r.warnings;
      return r;
    },
    createReplacement: (): Made<Rec> => {
      // G5: the date defaults to the ORIGINAL's business date (the void keeps it, so reading it now is the same).
      const date = req.replacement.businessDate ?? a.load(ctx, id).businessDate;
      const made = a.createIt(ctx, { ...req.replacement, businessDate: date } as unknown as B);
      if (!made.created) {
        // The reference belongs to a record that already existed: never link a correction to that.
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
      }
      const out: Made<Rec> = { record: made.record, warnings: made.warnings };
      if (made.funds !== undefined) out.funds = made.funds;
      return out;
    },
    replacementIdOf: (m: Made<Rec>) => m.record.id,
  };
}

function check<Rec extends { id: number; businessDate: string }, B extends { businessDate: string; clientRef: string }>(
  ctx: AppContext, a: Adapter<Rec, B>, id: number,
): Eligibility {
  return checkCorrectable(ctx, {
    originalId: id, statusOf: a.statusOf, notFound: a.notFound,
    voidOriginal: (reason: string) => a.voidIt(ctx, id, reason),
  });
}

function preview<Rec extends { id: number; businessDate: string }, B extends { businessDate: string; clientRef: string }>(
  ctx: AppContext, a: Adapter<Rec, B>, id: number, req: CorrectionRequest<B>,
): Record<string, unknown> {
  const cap: Captured<Rec> = { voidWarnings: [] };
  const { replacement } = previewCorrection(ctx, stepsOf(ctx, a, id, req, cap));
  const body: Record<string, unknown> = {
    original: cap.original, replacement: replacement.record, warnings: mergeWarnings(cap.voidWarnings, replacement.warnings),
  };
  if (replacement.funds !== undefined) body.funds = replacement.funds;
  return body;
}

function correct<Rec extends { id: number; businessDate: string }, B extends { businessDate: string; clientRef: string }>(
  ctx: AppContext, a: Adapter<Rec, B>, id: number, req: CorrectionRequest<B>,
): CorrectionReply {
  const cap: Captured<Rec> = { voidWarnings: [] };
  const res = applyCorrection(ctx, stepsOf(ctx, a, id, req, cap));
  const link: CorrectionLink = res.correction;
  if (res.replayed || res.replacement === null) {
    // Replay (G7): the stored result, no second void.
    const body: Record<string, unknown> = {
      original: a.load(ctx, link.originalId), replacement: a.load(ctx, link.replacementId), correction: link, warnings: [],
    };
    if (a.fundsNow) body.funds = a.fundsNow(ctx);
    return { status: 200, body };
  }
  const body: Record<string, unknown> = {
    original: cap.original, replacement: res.replacement.record, correction: link,
    warnings: mergeWarnings(cap.voidWarnings, res.replacement.warnings),
  };
  if (res.replacement.funds !== undefined) body.funds = res.replacement.funds;
  return { status: 201, body };
}

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

const topupAdapter: Adapter<Topup, TopupCreate> = {
  entity: 'telecom_topups',
  statusOf: (conn, id) => getTopupRow(conn, id)?.status ?? null,
  notFound: () => { throw notFound('Top-up'); },
  load: (ctx, id) => getTopup(ctx, id),
  voidIt: (ctx, id, reason) => ({ record: voidTopup(ctx, id, { reason }), warnings: [] }),
  createIt: (ctx, body) => { const r = createTopup(ctx, body); return { record: r.item, created: r.created, warnings: r.warnings }; },
};

const supplyAdapter: Adapter<PrintingSupply, Parameters<typeof createSupply>[1]> = {
  entity: 'printing_supplies',
  statusOf: (conn, id) => getSupplyRow(conn, id)?.status ?? null,
  notFound: () => { throw notFound('Printing supply'); },
  load: (ctx, id) => getSupply(ctx, id),
  voidIt: (ctx, id, reason) => ({ record: voidSupply(ctx, id, { reason }), warnings: [] }),
  createIt: (ctx, body) => { const r = createSupply(ctx, body); return { record: r.item, created: r.created, warnings: r.warnings }; },
};

// The Ice Cream services keep their record mappers private; these two mirror `toPayment` / `toMove` (the tests compare a replayed
// record with the one the list endpoint returns, so any drift is caught).
function paymentOf(r: PaymentRow): IcePayment {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt), kind: r.kind,
    fund: r.fund, amountCents: r.amountCents, category: r.category, description: r.description,
    pnlTreatment: pnlTreatment(r.kind, r.fund), status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function moveOf(r: MoveRow): IceMove {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    fromFund: r.fromFund, toFund: r.toFund, amountCents: r.amountCents, kind: moveKind(r.fromFund, r.toFund),
    profitEffectCents: r.profitEffectCents, chargeRelabelCents: r.chargeRelabelCents, cashOnlyCents: r.cashOnlyCents, note: r.note,
    status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

const paymentAdapter: Adapter<IcePayment, IcePaymentCreate> = {
  entity: 'icecream_payments',
  statusOf: (conn, id) => getPayment(conn, id)?.status ?? null,
  notFound: () => { throw notFound('Payment'); },
  load: (ctx, id) => {
    const r = getPayment(ctx.database.conn, id);
    if (!r) throw notFound('Payment');
    return paymentOf(r);
  },
  voidIt: (ctx, id, reason) => { const r = voidPayment(ctx, id, { reason }); return { record: r.payment, warnings: r.warnings }; },
  createIt: (ctx, body) => {
    const r = createPayment(ctx, body);
    return { record: r.payment, created: r.created, warnings: r.warnings, funds: r.funds };
  },
  fundsNow: (ctx) => writeExtras(ctx.database.conn, false).funds,
};

const moveAdapter: Adapter<IceMove, IceMoveCreate> = {
  entity: 'icecream_fund_moves',
  statusOf: (conn, id) => getMove(conn, id)?.status ?? null,
  notFound: () => { throw notFound('Fund move'); },
  load: (ctx, id) => {
    const r = getMove(ctx.database.conn, id);
    if (!r) throw notFound('Fund move');
    return moveOf(r);
  },
  voidIt: (ctx, id, reason) => { const r = voidMove(ctx, id, { reason }); return { record: r.move, warnings: r.warnings }; },
  createIt: (ctx, body) => {
    const r = createMove(ctx, body);
    return { record: r.move, created: r.created, warnings: r.warnings, funds: r.funds };
  },
  fundsNow: (ctx) => writeExtras(ctx.database.conn, false).funds,
};

const lossAdapter: Adapter<StockLoss, StockLossCreate> = {
  entity: 'stock_losses',
  statusOf: (conn, id) => {
    const row = getStockLossRow(conn, id);
    if (!row) return null;
    // A loss written by a damaged sales return belongs to that return: it is refused here, before any void is attempted.
    if (row.source === 'damaged_return') {
      throw new AppError(409, 'CORRECTION_NOT_SUPPORTED',
        'This loss comes from a damaged sales return. Correct it by changing the sales return, not here.');
    }
    return row.status;
  },
  notFound: () => { throw notFound('Stock loss'); },
  load: (ctx, id) => getStockLoss(ctx, id),
  voidIt: (ctx, id, reason) => ({ record: voidStockLoss(ctx, id, { reason }), warnings: [] }),
  createIt: (ctx, body) => { const r = createStockLoss(ctx, body); return { record: r.item, created: r.created, warnings: [] }; },
};

// ---------------------------------------------------------------------------------------------
// Public functions (one trio per type)
// ---------------------------------------------------------------------------------------------

export const checkTopupCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, topupAdapter, id);
export const previewTopupCorrection = (ctx: AppContext, id: number, req: CorrectionRequest<TopupCreate>) => preview(ctx, topupAdapter, id, req);
export const correctTopup = (ctx: AppContext, id: number, req: CorrectionRequest<TopupCreate>) => correct(ctx, topupAdapter, id, req);

type SupplyCreate = Parameters<typeof createSupply>[1];
export const checkSupplyCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, supplyAdapter, id);
export const previewSupplyCorrection = (ctx: AppContext, id: number, req: CorrectionRequest<SupplyCreate>) => preview(ctx, supplyAdapter, id, req);
export const correctSupply = (ctx: AppContext, id: number, req: CorrectionRequest<SupplyCreate>) => correct(ctx, supplyAdapter, id, req);

export const checkIcePaymentCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, paymentAdapter, id);
export const previewIcePaymentCorrection = (ctx: AppContext, id: number, req: CorrectionRequest<IcePaymentCreate>) => preview(ctx, paymentAdapter, id, req);
export const correctIcePayment = (ctx: AppContext, id: number, req: CorrectionRequest<IcePaymentCreate>) => correct(ctx, paymentAdapter, id, req);

export const checkIceMoveCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, moveAdapter, id);
export const previewIceMoveCorrection = (ctx: AppContext, id: number, req: CorrectionRequest<IceMoveCreate>) => preview(ctx, moveAdapter, id, req);
export const correctIceMove = (ctx: AppContext, id: number, req: CorrectionRequest<IceMoveCreate>) => correct(ctx, moveAdapter, id, req);

export const checkStockLossCorrection = (ctx: AppContext, id: number): Eligibility => check(ctx, lossAdapter, id);
export const previewStockLossCorrection = (ctx: AppContext, id: number, req: CorrectionRequest<StockLossCreate>) => preview(ctx, lossAdapter, id, req);
export const correctStockLoss = (ctx: AppContext, id: number, req: CorrectionRequest<StockLossCreate>) => correct(ctx, lossAdapter, id, req);
