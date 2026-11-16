/**
 * services/sales-correction.ts - "correct this entry" for POS sales (Phase 1 correction contract).
 *
 * Layer: service (route -> SERVICE -> repository -> database). It only wires the EXISTING `voidSale` and the EXISTING `createSales`
 * into the shared `correction.ts` helper; no accounting rule, guard, formula or error code lives here and nothing is recomputed:
 *  - the replacement is the normal POS body (`businessDate` optional, default = the ORIGINAL sale's date, G5);
 *  - a sale can only be corrected into a sale of the SAME book: a body whose lines would make more than one sale, or a sale of the
 *    other book, is refused 400 VALIDATION_ERROR (and nothing is saved);
 *  - a replacement `clientRef` that already belongs to an existing sale is refused 409 CLIENT_REF_CONFLICT (never linked);
 *  - the `comparison` object only READS the frozen figures of the original and of the replacement (weighted-average cost can differ
 *    when stock was bought or sold in between; the replacement uses the live average, C5).
 * Sales with posted returns are refused by the existing void (409 HAS_RETURNS).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getProduct } from '../repositories/products.repo.ts';
import { getSale as getSaleRow } from '../repositories/sales.repo.ts';
import type { CashWarning } from './cash-warnings.ts';
import { applyCorrection, checkCorrectable, previewCorrection } from './correction.ts';
import type { CorrectionLink, CorrectionSteps, Eligibility } from './correction.ts';
import { loadSale, unitCostOf } from './sales-common.ts';
import type { Sale } from './sales-common.ts';
import { createSales, voidSale } from './sales.service.ts';
import type { SaleCartLine, SaleWarning } from './sales.service.ts';
import { notFound, validationError } from './validation.ts';

/** The replacement body: the normal POS body, but `businessDate` is optional (default: the original sale's date). */
export interface SaleCorrectionBody {
  reason: string;
  replacement: { businessDate?: string; items: SaleCartLine[]; notes?: string; clientRef: string };
}

/** Per product: the automatic unit cost snapshot of the original and of the replacement (null when the product is on one side only). */
export interface ComparisonLine { productId: number; originalUnitCostCents: number | null; replacementUnitCostCents: number | null }

/** Original versus replacement, read from the frozen sale figures (nothing is recomputed). */
export interface SaleComparison {
  originalCogsCents: number; replacementCogsCents: number; cogsDifferenceCents: number;
  originalExtraCostCents: number; replacementExtraCostCents: number; extraCostDifferenceCents: number;
  originalRevenueCents: number; replacementRevenueCents: number;
  lines: ComparisonLine[];
}

export type SaleWarningOrCash = SaleWarning | CashWarning;

export interface SaleCorrectionPreview { original: Sale; replacement: Sale; warnings: SaleWarningOrCash[]; comparison: SaleComparison }
export interface SaleCorrectionResult extends SaleCorrectionPreview { correction: CorrectionLink; replayed: boolean }

/** Unit cost snapshot per product (several lines of one product: total cost / total quantity, the same rounding the lines use). */
function unitCostsByProduct(sale: Sale): Map<number, number> {
  const agg = new Map<number, { cogs: number; qty: number }>();
  for (const i of sale.items) {
    const a = agg.get(i.productId) ?? { cogs: 0, qty: 0 };
    a.cogs += i.cogsCents; a.qty += i.qty;
    agg.set(i.productId, a);
  }
  return new Map([...agg].map(([id, a]) => [id, unitCostOf(a.cogs, a.qty)]));
}

/** Builds the comparison from two sales (pure reads). */
export function compareSales(original: Sale, replacement: Sale): SaleComparison {
  const o = unitCostsByProduct(original);
  const r = unitCostsByProduct(replacement);
  const ids = [...new Set([...o.keys(), ...r.keys()])];
  return {
    originalCogsCents: original.cogsCents, replacementCogsCents: replacement.cogsCents,
    cogsDifferenceCents: replacement.cogsCents - original.cogsCents,
    originalExtraCostCents: original.extraCostCents, replacementExtraCostCents: replacement.extraCostCents,
    extraCostDifferenceCents: replacement.extraCostCents - original.extraCostCents,
    originalRevenueCents: original.totalCents, replacementRevenueCents: replacement.totalCents,
    lines: ids.map((productId) => ({
      productId, originalUnitCostCents: o.get(productId) ?? null, replacementUnitCostCents: r.get(productId) ?? null,
    })),
  };
}

/** De-duplicates warnings (the void and the create may both report the same cash book). */
function mergeWarnings(...lists: SaleWarningOrCash[][]): SaleWarningOrCash[] {
  const seen = new Set<string>();
  const out: SaleWarningOrCash[] = [];
  for (const w of lists.flat()) {
    const key = JSON.stringify(w);
    if (!seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

type Created = ReturnType<typeof createSales>;

interface Captured { before: Sale | null; voided: Sale | null; voidWarnings: CashWarning[]; created: Created | null }

/** The steps handed to the shared helper. `cap` collects what the existing services returned (for the response). */
function buildSteps(ctx: AppContext, id: number, body: SaleCorrectionBody, cap: Captured): CorrectionSteps<Created> {
  const statusOf = (conn: DatabaseSync, sid: number): 'posted' | 'void' | null => getSaleRow(conn, sid)?.status ?? null;
  return {
    entity: 'sales', originalId: id, reason: body.reason, replacementClientRef: body.replacement.clientRef,
    statusOf,
    notFound: () => { throw notFound('Sale'); },
    voidOriginal: (reason) => {
      cap.before = loadSale(ctx.database.conn, id);
      const v = voidSale(ctx, id, { reason });
      cap.voided = v.item; cap.voidWarnings = v.warnings;
      return v;
    },
    createReplacement: () => {
      const original = cap.before as Sale;
      const rep = body.replacement;
      assertSameBook(ctx.database.conn, rep.items, original);
      const create = {
        businessDate: rep.businessDate ?? original.businessDate, items: rep.items, clientRef: rep.clientRef,
        ...(rep.notes === undefined ? {} : { notes: rep.notes }),
      };
      const created = createSales(ctx, create);
      // A repeated clientRef of an EXISTING sale answers with that sale and creates nothing: never link a correction to it.
      if (!created.created) throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
      if (created.sales.length !== 1 || created.sales[0]?.book !== original.book) throw wrongBook(original.book);
      cap.created = created;
      return created;
    },
    replacementIdOf: (c) => (c.sales[0] as Sale).id,
  };
}

function wrongBook(book: string): AppError {
  return validationError({ items: `A correction must contain only ${book === 'shop' ? 'Shop' : 'Telecom'} products, like the original sale.` });
}

/** Refuses a cart that has a product of another book than the original sale (unknown products are left to the create's own check). */
function assertSameBook(conn: DatabaseSync, items: SaleCartLine[], original: Sale): void {
  const fields: Record<string, string> = {};
  items.forEach((l, i) => {
    const p = getProduct(conn, l.productId);
    if (p && p.book !== original.book) fields[`items.${i}.productId`] = `${p.name} is not a ${original.book === 'shop' ? 'Shop' : 'Telecom'} product.`;
  });
  if (Object.keys(fields).length > 0) {
    throw validationError({ items: `A correction must contain only ${original.book === 'shop' ? 'Shop' : 'Telecom'} products, like the original sale.`, ...fields });
  }
}

/** GET /sales/:id/correct-check - the existing void's own answer; saves nothing. @throws AppError 404 */
export function checkSaleCorrectable(ctx: AppContext, id: number): Eligibility {
  const cap: Captured = { before: null, voided: null, voidWarnings: [], created: null };
  const s = buildSteps(ctx, id, { reason: 'Eligibility check', replacement: { items: [], clientRef: 'check' } }, cap);
  return checkCorrectable(ctx, s);
}

/** POST /sales/:id/correct-preview - a whole dry run (rolled back). @throws the same AppErrors as the real correction */
export function previewSaleCorrection(ctx: AppContext, id: number, body: SaleCorrectionBody): SaleCorrectionPreview {
  const cap: Captured = { before: null, voided: null, voidWarnings: [], created: null };
  const { replacement } = previewCorrection(ctx, buildSteps(ctx, id, body, cap));
  return {
    original: cap.voided as Sale, replacement: replacement.sales[0] as Sale,
    warnings: mergeWarnings(cap.voidWarnings, replacement.warnings), comparison: compareSales(cap.before as Sale, replacement.sales[0] as Sale),
  };
}

/** POST /sales/:id/correct - void + create + link in ONE transaction; a repeated replacement clientRef replays the first result. */
export function correctSale(ctx: AppContext, id: number, body: SaleCorrectionBody): SaleCorrectionResult {
  const cap: Captured = { before: null, voided: null, voidWarnings: [], created: null };
  const result = applyCorrection(ctx, buildSteps(ctx, id, body, cap));
  const conn = ctx.database.conn;
  if (result.replayed) {
    const original = loadSale(conn, result.correction.originalId);
    const replacement = loadSale(conn, result.correction.replacementId);
    // The original's lines are frozen, so the comparison of a replay equals the first answer.
    return { replayed: true, correction: result.correction, original, replacement, warnings: [], comparison: compareSales(original, replacement) };
  }
  const replacement = (result.replacement as Created).sales[0] as Sale;
  return {
    replayed: false, correction: result.correction, original: loadSale(conn, id), replacement,
    warnings: mergeWarnings(cap.voidWarnings, (result.replacement as Created).warnings),
    comparison: compareSales(cap.before as Sale, replacement),
  };
}
