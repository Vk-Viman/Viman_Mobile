/**
 * services/correction-cash.ts - "correct this entry" for expenses, cash transfers, capital entries and cash drawings.
 *
 * Layer: service (route -> SERVICE -> existing services). Contract: API_CONTRACTS.md "Correction contract, Phase 1".
 * Each type is corrected by the EXISTING void function + the EXISTING create function inside ONE transaction
 * (`applyCorrection` / `previewCorrection` / `checkCorrectable` from correction.ts). Nothing here re-implements a rule: every
 * guard (R9 closed day, backdating, E2 electricity, USE_ICECREAM_PAYMENTS, SAME_BOOK, fund rules 10.2, R13 warnings ...)
 * is decided by the unchanged void/create services. This file only adapts them to the correction helper:
 *  - the replacement body is the normal create body, `businessDate` optional (defaults to the original's date, G5);
 *  - a variant that cannot be corrected in Phase 1 (opening balance, goods drawing) is refused 409 CORRECTION_NOT_SUPPORTED
 *    BEFORE the void is attempted;
 *  - a create that answered with an already-existing record (`created: false`) is a clientRef clash, never a correction;
 *  - warnings of the void and of the create are merged and de-duplicated.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { applyCorrection, checkCorrectable, previewCorrection } from './correction.ts';
import type { CorrectionEntity, CorrectionLink, Eligibility } from './correction.ts';
import type { CashWarning } from './cash-warnings.ts';
import { createExpense, getExpense, voidExpense } from './expenses.service.ts';
import type { Expense, ExpenseCreate } from './expenses.service.ts';
import { createTransfer, getTransfer, voidTransfer } from './cash-transfers.service.ts';
import type { Transfer, TransferCreate } from './cash-transfers.service.ts';
import { createCapital, getCapitalEntry } from './capital.service.ts';
import type { CapitalCreate, CapitalEntry } from './capital.service.ts';
import { voidCapitalEntry } from './opening-balance.service.ts';
import { createDrawing, getDrawing, voidDrawing } from './drawings.service.ts';
import type { Drawing, DrawingCreate } from './drawings.service.ts';
import { validationError } from './validation.ts';
import type { StoredSegment } from './segments.ts';

/** 13D: the replacement keeps the original's real segment unless the caller names one; `legacy` is never carried over. */
function keepSegment(original: StoredSegment | null, replacementBook: string | undefined, supplied: StoredSegment | undefined): StoredSegment | undefined {
  if (supplied !== undefined) return supplied;
  if (replacementBook === 'telecom' && original !== null && original !== 'legacy') return original;
  return undefined;
}

/** The replacement body: the normal create body with `businessDate` optional. */
export type Replacement<C extends { businessDate: string }> = Omit<C, 'businessDate'> & { businessDate?: string };

/** Body of correct / correct-preview. */
export interface CorrectionRequest<C extends { businessDate: string }> { reason: string; replacement: Replacement<C> }

/** Answer of preview. */
export interface CorrectionPreview<T> { original: T; replacement: T; warnings: CashWarning[]; comparison?: unknown }

/** Answer of a real correction (`replayed` = the same replacement clientRef was already applied; the route answers 200 then). */
export interface CorrectionApplied<T> extends CorrectionPreview<T> { correction: CorrectionLink; replayed: boolean }

interface Adapter<T extends { id: number; status: 'posted' | 'void'; businessDate: string }, C extends { businessDate: string }> {
  entity: CorrectionEntity;
  /** The record, or null when it does not exist. */
  find: (ctx: AppContext, id: number) => T | null;
  /** Throws 409 CORRECTION_NOT_SUPPORTED for a variant that is not correctable in Phase 1 (called before the void). */
  assertSupported: (original: T) => void;
  /** Optional (Phase 2): refuses a replacement that does not fit the original (e.g. another drawing kind); called before the void. */
  assertReplacement?: (original: T, replacement: Replacement<C>) => void;
  /** Optional (13D): fills the segment field(s) the caller left out from the original (corrections keep the segment by default). */
  withSegments?: (original: T, replacement: Replacement<C>) => Replacement<C>;
  /** Optional (Phase 2): the `comparison` of the answer; undefined = none. */
  compare?: (original: T, replacement: T) => unknown;
  /** Calls the existing void; returns the voided record and any warnings it produced. */
  voidIt: (ctx: AppContext, id: number, reason: string) => { item: T; warnings: CashWarning[] };
  /** Calls the existing create. */
  create: (ctx: AppContext, body: C) => { item: T; warnings: CashWarning[]; created: boolean };
  notFoundMessage: string;
}

function notFoundError(message: string): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

function unsupported(message: string): AppError {
  return new AppError(409, 'CORRECTION_NOT_SUPPORTED', message);
}

/** Merges warning lists, dropping exact duplicates (same code, book, fund, balance and message). */
function mergeWarnings(...lists: CashWarning[][]): CashWarning[] {
  const seen = new Set<string>();
  const out: CashWarning[] = [];
  for (const w of lists.flat()) {
    const key = JSON.stringify([w.code, w.book, w.fund ?? null, w.balanceCents, w.message]);
    if (!seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

function build<T extends { id: number; status: 'posted' | 'void'; businessDate: string }, C extends { businessDate: string; clientRef: string }>(
  a: Adapter<T, C>,
) {
  /** The steps of one correction; captures what the void and the create returned. */
  function steps(ctx: AppContext, id: number, reason: string, replacement: Replacement<C> | null) {
    const captured: { original?: T; replacement?: T; voidWarnings: CashWarning[]; createWarnings: CashWarning[] } = {
      voidWarnings: [], createWarnings: [],
    };
    const base = {
      entity: a.entity,
      originalId: id,
      reason,
      replacementClientRef: replacement?.clientRef ?? '',
      statusOf: (_conn: unknown, rid: number) => a.find(ctx, rid)?.status ?? null,
      notFound: (): never => { throw notFoundError(a.notFoundMessage); },
      voidOriginal: (r: string) => {
        const current = a.find(ctx, id);
        if (current) a.assertSupported(current); // refused BEFORE the void is attempted
        if (current && replacement !== null && a.assertReplacement) a.assertReplacement(current, replacement);
        const v = a.voidIt(ctx, id, r);
        captured.original = v.item;
        captured.voidWarnings = v.warnings;
        return v;
      },
      createReplacement: (): T => {
        if (replacement === null) throw new Error('A replacement body is required');
        const date = captured.original?.businessDate as string; // G5: defaults to the original's business date
        const filled = a.withSegments && captured.original ? a.withSegments(captured.original, replacement) : replacement;
        const body = { ...filled, businessDate: replacement.businessDate ?? date } as unknown as C;
        const c = a.create(ctx, body);
        if (!c.created) {
          // The reference belongs to an existing record: never link a correction to it.
          throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
        }
        captured.replacement = c.item;
        captured.createWarnings = c.warnings;
        return c.item;
      },
      replacementIdOf: (t: T) => t.id,
    };
    return { base, captured };
  }

  /** `{ comparison }` when the type has one, else `{}` (so Phase 1 answers keep exactly their old keys). */
  const cmp = (original: T, replacement: T): { comparison?: unknown } => {
    const c = a.compare?.(original, replacement);
    return c === undefined ? {} : { comparison: c };
  };

  return {
    check(ctx: AppContext, id: number): Eligibility {
      const { base } = steps(ctx, id, 'Eligibility check', null);
      return checkCorrectable(ctx, base);
    },
    preview(ctx: AppContext, id: number, req: CorrectionRequest<C>): CorrectionPreview<T> {
      const { base, captured } = steps(ctx, id, req.reason, req.replacement);
      previewCorrection(ctx, base);
      return {
        original: captured.original as T, replacement: captured.replacement as T,
        warnings: mergeWarnings(captured.voidWarnings, captured.createWarnings),
        ...cmp(captured.original as T, captured.replacement as T),
      };
    },
    apply(ctx: AppContext, id: number, req: CorrectionRequest<C>): CorrectionApplied<T> {
      const { base, captured } = steps(ctx, id, req.reason, req.replacement);
      const r = applyCorrection(ctx, base);
      if (r.replayed) {
        const original = a.find(ctx, r.correction.originalId) as T;
        const replacement = a.find(ctx, r.correction.replacementId) as T;
        return { replayed: true, correction: r.correction, original, replacement, warnings: [], ...cmp(original, replacement) };
      }
      return {
        replayed: false, correction: r.correction, original: captured.original as T, replacement: captured.replacement as T,
        warnings: mergeWarnings(captured.voidWarnings, captured.createWarnings),
        ...cmp(captured.original as T, captured.replacement as T),
      };
    },
  };
}

function findOrNull<T>(fn: () => T): T | null {
  try { return fn(); } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}

const expenses = build<Expense, ExpenseCreate>({
  entity: 'expenses',
  find: (ctx, id) => findOrNull(() => getExpense(ctx, id)),
  assertSupported: () => {},
  withSegments: (o, r) => {
    const segment = keepSegment(o.segment, r.book, r.segment);
    return segment === undefined ? r : { ...r, segment };
  },
  voidIt: (ctx, id, reason) => ({ item: voidExpense(ctx, id, { reason }), warnings: [] }),
  create: createExpense,
  notFoundMessage: 'Expense not found.',
});

const transfers = build<Transfer, TransferCreate>({
  entity: 'cash_transfers',
  find: (ctx, id) => findOrNull(() => getTransfer(ctx, id)),
  assertSupported: () => {},
  withSegments: (o, r) => {
    const fromSegment = keepSegment(o.fromSegment, r.fromBook, r.fromSegment);
    const toSegment = keepSegment(o.toSegment, r.toBook, r.toSegment);
    return { ...r, ...(fromSegment !== undefined ? { fromSegment } : {}), ...(toSegment !== undefined ? { toSegment } : {}) };
  },
  voidIt: (ctx, id, reason) => voidTransfer(ctx, id, { reason }),
  create: createTransfer,
  notFoundMessage: 'Transfer not found.',
});

const capital = build<CapitalEntry, CapitalCreate>({
  entity: 'capital_entries',
  find: (ctx, id) => findOrNull(() => getCapitalEntry(ctx, id)),
  assertSupported: (e) => {
    if (e.kind !== 'capital') {
      throw unsupported('Only capital entries can be corrected here. An opening balance is changed by voiding it and setting it again.');
    }
  },
  withSegments: (o, r) => {
    const segment = keepSegment(o.segment, r.book, r.segment);
    return segment === undefined ? r : { ...r, segment };
  },
  voidIt: (ctx, id, reason) => voidCapitalEntry(ctx, id, { reason }),
  create: createCapital,
  notFoundMessage: 'Capital entry not found.',
});

const drawings = build<Drawing, DrawingCreate>({
  entity: 'owner_drawings',
  find: (ctx, id) => findOrNull(() => getDrawing(ctx, id)),
  assertSupported: () => {}, // Phase 2: goods drawings are correctable too (the replacement must keep the kind)
  assertReplacement: (d, r) => {
    if (r.kind !== d.kind) throw validationError({ 'replacement.kind': `The replacement must be a ${d.kind} drawing, like the original.` });
  },
  withSegments: (o, r) => {
    // Cash drawings only; a goods drawing's segment follows its product (package F).
    if (o.kind !== 'cash' || r.kind !== 'cash') return r;
    const segment = keepSegment(o.segment, r.book, r.segment);
    return segment === undefined ? r : { ...r, segment };
  },
  compare: (o, r) => (o.kind === 'goods'
    ? { originalCostCents: o.amountCents, replacementCostCents: r.amountCents, differenceCents: r.amountCents - o.amountCents }
    : undefined),
  voidIt: (ctx, id, reason) => ({ item: voidDrawing(ctx, id, { reason }), warnings: [] }),
  create: createDrawing,
  notFoundMessage: 'Drawing not found.',
});

export const expenseCorrection = expenses;
export const transferCorrection = transfers;
export const capitalCorrection = capital;
export const drawingCorrection = drawings;

/** The three operations of one correctable type. */
export interface CashCorrection<T, C extends { businessDate: string }> {
  check: (ctx: AppContext, id: number) => Eligibility;
  preview: (ctx: AppContext, id: number, req: CorrectionRequest<C>) => CorrectionPreview<T>;
  apply: (ctx: AppContext, id: number, req: CorrectionRequest<C>) => CorrectionApplied<T>;
}

/**
 * Registers `GET /<resource>/:id/correct-check`, `POST /<resource>/:id/correct-preview` and `POST /<resource>/:id/correct`.
 * `bodySchema` is `correctionBodySchema(<create schema, businessDate optional>)`; `idParams` the numeric id schema.
 */
export function registerCorrectionEndpoints<T, C extends { businessDate: string }>(
  app: FastifyInstance, ctx: AppContext, resource: string, ops: CashCorrection<T, C>, bodySchema: object, idParams: object,
): void {
  const id = (params: unknown): number => Number((params as { id: string }).id);
  app.get(`/${resource}/:id/correct-check`, { schema: { params: idParams } }, async (request) =>
    ops.check(ctx, id(request.params)));
  app.post(`/${resource}/:id/correct-preview`, { schema: { params: idParams, body: bodySchema } }, async (request) =>
    ops.preview(ctx, id(request.params), request.body as CorrectionRequest<C>));
  app.post(`/${resource}/:id/correct`, { schema: { params: idParams, body: bodySchema } }, async (request, reply) => {
    const { replayed, ...result } = ops.apply(ctx, id(request.params), request.body as CorrectionRequest<C>);
    return reply.code(replayed ? 200 : 201).send(result);
  });
}
