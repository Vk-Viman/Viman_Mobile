/**
 * services/correction.ts - "correct this entry": void the original and enter a replacement as ONE atomic action (migration 022).
 *
 * Layer: service helper used by the per-type correction functions (sales, expenses, transfers, ...). It owns only the glue:
 *  - it calls the EXISTING void service of the type and the EXISTING create service of the type, unchanged, inside ONE
 *    `AppDatabase.tx()` (nested service transactions become savepoints), so every current guard (R9 closed day, backdating order,
 *    HAS_RETURNS, stock availability, R-FD, negative-cash warnings, D2 ...) still decides. Nothing here re-implements a rule;
 *  - if the replacement is refused for ANY reason, the whole transaction rolls back and the original stays posted (G2);
 *  - it writes the append-only link row in `corrections` (reason, original id, replacement id, replacement client reference)
 *    and one audit entry (`correction` / `correct`);
 *  - a repeated request (same replacement `clientRef`) returns the first result instead of correcting again (G7);
 *  - `preview` and `check` run the same steps and then ROLL BACK, so the screen can show the outcome (or the plain-language
 *    refusal) before anything is saved. The preview uses the real services, so it can never disagree with the real thing.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { logAudit } from './audit.service.ts';
import { REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, trimmed } from './validation.ts';
import type { Fields } from './validation.ts';

/** The tables whose records can be corrected (the CHECK list of `corrections.entity`). Phase 1 first, then Phase 2. */
export type CorrectionEntity =
  | 'sales' | 'expenses' | 'cash_transfers' | 'capital_entries' | 'owner_drawings' | 'telecom_topups'
  | 'printing_supplies' | 'icecream_payments' | 'icecream_fund_moves' | 'stock_losses'
  | 'purchases' | 'print_sales' | 'reload_sales' | 'ezcash_sales';

/** One stored link, as the API returns it. */
export interface CorrectionLink {
  id: number; entity: CorrectionEntity; originalId: number; replacementId: number; reason: string; createdAt: string;
}

/** What a type adapter must supply. Every function must call the existing service function of the type (no re-implementation). */
export interface CorrectionSteps<R> {
  entity: CorrectionEntity;
  originalId: number;
  /** The raw correction reason typed by the owner (validated here with the same limits as a void reason). */
  reason: string;
  /** The `clientRef` of the replacement record (required: it is the idempotency key of the correction). */
  replacementClientRef: string;
  /** Current status of the original, or null when it does not exist (the adapter's not-found error is thrown by the caller). */
  statusOf: (conn: DatabaseSync, id: number) => 'posted' | 'void' | null;
  /** Calls the existing `voidX(ctx, id, { reason })`. Throws exactly what that service throws. */
  voidOriginal: (reason: string) => unknown;
  /** Calls the existing `createX(ctx, body)` with the corrected details (the adapter fills the original's date by default, G5). */
  createReplacement: () => R;
  /** The id of the record `createReplacement` created. */
  replacementIdOf: (created: R) => number;
  /** Raises the type's own 404 when the original does not exist. */
  notFound: () => never;
}

/** Result of a real correction. `replayed` is true when the same request had already been applied. */
export interface CorrectionResult<R> {
  replayed: boolean;
  correction: CorrectionLink;
  /** The record created by the replacement step (null on a replay: the caller loads the stored replacement by id). */
  replacement: R | null;
}

/** Thrown inside a dry run to roll everything back; never escapes this module. */
class DryRunRollback<T> extends Error {
  readonly value: T;
  constructor(value: T) { super('dry run'); this.value = value; }
}

interface LinkRow {
  id: number; entity: CorrectionEntity; original_id: number; replacement_id: number; reason: string; client_ref: string; created_at: string;
}

function toLink(r: LinkRow): CorrectionLink {
  return { id: r.id, entity: r.entity, originalId: r.original_id, replacementId: r.replacement_id, reason: r.reason, createdAt: r.created_at };
}

/** The link whose replacement used this client reference, if any. */
function findByClientRef(conn: DatabaseSync, entity: CorrectionEntity, clientRef: string): LinkRow | undefined {
  return conn.prepare('SELECT * FROM corrections WHERE entity = ? AND client_ref = ?').get(entity, clientRef) as unknown as LinkRow | undefined;
}

/** Validates the correction reason with the same limits as a void reason. */
export function correctionReason(raw: string): string {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Correction reason', raw, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);
  return reason;
}

/** The steps shared by apply and preview, executed on an open transaction. */
function runSteps<R>(ctx: AppContext, conn: DatabaseSync, s: CorrectionSteps<R>, reason: string): { link: CorrectionLink; replacement: R } {
  const status = s.statusOf(conn, s.originalId);
  if (status === null) s.notFound();
  if (status === 'void') throw alreadyVoid('record'); // G1: a void record cannot be corrected (enter a new record instead)

  s.voidOriginal(reason); // the existing void: every guard of the type applies and may refuse
  const replacement = s.createReplacement(); // the existing create: every guard applies and may refuse
  const replacementId = s.replacementIdOf(replacement);
  if (!(replacementId > s.originalId)) {
    // The create answered with an older record (a repeated clientRef of some other record): never link to that.
    throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This reference was already used for a different record.');
  }
  const info = conn.prepare(
    'INSERT INTO corrections (entity, original_id, replacement_id, reason, client_ref) VALUES (?, ?, ?, ?, ?)',
  ).run(s.entity, s.originalId, replacementId, reason, s.replacementClientRef);
  const row = conn.prepare('SELECT * FROM corrections WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as LinkRow;
  logAudit(conn, 'correction', `${s.entity}:${s.originalId}`, 'correct', { entity: s.entity, originalId: s.originalId },
    { entity: s.entity, originalId: s.originalId, replacementId }, reason);
  void ctx;
  return { link: toLink(row), replacement };
}

/**
 * Corrects a record: void the original, create the replacement, store the link - all or nothing (G2).
 * @throws whatever the existing void/create services throw (404, 409, 422 ...) - nothing is saved then.
 */
export function applyCorrection<R>(ctx: AppContext, s: CorrectionSteps<R>): CorrectionResult<R> {
  const reason = correctionReason(s.reason);
  return ctx.database.tx((conn) => {
    const earlier = findByClientRef(conn, s.entity, s.replacementClientRef);
    if (earlier) {
      if (earlier.original_id !== s.originalId) {
        throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different correction.');
      }
      return { replayed: true, correction: toLink(earlier), replacement: null };
    }
    const { link, replacement } = runSteps(ctx, conn, s, reason);
    return { replayed: false, correction: link, replacement };
  });
}

/**
 * Dry run of a whole correction: does everything, returns what the replacement WOULD be, then rolls back (nothing is saved, not
 * even the audit entry). Refusals come out as the same `AppError` a real correction would raise.
 */
export function previewCorrection<R>(ctx: AppContext, s: CorrectionSteps<R>): { replacement: R } {
  const reason = correctionReason(s.reason);
  try {
    ctx.database.tx((conn) => {
      const { replacement } = runSteps(ctx, conn, s, reason);
      throw new DryRunRollback({ replacement });
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.value as { replacement: R };
    throw err;
  }
  throw new Error('unreachable');
}

/** Answer of the eligibility check. */
export type Eligibility = { eligible: true } | { eligible: false; code: string; message: string };

/**
 * Can this record be corrected right now? Runs the existing VOID only (with a placeholder reason) and rolls back. The answer is the
 * void service's own: "yes", or its plain-language refusal (closed day, has returns, stock already used, ...).
 */
export function checkCorrectable(
  ctx: AppContext,
  s: Pick<CorrectionSteps<unknown>, 'originalId' | 'statusOf' | 'voidOriginal' | 'notFound'>,
): Eligibility {
  try {
    ctx.database.tx((conn) => {
      const status = s.statusOf(conn, s.originalId);
      if (status === null) s.notFound();
      if (status === 'void') throw alreadyVoid('record');
      s.voidOriginal('Eligibility check');
      throw new DryRunRollback(true);
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return { eligible: true };
    if (err instanceof AppError) {
      if (err.statusCode === 404) throw err;
      return { eligible: false, code: err.code, message: err.message };
    }
    throw err;
  }
  return { eligible: true };
}

/** All links for a set of record ids of one table, both directions (for History badges). */
export function listCorrectionLinks(ctx: AppContext, entity: CorrectionEntity, ids: number[]): CorrectionLink[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = ctx.database.conn.prepare(
    `SELECT * FROM corrections WHERE entity = ? AND (original_id IN (${marks}) OR replacement_id IN (${marks})) ORDER BY id`,
  ).all(entity, ...ids, ...ids) as unknown as LinkRow[];
  return rows.map(toLink);
}
