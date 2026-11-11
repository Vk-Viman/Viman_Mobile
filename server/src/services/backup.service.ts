/**
 * services/backup.service.ts - database backups and restores.
 *
 * Layer: service (route -> SERVICE -> repository -> database). Protects the shop's data (ARCHITECTURE.md
 * "Backup / restore" and "Startup & crash safety"):
 *  - A backup is a consistent snapshot made with `VACUUM INTO`. A plain file copy would be unsafe, because in
 *    WAL mode recent commits may still live in `viman.db-wal` and not in `viman.db`.
 *  - Backups are created at start-up and on demand; the newest 30 are kept (and the newest 10 safety copies
 *    that are made just before a restore), older ones are removed.
 *  - A restore never touches the live database until the candidate file has passed every check: SQLite header,
 *    read-only open, integrity check, required tables, schema version not newer than this system. Then a safety
 *    backup is made, the file is swapped with an atomic rename, and the audit log records the restore.
 *    If anything fails after the swap began, the previous data is put back automatically.
 *  - While a restore runs `ctx.isRestoring` is true and `app.ts` answers every /api request with 503.
 */
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

/** Why a backup was made: at start-up, by the owner, or automatically just before a restore. */
export type BackupReason = 'startup' | 'manual' | 'pre-restore';
export interface BackupInfo { name: string; reason: BackupReason; sizeBytes: number; createdAt: string }

/**
 * The only file names the system recognises as its own backups: `viman-YYYYMMDD-HHmmss-<reason>[-n].db`.
 * The route also uses it to reject a path-like name (so a restore request can never point outside the
 * backups folder).
 */
export const BACKUP_NAME_RE = /^viman-\d{8}-\d{6}-(startup|manual|pre-restore)(-\d{1,3})?\.db$/;
/** How many start-up/manual backups are kept. */
export const KEEP_REGULAR = 30;
/** How many pre-restore safety copies are kept. */
export const KEEP_PRE_RESTORE = 10;

/** First 16 bytes of every SQLite file; checked before opening an uploaded file as a database. */
const SQLITE_HEADER = 'SQLite format 3\u0000';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Describes one file in the backups folder, or null when it is not one of our backups (or not a plain file). */
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

/** The `YYYYMMDD-HHmmss` part of a backup name, used for ordering. */
function stampOf(name: string): string {
  // "viman-" + "YYYYMMDD-HHmmss"
  return name.slice(6, 21);
}

/**
 * Makes a consistent snapshot of the live database in the backups folder, then trims old backups.
 *
 * The snapshot is written to a `.tmp` file first and renamed into place, so a power cut can never leave a
 * half-written file that looks like a good backup (leftover `.tmp` files are removed at the next start-up).
 *
 * @param reason 'startup' | 'manual' | 'pre-restore' (becomes part of the file name).
 * @param now    Time used in the file name (tests pass a fixed value).
 * @throws AppError 500 BACKUP_FAILED.
 */
export function createBackup(ctx: AppContext, reason: BackupReason, now: Date = new Date()): BackupInfo {
  try {
    const base = `viman-${backupStamp(now)}-${reason}`;
    let name = `${base}.db`;
    // Two backups in the same second get "-2", "-3" ... instead of overwriting each other.
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

/** Lists the backups in the folder, newest first (by the stamp in the name, then file time, then name). */
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

/**
 * Deletes backups beyond the retention limits: the 30 newest start-up/manual ones and the 10 newest
 * pre-restore ones are kept. A file that cannot be deleted (e.g. locked on Windows) is skipped and retried
 * on the next rotation.
 *
 * @returns The names that were deleted.
 */
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

/**
 * Checks that a file is a usable Viman Mobile database WITHOUT changing it.
 * Gates in order: (1) SQLite header, (2) opens read-only, (3) `integrity_check` = ok, (4) required tables exist,
 * (5) its schema version is not newer than this system's.
 *
 * @returns The file's schema version.
 * @throws AppError 422 RESTORE_INVALID_FILE / RESTORE_INTEGRITY_FAILED / RESTORE_SCHEMA_MISSING /
 *   RESTORE_SCHEMA_TOO_NEW.
 */
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

/** Removes the `-wal` / `-shm` side files of a database file (they belong to the OLD file and must not outlive it). */
function removeSidecars(dbPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

/**
 * Replaces the live database with the contents of `sourcePath` (a backup or an uploaded file).
 *
 * Sequence: copy to a candidate file next to the live DB -> validate it (live DB untouched if it fails) ->
 * safety backup of the current data -> close, remove stale `-wal`/`-shm`, atomic rename over `viman.db` ->
 * reopen -> migrate (an older backup is upgraded to this version) -> audit entry. If anything fails after the
 * swap began, the safety backup is copied back and the owner sees "nothing was lost".
 *
 * @param label What to show in the audit log (a backup name, or `upload:<file name>`).
 * @throws AppError 409 RESTORE_IN_PROGRESS, 422 RESTORE_* (validation), 500 RESTORE_FAILED.
 */
export function restoreFromFile(
  ctx: AppContext,
  sourcePath: string,
  label: string,
): { restoredFrom: string; safetyBackup: string; schemaVersion: number } {
  if (ctx.isRestoring) {
    throw new AppError(409, 'RESTORE_IN_PROGRESS', 'Another restore is already running.');
  }
  // From here until `finally`, app.ts answers every /api request with 503 so nothing writes mid-swap.
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
    // Always clean up the candidate (and any -wal/-shm opened on it) and let requests through again.
    rmSync(candidate, { force: true });
    removeSidecars(candidate);
    ctx.isRestoring = false;
  }
}

/** Temp files a crash (power cut) could leave behind; safe to delete at startup. */
const STALE_TEMP_RE = /^(upload-\d+\.tmp\.db|restore-candidate\.tmp\.db(-wal|-shm)?|viman\.db\.rollback\.tmp)$/;

/**
 * Removes leftovers of an interrupted backup/restore/upload from the data and backups folders.
 * Only files matching the exact temp-file name patterns are touched; real backups and `viman.db` never match.
 *
 * @returns The names that were removed.
 */
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

/**
 * Newest backup names in a backups folder, readable without an open database (for recovery messages when the
 * live database is damaged and the system cannot start).
 */
export function newestBackupNames(backupsDir: string, limit: number): string[] {
  let names: string[];
  try { names = readdirSync(backupsDir); } catch { return []; }
  return names.filter((n) => BACKUP_NAME_RE.test(n))
    .sort((a, b) => b.localeCompare(a)).slice(0, limit);
}
