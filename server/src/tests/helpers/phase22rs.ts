// Helpers for the M7 restore-validation tests (hardening: a restore validates the candidate before touching live data).
// A refused restore changes NOTHING in the live database except ONE new audit row (entity backup, action restore_refused);
// `diffExceptRefusalAudit` compares whole-table snapshots with that single allowed difference.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../../app.ts';
import { diffSnapshots, snapshotAll } from './phase14.ts';

/** SHA-256 of a file's bytes. */
export const hashFile = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Names of the tables whose content differs from `before`, ignoring audit rows that were ADDED with action
 * `restore_refused` (older audit rows must be unchanged and in place). Empty = nothing else changed.
 */
export function diffExceptRefusalAudit(before: Record<string, string>, ctx: AppContext): string[] {
  const now = snapshotAll(ctx);
  const changed = diffSnapshots(before, now);
  if (!changed.includes('audit_logs')) return changed;
  const old = JSON.parse(before.audit_logs ?? '[]') as { action: string; entity: string }[];
  const cur = JSON.parse(now.audit_logs ?? '[]') as { action: string; entity: string }[];
  const prefixSame = JSON.stringify(cur.slice(0, old.length)) === JSON.stringify(old);
  const addedOnlyRefusals = cur.slice(old.length).every((r) => r.entity === 'backup' && r.action === 'restore_refused');
  return prefixSame && addedOnlyRefusals ? changed.filter((t) => t !== 'audit_logs') : changed;
}

/** How many `restore_refused` audit rows the live database holds. */
export function refusalRows(ctx: AppContext): { entity_id: string; after_json: string }[] {
  return ctx.database.conn.prepare("SELECT entity_id, after_json FROM audit_logs WHERE entity = 'backup' AND action = 'restore_refused' ORDER BY id")
    .all() as unknown as { entity_id: string; after_json: string }[];
}

/** Files in the data folder and the system temp folder that a restore/validation must never leave behind. */
export function strayTempFiles(dataDir: string): string[] {
  const inData = readdirSync(dataDir).filter((f) => /restore-candidate|upload-|rollback|\.tmp/.test(f));
  return inData;
}

/** Names of validation trial-copy folders currently in the OS temp folder (to prove they are cleaned up). */
export function trialFolders(tmp: string): string[] {
  return readdirSync(tmp).filter((f) => f.startsWith('viman-validate-')).map((f) => join(tmp, f));
}
