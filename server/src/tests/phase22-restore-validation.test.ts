// M7 (hardening): the database validation module `services/database-validation.ts`, one named check at a time.
// A rich, valid database (the Phase 19 world: every document type, returns, voids, Ice Cream funds, closed days) is built once through the real
// HTTP API and saved as a backup. Each test copies that file, damages ONE thing (with raw SQL while the safety triggers are lifted and put back
// unchanged, or with raw bytes) and checks that the matching check - and only plausible companions - report it in plain words.
// Honest limit (also in the module header): a change inside a free-text column (a name, a note) keeps the file perfectly consistent and cannot be detected.

import { tamperMigrationRecords } from './helpers/tamper.ts';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { buildWorld19 } from './helpers/phase19h.ts';
import { damagedCopy } from './helpers/phase22rs.ts';
import { createBackup } from '../services/backup.service.ts';
import { CHECK_CODES, validateDatabase } from '../services/database-validation.ts';
import type { ValidationResult } from '../services/database-validation.ts';
import { checkStock } from '../services/database-validation-invariants.ts';
import { latestVersion, loadMigrations, MIGRATIONS_DIR, migrate } from '../db/migrate.ts';

const env = new TestEnv();
let base = '';
let work = '';
let seq = 0;
let worldMs = 0;

beforeAll(async () => {
  const s = await apiBase(await env.build());
  await buildWorld19(s);
  base = join(s.ctx.backupsDir, createBackup(s.ctx, 'manual').name);
  work = mkdtempSync(join(tmpdir(), 'viman-p22v-'));
  copyFileSync(base, join(work, 'base.db'));
  base = join(work, 'base.db');
  await s.app.close();
}, 180000);
// All tests here are synchronous and heavy; yielding to the event loop after each lets vitest's worker report progress (otherwise its RPC times out).
afterEach(async () => { await new Promise((r) => setTimeout(r, 0)); });
afterAll(async () => { await env.cleanup(); rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

/** Copy of the valid database. */
function copyOfBase(): string {
  const p = join(work, `c${++seq}.db`);
  copyFileSync(base, p);
  return p;
}

/** Damaged copy of the base database in the work folder (see `damagedCopy`). */
function damaged(fn: (db: DatabaseSync) => void, keepTriggers = false): string {
  return damagedCopy(base, join(work, `d${++seq}.db`), fn, keepTriggers);
}

/** Runs the validation on a file (read-only first, like a candidate that is only read). */
function verdict(file: string): ValidationResult {
  const db = new DatabaseSync(file);
  try { return validateDatabase(db); } finally { db.close(); }
}
const codes = (r: ValidationResult): string[] => [...new Set(r.failures.map((f) => f.code))];
const one = (db: DatabaseSync, sql: string): number => Number(Object.values(db.prepare(sql).get() as Record<string, unknown>)[0]);

describe('a valid database', () => {
  it('passes every check; the world is rich enough (voids, reversals, returns, funds)', () => {
    const t0 = Date.now();
    const r = verdict(base);
    worldMs = Date.now() - t0;
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.schemaVersion).toBe(latestVersion());
    expect(r.checks.map((c) => c.code)).toEqual([...CHECK_CODES]);
    expect(r.checks.every((c) => c.status === 'passed')).toBe(true);
    const db = new DatabaseSync(base, { readOnly: true });
    try {
      expect(one(db, "SELECT COUNT(*) FROM sales_returns WHERE status='void'")).toBeGreaterThan(0);
      expect(one(db, 'SELECT COUNT(*) FROM cash_entries WHERE reverses_entry_id IS NOT NULL')).toBeGreaterThan(10);
      expect(one(db, 'SELECT COUNT(*) FROM icecream_fund_entries')).toBeGreaterThan(0);
    } finally { db.close(); }
  });

  it('is fast enough (a few seconds on the audit world) and leaves no temporary folder behind', () => {
    // own temp folder (other test files run in parallel and also use the OS temp folder)
    const mine = mkdtempSync(join(tmpdir(), 'viman-p22t-'));
    try {
      const t0 = Date.now();
      const db = new DatabaseSync(base);
      try { expect(validateDatabase(db, { tempDir: mine }).ok).toBe(true); } finally { db.close(); }
      const ms = Date.now() - t0;
      console.log(`validation of the audit world: ${ms} ms (first run ${worldMs} ms, ${Math.round(readFileSync(base).length / 1024)} KB)`);
      expect(ms).toBeLessThan(5000);
      expect(readdirSync(mine)).toEqual([]);
      // a failing validation cleans up as well
      const bad = new DatabaseSync(damaged((d) => d.exec('DROP INDEX idx_sales_returns_status')));
      try { expect(validateDatabase(bad, { tempDir: mine }).ok).toBe(false); } finally { bad.close(); }
      expect(readdirSync(mine)).toEqual([]);
    } finally { rmSync(mine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it('does not change the candidate file at all', () => {
    const p = copyOfBase();
    const a = readFileSync(p);
    const db = new DatabaseSync(p, { readOnly: true });
    try { expect(validateDatabase(db).ok).toBe(true); } finally { db.close(); }
    expect(readFileSync(p).equals(a)).toBe(true);
    expect(readdirSync(work).filter((f) => f.endsWith('-wal') || f.endsWith('-shm') || f.endsWith('-journal'))).toEqual([]);
  });

  it('a fresh empty database made by the program passes', () => {
    const p = join(work, 'fresh.db');
    const db = new DatabaseSync(p);
    try { migrate(db); expect(validateDatabase(db).failures).toEqual([]); } finally { db.close(); }
  });
});

describe('integrity_check: damaged bytes', () => {
  /** Overwrites whole pages (a backup is VACUUMed, so every page is in use and any damaged page must be noticed). */
  function pageDamage(src: string, pages: number[], fill: (i: number) => number): string {
    const p = join(work, `pd${++seq}.db`);
    const b = Buffer.from(readFileSync(src));
    const pageSize = b.readUInt16BE(16) === 1 ? 65536 : b.readUInt16BE(16);
    for (const pg of pages) b.fill(fill(pg), (pg - 1) * pageSize, Math.min(b.length, pg * pageSize));
    writeFileSync(p, b);
    return p;
  }
  const pageCount = (src: string): number => readFileSync(src).readUInt32BE(28);

  it.each([2, 3, 7, 40, 100])('page %i overwritten with garbage: refused with integrity_check (base database)', (pg) => {
    const r = verdict(pageDamage(base, [pg], () => 0xab));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('integrity_check');
    expect(r.failures.find((f) => f.code === 'integrity_check')!.message).toBe('The backup file is damaged (the database integrity check failed).');
    // the checks that need a healthy file did not run (and did not crash)
    expect(r.checks.find((c) => c.code === 'trial_upgrade')!.status).toBe('skipped');
  });

  it('the last page and a zeroed middle page are noticed too', () => {
    const n = pageCount(base);
    expect(codes(verdict(pageDamage(base, [n], () => 0x00)))).toContain('integrity_check');
    expect(codes(verdict(pageDamage(base, [Math.floor(n / 2)], () => 0x00)))).toContain('integrity_check');
  });

  it('a second, small database (fresh schema): damaged pages at several positions are noticed', () => {
    const small = join(work, 'small.db');
    const db = new DatabaseSync(small);
    try { migrate(db); db.exec('VACUUM'); } finally { db.close(); }
    const n = pageCount(small);
    expect(n).toBeGreaterThan(10);
    for (const pg of [2, 5, Math.floor(n / 2), n]) {
      const r = verdict(pageDamage(small, [pg], (i) => (i * 37) & 0xff));
      expect(r.ok, `small database page ${pg}`).toBe(false);
      expect(codes(r), `small database page ${pg}`).toContain('integrity_check');
    }
  });

  it('a CHECK constraint violated inside a row (damaged JSON text in the audit log) is found by the integrity check', () => {
    const p = damaged((db) => db.exec("UPDATE audit_logs SET after_json = '{broken' WHERE id = (SELECT MIN(id) FROM audit_logs WHERE after_json IS NOT NULL)"));
    const r = verdict(p);
    expect(codes(r)).toContain('integrity_check');
  });

  it('a file cut at 50 %, a file with only the 100-byte header, a text file and a zero-length file are refused without crashing', () => {
    const b = readFileSync(base);
    const make = (name: string, bytes: Buffer): string => { const p = join(work, name); writeFileSync(p, bytes); return p; };
    for (const [label, bytes] of [
      ['half', b.subarray(0, Math.floor(b.length / 2))], ['header only', b.subarray(0, 100)], ['one page', b.subarray(0, 4096)],
      ['text', Buffer.from('this is definitely not a database '.repeat(300))],
    ] as [string, Buffer][]) {
      const r = verdict(make(`t-${label.replace(' ', '-')}.db`, bytes));
      expect(r.ok, label).toBe(false);
      expect(r.failures.length, label).toBeGreaterThan(0);
    }
    const empty = verdict(make('t-empty.db', Buffer.alloc(0)));
    expect(empty.ok).toBe(false);
    expect(codes(empty)).toContain('schema_version');
  });
});

describe('foreign_key_check', () => {
  it('a record that points to a product that does not exist is refused', () => {
    const r = verdict(damaged((db) => db.exec('UPDATE stock_movements SET product_id = 987654 WHERE id = (SELECT MIN(id) FROM stock_movements)')));
    expect(codes(r)).toContain('foreign_key_check');
    expect(r.failures.find((f) => f.code === 'foreign_key_check')!.message).toMatch(/points? to something that does not exist/);
  });
  it('an orphan row added to a child table is refused', () => {
    const r = verdict(damaged((db) => db.exec(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason)
      VALUES (777777, '2025-01-05', 'opening', 1, 1, 1, 'orphan')`)));
    expect(codes(r)).toContain('foreign_key_check');
  });
});

describe('schema_version and migration_records', () => {
  it('a version newer than the program is refused (schema_version) and nothing else is attempted on it', () => {
    const r = verdict(damaged((db) => db.exec("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '999_future.sql', 'x')")));
    expect(codes(r)).toContain('schema_version');
    expect(r.failures.find((f) => f.code === 'schema_version')!.message).toMatch(/newer version of the shop system/);
    expect(r.checks.find((c) => c.code === 'trial_upgrade')!.status).toBe('skipped');
  });
  it('a wrong checksum of an applied migration is refused (migration_records)', () => {
    const r = verdict(damaged((db) => tamperMigrationRecords(db, "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 3")));
    expect(codes(r)).toEqual(['migration_records']);
    expect(r.failures[0]!.message).toMatch(/step 3 was changed/);
  });
  it('a missing migration version in the middle of the history is refused (migration_records)', () => {
    const r = verdict(damaged((db) => db.exec('DELETE FROM schema_migrations WHERE version = 5')));
    expect(codes(r)).toEqual(['migration_records']);
    expect(r.failures[0]!.message).toMatch(/step 5 is missing/);
  });
  it('a changed migration name is refused too', () => {
    const r = verdict(damaged((db) => tamperMigrationRecords(db, "UPDATE schema_migrations SET name = '004_other.sql' WHERE version = 4")));
    expect(codes(r)).toEqual(['migration_records']);
  });
  it('no migration table at all is refused', () => {
    const r = verdict(damaged((db) => db.exec('DROP TABLE schema_migrations')));
    expect(codes(r)).toContain('schema_version');
    expect(codes(r)).toContain('migration_records');
  });
});

describe('schema_objects: tables, indexes and triggers against a reference built from migrations 1..N', () => {
  const msg = (r: ValidationResult): string[] => r.failures.filter((f) => f.code === 'schema_objects').map((f) => f.message);
  it('a missing table is named', () => {
    const r = verdict(damaged((db) => db.exec('DROP TABLE cash_counts'), true));
    expect(msg(r)).toContain('A required part of the database is missing: table cash_counts.');
  });
  it('a missing index is named in plain words', () => {
    const r = verdict(damaged((db) => db.exec('DROP INDEX idx_sales_returns_status')));
    expect(msg(r)).toEqual(['A required part of the database is missing: index idx_sales_returns_status.']);
  });
  it('a missing append-only trigger is named', () => {
    const r = verdict(damaged((db) => db.exec('DROP TRIGGER audit_logs_no_update'), true));
    expect(msg(r)).toEqual(['A required part of the database is missing: safety rule (trigger) audit_logs_no_update.']);
  });
  it('an extra unexpected trigger is named', () => {
    const r = verdict(damaged((db) => db.exec('CREATE TRIGGER evil_hook AFTER INSERT ON settings BEGIN SELECT 1; END'), true));
    expect(msg(r)).toEqual(['The database contains a part that does not belong to it: safety rule (trigger) evil_hook.']);
  });
  it('an altered trigger (same name, other body) is noticed', () => {
    const r = verdict(damaged((db) => {
      db.exec('DROP TRIGGER audit_logs_no_update');
      db.exec("CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT 1; END");
    }, true));
    expect(msg(r)).toEqual(['A part of the database has been changed from its original form: safety rule (trigger) audit_logs_no_update.']);
  });
  it('an extra index and an extra column are noticed', () => {
    const r = verdict(damaged((db) => { db.exec('CREATE INDEX idx_extra ON settings(key)'); db.exec('ALTER TABLE settings ADD COLUMN junk TEXT'); }, true));
    expect(msg(r)).toEqual(expect.arrayContaining([
      'The database contains a part that does not belong to it: index idx_extra.',
      'The database contains a part that does not belong to it: column settings.junk.',
    ]));
  });
  it('an older-schema file is compared with the reference of ITS version (not the current one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-p22o-'));
    try {
      const mdir = join(dir, 'm');
      mkdirSync(mdir, { recursive: true });
      for (const m of loadMigrations().filter((x) => x.version <= 8)) writeFileSync(join(mdir, m.name), m.sql);
      const p = join(dir, 'v8.db');
      const db = new DatabaseSync(p);
      try {
        migrate(db, mdir);
        const r = validateDatabase(db);
        expect(r.failures).toEqual([]);
        expect(r.schemaVersion).toBe(8);
        db.exec('DROP INDEX idx_audit_logs_business_date');
        expect(validateDatabase(db).failures.map((f) => f.message)).toContain('A required part of the database is missing: index idx_audit_logs_business_date.');
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  it('many differences: at most 8 listed plus one summary line', () => {
    const r = verdict(damaged((db) => { for (const t of ['cash_counts', 'cash_transfers', 'capital_entries', 'owner_drawings']) db.exec(`DROP TABLE ${t}`); }, true));
    expect(msg(r).length).toBeLessThanOrEqual(9);
    expect(msg(r).some((m) => /more parts of the database differ/.test(m))).toBe(true);
  });
});

describe('trial_upgrade', () => {
  it('a database that the real migrate() cannot upgrade is refused (a program with one more, broken migration)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-p22m-'));
    try {
      for (const m of loadMigrations()) writeFileSync(join(dir, m.name), m.sql);
      const next = String(latestVersion() + 1).padStart(3, '0');
      writeFileSync(join(dir, `${next}_broken.sql`), 'CREATE TABLE broken_one (id INTEGER); SELECT nonexistent_function_xyz(1);');
      const db = new DatabaseSync(base, { readOnly: true });
      try {
        const r = validateDatabase(db, { migrationsDir: dir });
        expect(r.ok).toBe(false);
        expect(codes(r)).toEqual(['trial_upgrade']);
        expect(r.failures[0]!.message).toMatch(/could not be brought up to the current version/);
        expect(r.checks.find((c) => c.code === 'stock_reconciliation')!.status).toBe('skipped');
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  it('a candidate one version behind a program with one more VALID migration is accepted (the upgrade is only tried on a copy)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-p22n-'));
    try {
      for (const m of loadMigrations()) writeFileSync(join(dir, m.name), m.sql);
      writeFileSync(join(dir, `${String(latestVersion() + 1).padStart(3, '0')}_extra.sql`), 'CREATE TABLE extra_for_test (id INTEGER PRIMARY KEY);');
      const db = new DatabaseSync(base, { readOnly: true });
      try {
        expect(validateDatabase(db, { migrationsDir: dir }).failures).toEqual([]);
        expect(one(db, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'extra_for_test'")).toBe(0); // the candidate itself is untouched
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});

describe('business invariants (the structure is valid, the numbers are not)', () => {
  it('stock_reconciliation: the quantity cache of one product is edited', () => {
    const r = verdict(damaged((db) => db.exec("UPDATE products SET qty_on_hand = qty_on_hand + 1 WHERE id = (SELECT MIN(id) FROM products WHERE kind = 'stock' AND qty_on_hand > 0)")));
    expect(codes(r)).toEqual(['stock_reconciliation']);
    expect(r.failures[0]!.message).toBe('Stock quantities in the file do not match its stock history for 1 product.');
    expect(r.failures[0]!.detail).toMatch(/stock shows/);
  });
  it('stock_reconciliation: the value cache of two products is edited', () => {
    const r = verdict(damaged((db) => db.exec("UPDATE products SET stock_value_cents = stock_value_cents + 7 WHERE id IN (SELECT id FROM products WHERE kind = 'stock' AND qty_on_hand > 0 ORDER BY id LIMIT 2)")));
    expect(codes(r)).toEqual(['stock_reconciliation']);
    expect(r.failures[0]!.message).toBe('Stock quantities in the file do not match its stock history for 2 products.');
  });
  it('stock_reconciliation: negative stock (checked on a hand-made pair of tables, because the real schema forbids it)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, qty_on_hand INTEGER, stock_value_cents INTEGER);
        CREATE TABLE stock_movements (id INTEGER PRIMARY KEY, product_id INTEGER, qty_delta INTEGER, value_delta_cents INTEGER);
        INSERT INTO products VALUES (1, 'Milk', -2, -200); INSERT INTO stock_movements VALUES (1, 1, -2, -200);`);
      const f = checkStock(db);
      expect(f.map((x) => x.message)).toEqual(['The file shows negative stock for 1 product.']);
    } finally { db.close(); }
  });
  it('stock_reconciliation: a stock movement that belongs to no product', () => {
    const r = verdict(damaged((db) => db.exec('UPDATE stock_movements SET product_id = 555555 WHERE id = (SELECT MAX(id) FROM stock_movements)')));
    expect(codes(r)).toContain('stock_reconciliation');
  });
  it('cash_ledger: a reversal that does not negate its original', () => {
    const r = verdict(damaged((db) => db.exec('UPDATE cash_entries SET amount_cents = amount_cents + 5 WHERE id = (SELECT MIN(id) FROM cash_entries WHERE reverses_entry_id IS NOT NULL)')));
    expect(codes(r)).toContain('cash_ledger');
    expect(r.failures.find((f) => f.code === 'cash_ledger')!.message).toMatch(/do(es)? not properly cancel the original entry/);
  });
  it('cash_ledger: a reversal in another cash book / on another date than its original', () => {
    const a = verdict(damaged((db) => db.exec("UPDATE cash_entries SET business_date = '2025-01-01' WHERE id = (SELECT MIN(id) FROM cash_entries WHERE reverses_entry_id IS NOT NULL)")));
    expect(codes(a)).toContain('cash_ledger');
    const b = verdict(damaged((db) => db.exec("UPDATE cash_entries SET book = CASE book WHEN 'shop' THEN 'telecom' ELSE 'shop' END, fund = NULL WHERE id = (SELECT MIN(id) FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND book <> 'icecream')")));
    expect(codes(b)).toContain('cash_ledger');
  });
  it('cash_ledger: one original reversed twice', () => {
    const r = verdict(damaged((db) => {
      db.exec('DROP INDEX IF EXISTS idx_cash_entries_reverses');
      for (const i of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cash_entries' AND sql LIKE '%reverses_entry_id%'").all() as unknown as { name: string }[]) db.exec(`DROP INDEX "${i.name}"`);
      db.exec(`INSERT INTO cash_entries (business_date, book, fund, type, amount_cents, ref_table, ref_id, reverses_entry_id, note)
        SELECT business_date, book, fund, type, amount_cents, ref_table, ref_id, reverses_entry_id, note FROM cash_entries WHERE reverses_entry_id IS NOT NULL ORDER BY id LIMIT 1`);
    }));
    expect(codes(r)).toContain('cash_ledger');
    expect(r.failures.find((f) => f.code === 'cash_ledger')!.detail).toMatch(/reversed 2 times/);
  });
  it('icecream_funds: Cost + Electricity + Profit no longer equals the Ice Cream cash book', () => {
    const r = verdict(damaged((db) => db.exec('UPDATE icecream_fund_entries SET amount_cents = amount_cents + 100 WHERE id = (SELECT MIN(id) FROM icecream_fund_entries WHERE reverses_entry_id IS NULL)')));
    expect(codes(r)).toContain('icecream_funds');
    expect(r.failures.find((f) => f.code === 'icecream_funds')!.message).toBe('The Ice Cream funds in the file do not add up to the Ice Cream cash book.');
  });
  it('icecream_funds: a fund entry deleted', () => {
    const r = verdict(damaged((db) => db.exec('DELETE FROM icecream_fund_entries WHERE id = (SELECT MAX(id) FROM icecream_fund_entries)')));
    expect(codes(r)).toContain('icecream_funds');
  });
  it('returned_qty: a sale line says it was returned although no posted return line says so', () => {
    const r = verdict(damaged((db) => db.exec(`UPDATE sale_items SET returned_qty = 1 WHERE id = (SELECT MIN(id) FROM sale_items WHERE returned_qty = 0 AND qty >= 1
      AND id NOT IN (SELECT sale_item_id FROM sales_return_items))`)));
    expect(codes(r)).toEqual(['returned_qty']);
    expect(r.failures[0]!.message).toBe('Returned quantities in the file do not match the return records for 1 sale line.');
  });
  it('returned_qty: a posted return line deleted (the sale line still says it was returned)', () => {
    const r = verdict(damaged((db) => db.exec('DELETE FROM sales_return_items WHERE id = (SELECT MAX(id) FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE status = \'posted\'))')));
    expect(codes(r)).toContain('returned_qty');
  });
  it('void_reversals: a voided record whose reversal rows are missing', () => {
    const r = verdict(damaged((db) => {
      const row = db.prepare("SELECT ref_table, ref_id FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND ref_table = 'expenses' LIMIT 1").get() as { ref_table: string; ref_id: number };
      db.exec(`DELETE FROM cash_entries WHERE ref_table = '${row.ref_table}' AND ref_id = ${row.ref_id} AND reverses_entry_id IS NOT NULL`);
    }));
    expect(codes(r)).toContain('void_reversals');
    expect(r.failures.find((f) => f.code === 'void_reversals')!.message).toMatch(/cancelled record is missing the entries that reverse/);
  });
  it('void_reversals: a record marked void without ever having been reversed (status edited)', () => {
    const r = verdict(damaged((db) => db.exec(`UPDATE expenses SET status = 'void', voided_at = '2025-09-20T00:00:00Z', void_reason = 'edited by hand'
      WHERE id = (SELECT MIN(id) FROM expenses WHERE status = 'posted')`)));
    expect(codes(r)).toContain('void_reversals');
  });
  it('future_dates: a record dated after today', () => {
    const r = verdict(damaged((db) => db.exec("UPDATE expenses SET business_date = '2099-01-01' WHERE id = (SELECT MIN(id) FROM expenses)")));
    expect(codes(r)).toContain('future_dates');
    expect(r.failures.find((f) => f.code === 'future_dates')!.detail).toMatch(/expenses/);
  });
  it('future_dates: the clock is injectable (a backup made "tomorrow" fails when checked "yesterday")', () => {
    const db = new DatabaseSync(base, { readOnly: true });
    try {
      const r = validateDatabase(db, { now: new Date('2020-01-01T00:00:00Z') });
      expect(codes(r)).toEqual(['future_dates']);
    } finally { db.close(); }
  });
  it('a free-text change is NOT detectable (documented limit): a changed product name passes', () => {
    const r = verdict(damaged((db) => db.exec("UPDATE products SET name = name || ' (edited)' WHERE id = (SELECT MIN(id) FROM products)")));
    expect(r.ok).toBe(true);
  });
});

describe('result shape and robustness', () => {
  it('every failure has a code from the list, a plain message and an optional text detail', () => {
    const r = verdict(damaged((db) => db.exec('DROP INDEX idx_sales_returns_status; UPDATE products SET qty_on_hand = qty_on_hand + 1 WHERE id = (SELECT MIN(id) FROM products WHERE kind = \'stock\' AND qty_on_hand > 0)')));
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
    for (const f of r.failures) {
      expect(CHECK_CODES).toContain(f.code);
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.message).not.toMatch(/node:|at .*\.ts|SQLITE_/);
      if (f.detail !== undefined) expect(typeof f.detail).toBe('string');
    }
    expect(codes(r).sort()).toEqual(['schema_objects', 'stock_reconciliation']);
  });
  it('the checks are independent: two different problems are both reported', () => {
    const r = verdict(damaged((db) => db.exec("UPDATE expenses SET business_date = '2099-01-01' WHERE id = 1; UPDATE products SET qty_on_hand = qty_on_hand + 1 WHERE id = (SELECT MIN(id) FROM products WHERE kind = 'stock' AND qty_on_hand > 0)")));
    expect(codes(r).sort()).toEqual(['future_dates', 'stock_reconciliation']);
  });
  it('MIGRATIONS_DIR is the program definition used by default', () => {
    expect(loadMigrations(MIGRATIONS_DIR).length).toBe(latestVersion());
  });
});
