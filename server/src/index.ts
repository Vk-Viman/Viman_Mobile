import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from './app.ts';
import { cleanupStaleTempFiles, createBackup, newestBackupNames } from './services/backup.service.ts';

const dataDir = process.env.VIMAN_DATA_DIR ?? resolve(import.meta.dirname, '../../data');
const webDistDir = resolve(import.meta.dirname, '../../web/dist');
const port = Number(process.env.VIMAN_PORT ?? 4300);
const host = process.env.VIMAN_HOST ?? '127.0.0.1';

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
  const newest = newestBackupNames(backupsDir, 3);
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

// Pre-flight, READ-ONLY: check an existing database before anything opens it for writing
// (opening for writing switches it to WAL and runs migrations — both write to the file).
// So "nothing was changed" in the damage message is literally true.
const liveDb = join(resolve(dataDir), 'viman.db');
if (existsSync(liveDb)) {
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

// Listen before the startup backup: a second launch on a busy port must fail fast
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

const staleRemoved = cleanupStaleTempFiles(ctx);

let startupBackup: string | null = null;
try {
  startupBackup = createBackup(ctx, 'startup').name;
} catch (err) {
  console.warn('Warning: could not create the startup backup:', err instanceof Error ? err.message : err);
}

console.log(`Viman Mobile Shop running at http://localhost:${port}`);
console.log(`Data folder: ${ctx.dataDir}`);
console.log(startupBackup ? `Startup backup: ${startupBackup}` : 'Startup backup: not created');
if (staleRemoved.length > 0) console.log(`Cleaned up ${staleRemoved.length} leftover temporary file(s).`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
