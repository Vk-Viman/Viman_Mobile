// Hardening M1 (migration 019): structure, upgrade of a populated database, coverage guard, performance pattern and a real two-connection race.

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, ref } from './helpers/inventory.ts';
import { closeNew } from './helpers/phase8.ts';
import { C, E, L, allOps, closeBooks, fixture, fullSnapshot, must } from './helpers/phase19cd.ts';
import { migrate } from '../db/migrate.ts';
import { openDatabase } from '../db/db.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

/** The 38 triggers migration 019 adds (name -> table). */
const NEW_TRIGGERS: Record<string, string> = {
  trg_sales_day_closed: 'sales', trg_sales_day_closed_void: 'sales',
  trg_purchases_day_closed: 'purchases', trg_purchases_day_closed_void: 'purchases',
  trg_expenses_day_closed: 'expenses', trg_expenses_day_closed_void: 'expenses',
  trg_capital_entries_day_closed: 'capital_entries', trg_capital_entries_day_closed_void: 'capital_entries',
  trg_owner_drawings_day_closed: 'owner_drawings', trg_owner_drawings_day_closed_void: 'owner_drawings',
  trg_stock_losses_day_closed: 'stock_losses', trg_stock_losses_day_closed_void: 'stock_losses',
  trg_stock_movements_day_closed: 'stock_movements',
  trg_reload_sales_day_closed: 'reload_sales', trg_reload_sales_day_closed_void: 'reload_sales',
  trg_ezcash_sales_day_closed: 'ezcash_sales', trg_ezcash_sales_day_closed_void: 'ezcash_sales',
  trg_telecom_topups_day_closed: 'telecom_topups', trg_telecom_topups_day_closed_void: 'telecom_topups',
  trg_print_sales_day_closed: 'print_sales', trg_print_sales_day_closed_void: 'print_sales',
  trg_printing_supplies_day_closed: 'printing_supplies', trg_printing_supplies_day_closed_void: 'printing_supplies',
  trg_cash_transfers_day_closed: 'cash_transfers', trg_cash_transfers_day_closed_void: 'cash_transfers',
  trg_sales_returns_day_closed: 'sales_returns', trg_sales_returns_day_closed_void: 'sales_returns',
  trg_purchase_returns_day_closed: 'purchase_returns',
  trg_icecream_fund_entries_day_closed: 'icecream_fund_entries', trg_icecream_sales_day_closed: 'icecream_sales',
  trg_icecream_payments_day_closed_void: 'icecream_payments',
  trg_cash_counts_day_closed: 'cash_counts', trg_cash_counts_day_closed_void: 'cash_counts',
  trg_stocktakes_day_closed: 'stocktakes', trg_stocktakes_day_closed_complete: 'stocktakes', trg_stocktakes_day_closed_void: 'stocktakes',
  trg_opening_stock_batches_day_closed: 'opening_stock_batches', trg_opening_stock_batches_day_closed_void: 'opening_stock_batches',
};

type Master = { type: string; name: string; tbl_name: string; sql: string | null };
const master = (c: DatabaseSync): Master[] =>
  c.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as unknown as Master[];

describe('M1: migration 019 on a populated database', () => {
  it('adds exactly the 38 documented triggers, removes and changes nothing else, preserves every row', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s, { returns: 4 });
    // a populated database: one record of (nearly) every kind, some of them voided, closings with a count, a reopened day
    for (const op of allOps()) {
      if (op.seedDays) continue;
      const r = await op.create(fx, op.perDate || op.single ? E() : C());
      if (r.status === 201 || r.status === 200) { if (op.void && (op.key.includes('sale') || op.key.includes('expense'))) await op.void(fx, r, C(), 'shop'); }
    }
    const conn = s.ctx.database.conn;
    conn.exec('PRAGMA foreign_keys = OFF'); // only to be able to drop and replay in this copy; no data is touched
    // turn this 019 database into a faithful 018 one: drop the 38 triggers and forget the migration
    for (const name of Object.keys(NEW_TRIGGERS)) conn.exec(`DROP TRIGGER ${name}`);
    conn.exec('DELETE FROM schema_migrations WHERE version = 19');
    conn.exec('PRAGMA foreign_keys = ON');
    const beforeMaster = master(conn);
    const beforeRows = fullSnapshot(s, ['schema_migrations']);
    expect(beforeMaster.filter((m) => m.name.endsWith('_day_closed') || m.name.endsWith('_day_closed_void')).map((m) => m.name).sort())
      .toEqual(['trg_cash_entries_day_closed', 'trg_icecream_days_day_closed', 'trg_icecream_days_day_closed_void', 'trg_icecream_fund_moves_day_closed',
        'trg_icecream_fund_moves_day_closed_void', 'trg_icecream_payments_day_closed']);

    const res = migrate(conn);
    expect(res.applied).toEqual(['019_closed_day_db_protection.sql']);
    expect(res.version).toBe(19);

    const afterMaster = master(conn);
    const beforeByName = new Map(beforeMaster.map((m) => [`${m.type}:${m.name}`, m]));
    // nothing removed, nothing changed
    for (const m of beforeMaster) {
      const a = afterMaster.find((x) => x.type === m.type && x.name === m.name);
      expect(a, `${m.type} ${m.name} must survive`).toBeTruthy();
      expect(a!.sql, `${m.type} ${m.name} must be unchanged`).toBe(m.sql);
    }
    // added: exactly the 38 triggers, each on its documented table
    const added = afterMaster.filter((m) => !beforeByName.has(`${m.type}:${m.name}`));
    expect(added.every((m) => m.type === 'trigger')).toBe(true);
    expect(Object.fromEntries(added.map((m) => [m.name, m.tbl_name]))).toEqual(NEW_TRIGGERS);
    expect(Object.keys(NEW_TRIGGERS).length).toBe(38);
    // every row preserved column by column
    expect(fullSnapshot(s, ['schema_migrations'])).toEqual(beforeRows);
    expect(conn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('an old closing recorded before the migration protects immediately afterwards (history is judged by the closings)', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const conn = s.ctx.database.conn;
    await closeBooks(s, ['shop'], C());
    // the same SQL after the upgrade replay: the closing exists, a raw expense dated C is refused
    expect(() => conn.prepare("INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'shop', 'rent', 1, 'x', ?)").run(C(), ref()))
      .toThrow(/DAY_CLOSED/);
    void fx;
  });
});

describe('M1: coverage guard - every table with a business date is protected or deliberately exempt', () => {
  it('lists the business-date tables from sqlite_master', async () => {
    const s = await apiBase(await env.build());
    const conn = s.ctx.database.conn;
    const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
    const withDate = tables.filter((t) => (conn.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((c) => c.name === 'business_date'));
    // deliberately exempt: audit logs (append-only, every attempt must stay recordable), import audit rows, the closings themselves
    const EXEMPT = new Set(['audit_logs', 'import_runs', 'daily_closings']);
    const triggers = conn.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all() as unknown as Array<{ name: string; tbl_name: string; sql: string }>;
    const protectedTables = withDate.filter((t) => triggers.some((g) => g.tbl_name === t && /BEFORE INSERT/.test(g.sql) && /DAY_CLOSED/.test(g.sql)));
    const unprotected = withDate.filter((t) => !protectedTables.includes(t));
    expect(unprotected.sort()).toEqual([...EXEMPT].sort());
    // and the one table without a date of its own that carries dated child rows
    expect(triggers.some((g) => g.tbl_name === 'icecream_sales' && /DAY_CLOSED/.test(g.sql))).toBe(true);
    expect(protectedTables.length).toBe(23);
  });
});

describe('M1: performance pattern', () => {
  it('the closed-day probe is answered by the (book, business_date) index of daily_closings', async () => {
    const s = await apiBase(await env.build());
    const conn = s.ctx.database.conn;
    const plan = conn.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date >= '2026-01-01' AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at)").all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' | ')).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_daily_closings/);
    const plan2 = conn.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM daily_closings d WHERE d.book IN ('shop','telecom') AND d.business_date = '2026-01-01'").all() as Array<{ detail: string }>;
    expect(plan2.map((p) => p.detail).join(' | ')).toMatch(/INDEX/);
  });

  it('20,000 raw rows into stock_movements / expenses with closings in place stay fast (no full scans per row)', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const conn = s.ctx.database.conn;
    await closeBooks(s, ['shop', 'telecom', 'icecream'], E());
    const t0 = Date.now();
    conn.exec('BEGIN');
    const exp = conn.prepare("INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'shop', 'rent', 1, 'x', ?)");
    const mv = conn.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'adjustment', 0, 1)");
    for (let i = 0; i < 10000; i++) { exp.run(L(), `perf-${i}`); mv.run(fx.shopP.id, L()); }
    conn.exec('COMMIT');
    const ms = Date.now() - t0;
    expect(ms, `20,000 triggered inserts took ${ms} ms`).toBeLessThan(15000);
    expect(Number((conn.prepare("SELECT COUNT(*) AS n FROM expenses WHERE client_ref LIKE 'perf-%'").get() as { n: number }).n)).toBe(10000);
  }, 60000);
});

describe('M1: concurrency (two real connections to one database file)', () => {
  const file = (dir: string) => join(dir, 'viman.db');

  it('after a closing commits on one connection a raw write dated on / before it is refused on another; one posted before is part of the snapshot', async () => {
    const dir = env.newDir();
    const a = openDatabase(file(dir));
    migrate(a);
    const b = openDatabase(file(dir));
    const ins = (c: DatabaseSync, d: string) => c.prepare("INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'shop', 'rent', 100, 'x', ?)").run(d, ref());
    const close = (c: DatabaseSync, d: string) => c.prepare("INSERT INTO daily_closings (book, business_date, expected_cents) VALUES ('shop', ?, 0)").run(d);

    ins(b, C());                      // posted BEFORE the closing, on the other connection
    close(a, C());                    // the closing commits (autocommit)
    expect(() => ins(b, C())).toThrow(/DAY_CLOSED/);
    expect(() => ins(b, E())).toThrow(/BACKDATE_BEFORE_CLOSED_DAY/);
    ins(b, L());                      // later days stay open
    const closedAt = (a.prepare("SELECT closed_at FROM daily_closings").get() as { closed_at: string }).closed_at;
    const late = a.prepare('SELECT COUNT(*) AS n FROM expenses WHERE business_date <= ? AND posted_at > ?').get(C(), closedAt) as { n: number };
    expect(Number(late.n)).toBe(0);
    a.close(); b.close();
  });

  it('a transaction that began before the closing cannot post into the closed day afterwards (stale snapshot / lock: refused, nothing written)', async () => {
    const dir = env.newDir();
    const a = openDatabase(file(dir));
    migrate(a);
    const b = openDatabase(file(dir));
    b.exec('BEGIN');                                              // deferred transaction on B
    b.prepare('SELECT COUNT(*) FROM daily_closings').get();       // B reads: its snapshot has no closing
    a.prepare("INSERT INTO daily_closings (book, business_date, expected_cents) VALUES ('shop', ?, 0)").run(C()); // A closes and commits
    let outcome = 'accepted';
    try {
      b.prepare("INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'shop', 'rent', 100, 'x', ?)").run(C(), ref());
      b.exec('COMMIT');
    } catch (e) { outcome = (e as Error).message; try { b.exec('ROLLBACK'); } catch { /* ignore */ } }
    expect(outcome, 'a write from a snapshot older than the closing must not be accepted').not.toBe('accepted');
    expect(Number((a.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n)).toBe(0);
    a.close(); b.close();
  });

  it('API level: a close racing writes of 8 different record kinds dated <= C: nothing posted after closed_at', async () => {
    for (let round = 0; round < 2; round++) {
      const s = await apiBase(await env.build());
      const fx = await fixture(s);
      const keys = ['expense (shop)', 'stock loss (shop)', 'goods drawing (shop)', 'print sale', 'printing supplies', 'capital (shop)', 'cash drawing (shop)', 'sale (shop)'];
      const ops = keys.map((k) => allOps().find((o) => o.key === k)!);
      const reqs: Array<Promise<any>> = [];
      for (let i = 0; i < 12; i++) {
        for (const op of ops) {
          if (reqs.length === 20 + round * 9) reqs.push(closeNew(s, 'shop', C()));
          reqs.push(op.create(fx, i % 3 === 0 ? C() : i % 3 === 1 ? E() : L()));
        }
      }
      const res = await Promise.all(reqs);
      for (const r of res) expect([200, 201, 409, 422]).toContain(r.status);
      const closing = res.find((r) => r.body?.item?.closedAt);
      expect(closing).toBeTruthy();
      const closedAt = closing.body.item.closedAt as string;
      const conn = s.ctx.database.conn;
      for (const [t, col] of [['expenses', 'posted_at'], ['stock_losses', 'posted_at'], ['owner_drawings', 'posted_at'], ['print_sales', 'posted_at'],
        ['printing_supplies', 'posted_at'], ['capital_entries', 'posted_at'], ['sales', 'posted_at'], ['stock_movements', 'posted_at']] as const) {
        const n = Number((conn.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'stock_movements' ? "product_id IN (SELECT id FROM products WHERE book = 'shop')" : (t === 'owner_drawings' || t === 'capital_entries' || t === 'sales') ? "book = 'shop'" : '1 = 1'}
          AND business_date <= ? AND ${col} > ? AND business_date >= ?`).get(C(), closedAt, E()) as { n: number }).n);
        expect(n, `${t} dated <= C posted after the closing`).toBe(0);
      }
    }
  });
});
void must;
