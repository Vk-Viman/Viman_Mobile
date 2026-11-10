import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { buildMultipart } from './helpers/multipart.ts';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

function mem(): DatabaseSync {
  const c = new DatabaseSync(':memory:');
  c.exec('PRAGMA foreign_keys = ON');
  conns.push(c);
  migrate(c);
  return c;
}

const DEFAULTS = [
  'Phone Accessories', 'Tempered Glass', 'Phone Covers', 'Electronics', 'Stationery',
  'Snacks and Drinks', 'Party Items', 'Perfume', 'Pooja Items', 'SIM', 'Other',
];

const catId = (c: DatabaseSync, name: string): number =>
  Number((c.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number | bigint }).id);

function addCat(c: DatabaseSync, name: string, book = 'shop'): number {
  return Number(c.prepare('INSERT INTO categories (name, book) VALUES (?, ?)').run(name, book).lastInsertRowid);
}

interface P { code?: string | null; name?: string; cat?: number; kind?: string; book?: string; sell?: number; min?: number; reorder?: number; qty?: number; value?: number }
let seq = 0;
function addProd(c: DatabaseSync, p: P = {}): number {
  const cat = p.cat ?? catId(c, 'Other');
  const book = p.book ?? (c.prepare('SELECT book FROM categories WHERE id = ?').get(cat) as { book: string }).book;
  return Number(c.prepare(
    `INSERT INTO products (code, name, category_id, kind, book, sell_price_cents, min_price_cents, reorder_level, qty_on_hand, stock_value_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.code ?? null, p.name ?? `P${seq++}`, cat, p.kind ?? 'stock', book, p.sell ?? 100, p.min ?? 50,
    p.reorder ?? 0, p.qty ?? 0, p.value ?? 0).lastInsertRowid);
}

const msg = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected throw');
};

function v2Db(dir: string, path: string): DatabaseSync {
  const v2dir = join(dir, 'mig');
  mkdirSync(v2dir, { recursive: true });
  for (const f of loadMigrations().filter((m) => m.version <= 2)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(v2dir, f.name));
  const c = new DatabaseSync(path);
  c.exec('PRAGMA foreign_keys = ON');
  c.exec('PRAGMA journal_mode = DELETE');
  expect(migrate(c, v2dir).version).toBe(2);
  return c;
}

describe('migration 003', () => {
  it('fresh DB reaches latestVersion with the catalog tables, triggers and indexes', () => {
    const c = mem();
    expect(latestVersion()).toBeGreaterThanOrEqual(3);
    expect(currentVersion(c)).toBe(latestVersion());
    const names = (type: string) =>
      (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(['categories', 'products', 'suppliers']));
    expect(names('trigger')).toEqual(expect.arrayContaining([
      'trg_categories_default_locked', 'trg_categories_book_has_products', 'trg_products_book_insert',
      'trg_products_book_update', 'trg_products_kind_immutable',
    ]));
    expect(names('index')).toEqual(expect.arrayContaining(['idx_products_category', 'idx_products_active_name']));
  });

  it('seeds 12 default categories (11 shop + Scratch Cards telecom), all is_default=1, active', () => {
    const c = mem();
    const rows = c.prepare('SELECT name, book, is_default, active FROM categories ORDER BY id').all() as
      { name: string; book: string; is_default: number; active: number }[];
    expect(rows).toHaveLength(12);
    expect(rows.slice(0, 11).map((r) => r.name)).toEqual(DEFAULTS);
    expect(rows.slice(0, 11).every((r) => r.book === 'shop')).toBe(true);
    expect(rows[11]).toMatchObject({ name: 'Scratch Cards', book: 'telecom' });
    expect(rows.every((r) => r.is_default === 1 && r.active === 1)).toBe(true);
    expect((c.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n).toBe(0);
  });

  it('upgrades a v2-only database to v3 keeping existing data', () => {
    const dir = env.newDir();
    const c = v2Db(dir, join(dir, 'v2.db'));
    conns.push(c);
    expect(c.prepare("SELECT name FROM sqlite_master WHERE name = 'categories'").get()).toBeUndefined();
    c.prepare("INSERT INTO settings (key, value_json) VALUES ('rates', '1')").run();
    const r = migrate(c);
    expect(r.applied).toEqual(loadMigrations().filter((m) => m.version >= 3).map((m) => m.name));
    expect(r.applied[0]).toBe('003_catalog.sql');
    expect(currentVersion(c)).toBe(latestVersion());
    expect((c.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n).toBe(12);
    expect(c.prepare("SELECT value_json FROM settings WHERE key = 'rates'").get()).toMatchObject({ value_json: '1' });
    expect(migrate(c).applied).toEqual([]);
  });
});

describe('categories constraints', () => {
  it('names are unique case-insensitively; blank names rejected; book enum enforced', () => {
    const c = mem();
    expect(msg(() => addCat(c, 'electronics'))).toMatch(/UNIQUE/);
    expect(msg(() => addCat(c, 'ELECTRONICS', 'telecom'))).toMatch(/UNIQUE/);
    expect(msg(() => addCat(c, ''))).toMatch(/CHECK/);
    expect(msg(() => addCat(c, '   '))).toMatch(/CHECK/);
    expect(msg(() => addCat(c, 'X', 'icecream'))).toMatch(/CHECK/);
    expect(msg(() => c.prepare("INSERT INTO categories (name, book, active) VALUES ('Z','shop',2)").run())).toMatch(/CHECK/);
    expect(addCat(c, 'Mine')).toBeGreaterThan(12);
    expect(msg(() => c.prepare("UPDATE categories SET name = '  ' WHERE name = 'Mine'").run())).toMatch(/CHECK/);
  });

  it('default categories: name (incl. case-only) and book locked; active changeable; same-value update ok', () => {
    const c = mem();
    expect(msg(() => c.prepare("UPDATE categories SET name = 'Elec' WHERE name = 'Electronics'").run())).toMatch(/DEFAULT_CATEGORY_LOCKED/);
    expect(msg(() => c.prepare("UPDATE categories SET name = 'ELECTRONICS' WHERE name = 'Electronics'").run())).toMatch(/DEFAULT_CATEGORY_LOCKED/);
    expect(msg(() => c.prepare("UPDATE categories SET book = 'telecom' WHERE name = 'Electronics'").run())).toMatch(/DEFAULT_CATEGORY_LOCKED/);
    expect(msg(() => c.prepare("UPDATE categories SET book = 'shop' WHERE name = 'Scratch Cards'").run())).toMatch(/DEFAULT_CATEGORY_LOCKED/);
    c.prepare("UPDATE categories SET name = 'Electronics', book = 'shop' WHERE name = 'Electronics'").run();
    c.prepare("UPDATE categories SET active = 0 WHERE name = 'Electronics'").run();
    expect((c.prepare("SELECT active FROM categories WHERE name = 'Electronics'").get() as { active: number }).active).toBe(0);
    c.prepare("UPDATE categories SET active = 1 WHERE name = 'Electronics'").run();
  });

  it('owner category: rename ok; book change ok only without products (CATEGORY_HAS_PRODUCTS)', () => {
    const c = mem();
    const id = addCat(c, 'Mine');
    c.prepare("UPDATE categories SET name = 'Mine2' WHERE id = ?").run(id);
    c.prepare("UPDATE categories SET book = 'telecom' WHERE id = ?").run(id);
    c.prepare("UPDATE categories SET book = 'shop' WHERE id = ?").run(id);
    addProd(c, { cat: id, name: 'In Mine' });
    expect(msg(() => c.prepare("UPDATE categories SET book = 'telecom' WHERE id = ?").run(id))).toMatch(/CATEGORY_HAS_PRODUCTS/);
    c.prepare("UPDATE categories SET book = 'shop', name = 'Mine3' WHERE id = ?").run(id); // unchanged book is fine
    c.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(id);
  });

  it('FK restrict: a category with products cannot be deleted; an empty owner category can', () => {
    const c = mem();
    const id = addCat(c, 'Mine');
    addProd(c, { cat: id, name: 'In Mine' });
    expect(msg(() => c.prepare('DELETE FROM categories WHERE id = ?').run(id))).toMatch(/FOREIGN KEY/);
    const empty = addCat(c, 'Empty');
    c.prepare('DELETE FROM categories WHERE id = ?').run(empty);
  });
});

describe('products constraints', () => {
  it('names and codes unique case-insensitively; multiple NULL codes allowed', () => {
    const c = mem();
    addProd(c, { name: 'Cable', code: 'AbC' });
    expect(msg(() => addProd(c, { name: 'CABLE' }))).toMatch(/UNIQUE.*products\.name/);
    expect(msg(() => addProd(c, { name: 'Other', code: 'abc' }))).toMatch(/UNIQUE.*products\.code/);
    addProd(c, { name: 'N1' });
    addProd(c, { name: 'N2' });
  });

  it('blank name and empty-string code rejected', () => {
    const c = mem();
    expect(msg(() => addProd(c, { name: '' }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: '   ' }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 'A', code: '' }))).toMatch(/CHECK/);
  });

  it('price/reorder/qty/value CHECKs', () => {
    const c = mem();
    expect(msg(() => addProd(c, { name: 'a', sell: 100, min: 101 }))).toMatch(/CHECK/);
    addProd(c, { name: 'a2', sell: 100, min: 100 });
    expect(msg(() => addProd(c, { name: 'b', sell: -1, min: -1 }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 'c', sell: 10, min: -1 }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 'd', reorder: -1 }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 'e', qty: -1 }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 'f', value: -1 }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 'g', kind: 'weird' }))).toMatch(/CHECK/);
    const id = addProd(c, { name: 'h', qty: 3, value: 900 });
    expect(msg(() => c.prepare('UPDATE products SET qty_on_hand = -1 WHERE id = ?').run(id))).toMatch(/CHECK/);
    expect(msg(() => c.prepare('UPDATE products SET min_price_cents = 101 WHERE id = ?').run(id))).toMatch(/CHECK/);
    expect(msg(() => c.prepare('UPDATE products SET sell_price_cents = 10 WHERE id = ?').run(id))).toMatch(/CHECK/);
  });

  it('services cannot hold qty or value, even via update', () => {
    const c = mem();
    expect(msg(() => addProd(c, { name: 's1', kind: 'service', qty: 1 }))).toMatch(/CHECK/);
    expect(msg(() => addProd(c, { name: 's2', kind: 'service', value: 1 }))).toMatch(/CHECK/);
    const id = addProd(c, { name: 's3', kind: 'service' });
    expect(msg(() => c.prepare('UPDATE products SET qty_on_hand = 1 WHERE id = ?').run(id))).toMatch(/CHECK/);
    expect(msg(() => c.prepare('UPDATE products SET stock_value_cents = 1 WHERE id = ?').run(id))).toMatch(/CHECK/);
  });

  it('PRODUCT_BOOK_MISMATCH on insert and on category move; kind/book immutable', () => {
    const c = mem();
    expect(msg(() => addProd(c, { name: 'x', cat: catId(c, 'Scratch Cards'), book: 'shop' }))).toMatch(/PRODUCT_BOOK_MISMATCH/);
    expect(msg(() => addProd(c, { name: 'x', cat: catId(c, 'Other'), book: 'telecom' }))).toMatch(/PRODUCT_BOOK_MISMATCH/);
    const id = addProd(c, { name: 'x' });
    expect(msg(() => c.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(catId(c, 'Scratch Cards'), id)))
      .toMatch(/PRODUCT_BOOK_MISMATCH/);
    const other = addCat(c, 'Mine');
    c.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(other, id); // same book fine
    expect(msg(() => c.prepare("UPDATE products SET kind = 'service' WHERE id = ?").run(id))).toMatch(/PRODUCT_KIND_IMMUTABLE/);
    expect(msg(() => c.prepare("UPDATE products SET book = 'telecom' WHERE id = ?").run(id))).toMatch(/PRODUCT_/);
    expect(msg(() => c.prepare("UPDATE products SET book = 'telecom', category_id = ? WHERE id = ?")
      .run(catId(c, 'Scratch Cards'), id))).toMatch(/PRODUCT_KIND_IMMUTABLE/);
  });

  it('unknown category id is rejected', () => {
    const c = mem();
    expect(msg(() => addProd(c, { name: 'x', cat: 9999, book: 'shop' }))).toMatch(/PRODUCT_BOOK_MISMATCH|FOREIGN KEY/);
  });
});

describe('suppliers constraints', () => {
  it('unique case-insensitive name, blank rejected, defaults', () => {
    const c = mem();
    c.prepare("INSERT INTO suppliers (name) VALUES ('Acme')").run();
    expect(msg(() => c.prepare("INSERT INTO suppliers (name) VALUES ('ACME')").run())).toMatch(/UNIQUE/);
    expect(msg(() => c.prepare("INSERT INTO suppliers (name) VALUES ('  ')").run())).toMatch(/CHECK/);
    expect(c.prepare("SELECT phone, notes, active FROM suppliers WHERE name = 'Acme'").get())
      .toMatchObject({ phone: '', notes: '', active: 1 });
  });
});

describe('restore of a v2 backup', () => {
  it('uploaded v2 database restores, migrates to latest, catalog works', async () => {
    const dir = env.newDir();
    const v2 = join(dir, 'v2.db');
    const d = v2Db(dir, v2);
    try {
      d.prepare("INSERT INTO settings (key, value_json) VALUES ('rates', ?)")
        .run(JSON.stringify({ reloadCommissionBp: 321, ezcashCommissionBp: 32 }));
    } finally { d.close(); }

    const { app } = await env.build();
    const { payload, headers } = buildMultipart([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'v2.db', content: readFileSync(v2) },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().schemaVersion).toBe(latestVersion());
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().rates)
      .toEqual({ reloadCommissionBp: 321, ezcashCommissionBp: 32 });
    const cats = (await app.inject({ method: 'GET', url: '/api/v1/categories' })).json().items;
    expect(cats).toHaveLength(12);
    const post = await app.inject({
      method: 'POST', url: '/api/v1/products',
      payload: { name: 'After restore', categoryId: cats[0].id, kind: 'stock', sellPriceCents: 100, minPriceCents: 50 },
    });
    expect(post.statusCode).toBe(201);
  });
});
