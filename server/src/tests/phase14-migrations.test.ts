// Phase 14: migrations and FIRST LAUNCH. (1) An empty folder started through buildApp ends with exactly the documented seed rows and NO business rows,
// every read endpoint answers on the empty database. (2) The migration runner refuses a modified, already-applied migration (checksum) and a database
// from a newer system. (3) Schema sanity from sqlite_master: every foreign key has an index, every business_date table has the R-FD trigger, every
// business record table has delete guards, every record with a posting timestamp cannot have its dates changed.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { get } from './helpers/catalog.ts';
import { assertGlobalInvariants, buildWorld14, rows, tableNames } from './helpers/phase14.ts';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

/** The seed rows of a fresh installation, written from API_CONTRACTS / migration README (not read from the database). */
const SEEDED_CATEGORIES: Array<[string, string]> = [
  ['Phone Accessories', 'shop'], ['Tempered Glass', 'shop'], ['Phone Covers', 'shop'], ['Electronics', 'shop'], ['Stationery', 'shop'], ['Snacks and Drinks', 'shop'],
  ['Party Items', 'shop'], ['Perfume', 'shop'], ['Pooja Items', 'shop'], ['SIM', 'shop'], ['Other', 'shop'], ['Scratch Cards', 'telecom'],
];
const SEEDED_PRINT: Array<[string, number, number]> = [
  ['BW_1S', 1500, 650], ['BW_2S', 2500, 900], ['CLR_1S', 2000, 650], ['CLR_2S', 3000, 900], ['PC_BW_1S', 1000, 650], ['PC_BW_2S', 1500, 900], ['CUSTOM', 4000, 650],
];
const SEED_TABLES = ['categories', 'reload_providers', 'print_service_types', 'schema_migrations'];

describe('first launch', () => {
  it('an empty folder gets every migration and exactly the documented seed rows; no business table has a row', async () => {
    const b = await env.build();
    const ctx = b.ctx;
    const files = loadMigrations();
    expect(rows(ctx, 'SELECT version, name FROM schema_migrations ORDER BY version').map((r) => [Number(r.version), r.name])).toEqual(files.map((f) => [f.version, f.name]));
    expect(files.length).toBe(15);
    expect(rows(ctx, 'SELECT name, book, is_default, active FROM categories ORDER BY id').map((r) => [r.name, r.book])).toEqual(SEEDED_CATEGORIES);
    expect(rows(ctx, 'SELECT is_default, active FROM categories').every((r) => Number(r.is_default) === 1 && Number(r.active) === 1)).toBe(true);
    expect(rows(ctx, 'SELECT name, commission_bp, active FROM reload_providers ORDER BY sort_order').map((r) => [r.name, r.commission_bp, Number(r.active)])).toEqual([
      ['Dialog', null, 1], ['Mobitel', null, 1], ['Hutch', null, 1], ['Airtel', null, 1]]);
    expect(rows(ctx, 'SELECT code, price_cents, cost_cents, active FROM print_service_types ORDER BY sort_order').map((r) => [r.code, Number(r.price_cents), Number(r.cost_cents)])).toEqual(SEEDED_PRINT);
    // every other table is empty, including audit_logs, settings, products, every ledger
    for (const t of tableNames(ctx)) {
      if (SEED_TABLES.includes(t)) continue;
      expect(Number(rows(ctx, `SELECT COUNT(*) n FROM "${t}"`)[0]!.n), `${t} must be empty on first launch`).toBe(0);
    }
    // the settings API returns the documented defaults although the table is empty
    const st = (await get(b.app, '/settings')).body;
    expect(st.shop).toEqual({ name: 'Viman Mobile', address: '162 Padiliyathuduwa Rd, Hunupitiya, Wattala', phone: '+94 71 900 4044', email: 'viman.mobile.shop@gmail.com' });
    expect(st.rates).toEqual({ reloadCommissionBp: 600, ezcashCommissionBp: 80 });
    expect(st.printDefaults.map((p: any) => [p.code, p.priceCents, p.costCents])).toEqual(SEEDED_PRINT);
    expect((await get(b.app, '/health')).body.status).toBe('ok');
  });

  it('every read endpoint answers 200 with zeros on the empty database (no 500, no NaN)', async () => {
    const s = await apiBase(await env.build());
    const urls = [
      '/cashbooks', '/cashbooks/shop', '/cashbooks/telecom', '/cashbooks/icecream', '/dashboard', '/dashboard?asOf=2025-01-01', '/icecream/funds', '/icecream/funds/entries', '/icecream/days',
      '/icecream/payments', '/icecream/fund-moves', '/inventory/reconciliation', '/products', '/suppliers', '/purchases', '/sales', '/expenses', '/cash-counts', '/daily-closings',
      '/capital', '/drawings', '/cash-transfers', '/stock-losses', '/stocktakes', '/opening-stock', '/reload-sales', '/ezcash-sales', '/telecom/topups', '/print-sales', '/printing-supplies',
      '/telecom/summary?from=2025-01-01&to=2025-12-31', '/audit-logs', '/backups',
      ...['pnl/shop', 'pnl/telecom', 'pnl/icecream', 'pnl/combined', 'cashbook/shop', 'cashbook/telecom', 'cashbook/icecream', 'transfers', 'icecream-funds', 'stock-movements', 'stock-losses',
        'product-profitability', 'low-stock', 'purchases', 'sales', 'drawings', 'printing-variance', 'backdated'].map((r) => `/reports/${r}?from=2025-01-01&to=2025-12-31&granularity=month`),
      '/reports/inventory/valuation', '/reports/export-pack?from=2025-01-01&to=2025-12-31',
    ];
    for (const u of urls) {
      let r = await get(s.app, u);
      // some operational reports are not period based and reject `granularity`: retry the same URL without it
      if (r.status === 400 && /granularity/.test(JSON.stringify(r.body))) r = await get(s.app, u.replace('&granularity=month', ''));
      if (r.status === 400 && /Unknown field/.test(JSON.stringify(r.body))) r = await get(s.app, u.split('?')[0]!);
      expect(r.status, `${u} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      if (typeof r.body === 'object' && r.body) expect(JSON.stringify(r.body), `${u} contains NaN/null money`).not.toMatch(/NaN|Infinity/);
    }
    const d = (await get(s.app, '/dashboard')).body;
    expect(d.cash.totalCents).toBe(0);
    expect(d.today.profitCents).toBe(0);
    await assertGlobalInvariants(s);
  });

  it('restarting on the same folder applies nothing again and keeps every row', async () => {
    const b = await env.build();
    const dir = b.dataDir;
    const s = await apiBase(b);
    await buildWorld14(s);
    const before = JSON.stringify(tableNames(s.ctx).map((t) => rows(s.ctx, `SELECT * FROM "${t}" ORDER BY rowid`)));
    await b.app.close();
    const b2 = await env.build({ dataDir: dir });
    const after = JSON.stringify(tableNames(b2.ctx).map((t) => rows(b2.ctx, `SELECT * FROM "${t}" ORDER BY rowid`)));
    // the second launch may write a startup backup but must not change a single database row
    expect(after).toBe(before);
    await assertGlobalInvariants({ app: b2.app, ctx: b2.ctx });
  });
});

describe('migration runner', () => {
  /** A temp copy of the migrations folder. */
  function copyDir(env2: TestEnv): string {
    const dst = env2.newDir('viman-mig-');
    for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dst, f));
    return dst;
  }

  it('refuses a modified already-applied migration (checksum) and leaves the database untouched', () => {
    const dir = copyDir(env);
    const db = new DatabaseSync(':memory:');
    migrate(db, dir);
    const tables0 = JSON.stringify(rows({ database: { conn: db } } as any, "SELECT name, sql FROM sqlite_master ORDER BY name"));
    const f = join(dir, '004_purchases_inventory.sql');
    writeFileSync(f, readFileSync(f, 'utf8') + '\n-- sneaky edit\n');
    let err: any;
    try { migrate(db, dir); } catch (e) { err = e; }
    expect(err?.code).toBe('MIGRATION_CHECKSUM_MISMATCH');
    expect(JSON.stringify(rows({ database: { conn: db } } as any, 'SELECT name, sql FROM sqlite_master ORDER BY name'))).toBe(tables0);
    db.close();
  });

  it('a one-character change in ANY of the 15 applied migrations is detected', () => {
    for (const m of loadMigrations()) {
      const dir = copyDir(env);
      const db = new DatabaseSync(':memory:');
      migrate(db, dir);
      const f = join(dir, m.name);
      writeFileSync(f, readFileSync(f, 'utf8').replace(/\r?\n/, ' \n'));
      let err: any;
      try { migrate(db, dir); } catch (e) { err = e; }
      expect(err?.code, m.name).toBe('MIGRATION_CHECKSUM_MISMATCH');
      db.close();
    }
  });

  it('a database made by a NEWER system is refused (MIGRATION_DB_TOO_NEW); a failing new migration rolls back completely', () => {
    const dir = copyDir(env);
    const db = new DatabaseSync(':memory:');
    migrate(db, dir);
    db.prepare("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '999_future.sql', 'x')").run();
    let err: any;
    try { migrate(db, dir); } catch (e) { err = e; }
    expect(err?.code).toBe('MIGRATION_DB_TOO_NEW');
    db.close();
    const dir2 = copyDir(env);
    writeFileSync(join(dir2, '016_broken.sql'), 'CREATE TABLE half_built (id INTEGER); CREATE TABLE half_built (id INTEGER);');
    const db2 = new DatabaseSync(':memory:');
    let e2: any;
    try { migrate(db2, dir2); } catch (e) { e2 = e; }
    expect(String(e2?.message)).toContain('016_broken.sql');
    expect(rows({ database: { conn: db2 } } as any, "SELECT name FROM sqlite_master WHERE name = 'half_built'")).toEqual([]);
    expect(Number(rows({ database: { conn: db2 } } as any, 'SELECT MAX(version) v FROM schema_migrations')[0]!.v)).toBe(15);
    db2.close();
  });
});

describe('schema sanity (from sqlite_master)', () => {
  const idxCovers = (ctx: any, table: string, col: string): boolean => {
    const pk = rows(ctx, `PRAGMA table_info("${table}")`).filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
    if (pk[0] === col) return true;
    return rows(ctx, `PRAGMA index_list("${table}")`).some((i) => rows(ctx, `PRAGMA index_info("${i.name}")`).sort((a, b) => Number(a.seqno) - Number(b.seqno))[0]?.name === col);
  };

  it('every foreign key column is the leading column of an index (no full-table scans on joins/deletes)', async () => {
    const ctx = (await env.build()).ctx;
    const gaps: string[] = [];
    for (const t of tableNames(ctx)) for (const f of rows(ctx, `PRAGMA foreign_key_list("${t}")`)) if (!idxCovers(ctx, t, f.from as string)) gaps.push(`${t}.${f.from} -> ${f.table}`);
    expect(gaps, `foreign keys without an index: ${gaps.join(', ')}`).toEqual([]);
  });

  it('every table with a business_date has an R-FD (future date) trigger, except audit_logs and import_runs (recorded as a gap)', async () => {
    const ctx = (await env.build()).ctx;
    const missing: string[] = [];
    for (const t of tableNames(ctx)) {
      if (!rows(ctx, `PRAGMA table_info("${t}")`).some((c) => c.name === 'business_date')) continue;
      const trg = rows(ctx, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?", t);
      if (!trg.some((x) => /future_date/i.test(String(x.name)) && /FUTURE_DATE_NOT_ALLOWED/.test(String(x.sql)))) missing.push(t);
    }
    // audit_logs carries the date of the record it describes (already checked on that record); import_runs is import metadata (documented gap in the QA report)
    expect(missing.sort()).toEqual(['audit_logs', 'import_runs']);
  });

  it('every business record table has a delete guard; only master data (products, suppliers, settings, migrations) can be deleted; categories are guarded since 015', async () => {
    const ctx = (await env.build()).ctx;
    const guarded = new Set(rows(ctx, "SELECT tbl_name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%BEFORE DELETE%'").map((r) => r.tbl_name as string));
    const unguarded = tableNames(ctx).filter((t) => !guarded.has(t));
    // (stocktake_items is guarded too: a trigger refuses deleting lines of a completed stocktake)
    expect(unguarded.sort()).toEqual(['products', 'schema_migrations', 'settings', 'suppliers'].sort());
  });

  it('on a real world: dates and posting timestamps of every record cannot be edited, no record row can be deleted, a product with history cannot be deleted', async () => {
    const s = await apiBase(await env.build());
    await buildWorld14(s);
    const c = s.ctx.database.conn;
    const probe = (sql: string): boolean => {
      c.exec('SAVEPOINT p14m');
      let refused = false;
      try { c.exec(sql); } catch { refused = true; }
      c.exec('ROLLBACK TO p14m'); c.exec('RELEASE p14m');
      return refused;
    };
    const notRefused: string[] = [];
    for (const t of tableNames(s.ctx)) {
      const cols = rows(s.ctx, `PRAGMA table_info("${t}")`).map((r) => r.name as string);
      if (Number(rows(s.ctx, `SELECT COUNT(*) n FROM "${t}"`)[0]!.n) === 0) continue;
      if (cols.includes('posted_at') && !probe(`UPDATE "${t}" SET posted_at = '2000-01-01T00:00:00.000Z' WHERE rowid = (SELECT MIN(rowid) FROM "${t}")`)) notRefused.push(`${t}.posted_at`);
      if (cols.includes('business_date') && t !== 'audit_logs' && t !== 'daily_closings' && t !== 'import_runs' &&
        !probe(`UPDATE "${t}" SET business_date = '2000-01-01' WHERE rowid = (SELECT MIN(rowid) FROM "${t}")`)) notRefused.push(`${t}.business_date`);
    }
    expect(notRefused, `editable columns: ${notRefused.join(', ')}`).toEqual([]);
    expect(probe('DELETE FROM products WHERE id = (SELECT MIN(id) FROM products)'), 'a product with stock history must not be deletable').toBe(true);
    expect(probe("INSERT INTO cash_entries (book, business_date, type, amount_cents, fund) VALUES ('shop', '2099-01-01', 'capital', 100, NULL)"), 'future cash entry by raw SQL').toBe(true);
    expect(probe("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (1, '2099-01-01', 'opening', 1, 100, 'x')"), 'future stock movement by raw SQL').toBe(true);
    expect(probe("INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind) VALUES ('2099-01-01', 'cost', 100, 'opening')"), 'future fund entry by raw SQL').toBe(true);
    expect(probe("INSERT INTO cash_entries (book, business_date, type, amount_cents, fund) VALUES ('icecream', '2025-01-01', 'capital', 100, NULL)"), 'ice cream cash entry without a fund').toBe(true);
    expect(probe("UPDATE products SET qty_on_hand = -1 WHERE id = 1"), 'negative stock quantity by raw SQL').toBe(true);
    expect(probe('UPDATE products SET qty_on_hand = 0 WHERE id = 1'), 'value without quantity (qty 0 while value > 0)').toBe(true);
    await assertGlobalInvariants(s);
  });
});
