// Sales discounts, migrations 027 (sale_items) and 028 (print_sales) on the FROZEN populated schema-26 database (fixtures/schema26-world.db, built by
// fixtures/make-schema26-fixture.ts through the real API BEFORE these migrations existed: Shop goods with partial / final returns, a void and a
// corrected sale; print / photocopy / other-service sales with a void and a correction; Telecom card sales in four segments with returns and a void;
// reloads, EZCash, top-ups, purchases, loss, stocktake, expenses, capital, drawings, transfers, counts, closed days).
// Proves: every row of every table is identical except the new columns (list = unit price, every discount column 0); every figure of the frozen figures
// JSON is reproduced (cash books, per-segment balances, P&Ls, valuation, dashboard, sale_items / print_sales sums and counts); the trigger / index /
// foreign-key sets are exactly the old ones plus the documented new ones; foreign_key_check and integrity_check are clean; the guards abort a corrupted
// copy or a sabotaged file with a full rollback; the generator still writes exactly the committed files; the objects on other tables that read
// sale_items (the return triggers) behave identically on a schema-26 and a schema-28 database.

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../db/migrate.ts';
import { generate027, generate028 } from '../db/gen/sales-discounts-sql.ts';
import { all, one } from './helpers/phase26db.ts';
import { get } from './helpers/catalog.ts';
import { sqlProduct } from './helpers/inventory.ts';
import { sqlReturn, sqlReturnItem, sqlSale, sqlSaleItem } from './helpers/phase5.ts';

const env = new TestEnv();
const open: DatabaseSync[] = [];
// every connection is closed BEFORE the temp folders are removed (Windows cannot delete an open database file)
afterEach(async () => { for (const c of open.splice(0)) { try { c.close(); } catch { /* already closed */ } } await env.cleanup(); });
const FIXTURE = join(import.meta.dirname, 'fixtures', 'schema26-world.db');
const F = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'schema26-world.figures.json'), 'utf8'));
const norm = (s: string): string => s.replaceAll('\r\n', '\n');
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));

type Master = { type: string; name: string; tbl_name: string; sql: string | null };
const master = (c: DatabaseSync): Master[] =>
  all(c, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name") as unknown as Master[];
const tablesOf = (c: DatabaseSync): string[] => all(c, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
const cols = (c: DatabaseSync, t: string): string[] => all(c, `PRAGMA table_info("${t}")`).map((r) => String(r.name));
const dump = (c: DatabaseSync, t: string): Array<Record<string, unknown>> => all(c, `SELECT * FROM "${t}" ORDER BY rowid`);
const seq = (c: DatabaseSync): Record<string, number> => Object.fromEntries(all(c, 'SELECT name, seq FROM sqlite_sequence').map((r) => [String(r.name), Number(r.seq)]));
const fks = (c: DatabaseSync, t: string) => json(all(c, `PRAGMA foreign_key_list("${t}")`));
const versionOf = (c: DatabaseSync): number => Number(one(c, 'SELECT MAX(version) FROM schema_migrations'));
const tempLeft = (c: DatabaseSync) => all(c, "SELECT name FROM sqlite_temp_master WHERE name LIKE '\\_mig02%' ESCAPE '\\'");

function openCopy(): DatabaseSync {
  const file = join(env.newDir(), 'world.db');
  copyFileSync(FIXTURE, file);
  const c = new DatabaseSync(file);
  open.push(c);
  c.exec('PRAGMA foreign_keys = ON');
  return c;
}

// ---- what 027 and 028 add / change (written out by hand, NOT read from the generator) ------------------------------------------------------------
const NEW_COLUMNS = ['list_unit_price_cents', 'unit_discount_cents', 'line_discount_cents', 'price_reduction_cents', 'bill_discount_cents'];
const NEW_TRIGGERS = ['trg_print_sales_list_price_default', 'trg_sale_items_list_price_default', 'trg_sale_items_telecom_no_discount'].sort();
const CHANGED_TRIGGERS = ['trg_print_sales_immutable', 'trg_sale_items_immutable'];
const SALE_ITEMS_OBJECTS = [
  'index:idx_sale_items_product', 'index:idx_sale_items_sale',
  'trigger:trg_sale_items_book_mismatch', 'trigger:trg_sale_items_extra_cost_immutable', 'trigger:trg_sale_items_immutable',
  'trigger:trg_sale_items_no_delete', 'trigger:trg_sale_items_segment_matches',
];
const PRINT_SALES_OBJECTS = [
  'index:idx_print_sales_business_date', 'index:idx_print_sales_posted_at', 'index:idx_print_sales_type_date',
  'trigger:trg_print_sales_business_date_immutable', 'trigger:trg_print_sales_day_closed', 'trigger:trg_print_sales_day_closed_void',
  'trigger:trg_print_sales_future_date', 'trigger:trg_print_sales_immutable', 'trigger:trg_print_sales_no_delete',
  'trigger:trg_print_sales_posted_at_immutable', 'trigger:trg_print_sales_type_active', 'trigger:trg_print_sales_void_requires_reversal',
];
const OTHER_TABLE_TRIGGERS = [
  'trg_sales_return_items_exceeds', 'trg_sales_return_items_extra_exceeds', 'trg_sales_return_items_mismatch', 'trg_sales_returns_void_effects',
  'trg_stock_movements_return_restock', 'trg_stock_movements_return_reversal_cap',
];
const objectsOn = (c: DatabaseSync, t: string): string[] =>
  all(c, "SELECT type, name FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name", t).map((r) => `${r.type}:${r.name}`);

describe('migrations 027-028 on the frozen schema-26 world', () => {
  it('the fixture is a rich schema-26 database (goods, returns, voids, corrections, services, four Telecom card segments, every other kind of record)', () => {
    const c = openCopy();
    expect(versionOf(c)).toBe(26);
    expect(cols(c, 'sale_items')).not.toContain('list_unit_price_cents');
    expect(cols(c, 'print_sales')).not.toContain('list_unit_price_cents');
    const n = (sql: string) => Number(one(c, sql));
    expect(n("SELECT COUNT(*) FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.book = 'shop' AND s.status = 'posted'")).toBeGreaterThan(15);
    expect(n("SELECT COUNT(*) FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.book = 'shop' AND s.status = 'void'")).toBeGreaterThan(2);
    expect(n('SELECT COUNT(*) FROM sale_items WHERE returned_qty > 0 AND returned_qty < qty')).toBeGreaterThan(1);  // partial returns
    expect(n('SELECT COUNT(*) FROM sale_items WHERE returned_qty = qty')).toBeGreaterThan(1);                      // final returns
    expect(n("SELECT COUNT(*) FROM sales_returns WHERE status = 'posted'")).toBeGreaterThan(8);
    expect(n("SELECT COUNT(DISTINCT s.segment) FROM sales s WHERE s.book = 'telecom'")).toBeGreaterThanOrEqual(4);
    expect(n("SELECT COUNT(*) FROM sales s JOIN sales_returns r ON r.sale_id = s.id WHERE s.book = 'telecom'")).toBeGreaterThan(2);
    expect(n("SELECT COUNT(*) FROM sales WHERE book = 'telecom' AND status = 'void'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM corrections WHERE entity = 'sales'")).toBe(1);
    expect(n("SELECT COUNT(*) FROM corrections WHERE entity = 'print_sales'")).toBe(1);
    expect(n("SELECT COUNT(*) FROM print_sales WHERE status = 'posted'")).toBeGreaterThan(5);
    expect(n("SELECT COUNT(*) FROM print_sales WHERE status = 'void'")).toBeGreaterThan(1);
    expect(n('SELECT COUNT(DISTINCT service_type_id) FROM print_sales')).toBeGreaterThanOrEqual(5);
    expect(n('SELECT COUNT(*) FROM reload_sales')).toBeGreaterThan(5);
    expect(n('SELECT COUNT(*) FROM ezcash_sales')).toBeGreaterThan(2);
    expect(n('SELECT COUNT(*) FROM telecom_topups')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) FROM stock_losses')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) FROM stocktakes')).toBeGreaterThan(2);
    expect(n('SELECT COUNT(*) FROM expenses')).toBeGreaterThan(8);
    expect(n('SELECT COUNT(*) FROM capital_entries')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) FROM owner_drawings')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) FROM cash_transfers')).toBeGreaterThan(4);
    expect(n('SELECT COUNT(*) FROM cash_counts')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) FROM daily_closings')).toBeGreaterThan(2);
    expect(n('SELECT COUNT(*) FROM purchases')).toBeGreaterThan(5);
    c.close();
  });

  it('every pre-existing row of every table is identical except the new columns (list = unit price, every discount 0); sequences, integrity and foreign keys intact', () => {
    const c = openCopy();
    const tables = tablesOf(c);
    const before = Object.fromEntries(tables.map((t) => [t, dump(c, t)]));
    const colsBefore = Object.fromEntries(tables.map((t) => [t, cols(c, t)]));
    const seqBefore = seq(c);
    const res = migrate(c);
    expect(res.applied).toEqual(['027_sale_items_discounts.sql', '028_print_sales_discounts.sql']);
    expect(res.version).toBe(28);

    expect(tablesOf(c)).toEqual(tables);                                // no table added or removed
    for (const t of tables) {
      const add = t === 'sale_items' || t === 'print_sales' ? NEW_COLUMNS : [];
      expect([...cols(c, t)].sort(), `${t}: columns`).toEqual([...colsBefore[t]!, ...add].sort());
      let after = dump(c, t);
      if (t === 'schema_migrations') after = after.filter((r) => Number(r.version) <= 26);
      expect(after.length, `${t}: row count`).toBe(before[t]!.length);
      expect(after.map((r) => Object.fromEntries(colsBefore[t]!.map((k) => [k, r[k]]))), `${t}: every pre-existing value`).toEqual(before[t]);
      for (const row of after) {
        for (const k of add) expect(row[k], `${t} #${row.id} ${k}`).toBe(k === 'list_unit_price_cents' ? row.unit_price_cents : 0);
      }
    }
    expect(seq(c)).toEqual(seqBefore);                                  // AUTOINCREMENT counters are exactly where they were
    expect(all(c, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version)).slice(-3)).toEqual([26, 27, 28]);
    expect(all(c, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(c, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(tempLeft(c)).toEqual([]);                                    // no leftover temp tables
    c.close();
  });

  it('the trigger / index / foreign-key sets are exactly the old sets plus the documented new objects; only the two immutable triggers and the two tables changed', () => {
    const c = openCopy();
    const pre = master(c);
    const fkBefore = { sale_items: fks(c, 'sale_items'), print_sales: fks(c, 'print_sales'), sales_return_items: fks(c, 'sales_return_items') };
    expect(objectsOn(c, 'sale_items')).toEqual([...SALE_ITEMS_OBJECTS].sort());     // the hand-written list really is the schema-26 set
    expect(objectsOn(c, 'print_sales')).toEqual([...PRINT_SALES_OBJECTS].sort());
    migrate(c);
    const post = master(c);
    const key = (m: Master) => `${m.type}:${m.name}`;
    const preBy = new Map(pre.map((m) => [key(m), m]));
    const postBy = new Map(post.map((m) => [key(m), m]));
    for (const m of pre) expect(postBy.has(key(m)), `${key(m)} must survive`).toBe(true);                       // nothing removed
    const added = post.filter((m) => !preBy.has(key(m)));
    expect(added.map(key).sort()).toEqual(NEW_TRIGGERS.map((n) => `trigger:${n}`).sort());                       // exactly the new triggers, no new index, table or view
    expect(NEW_TRIGGERS).toHaveLength(3);
    // the objects of the two tables: old set + new triggers
    expect(objectsOn(c, 'sale_items')).toEqual([...SALE_ITEMS_OBJECTS, 'trigger:trg_sale_items_list_price_default', 'trigger:trg_sale_items_telecom_no_discount'].sort());
    expect(objectsOn(c, 'print_sales')).toEqual([...PRINT_SALES_OBJECTS, 'trigger:trg_print_sales_list_price_default'].sort());
    // changed text: exactly the two tables and the two immutable triggers (everything else, on the two tables and on every other table, is character-identical)
    const changed = pre.filter((m) => norm(postBy.get(key(m))!.sql ?? '') !== norm(m.sql ?? ''));
    expect(changed.filter((m) => m.type === 'table').map((m) => m.name).sort()).toEqual(['print_sales', 'sale_items']);
    expect(changed.filter((m) => m.type !== 'table').map((m) => m.name).sort()).toEqual(CHANGED_TRIGGERS);
    for (const name of OTHER_TABLE_TRIGGERS) expect(postBy.get(`trigger:${name}`)!.sql, name).toBe(preBy.get(`trigger:${name}`)!.sql);  // byte-identical
    expect(postBy.get('table:sales_return_items')!.sql).toBe(preBy.get('table:sales_return_items')!.sql);
    // foreign keys of the two tables and of the child table are unchanged
    expect({ sale_items: fks(c, 'sale_items'), print_sales: fks(c, 'print_sales'), sales_return_items: fks(c, 'sales_return_items') }).toEqual(fkBefore);
    expect(fkBefore.sales_return_items.map((r: any) => r.table).sort()).toEqual(['sale_items', 'sales_returns']);
    c.close();
  });

  it('the new immutable triggers name every new column; nothing else of the old text was dropped', () => {
    const c = openCopy();
    const old = Object.fromEntries(['trg_sale_items_immutable', 'trg_print_sales_immutable'].map((n) => [n, norm(String(one(c, `SELECT sql FROM sqlite_master WHERE name = '${n}'`)))]));
    migrate(c);
    for (const n of CHANGED_TRIGGERS) {
      const now = norm(String(one(c, `SELECT sql FROM sqlite_master WHERE name = '${n}'`)));
      for (const col of NEW_COLUMNS) expect(now, `${n} covers ${col}`).toContain(`NEW.${col} IS NOT OLD.${col}`);
      // every old condition line is still there
      for (const line of old[n]!.split('\n').filter((l) => l.trim().startsWith('OR NEW.') || l.trim().startsWith('WHEN NEW.'))) expect(now, `${n}: ${line.trim()}`).toContain(line);
    }
    expect(String(one(c, "SELECT sql FROM sqlite_master WHERE name = 'trg_print_sales_immutable'"))).toMatch(/UPDATE OF[\s\S]*list_unit_price_cents[\s\S]*bill_discount_cents/);
    c.close();
  });

  it('every figure of the frozen figures JSON is reproduced by the upgraded database (cash books, segments, P&Ls, valuation, dashboard, sale_items / print_sales sums)', async () => {
    const dataDir = env.newDir();
    copyFileSync(FIXTURE, join(dataDir, 'viman.db'));
    const { app, ctx } = await env.build({ dataDir });                   // the application's own start-up runs 027 and 028
    const c = ctx.database.conn;
    expect(versionOf(c)).toBe(28);
    // through the API: byte-for-byte the figures taken at schema 26
    const q = 'from=2025-08-01&to=2025-09-30&granularity=month';
    expect(json((await get(app, '/cashbooks')).body)).toEqual(F.cashbooks);
    expect(json((await get(app, `/reports/pnl/shop?${q}`)).body)).toEqual(F.pnlShop);
    expect(json((await get(app, `/reports/pnl/telecom?${q}`)).body)).toEqual(F.pnlTelecom);
    expect(json((await get(app, `/reports/pnl/icecream?${q}`)).body)).toEqual(F.pnlIcecream);
    expect(json((await get(app, `/reports/pnl/combined?${q}`)).body)).toEqual(F.pnlCombined);
    expect(json((await get(app, '/reports/inventory/valuation')).body)).toEqual(F.valuation);
    expect(json((await get(app, '/dashboard?asOf=2025-09-15')).body)).toEqual(F.dashboard);
    // raw sums: cash per book and per segment
    expect(json(all(c, 'SELECT book, COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n FROM cash_entries GROUP BY book ORDER BY book'))).toEqual(F.cashByBook);
    expect(json(all(c, "SELECT book, COALESCE(segment,'') AS segment, COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n FROM cash_entries GROUP BY book, segment ORDER BY book, segment"))).toEqual(F.cashBySegment);
    expect(F.cashBySegment.filter((r: { book: string }) => r.book === 'telecom').length).toBeGreaterThanOrEqual(4);
    // sale_items and print_sales: counts and sums (revenue, cogs, extra cost, qty, returned qty)
    expect(json(all(c, `SELECT COUNT(*) AS n, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(returned_qty),0) AS returnedQty, COALESCE(SUM(revenue_cents),0) AS revenueCents,
      COALESCE(SUM(cogs_cents),0) AS cogsCents, COALESCE(SUM(extra_cost_cents),0) AS extraCostCents, COALESCE(SUM(unit_price_cents),0) AS unitPriceCents FROM sale_items`)[0])).toEqual(F.saleItems);
    expect(json(all(c, `SELECT s.book, COALESCE(s.segment,'') AS segment, s.status, COUNT(*) AS n, SUM(i.qty) AS qty, SUM(i.returned_qty) AS returnedQty,
      SUM(i.revenue_cents) AS revenueCents, SUM(i.cogs_cents) AS cogsCents, SUM(i.extra_cost_cents) AS extraCostCents
      FROM sale_items i JOIN sales s ON s.id = i.sale_id GROUP BY s.book, s.segment, s.status ORDER BY s.book, s.segment, s.status`))).toEqual(F.saleItemsByBook);
    expect(json(all(c, `SELECT COUNT(*) AS n, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(revenue_cents),0) AS revenueCents, COALESCE(SUM(cogs_cents),0) AS cogsCents,
      COALESCE(SUM(unit_price_cents),0) AS unitPriceCents, COALESCE(SUM(unit_cost_cents),0) AS unitCostCents FROM print_sales`)[0])).toEqual(F.printSales);
    expect(json(all(c, 'SELECT status, COUNT(*) AS n, SUM(qty) AS qty, SUM(revenue_cents) AS revenueCents, SUM(cogs_cents) AS cogsCents FROM print_sales GROUP BY status ORDER BY status'))).toEqual(F.printSalesByStatus);
    // the new columns on the real data: list = price, no discount anywhere, so gross = net
    expect(Number(one(c, 'SELECT COUNT(*) FROM sale_items WHERE list_unit_price_cents <> unit_price_cents OR unit_discount_cents <> 0 OR line_discount_cents <> 0 OR price_reduction_cents <> 0 OR bill_discount_cents <> 0'))).toBe(0);
    expect(Number(one(c, 'SELECT COUNT(*) FROM print_sales WHERE list_unit_price_cents <> unit_price_cents OR unit_discount_cents <> 0 OR line_discount_cents <> 0 OR price_reduction_cents <> 0 OR bill_discount_cents <> 0'))).toBe(0);
    // row counts of every table
    const counts = Object.fromEntries(tablesOf(c).filter((t) => t !== 'schema_migrations' && t in F.rowCounts).map((t) => [t, Number(one(c, `SELECT COUNT(*) FROM "${t}"`))]));
    expect(counts).toEqual(Object.fromEntries(Object.entries(F.rowCounts).filter(([t]) => t !== 'schema_migrations')));
    // sales.total_cents = sum of its lines' net revenue, for every sale (the invariant the discount feature relies on)
    expect(all(c, 'SELECT s.id FROM sales s WHERE s.total_cents <> (SELECT COALESCE(SUM(i.revenue_cents),0) FROM sale_items i WHERE i.sale_id = s.id)')).toEqual([]);
  });

  it('running the migrations again applies nothing', () => {
    const c = openCopy();
    migrate(c);
    expect(migrate(c).applied).toEqual([]);
    c.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the objects on other tables that read sale_items behave identically before (schema 26) and after (schema 28)', () => {
  /** A database migrated up to `max` only (a temp copy of the migration folder). */
  function dbAt(max: number): DatabaseSync {
    const dir = env.newDir();
    for (const f of loadMigrations().filter((m) => m.version <= max)) writeFileSync(join(dir, f.name), f.sql);
    const c = new DatabaseSync(':memory:');
    open.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    migrate(c, dir);
    return c;
  }
  const attempt = (c: DatabaseSync, fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as Error).message; } };

  /** Runs a scripted series of raw-SQL probes of the return triggers; returns what each did. Uses only columns that exist in schema 26 (the old INSERT path). */
  function probes(c: DatabaseSync): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const p = sqlProduct(c);
    const s1 = sqlSale(c, { date: '2025-03-10', total: 300000 });
    const i1 = sqlSaleItem(c, s1, p, { qty: 3, price: 100000, extra: 1000 });
    const s2 = sqlSale(c, { date: '2025-03-10', total: 100000 });
    sqlSaleItem(c, s2, p, { qty: 1, price: 100000 });
    const r1 = sqlReturn(c, s1, { date: '2025-03-11', refund: 200000 });
    const r2 = sqlReturn(c, s2, { date: '2025-03-11', refund: 100000 });
    out.item_ok = attempt(c, () => sqlReturnItem(c, r1, i1, 2, { revenue: 200000, extra: 600 }));
    c.prepare('UPDATE sale_items SET returned_qty = 2 WHERE id = ?').run(i1);
    out.exceeds = attempt(c, () => sqlReturnItem(c, r1, i1, 2, { revenue: 200000 }));
    out.mismatch = attempt(c, () => sqlReturnItem(c, r2, i1, 1, { revenue: 100000 }));
    out.extra_exceeds = attempt(c, () => sqlReturnItem(c, r1, i1, 1, { revenue: 100000, extra: 500 }));
    out.returned_down = attempt(c, () => c.prepare('UPDATE sale_items SET returned_qty = 0 WHERE id = ?').run(i1));
    out.qty_edit = attempt(c, () => c.prepare('UPDATE sale_items SET qty = 9 WHERE id = ?').run(i1));
    out.revenue_edit = attempt(c, () => c.prepare('UPDATE sale_items SET revenue_cents = 1 WHERE id = ?').run(i1));
    out.delete = attempt(c, () => c.prepare('DELETE FROM sale_items WHERE id = ?').run(i1));
    const mv = (type: string, qty: number) => attempt(c, () => c.prepare(
      "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id) VALUES (?, '2025-03-11', ?, ?, ?, 'sales_returns', ?)",
    ).run(p, type, qty, qty * 100, r1));
    out.restock_wrong_type = mv('sale', 2);
    out.restock_over = mv('sale_return', 3);
    out.restock_ok = mv('sale_return', 2);
    out.reversal_over = mv('sale_return', -3);
    out.reversal_ok = mv('sale_return', -2);
    // a return whose restock was not reversed cannot be voided
    const voidIt = (id: number) => attempt(c, () => c.prepare("UPDATE sales_returns SET status = 'void', voided_at = '2025-03-12T00:00:00Z', void_reason = 'x' WHERE id = ?").run(id));
    out.void_with_restock = voidIt(r1);
    // voiding a clean return rolls the returned quantity back through trg_sales_returns_void_effects
    const s3 = sqlSale(c, { date: '2025-03-10', total: 200000 });
    const i3 = sqlSaleItem(c, s3, p, { qty: 2, price: 100000 });
    const r3 = sqlReturn(c, s3, { date: '2025-03-11', refund: 100000 });
    out.item3 = attempt(c, () => sqlReturnItem(c, r3, i3, 1, { revenue: 100000 }));
    c.prepare('UPDATE sale_items SET returned_qty = 1 WHERE id = ?').run(i3);
    out.void_return = voidIt(r3);
    out.returned_after_void = one(c, 'SELECT returned_qty FROM sale_items WHERE id = ?', i3);
    out.items = json(all(c, 'SELECT id, sale_id, line_no, qty, unit_price_cents, revenue_cents, returned_qty, extra_cost_cents FROM sale_items ORDER BY id'));
    return out;
  }

  it('raw-SQL probes of trg_sales_return_items_*, trg_sales_returns_void_effects, trg_stock_movements_return_* give the same result on schema 26 and 28', () => {
    const old = probes(dbAt(26));
    const now = probes(dbAt(28));
    expect(now).toEqual(old);
    // the probes are not vacuous: the database really refused / accepted what the rules say
    expect(old.item_ok).toBe('ok');
    expect(old.exceeds).toMatch(/RETURN_EXCEEDS_SOLD/);
    expect(old.mismatch).toMatch(/RETURN_ITEM_MISMATCH/);
    expect(old.extra_exceeds).toMatch(/RETURN_EXCEEDS_EXTRA_COST/);
    expect(old.returned_down).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(old.qty_edit).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(old.revenue_edit).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(old.delete).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(old.restock_wrong_type).toMatch(/RETURN_RESTOCK_EXCEEDS/);
    expect(old.restock_over).toMatch(/RETURN_RESTOCK_EXCEEDS/);
    expect(old.restock_ok).toBe('ok');
    expect(old.reversal_over).toMatch(/RETURN_REVERSAL_EXCEEDS/);
    expect(old.void_with_restock).toMatch(/VOID_WITHOUT_REVERSAL/);
    expect(old.void_return).toBe('ok');
    expect(old.returned_after_void).toBe(0);
  });

  it('on the upgraded world the same return triggers still protect the old rows (a return over the sold quantity, a mismatch, an edit of an old line)', () => {
    const c = openCopy();
    migrate(c);
    const line = all(c, "SELECT i.id, i.sale_id, i.qty, i.returned_qty FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.book = 'shop' AND s.status = 'posted' AND i.returned_qty = i.qty LIMIT 1")[0]!;
    const ret = all(c, "SELECT id FROM sales_returns WHERE sale_id = ? AND status = 'posted' LIMIT 1", line.sale_id)[0]!;
    expect(() => c.prepare("INSERT INTO sales_return_items (sales_return_id, sale_item_id, qty, resalable, revenue_cents, cogs_cents) VALUES (?, ?, 1, 1, 0, 0)").run(ret.id, line.id)).toThrow(/RETURN_EXCEEDS_SOLD/);
    const other = all(c, 'SELECT id FROM sale_items WHERE sale_id <> ? LIMIT 1', line.sale_id)[0]!;
    expect(() => c.prepare("INSERT INTO sales_return_items (sales_return_id, sale_item_id, qty, resalable, revenue_cents, cogs_cents) VALUES (?, ?, 1, 1, 0, 0)").run(ret.id, other.id)).toThrow(/RETURN_ITEM_MISMATCH/);
    expect(() => c.prepare('UPDATE sale_items SET revenue_cents = revenue_cents + 1 WHERE id = ?').run(line.id)).toThrow(/SALE_ITEM_IMMUTABLE/);
    expect(() => c.prepare('UPDATE sale_items SET bill_discount_cents = 1 WHERE id = ?').run(line.id)).toThrow(/SALE_ITEM_IMMUTABLE/);
    expect(() => c.prepare('DELETE FROM print_sales WHERE id = (SELECT MIN(id) FROM print_sales)').run()).toThrow(/RECORD_DELETE_FORBIDDEN/);
    c.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the in-migration guards abort the whole migration (nothing half-applied) on a corrupted copy or a sabotaged file', () => {
  /** A temp copy of the migrations folder with one file's text changed. */
  function patchedDir(file: string, patch: (sql: string) => string): string {
    const dir = env.newDir();
    for (const f of loadMigrations()) writeFileSync(join(dir, f.name), f.name === file ? patch(f.sql) : f.sql);
    expect(readFileSync(join(dir, file), 'utf8')).not.toBe(loadMigrations().find((f) => f.name === file)!.sql); // the patch really changed something
    return dir;
  }
  const GUARD_MARK = '-- ===== guard: any difference aborts';

  /** What must be unchanged after a failed migration of `table` at `version`: schema text, every row of the table, no temp leftovers, no new columns. */
  function expectRolledBack(c: DatabaseSync, table: string, version: number, pre: Master[], rows: Array<Record<string, unknown>>): void {
    expect(versionOf(c)).toBe(version);
    expect(master(c)).toEqual(pre);
    expect(cols(c, table)).not.toContain('list_unit_price_cents');
    expect(dump(c, table)).toEqual(rows);
    expect(all(c, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(tempLeft(c)).toEqual([]);
    for (const n of OTHER_TABLE_TRIGGERS) expect(Number(one(c, `SELECT COUNT(*) FROM sqlite_master WHERE name = '${n}'`)), n).toBe(1);
  }

  it('027: a pre-existing broken foreign key (an orphan cash count) aborts it; the database stays at schema 26, schema and rows untouched', () => {
    const c = openCopy();
    c.exec('PRAGMA foreign_keys = OFF');
    c.exec("INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, note, cash_entry_id, client_ref, status, segment) VALUES ('shop', '2025-12-30', 0, 1, 1, 'x', 999999, 'orphan', 'posted', NULL)");
    c.exec('PRAGMA foreign_keys = ON');
    expect(all(c, 'PRAGMA foreign_key_check').length).toBe(1);
    const pre = master(c);
    const rows = dump(c, 'sale_items');
    expect(() => migrate(c)).toThrow(/Migration 027_sale_items_discounts.sql failed/);
    expect(versionOf(c)).toBe(26);
    expect(master(c)).toEqual(pre);
    expect(dump(c, 'sale_items')).toEqual(rows);
    expect(cols(c, 'sale_items')).not.toContain('list_unit_price_cents');
    expect(tempLeft(c)).toEqual([]);
    c.close();
  });

  it('027: a row lost in the copy is caught by the guard', () => {
    const dir = patchedDir('027_sale_items_discounts.sql', (s) => s.replace('0, 0, 0, 0 FROM _mig027_rows ORDER BY id;', '0, 0, 0, 0 FROM _mig027_rows WHERE id > 1 ORDER BY id;'));
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    expect(() => migrate(c, dir)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('027: a changed value in the copy is caught by the guard', () => {
    const dir = patchedDir('027_sale_items_discounts.sql', (s) => s.replace('returned_qty, extra_cost_cents, unit_price_cents, 0, 0, 0, 0 FROM _mig027_rows', 'returned_qty, extra_cost_cents + 1, unit_price_cents, 0, 0, 0, 0 FROM _mig027_rows'));
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    expect(() => migrate(c, dir)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('027: a list price that is not the unit price (or a non-zero discount) in the copy is refused', () => {
    const dir = patchedDir('027_sale_items_discounts.sql', (s) => s.replace('extra_cost_cents, unit_price_cents, 0, 0, 0, 0 FROM _mig027_rows', 'extra_cost_cents, unit_price_cents, 0, 0, 0, 1 FROM _mig027_rows'));
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    expect(() => migrate(c, dir)).toThrow(/Migration 027.* failed/);   // refused by the revenue CHECK or by the guard
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('027: a trigger that is not re-created is caught by the set check', () => {
    const dir = patchedDir('027_sale_items_discounts.sql', (s) => s.replace(/CREATE TRIGGER trg_sale_items_no_delete[\s\S]*?\nEND;\n/, ''));
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    expect(() => migrate(c, dir)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('027: the Telecom trigger left out is caught by the set check', () => {
    const dir = patchedDir('027_sale_items_discounts.sql', (s) => s.replace(/CREATE TRIGGER trg_sale_items_telecom_no_discount[\s\S]*?\nEND;\n/, ''));
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    expect(() => migrate(c, dir)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('027: an extra object on the table is caught (the set must be exactly old + new)', () => {
    const dir = patchedDir('027_sale_items_discounts.sql', (s) => s.replace(GUARD_MARK, `CREATE INDEX idx_sale_items_extra ON sale_items(qty);\n${GUARD_MARK}`));
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    expect(() => migrate(c, dir)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('027: a return trigger on another table that disappears (or is re-created with other text) is caught', () => {
    const c0 = openCopy();
    const pre0 = master(c0); const rows0 = dump(c0, 'sale_items');
    const dropped = patchedDir('027_sale_items_discounts.sql', (s) => s.replace(GUARD_MARK, `DROP TRIGGER trg_sales_return_items_exceeds;\n${GUARD_MARK}`));
    expect(() => migrate(c0, dropped)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c0, 'sale_items', 26, pre0, rows0);
    c0.close();
    const c = openCopy();
    const pre = master(c); const rows = dump(c, 'sale_items');
    const changed = patchedDir('027_sale_items_discounts.sql', (s) => s.replace(GUARD_MARK, `DROP TRIGGER trg_sales_return_items_mismatch;
CREATE TRIGGER trg_sales_return_items_mismatch BEFORE INSERT ON sales_return_items WHEN 0 BEGIN SELECT RAISE(ABORT, 'RETURN_ITEM_MISMATCH'); END;
${GUARD_MARK}`));
    expect(() => migrate(c, changed)).toThrow(/Migration 027.* failed: .*ok = 1/);
    expectRolledBack(c, 'sale_items', 26, pre, rows);
    c.close();
  });

  it('028: a row lost in the copy aborts it, leaving schema 27 and the old print_sales table', () => {
    const dir = patchedDir('028_print_sales_discounts.sql', (s) => s.replace('0, 0, 0, 0 FROM _mig028_rows ORDER BY id;', '0, 0, 0, 0 FROM _mig028_rows WHERE id > 1 ORDER BY id;'));
    const c = openCopy();
    migrate(c, MIGRATIONS_DIR_UP_TO_27());
    const pre = master(c); const rows = dump(c, 'print_sales');
    expect(() => migrate(c, dir)).toThrow(/Migration 028.* failed: .*ok = 1/);
    expectRolledBack(c, 'print_sales', 27, pre, rows);
    expect(cols(c, 'sale_items')).toContain('list_unit_price_cents');     // 027 stays applied
    c.close();
  });

  it('028: a changed value in the copy aborts it', () => {
    const dir = patchedDir('028_print_sales_discounts.sql', (s) => s.replace('revenue_cents, cogs_cents, status, voided_at, void_reason, notes, client_ref, unit_price_cents, 0, 0, 0, 0 FROM _mig028_rows', "revenue_cents, cogs_cents, status, voided_at, void_reason, notes || 'x', client_ref, unit_price_cents, 0, 0, 0, 0 FROM _mig028_rows"));
    const c = openCopy();
    migrate(c, MIGRATIONS_DIR_UP_TO_27());
    const pre = master(c); const rows = dump(c, 'print_sales');
    expect(() => migrate(c, dir)).toThrow(/Migration 028.* failed/);
    expectRolledBack(c, 'print_sales', 27, pre, rows);
    c.close();
  });

  it('028: a trigger that is not re-created (a protection of print_sales) is caught by the set check', () => {
    for (const name of ['trg_print_sales_day_closed', 'trg_print_sales_void_requires_reversal', 'trg_print_sales_no_delete']) {
      const dir = patchedDir('028_print_sales_discounts.sql', (s) => s.replace(new RegExp(`CREATE TRIGGER ${name}\\n[\\s\\S]*?\\nEND;\\n`), ''));
      const c = openCopy();
      migrate(c, MIGRATIONS_DIR_UP_TO_27());
      const pre = master(c); const rows = dump(c, 'print_sales');
      expect(() => migrate(c, dir), name).toThrow(/Migration 028.* failed: .*ok = 1/);
      expectRolledBack(c, 'print_sales', 27, pre, rows);
      c.close();
    }
  });

  it('028: a pre-existing broken foreign key (a print sale of a missing service type) aborts it', () => {
    const c = openCopy();
    migrate(c, MIGRATIONS_DIR_UP_TO_27());
    c.exec('PRAGMA foreign_keys = OFF');
    c.exec("INSERT INTO print_sales (business_date, service_type_id, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents, client_ref) VALUES ('2025-09-20', 9999, 'orphan', 1, 100, 50, 100, 50, 'orphan-1')");
    c.exec('PRAGMA foreign_keys = ON');
    expect(all(c, 'PRAGMA foreign_key_check').length).toBe(1);
    const pre = master(c); const rows = dump(c, 'print_sales');
    expect(() => migrate(c)).toThrow(/Migration 028_print_sales_discounts.sql failed/);
    expect(versionOf(c)).toBe(27);
    expect(master(c)).toEqual(pre);
    expect(dump(c, 'print_sales')).toEqual(rows);
    expect(cols(c, 'print_sales')).not.toContain('list_unit_price_cents');
    expect(tempLeft(c)).toEqual([]);
    c.close();
  });

  /** The migration folder limited to 001-027 (a database "at schema 27" is made by applying exactly these). */
  function MIGRATIONS_DIR_UP_TO_27(): string {
    const dir = env.newDir();
    for (const f of loadMigrations().filter((m) => m.version <= 27)) writeFileSync(join(dir, f.name), f.sql);
    return dir;
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the migration files are exactly what the generator writes (committed once, checksummed, never hand-edited)', () => {
  const onDisk = (name: string): string => norm(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  it('027', () => { expect(onDisk('027_sale_items_discounts.sql')).toBe(norm(generate027())); });
  it('028', () => { expect(onDisk('028_print_sales_discounts.sql')).toBe(norm(generate028())); });
  it('the generator is deterministic (two runs, identical text)', () => {
    expect(generate027()).toBe(generate027());
    expect(generate028()).toBe(generate028());
  });
  it('the old trigger and index texts are really the schema-26 texts (compare with the fixture, character by character, except the two extended triggers)', () => {
    const c = openCopy();
    const keep = master(c).filter((m) => m.type !== 'table' && ['sale_items', 'print_sales'].includes(m.tbl_name) && m.sql !== null && !CHANGED_TRIGGERS.includes(m.name));
    expect(keep.length).toBe(SALE_ITEMS_OBJECTS.length + PRINT_SALES_OBJECTS.length - CHANGED_TRIGGERS.length);
    const sql = onDisk('027_sale_items_discounts.sql') + onDisk('028_print_sales_discounts.sql');
    for (const m of keep) expect(sql.includes(norm(m.sql!)), `${m.name} is copied verbatim`).toBe(true);
    c.close();
  });
  it('027 and 028 are the last two migrations, in order', () => {
    expect(loadMigrations().map((m) => m.name).slice(-2)).toEqual(['027_sale_items_discounts.sql', '028_print_sales_discounts.sql']);
  });
});
