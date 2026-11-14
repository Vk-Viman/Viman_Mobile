// M7 (hardening): the RESTORE FLOW with validation, through the real HTTP API on the rich Phase 19 world.
// Order proved here: structural open -> full validation on a temporary copy -> only then safety backup + atomic swap.
// A refusal answers 422 (RESTORE_INVALID or the structural code) with the plain-language failures (max 10 + totalFailures), changes nothing in the
// live database except ONE audit row (restore_refused), leaves no temporary file, keeps earlier safety backups and keeps the app fully usable.
// Valid backups (named, uploaded, a copy from the external folder, older-schema files, after a failed attempt) still restore with the same figures.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { call, get } from './helpers/catalog.ts';
import { buildWorld19 } from './helpers/phase19h.ts';
import { buildMultipart } from './helpers/multipart.ts';
import type { Part } from './helpers/multipart.ts';
import { diffSnapshots, snapshotAll } from './helpers/phase14.ts';
import { damagedCopy, diffExceptRefusalAudit, hashFile, refusalRows, strayTempFiles } from './helpers/phase22rs.ts';
import { distinctBackup, putFolder } from './helpers/phase19bk.ts';
import { createBackup } from '../services/backup.service.ts';
import { externalCopyIdle } from '../services/external-backup.service.ts';
import { validateDatabase } from '../services/database-validation.ts';
import { latestVersion, loadMigrations, migrate } from '../db/migrate.ts';

const env = new TestEnv();
let s: ApiBase;
let work = '';
let goodName = '';
let goodPath = '';
let goodSnap: Record<string, string> = {};
let seq = 0;

const upload = (app: FastifyInstance, content: Buffer, name = 'candidate.db') => {
  const parts: Part[] = [{ name: 'confirm', value: 'RESTORE' }, { name: 'file', filename: name, content }];
  const { payload, headers } = buildMultipart(parts);
  return app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload, headers });
};
const restoreByName = (app: FastifyInstance, name: string) =>
  app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: { name, confirm: 'RESTORE' } });
const safetyCopies = (): string[] => readdirSync(s.ctx.backupsDir).filter((n) => /-pre-restore/.test(n)).sort();
const damaged = (fn: (db: DatabaseSync) => void, keep = false): string => damagedCopy(goodPath, join(work, `x${++seq}.db`), fn, keep);
/** An expense through the API: the live database then differs from the good backup. */
const addExpense = async (amountCents: number) => call(s.app, 'POST', '/expenses', {
  businessDate: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), book: 'shop', category: 'rent', amountCents,
  description: 'p22 marker', clientRef: `p22-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
});
const sumExpenses = (): number => Number((s.ctx.database.conn.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM expenses').get() as { t: number }).t);
const checkpoint = (): void => { s.ctx.database.conn.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };

beforeAll(async () => {
  s = await apiBase(await env.build());
  await buildWorld19(s);
  work = mkdtempSync(join(tmpdir(), 'viman-p22f-'));
  goodName = createBackup(s.ctx, 'manual', new Date('2026-03-01T00:00:00Z')).name;
  goodPath = join(s.ctx.backupsDir, goodName);
  goodSnap = snapshotAll(s.ctx); // the live tables at the moment of the good backup
}, 180000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await env.cleanup(); rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('a refusal (stock cache edited in the file)', () => {
  let bad = '';
  beforeAll(() => { bad = damaged((db) => db.exec("UPDATE products SET qty_on_hand = qty_on_hand + 3 WHERE id = (SELECT MIN(id) FROM products WHERE kind = 'stock' AND qty_on_hand > 0)")); });

  it('answers 422 RESTORE_INVALID with a plain sentence, the failures and totalFailures', async () => {
    await addExpense(1234);
    const r = await upload(s.app, readFileSync(bad), 'bad-stock.db');
    expect(r.statusCode).toBe(422);
    const e = r.json().error;
    expect(e.code).toBe('RESTORE_INVALID');
    expect(e.message).toBe('This backup was not restored because it failed its safety checks. Your current data was not changed.');
    expect(e.totalFailures).toBe(1);
    expect(e.failures).toHaveLength(1);
    expect(e.failures[0].code).toBe('stock_reconciliation');
    expect(e.failures[0].message).toBe('Stock quantities in the file do not match its stock history for 1 product.');
    expect(JSON.stringify(e)).not.toMatch(/node:|\.ts:|SQLITE_|stack/);
  });

  it('the live database is unchanged except ONE audit row; no temp file; no new safety backup; same whole-table snapshot', async () => {
    await addExpense(77);
    checkpoint();
    const before = snapshotAll(s.ctx);
    const safetyBefore = safetyCopies();
    const rowsBefore = refusalRows(s.ctx).length;
    const sumBefore = sumExpenses();
    const r = await upload(s.app, readFileSync(bad), 'bad-stock.db');
    expect(r.statusCode).toBe(422);
    expect(diffExceptRefusalAudit(before, s.ctx)).toEqual([]);
    const audit = refusalRows(s.ctx);
    expect(audit.length).toBe(rowsBefore + 1);
    expect(sumExpenses()).toBe(sumBefore);
    expect(safetyCopies()).toEqual(safetyBefore); // validation comes BEFORE the safety backup
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
    // (the trial-copy folder is proven removed in phase22-restore-validation.test.ts with a private temp folder; other test files share the OS temp folder)
    expect(s.ctx.isRestoring).toBe(false);
  });

  it('the audit row names the file and the failed check codes (entity backup, action restore_refused)', async () => {
    const r = await upload(s.app, readFileSync(bad), 'my-bad-file.db');
    expect(r.statusCode).toBe(422);
    const last = refusalRows(s.ctx).at(-1)!;
    expect(last.entity_id).toBe('upload:my-bad-file.db');
    const after = JSON.parse(last.after_json);
    expect(after.file).toBe('upload:my-bad-file.db');
    expect(after.failedChecks).toEqual(['stock_reconciliation']);
    expect(after.errorCode).toBe('RESTORE_INVALID');
    const api = (await get(s.app, '/audit-logs?entity=backup')).body.items as { action: string }[];
    expect(api.map((a) => a.action)).toContain('restore_refused');
  });

  it('the live database file is BYTE-IDENTICAL when the audit row cannot be written, and the answer is still the clean 422', async () => {
    await addExpense(55);
    checkpoint();
    const h = hashFile(s.ctx.dbPath);
    const tx = vi.spyOn(s.ctx.database, 'tx').mockImplementation(() => { throw new Error('audit write failed'); });
    const r = await upload(s.app, readFileSync(bad), 'bad-stock.db');
    expect(tx).toHaveBeenCalled();
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('RESTORE_INVALID');
    vi.restoreAllMocks();
    checkpoint();
    expect(hashFile(s.ctx.dbPath)).toBe(h);
  });

  it('the same refusal for a named backup in the backups folder', async () => {
    const name = 'viman-20250101-000000-manual.db';
    copyFileSync(bad, join(s.ctx.backupsDir, name));
    try {
      const r = await restoreByName(s.app, name);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('RESTORE_INVALID');
      expect(refusalRows(s.ctx).at(-1)!.entity_id).toBe(name);
    } finally { rmSync(join(s.ctx.backupsDir, name), { force: true }); }
  });

  it('the app is fully usable afterwards: new work, a backup, reports, a later good restore', async () => {
    await upload(s.app, readFileSync(bad), 'bad-stock.db');
    expect((await addExpense(4321)).status).toBe(201);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    expect((await call(s.app, 'POST', '/backups')).status).toBe(201);
    expect((await get(s.app, '/inventory/reconciliation')).body.ok).toBe(true);
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
  });
});

describe('many failures: at most 10 shown, all counted', () => {
  it('a file with a dozen problems lists 10 and says how many there are', async () => {
    // two steps: first the data problems (triggers lifted and restored), then the dropped tables (their triggers go with them)
    const step1 = damaged((db) => {
      db.exec("UPDATE expenses SET business_date = '2099-01-01' WHERE id = 1");
      db.exec("UPDATE products SET qty_on_hand = qty_on_hand + 1 WHERE id = (SELECT MIN(id) FROM products WHERE kind = 'stock' AND qty_on_hand > 0)");
      db.exec('UPDATE icecream_fund_entries SET amount_cents = amount_cents + 100 WHERE id = (SELECT MIN(id) FROM icecream_fund_entries WHERE reverses_entry_id IS NULL)');
    });
    const p = damagedCopy(step1, join(work, `x${++seq}.db`), (db) => {
      for (const t of ['cash_counts', 'cash_transfers', 'capital_entries', 'owner_drawings', 'print_sales', 'printing_supplies']) db.exec(`DROP TABLE ${t}`);
    }, true);
    const r = await upload(s.app, readFileSync(p), 'many.db');
    expect(r.statusCode).toBe(422);
    const e = r.json().error;
    expect(e.totalFailures).toBeGreaterThan(10);
    expect(e.failures).toHaveLength(10);
    const last = refusalRows(s.ctx).at(-1)!;
    expect(JSON.parse(last.after_json).totalFailures).toBe(e.totalFailures);
  });
});

describe('every kind of bad file through the API is refused, the live data stays', () => {
  const cases: [string, (db: DatabaseSync) => void, string, boolean?][] = [
    ['foreign key orphan', (db) => db.exec('UPDATE stock_movements SET product_id = 987654 WHERE id = (SELECT MIN(id) FROM stock_movements)'), 'foreign_key_check'],
    ['edited migration checksum', (db) => db.exec("DROP TRIGGER trg_schema_migrations_no_update; UPDATE schema_migrations SET checksum = 'zz' WHERE version = 2"), 'migration_records'],
    ['missing migration version', (db) => db.exec('DELETE FROM schema_migrations WHERE version = 6'), 'migration_records'],
    ['missing index', (db) => db.exec('DROP INDEX idx_sales_returns_status'), 'schema_objects'],
    ['extra trigger', (db) => db.exec('CREATE TRIGGER evil AFTER INSERT ON settings BEGIN SELECT 1; END'), 'schema_objects', true],
    ['missing trigger', (db) => db.exec('DROP TRIGGER audit_logs_no_delete'), 'schema_objects', true],
    ['cash reversal that does not negate', (db) => db.exec('UPDATE cash_entries SET amount_cents = amount_cents + 9 WHERE id = (SELECT MIN(id) FROM cash_entries WHERE reverses_entry_id IS NOT NULL)'), 'cash_ledger'],
    ['Ice Cream funds broken', (db) => db.exec('UPDATE icecream_fund_entries SET amount_cents = amount_cents + 9 WHERE id = (SELECT MIN(id) FROM icecream_fund_entries WHERE reverses_entry_id IS NULL)'), 'icecream_funds'],
    ['wrong returned_qty', (db) => db.exec('UPDATE sale_items SET returned_qty = 1 WHERE id = (SELECT MIN(id) FROM sale_items WHERE returned_qty = 0 AND qty >= 1 AND id NOT IN (SELECT sale_item_id FROM sales_return_items))'), 'returned_qty'],
    ['void without reversal', (db) => db.exec("UPDATE expenses SET status = 'void', voided_at = '2025-09-20T00:00:00Z', void_reason = 'x' WHERE id = (SELECT MIN(id) FROM expenses WHERE status = 'posted')"), 'void_reversals'],
    ['future date', (db) => db.exec("UPDATE expenses SET business_date = '2099-01-01' WHERE id = 1"), 'future_dates'],
  ];
  it.each(cases)('%s', async (_label, fn, code, keep) => {
    const p = damaged(fn, keep === true);
    checkpoint();
    const before = snapshotAll(s.ctx);
    const r = await upload(s.app, readFileSync(p), 'x.db');
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('RESTORE_INVALID');
    expect(r.json().error.failures.map((f: { code: string }) => f.code)).toContain(code);
    expect(diffExceptRefusalAudit(before, s.ctx)).toEqual([]);
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
  });

  it('structural refusals keep their codes, list one failure and are audited too', async () => {
    const junk = await upload(s.app, Buffer.from('not a database '.repeat(100)), 'junk.db');
    expect(junk.statusCode).toBe(422);
    expect(junk.json().error.code).toBe('RESTORE_INVALID_FILE');
    expect(junk.json().error.totalFailures).toBe(1);
    expect(junk.json().error.failures[0].code).toBe('not_a_database');
    expect(JSON.parse(refusalRows(s.ctx).at(-1)!.after_json).failedChecks).toEqual(['not_a_database']);
    const newer = damaged((db) => db.exec("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '999_f.sql', 'x')"));
    const r = await upload(s.app, readFileSync(newer), 'newer.db');
    expect(r.json().error.code).toBe('RESTORE_SCHEMA_TOO_NEW');
  });

  it('a file whose data pages are damaged is refused (integrity)', async () => {
    const b = Buffer.from(readFileSync(goodPath));
    b.fill(0xab, 4096 * 6, 4096 * 7);
    const r = await upload(s.app, b, 'pages.db');
    expect(r.statusCode).toBe(422);
    expect(['RESTORE_INTEGRITY_FAILED', 'RESTORE_INVALID_FILE', 'RESTORE_INVALID']).toContain(r.json().error.code);
    expect(r.json().error.failures.map((f: { code: string }) => f.code).some((c: string) => ['integrity_check', 'not_a_database'].includes(c))).toBe(true);
  });
});

describe('valid backups still restore, with the same figures', () => {
  /** Restores `act`, then expects the live tables to equal the moment of the backup (only audit_logs gained rows). */
  async function expectRestoredAs(snap: Record<string, string>, res: { statusCode: number; json(): any; body: string }): Promise<void> {
    expect(res.statusCode, res.body).toBe(200);
    const diff = diffSnapshots(snap, snapshotAll(s.ctx));
    expect(diff).toEqual(['audit_logs']);
    const a = JSON.parse(snapshotAll(s.ctx).audit_logs!) as { action: string }[];
    expect(a.at(-1)!.action).toBe('restore');
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
    expect(s.ctx.isRestoring).toBe(false);
  }
  it('a valid local backup by name (safety backup made, work after the restore possible)', async () => {
    await addExpense(999);
    const safetyBefore = safetyCopies().length;
    const r = await restoreByName(s.app, goodName);
    await expectRestoredAs(goodSnap, r);
    expect(r.json().schemaVersion).toBe(latestVersion());
    expect(safetyCopies().length).toBe(safetyBefore + 1);
    expect((await addExpense(1)).status).toBe(201);
  });

  it('a valid upload (the same file as bytes)', async () => {
    await addExpense(998);
    const r = await upload(s.app, readFileSync(goodPath), 'shop.db');
    await expectRestoredAs(goodSnap, r);
    expect(r.json().restoredFrom).toBe('upload:shop.db');
  });

  it('a valid copy taken from the external folder (uploaded from there)', async () => {
    const usb = env.newDir('viman-usb22-');
    expect((await putFolder(s.app, usb)).status).toBe(200);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const ext = join(usb, name);
    expect(existsSync(ext)).toBe(true);
    const snap = snapshotAll(s.ctx); // equals the backup moment (distinctBackup posted its expense BEFORE the backup)
    await addExpense(997);
    const hashBefore = hashFile(ext);
    const r = await upload(s.app, readFileSync(ext), name);
    expect(r.statusCode, r.body).toBe(200);
    expect(diffSnapshots(snap, snapshotAll(s.ctx)).filter((t) => !['audit_logs', 'external_backup_log', 'settings'].includes(t))).toEqual([]);
    expect(hashFile(ext)).toBe(hashBefore); // the external file was only read
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
    await putFolder(s.app, null);
  });

  /** An older database built from the first `upTo` migration files, with a little data. */
  function oldDb(upTo: number): string {
    const dir = mkdtempSync(join(work, 'old-'));
    const mdir = join(dir, 'm');
    mkdirSync(mdir);
    for (const m of loadMigrations().filter((x) => x.version <= upTo)) writeFileSync(join(mdir, m.name), m.sql);
    const p = join(dir, `v${upTo}.db`);
    const db = new DatabaseSync(p);
    try {
      migrate(db, mdir);
      db.exec("INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Old product', (SELECT id FROM categories WHERE name='Other'), 'stock', 'shop', 1000, 100)");
      db.exec("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason) VALUES (1, '2025-01-05', 'opening', 3, 3000, 1000, 'old')");
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    return p;
  }

  it.each([8, 17])('an older-schema backup (version %i) is upgraded by the restore and its data survives', async (v) => {
    const r = await upload(s.app, readFileSync(oldDb(v)), `v${v}.db`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().schemaVersion).toBe(latestVersion());
    const prods = (await get(s.app, '/products')).body.items as { name: string; qtyOnHand: number }[];
    expect(prods.map((p) => [p.name, p.qtyOnHand])).toEqual([['Old product', 3]]);
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
    // put the world back for the following tests
    expect((await restoreByName(s.app, goodName)).statusCode).toBe(200);
  });

  it('after a failed attempt the same good file restores fine (and the failed attempt left nothing behind)', async () => {
    const bad = damaged((db) => db.exec("UPDATE products SET stock_value_cents = stock_value_cents + 1 WHERE id = (SELECT MIN(id) FROM products WHERE kind = 'stock' AND qty_on_hand > 0)"));
    const f = await upload(s.app, readFileSync(bad), 'bad.db');
    expect(f.statusCode).toBe(422);
    const r = await upload(s.app, readFileSync(goodPath), 'good.db');
    await expectRestoredAs(goodSnap, r);
  });

  it('a previous safety backup survives a refusal untouched (earlier files are never rewritten or deleted by it)', async () => {
    const before = safetyCopies();
    expect(before.length).toBeGreaterThan(0);
    const hashes = before.map((n) => hashFile(join(s.ctx.backupsDir, n)));
    const bad = damaged((db) => db.exec('UPDATE sale_items SET returned_qty = 1 WHERE id = (SELECT MIN(id) FROM sale_items WHERE returned_qty = 0 AND qty >= 1 AND id NOT IN (SELECT sale_item_id FROM sales_return_items))'));
    expect((await upload(s.app, readFileSync(bad), 'bad.db')).statusCode).toBe(422);
    expect(safetyCopies()).toEqual(before);
    expect(before.map((n) => hashFile(join(s.ctx.backupsDir, n)))).toEqual(hashes);
  });
});

describe('concurrent restore requests', () => {
  it('three restores at once: each answers 200 or 409/503, the data ends as the good backup, safety copies match the successes, no temp files', async () => {
    await addExpense(222);
    const safetyBefore = safetyCopies().length;
    const results = await Promise.all([restoreByName(s.app, goodName), restoreByName(s.app, goodName), upload(s.app, readFileSync(goodPath), 'c.db')]);
    const codes = results.map((r) => r.statusCode);
    for (const c of codes) expect([200, 409, 503]).toContain(c);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    // every success made its own safety copy (older ones may have been rotated out: only the newest 10 are kept)
    const names = results.filter((r) => r.statusCode === 200).map((r) => r.json().safetyBackup as string);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(existsSync(join(s.ctx.backupsDir, n))).toBe(true);
    expect(safetyCopies().length).toBeGreaterThanOrEqual(Math.min(10, safetyBefore));
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
    expect(s.ctx.isRestoring).toBe(false);
  });

  it('a bad and a good restore at the same time: the bad one is refused, the good one wins, nothing breaks', async () => {
    const bad = damaged((db) => db.exec('DELETE FROM icecream_fund_entries WHERE id = (SELECT MAX(id) FROM icecream_fund_entries)'));
    await addExpense(223);
    const [a, b] = await Promise.all([upload(s.app, readFileSync(bad), 'bad.db'), restoreByName(s.app, goodName)]);
    expect([422, 409, 503]).toContain(a.statusCode);
    expect(b.statusCode === 200 || [409, 503].includes(b.statusCode)).toBe(true);
    if (b.statusCode !== 200) expect((await restoreByName(s.app, goodName)).statusCode).toBe(200);
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
    expect(s.ctx.isRestoring).toBe(false);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
  });
});
