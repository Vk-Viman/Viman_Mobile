// Phase 14: BACKUP / RESTORE of a full financial world. Build the six-week world, back it up, mutate every module, restore, and assert that every figure
// (cash books, funds, P&L of all segments, dashboard, valuation, lists) and every ledger table equals the pre-mutation state, and that the global invariants
// hold. Restoring a garbage / truncated / corrupt / incomplete / too-new / tampered file is refused and the live data stays intact.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post } from './helpers/catalog.ts';
import { latestVersion } from '../db/migrate.ts';
import { buildMultipart } from './helpers/multipart.ts';
import type { Part } from './helpers/multipart.ts';
import { assertGlobalInvariants, buildWorld14, countsAll, diffSnapshots, must, rows, snapshotAll } from './helpers/phase14.ts';
import type { World14 } from './helpers/phase14.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { expNew } from './helpers/phase8.ts';
import { dayOk, payOk } from './helpers/phase10.ts';
import { latestVersion } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

/** Every figure an owner would look at, as one string (time-dependent blocks such as the dashboard backup status are left out). */
async function figures(s: ApiBase): Promise<string> {
  const q = 'from=2025-08-01&to=2025-09-30';
  const urls = [
    '/cashbooks', '/icecream/funds?asOf=2025-08-31&from=2025-08-01', '/icecream/funds', '/cashbooks/shop', '/cashbooks/telecom', '/cashbooks/icecream',
    `/reports/pnl/shop?${q}&granularity=day`, `/reports/pnl/telecom?${q}&granularity=month`, `/reports/pnl/icecream?${q}&granularity=day`, `/reports/pnl/combined?${q}&granularity=month`,
    `/reports/cashbook/shop?${q}&granularity=month`, `/reports/icecream-funds?${q}&granularity=month`, '/reports/inventory/valuation', '/reports/inventory/valuation?asOf=2025-08-31',
    '/products?limit=100', '/sales?limit=200', '/purchases?limit=200', '/expenses?limit=200', '/cash-counts', '/daily-closings', '/icecream/days', '/icecream/payments', '/icecream/fund-moves',
    '/telecom/summary?from=2025-08-01&to=2025-09-30', '/inventory/reconciliation',
  ];
  const out: Record<string, unknown> = {};
  for (const u of urls) out[u] = (await get(s.app, u)).body;
  for (const d of ['2025-08-14', '2025-08-31', '2025-09-14']) { const dash = (await get(s.app, `/dashboard?asOf=${d}`)).body; delete dash.backup; out[`dash${d}`] = dash; }
  return JSON.stringify(out);
}

const restoreJson = (app: FastifyInstance, body: unknown) => app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: body as object });
const restoreUpload = (app: FastifyInstance, parts: Part[]) => {
  const { payload, headers } = buildMultipart(parts);
  return app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload, headers });
};
const upload = (app: FastifyInstance, content: Buffer, name = 'x.db') => restoreUpload(app, [{ name: 'confirm', value: 'RESTORE' }, { name: 'file', filename: name, content }]);

/** Adds records to every module (all dated today / recently) so the live data differs from the backup. */
async function mutate(s: ApiBase, w: World14): Promise<void> {
  await sellOk(s, [cl(w.P, 2, 80000)], { businessDate: daysAgo(1) });
  await sellOk(s, [cl(w.K, 3, 10000)], { businessDate: daysAgo(1) });
  await buy(s, [{ productId: w.S, packs: 2, packSize: 5, lineTotalCents: 12345 }], { businessDate: daysAgo(2) });
  await must(await expNew(s, { businessDate: daysAgo(1), book: 'shop', category: 'water', amountCents: 4321 }), 'expense');
  await must(await expNew(s, { businessDate: daysAgo(1), book: 'telecom', category: 'repairs', amountCents: 999 }), 'expense');
  await dayOk(s, { businessDate: daysAgo(1), salesCents: 55555, costAllocCents: 20000, electricityAllocCents: 5000 });
  await payOk(s, 'materials', 7777, { businessDate: daysAgo(1), fund: 'cost' });
  await must(await post(s.app, '/cash-transfers', { businessDate: daysAgo(1), fromBook: 'shop', toBook: 'icecream', toFund: 'profit', amountCents: 3333, clientRef: ref() }), 'transfer');
  await must(await post(s.app, '/stock-losses', { businessDate: daysAgo(1), productId: w.Q, qty: 1, reason: 'lost', clientRef: ref() }), 'loss');
}

describe('backup then mutate then restore', () => {
  it('restoring by name brings back EVERY figure and ledger row exactly; the invariants hold; the system keeps working', async () => {
    const s = await apiBase(await env.build());
    const w = await buildWorld14(s);
    await assertGlobalInvariants(s);
    const figs0 = await figures(s);
    const tables0 = snapshotAll(s.ctx);
    const b = (await post(s.app, '/backups', {})).body.item;
    expect(b.reason).toBe('manual');

    await mutate(s, w);
    const figs1 = await figures(s);
    expect(figs1, 'the mutation must change the figures (otherwise the test proves nothing)').not.toBe(figs0);
    await assertGlobalInvariants(s);

    const r = await restoreJson(s.app, { name: b.name, confirm: 'RESTORE' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().safetyBackup).toBeTruthy();

    expect(await figures(s), 'figures after restore differ from the pre-mutation state').toBe(figs0);
    const tables1 = snapshotAll(s.ctx);
    // the restore itself is audited: audit_logs gained rows, every other table is identical
    const changed = diffSnapshots(tables0, tables1);
    expect(changed).toEqual(['audit_logs']);
    const auditBefore = JSON.parse(tables0.audit_logs!) as any[];
    const auditAfter = JSON.parse(tables1.audit_logs!) as any[];
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
    expect(auditAfter.length).toBeGreaterThan(auditBefore.length);
    expect(auditAfter.some((a) => a.action === 'restore' || a.entity === 'backup')).toBe(true);
    await assertGlobalInvariants(s);

    // the restored system accepts new work and stays consistent
    await must(await expNew(s, { businessDate: daysAgo(0), book: 'shop', category: 'other', amountCents: 100 }), 'new expense');
    await sellOk(s, [cl(w.P, 1, 80000)], { businessDate: daysAgo(0) });
    await assertGlobalInvariants(s);
  });

  it('restoring by UPLOAD of the backup file behaves the same way', async () => {
    const s = await apiBase(await env.build());
    const w = await buildWorld14(s);
    const figs0 = await figures(s);
    const tables0 = snapshotAll(s.ctx);
    const b = (await post(s.app, '/backups', {})).body.item;
    const bytes = readFileSync(join(s.ctx.database.filePath, '..', 'backups', b.name));
    await mutate(s, w);
    const r = await upload(s.app, bytes, b.name);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().restoredFrom).toBe(`upload:${b.name}`);
    expect(await figures(s)).toBe(figs0);
    expect(diffSnapshots(tables0, snapshotAll(s.ctx))).toEqual(['audit_logs']);
    await assertGlobalInvariants(s);
  });

  it('restore twice in a row, and restore of an OLDER backup after newer work, each give exactly that backup\'s state', async () => {
    const s = await apiBase(await env.build());
    const w = await buildWorld14(s);
    const figsA = await figures(s);
    const a = (await post(s.app, '/backups', {})).body.item;
    await mutate(s, w);
    const figsB = await figures(s);
    const bb = (await post(s.app, '/backups', {})).body.item;
    await must(await expNew(s, { businessDate: daysAgo(0), book: 'shop', category: 'rent', amountCents: 555 }), 'more');
    expect((await restoreJson(s.app, { name: a.name, confirm: 'RESTORE' })).statusCode).toBe(200);
    expect(await figures(s)).toBe(figsA);
    expect((await restoreJson(s.app, { name: bb.name, confirm: 'RESTORE' })).statusCode).toBe(200);
    expect(await figures(s)).toBe(figsB);
    expect((await restoreJson(s.app, { name: a.name, confirm: 'RESTORE' })).statusCode).toBe(200);
    expect(await figures(s)).toBe(figsA);
    await assertGlobalInvariants(s);
  });
});

describe('a bad file is refused and the live data stays exactly as it was', () => {
  async function live() {
    const s = await apiBase(await env.build());
    await buildWorld14(s);
    const before = snapshotAll(s.ctx);
    const figs = await figures(s);
    return { s, before, figs };
  }
  /** Same data, different bytes: copies the live database file (via a backup) and lets the test damage it. */
  async function goodBackup(s: ApiBase): Promise<{ bytes: Buffer; path: string }> {
    const b = (await post(s.app, '/backups', {})).body.item;
    const path = join(s.ctx.database.filePath, '..', 'backups', b.name);
    return { bytes: readFileSync(path), path };
  }
  async function expectIntact(s: ApiBase, before: Record<string, string>, figs: string): Promise<void> {
    // a refused restore writes nothing (an audit row for the refusal is not expected either)
    const changed = diffSnapshots(before, snapshotAll(s.ctx));
    expect(changed, `tables changed by a refused restore: ${changed.join(',')}`).toEqual([]);
    expect(await figures(s)).toBe(figs);
    await assertGlobalInvariants(s);
  }

  it('garbage bytes, an empty file, a text file, a truncated database and a database with damaged pages are refused 422', async () => {
    const { s, before, figs } = await live();
    const { bytes } = await goodBackup(s);
    const before2 = snapshotAll(s.ctx); // the backup request itself wrote an audit row
    const damaged = Buffer.from(bytes); for (let i = 4096; i < Math.min(damaged.length, 4096 + 2048); i++) damaged[i] = (damaged[i]! ^ 0xff);
    const cases: Array<[string, Buffer]> = [
      ['garbage', Buffer.from('this is not a database '.repeat(500))], ['empty', Buffer.alloc(0)], ['sqlite header only', bytes.subarray(0, 100)],
      ['truncated', bytes.subarray(0, Math.floor(bytes.length / 2))], ['damaged pages', damaged], ['zeros', Buffer.alloc(8192)],
    ];
    for (const [label, content] of cases) {
      const r = await upload(s.app, content);
      expect([400, 422], `${label}: ${r.statusCode} ${r.body.slice(0, 200)}`).toContain(r.statusCode);
      expect(['RESTORE_INVALID_FILE', 'RESTORE_INTEGRITY_FAILED', 'RESTORE_SCHEMA_MISSING', 'VALIDATION_ERROR'], `${label}: ${r.body.slice(0, 200)}`).toContain(r.json().error.code);
      await expectIntact(s, before2, figs);
    }
    void before;
  });

  it('a wrong or missing confirm word, an unknown name and a path-traversal name are refused', async () => {
    const { s, before, figs } = await live();
    for (const body of [{ name: 'viman-20250101-000000-manual.db' }, { name: 'viman-20250101-000000-manual.db', confirm: 'restore' }, { name: 'viman-20250101-000000-manual.db', confirm: 'RESTORE' },
      { name: '../viman.db', confirm: 'RESTORE' }, { name: '..\\viman.db', confirm: 'RESTORE' }, { name: 'viman.db', confirm: 'RESTORE' }]) {
      const r = await restoreJson(s.app, body);
      expect([400, 404], `${JSON.stringify(body)} -> ${r.statusCode} ${r.body}`).toContain(r.statusCode);
    }
    const noConfirm = await upload(s.app, Buffer.from('x'));
    expect(noConfirm.statusCode).not.toBe(200);
    const r2 = await restoreUpload(s.app, [{ name: 'file', filename: 'x.db', content: Buffer.from('x') }]);
    expect(r2.statusCode).toBe(400);
    await expectIntact(s, before, figs);
  });

  it('a valid database without the application tables, one from a NEWER version and one with a tampered migration checksum are refused', async () => {
    const { s, figs } = await live();
    const { bytes } = await goodBackup(s);
    const before = snapshotAll(s.ctx);
    const tmp = env.newDir('viman-bad-');
    const make = (name: string, fn: (db: DatabaseSync) => void): Buffer => {
      const p = join(tmp, name); writeFileSync(p, bytes);
      const db = new DatabaseSync(p);
      try { fn(db); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      return readFileSync(p);
    };
    const noTables = make('a.db', (db) => { db.exec('DROP TRIGGER audit_logs_no_update; DROP TRIGGER audit_logs_no_delete; DROP TABLE audit_logs'); });
    const newer = make('b.db', (db) => { db.exec("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '999_future.sql', 'x')"); });
    const tampered = make('c.db', (db) => { db.exec("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 5"); });
    const noMigrations = make('d.db', (db) => { db.exec('DROP TABLE schema_migrations'); });
    for (const [label, content, codes] of [
      ['required table missing', noTables, ['RESTORE_SCHEMA_MISSING']], ['newer schema', newer, ['RESTORE_SCHEMA_TOO_NEW']],
      ['tampered checksum', tampered, ['RESTORE_FAILED', 'RESTORE_INVALID_FILE', 'RESTORE_SCHEMA_MISSING']], ['no schema_migrations', noMigrations, ['RESTORE_SCHEMA_MISSING']],
    ] as Array<[string, Buffer, string[]]>) {
      const r = await upload(s.app, content);
      expect(codes, `${label}: ${r.statusCode} ${r.body.slice(0, 250)}`).toContain(r.json().error.code);
      expect([400, 422, 500]).toContain(r.statusCode);
      // the live data is back / untouched; a safety backup may have been written (it is a file, not a row), the audit log may mention the failed attempt
      const changed = diffSnapshots(before, snapshotAll(s.ctx));
      expect(changed.filter((t) => t !== 'audit_logs'), `${label}: tables changed`).toEqual([]);
      expect(await figures(s), `${label}: figures changed`).toBe(figs);
      await assertGlobalInvariants(s);
    }
  });

  it('an OLD-schema backup (version 8, before telecom/cash books/ice cream) is upgraded by the restore, its data survives and the system works', async () => {
    const s = await apiBase(await env.build());
    await buildWorld14(s);
    // an old database: migrations 001-008 only, with a little data written by raw SQL the way the old version would have
    const { migrate, loadMigrations } = await import('../db/migrate.ts');
    const dir = env.newDir('viman-old-');
    const oldMig = env.newDir('viman-oldmig-');
    for (const m of loadMigrations().filter((x) => x.version <= 8)) writeFileSync(join(oldMig, m.name), m.sql);
    const p = join(dir, 'old.db');
    const db = new DatabaseSync(p);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, oldMig);
    db.exec("INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Old product', (SELECT id FROM categories WHERE name='Other'), 'stock', 'shop', 1000, 100)");
    db.exec("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason) VALUES (1, '2025-01-05', 'opening', 3, 3000, 1000, 'old')");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const r = await upload(s.app, readFileSync(p), 'old.db');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().schemaVersion).toBe(latestVersion()); // was a literal 15 before migration 016
    const prods = (await get(s.app, '/products')).body.items as any[];
    expect(prods.map((x) => [x.name, x.qtyOnHand, x.stockValueCents])).toEqual([['Old product', 3, 3000]]);
    // the world's records are gone (replaced), the old file's data is live, the new tables exist and are empty
    expect(Number(rows(s.ctx, 'SELECT COUNT(*) n FROM sales')[0]!.n)).toBe(0);
    await assertGlobalInvariants(s);
    await must(await expNew(s, { businessDate: daysAgo(0), book: 'shop', category: 'other', amountCents: 100 }), 'works after restore');
  });

  it('GAP probe: a database whose stock cache disagrees with its movements restores (the restore checks integrity, not business consistency) but is then FLAGGED by the reconciliation', async () => {
    const s = await apiBase(await env.build());
    await buildWorld14(s);
    const { bytes } = await goodBackup(s);
    const tmp = env.newDir('viman-skew-');
    const p = join(tmp, 's.db'); writeFileSync(p, bytes);
    const db = new DatabaseSync(p);
    db.exec('UPDATE products SET qty_on_hand = qty_on_hand + 1 WHERE id = 1');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
    const r = await upload(s.app, readFileSync(p), 's.db');
    // either the restore refuses an inconsistent file (best), or it accepts it and the reconciliation must not say "ok"
    if (r.statusCode === 200) {
      const rec = (await get(s.app, '/inventory/reconciliation')).body;
      expect(rec.ok, 'an inconsistent restore must be visible in the reconciliation').toBe(false);
      const dash = (await get(s.app, '/dashboard')).body;
      expect(JSON.stringify(dash.warnings) + JSON.stringify(dash.stock), 'dashboard shows the mismatch').toMatch(/STOCK_CACHE_MISMATCH|mismatch/i);
    } else expect([400, 422]).toContain(r.statusCode);
  });
});

void countsAll; void copyFileSync;
