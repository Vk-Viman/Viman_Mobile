// PHASE 20 - migration 020, service level: the void services (reversal rows BEFORE the status flip), M3 / M4 on real returns, concurrent
// duplicate attempts, reconciliation after every void type, and the migration on a populated database.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct, pool, scalar, sqlProduct, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { poolOf } from './helpers/phase4.ts';
import { openNew, expNew, expVoid } from './helpers/phase8.ts';
import { cl, returnOk, rl, sellOk, sqlReturn, sqlReturnItem, sqlSale, sqlSaleItem, voidSaleNew } from './helpers/phase5.ts';
import { voidReturnOk, voidReturnNew } from './helpers/phase17.ts';
import { post } from './helpers/catalog.ts';
import { must } from './helpers/phase14.ts';
import {
  buildWorld19, bookBalances, dbIntegrity, fundBalances, n1, probe, returnedQtyProblems, reversalProblems, rows, stockProblems, voidNetProblems,
} from './helpers/phase19h.ts';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { receiveStock } from '../services/inventory.service.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

const attempt = (s: ApiBase, sql: string): string | null => probe(s.ctx, sql);
const mk = (s: ApiBase) => mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 });
const mvRows = (s: ApiBase, ret: number) => rows(s.ctx, 'SELECT id, type, qty_delta q, value_delta_cents v, reverses_movement_id link FROM stock_movements WHERE ref_table = ? AND ref_id = ? ORDER BY id', 'sales_returns', ret);

describe('return void: reversal rows first, linked, bounded (M2, M3)', () => {
  it('hand case (sweep 50 + removal 300): restock, sweep and removal are exactly the rows the rules allow; every second attempt is refused', async () => {
    const s = await apiBase(await env.build());
    const H = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await buy(s, [{ productId: H.id, packs: 1, packSize: 6, lineTotalCents: 600 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(H.id, 3, 250)], { businessDate: '2025-05-02' })).sales[0];
    const R = (await returnOk(s, sale.id, [rl(sale.items[0].id, 3, true)], { businessDate: '2025-05-03' })).item;
    await buy(s, [{ productId: H.id, packs: 1, packSize: 3, lineTotalCents: 450 }], { businessDate: '2025-05-04' });
    await sellOk(s, [cl(H.id, 6, 250)], { businessDate: '2025-05-05' });
    expect(poolOf(s, H.id)).toEqual({ qty: 3, value: 350 });
    await voidReturnOk(s, sale.id, R.id);
    expect(poolOf(s, H.id)).toEqual({ qty: 0, value: 0 });
    const m = mvRows(s, R.id);
    expect(m.map((r) => [r.type, Number(r.q), Number(r.v)])).toEqual([['sale_return', 3, 300], ['adjustment', 0, -50], ['sale_return', -3, -300]]);
    expect(m[0]!.link).toBeNull();
    expect(m[1]!.link).toBeNull();
    expect(Number(m[2]!.link)).toBe(Number(m[0]!.id));                      // the removal names the restock row it cancels
    await buy(s, [{ productId: H.id, packs: 1, packSize: 4, lineTotalCents: 400 }], { businessDate: '2025-05-06' });
    const base = (type: string, q: number, v: number, link: string) =>
      `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id,reverses_movement_id) VALUES (${H.id},'2025-05-03','${type}',${q},${v},'sales_returns',${R.id},${link})`;
    expect(attempt(s, base('adjustment', 0, -5, 'NULL')), 'second sweep').toMatch(/RETURN_NOT_VOID|UNIQUE/);
    expect(attempt(s, base('sale_return', 0, -5, 'NULL')), 'value-only sale_return').toMatch(/RETURN_NOT_VOID/);
    expect(attempt(s, base('sale_return', 0, -5, String(m[0]!.id))), 'value-only linked sale_return').not.toBeNull();
    expect(attempt(s, base('sale_return', -3, -300, String(m[0]!.id))), 'second removal of the same restock').not.toBeNull();
    expect(attempt(s, base('sale_return', -1, -1, 'NULL')), 'unlinked removal').toMatch(/RETURN_REVERSAL_EXCEEDS|RETURN_NOT_VOID/);
    expect(attempt(s, base('sale_return', 1, 10, 'NULL')), 'restock beyond the returned quantity').toMatch(/RETURN_RESTOCK_EXCEEDS/);
    expect(attempt(s, base('purchase', 1, 10, 'NULL')), 'other movement type referencing a return').toMatch(/RETURN_RESTOCK_EXCEEDS/);
    expect(stockProblems(s.ctx)).toEqual([]);
    expect(voidNetProblems(s.ctx).problems.filter((p) => !/stock net/.test(p))).toEqual([]);
  });

  it('M4: one refund entry and one restock per return line; the service writes exactly that', async () => {
    const s = await apiBase(await env.build());
    const X = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const R = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: '2025-05-03' })).item;
    expect(Number(scalar(s.ctx.database.conn, "SELECT COUNT(*) FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? AND reverses_entry_id IS NULL", R.id))).toBe(1);
    expect(attempt(s, `INSERT INTO cash_entries (book,business_date,type,amount_cents,ref_table,ref_id) VALUES ('shop','2025-05-03','sale_refund',-1,'sales_returns',${R.id})`)).toMatch(/UNIQUE/);
    expect(attempt(s, `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id) VALUES (${X.id},'2025-05-03','sale_return',1,100,'sales_returns',${R.id})`)).toMatch(/RETURN_RESTOCK_EXCEEDS/);
    // exactly the returned quantity is still possible only through the existing row: nothing left
    expect(attempt(s, `INSERT OR REPLACE INTO cash_entries (book,business_date,type,amount_cents,ref_table,ref_id) VALUES ('shop','2025-05-03','sale_refund',-1,'sales_returns',${R.id})`)).toMatch(/UNIQUE/);
  });

  it('a return that is not the newest cannot get reversal rows (RETURN_NOT_NEWEST), even raw; the service refuses first with the same code', async () => {
    const s = await apiBase(await env.build());
    const X = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const r1 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: '2025-05-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-05-04' })).item;
    const old = Number(scalar(s.ctx.database.conn, "SELECT id FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = ? AND qty_delta > 0", r1.id));
    expect(attempt(s, `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id,reverses_movement_id) VALUES (${X.id},'2025-05-03','sale_return',-2,-200,'sales_returns',${r1.id},${old})`)).toMatch(/RETURN_NOT_NEWEST/);
    const api = await voidReturnNew(s, sale.id, r1.id);
    expect(api.status).toBe(409);
    expect(api.body.error.code).toBe('RETURN_NOT_NEWEST');
    await voidReturnOk(s, sale.id, r2.id);
    await voidReturnOk(s, sale.id, r1.id);
    expect(returnedQtyProblems(s.ctx)).toEqual([]);
  });
});

describe('concurrent / repeated void attempts: exactly one set of reversal rows', () => {
  const reversalCounts = (s: ApiBase, table: string, id: number) => ({
    cash: n1(s.ctx, 'SELECT COUNT(*) FROM cash_entries WHERE ref_table = ? AND ref_id = ? AND reverses_entry_id IS NOT NULL', table, id),
    stock: n1(s.ctx, 'SELECT COUNT(*) FROM stock_movements WHERE ref_table = ? AND ref_id = ? AND reverses_movement_id IS NOT NULL', table, id),
  });

  it('parallel void requests of a sale, a sales return, a purchase and an expense: one success, the rest 409 ALREADY_VOID, one set of reversal rows', async () => {
    const s = await apiBase(await env.build());
    const X = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 1000000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 20, lineTotalCents: 2000 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const sale2 = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const R = (await returnOk(s, sale2.id, [rl(sale2.items[0].id, 2, true)], { businessDate: '2025-05-03' })).item;
    const pur = await buy(s, [{ productId: X.id, packs: 1, packSize: 2, lineTotalCents: 300 }], { businessDate: '2025-05-03' });
    const exp = (await must(await expNew(s, { businessDate: '2025-05-03', book: 'shop', category: 'rent', amountCents: 5000 }), 'expense')).item;
    const calls: Array<[string, number, () => Promise<{ status: number; body: any }>]> = [
      ['sales', sale.id, () => voidSaleNew(s, sale.id)],
      ['sales_returns', R.id, () => voidReturnNew(s, sale2.id, R.id)],
      ['purchases', pur.id, () => post(s.app, `/purchases/${pur.id}/void`, { reason: 'dup' })],
      ['expenses', exp.id, () => expVoid(s, exp.id)],
    ];
    for (const [table, id, call] of calls) {
      const before = reversalCounts(s, table, id);
      expect(before).toEqual({ cash: 0, stock: 0 });
      const res = await Promise.all([call(), call(), call(), call(), call()]);
      expect(res.filter((r) => r.status === 200).length, `${table}: successes`).toBe(1);
      expect(res.filter((r) => r.status === 409).length, `${table}: 409`).toBe(4);
      expect(res.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'ALREADY_VOID'), `${table}: code`).toBe(true);
      const after = reversalCounts(s, table, id);
      const originals = { cash: n1(s.ctx, 'SELECT COUNT(*) FROM cash_entries WHERE ref_table = ? AND ref_id = ? AND reverses_entry_id IS NULL', table, id),
        stock: n1(s.ctx, 'SELECT COUNT(*) FROM stock_movements WHERE ref_table = ? AND ref_id = ? AND reverses_movement_id IS NULL AND qty_delta <> 0 AND NOT (type = \'sale_return\' AND qty_delta < 0)', table, id) };
      expect(after.cash, `${table}: cash reversals`).toBe(originals.cash);
      expect(after.stock, `${table}: stock reversals`).toBe(originals.stock);
    }
    expect(stockProblems(s.ctx)).toEqual([]);
    expect(reversalProblems(s.ctx)).toEqual([]);
    expect(dbIntegrity(s.ctx)).toEqual([]);
  });

  it('a raw reversal that wins the race against a service void leaves exactly one set; the service attempt rolls back completely; later raw duplicates are refused', async () => {
    const s = await apiBase(await env.build());
    const X = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 1000000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 20, lineTotalCents: 2000 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const c = s.ctx.database.conn;
    const inflight = Promise.all([voidSaleNew(s, sale.id), voidSaleNew(s, sale.id)]);
    // synchronous raw writer running before the requests are handled: it writes the reversal rows of the sale
    const o = c.prepare("SELECT * FROM stock_movements WHERE ref_table = 'sales' AND ref_id = ?").get(sale.id) as any;
    c.prepare("INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id,reason,reverses_movement_id) VALUES (?,?,?,?,?,?,?,'raw',?)")
      .run(o.product_id, o.business_date, o.type, -o.qty_delta, -o.value_delta_cents, 'sales', sale.id, o.id);
    const oc = c.prepare("SELECT * FROM cash_entries WHERE ref_table = 'sales' AND ref_id = ?").get(sale.id) as any;
    c.prepare("INSERT INTO cash_entries (book,business_date,type,amount_cents,ref_table,ref_id,reverses_entry_id) VALUES (?,?,?,?,?,?,?)")
      .run(oc.book, oc.business_date, oc.type, -oc.amount_cents, 'sales', sale.id, oc.id);
    const res = await inflight;
    expect(res.every((r) => r.status >= 400)).toBe(true);                    // the services find the reversals already there and roll back
    expect(reversalCounts(s, 'sales', sale.id)).toEqual({ cash: 1, stock: 1 });
    expect(n1(s.ctx, "SELECT COUNT(*) FROM sales WHERE id = ? AND status = 'posted'", sale.id)).toBe(1);
    expect(attempt(s, `INSERT INTO cash_entries (book,business_date,type,amount_cents,ref_table,ref_id,reverses_entry_id) VALUES ('${oc.book}','${oc.business_date}','${oc.type}',${-oc.amount_cents},'sales',${sale.id},${oc.id})`)).toMatch(/UNIQUE/);
    // the raw writer completes the void itself: the flip is now accepted
    c.exec(`UPDATE sales SET status = 'void', voided_at = '${today()}T00:00:00.000Z', void_reason = 'raw' WHERE id = ${sale.id}`);
    expect(reversalCounts(s, 'sales', sale.id)).toEqual({ cash: 1, stock: 1 });
    expect(stockProblems(s.ctx)).toEqual([]);
  });
});

describe('after every void type (through the API) the books reconcile and every reversal is linked', () => {
  it('world with a void of every document type: stock = cache, cash ledger, Ice Cream funds, links of all new reversal rows', async () => {
    const s = await apiBase(await env.build());
    await buildWorld19(s);
    expect(stockProblems(s.ctx)).toEqual([]);
    expect(reversalProblems(s.ctx)).toEqual([]);
    expect(returnedQtyProblems(s.ctx)).toEqual([]);
    expect(dbIntegrity(s.ctx)).toEqual([]);
    expect(voidNetProblems(s.ctx).problems.filter((p) => !/stock net/.test(p))).toEqual([]);
    const f = fundBalances(s.ctx);
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(f.ledger)).toBe(sum(f.cash));                                  // Ice Cream funds (ledger) = Ice Cream cash book
    expect(sum(f.ledger)).toBe(bookBalances(s.ctx).icecream);
    expect(Object.values(bookBalances(s.ctx)).length).toBe(3);
    // every void record has all its originals reversed (the very rule of the VOID_WITHOUT_REVERSAL trigger), checked independently here
    for (const t of ['sales', 'sales_returns', 'purchases', 'stock_losses', 'stocktakes', 'owner_drawings', 'opening_stock_batches', 'expenses', 'capital_entries',
      'cash_counts', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales', 'printing_supplies', 'cash_transfers', 'icecream_days', 'icecream_payments', 'icecream_fund_moves']) {
      const bad = n1(s.ctx, `SELECT
        (SELECT COUNT(*) FROM cash_entries o JOIN ${t} d ON d.id = o.ref_id AND d.status = 'void' WHERE o.ref_table = '${t}' AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
           AND NOT EXISTS (SELECT 1 FROM cash_entries r WHERE r.reverses_entry_id = o.id))
        + (SELECT COUNT(*) FROM stock_movements o JOIN ${t} d ON d.id = o.ref_id AND d.status = 'void' WHERE o.ref_table = '${t}' AND o.reverses_movement_id IS NULL
           AND NOT (o.type = 'adjustment' AND o.qty_delta = 0) AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id))
        + (SELECT COUNT(*) FROM icecream_fund_entries o JOIN ${t} d ON d.id = o.ref_id AND d.status = 'void' WHERE o.ref_table = '${t}' AND o.reverses_entry_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r WHERE r.reverses_entry_id = o.id))`);
      expect(bad, `${t}: voided records with an unreversed original`).toBe(0);
    }
    // at least the purchase, the stock loss, a sale and returns were voided with linked movements
    expect(n1(s.ctx, 'SELECT COUNT(*) FROM stock_movements WHERE reverses_movement_id IS NOT NULL')).toBeGreaterThan(5);
  });
});

describe('migration 020 on a populated database', () => {
  it('keeps every row of every table byte for byte (only sqlite_master changes), and old records can be voided reversal-first afterwards', () => {
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version < 20)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const c = new DatabaseSync(join(dir, 'old.db'));
    conns.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    const v0 = migrate(c, mdir).version;
    expect(v0).toBeLessThan(20);

    // data written the way the app does it before migration 020
    const p = sqlProduct(c);
    receiveStock(c, { productId: p, businessDate: '2025-04-01', type: 'purchase', qty: 10, valueCents: 10000, refTable: null, refId: null, reason: 'seed' });
    const sale = sqlSale(c, { date: '2025-04-02', total: 300000 });
    const item = sqlSaleItem(c, sale, p, { qty: 3, price: 100000, cogs: 70000 });
    const mkRet = (qty: number, date: string) => {
      const id = sqlReturn(c, sale, { date, refund: 100000 * qty, cogs: 1000 * qty });
      sqlReturnItem(c, id, item, qty, { revenue: 100000 * qty, cogs: 1000 * qty });
      c.prepare('UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ?').run(qty, item);
      c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', ?, 'sale_refund', ?, 'sales_returns', ?)").run(date, -100000 * qty, id);
      c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (?, ?, 'sale_return', ?, ?, 'sales_returns', ?, 'r')").run(p, date, qty, 1000 * qty, id);
      return id;
    };
    const rVoid = mkRet(1, '2025-04-03');
    const rPosted = mkRet(1, '2025-04-04');
    // a legacy VOID return: flipped first, reversal rows written after it (the only order 017 allowed), no link column yet
    c.prepare("UPDATE sales_returns SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(rPosted);
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (?, '2025-04-04', 'sale_return', -1, -1000, 'sales_returns', ?, 'void')").run(p, rPosted);
    const orig = scalar(c, "SELECT id FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ?", rPosted);
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', '2025-04-04', 'sale_refund', 100000, 'sales_returns', ?, ?)").run(rPosted, orig);
    c.prepare("INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES ('2025-04-05', 'shop', 'rent', 500, 'x', 'exp-old-1')").run();
    const expId = scalar(c, "SELECT id FROM expenses WHERE client_ref = 'exp-old-1'");
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', '2025-04-05', 'expense', -500, 'expenses', ?)").run(expId);
    c.prepare("INSERT INTO audit_logs (entity, entity_id, action) VALUES ('expense', ?, 'create')").run(String(expId));

    const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => r.name);
    const snap = (db: DatabaseSync, colsOf: Record<string, string[]>) => JSON.stringify(Object.keys(colsOf).map((t) =>
      [t, db.prepare(`SELECT ${colsOf[t]!.map((x) => `"${x}"`).join(', ')} FROM "${t}" ORDER BY rowid`).all()]), (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    const snapT = (db: DatabaseSync, colsOf: Record<string, string[]>) => Object.fromEntries(Object.keys(colsOf).map((t) => [t, JSON.stringify(
      db.prepare(`SELECT ${colsOf[t]!.map((x) => `"${x}"`).join(', ')} FROM "${t}" ORDER BY rowid`).all(), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))]));
    const before: Record<string, string[]> = {};
    for (const t of tables(c)) before[t] = cols(c, t);
    const masterBefore = (c.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as any[]).map((r) => `${r.type}:${r.name}:${r.sql}`);
    const perTableBefore = snapT(c, before);
    expect(Object.keys(before).length).toBeGreaterThan(30);
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_movements')).toBeGreaterThan(3);

    const out = migrate(c);
    expect(out.applied).toContain('020_reversal_protection.sql');
    expect(currentVersion(c)).toBe(latestVersion());

    // every row of every table is identical (the only new column, stock_movements.reverses_movement_id, is NULL everywhere)
    const perTableAfter = snapT(c, before);
    // (schema_migrations itself only gains the row of the new migration: the old rows are identical)
    expect(perTableAfter.schema_migrations!.startsWith(perTableBefore.schema_migrations!.slice(0, -1))).toBe(true);
    for (const t of Object.keys(before).filter((x) => x !== 'schema_migrations')) expect(perTableAfter[t], `table ${t} changed`).toBe(perTableBefore[t]);
    expect(tables(c)).toEqual(Object.keys(before));
    expect(cols(c, 'stock_movements')).toEqual([...before.stock_movements!, 'reverses_movement_id']);
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_movements WHERE reverses_movement_id IS NOT NULL')).toBe(0);
    // sqlite_master: nothing was dropped except the triggers migration 020 re-creates; the rest is added
    const masterAfter = (c.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as any[]).map((r) => `${r.type}:${r.name}:${r.sql}`);
    expect(masterAfter).not.toEqual(masterBefore);
    const namesBefore = new Set(masterBefore.map((x) => x.split(':').slice(0, 2).join(':')));
    const namesAfter = new Set(masterAfter.map((x) => x.split(':').slice(0, 2).join(':')));
    for (const n of namesBefore) expect(namesAfter.has(n), `${n} must still exist`).toBe(true);
    const changed = masterBefore.filter((x) => !masterAfter.includes(x)).map((x) => x.split(':').slice(0, 2).join(':')).sort();
    expect(changed).toEqual(['table:stock_movements', 'trigger:trg_cash_entries_return_reversal', 'trigger:trg_stock_movements_return_reversal_cap', 'trigger:trg_stock_movements_return_reversal_void']);
    expect(rows({ database: { conn: c } } as any, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(rows({ database: { conn: c } } as any, 'PRAGMA integrity_check').map((r) => Object.values(r)[0])).toEqual(['ok']);

    // the old records behave: a legacy posted record is voided reversal-first; the legacy void return and its reversal cannot be repeated
    expect(() => c.prepare("UPDATE expenses SET status = 'void', voided_at = '2026-01-02T00:00:00.000Z', void_reason = 'x' WHERE id = ?").run(expId)).toThrow(/VOID_WITHOUT_REVERSAL/);
    const eo = scalar(c, "SELECT id FROM cash_entries WHERE ref_table = 'expenses' AND ref_id = ?", expId);
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', '2025-04-05', 'expense', 500, 'expenses', ?, ?)").run(expId, eo);
    c.prepare("UPDATE expenses SET status = 'void', voided_at = '2026-01-02T00:00:00.000Z', void_reason = 'x' WHERE id = ?").run(expId);
    expect(() => c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', '2025-04-04', 'sale_refund', 100000, 'sales_returns', ?, ?)").run(rPosted, orig)).toThrow(/UNIQUE|RETURN_REVERSAL_INVALID/);
    const restock = scalar(c, "SELECT id FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = ? AND qty_delta > 0", rPosted);
    expect(() => c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason, reverses_movement_id) VALUES (?, '2025-04-04', 'sale_return', -1, -1000, 'sales_returns', ?, 'again', ?)").run(p, rPosted, restock)).toThrow();
    // the still-posted legacy return rVoid (the newest posted one) is voided reversal-first through the stock link
    const restock2 = scalar(c, "SELECT id FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = ? AND qty_delta > 0", rVoid);
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason, reverses_movement_id) VALUES (?, '2025-04-03', 'sale_return', -1, -1000, 'sales_returns', ?, 'void', ?)").run(p, rVoid, restock2);
    const orig2 = scalar(c, "SELECT id FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ?", rVoid);
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', '2025-04-03', 'sale_refund', 100000, 'sales_returns', ?, ?)").run(rVoid, orig2);
    c.prepare("UPDATE sales_returns SET status = 'void', voided_at = '2026-01-02T00:00:00.000Z', void_reason = 'x' WHERE id = ?").run(rVoid);
    expect(scalar(c, "SELECT COUNT(*) FROM sales_returns WHERE status = 'posted'")).toBe(0);
    expect(pool(c, p)).toEqual({ qty: 10, value: 10000 });
  });
});
