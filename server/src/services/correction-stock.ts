/**
 * services/correction-stock.ts - "correct this entry" for supplier purchases (Phase 2; goods personal use lives in correction-cash.ts
 * next to the cash drawings because both share the `/drawings` endpoints).
 *
 * Layer: service (route -> SERVICE -> existing services). Contract: API_CONTRACTS.md "Correction contract, Phase 2".
 * A purchase is corrected by the EXISTING `voidPurchase` + the EXISTING `createPurchase` inside ONE transaction
 * (`applyCorrection` / `previewCorrection` / `checkCorrectable`). Nothing here re-implements a rule: HAS_RETURNS, INSUFFICIENT_STOCK
 * (part of the goods already sold), R9 closed day, backdating, R11 one book, MIXED_SEGMENTS, supplier / product guards and the negative-cash
 * warning are all decided by the unchanged void/create services. Consequences that come from those rules, not from this file:
 *  - the void removes the old units at min(line cost, pool value) (R4) and the create receives the new ones at the new line totals,
 *    so the weighted average of every product on the bill changes from that point on; earlier sale snapshots stay;
 *  - the replacement is posted AFTER the void, so its stock movements get new, later ids.
 */
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { applyCorrection, checkCorrectable, previewCorrection } from './correction.ts';
import type { Eligibility } from './correction.ts';
import type { CashWarning } from './cash-warnings.ts';
import type { CashCorrection, CorrectionApplied, CorrectionPreview, CorrectionRequest, Replacement } from './correction-cash.ts';
import { createPurchase, getPurchase, voidPurchase } from './purchases.service.ts';
import type { Purchase, PurchaseCreate } from './purchases.service.ts';

/** `comparison` of a purchase correction. Lines are summed per product (a product may be on several lines). */
export interface PurchaseComparison {
  originalTotalCents: number; replacementTotalCents: number; differenceTotalCents: number;
  lines: Array<{
    productId: number; originalQty: number; replacementQty: number; originalLineTotalCents: number; replacementLineTotalCents: number;
  }>;
}

/** Builds the purchase comparison: original bill vs replacement bill, per product (units and exact line totals). */
export function comparePurchases(original: Purchase, replacement: Purchase): PurchaseComparison {
  const byProduct = new Map<number, PurchaseComparison['lines'][number]>();
  const line = (productId: number) => {
    let l = byProduct.get(productId);
    if (!l) { l = { productId, originalQty: 0, replacementQty: 0, originalLineTotalCents: 0, replacementLineTotalCents: 0 }; byProduct.set(productId, l); }
    return l;
  };
  for (const i of original.items) { const l = line(i.productId); l.originalQty += i.units; l.originalLineTotalCents += i.lineTotalCents; }
  for (const i of replacement.items) { const l = line(i.productId); l.replacementQty += i.units; l.replacementLineTotalCents += i.lineTotalCents; }
  return {
    originalTotalCents: original.totalCents, replacementTotalCents: replacement.totalCents,
    differenceTotalCents: replacement.totalCents - original.totalCents,
    lines: [...byProduct.values()],
  };
}

function findPurchase(ctx: AppContext, id: number): Purchase | null {
  try { return getPurchase(ctx, id); } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}

/** The steps of one correction; captures what the void and the create returned. */
function steps(ctx: AppContext, id: number, reason: string, replacement: Replacement<PurchaseCreate> | null) {
  const captured: { original?: Purchase; replacement?: Purchase; createWarnings: CashWarning[] } = { createWarnings: [] };
  const base = {
    entity: 'purchases' as const,
    originalId: id,
    reason,
    replacementClientRef: replacement?.clientRef ?? '',
    statusOf: (_conn: unknown, rid: number) => findPurchase(ctx, rid)?.status ?? null,
    notFound: (): never => { throw new AppError(404, 'NOT_FOUND', 'Purchase not found.'); },
    voidOriginal: (r: string) => {
      const v = voidPurchase(ctx, id, { reason: r }); // HAS_RETURNS, INSUFFICIENT_STOCK, R9 decide
      captured.original = v;
      return v;
    },
    createReplacement: (): Purchase => {
      if (replacement === null) throw new Error('A replacement body is required');
      const date = captured.original?.businessDate as string; // G5: defaults to the original's business date
      const body = { ...replacement, businessDate: replacement.businessDate ?? date } as PurchaseCreate;
      const c = createPurchase(ctx, body);
      if (!c.created) throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
      // 13D: a Telecom purchase is corrected inside its own provider Cards segment (the replacement keeps the original's scope).
      const was = captured.original;
      if (was && was.book === 'telecom' && (c.item.book !== was.book || c.item.segment !== was.segment)) {
        throw new AppError(400, 'SEGMENT_MISMATCH',
          'A Telecom purchase can only be corrected with cards of the same provider (the same segment). Void it and record a new bill instead.',
          { items: 'The replacement must contain cards of the original provider.' });
      }
      captured.replacement = c.item;
      captured.createWarnings = c.warnings;
      return c.item;
    },
    replacementIdOf: (p: Purchase) => p.id,
  };
  return { base, captured };
}

/** Warnings: the void raises none (cash comes back in); the create's negative-cash warnings are de-duplicated. */
function dedupe(list: CashWarning[]): CashWarning[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const key = JSON.stringify([w.code, w.book, w.fund ?? null, w.balanceCents, w.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const purchaseCorrection: CashCorrection<Purchase, PurchaseCreate> = {
  check(ctx: AppContext, id: number): Eligibility {
    return checkCorrectable(ctx, steps(ctx, id, 'Eligibility check', null).base);
  },
  preview(ctx: AppContext, id: number, req: CorrectionRequest<PurchaseCreate>): CorrectionPreview<Purchase> {
    const { base, captured } = steps(ctx, id, req.reason, req.replacement);
    previewCorrection(ctx, base);
    const original = captured.original as Purchase;
    const replacement = captured.replacement as Purchase;
    return { original, replacement, warnings: dedupe(captured.createWarnings), comparison: comparePurchases(original, replacement) };
  },
  apply(ctx: AppContext, id: number, req: CorrectionRequest<PurchaseCreate>): CorrectionApplied<Purchase> {
    const { base, captured } = steps(ctx, id, req.reason, req.replacement);
    const r = applyCorrection(ctx, base);
    if (r.replayed) {
      const original = getPurchase(ctx, r.correction.originalId);
      const replacement = getPurchase(ctx, r.correction.replacementId);
      return { replayed: true, correction: r.correction, original, replacement, warnings: [], comparison: comparePurchases(original, replacement) };
    }
    const original = captured.original as Purchase;
    const replacement = captured.replacement as Purchase;
    return {
      replayed: false, correction: r.correction, original, replacement, warnings: dedupe(captured.createWarnings),
      comparison: comparePurchases(original, replacement),
    };
  },
};
