import { DatabaseSync } from 'node:sqlite';
import {
  closeSync, copyFileSync, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { backupStamp } from '../lib/dates.ts';
import { currentVersion, latestVersion, migrate, REQUIRED_TABLES } from '../db/migrate.ts';
import { logAudit } from './audit.service.ts';

export type BackupReason = 'startup' | 'manual' | 'pre-restore';
export interface BackupInfo { name: string; reason: BackupReason; sizeBytes: number; createdAt: string }

export const BACKUP_NAME_RE = /^viman-\d{8}-\d{6}-(startup|manual|pre-restore)(-\d{1,3})?\.db$/;
export const KEEP_REGULAR = 30;
export const KEEP_PRE_RESTORE = 10;

const SQLITE_HEADER = 'SQLite format 3\u0000';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function infoFor(ctx: AppContext, name: string): BackupInfo | null {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  try {
    const st = statSync(join(ctx.backupsDir, name));
    if (!st.isFile()) return null;
    return {
      name,
      reason: m[1] as BackupReason,
      sizeBytes: st.size,
      createdAt: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function stampOf(name: string): string {
  // "viman-" + "YYYYMMDD-HHmmss"
  return name.slice(6, 21);
}

export function createBackup(ctx: AppContext, reason: BackupReason, now: Date = new Date()): BackupInfo {
  try {
    const base = `viman-${backupStamp(now)}-${reason}`;
    let name = `${base}.db`;
    for (let n = 2; existsSync(join(ctx.backupsDir, name)); n++) name = `${base}-${n}.db`;
    const finalPath = join(ctx.backupsDir, name);
    const tmpPath = `${finalPath}.tmp`;
    rmSync(tmpPath, { force: true });
    try {
      ctx.database.conn.prepare('VACUUM INTO ?').run(tmpPath);
      renameSync(tmpPath, finalPath);
    } catch (err) {
      rmSync(tmpPath, { force: true });
      throw err;
    }
    const info = infoFor(ctx, name);
    if (!info) throw new Error('Backup file was not created');
    rotateBackups(ctx);
    return info;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'BACKUP_FAILED', `Could not create a backup: ${errMsg(err)}`);
  }
}

export function listBackups(ctx: AppContext): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(ctx.backupsDir);
  } catch {
    return [];
  }
  const items: BackupInfo[] = [];
  for (const name of names) {
    const info = infoFor(ctx, name);
    if (info) items.push(info);
  }
  items.sort((a, b) => {
    const s = stampOf(b.name).localeCompare(stampOf(a.name));
    if (s !== 0) return s;
    const t = b.createdAt.localeCompare(a.createdAt);
    if (t !== 0) return t;
    return b.name.localeCompare(a.name);
  });
  return items;
}

export function rotateBackups(ctx: AppContext): string[] {
  const all = listBackups(ctx);
  const regular = all.filter((b) => b.reason !== 'pre-restore');
  const pre = all.filter((b) => b.reason === 'pre-restore');
  const doomed = [...regular.slice(KEEP_REGULAR), ...pre.slice(KEEP_PRE_RESTORE)];
  const deleted: string[] = [];
  for (const b of doomed) {
    try {
      rmSync(join(ctx.backupsDir, b.name), { force: true });
      deleted.push(b.name);
    } catch {
      // Ignore: it will be retried on the next rotation.
    }
  }
  return deleted;
}

export function validateDatabaseFile(filePath: string): { schemaVersion: number } {
  const notDb = (): AppError =>
    new AppError(422, 'RESTORE_INVALID_FILE', 'This file is not a Viman Mobile database.');

  // 1. header check
  const header = Buffer.alloc(16);
  let read = 0;
  try {
    const fd = openSync(filePath, 'r');
    try {
      read = readSync(fd, header, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw notDb();
  }
  if (read !== 16 || header.toString('latin1') !== SQLITE_HEADER) throw notDb();

  // 2. open read-only
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch {
    throw notDb();
  }
  try {
    // 3. integrity
    let integrityOk = false;
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as unknown as Record<string, unknown>[];
      integrityOk = rows.length === 1 && Object.values(rows[0] as Record<string, unknown>)[0] === 'ok';
    } catch {
      throw notDb();
    }
    if (!integrityOk) {
      throw new AppError(422, 'RESTORE_INTEGRITY_FAILED',
        'This database file is damaged (the integrity check failed), so it was not restored.');
    }

    // 4. schema present
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[])
        .map((r) => r.name),
    );
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length > 0) {
      throw new AppError(422, 'RESTORE_SCHEMA_MISSING',
        `This database is missing required data (${missing.join(', ')}), so it was not restored.`);
    }

    // 5. version
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
      { v: number | bigint | null } | undefined;
    const schemaVersion = row?.v == null ? 0 : Number(row.v);
    if (schemaVersion > latestVersion()) {
      throw new AppError(422, 'RESTORE_SCHEMA_TOO_NEW',
        'This backup was made by a newer version of the shop system. Please update the system before restoring it.');
    }
    return { schemaVersion };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function removeSidecars(dbPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

export function restoreFromFile(
  ctx: AppContext,
  sourcePath: string,
  label: string,
): { restoredFrom: string; safetyBackup: string; schemaVersion: number } {
  if (ctx.isRestoring) {
    throw new AppError(409, 'RESTORE_IN_PROGRESS', 'Another restore is already running.');
  }
  ctx.isRestoring = true;
  const candidate = join(ctx.dataDir, 'restore-candidate.tmp.db');
  try {
    try {
      rmSync(candidate, { force: true });
      copyFileSync(sourcePath, candidate);
    } catch (err) {
      throw new AppError(500, 'RESTORE_FAILED', `Could not read the backup file: ${errMsg(err)}`);
    }

    // The live database is untouched if validation fails.
    validateDatabaseFile(candidate);

    const safety = createBackup(ctx, 'pre-restore');

    try {
      ctx.database.close();
      removeSidecars(ctx.dbPath);
      // Atomic swap: the validated candidate lives in the same folder, so a rename replaces
      // viman.db in one step — a power cut can never leave a half-copied live database.
      renameSync(candidate, ctx.dbPath);
      ctx.database.reopen();
      migrate(ctx.database.conn);
      const schemaVersion = currentVersion(ctx.database.conn);
      ctx.database.tx((conn) => {
        logAudit(conn, 'backup', label, 'restore', null,
          { restoredFrom: label, safetyBackup: safety.name, schemaVersion });
      });
      return { restoredFrom: label, safetyBackup: safety.name, schemaVersion };
    } catch (err) {
      // Put the previous data back.
      try {
        ctx.database.close();
        removeSidecars(ctx.dbPath);
        const rollbackTmp = `${ctx.dbPath}.rollback.tmp`;
        copyFileSync(join(ctx.backupsDir, safety.name), rollbackTmp);
        renameSync(rollbackTmp, ctx.dbPath);
        ctx.database.reopen();
      } catch (rollbackErr) {
        console.error('Restore rollback failed:', rollbackErr);
      }
      console.error('Restore failed:', err);
      throw new AppError(500, 'RESTORE_FAILED',
        'The restore failed and your previous data was put back. Nothing was lost.');
    }
  } finally {
    rmSync(candidate, { force: true });
    removeSidecars(candidate);
    ctx.isRestoring = false;
  }
}

/** Temp files a crash (power cut) could leave behind; safe to delete at startup. */
const STALE_TEMP_RE = /^(upload-\d+\.tmp\.db|restore-candidate\.tmp\.db(-wal|-shm)?|viman\.db\.rollback\.tmp)$/;

export function cleanupStaleTempFiles(ctx: AppContext): string[] {
  const removed: string[] = [];
  const sweep = (dir: string, match: (name: string) => boolean): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!match(name)) continue;
      try { rmSync(join(dir, name), { force: true }); removed.push(name); } catch { /* retry next start */ }
    }
  };
  sweep(ctx.dataDir, (n) => STALE_TEMP_RE.test(n));
  sweep(ctx.backupsDir, (n) => n.endsWith('.db.tmp') && BACKUP_NAME_RE.test(n.slice(0, -4)));
  return removed;
}

/** Newest backup names in a backups folder, readable without an open database (for recovery messages). */
export function newestBackupNames(backupsDir: string, limit: number): string[] {
  let names: string[];
  try { names = readdirSync(backupsDir); } catch { return []; }
  return names.filter((n) => BACKUP_NAME_RE.test(n))
    .sort((a, b) => b.localeCompare(a)).slice(0, limit);
}
