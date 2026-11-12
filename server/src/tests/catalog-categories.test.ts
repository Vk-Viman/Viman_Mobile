// Category API (GET/POST/PUT /categories) - API level (Fastify inject, real temp database).
// Protects the catalog contract in API_CONTRACTS.md and the segment rules: default categories are locked, a category's
// book (shop/telecom) can only change while it has no products (section 0: segments are disjoint), names are unique
// ignoring case, every real change writes exactly ONE audit row with full before/after (section 12), and a failed
// audit write rolls the change back (the data and its audit trail are one transaction).
// Organised by endpoint: list/filter, create, update, then persistence across a restart.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import {
  auditRows, breakAudit, catIds, CATEGORY_KEYS, count, get, post, put, raw,
} from './helpers/catalog.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const DEFAULTS = [
  'Electronics', 'Other', 'Party Items', 'Perfume', 'Phone Accessories', 'Phone Covers', 'Pooja Items',
  'SIM', 'Snacks and Drinks', 'Stationery', 'Tempered Glass',
];

// Helper: create a product in a category through the API (used to make a category "non-empty").
async function newProduct(app: Parameters<typeof post>[0], categoryId: number, name = 'Prod') {
  const r = await post(app, '/products', { name, categoryId, kind: 'stock', sellPriceCents: 100, minPriceCents: 50 });
  expect(r.status).toBe(201);
  return r.body.item;
}

// Listing: defaults, ordering, filters and query validation.
describe('GET /categories', () => {
  // The fresh shop shows the 12 seeded categories, shop book first then A-Z, with exactly the contract's fields.
  it('returns the 12 defaults ordered shop first then name, with the exact item shape', async () => {
    const { app } = await env.build();
    const r = await get(app, '/categories');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['items']);
    const items = r.body.items;
    expect(items).toHaveLength(12);
    expect(items.map((i: any) => i.name)).toEqual([...DEFAULTS, 'Scratch Cards']);
    expect(items.slice(0, 11).every((i: any) => i.book === 'shop')).toBe(true);
    expect(items[11].book).toBe('telecom');
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual(CATEGORY_KEYS);
      expect(i).toMatchObject({ isDefault: true, active: true, productCount: 0 });
      expect(typeof i.id).toBe('number');
      expect(i.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
  });

  it('filters by book and active; combos; invalid values and unknown params -> 400', async () => {
    const { app } = await env.build();
    const ids = await catIds(app);
    await put(app, `/categories/${ids.Perfume}`, { active: false });
    const shop = (await get(app, '/categories?book=shop')).body.items;
    expect(shop).toHaveLength(11);
    expect((await get(app, '/categories?book=telecom')).body.items.map((i: any) => i.name)).toEqual(['Scratch Cards']);
    const inactive = (await get(app, '/categories?active=false')).body.items;
    expect(inactive.map((i: any) => i.name)).toEqual(['Perfume']);
    expect((await get(app, '/categories?active=true')).body.items).toHaveLength(11);
    expect((await get(app, '/categories?active=false&book=telecom')).body.items).toEqual([]);
    for (const bad of ['?book=icecream', '?active=yes', '?active=TRUE', '?active=1', '?foo=bar']) {
      const r = await get(app, `/categories${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('owner categories sort among defaults (shop by name, case-insensitive; telecom after shop)', async () => {
    const { app } = await env.build();
    await post(app, '/categories', { name: 'aardvark', book: 'shop' });
    await post(app, '/categories', { name: 'Zebra', book: 'shop' });
    await post(app, '/categories', { name: 'Aaa Tel', book: 'telecom' });
    const names = (await get(app, '/categories')).body.items.map((i: any) => i.name);
    expect(names[0]).toBe('aardvark');
    expect(names[names.length - 1]).toBe('Scratch Cards');
    expect(names.indexOf('Zebra')).toBeLessThan(names.indexOf('Aaa Tel'));
    expect(names.indexOf('Aaa Tel')).toBeLessThan(names.indexOf('Scratch Cards'));
    expect(names.indexOf('Tempered Glass')).toBeLessThan(names.indexOf('Zebra'));
  });
});

// Creating owner categories: input rules, duplicate names and audit.
describe('POST /categories', () => {
  it('creates with 201, trims the name, owner category is not default', async () => {
    const { app, ctx } = await env.build();
    const r = await post(app, '/categories', { name: '  Gadgets  ', book: 'telecom' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(CATEGORY_KEYS);
    expect(r.body.item).toMatchObject({ name: 'Gadgets', book: 'telecom', isDefault: false, active: true, productCount: 0 });
    expect(count(ctx, 'categories')).toBe(13);
    const again = (await get(app, '/categories')).body.items.find((i: any) => i.id === r.body.item.id);
    expect(again).toEqual(r.body.item);
  });

  it('validation: name 1-60 trimmed, book required/enum, extra fields, non-JSON', async () => {
    const { app, ctx } = await env.build();
    let r = await post(app, '/categories', { name: '', book: 'shop' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: { name: 'Name is required.' } });
    r = await post(app, '/categories', { name: '   ', book: 'shop' });
    expect(r.body.error.fields.name).toBe('Name is required.');
    r = await post(app, '/categories', { name: 'x'.repeat(61), book: 'shop' });
    expect(r.body.error.fields.name).toBe('Name must be at most 60 characters.');
    expect((await post(app, '/categories', { name: 'x'.repeat(60), book: 'shop' })).status).toBe(201);
    expect((await post(app, '/categories', { name: ` ${'y'.repeat(60)} `, book: 'shop' })).status).toBe(201);
    r = await post(app, '/categories', { name: 'NoBook' });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.book).toBeDefined();
    r = await post(app, '/categories', { name: 'Bad', book: 'icecream' });
    expect(r.body.error.fields.book).toBeDefined();
    r = await post(app, '/categories', { book: 'shop' });
    expect(r.body.error.fields.name).toBeDefined();
    r = await post(app, '/categories', { name: 5, book: 'shop' });
    expect(r.status).toBe(400);
    r = await post(app, '/categories', { name: 'Extra', book: 'shop', isDefault: true });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.isDefault).toBe('Unknown field.');
    r = await post(app, '/categories', { name: 'Extra', book: 'shop', active: false });
    expect(r.status).toBe(400);
    r = await raw(app, 'POST', '/categories', '{not json');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(count(ctx, 'categories')).toBe(14);
    expect(auditRows(ctx, 'category')).toHaveLength(2);
  });

  // "Perfume", " perfume " and "PERFUME" are all the same name, even if the other book is chosen; nothing is saved.
  it('DUPLICATE_NAME: case-insensitive, after trimming, within the book; no audit/partial row', async () => {
    const { app, ctx } = await env.build();
    for (const name of ['Electronics', 'electronics', '  ELECTRONICS  ']) {
      const r = await post(app, '/categories', { name, book: 'shop' });
      expect(r.status, name).toBe(409);
      expect(r.body.error.code).toBe('DUPLICATE_NAME');
      expect(r.body.error.fields.name).toBe('A Shop category with this name already exists.');
    }
    expect(count(ctx, 'categories')).toBe(12);
    expect(auditRows(ctx)).toEqual([]);
  });

  it('writes exactly one audit row: entity category, action create, before null, after = item', async () => {
    const { app, ctx } = await env.build();
    const r = await post(app, '/categories', { name: 'Audited', book: 'shop' });
    const rows = auditRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'category', entityId: String(r.body.item.id), action: 'create', before: null });
    expect(rows[0]!.after).toEqual(r.body.item);
  });

  // breakAudit forces the audit insert to fail; the category must not exist afterwards (one transaction).
  it('rolls back the row when its audit write fails', async () => {
    const { app, ctx } = await env.build();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    breakAudit(ctx, 'category');
    const r = await post(app, '/categories', { name: 'Doomed', book: 'shop' });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL_ERROR');
    expect(count(ctx, 'categories')).toBe(12);
    expect(auditRows(ctx)).toEqual([]);
  });
});

// Renaming, activating/deactivating and moving between books, with the lock rules for default categories.
describe('PUT /categories/:id', () => {
  it('renames an owner category (trimmed), 200 with item, one audit row with full before/after', async () => {
    const { app, ctx } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    const r = await put(app, `/categories/${c.id}`, { name: '  Mine Renamed ' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(r.body.item).toMatchObject({ id: c.id, name: 'Mine Renamed', book: 'shop', isDefault: false });
    expect(r.body.item.updatedAt >= c.updatedAt).toBe(true);
    const rows = auditRows(ctx);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ entity: 'category', entityId: String(c.id), action: 'update' });
    expect(rows[1]!.before).toEqual(c);
    expect(rows[1]!.after).toEqual(r.body.item);
  });

  it('case-only rename of own category is allowed (self excluded from duplicate check)', async () => {
    const { app } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    const r = await put(app, `/categories/${c.id}`, { name: 'MINE' });
    expect(r.status).toBe(200);
    expect(r.body.item.name).toBe('MINE');
  });

  it('DUPLICATE_NAME on rename to another category (case-insensitive); nothing written', async () => {
    const { app, ctx } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    const before = auditRows(ctx).length;
    const r = await put(app, `/categories/${c.id}`, { name: ' electronics ' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_NAME');
    expect(r.body.error.fields.name).toBe('A Shop category with this name already exists.');
    expect(auditRows(ctx)).toHaveLength(before);
    expect((await get(app, '/categories')).body.items.find((i: any) => i.id === c.id).name).toBe('Mine');
  });

  // Seeded categories are part of the report structure, so their name and book are locked (409).
  it('default categories: name, case-only rename and book changes -> 409 DEFAULT_CATEGORY_LOCKED', async () => {
    const { app, ctx } = await env.build();
    const ids = await catIds(app);
    for (const body of [
      { name: 'Gadgets' }, { name: 'ELECTRONICS' }, { name: 'electronics' }, { book: 'telecom' },
      { name: 'Gadgets', book: 'telecom' }, { name: 'Electronics', book: 'telecom' },
    ]) {
      const r = await put(app, `/categories/${ids.Electronics}`, body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.error.code).toBe('DEFAULT_CATEGORY_LOCKED');
    }
    const t = await put(app, `/categories/${ids['Scratch Cards']}`, { book: 'shop' });
    expect(t.status).toBe(409);
    expect(t.body.error.code).toBe('DEFAULT_CATEGORY_LOCKED');
    expect(auditRows(ctx)).toEqual([]);
    const e = (await get(app, '/categories')).body.items.find((i: any) => i.id === ids.Electronics);
    expect(e).toMatchObject({ name: 'Electronics', book: 'shop' });
  });

  it('default categories can be deactivated and reactivated; unchanged values are a no-op', async () => {
    const { app, ctx } = await env.build();
    const ids = await catIds(app);
    let r = await put(app, `/categories/${ids.Perfume}`, { active: false });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ active: false, isDefault: true });
    r = await put(app, `/categories/${ids.Perfume}`, { active: true });
    expect(r.body.item.active).toBe(true);
    // identical name/book alongside is not a change -> not locked
    r = await put(app, `/categories/${ids.Perfume}`, { name: 'Perfume', book: 'shop', active: false });
    expect(r.status).toBe(200);
    expect(r.body.item.active).toBe(false);
    expect(auditRows(ctx).map((a) => a.action)).toEqual(['update', 'update', 'update']);
  });

  // Saving unchanged values must not create noise in the audit log.
  it('no-op PUT returns the item and writes no audit row', async () => {
    const { app, ctx } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    const n = auditRows(ctx).length;
    for (const body of [{ name: 'Mine' }, { name: '  Mine  ' }, { book: 'shop' }, { active: true }, { name: 'Mine', book: 'shop', active: true }]) {
      const r = await put(app, `/categories/${c.id}`, body);
      expect(r.status).toBe(200);
      expect(r.body.item).toEqual(c);
    }
    expect(auditRows(ctx)).toHaveLength(n);
  });

  // A category with products (even inactive ones) cannot switch book, otherwise those products would move between P&L segments.
  it('book: changes only while productCount = 0, else 409 CATEGORY_HAS_PRODUCTS (inactive products count)', async () => {
    const { app, ctx } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    let r = await put(app, `/categories/${c.id}`, { book: 'telecom' });
    expect(r.status).toBe(200);
    expect(r.body.item.book).toBe('telecom');
    r = await put(app, `/categories/${c.id}`, { book: 'shop' });
    expect(r.body.item.book).toBe('shop');
    const p = await newProduct(app, c.id);
    expect((await get(app, '/categories')).body.items.find((i: any) => i.id === c.id).productCount).toBe(1);
    r = await put(app, `/categories/${c.id}`, { book: 'telecom' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CATEGORY_HAS_PRODUCTS');
    // an inactive product still counts
    await put(app, `/products/${p.id}`, { active: false });
    r = await put(app, `/categories/${c.id}`, { book: 'telecom' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CATEGORY_HAS_PRODUCTS');
    // same book with products is a no-op, rename still fine
    expect((await put(app, `/categories/${c.id}`, { book: 'shop', name: 'Mine B' })).status).toBe(200);
    expect(auditRows(ctx, 'category').filter((a) => a.action === 'update')).toHaveLength(3);
  });

  // Deactivating hides a category from new products but never touches existing ones (no hard deletes).
  it('deactivate keeps products; productCount includes inactive; new products cannot use it', async () => {
    const { app } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    const p = await newProduct(app, c.id);
    await put(app, `/products/${p.id}`, { active: false });
    await newProduct(app, c.id, 'Second');
    const r = await put(app, `/categories/${c.id}`, { active: false });
    expect(r.body.item).toMatchObject({ active: false, productCount: 2 });
    expect((await get(app, `/products/${p.id}`)).body.item.categoryId).toBe(c.id);
    const bad = await post(app, '/products', { name: 'Third', categoryId: c.id, kind: 'stock', sellPriceCents: 1, minPriceCents: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CATEGORY_INACTIVE');
    expect((await put(app, `/categories/${c.id}`, { active: true })).body.item.active).toBe(true);
    expect((await post(app, '/products', { name: 'Third', categoryId: c.id, kind: 'stock', sellPriceCents: 1, minPriceCents: 1 })).status).toBe(201);
  });

  it('validation and id errors', async () => {
    const { app, ctx } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    const n = auditRows(ctx).length;
    let r = await put(app, `/categories/${c.id}`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    r = await put(app, `/categories/${c.id}`, { name: '' });
    expect(r.body.error.fields.name).toBe('Name is required.');
    r = await put(app, `/categories/${c.id}`, { name: 'z'.repeat(61) });
    expect(r.body.error.fields.name).toBe('Name must be at most 60 characters.');
    r = await put(app, `/categories/${c.id}`, { book: 'icecream' });
    expect(r.status).toBe(400);
    r = await put(app, `/categories/${c.id}`, { active: 'yes' });
    expect(r.status).toBe(400);
    r = await put(app, `/categories/${c.id}`, { productCount: 3 });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.productCount).toBe('Unknown field.');
    r = await put(app, `/categories/${c.id}`, { isDefault: true });
    expect(r.status).toBe(400);
    r = await raw(app, 'PUT', `/categories/${c.id}`, '');
    expect(r.status).toBe(400);
    for (const id of ['abc', '1.5', '-1', '0x1', '1234567890']) {
      r = await put(app, `/categories/${id}`, { active: true });
      expect(r.status, id).toBe(400);
    }
    r = await put(app, '/categories/99999', { active: false });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect(auditRows(ctx)).toHaveLength(n);
  });

  it('rolls back the update when its audit write fails', async () => {
    const { app, ctx } = await env.build();
    const c = (await post(app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    breakAudit(ctx, 'category');
    const r = await put(app, `/categories/${c.id}`, { name: 'Changed' });
    expect(r.status).toBe(500);
    expect((await get(app, '/categories')).body.items.find((i: any) => i.id === c.id).name).toBe('Mine');
  });
});

// Data must still be there after the app is stopped and started again on the same folder.
describe('persistence', () => {
  it('categories survive re-opening the same data directory', async () => {
    const first = await env.build();
    const c = (await post(first.app, '/categories', { name: 'Persist', book: 'telecom' })).body.item;
    await put(first.app, `/categories/${c.id}`, { active: false });
    await first.app.close();
    env.apps = env.apps.filter((a) => a !== first.app);
    const second = await env.build({ dataDir: first.dataDir });
    const items = (await get(second.app, '/categories')).body.items;
    expect(items).toHaveLength(13);
    expect(items.find((i: any) => i.id === c.id)).toMatchObject({ name: 'Persist', book: 'telecom', active: false, isDefault: false });
    expect(auditRows(second.ctx, 'category')).toHaveLength(2);
  });
});
