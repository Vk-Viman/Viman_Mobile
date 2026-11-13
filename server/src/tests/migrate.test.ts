// Schema migrations (db/migrate.ts) - database level, in-memory SQLite and temp migration folders.
// Protects data safety across app upgrades: migrations run once, in order, inside a transaction (a failing one rolls back
// completely), each applied file's checksum is stored so a changed historical migration is detected, a database from a
// NEWER app is refused, and old databases upgrade without losing data. Also checks the table-level guards created by
// the early migrations (audit_logs append-only, settings/audit JSON validity).
// Organised as a single list of migration scenarios.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksumOf, currentVersion, loadMigrations, migrate, latestVersion, MIGRATIONS_DIR } from '../db/migrate.ts';
import { TestEnv } from './helpers/tmp.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

// Empty in-memory database (not yet migrated), registered for cleanup.
function mem(): DatabaseSync {
  const c = new DatabaseSync(':memory:');
  conns.push(c);
  return c;
}
const tables = (c: DatabaseSync) =>
  (c.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

function codeOf(fn: () => unknown): { code?: string; message: string } {
  try { fn(); } catch (e) { return { code: (e as { code?: string }).code, message: (e as Error).message }; }
  throw new Error('expected throw');
}

// Applying, repeating, upgrading and rejecting migrations.
describe('migrate', () => {
  it('fresh database migrates to the latest version with the Phase 1 tables', () => {
    const c = mem();
    expect(currentVersion(c)).toBe(0);
    const r = migrate(c);
    expect(r.version).toBe(latestVersion());
    expect(r.applied).toEqual(loadMigrations().map((m) => m.name));
    expect(r.applied[0]).toBe('001_foundation.sql');
    expect(tables(c)).toEqual(expect.arrayContaining(['schema_migrations', 'settings', 'audit_logs']));
    expect(latestVersion()).toBeGreaterThanOrEqual(2);
  });

  // Starting the app twice must not re-run migrations (idempotent).
  it('second run applies nothing', () => {
    const c = mem();
    migrate(c);
    const r = migrate(c);
    expect(r.applied).toEqual([]);
    expect(r.version).toBe(latestVersion());
  });

  // Windows (CRLF) and Linux (LF) copies of one migration must count as identical, so a git line-ending change is not mistaken for tampering.
  it('checksum is the same for CRLF and LF text and differs for different text', () => {
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'));
    expect(checksumOf('a\nb\n')).not.toBe(checksumOf('a\nc\n'));
    const m = loadMigrations()[0]!;
    expect(m.checksum).toBe(checksumOf(m.sql.replaceAll('\n', '\r\n')));
  });

  // If an already-applied migration file no longer matches what was recorded, stop: the database history is not what the app expects.
  it('tampered checksum row -> MIGRATION_CHECKSUM_MISMATCH', () => {
    const c = mem();
    migrate(c);
    c.exec('DROP TRIGGER trg_schema_migrations_no_update'); // migration 020 guards the history; this test simulates a tampered file
    c.exec("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 1");
    expect(codeOf(() => migrate(c)).code).toBe('MIGRATION_CHECKSUM_MISMATCH');
  });

  // Never run an older app on a newer database; it could corrupt data it does not understand.
  it('db version newer than the app -> MIGRATION_DB_TOO_NEW', () => {
    const c = mem();
    migrate(c);
    c.exec("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '999_future.sql', 'x')");
    expect(codeOf(() => migrate(c)).code).toBe('MIGRATION_DB_TOO_NEW');
  });

  // A broken migration is rolled back in full and reports which file failed; the database stays at version 1.
  it('a failing 002 file aborts with its name, rolls back, and version stays 1', () => {
    const dir = env.newDir();
    const sql1 = readFileSync(join(MIGRATIONS_DIR, '001_foundation.sql'), 'utf8');
    writeFileSync(join(dir, '001_foundation.sql'), sql1);
    writeFileSync(join(dir, '002_broken.sql'),
      'CREATE TABLE partial_table (id INTEGER);\nINSERT INTO no_such_table VALUES (1);\n');
    const c = mem();
    const err = codeOf(() => migrate(c, dir));
    expect(err.message).toContain('002_broken.sql');
    expect(currentVersion(c)).toBe(1);
    expect(tables(c)).not.toContain('partial_table');
    // Connection is not stuck inside a transaction.
    c.exec('BEGIN'); c.exec('ROLLBACK');
  });

  it('a good 002 file applies after 001', () => {
    const dir = env.newDir();
    writeFileSync(join(dir, '001_foundation.sql'), readFileSync(join(MIGRATIONS_DIR, '001_foundation.sql'), 'utf8'));
    writeFileSync(join(dir, '002_extra.sql'), 'CREATE TABLE extra (id INTEGER);\n');
    const c = mem();
    const r = migrate(c, dir);
    expect(r.version).toBe(2);
    expect(r.applied).toEqual(['001_foundation.sql', '002_extra.sql']);
  });

  it('duplicate version files throw', () => {
    const dir = env.newDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '001_b.sql'), 'SELECT 2;');
    expect(() => loadMigrations(dir)).toThrow(/Duplicate migration version 1/);
  });

  it('ignores files not matching the name pattern', () => {
    const dir = env.newDir();
    writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '2_bad.sql'), 'x');
    expect(loadMigrations(dir).map((m) => m.version)).toEqual([1]);
  });

  // Audit rows can never be changed or removed (section 12), enforced by triggers.
  it('audit_logs is append-only: UPDATE and DELETE are refused, INSERT works', () => {
    const c = mem();
    migrate(c);
    c.prepare("INSERT INTO audit_logs (entity, action) VALUES ('x','y')").run();
    expect(() => c.exec("UPDATE audit_logs SET note = 'edited'")).toThrow(/append-only/);
    expect(() => c.exec('DELETE FROM audit_logs')).toThrow(/append-only/);
    c.prepare("INSERT INTO audit_logs (entity, action) VALUES ('x','z')").run();
    const row = c.prepare('SELECT COUNT(*) AS n, MAX(note) AS note FROM audit_logs').get() as { n: number; note: string | null };
    expect(Number(row.n)).toBe(2);
    expect(row.note).toBeNull();
    const trg = (c.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((t) => t.name);
    expect(trg).toEqual(expect.arrayContaining(['audit_logs_no_update', 'audit_logs_no_delete']));
  });

  // An early install upgrades to the latest schema, gains the append-only triggers, and keeps its existing audit row.
  it('a version-1 database upgrades to latest and gains the triggers; data is kept', () => {
    const dir = env.newDir();
    writeFileSync(join(dir, '001_foundation.sql'), readFileSync(join(MIGRATIONS_DIR, '001_foundation.sql'), 'utf8'));
    const c = mem();
    expect(migrate(c, dir).version).toBe(1);
    c.prepare("INSERT INTO audit_logs (entity, action) VALUES ('old','row')").run();
    c.exec("UPDATE audit_logs SET note = 'editable before upgrade'");
    const r = migrate(c);
    expect(r.version).toBe(latestVersion());
    expect(r.applied).toEqual(loadMigrations().filter((m) => m.version > 1).map((m) => m.name));
    expect(() => c.exec("UPDATE audit_logs SET note = 'x'")).toThrow(/append-only/);
    expect(() => c.exec('DELETE FROM audit_logs')).toThrow(/append-only/);
    expect((c.prepare('SELECT note FROM audit_logs').get() as { note: string }).note).toBe('editable before upgrade');
  });

  it('settings CHECK rejects an unknown key', () => {
    const c = mem();
    migrate(c);
    expect(() => c.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('bogus', '{}')).toThrow();
    expect(() => c.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('shop', '{}')).not.toThrow();
  });

  it('settings CHECK rejects invalid JSON', () => {
    const c = mem();
    migrate(c);
    expect(() => c.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('shop', '{not json')).toThrow();
  });

  it('audit_logs CHECK rejects invalid JSON in before/after', () => {
    const c = mem();
    migrate(c);
    expect(() => c.prepare("INSERT INTO audit_logs (entity, action, before_json) VALUES ('x','y',?)").run('{bad')).toThrow();
    expect(() => c.prepare("INSERT INTO audit_logs (entity, action, after_json) VALUES ('x','y',?)").run('nope')).toThrow();
    expect(() => c.prepare("INSERT INTO audit_logs (entity, action, before_json, after_json) VALUES ('x','y',?,?)").run('{"a":1}', null)).not.toThrow();
  });
});
