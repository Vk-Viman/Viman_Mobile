/**
 * index.ts - the program that `Start-Viman-Shop.bat` runs (`node server/src/index.ts`).
 *
 * Layer: entry point (composition root). Start-up order, chosen to protect the shop's data (ARCHITECTURE.md
 * "Startup & crash safety"):
 *   1. READ-ONLY integrity check of an existing `viman.db` - before anything opens it for writing.
 *   2. Open the database for writing and apply the migrations (`buildApp`).
 *   3. Start listening on the port. (Before the backup, so a second copy of the program started by mistake
 *      fails fast on "port in use" without writing anything.)
 *   4. Remove temp files left by a crash, then take the start-up backup.
 *   5. Print where the shop is running; close cleanly on Ctrl+C / system shutdown.
 * Every failure prints plain-language instructions for the owner and exits; nothing is ever deleted.
 *
 * Settings (environment variables): VIMAN_DATA_DIR (default `<project>/data`), VIMAN_PORT (default 4300),
 * VIMAN_HOST (default 127.0.0.1, i.e. only this PC can connect).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from './app.ts';
import { cleanupStaleTempFiles, createBackup, newestBackupNames } from './services/backup.service.ts';
import { externalCopyIdle, scheduleExternalCopy, startExternalCopyTimer } from './services/external-backup.service.ts';

const DEFAULT_PORT = 4300;
/** How many recent backups are listed in the "database is damaged" recovery message. */
const RECOVERY_BACKUPS_SHOWN = 3;

const dataDir = process.env.VIMAN_DATA_DIR ?? resolve(import.meta.dirname, '../../data');
const webDistDir = resolve(import.meta.dirname, '../../web/dist');
const port = Number(process.env.VIMAN_PORT ?? DEFAULT_PORT);
const host = process.env.VIMAN_HOST ?? '127.0.0.1';

/** Prints each line to the console and stops the program with an error status. */
function fail(lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

// SQLite result codes for a damaged file: SQLITE_CORRUPT (11), SQLITE_NOTADB (26).
function isDamagedDbError(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string };
  return e?.errcode === 11 || e?.errcode === 26 || /malformed|not a database/i.test(e?.message ?? '');
}

/** The live DB cannot be used: explain how to recover from a backup. Never touches any file. */
function failDamaged(detail: string): never {
  const dbFile = join(resolve(dataDir), 'viman.db');
  const backupsDir = join(resolve(dataDir), 'backups');
  const newest = newestBackupNames(backupsDir, RECOVERY_BACKUPS_SHOWN);
  fail([
    '',
    'The shop database is damaged, so the system did not start. Nothing was changed or deleted.',
    `  Problem: ${detail}`,
    '',
    'To recover from your most recent backup:',
    '  1. Close this window.',
    `  2. Open the folder ${resolve(dataDir)}`,
    '     Rename "viman.db" to "viman-damaged.db". Delete "viman.db-wal" and "viman.db-shm" if they exist.',
    `  3. Open the folder ${backupsDir}`,
    '     Copy the newest backup (listed below) into the data folder and rename the copy to "viman.db".',
    '  4. Start the shop system again.',
    '',
    newest.length > 0 ? 'Newest backups:' : 'No backups were found in the backups folder.',
    ...newest.map((n) => `  - ${n}`),
    '',
    `(Damaged file: ${dbFile})`,
  ]);
}

/**
 * Step 1 - pre-flight, READ-ONLY: check an existing database before anything opens it for writing
 * (opening for writing switches it to WAL and runs migrations - both write to the file).
 * So "nothing was changed" in the damage message is literally true. `quick_check` is a fast integrity test.
 * Stops the program (with recovery instructions) if the file is damaged; returns normally otherwise.
 */
function preflightIntegrityCheck(): void {
  const liveDb = join(resolve(dataDir), 'viman.db');
  if (!existsSync(liveDb)) return; // first run: nothing to check yet
  let integrity: string | null = null;
  try {
    const ro = new DatabaseSync(liveDb, { readOnly: true });
    try {
      const rows = ro.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
      integrity = rows.map((r) => String(Object.values(r)[0])).join('; ');
    } finally {
      ro.close();
    }
  } catch (err) {
    if (isDamagedDbError(err)) failDamaged(err instanceof Error ? err.message : String(err));
    // Any other open problem (e.g. permissions) is reported by the normal startup below.
  }
  if (integrity !== null && integrity !== 'ok') failDamaged(`integrity check failed (${integrity.slice(0, 200)})`);
}

preflightIntegrityCheck();

// Step 2 - open for writing and migrate. The codes below come from db/migrate.ts.
let built: Awaited<ReturnType<typeof buildApp>>;
try {
  built = await buildApp({ dataDir, webDistDir, logger: false });
} catch (err) {
  const code = (err as { code?: string }).code;
  if (code === 'MIGRATION_DB_TOO_NEW') {
    fail([
      'This shop database was created by a newer version of the system.',
      'Please install the latest version, or restore an older backup. Nothing was changed.',
    ]);
  }
  if (code === 'MIGRATION_CHECKSUM_MISMATCH') {
    fail([
      'The shop database does not match this version of the system (a past update was changed).',
      'Nothing was changed. Please contact support before continuing.',
    ]);
  }
  if (isDamagedDbError(err)) failDamaged(err instanceof Error ? err.message : String(err));
  console.error('Could not start the shop system:', err);
  process.exit(1);
}

const { app, ctx } = built;

// Step 3 - listen before the startup backup: a second launch on a busy port must fail fast
// without writing anything (it would otherwise snapshot a DB another process is using).
try {
  await app.listen({ port, host });
} catch (err) {
  const code = (err as { code?: string }).code;
  await app.close().catch(() => undefined);
  if (code === 'EADDRINUSE') {
    fail([`Port ${port} is already in use — the shop system is probably already running.`]);
  }
  console.error('Could not start the shop system:', err);
  process.exit(1);
}

// Step 4 - housekeeping. A failed start-up backup is only a warning: the shop can still work.
const staleRemoved = cleanupStaleTempFiles(ctx);

let startupBackup: string | null = null;
try {
  startupBackup = createBackup(ctx, 'startup').name;
} catch (err) {
  console.warn('Warning: could not create the startup backup:', err instanceof Error ? err.message : err);
}

// External backup copy (USB drive): started in the background and never awaited. A missing or failing drive is only
// logged and shown as a warning; the 10-minute timer is unref'd and copies when the drive appears later.
if (startupBackup) scheduleExternalCopy(ctx);
const stopExternalTimer = startExternalCopyTimer(ctx);

// Step 5 - tell the owner where the shop is running.
console.log(`Viman Mobile Shop running at http://localhost:${port}`);
console.log(`Data folder: ${ctx.dataDir}`);
console.log(startupBackup ? `Startup backup: ${startupBackup}` : 'Startup backup: not created');
if (staleRemoved.length > 0) console.log(`Cleaned up ${staleRemoved.length} leftover temporary file(s).`);

/** Closes the server (and the database, folding the WAL file in) once, then exits. */
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  stopExternalTimer();
  try {
    // Let a copy that is already running finish (bounded), so a half-written temporary file is not left on the drive.
    await Promise.race([externalCopyIdle(ctx), new Promise((r) => setTimeout(r, 5000))]);
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
