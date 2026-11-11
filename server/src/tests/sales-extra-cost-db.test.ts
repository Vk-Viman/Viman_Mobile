// Phase 5 amendment, database level: migration 008 (extra cost on sales, BUSINESS_RULES C13) - raw SQL on in-memory / temp SQLite, no HTTP.
// Protects the schema-level guarantees behind the editable sale cost, so no app bug, retry or manual edit can corrupt it:
//   C13  the three new columns exist, default to 0 (old rows keep their meaning) and can never be negative (CHECK);
//   C5/R1 a saved sale line's extra cost is frozen (SALE_ITEM_IMMUTABLE on UPDATE OF extra_cost_cents), while the normal
//         returned_qty counter still moves;
//   C13/C5 all returns of one line together can never take back more extra cost than the line carries (RETURN_EXCEEDS_EXTRA_COST);
//   R1   the return tables stay append-only, extra columns included;
//   C13  the extra cost never touches stock: a sale with an extra cost commits / rolls back with its movement and cash entry only.
// Organised by area: migration 008 and the v7 -> v8 upgrade, CHECK constraints, immutability, the return backstop, append-only, rollback.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase } from '../db/db.ts';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { issueStock, receiveStock } from '../services/inventory.service.ts';
import { TestEnv } from './helpers/tmp.ts';
import { memDb, msgOf, pool, scalar, sqlProduct, today } from './helpers/inventory.ts';
import { sqlReturn, sqlReturnItem, sqlSale, sqlSaleItem } from './helpers/phase5.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

/** Puts `units` units worth `value` cents into a product's pool (what a purchase does). */
const stock = (c: DatabaseSync, p: number, units: number, value: number) =>
  receiveStock(c, { productId: p, businessDate: today(), type: 'purchase', qty: units, valueCents: value, refTable: null, refId: null, reason: 'seed' });
const upd = (c: DatabaseSync, table: string, col: string, val: unknown, id: number) =>
  c.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(val as any, id);
const colsOf = (c: DatabaseSync, table: string) =>
  (c.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);

// =============================================================================================
// Migration 008: version, columns, triggers, and the upgrade from a version-7 database.
describe('migration 008', () => {
  it('fresh DB reaches latestVersion >= 8; the three extra-cost columns are NOT NULL DEFAULT 0; both triggers exist', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(8);
    expect(currentVersion(c)).toBe(latestVersion());
    expect(loadMigrations().some((m) => m.name === '008_sale_extra_cost.sql')).toBe(true);
    for (const [table, col] of [['sale_items', 'extra_cost_cents'], ['sales_return_items', 'extra_cost_cents'], ['sales_returns', 'extra_cost_reversed_cents']] as const) {
      const meta = colsOf(c, table).find((x) => x.name === col);
      expect(meta, `${table}.${col}`).toBeDefined();
      expect(meta).toMatchObject({ notnull: 1, dflt_value: '0' });
    }
    const triggers = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name);
    expect(triggers).toEqual(expect.arrayContaining(['trg_sale_items_extra_cost_immutable', 'trg_sales_return_items_extra_exceeds']));
  });

  // An older shop database (version 7) upgrades without losing a row; its old sale and return count as "no extra cost".
  it('v7 -> v8 upgrade keeps existing sales, lines and returns; old rows get extra 0; new columns usable', () => {
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 7)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const c = new DatabaseSync(join(dir, 'v7.db'));
    conns.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    expect(migrate(c, mdir).version).toBe(7);
    expect(colsOf(c, 'sale_items').map((x) => x.name)).not.toContain('extra_cost_cents');
    // an old sale with one returned unit, written with the version-7 columns only
    const pid = sqlProduct(c);
    const sale = sqlSale(c, { total: 300000 });
    const item = sqlSaleItem(c, sale, pid, { qty: 3, price: 100000, revenue: 300000, cogs: 70000 });
    const ret = sqlReturn(c, sale, { refund: 100000, cogs: 23333 });
    sqlReturnItem(c, ret, item, 1);

    const r = migrate(c);
    expect(r.applied[0]).toBe('008_sale_extra_cost.sql');
    expect(currentVersion(c)).toBe(latestVersion());
    // nothing lost, every old row reads as "no extra cost"
    expect(scalar(c, 'SELECT COUNT(*) FROM sales')).toBe(1);
    expect(scalar(c, 'SELECT total_cents FROM sales WHERE id = ?', sale)).toBe(300000);
    expect(c.prepare('SELECT cogs_cents, extra_cost_cents FROM sale_items WHERE id = ?').get(item)).toMatchObject({ cogs_cents: 70000, extra_cost_cents: 0 });
    expect(c.prepare('SELECT cogs_reversed_cents, extra_cost_reversed_cents FROM sales_returns WHERE id = ?').get(ret)).toMatchObject({ cogs_reversed_cents: 23333, extra_cost_reversed_cents: 0 });
    expect(scalar(c, 'SELECT extra_cost_cents FROM sales_return_items')).toBe(0);
    // the new columns work on the upgraded database (a new sale line with an extra, and its partial return)
    const sale2 = sqlSale(c);
    const item2 = sqlSaleItem(c, sale2, pid, { qty: 2, price: 100000, revenue: 200000, cogs: 50000, extra: 400 });
    const ret2 = sqlReturn(c, sale2, { extra: 200 });
    sqlReturnItem(c, ret2, item2, 1, { extra: 200 });
    expect(scalar(c, 'SELECT extra_cost_cents FROM sale_items WHERE id = ?', item2)).toBe(400);
    expect(migrate(c).applied).toEqual([]);
  });
});

// =============================================================================================
// CHECK constraints: an extra cost can never be negative, on all three tables; defaults to 0.
describe('extra cost CHECK constraints (C13)', () => {
  it('sale_items.extra_cost_cents: default 0, zero and positive accepted, negative rejected', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const a = sqlSaleItem(c, sale, p, { lineNo: 1 });
    expect(scalar(c, 'SELECT extra_cost_cents FROM sale_items WHERE id = ?', a)).toBe(0);          // default when not given
    sqlSaleItem(c, sale, p, { lineNo: 2, extra: 0 });
    sqlSaleItem(c, sale, p, { lineNo: 3, extra: 12345 });
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 4, extra: -1 }))).toMatch(/CHECK/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sale_items')).toBe(3);
  });

  it('sales_return_items.extra_cost_cents: default 0, negative rejected', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p, { qty: 5, price: 20000, revenue: 100000, extra: 500 });
    const ret = sqlReturn(c, sale);
    const a = sqlReturnItem(c, ret, item, 1);
    expect(scalar(c, 'SELECT extra_cost_cents FROM sales_return_items WHERE id = ?', a)).toBe(0);
    sqlReturnItem(c, ret, item, 1, { extra: 100 });
    expect(msgOf(() => sqlReturnItem(c, ret, item, 1, { extra: -1 }))).toMatch(/CHECK/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_return_items')).toBe(2);
  });

  it('sales_returns.extra_cost_reversed_cents: default 0, negative rejected', () => {
    const c = memDb(conns);
    const sale = sqlSale(c);
    const a = sqlReturn(c, sale);
    expect(scalar(c, 'SELECT extra_cost_reversed_cents FROM sales_returns WHERE id = ?', a)).toBe(0);
    sqlReturn(c, sale, { extra: 700 });
    expect(msgOf(() => sqlReturn(c, sale, { extra: -1 }))).toMatch(/CHECK/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns')).toBe(2);
  });
});

// =============================================================================================
// A sold line is frozen: the extra cost of a saved line can never change (C5, R1).
describe('sale_items extra cost is immutable', () => {
  it('SALE_ITEM_IMMUTABLE on UPDATE OF extra_cost_cents (up, down, from 0); a same-value update is harmless', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const withExtra = sqlSaleItem(c, sale, p, { lineNo: 1, extra: 300 });
    const noExtra = sqlSaleItem(c, sale, p, { lineNo: 2 });
    expect(msgOf(() => upd(c, 'sale_items', 'extra_cost_cents', 301, withExtra))).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sale_items', 'extra_cost_cents', 0, withExtra))).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sale_items', 'extra_cost_cents', 1, noExtra))).toMatch(/SALE_ITEM_IMMUTABLE/);
    upd(c, 'sale_items', 'extra_cost_cents', 300, withExtra);          // same value: no change, no error
    expect(scalar(c, 'SELECT extra_cost_cents FROM sale_items WHERE id = ?', withExtra)).toBe(300);
    expect(scalar(c, 'SELECT extra_cost_cents FROM sale_items WHERE id = ?', noExtra)).toBe(0);
  });

  // The service raises returned_qty after every return; the new trigger must not get in its way.
  it('the returned_qty counter still moves on a line that carries an extra cost', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p, { qty: 3, price: 100000, revenue: 300000, extra: 300 });
    c.prepare('UPDATE sale_items SET returned_qty = returned_qty + 1 WHERE id = ?').run(item);
    expect(c.prepare('SELECT returned_qty, extra_cost_cents FROM sale_items WHERE id = ?').get(item)).toMatchObject({ returned_qty: 1, extra_cost_cents: 300 });
  });
});

// =============================================================================================
// Backstop: all returns of a line together may not reverse more extra cost than the line carries.
describe('RETURN_EXCEEDS_EXTRA_COST (C13 backstop)', () => {
  // Hand calculation: line extra 100. Return A reverses 60 -> 60 <= 100 ok. Return B 41: 60 + 41 = 101 > 100 refused;
  // 40: 60 + 40 = 100 ok (exactly the line extra). Now 100 is used up: even 1 more is refused, but 0 is fine.
  it('cumulative reversed extra over several returns can never exceed the line extra', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p, { qty: 5, price: 20000, revenue: 100000, extra: 100 });
    const a = sqlReturn(c, sale);
    const b = sqlReturn(c, sale);
    const d = sqlReturn(c, sale);
    sqlReturnItem(c, a, item, 1, { extra: 60 });
    expect(msgOf(() => sqlReturnItem(c, b, item, 1, { extra: 41 }))).toMatch(/RETURN_EXCEEDS_EXTRA_COST/);
    sqlReturnItem(c, b, item, 1, { extra: 40 });
    expect(msgOf(() => sqlReturnItem(c, d, item, 1, { extra: 1 }))).toMatch(/RETURN_EXCEEDS_EXTRA_COST/);
    sqlReturnItem(c, d, item, 1, { extra: 0 });
    expect(scalar(c, 'SELECT SUM(extra_cost_cents) FROM sales_return_items WHERE sale_item_id = ?', item)).toBe(100);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_return_items')).toBe(3);
  });

  // A line without an extra cost can never reverse one; a single return larger than the line extra is refused too.
  it('a line with extra 0 cannot reverse any; one return above the line extra is refused; other lines are independent', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const plain = sqlSaleItem(c, sale, p, { lineNo: 1, qty: 5, price: 20000, revenue: 100000 });
    const rich = sqlSaleItem(c, sale, p, { lineNo: 2, qty: 5, price: 20000, revenue: 100000, extra: 50 });
    const ret = sqlReturn(c, sale);
    expect(msgOf(() => sqlReturnItem(c, ret, plain, 1, { extra: 1 }))).toMatch(/RETURN_EXCEEDS_EXTRA_COST/);
    expect(msgOf(() => sqlReturnItem(c, ret, rich, 1, { extra: 51 }))).toMatch(/RETURN_EXCEEDS_EXTRA_COST/);
    sqlReturnItem(c, ret, rich, 1, { extra: 50 });          // the other line's extra does not count against this one
    sqlReturnItem(c, ret, plain, 1, { extra: 0 });
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_return_items')).toBe(2);
  });
});

// =============================================================================================
// The return tables stay append-only, including the new columns.
describe('return tables stay append-only (R1)', () => {
  it('UPDATE and DELETE of the extra-cost columns / rows are refused', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p, { qty: 5, price: 20000, revenue: 100000, extra: 500 });
    const ret = sqlReturn(c, sale, { extra: 100 });
    const ri = sqlReturnItem(c, ret, item, 1, { extra: 100 });
    expect(msgOf(() => upd(c, 'sales_returns', 'extra_cost_reversed_cents', 5, ret))).toMatch(/append-only/);
    expect(msgOf(() => upd(c, 'sales_return_items', 'extra_cost_cents', 5, ri))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM sales_return_items WHERE id = ?').run(ri))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM sales_returns WHERE id = ?').run(ret))).toMatch(/append-only/);
    expect(c.prepare('SELECT extra_cost_reversed_cents FROM sales_returns WHERE id = ?').get(ret)).toMatchObject({ extra_cost_reversed_cents: 100 });
    expect(scalar(c, 'SELECT extra_cost_cents FROM sales_return_items WHERE id = ?', ri)).toBe(100);
  });
});

// =============================================================================================
// All-or-nothing: a sale with an extra cost, its stock movement and cash entry commit or roll back together; the extra never moves stock.
describe('transaction rollback with an extra-cost sale', () => {
  // Hand calculation: pool 10 / 5,000 (average 500). Sale of 4: COGS = 5,000 x 4 / 10 = 2,000; entered cost 600 each -> charged 2,400,
  // extra 400. Stock leaves at 2,000 only -> pool 6 / 3,000 with or without the extra.
  it('a failed tx leaves no sale, line, movement or cash; the committed sale keeps extra 400 and pool 6 / 3,000', () => {
    const dir = env.newDir();
    const db = new AppDatabase(join(dir, 'tx.db'));
    try {
      migrate(db.conn);
      const p = sqlProduct(db.conn);
      db.tx((c) => stock(c, p, 10, 5000));
      const counts = () => ({
        sales: scalar(db.conn, 'SELECT COUNT(*) FROM sales'), items: scalar(db.conn, 'SELECT COUNT(*) FROM sale_items'),
        mov: scalar(db.conn, 'SELECT COUNT(*) FROM stock_movements'), cash: scalar(db.conn, 'SELECT COUNT(*) FROM cash_entries'),
      });
      const before = counts();
      expect(before).toEqual({ sales: 0, items: 0, mov: 1, cash: 0 });

      const writeSale = (c: DatabaseSync) => {
        const sale = sqlSale(c, { total: 100000 });
        sqlSaleItem(c, sale, p, { qty: 4, price: 25000, revenue: 100000, cogs: 2000, extra: 400 });
        issueStock(c, { productId: p, businessDate: today(), type: 'sale', qty: 4, refTable: 'sales', refId: sale, reason: 'x' });
        c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', ?, 'sale_goods', 100000, 'sales', ?)").run(today(), sale);
        return sale;
      };

      expect(() => db.tx((c) => {
        writeSale(c);
        expect(pool(c, p)).toEqual({ qty: 6, value: 3000 });      // the extra 400 is not part of the stock movement
        throw new Error('boom after cash entry');
      })).toThrow(/boom after cash entry/);
      expect(counts()).toEqual(before);
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      // a line whose extra cost is negative fails the CHECK and takes the earlier statements with it
      expect(() => db.tx((c) => {
        const sale = sqlSale(c, { total: 100000 });
        issueStock(c, { productId: p, businessDate: today(), type: 'sale', qty: 4, refTable: 'sales', refId: sale, reason: 'x' });
        sqlSaleItem(c, sale, p, { qty: 4, price: 25000, revenue: 100000, cogs: 2000, extra: -1 });
      })).toThrow(/CHECK/);
      expect(counts()).toEqual(before);
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      db.tx((c) => writeSale(c));
      expect(counts()).toEqual({ sales: 1, items: 1, mov: 2, cash: 1 });
      expect(pool(db.conn, p)).toEqual({ qty: 6, value: 3000 });
      expect(scalar(db.conn, 'SELECT extra_cost_cents FROM sale_items')).toBe(400);
      expect(scalar(db.conn, "SELECT value_delta_cents FROM stock_movements WHERE type = 'sale'")).toBe(-2000);
    } finally { db.close(); }
  });
});
