// Helpers for the M7 restore-validation tests (hardening: a restore validates the candidate before touching live data).
// A refused restore changes NOTHING in the live database except ONE new audit row (entity backup, action restore_refused);
// `diffExceptRefusalAudit` compares whole-table snapshots with that single allowed difference.

import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

/**
 * Damages a copy with raw SQL. Foreign keys and CHECK constraints are off; every trigger is taken out of the schema while `fn` runs
 * and put back with its own stored text afterwards, so the schema is exactly as before (only the DATA differs). The triggers are
 * lifted by editing sqlite_master directly (writable_schema) in separate short connections, which is much faster than hundreds of DROP TRIGGER statements.
 */
export function damagedCopy(src: string, p: string, fn: (db: DatabaseSync) => void, keepTriggers = false): string {
  copyFileSync(src, p);
  let trig: { name: string; tbl_name: string; sql: string }[] = [];
  if (!keepTriggers) {
    const a = new DatabaseSync(p);
    try {
      a.enableDefensive(false);
      a.exec('PRAGMA journal_mode = DELETE');
      trig = a.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'").all() as unknown as typeof trig;
      a.exec("PRAGMA writable_schema = ON; DELETE FROM sqlite_master WHERE type = 'trigger'; PRAGMA writable_schema = OFF");
    } finally { a.close(); }
  }
  const db = new DatabaseSync(p);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('PRAGMA ignore_check_constraints = ON');
    fn(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  if (!keepTriggers) {
    const c = new DatabaseSync(p);
    try {
      c.enableDefensive(false);
      c.exec('PRAGMA writable_schema = ON');
      const ins = c.prepare("INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('trigger', ?, ?, 0, ?)");
      for (const t of trig) ins.run(t.name, t.tbl_name, t.sql);
      c.exec('PRAGMA writable_schema = OFF');
    } finally { c.close(); }
  }
  return p;
}

