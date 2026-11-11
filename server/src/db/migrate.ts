/**
 * db/migrate.ts - the migration runner: builds and upgrades the database structure.
 *
 * Layer: database. The database layout is defined by numbered SQL files in `db/migrations/` (001, 002, ...).
 * On every start-up `migrate()` applies the files that this database has not seen yet, each inside its own
 * transaction, and records a SHA-256 checksum of the file text in `schema_migrations`.
 *
 * Safety rules enforced here (ARCHITECTURE.md "Data"):
 *  - an already-applied migration file may never be edited (checksum mismatch stops the system), because the
 *    real shop database was built from the original text;
 *  - a database created by a NEWER version of the system is refused rather than guessed at.
 * See `migrations/README.md` for what each migration creates and why.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codedError } from '../lib/errors.ts';

/** One migration file as loaded from disk. */
export interface MigrationFile { version: number; name: string; checksum: string; sql: string }

/** Folder holding the `NNN_name.sql` files (next to this source file). */
export const MIGRATIONS_DIR: string = resolve(import.meta.dirname, 'migrations');

/** Tables that must exist in any database we are willing to restore from a backup (see backup.service.ts). */
export const REQUIRED_TABLES = ['schema_migrations', 'settings', 'audit_logs'] as const;

// "001_foundation.sql": three digits, underscore, lower-case name. Other files (e.g. README.md) are ignored.
const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * SHA-256 of a migration's text.
 *
 * Windows checkouts may turn line endings into CRLF; normalising to LF first means the same migration always
 * has the same checksum on every machine (otherwise a harmless line-ending change would block start-up).
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/**
 * Reads all migration files from `dir`, sorted by version.
 *
 * @throws Error when two files share the same version number.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const out: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const name of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const version = Number(m[1]);
    const prev = seen.get(version);
    if (prev !== undefined) {
      throw new Error(`Duplicate migration version ${version}: ${prev} and ${name}`);
    }
    seen.set(version, name);
    const sql = readFileSync(join(dir, name), 'utf8');
    out.push({ version, name, checksum: checksumOf(sql), sql });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

/** Creates the bookkeeping table if this is a brand-new database (migration 001 also declares it, harmlessly). */
function bootstrap(conn: DatabaseSync): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    checksum    TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
}

/** Highest migration version recorded in the database (0 when none / no bookkeeping table yet). */
export function currentVersion(conn: DatabaseSync): number {
  const t = conn.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!t) return 0;
  const row = conn.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | bigint | null } | undefined;
  return row?.v == null ? 0 : Number(row.v);
}

/** Highest migration version that exists as a file in this version of the system (0 when there are none). */
export function latestVersion(dir: string = MIGRATIONS_DIR): number {
  const all = loadMigrations(dir);
  return all.length === 0 ? 0 : all[all.length - 1]!.version;
}

/**
 * Brings the database up to date.
 *
 * Steps: (1) make sure the bookkeeping table exists; (2) refuse a database newer than this system;
 * (3) refuse if any already-applied file was edited; (4) apply each missing file in its own transaction.
 *
 * @param conn Open connection.
 * @param dir  Folder of migration files (tests pass a temporary folder).
 * @returns The file names applied now and the resulting schema version.
 * @throws Error `MIGRATION_DB_TOO_NEW`, `MIGRATION_CHECKSUM_MISMATCH`, or "Migration X failed: ..." (rolled back).
 */
export function migrate(conn: DatabaseSync, dir: string = MIGRATIONS_DIR): { applied: string[]; version: number } {
  bootstrap(conn);
  const files = loadMigrations(dir);
  const latest = files.length === 0 ? 0 : files[files.length - 1]!.version;
  const dbVersion = currentVersion(conn);
  if (dbVersion > latest) {
    throw codedError(`Database schema version ${dbVersion} is newer than this application supports (${latest})`, 'MIGRATION_DB_TOO_NEW');
  }
  const rows = conn.prepare('SELECT version, name, checksum FROM schema_migrations').all() as unknown as
    { version: number | bigint; name: string; checksum: string }[];
  const appliedMap = new Map<number, string>(rows.map((r) => [Number(r.version), r.checksum]));

  // Verify ALL applied files before applying anything new, so a tampered history is caught immediately.
  for (const f of files) {
    const cs = appliedMap.get(f.version);
    if (cs !== undefined && cs !== f.checksum) {
      throw codedError(`Checksum mismatch for applied migration ${f.name}`, 'MIGRATION_CHECKSUM_MISMATCH');
    }
  }

  const applied: string[] = [];
  const insert = conn.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  for (const f of files) {
    if (appliedMap.has(f.version)) continue;
    // The whole file and its bookkeeping row commit together, so a failure leaves no half-built schema.
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.exec(f.sql);
      insert.run(f.version, f.name, f.checksum);
      conn.exec('COMMIT');
    } catch (err) {
      try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${f.name} failed: ${msg}`, { cause: err });
    }
    applied.push(f.name);
  }
  return { applied, version: currentVersion(conn) };
}
