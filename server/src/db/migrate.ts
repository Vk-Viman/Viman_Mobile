import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface MigrationFile { version: number; name: string; checksum: string; sql: string }

export const MIGRATIONS_DIR: string = resolve(import.meta.dirname, 'migrations');
export const REQUIRED_TABLES = ['schema_migrations', 'settings', 'audit_logs'] as const;

const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

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

function bootstrap(conn: DatabaseSync): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    checksum    TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
}

export function currentVersion(conn: DatabaseSync): number {
  const t = conn.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!t) return 0;
  const row = conn.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | bigint | null } | undefined;
  return row?.v == null ? 0 : Number(row.v);
}

export function latestVersion(dir: string = MIGRATIONS_DIR): number {
  const all = loadMigrations(dir);
  return all.length === 0 ? 0 : all[all.length - 1]!.version;
}

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
