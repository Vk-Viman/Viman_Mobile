// Product names are unique PER CATEGORY (migration 023), product codes stay globally unique.
// (1) API rules: same name in two categories of one book / of different books accepted; a duplicate in the same category is refused with the
//     same 409 DUPLICATE_NAME shape (create, rename, move; case-insensitive, trimmed); the database UNIQUE abort is mapped to the same error.
// (2) Migration 023 on a populated database: a full world built through the API is rewound to the exact schema-22 `products` table (global
//     UNIQUE name), then the app starts on it so 023 runs on real data. Every row of every table is unchanged, ids and sequences are kept, all
//     indexes and triggers of products are back, and the shop still sells / returns / moves stock afterwards.
// (3) Excel opening-stock import: matching is by SKU only; a row without SKU whose name exists in several categories is refused with a clear message.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import { get, post, put } from './helpers/catalog.ts';
import { providerIdByName } from './helpers/segments.ts';
import { assertGlobalInvariants, buildWorld14, diffSnapshots, rows, snapshotAll } from './helpers/phase14.ts';
import { rl, returnOk, sellOne } from './helpers/phase5.ts';
import { importFile, mkSku, previewFile, xlsx } from './helpers/phase13.ts';
import { latestVersion, loadMigrations, migrate } from '../db/migrate.ts';
import { lossNew } from './helpers/phase4.ts';

// Lets one test make the service's friendly duplicate check blind, so only the database UNIQUE constraint can stop the write.
const blind = vi.hoisted(() => ({ on: false }));
vi.mock('../repositories/products.repo.ts', async (orig) => {
  const real = await orig<typeof import('../repositories/products.repo.ts')>();
  return { ...real, findProductByName: (...a: Parameters<typeof real.findProductByName>) => (blind.on ? undefined : real.findProductByName(...a)) };
});

const env = new TestEnv();
afterEach(async () => { blind.on = false; await env.cleanup(); });

const NAME_MSG = 'Another product already uses this name.';
const prod = (cat: number | undefined, name: string, over: Record<string, unknown> = {}) =>
  ({ name, categoryId: cat, kind: 'stock', sellPriceCents: 1000, minPriceCents: 500, ...over });
async function newCat(s: { app: any }, name: string, book: 'shop' | 'telecom', provider?: 'Dialog' | 'Airtel'): Promise<number> {
  // 13D: a Telecom category that will hold card products is linked to a provider (the product trigger of migration 024 needs it)
  const providerId = provider ? (await providerIdByName(s.app))[provider] : undefined;
  const r = await post(s.app, '/categories', { name, book, ...(providerId !== undefined ? { providerId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.item.id;
}

describe('product name unique per category - API', () => {
  it('the same name is accepted in two categories of one book and in categories of different books', async () => {
    const s = await apiBase(await env.build());
    const dialog = await newCat(s, 'Dialog Crds', 'telecom', 'Dialog');
    const airtel = await newCat(s, 'Airtel Crds', 'telecom', 'Airtel');
    const a = await post(s.app, '/products', prod(dialog, '100/-'));
    const b = await post(s.app, '/products', prod(airtel, '100/-'));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.item.id).not.toBe(b.body.item.id);
    // same book (shop), two categories; and a shop vs a telecom category
    expect((await post(s.app, '/products', prod(s.ids.Electronics, 'Cable'))).status).toBe(201);
    expect((await post(s.app, '/products', prod(s.ids.Other, 'cable'))).status).toBe(201);
    // the default Scratch Cards category needs a provider before it can hold a new card product (13D; allowed while it has no products)
    expect((await put(s.app, `/categories/${s.ids['Scratch Cards']}`, { providerId: (await providerIdByName(s.app)).Dialog })).status).toBe(200);
    expect((await post(s.app, '/products', prod(s.ids['Scratch Cards'], ' CABLE '))).status).toBe(201);
    expect((await get(s.app, '/products?q=cable&limit=50')).body.items).toHaveLength(3);
  });

  it('a duplicate inside the SAME category is refused as before: create (case-insensitive, trimmed) and rename', async () => {
    const s = await apiBase(await env.build());
    await post(s.app, '/products', prod(s.ids.Electronics, 'Cable', { code: 'C-1' }));
    for (const name of ['cable', 'CABLE', '  Cable ']) {
      const r = await post(s.app, '/products', prod(s.ids.Electronics, name, { code: `x-${name.length}` }));
      expect(r.status, name).toBe(409);
      expect(r.body.error.code).toBe('DUPLICATE_NAME');
      expect(r.body.error.fields.name).toBe(NAME_MSG);
      expect(r.body.error.message).toBe(NAME_MSG);
    }
    const other = (await post(s.app, '/products', prod(s.ids.Electronics, 'Plug'))).body.item;
    const r = await put(s.app, `/products/${other.id}`, { name: ' cAbLe ' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DUPLICATE_NAME', fields: { name: NAME_MSG } });
    // renaming to a name that only exists in ANOTHER category is fine
    const elsewhere = (await post(s.app, '/products', prod(s.ids.Other, 'Charger'))).body.item;
    expect((await put(s.app, `/products/${elsewhere.id}`, { name: 'Cable' })).status).toBe(200);
    // the product keeps its own name (case-only rename of itself)
    expect((await put(s.app, `/products/${other.id}`, { name: 'PLUG' })).status).toBe(200);
  });

  it('moving a product to a category that already has its name is refused; to one that does not, accepted (also with a rename)', async () => {
    const s = await apiBase(await env.build());
    const a = (await post(s.app, '/products', prod(s.ids.Electronics, 'Cable'))).body.item;
    await post(s.app, '/products', prod(s.ids.Other, 'cable'));
    const free = await newCat(s, 'Wires', 'shop');
    let r = await put(s.app, `/products/${a.id}`, { categoryId: s.ids.Other });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DUPLICATE_NAME', fields: { name: NAME_MSG } });
    expect((await get(s.app, `/products/${a.id}`)).body.item.categoryId).toBe(s.ids.Electronics); // unchanged
    // move + rename together: the NEW name in the TARGET category is what is checked
    r = await put(s.app, `/products/${a.id}`, { categoryId: s.ids.Other, name: 'Cable2' });
    expect(r.status).toBe(200);
    r = await put(s.app, `/products/${a.id}`, { categoryId: s.ids.Electronics, name: 'cable' }); // back; 'cable' does not exist in Electronics now
    expect(r.status).toBe(200);
    r = await put(s.app, `/products/${a.id}`, { categoryId: free });
    expect(r.status).toBe(200);
    expect(r.body.item.categoryId).toBe(free);
  });

  it('product CODE uniqueness is still global (across categories and books)', async () => {
    const s = await apiBase(await env.build());
    await post(s.app, '/products', prod(s.ids.Electronics, 'A', { code: 'Same' }));
    // 13D: the default Scratch Cards category needs a provider before it can hold a stock product
    await put(s.app, `/categories/${s.ids['Scratch Cards']}`, { providerId: (await providerIdByName(s.app)).Dialog });
    for (const cat of [s.ids.Electronics, s.ids.Other, s.ids['Scratch Cards']]) {
      const r = await post(s.app, '/products', prod(cat, `B${cat}`, { code: 'SAME' }));
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: 'DUPLICATE_CODE', fields: { code: 'Another product already uses this code.' } });
    }
    const b = (await post(s.app, '/products', prod(s.ids.Other, 'B'))).body.item;
    expect((await put(s.app, `/products/${b.id}`, { code: 'same' })).body.error.code).toBe('DUPLICATE_CODE');
  });

  it('the database UNIQUE(category_id, name) is the final guard and is mapped to the same 409 DUPLICATE_NAME (create and update)', async () => {
    const s = await apiBase(await env.build());
    await post(s.app, '/products', prod(s.ids.Electronics, 'Cable'));
    const p = (await post(s.app, '/products', prod(s.ids.Other, 'Cable'))).body.item;
    blind.on = true; // the friendly pre-check sees nothing; only the constraint is left
    const before = rows(s.ctx, 'SELECT COUNT(*) n FROM products')[0]!.n;
    let r = await post(s.app, '/products', prod(s.ids.Electronics, 'CABLE'));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DUPLICATE_NAME', fields: { name: NAME_MSG } });
    r = await put(s.app, `/products/${p.id}`, { categoryId: s.ids.Electronics });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DUPLICATE_NAME', fields: { name: NAME_MSG } });
    expect(rows(s.ctx, 'SELECT COUNT(*) n FROM products')[0]!.n).toBe(before);
    expect(() => s.ctx.database.conn.prepare("INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('cable', ?, 'stock', 'shop', 1, 1)").run(s.ids.Electronics!))
      .toThrow(/UNIQUE constraint failed: products\.category_id, products\.name/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('migration 023 on a populated database', () => {
  const all = (db: DatabaseSync, q: string, ...p: any[]) => db.prepare(q).all(...p) as unknown as Array<Record<string, any>>;
  /** A real schema-22 database in memory: migrations 001-022 only. */
  function schema22(): DatabaseSync {
    const dir = env.newDir('viman-mig22-');
    for (const m of loadMigrations().filter((x) => x.version <= 22)) writeFileSync(join(dir, m.name), m.sql);
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, dir);
    return db;
  }
  const productObjects = (db: DatabaseSync) =>
    all(db, "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'products' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name");
  const otherObjects = (db: DatabaseSync) =>
    all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'products' ORDER BY type, name");

  it('every row of every table is byte-identical; ids, sequences, indexes and triggers are preserved; the shop keeps working', async () => {
    // ---- a full world through the real API (schema 23)
    const dataDir = env.newDir('viman-p25-');
    const b1 = await env.build({ dataDir });
    const s1 = await apiBase(b1);
    await buildWorld14(s1);
    const pens = (await post(s1.app, '/categories', { name: 'Pens', book: 'shop' })).body.item;
    await post(s1.app, '/products', prod(pens.id, 'Gel pen', { code: 'GP-1' }));
    const inactive = (await post(s1.app, '/products', prod(pens.id, 'Old pen'))).body.item;
    await put(s1.app, `/products/${inactive.id}`, { active: false });
    expect(Number(rows(s1.ctx, 'SELECT COUNT(*) n FROM sale_items')[0]!.n)).toBeGreaterThan(3);
    expect(Number(rows(s1.ctx, 'SELECT COUNT(*) n FROM purchase_items')[0]!.n)).toBeGreaterThan(1);
    expect(Number(rows(s1.ctx, 'SELECT COUNT(*) n FROM stock_movements')[0]!.n)).toBeGreaterThan(10);
    const apiBefore = {
      products: (await get(s1.app, '/products?limit=500')).body,
      valuation: (await get(s1.app, '/reports/inventory/valuation')).body,
    };
    const snapBefore = snapshotAll(s1.ctx);
    const prodSeq = rows(s1.ctx, "SELECT seq FROM sqlite_sequence WHERE name = 'products'")[0]!.seq;
    const seqBefore = JSON.stringify(rows(s1.ctx, 'SELECT name, seq FROM sqlite_sequence ORDER BY name'));
    const ref22 = schema22();
    const oldObjs = productObjects(ref22); // 003/004 indexes + triggers exactly as they were (schema 22)
    expect(oldObjs.map((o) => o.name)).toEqual([
      'idx_products_active_name', 'idx_products_category', 'trg_products_book_insert', 'trg_products_book_update', 'trg_products_kind_immutable', 'trg_products_value_without_qty',
    ]);
    // the migrated schema carries the same objects, plus the two triggers of migration 024 (Telecom segments: provider needed on a new card product, segment locked)
    const byTypeName = (a: any, b: any) => (a.type + a.name < b.type + b.name ? -1 : 1);
    const segObjs = productObjects(b1.ctx.database.conn).filter((o) => !oldObjs.some((x) => x.name === o.name));
    expect(segObjs.map((o) => o.name)).toEqual(['trg_products_needs_provider', 'trg_products_segment_locked']);
    expect(productObjects(b1.ctx.database.conn)).toEqual([...oldObjs, ...segObjs].sort(byTypeName));
    const newObjs = otherObjects(b1.ctx.database.conn);
    await b1.app.close();

    // ---- rewind `products` to its exact schema-22 form (global UNIQUE name) and schema_migrations back to 22
    const file = join(dataDir, 'viman.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    const tableSql = String(all(ref22, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'")[0]!.sql);
    const guardSql = String(all(ref22, "SELECT sql FROM sqlite_master WHERE name = 'trg_schema_migrations_no_delete'")[0]!.sql);
    raw.exec('BEGIN');
    raw.exec('PRAGMA defer_foreign_keys = ON');
    raw.exec('CREATE TEMP TABLE p_bak AS SELECT * FROM products');
    raw.exec('DROP TABLE products');
    raw.exec(tableSql);
    raw.exec('INSERT INTO products SELECT * FROM p_bak ORDER BY id');
    raw.exec(`UPDATE sqlite_sequence SET seq = ${Number(prodSeq)} WHERE name = 'products'`);
    for (const o of oldObjs) raw.exec(String(o.sql));
    raw.exec('DROP TABLE p_bak');
    raw.exec('DROP TRIGGER trg_schema_migrations_no_delete'); // migration 020 guards the history; the test rebuilds a version-22 database
    raw.exec('DELETE FROM schema_migrations WHERE version = 23');
    raw.exec(guardSql);
    raw.exec('COMMIT');
    expect(all(raw, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(raw, "SELECT sql FROM sqlite_master WHERE name = 'products'")[0]!.sql).toBe(tableSql);
    const dupOld = "INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('GEL PEN', ?, 'stock', 'shop', 1, 1)";
    expect(() => raw.prepare(dupOld).run(s1.ids.Electronics!)).toThrow(/UNIQUE constraint failed: products\.name/); // really the old global rule
    raw.close();

    // ---- start the app on it: migration 023 runs on real data
    const b2 = await env.build({ dataDir });
    const s2 = await apiBase(b2);
    expect(rows(s2.ctx, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version)))
      .toEqual(Array.from({ length: latestVersion() }, (_, i) => i + 1));
    expect(diffSnapshots(snapBefore, snapshotAll(s2.ctx))).toEqual(['schema_migrations']); // every table, byte for byte (only the re-applied 023 row differs)
    expect(rows(s2.ctx, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(rows(s2.ctx, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(JSON.stringify(rows(s2.ctx, 'SELECT name, seq FROM sqlite_sequence ORDER BY name'))).toBe(seqBefore);
    // every products index and trigger of schema 22 is back, unchanged. (The re-applied 023 drops and re-creates `products` with its own objects only; the two
    // triggers of migration 024 belong to a LATER version that this rewind kept, so the test puts them back exactly as they were before the rewind.)
    expect(productObjects(s2.ctx.database.conn)).toEqual(oldObjs);
    for (const o of segObjs) s2.ctx.database.conn.exec(String(o.sql));
    expect(productObjects(s2.ctx.database.conn)).toEqual([...oldObjs, ...segObjs].sort(byTypeName));
    expect(otherObjects(s2.ctx.database.conn)).toEqual(newObjs); // nothing else in the schema moved
    const tbl = String(rows(s2.ctx, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'")[0]!.sql);
    expect(tbl).toMatch(/UNIQUE \(category_id, name\)/);
    expect(tbl).toMatch(/name\s+TEXT\s+NOT NULL COLLATE NOCASE,/);
    expect(rows(s2.ctx, 'PRAGMA foreign_key_list(products)').some((f) => f.table === 'categories' && f.from === 'category_id')).toBe(true);
    expect({
      products: (await get(s2.app, '/products?limit=500')).body,
      valuation: (await get(s2.app, '/reports/inventory/valuation')).body,
    }).toEqual(apiBefore);

    // ---- the new rule is live on the migrated data: same name in another category is fine, in the same category it is not
    const pens2 = (await post(s2.app, '/categories', { name: 'Brushes', book: 'shop' })).body.item;
    const x = await post(s2.app, '/products', prod(pens2.id, 'gel pen', { code: 'GP-2' }));
    expect(x.status).toBe(201);
    expect(x.body.item.id).toBeGreaterThan(Number(prodSeq)); // ids continue, never reused
    expect((await post(s2.app, '/products', prod(pens.id, 'GEL PEN'))).status).toBe(409);
    expect((await post(s2.app, '/products', prod(s2.ids.Electronics, 'Gel pen', { code: 'gp-1' }))).body.error.code).toBe('DUPLICATE_CODE');

    // ---- a product (old or new, same name twice) can still be bought, sold, returned and stock-moved
    const twinA = await mkProduct(s2, { name: 'Twin', categoryId: s2.ids.Electronics });
    const twinB = await mkProduct(s2, { name: 'Twin', categoryId: s2.ids.Other });
    for (const t of [twinA, twinB]) await buy(s2, [{ productId: t.id, packs: 1, packSize: 10, lineTotalCents: 5000 }]);
    const sale = await sellOne(s2, twinB.id, 3, 1000);
    await returnOk(s2, sale.id, [rl(sale.items[0].id, 1, true)]);
    const st = await lossNew(s2, twinA.id, 1);
    expect([200, 201]).toContain(st.status);
    expect(rows(s2.ctx, 'SELECT qty_on_hand FROM products WHERE id = ?', twinB.id)[0]!.qty_on_hand).toBe(8);
    // the triggers still fire
    const c = s2.ctx.database.conn;
    expect(() => c.prepare("UPDATE products SET book = 'telecom' WHERE id = ?").run(twinA.id)).toThrow(/PRODUCT_BOOK_MISMATCH|PRODUCT_KIND_IMMUTABLE/);
    expect(() => c.prepare("UPDATE products SET category_id = ? WHERE id = ?").run(s2.ids["Scratch Cards"]!, twinA.id)).toThrow(/PRODUCT_BOOK_MISMATCH/);
    expect(() => c.prepare("UPDATE products SET qty_on_hand = 0, stock_value_cents = 5 WHERE id = ?").run(twinA.id)).toThrow(/STOCK_VALUE_WITHOUT_QTY/);
    expect(() => c.prepare("UPDATE products SET kind = 'service' WHERE id = ?").run(twinA.id)).toThrow(/PRODUCT_KIND_IMMUTABLE/);
    expect(() => c.prepare("INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Bad', ?, 'stock', 'telecom', 1, 1)").run(s2.ids.Electronics!)).toThrow(/PRODUCT_BOOK_MISMATCH/);
    await assertGlobalInvariants(s2);
  });

  it('a pure schema-22 database (real migrations 001-022, raw SQL data, same names in other categories impossible before) upgrades intact', () => {
    const db = schema22();
    db.exec("INSERT INTO categories (name, book) VALUES ('Mine', 'shop'), ('Other tel', 'telecom')");
    const cat = (n: string) => Number(all(db, 'SELECT id FROM categories WHERE name = ?', n)[0]!.id);
    db.exec(`INSERT INTO products (name, code, category_id, kind, book, sell_price_cents, min_price_cents) VALUES
      ('A', 'a1', ${cat('Mine')}, 'stock', 'shop', 1000, 100), ('B', NULL, ${cat('Scratch Cards')}, 'stock', 'telecom', 500, 50), ('C', NULL, ${cat('Mine')}, 'service', 'shop', 300, 0)`);
    db.exec(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason)
      VALUES (1, '2025-01-05', 'opening', 3, 3000, 1000, 'old'), (2, '2025-01-05', 'opening', 4, 800, 200, 'old')`);
    const prodsBefore = all(db, 'SELECT * FROM products ORDER BY id');
    const movesBefore = all(db, 'SELECT * FROM stock_movements ORDER BY id');
    expect(() => db.exec(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('a', ${cat('Other tel')}, 'stock', 'telecom', 1, 1)`)).toThrow(/UNIQUE/);
    expect(migrate(db).applied).toEqual(loadMigrations().filter((m) => m.version >= 23).map((m) => m.name));
    expect(all(db, 'SELECT * FROM products ORDER BY id')).toEqual(prodsBefore);
    expect(all(db, 'SELECT * FROM stock_movements ORDER BY id')).toEqual(movesBefore);
    expect(all(db, "SELECT seq FROM sqlite_sequence WHERE name = 'products'")[0]!.seq).toBe(3);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    // migration 024 (Telecom segments): a NEW Telecom stock product needs a category with a provider (it has no products yet, so it may get one)
    db.exec(`UPDATE categories SET provider_id = (SELECT id FROM reload_providers WHERE name = 'Dialog') WHERE id = ${cat('Other tel')}`);
    db.exec(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('a', ${cat('Other tel')}, 'stock', 'telecom', 1, 1)`); // now allowed
    expect(Number(all(db, "SELECT id FROM products WHERE name = 'a' ORDER BY id DESC")[0]!.id)).toBe(4);
    expect(() => db.exec(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('A', ${cat('Mine')}, 'stock', 'shop', 1, 1)`)).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO products (name, code, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Z', 'A1', ${cat('Mine')}, 'stock', 'shop', 1, 1)`)).toThrow(/UNIQUE.*products\.code/);
    db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Excel opening-stock import with a name that exists in several categories', () => {
  it('rows are matched by SKU only; a row without SKU and an ambiguous name is refused with a clear message, never guessed', async () => {
    const s = await apiBase(await env.build());
    const a = await mkSku(s, 'CBL-E', { name: 'Cable', categoryId: s.ids.Electronics });
    const b = await mkSku(s, 'CBL-O', { name: 'Cable', categoryId: s.ids.Other });
    await mkProduct(s, { name: 'Solo', categoryId: s.ids.Electronics });
    const file = await xlsx([
      ['CBL-E', 'Cable', 2, 10],     // row 2: by SKU -> the Electronics product
      ['cbl-o', 'Cable', 3, 10],     // row 3: by SKU -> the Other product
      [null, 'Cable', 1, 10],        // row 4: name only, ambiguous -> refused with a clear message
      [null, 'Solo', 1, 10],         // row 5: name only, unique -> still needs the SKU (a name is never used to match)
    ]);
    const r = await previewFile(s, file);
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: any) => [x.rowNo, x.productId, x.categoryName, x.status])).toEqual([
      [2, a.id, 'Electronics', 'ok'], [3, b.id, 'Other', 'ok'], [4, null, null, 'error'], [5, null, null, 'error'],
    ]);
    expect(r.body.rows[2].issues).toHaveLength(1);
    expect(r.body.rows[2].issues[0].code).toBe('MISSING_SKU');
    expect(r.body.rows[2].issues[0].message).toMatch(/Several products are named "Cable" \(categories: .*Electronics.*Other.*\)\. Enter the SKU/);
    expect(r.body.rows[3].issues[0]).toEqual({ code: 'MISSING_SKU', message: 'Enter the product SKU.' });
    // the import is all-or-nothing: nothing is written while a row is refused ...
    const bad = await importFile(s, file);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(rows(s.ctx, 'SELECT COUNT(*) n FROM stock_movements')[0]!.n).toBe(0);
    // ... and the SKU-only rows import cleanly into the right products
    const good = await importFile(s, await xlsx([['CBL-E', 'Cable', 2, 10], ['cbl-o', 'Cable', 3, 10]]));
    expect(good.status).toBe(201);
    expect(rows(s.ctx, 'SELECT id, qty_on_hand FROM products WHERE id IN (?, ?) ORDER BY id', a.id, b.id).map((x) => x.qty_on_hand)).toEqual([2, 3]);
  });
});
