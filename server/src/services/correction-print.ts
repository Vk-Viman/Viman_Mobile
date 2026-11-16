/**
 * services/correction-print.ts - "correct this entry" for print / service sales (API_CONTRACTS "Correction contract, Phase 2").
 *
 * Layer: service. Glue only: the EXISTING `voidPrintSale` (cash reversal, R9) and the EXISTING `createPrintSale` (R12 snapshot of the
 * service type's CURRENT price and standard cost, R-FD, R9, SERVICE_TYPE_INACTIVE, PRICE_BELOW_COST) run unchanged inside the one
 * transaction of `applyCorrection`. No rule is re-implemented.
 *
 * `comparison` = original vs replacement figures. What can differ: quantity, service type and price (the owner may change them in the
 * replacement); the unit COST snapshot and, when the replacement sends no `unitPriceCents`, the unit price, are those of the service
 * type TODAY (create snapshots the type's current values), so they differ from the original when the type was edited since.
 */
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getPrintSale as getPrintSaleRow } from '../repositories/printing.repo.ts';
import { notFound } from './validation.ts';
import { applyCorrection, checkCorrectable, previewCorrection } from './correction.ts';
import type { Eligibility } from './correction.ts';
import type { CorrectionReply, CorrectionRequest } from './correction-other.ts';
import { createPrintSale, getPrintSale, voidPrintSale } from './printing.service.ts';
import type { PrintSale, PrintSaleCreate } from './printing.service.ts';
import type { CashWarning } from './cash-warnings.ts';

/** Original vs replacement revenue and cost of a corrected print sale (cents). */
export interface PrintComparison {
  originalQty: number; replacementQty: number;
  originalServiceTypeId: number; replacementServiceTypeId: number;
  originalUnitPriceCents: number; replacementUnitPriceCents: number;
  originalUnitCostCents: number; replacementUnitCostCents: number;
  originalRevenueCents: number; replacementRevenueCents: number; revenueDifferenceCents: number;
  originalCogsCents: number; replacementCogsCents: number; cogsDifferenceCents: number;
  originalGrossProfitCents: number; replacementGrossProfitCents: number; grossProfitDifferenceCents: number;
}

export function compare(o: PrintSale, r: PrintSale): PrintComparison {
  return {
    originalQty: o.qty, replacementQty: r.qty,
    originalServiceTypeId: o.serviceTypeId, replacementServiceTypeId: r.serviceTypeId,
    originalUnitPriceCents: o.unitPriceCents, replacementUnitPriceCents: r.unitPriceCents,
    originalUnitCostCents: o.unitCostCents, replacementUnitCostCents: r.unitCostCents,
    originalRevenueCents: o.revenueCents, replacementRevenueCents: r.revenueCents, revenueDifferenceCents: r.revenueCents - o.revenueCents,
    originalCogsCents: o.cogsCents, replacementCogsCents: r.cogsCents, cogsDifferenceCents: r.cogsCents - o.cogsCents,
    originalGrossProfitCents: o.grossProfitCents, replacementGrossProfitCents: r.grossProfitCents,
    grossProfitDifferenceCents: r.grossProfitCents - o.grossProfitCents,
  };
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

type Req = CorrectionRequest<PrintSaleCreate>;
interface Cap { original?: PrintSale; voidWarnings: CashWarning[] }
interface Made { item: PrintSale; warnings: unknown[] }

const statusOf = (conn: Parameters<typeof getPrintSaleRow>[0], id: number) => getPrintSaleRow(conn, id)?.status ?? null;
const notFoundSale = (): never => { throw notFound('Print sale'); };

function steps(ctx: AppContext, id: number, req: Req, cap: Cap) {
  return {
    entity: 'print_sales' as const,
    originalId: id,
    reason: req.reason,
    replacementClientRef: req.replacement.clientRef,
    statusOf,
    notFound: notFoundSale,
    voidOriginal: (reason: string) => {
      const r = voidPrintSale(ctx, id, { reason });
      cap.original = r.item;
      cap.voidWarnings = r.warnings;
      return r;
    },
    createReplacement: (): Made => {
      const date = req.replacement.businessDate ?? getPrintSale(ctx, id).businessDate; // G5
      const made = createPrintSale(ctx, { ...req.replacement, businessDate: date });
      if (!made.created) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
      }
      return { item: made.item, warnings: made.warnings };
    },
    replacementIdOf: (m: Made) => m.item.id,
  };
}

export const checkPrintSaleCorrection = (ctx: AppContext, id: number): Eligibility =>
  checkCorrectable(ctx, { originalId: id, statusOf, notFound: notFoundSale, voidOriginal: (reason: string) => voidPrintSale(ctx, id, { reason }) });

export function previewPrintSaleCorrection(ctx: AppContext, id: number, req: Req): Record<string, unknown> {
  const cap: Cap = { voidWarnings: [] };
  const { replacement } = previewCorrection(ctx, steps(ctx, id, req, cap));
  return {
    original: cap.original, replacement: replacement.item, warnings: mergeWarnings(cap.voidWarnings, replacement.warnings),
    comparison: compare(cap.original!, replacement.item),
  };
}

export function correctPrintSale(ctx: AppContext, id: number, req: Req): CorrectionReply {
  const cap: Cap = { voidWarnings: [] };
  const res = applyCorrection(ctx, steps(ctx, id, req, cap));
  const link = res.correction;
  if (res.replayed || res.replacement === null) {
    const original = getPrintSale(ctx, link.originalId);
    const replacement = getPrintSale(ctx, link.replacementId);
    return { status: 200, body: { original, replacement, correction: link, warnings: [], comparison: compare(original, replacement) } };
  }
  return {
    status: 201,
    body: {
      original: cap.original, replacement: res.replacement.item, correction: link,
      warnings: mergeWarnings(cap.voidWarnings, res.replacement.warnings), comparison: compare(cap.original!, res.replacement.item),
    },
  };
}
