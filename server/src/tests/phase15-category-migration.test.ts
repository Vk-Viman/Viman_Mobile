// Migration 015 (category per book): data preservation on a database that already holds a full world.
// (1) A world built through the real HTTP API (buildWorld14: purchases, sales, returns, stock movements, cash books ...) plus custom categories is
// "rewound" to the exact schema-14 shape of `categories` (global UNIQUE name, two 003 triggers, no 015 objects), then the app is started on it so
// migration 015 runs on real data. (2) A pure schema-14 database built from the real migration files 001-014 with raw SQL. (3) A database that
// would lose a product link makes 015 abort and roll back completely.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { get, post, put } from './helpers/catalog.ts';
import { assertGlobalInvariants, buildWorld14, diffSnapshots, rows, snapshotAll } from './helpers/phase14.ts';
import { latestVersion, loadMigrations, migrate } from '../db/migrate.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

/** A real schema-14 database in memory: migrations 001-014 only. */
function schema14(file = ':memory:'): DatabaseSync {
  const dir = env.newDir('viman-mig14-');
  for (const m of loadMigrations().filter((x) => x.version <= 14)) writeFileSync(join(dir, m.name), m.sql);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, dir);
  return db;
}
const all = (db: DatabaseSync, q: string, ...p: any[]) => db.prepare(q).all(...p) as unknown as Array<Record<string, any>>;
const objects = (db: DatabaseSync) =>
  all(db, "SELECT type, name FROM sqlite_master WHERE tbl_name = 'categories' ORDER BY type, name").map((r) => `${r.type}:${r.name}`);

describe('migration 015 on a database that already holds data', () => {
  it('every category and product link, every table row and every figure is unchanged; the trigger/index set is as designed; the app still works', async () => {
    // ---- a full world through the real API (schema 15), plus custom categories
    const dataDir = env.newDir('viman-p15-');
    const b1 = await env.build({ dataDir });
    const s1 = await apiBase(b1);
    await buildWorld14(s1);
    const pens = (await post(s1.app, '/categories', { name: 'Pens', book: 'shop' })).body.item;
    await post(s1.app, '/categories', { name: 'Top-up cards', book: 'telecom' });
    const inactive = (await get(s1.app, '/categories')).body.items.find((c: any) => c.name === 'Party Items');
    await put(s1.app, `/categories/${inactive.id}`, { active: false });
    const np = await post(s1.app, '/products', { name: 'Gel pen', kind: 'stock', sellPriceCents: 5000, minPriceCents: 1000, categoryId: pens.id });
    expect(np.status).toBe(201);
    const apiBefore = {
      categories: (await get(s1.app, '/categories')).body,
      products: (await get(s1.app, '/products?limit=500')).body,
      valuation: (await get(s1.app, '/reports/inventory/valuation')).body,
      cashbooks: (await get(s1.app, '/cashbooks')).body,
    };
    const snapBefore = snapshotAll(s1.ctx);
    const catsBefore = rows(s1.ctx, 'SELECT id, name, book, is_default, active, created_at, updated_at FROM categories ORDER BY id');
    const linksBefore = rows(s1.ctx, 'SELECT id, category_id, book FROM products ORDER BY id');
    expect(catsBefore.length).toBe(14); // 12 seeded + Pens + Top-up cards
    expect(linksBefore.length).toBeGreaterThan(5);
    expect(Number(rows(s1.ctx, 'SELECT COUNT(*) n FROM stock_movements')[0]!.n)).toBeGreaterThan(10);
    expect(Number(rows(s1.ctx, 'SELECT COUNT(*) n FROM sales')[0]!.n)).toBeGreaterThan(3);
    expect(Number(rows(s1.ctx, 'SELECT COUNT(*) n FROM purchases')[0]!.n)).toBeGreaterThan(1);
    await b1.app.close();

    // ---- rewind `categories` to its exact schema-14 form (global UNIQUE name; no 015 index/trigger), schema_migrations back to 14
    const ref14 = schema14();
    const ddl = (type: string, name: string) => String(all(ref14, 'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', type, name)[0]!.sql);
    const objects14 = objects(ref14);
    expect(objects14).toEqual(['index:sqlite_autoindex_categories_1', 'table:categories', 'trigger:trg_categories_book_has_products', 'trigger:trg_categories_default_locked']);
    const file = join(dataDir, 'viman.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('BEGIN');
    raw.exec('PRAGMA defer_foreign_keys = ON');
    raw.exec('CREATE TEMP TABLE c_bak AS SELECT * FROM categories');
    raw.exec('DROP TABLE categories');
    raw.exec(ddl('table', 'categories'));
    raw.exec('INSERT INTO categories SELECT * FROM c_bak ORDER BY id');
    raw.exec(ddl('trigger', 'trg_categories_default_locked'));
    raw.exec(ddl('trigger', 'trg_categories_book_has_products'));
    raw.exec('DROP TABLE c_bak');
    raw.exec('DELETE FROM schema_migrations WHERE version = 15');
    raw.exec('COMMIT');
    expect(objects(raw)).toEqual(objects14);
    expect(all(raw, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => raw.exec("INSERT INTO categories (name, book) VALUES ('PENS', 'shop')")).toThrow(/UNIQUE/); // really the old global rule
    expect(() => raw.exec("INSERT INTO categories (name, book) VALUES ('pens', 'telecom')")).toThrow(/UNIQUE/);
    raw.close();

    // ---- start the app on it: migration 015 runs on real data
    const b2 = await env.build({ dataDir });
    const s2 = await apiBase(b2);
    expect(rows(s2.ctx, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version))).toEqual(Array.from({ length: latestVersion() }, (_, i) => i + 1)); // every migration, 015 included (was a literal 15)

    // every category: id, name, book, is_default, active and both timestamps unchanged; every product link unchanged; counts unchanged
    expect(rows(s2.ctx, 'SELECT id, name, book, is_default, active, created_at, updated_at FROM categories ORDER BY id')).toEqual(catsBefore);
    expect(rows(s2.ctx, 'SELECT id, category_id, book FROM products ORDER BY id')).toEqual(linksBefore);
    expect(diffSnapshots(snapBefore, snapshotAll(s2.ctx))).toEqual(['schema_migrations']); // whole database, table by table, byte for byte; only the re-applied 015 bookkeeping row (new applied_at) differs
    expect(rows(s2.ctx, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(rows(s2.ctx, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(rows(s2.ctx, "SELECT seq FROM sqlite_sequence WHERE name = 'categories'")[0]!.seq).toBe(14);

    // schema as designed: no autoindex, the per-book index, the two old triggers and the delete guard
    expect(objects(s2.ctx.database.conn)).toEqual([
      'index:ux_categories_book_name', 'table:categories',
      'trigger:trg_categories_book_has_products', 'trigger:trg_categories_default_locked', 'trigger:trg_categories_no_delete',
    ]);
    expect(String(rows(s2.ctx, "SELECT sql FROM sqlite_master WHERE name = 'ux_categories_book_name'")[0]!.sql))
      .toBe('CREATE UNIQUE INDEX ux_categories_book_name ON categories(book, name COLLATE NOCASE)');
    expect(rows(s2.ctx, 'PRAGMA index_list(categories)').filter((i) => Number(i.unique) === 1).map((i) => i.name)).toEqual(['ux_categories_book_name']);
    // the products triggers and FK still point at the new table
    expect(rows(s2.ctx, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'products' AND sql LIKE '%categories%' ORDER BY name").map((r) => r.name))
      .toEqual(['trg_products_book_insert', 'trg_products_book_update']);
    expect(rows(s2.ctx, 'PRAGMA foreign_key_list(products)').some((f) => f.table === 'categories' && f.from === 'category_id')).toBe(true);

    // the API gives the same answers as before the migration
    expect({
      categories: (await get(s2.app, '/categories')).body,
      products: (await get(s2.app, '/products?limit=500')).body,
      valuation: (await get(s2.app, '/reports/inventory/valuation')).body,
      cashbooks: (await get(s2.app, '/cashbooks')).body,
    }).toEqual(apiBefore);

    // the new rules are live on the migrated database
    expect((await post(s2.app, '/categories', { name: 'pens', book: 'shop' })).status).toBe(409);
    expect((await post(s2.app, '/categories', { name: 'pens', book: 'telecom' })).status).toBe(201);
    expect(() => s2.ctx.database.conn.prepare('DELETE FROM categories WHERE id = ?').run(pens.id)).toThrow(/CATEGORY_DELETE_FORBIDDEN/);
    expect(() => s2.ctx.database.conn.prepare("UPDATE categories SET book = 'telecom' WHERE id = ?").run(pens.id)).toThrow(/CATEGORY_HAS_PRODUCTS/);
    expect(() => s2.ctx.database.conn.prepare("UPDATE categories SET name = 'X' WHERE name = 'Perfume'").run()).toThrow(/DEFAULT_CATEGORY_LOCKED/);
    const created = await post(s2.app, '/products', { name: 'After migration', kind: 'stock', sellPriceCents: 100, minPriceCents: 50, newCategory: { name: 'Brand new', book: 'telecom' } });
    expect(created.status).toBe(201);
    expect(created.body.item.categoryId).toBe(16); // ids continue after the highest old id (15 = 'pens' in telecom)
    await assertGlobalInvariants(s2);
  });

  it('a pure schema-14 database (real migrations 001-014, raw SQL data) upgrades with every id, name, link and stock figure intact', () => {
    const db = schema14();
    db.exec("INSERT INTO categories (name, book) VALUES ('Mine', 'shop'), ('Other tel', 'telecom')");
    db.exec("UPDATE categories SET active = 0 WHERE name = 'Party Items'");
    const cat = (n: string) => Number(all(db, 'SELECT id FROM categories WHERE name = ?', n)[0]!.id);
    db.exec(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES
      ('A', ${cat('Mine')}, 'stock', 'shop', 1000, 100), ('B', ${cat('Scratch Cards')}, 'stock', 'telecom', 500, 50), ('C', ${cat('Mine')}, 'service', 'shop', 300, 0)`);
    db.exec(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason)
      VALUES (1, '2025-01-05', 'opening', 3, 3000, 1000, 'old'), (2, '2025-01-05', 'opening', 4, 800, 200, 'old')`);
    const catsBefore = all(db, 'SELECT * FROM categories ORDER BY id');
    const prodsBefore = all(db, 'SELECT * FROM products ORDER BY id');
    const seqBefore = all(db, "SELECT seq FROM sqlite_sequence WHERE name = 'categories'")[0]!.seq;
    // 015 and every later migration (016 ... ) are applied on top of the schema-14 database
    expect(migrate(db).applied).toEqual(loadMigrations().filter((m) => m.version >= 15).map((m) => m.name));
    expect(all(db, 'SELECT * FROM categories ORDER BY id')).toEqual(catsBefore);
    expect(all(db, 'SELECT * FROM products ORDER BY id')).toEqual(prodsBefore);
    expect(all(db, "SELECT seq FROM sqlite_sequence WHERE name = 'categories'")[0]!.seq).toBe(seqBefore);
    expect(all(db, 'SELECT product_id, qty_delta FROM stock_movements ORDER BY id').map((r) => [r.product_id, r.qty_delta])).toEqual([[1, 3], [2, 4]]);
    expect(all(db, 'SELECT qty_on_hand, stock_value_cents FROM products ORDER BY id').map((r) => [r.qty_on_hand, r.stock_value_cents])).toEqual([[3, 3000], [4, 800], [0, 0]]);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    db.exec("INSERT INTO categories (name, book) VALUES ('Mine', 'telecom')"); // same name, other book
    expect(() => db.exec("INSERT INTO categories (name, book) VALUES (' x', 'shop'), ('MINE', 'shop')")).toThrow(/UNIQUE/);
    // a product still cannot be created against a category of another book
    expect(() => db.exec(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Bad', ${cat('Mine')}, 'stock', 'telecom', 1, 1)`)).toThrow(/PRODUCT_BOOK_MISMATCH/);
    db.close();
  });

  it('if any product link would be lost the migration aborts, rolls back completely and the database stays at version 14', () => {
    const dir = env.newDir('viman-orphan-');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'o.db');
    const db = schema14(file);
    db.exec("INSERT INTO categories (name, book) VALUES ('Doomed', 'shop')");
    db.exec("INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Orphan', (SELECT id FROM categories WHERE name = 'Doomed'), 'stock', 'shop', 1, 1)");
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("DELETE FROM categories WHERE name = 'Doomed'"); // leaves a product pointing at a missing category (the damage the guard must catch)
    db.exec('PRAGMA foreign_keys = ON');
    expect(all(db, 'PRAGMA foreign_key_check').length).toBe(1);
    const objs = objects(db);
    const cats = all(db, 'SELECT * FROM categories ORDER BY id');
    let err: any;
    try { migrate(db); } catch (e) { err = e; }
    expect(String(err?.message)).toContain('015_category_per_book.sql');
    expect(all(db, 'SELECT MAX(version) v FROM schema_migrations')[0]!.v).toBe(14);
    expect(objects(db)).toEqual(objs);
    expect(all(db, 'SELECT * FROM categories ORDER BY id')).toEqual(cats);
    expect(all(db, "SELECT name FROM sqlite_temp_master WHERE name LIKE '_mig015%'")).toEqual([]);
    db.close();
  });
});
