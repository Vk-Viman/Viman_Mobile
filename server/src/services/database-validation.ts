/**
 * services/database-validation.ts - decides whether a database file is a sound Viman Mobile database
 * (hardening finding M7: "restore checks structure only").
 *
 * Layer: service, PURE with respect to the candidate: it only reads the connection it is given (the candidate may be
 * opened read-only) and writes nothing but a temporary copy that it always deletes. Used by `backup.service.ts`
 * before a restore touches the live data, and reusable on its own (e.g. `validateDatabase(conn)` in a script).
 *
 * Named, independent checks (each has its own `code`; a failed check adds one or more `failures`):
 *   integrity_check       full SQLite `PRAGMA integrity_check` (not the quick one)
 *   foreign_key_check     `PRAGMA foreign_key_check` returns nothing
 *   schema_version        the file records a version this program knows (not newer than the program's latest)
 *   migration_records     versions 1..N all present, names and SHA-256 checksums equal to the program's migration files
 *   schema_objects        tables (and columns), indexes and triggers equal a reference database built from migrations 1..N
 *   trial_upgrade         a temporary COPY is upgraded to the current version with the real `migrate()` and must succeed
 *   stock_reconciliation, cash_ledger, icecream_funds, returned_qty, void_reversals, future_dates
 *                         business invariants, evaluated on the upgraded copy (see database-validation-invariants.ts)
 * Unique indexes and append-only triggers are part of `schema_objects`; their data-level effect is covered by
 * `integrity_check` (an index must agree with its table). A change inside free-text columns (names, notes) keeps the
 * file perfectly consistent and CANNOT be detected by any of these checks.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentVersion, loadMigrations, migrate } from '../db/migrate.ts';
import type { MigrationFile } from '../db/migrate.ts';
import { describeDifference, diffSchemas, readSchema, referenceSchema } from './database-validation-schema.ts';
import { INVARIANT_CHECKS } from './database-validation-invariants.ts';
import type { ValidationFailure } from './database-validation-invariants.ts';

export type { ValidationFailure } from './database-validation-invariants.ts';

/** Options of `validateDatabase`. All optional; tests use them to pin the clock or use another migrations folder. */
export interface ValidationOptions {
  /** Folder in which the temporary trial copy is made (default: the operating system's temp folder). */
  tempDir?: string;
  /** Clock for the "no future dates" check. */
  now?: Date;
  /** Folder of migration files that define "the program" (default: the real `db/migrations`). */
  migrationsDir?: string;
}

/** Outcome of one check: it passed, failed, or was not run because an earlier check made it meaningless. */
export interface CheckOutcome { code: string; status: 'passed' | 'failed' | 'skipped' }

export interface ValidationResult {
  ok: boolean;
  failures: ValidationFailure[];
  checks: CheckOutcome[];
  /** The schema version recorded in the file (null when it could not be read). */
  schemaVersion: number | null;
}

/** All check codes, in the order they run. */
export const CHECK_CODES = [
  'integrity_check', 'foreign_key_check', 'schema_version', 'migration_records', 'schema_objects', 'trial_upgrade',
  ...INVARIANT_CHECKS.map((c) => c.code),
] as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
type Row = Record<string, unknown>;
const rowsOf = (conn: DatabaseSync, sql: string): Row[] => conn.prepare(sql).all() as unknown as Row[];

/** Full integrity check. A file so damaged that the check itself cannot run counts as damaged. */
export function checkIntegrity(conn: DatabaseSync): ValidationFailure[] {
  const damaged = (detail: string): ValidationFailure[] =>
    [{ code: 'integrity_check', message: 'The backup file is damaged (the database integrity check failed).', detail }];
  try {
    const lines = rowsOf(conn, 'PRAGMA integrity_check').map((r) => String(Object.values(r)[0]));
    if (lines.length === 1 && lines[0] === 'ok') return [];
    return damaged(lines.slice(0, 3).join('; '));
  } catch (e) {
    return damaged(errText(e));
  }
}

/** Every record must point to something that exists. */
export function checkForeignKeys(conn: DatabaseSync): ValidationFailure[] {
  const bad = rowsOf(conn, 'PRAGMA foreign_key_check');
  if (!bad.length) return [];
  const byTable = new Map<string, number>();
  for (const r of bad) byTable.set(String(r.table), (byTable.get(String(r.table)) ?? 0) + 1);
  return [{
    code: 'foreign_key_check',
    message: `The file contains ${bad.length} ${bad.length === 1 ? 'record that points' : 'records that point'} to something that does not exist.`,
    detail: [...byTable].slice(0, 5).map(([t, n]) => `${t}: ${n}`).join('; '),
  }];
}

/** Reads the migration records; null when the table is missing or unreadable. */
function readRecords(conn: DatabaseSync): { version: number; name: string; checksum: string }[] | null {
  try {
    return rowsOf(conn, 'SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .map((r) => ({ version: Number(r.version), name: String(r.name), checksum: String(r.checksum) }));
  } catch {
    return null;
  }
}

/** The file knows which version made it, and that version is not newer than this program. */
export function checkSchemaVersion(conn: DatabaseSync, latest: number): ValidationFailure[] {
  const records = readRecords(conn);
  const version = records === null || records.length === 0 ? 0 : Math.max(...records.map((r) => r.version));
  if (version === 0) {
    return [{ code: 'schema_version', message: 'The backup file does not say which version of the shop system made it.' }];
  }
  if (version > latest) {
    return [{
      code: 'schema_version',
      message: `This backup was made by a newer version of the shop system (version ${version}; this system supports up to ${latest}). Please update the system before restoring it.`,
    }];
  }
  return [];
}

/** Versions 1..N present without gaps; names and checksums equal the program's migration files. */
export function checkMigrationRecords(conn: DatabaseSync, files: MigrationFile[]): ValidationFailure[] {
  const records = readRecords(conn);
  if (records === null) {
    return [{ code: 'migration_records', message: 'The backup file has no history of its database structure (migration records are missing).' }];
  }
  const out: ValidationFailure[] = [];
  const have = new Map(records.map((r) => [r.version, r]));
  const top = records.length ? Math.max(...records.map((r) => r.version)) : 0;
  const missing: number[] = [];
  for (let v = 1; v <= top; v++) if (!have.has(v)) missing.push(v);
  if (missing.length) {
    out.push({ code: 'migration_records', message: `The database structure history of the backup is incomplete (step ${missing.slice(0, 5).join(', ')} is missing).` });
  }
  const changed: number[] = [];
  for (const f of files) {
    const r = have.get(f.version);
    if (r && (r.checksum !== f.checksum || r.name !== f.name)) changed.push(f.version);
  }
  if (changed.length) {
    out.push({
      code: 'migration_records',
      message: `The database structure history of the backup does not match this system (step ${changed.slice(0, 5).join(', ')} was changed), so it was probably not made by this program.`,
    });
  }
  return out;
}

/** Tables, indexes and triggers equal the reference built from migrations 1..version. At most 8 differences are listed. */
export function checkSchemaObjects(conn: DatabaseSync, files: MigrationFile[], version: number): ValidationFailure[] {
  const diffs = diffSchemas(readSchema(conn), referenceSchema(files, version));
  const out: ValidationFailure[] = diffs.slice(0, 8)
    .map((d) => ({ code: 'schema_objects', message: describeDifference(d) }));
  if (diffs.length > 8) out.push({ code: 'schema_objects', message: `${diffs.length - 8} more parts of the database differ from what this version requires.` });
  return out;
}

/**
 * Copies the candidate into a temporary file, upgrades the copy to the current version with the real `migrate()` and
 * hands it to `use`. The copy is always closed and deleted. A failure to upgrade is returned as a failure.
 */
function withUpgradedCopy(
  conn: DatabaseSync, o: ValidationOptions, use: (copy: DatabaseSync) => void,
): ValidationFailure[] {
  const dir = mkdtempSync(join(o.tempDir ?? tmpdir(), 'viman-validate-'));
  let copy: DatabaseSync | null = null;
  try {
    const path = join(dir, 'trial.db');
    try {
      conn.prepare('VACUUM INTO ?').run(path);
      copy = new DatabaseSync(path);
      copy.exec('PRAGMA foreign_keys = ON');
      migrate(copy, o.migrationsDir);
    } catch (e) {
      return [{
        code: 'trial_upgrade',
        message: 'The backup could not be brought up to the current version of the system, so it cannot be used.',
        detail: errText(e),
      }];
    }
    use(copy);
    return [];
  } finally {
    try { copy?.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Runs every check against `conn` (a connection to the candidate; read-only is enough).
 *
 * @returns `ok` when nothing failed; otherwise the failures in plain language (one entry per problem).
 *   A check that throws is reported as a failure of that check instead of crashing the caller.
 */
export function validateDatabase(conn: DatabaseSync, options: ValidationOptions = {}): ValidationResult {
  const now = options.now ?? new Date();
  const failures: ValidationFailure[] = [];
  const checks: CheckOutcome[] = [];
  const failed = new Set<string>();

  const run = (code: string, fn: () => ValidationFailure[], quietOnError = false): boolean => {
    let found: ValidationFailure[];
    try {
      found = fn();
    } catch (e) {
      found = quietOnError ? [] : [{ code, message: `The check "${code}" could not be completed on this file.`, detail: errText(e) }];
      if (quietOnError) { checks.push({ code, status: 'skipped' }); return false; }
    }
    checks.push({ code, status: found.length ? 'failed' : 'passed' });
    if (found.length) { failed.add(code); failures.push(...found); }
    return found.length === 0;
  };
  const skip = (code: string): void => { checks.push({ code, status: 'skipped' }); };

  let files: MigrationFile[] = [];
  let latest = 0;
  try {
    files = loadMigrations(options.migrationsDir);
    latest = files.length ? files[files.length - 1]!.version : 0;
  } catch (e) {
    failures.push({ code: 'schema_version', message: 'The program\'s own migration files could not be read.', detail: errText(e) });
    return { ok: false, failures, checks, schemaVersion: null };
  }

  const integrityOk = run('integrity_check', () => checkIntegrity(conn));
  // A damaged file may make the following checks throw; that is already explained by the integrity failure.
  run('foreign_key_check', () => checkForeignKeys(conn), !integrityOk);
  const versionOk = run('schema_version', () => checkSchemaVersion(conn, latest), !integrityOk);
  const recordsOk = run('migration_records', () => checkMigrationRecords(conn, files), !integrityOk);

  let schemaVersion: number | null = null;
  try { schemaVersion = currentVersion(conn); } catch { /* damaged file */ }

  if (integrityOk && versionOk && recordsOk && schemaVersion !== null && schemaVersion >= 1) {
    run('schema_objects', () => checkSchemaObjects(conn, files, schemaVersion!));
  } else skip('schema_objects');

  if (integrityOk && versionOk && recordsOk) {
    let upgraded = false;
    const upgradeFailures = withUpgradedCopy(conn, options, (copy) => {
      upgraded = true;
      checks.push({ code: 'trial_upgrade', status: 'passed' });
      for (const inv of INVARIANT_CHECKS) run(inv.code, () => inv.run(copy, now));
    });
    if (!upgraded) {
      checks.push({ code: 'trial_upgrade', status: 'failed' });
      failed.add('trial_upgrade');
      failures.push(...upgradeFailures);
      for (const inv of INVARIANT_CHECKS) skip(inv.code);
    }
  } else {
    skip('trial_upgrade');
    for (const inv of INVARIANT_CHECKS) skip(inv.code);
  }

  return { ok: failures.length === 0, failures, checks, schemaVersion };
}
