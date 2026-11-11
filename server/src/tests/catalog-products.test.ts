// Product API (GET/POST/PUT /products) - API level (Fastify inject, real temp database).
// Protects the catalog contract and business rules: a product's book comes from its category (cannot be sent),
// selling price >= minimum price, services have reorder level 0 and no stock, kind is immutable, names/codes unique
// ignoring case, stock fields (qtyOnHand, stockValueCents) are read-only here (only inventory movements change them,
// section 3), and the derived fields avgUnitCostCents (value/qty, display only) and lowStock.
// Every real change writes exactly one audit row (section 12); failed or no-op writes write none.
// Organised by endpoint: create, derived fields, get one, list/search/filter/paging, update, persistence.

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import type { AppContext } from '../app.ts';
import {
  auditRows, breakAudit, catIds, count, get, post, PRODUCT_KEYS, put, raw,
} from './helpers/catalog.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

// Test context: the app, its database context and the seeded category ids by name.
interface Base { app: FastifyInstance; ctx: AppContext; ids: Record<string, number> }
async function setup(): Promise<Base> {
  const b = await env.build();
  return { app: b.app, ctx: b.ctx, ids: await catIds(b.app) };
}

// Default valid product body: sells for Rs 10.00 (1000 cents), minimum Rs 8.00 (800).
const body = (ids: Record<string, number>, over: Record<string, unknown> = {}) => ({
  name: 'Widget', categoryId: ids.Electronics, kind: 'stock', sellPriceCents: 1000, minPriceCents: 800, ...over,
});
async function mk(s: Base, over: Record<string, unknown> = {}) {
  const r = await post(s.app, '/products', body(s.ids, over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.item;
}
function setStock(s: Base, id: number, qty: number, value: number) {
  s.ctx.database.conn.prepare('UPDATE products SET qty_on_hand = ?, stock_value_cents = ? WHERE id = ?').run(qty, value, id);
}
const names = (r: { body: any }) => r.body.items.map((i: any) => i.name);

// Creating products: shape, derived fields, validation, duplicates, audit.
describe('POST /products', () => {
  it('creates with 201, exact shape, defaults, derived book/categoryName, zero stock', async () => {
    const s = await setup();
    const r = await post(s.app, '/products', body(s.ids));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    const p = r.body.item;
    expect(Object.keys(p).sort()).toEqual(PRODUCT_KEYS);
    expect(p).toMatchObject({
      code: null, name: 'Widget', description: '', categoryId: s.ids.Electronics, categoryName: 'Electronics',
      kind: 'stock', book: 'shop', sellPriceCents: 1000, minPriceCents: 800, reorderLevel: 0, active: true,
      qtyOnHand: 0, stockValueCents: 0, avgUnitCostCents: null, lowStock: false,
    });
    expect(typeof p.id).toBe('number');
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((await get(s.app, `/products/${p.id}`)).body.item).toEqual(p);
  });

  // A product in "Scratch Cards" is automatically a telecom product; sending a book is refused (cannot be spoofed).
  it('book is derived from the category (telecom) and cannot be sent', async () => {
    const s = await setup();
    const p = await mk(s, { name: 'Dialog 100', categoryId: s.ids['Scratch Cards'], kind: 'service' });
    expect(p.book).toBe('telecom');
    expect(p.categoryName).toBe('Scratch Cards');
    const r = await post(s.app, '/products', body(s.ids, { name: 'B', book: 'telecom' }));
    expect(r.status).toBe(400);
    expect(r.body.error.fields.book).toBe('Unknown field.');
  });

  it('trims name, code and description; empty/blank code = no code', async () => {
    const s = await setup();
    const p = await mk(s, { name: '  Cable  ', code: '  C-1  ', description: '  nice  ' });
    expect(p).toMatchObject({ name: 'Cable', code: 'C-1', description: 'nice' });
    expect((await mk(s, { name: 'NoCode1', code: '' })).code).toBeNull();
    expect((await mk(s, { name: 'NoCode2', code: '   ' })).code).toBeNull();
    expect((await mk(s, { name: 'NoCode3' })).code).toBeNull();
  });

  it('name: required, 1-120 after trim', async () => {
    const s = await setup();
    let r = await post(s.app, '/products', body(s.ids, { name: '' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: { name: 'Name is required.' } });
    expect((await post(s.app, '/products', body(s.ids, { name: '   ' }))).body.error.fields.name).toBe('Name is required.');
    const { name: _n, ...noName } = body(s.ids);
    expect((await post(s.app, '/products', noName)).body.error.fields.name).toBeDefined();
    r = await post(s.app, '/products', body(s.ids, { name: 'n'.repeat(121) }));
    expect(r.body.error.fields.name).toBe('Name must be at most 120 characters.');
    expect((await post(s.app, '/products', body(s.ids, { name: 'n'.repeat(120) }))).status).toBe(201);
    expect((await post(s.app, '/products', body(s.ids, { name: ` ${'m'.repeat(120)} ` }))).status).toBe(201);
    expect((await post(s.app, '/products', body(s.ids, { name: 7 }))).status).toBe(400);
  });

  it('code: max 30, description max 500, types', async () => {
    const s = await setup();
    let r = await post(s.app, '/products', body(s.ids, { code: 'c'.repeat(31) }));
    expect(r.body.error.fields.code).toBe('Code must be at most 30 characters.');
    expect((await post(s.app, '/products', body(s.ids, { name: 'a', code: 'c'.repeat(30) }))).status).toBe(201);
    r = await post(s.app, '/products', body(s.ids, { name: 'b', description: 'd'.repeat(501) }));
    expect(r.body.error.fields.description).toBe('Description must be at most 500 characters.');
    expect((await post(s.app, '/products', body(s.ids, { name: 'c', description: 'd'.repeat(500) }))).status).toBe(201);
    expect((await post(s.app, '/products', body(s.ids, { name: 'd', code: null }))).status).toBe(400);
    expect((await post(s.app, '/products', body(s.ids, { name: 'e', code: 5 }))).status).toBe(400);
    expect((await post(s.app, '/products', body(s.ids, { name: 'f', description: null }))).status).toBe(400);
  });

  it('kind: required and enum; services must have reorderLevel 0', async () => {
    const s = await setup();
    expect((await post(s.app, '/products', body(s.ids, { kind: 'bundle' }))).body.error.fields.kind).toBeDefined();
    const { kind: _k, ...noKind } = body(s.ids);
    expect((await post(s.app, '/products', noKind)).body.error.fields.kind).toBeDefined();
    const bad = await post(s.app, '/products', body(s.ids, { kind: 'service', reorderLevel: 3 }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.reorderLevel).toBe('Services do not hold stock, so the reorder level must be 0.');
    const ok = await post(s.app, '/products', body(s.ids, { name: 'Svc', kind: 'service', reorderLevel: 0 }));
    expect(ok.status).toBe(201);
    expect(ok.body.item).toMatchObject({ kind: 'service', reorderLevel: 0, lowStock: false });
    expect((await post(s.app, '/products', body(s.ids, { name: 'Svc2', kind: 'service' }))).status).toBe(201);
  });

  it('reorderLevel: integer >= 0, default 0', async () => {
    const s = await setup();
    expect((await mk(s, { name: 'R5', reorderLevel: 5 })).reorderLevel).toBe(5);
    for (const v of [-1, 1.5, '5', null]) {
      const r = await post(s.app, '/products', body(s.ids, { name: `bad${String(v)}`, reorderLevel: v }));
      expect(r.status, String(v)).toBe(400);
      expect(r.body.error.fields.reorderLevel).toBeDefined();
    }
  });

  // Prices are whole cents from 0 to Rs 9,999,999.99; strings, decimals and nulls are rejected rather than coerced.
  it('price bounds: 0 and 999999999 accepted; 1000000000, negative, 1.5, "5", null, missing -> 400, no coercion', async () => {
    const s = await setup();
    expect((await mk(s, { name: 'Zero', sellPriceCents: 0, minPriceCents: 0 })).sellPriceCents).toBe(0);
    const max = await mk(s, { name: 'Max', sellPriceCents: 999999999, minPriceCents: 999999999 });
    expect(max).toMatchObject({ sellPriceCents: 999999999, minPriceCents: 999999999 });
    for (const field of ['sellPriceCents', 'minPriceCents'] as const) {
      for (const v of [1000000000, -1, 1.5, '5', null, true, 1e21]) {
        const over = field === 'sellPriceCents' ? { sellPriceCents: v, minPriceCents: 0 } : { sellPriceCents: 999999999, minPriceCents: v };
        const r = await post(s.app, '/products', body(s.ids, { name: `x${field}${String(v)}`, ...over }));
        expect(r.status, `${field}=${String(v)}`).toBe(400);
        expect(r.body.error.code).toBe('VALIDATION_ERROR');
        expect(r.body.error.fields[field]).toBeDefined();
      }
      const missing: Record<string, unknown> = body(s.ids, { name: 'missing' });
      delete missing[field];
      const r = await post(s.app, '/products', missing);
      expect(r.status).toBe(400);
      expect(r.body.error.fields[field]).toBeDefined();
    }
    // range message from the service for out-of-range integers
    const r = await post(s.app, '/products', body(s.ids, { name: 'big', sellPriceCents: 1000000000, minPriceCents: 0 }));
    expect(r.body.error.fields.sellPriceCents).toBe('Selling price must be a whole number of cents between 0 and 999999999.');
    const neg = await post(s.app, '/products', body(s.ids, { name: 'neg', sellPriceCents: 5, minPriceCents: -1 }));
    expect(neg.body.error.fields.minPriceCents).toBe('Minimum price must be a whole number of cents between 0 and 999999999.');
    expect(count(s.ctx, 'products')).toBe(2);
  });

  // A minimum price above the selling price would make every sale a warning (R13); equal is fine.
  it('minPriceCents must not exceed sellPriceCents (exact message), equal is fine', async () => {
    const s = await setup();
    const r = await post(s.app, '/products', body(s.ids, { sellPriceCents: 100, minPriceCents: 101 }));
    expect(r.status).toBe(400);
    expect(r.body.error.fields.minPriceCents).toBe('Minimum price cannot be higher than the selling price.');
    expect((await post(s.app, '/products', body(s.ids, { sellPriceCents: 100, minPriceCents: 100 }))).status).toBe(201);
  });

  it('collects several field errors at once', async () => {
    const s = await setup();
    const r = await post(s.app, '/products', body(s.ids, { name: '', code: 'c'.repeat(40), sellPriceCents: -5, minPriceCents: -6 }));
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.error.fields).sort()).toEqual(['code', 'minPriceCents', 'name', 'sellPriceCents']);
  });

  it('category: required integer >= 1; unknown -> "Choose a category."; inactive -> CATEGORY_INACTIVE', async () => {
    const s = await setup();
    const { categoryId: _c, ...none } = body(s.ids);
    expect((await post(s.app, '/products', none)).body.error.fields.categoryId).toBeDefined();
    for (const v of [0, -3, 1.5, '1', null]) {
      const r = await post(s.app, '/products', body(s.ids, { categoryId: v }));
      expect(r.status, String(v)).toBe(400);
      expect(r.body.error.fields.categoryId).toBeDefined();
    }
    const unknown = await post(s.app, '/products', body(s.ids, { categoryId: 99999 }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: { categoryId: 'Choose a category.' } });
    await put(s.app, `/categories/${s.ids.Electronics}`, { active: false });
    const inactive = await post(s.app, '/products', body(s.ids));
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.code).toBe('CATEGORY_INACTIVE');
    expect(inactive.body.error.fields.categoryId).toBeDefined();
    expect(count(s.ctx, 'products')).toBe(0);
  });

  // Stock and book are controlled by the system; a client cannot set them through the catalog.
  it('extra / read-only fields are rejected (qtyOnHand, stockValueCents, id, active, book)', async () => {
    const s = await setup();
    for (const f of ['qtyOnHand', 'stockValueCents', 'id', 'active', 'book', 'lowStock', 'avgUnitCostCents', 'createdAt']) {
      const r = await post(s.app, '/products', body(s.ids, { [f]: 1 }));
      expect(r.status, f).toBe(400);
      expect(r.body.error.fields[f]).toBe('Unknown field.');
    }
    expect((await raw(s.app, 'POST', '/products', '[1]')).status).toBe(400);
    expect((await raw(s.app, 'POST', '/products', '{bad')).status).toBe(400);
    expect(count(s.ctx, 'products')).toBe(0);
  });

  // Same name or code in any letter case is a duplicate, even after trimming; the failed request saves nothing.
  it('DUPLICATE_NAME / DUPLICATE_CODE: case-insensitive after trim; nothing written; no audit', async () => {
    const s = await setup();
    await mk(s, { name: 'Cable', code: 'AbC' });
    const n = auditRows(s.ctx).length;
    for (const name of ['cable', 'CABLE', '  Cable ']) {
      const r = await post(s.app, '/products', body(s.ids, { name, code: 'other' }));
      expect(r.status, name).toBe(409);
      expect(r.body.error.code).toBe('DUPLICATE_NAME');
      expect(r.body.error.fields.name).toBe('Another product already uses this name.');
    }
    for (const code of ['abc', 'ABC', ' aBc ']) {
      const r = await post(s.app, '/products', body(s.ids, { name: 'Different', code }));
      expect(r.status, code).toBe(409);
      expect(r.body.error.code).toBe('DUPLICATE_CODE');
      expect(r.body.error.fields.code).toBe('Another product already uses this code.');
    }
    expect(count(s.ctx, 'products')).toBe(1);
    expect(auditRows(s.ctx)).toHaveLength(n);
    // duplicate in a different category is still duplicate; two products without code are fine
    expect((await post(s.app, '/products', body(s.ids, { name: 'CABLE', categoryId: s.ids.Other }))).status).toBe(409);
    await mk(s, { name: 'NC1' });
    await mk(s, { name: 'NC2' });
  });

  it('writes exactly one audit row: entity product, create, before null, after = full item', async () => {
    const s = await setup();
    const p = await mk(s, { code: 'A1' });
    const rows = auditRows(s.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'product', entityId: String(p.id), action: 'create', before: null });
    expect(rows[0]!.after).toEqual(p);
    expect(Object.keys(rows[0]!.after).sort()).toEqual(PRODUCT_KEYS);
  });

  it('rolls back the product when its audit write fails', async () => {
    const s = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    breakAudit(s.ctx, 'product');
    const r = await post(s.app, '/products', body(s.ids));
    expect(r.status).toBe(500);
    expect(count(s.ctx, 'products')).toBe(0);
    expect(auditRows(s.ctx)).toEqual([]);
  });
});

// The two computed fields the owner sees on the stock screen (display only; costing is done by the stock engine).
describe('derived fields: avgUnitCostCents and lowStock', () => {
  // average = value / qty rounded half away from zero (R0): 1000/3 = 333.33 -> 333; 2000/3 = 666.67 -> 667;
  // 1/2 = 0.5 -> 1; 3/2 = 1.5 -> 2; 5/2 = 2.5 -> 3. No quantity -> null (no average exists); quantity with value 0 -> 0.
  it('avgUnitCostCents rounds half away from zero; null when qty is 0; large values exact', async () => {
    const s = await setup();
    const p = await mk(s);
    const avg = async () => (await get(s.app, `/products/${p.id}`)).body.item;
    expect((await avg()).avgUnitCostCents).toBeNull();
    setStock(s, p.id, 3, 1000);
    expect(await avg()).toMatchObject({ qtyOnHand: 3, stockValueCents: 1000, avgUnitCostCents: 333 });
    setStock(s, p.id, 3, 2000);
    expect((await avg()).avgUnitCostCents).toBe(667);
    setStock(s, p.id, 2, 1);
    expect((await avg()).avgUnitCostCents).toBe(1);
    setStock(s, p.id, 2, 3);
    expect((await avg()).avgUnitCostCents).toBe(2);
    setStock(s, p.id, 2, 5);
    expect((await avg()).avgUnitCostCents).toBe(3);
    setStock(s, p.id, 4, 0);
    expect((await avg()).avgUnitCostCents).toBe(0);
    setStock(s, p.id, 0, 0);
    expect((await avg()).avgUnitCostCents).toBeNull();
    setStock(s, p.id, 1, 9007199254740);
    expect((await avg()).avgUnitCostCents).toBe(9007199254740);
    setStock(s, p.id, 7, 9007199254740);
    expect((await avg()).avgUnitCostCents).toBe(Number((9007199254740n * 2n + 7n) / 14n));
    setStock(s, p.id, 999999999, 999999999999);
    expect((await avg()).avgUnitCostCents).toBe(1000);
    // also reflected in list and audit "after"
    setStock(s, p.id, 3, 1000);
    expect((await get(s.app, '/products')).body.items[0].avgUnitCostCents).toBe(333);
    const upd = await put(s.app, `/products/${p.id}`, { description: 'x' });
    expect(upd.body.item.avgUnitCostCents).toBe(333);
    expect(auditRows(s.ctx).at(-1)!.after.avgUnitCostCents).toBe(333);
  });

  // Low-stock alert: only for active stock items with a reorder level set, when qty is at or below it.
  // Services and items with reorder level 0 never alert; deactivated items never alert.
  it('lowStock = stock AND active AND reorderLevel > 0 AND qty <= reorderLevel', async () => {
    const s = await setup();
    const p = await mk(s, { reorderLevel: 5 });
    const low = async () => (await get(s.app, `/products/${p.id}`)).body.item.lowStock;
    expect(await low()).toBe(true); // qty 0 <= 5
    setStock(s, p.id, 5, 100);
    expect(await low()).toBe(true);
    setStock(s, p.id, 6, 100);
    expect(await low()).toBe(false);
    setStock(s, p.id, 5, 100);
    await put(s.app, `/products/${p.id}`, { active: false });
    expect(await low()).toBe(false);
    await put(s.app, `/products/${p.id}`, { active: true });
    expect(await low()).toBe(true);
    await put(s.app, `/products/${p.id}`, { reorderLevel: 0 });
    expect(await low()).toBe(false);
    const svc = await mk(s, { name: 'Svc', kind: 'service' });
    expect(svc.lowStock).toBe(false);
    const zero = await mk(s, { name: 'ZeroReorder' });
    expect(zero.lowStock).toBe(false);
  });
});

// Fetching one product: found, not found, bad id.
describe('GET /products/:id', () => {
  it('200 / 404 / bad id', async () => {
    const s = await setup();
    const p = await mk(s);
    expect((await get(s.app, `/products/${p.id}`)).status).toBe(200);
    const nf = await get(s.app, '/products/99999');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    for (const id of ['abc', '1.5', '-1', '1e3', '1234567890', '%20']) {
      const r = await get(s.app, `/products/${id}`);
      expect(r.status, id).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

// The product list: ordering, search (wildcards are literal), filters and paging.
describe('GET /products (list)', () => {
  async function seed(s: Base) {
    const out: Record<string, any> = {};
    out.banana = await mk(s, { name: 'banana', code: 'FRU-2', categoryId: s.ids['Snacks and Drinks'] });
    out.apple = await mk(s, { name: 'Apple', code: 'fru-1', categoryId: s.ids['Snacks and Drinks'] });
    out.cherry = await mk(s, { name: 'Cherry', categoryId: s.ids.Other });
    out.card = await mk(s, { name: 'Dialog Card', categoryId: s.ids['Scratch Cards'], kind: 'service' });
    return out;
  }

  it('orders by name case-insensitively then id; default limit; total', async () => {
    const s = await setup();
    await seed(s);
    const r = await get(s.app, '/products');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'total']);
    expect(names(r)).toEqual(['Apple', 'banana', 'Cherry', 'Dialog Card']);
    expect(r.body.total).toBe(4);
    for (const i of r.body.items) expect(Object.keys(i).sort()).toEqual(PRODUCT_KEYS);
    expect((await get(s.app, '/products?book=shop&limit=500')).body.total).toBe(3);
  });

  it('empty catalog', async () => {
    const s = await setup();
    expect((await get(s.app, '/products')).body).toEqual({ items: [], total: 0 });
  });

  it('q: substring of name or code, case-insensitive, trimmed; % and _ are literal', async () => {
    const s = await setup();
    await mk(s, { name: 'A_B cable', code: 'X1' });
    await mk(s, { name: 'AxB cable', code: 'X2' });
    await mk(s, { name: '100% cotton' });
    await mk(s, { name: 'plain', code: 'p%q' });
    await mk(s, { name: 'Banana' });
    expect(names(await get(s.app, '/products?q=BANAN'))).toEqual(['Banana']);
    expect(names(await get(s.app, '/products?q=x2'))).toEqual(['AxB cable']);
    expect(names(await get(s.app, '/products?q=CABLE'))).toEqual(['A_B cable', 'AxB cable']);
    expect(names(await get(s.app, '/products?q=%20banan%20'))).toEqual(['Banana']);
    expect(names(await get(s.app, '/products?q=_'))).toEqual(['A_B cable']);
    expect(names(await get(s.app, '/products?q=%25'))).toEqual(['100% cotton', 'plain']);
    expect(names(await get(s.app, '/products?q=p%25q'))).toEqual(['plain']);
    expect(names(await get(s.app, '/products?q=%5C'))).toEqual([]);
    expect(names(await get(s.app, '/products?q=%25%25'))).toEqual([]);
    expect((await get(s.app, '/products?q=%20%20')).body.total).toBe(5);
    expect((await get(s.app, '/products?q=zzz')).body).toEqual({ items: [], total: 0 });
    expect((await get(s.app, `/products?q=${'a'.repeat(201)}`)).status).toBe(400);
  });

  it('filters: book, categoryId, active, lowStock, and combinations', async () => {
    const s = await setup();
    const p = await seed(s);
    expect(names(await get(s.app, '/products?book=telecom'))).toEqual(['Dialog Card']);
    expect(names(await get(s.app, `/products?categoryId=${s.ids['Snacks and Drinks']}`))).toEqual(['Apple', 'banana']);
    expect((await get(s.app, '/products?categoryId=99999')).body).toEqual({ items: [], total: 0 });
    await put(s.app, `/products/${p.banana.id}`, { active: false });
    expect(names(await get(s.app, '/products?active=false'))).toEqual(['banana']);
    expect(names(await get(s.app, '/products?active=true'))).toEqual(['Apple', 'Cherry', 'Dialog Card']);
    expect(names(await get(s.app, `/products?active=true&categoryId=${s.ids['Snacks and Drinks']}`))).toEqual(['Apple']);
    // lowStock
    await put(s.app, `/products/${p.apple.id}`, { reorderLevel: 5 });
    await put(s.app, `/products/${p.banana.id}`, { reorderLevel: 5 });
    await put(s.app, `/products/${p.cherry.id}`, { reorderLevel: 2 });
    setStock(s, p.apple.id, 5, 10);
    setStock(s, p.banana.id, 1, 10); // inactive -> not low
    setStock(s, p.cherry.id, 3, 10);
    expect(names(await get(s.app, '/products?lowStock=true'))).toEqual(['Apple']);
    expect(names(await get(s.app, '/products?lowStock=false'))).toEqual(['Apple', 'banana', 'Cherry', 'Dialog Card']);
    expect(names(await get(s.app, '/products?lowStock=true&book=telecom'))).toEqual([]);
    for (const bad of ['book=icecream', 'active=yes', 'active=TRUE', 'lowStock=1', 'categoryId=abc', 'categoryId=1.5',
      'categoryId=-1', 'categoryId=1234567890', 'foo=bar', 'sort=name']) {
      const r = await get(s.app, `/products?${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('paging: limit/offset/total; defaults; limit 1..500; bad values -> 400', async () => {
    const s = await setup();
    for (let i = 1; i <= 5; i++) await mk(s, { name: `P${i}` });
    let r = await get(s.app, '/products?limit=2');
    expect(names(r)).toEqual(['P1', 'P2']);
    expect(r.body.total).toBe(5);
    r = await get(s.app, '/products?limit=2&offset=2');
    expect(names(r)).toEqual(['P3', 'P4']);
    expect(r.body.total).toBe(5);
    r = await get(s.app, '/products?limit=2&offset=4');
    expect(names(r)).toEqual(['P5']);
    r = await get(s.app, '/products?offset=5');
    expect(r.body).toMatchObject({ items: [], total: 5 });
    r = await get(s.app, '/products?offset=999999999');
    expect(r.body).toMatchObject({ items: [], total: 5 });
    expect(names(await get(s.app, '/products?limit=1'))).toEqual(['P1']);
    expect((await get(s.app, '/products?limit=500')).status).toBe(200);
    expect((await get(s.app, '/products?limit=500&offset=0')).body.items).toHaveLength(5);
    // total reflects filters, not the page
    r = await get(s.app, '/products?q=P&limit=1&offset=1');
    expect(names(r)).toEqual(['P2']);
    expect(r.body.total).toBe(5);
    for (const bad of ['limit=0', 'limit=501', 'limit=-1', 'limit=abc', 'limit=1.5', 'limit=', 'limit=1234567890',
      'offset=-1', 'offset=1.5', 'offset=abc', 'offset=1234567890']) {
      const x = await get(s.app, `/products?${bad}`);
      expect(x.status, bad).toBe(400);
      expect(x.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get(s.app, '/products?limit=0')).body.error.fields.limit).toBeDefined();
  });
});

// Editing products: partial updates validated against the merged result, category moves, activate/deactivate, audit chain.
describe('PUT /products/:id', () => {
  it('updates any subset, trims, 200 { item }, full before/after audit; others unchanged', async () => {
    const s = await setup();
    const p = await mk(s, { code: 'K1', description: 'd', reorderLevel: 2 });
    const r = await put(s.app, `/products/${p.id}`, { name: '  Renamed ', description: ' new ', sellPriceCents: 2000, minPriceCents: 1500, reorderLevel: 9 });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(r.body.item).toMatchObject({
      id: p.id, name: 'Renamed', description: 'new', sellPriceCents: 2000, minPriceCents: 1500, reorderLevel: 9,
      code: 'K1', kind: 'stock', book: 'shop', categoryId: p.categoryId, active: true,
    });
    expect(r.body.item.updatedAt >= p.updatedAt).toBe(true);
    const rows = auditRows(s.ctx);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ entity: 'product', entityId: String(p.id), action: 'update' });
    expect(rows[1]!.before).toEqual(p);
    expect(rows[1]!.after).toEqual(r.body.item);
  });

  it('kind (and other read-only / unknown fields) in PUT -> 400', async () => {
    const s = await setup();
    const p = await mk(s);
    for (const f of ['kind', 'book', 'qtyOnHand', 'stockValueCents', 'id', 'categoryName', 'lowStock', 'avgUnitCostCents']) {
      const r = await put(s.app, `/products/${p.id}`, { [f]: f === 'kind' ? 'service' : f === 'book' ? 'telecom' : 1 });
      expect(r.status, f).toBe(400);
      expect(r.body.error.fields[f]).toBe('Unknown field.');
    }
    const mixed = await put(s.app, `/products/${p.id}`, { name: 'Valid', kind: 'service' });
    expect(mixed.status).toBe(400);
    expect((await get(s.app, `/products/${p.id}`)).body.item).toEqual(p);
    expect(auditRows(s.ctx)).toHaveLength(1);
  });

  it('empty body / no body / malformed JSON -> 400; bad ids -> 400; unknown id -> 404', async () => {
    const s = await setup();
    const p = await mk(s);
    let r = await put(s.app, `/products/${p.id}`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect((await raw(s.app, 'PUT', `/products/${p.id}`, '')).status).toBe(400);
    expect((await raw(s.app, 'PUT', `/products/${p.id}`, '{bad')).status).toBe(400);
    for (const id of ['abc', '1.5', '-1', '1234567890']) expect((await put(s.app, `/products/${id}`, { active: true })).status, id).toBe(400);
    r = await put(s.app, '/products/99999', { active: false });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect(auditRows(s.ctx)).toHaveLength(1);
  });

  it('code: null or "" clears; new code set; trimmed; max 30; DUPLICATE_CODE (case-insensitive) with self excluded', async () => {
    const s = await setup();
    const a = await mk(s, { name: 'A', code: 'AAA' });
    const b = await mk(s, { name: 'B', code: 'BBB' });
    let r = await put(s.app, `/products/${a.id}`, { code: null });
    expect(r.body.item.code).toBeNull();
    r = await put(s.app, `/products/${a.id}`, { code: ' new1 ' });
    expect(r.body.item.code).toBe('new1');
    r = await put(s.app, `/products/${a.id}`, { code: '' });
    expect(r.body.item.code).toBeNull();
    r = await put(s.app, `/products/${a.id}`, { code: '   ' });
    expect(r.status).toBe(200);
    expect(r.body.item.code).toBeNull();
    // cleared code frees it for others
    r = await put(s.app, `/products/${b.id}`, { code: 'bbb' }); // case-only change on self
    expect(r.status).toBe(200);
    expect(r.body.item.code).toBe('bbb');
    r = await put(s.app, `/products/${a.id}`, { code: 'BBB' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_CODE');
    expect(r.body.error.fields.code).toBe('Another product already uses this code.');
    r = await put(s.app, `/products/${a.id}`, { code: 'c'.repeat(31) });
    expect(r.body.error.fields.code).toBe('Code must be at most 30 characters.');
    expect((await get(s.app, `/products/${a.id}`)).body.item.code).toBeNull();
    // clearing a code that is already null is a no-op
    const n = auditRows(s.ctx).length;
    expect((await put(s.app, `/products/${a.id}`, { code: null })).status).toBe(200);
    expect((await put(s.app, `/products/${a.id}`, { code: '' })).status).toBe(200);
    expect(auditRows(s.ctx)).toHaveLength(n);
  });

  it('DUPLICATE_NAME on rename to another product; case-only rename of self is allowed', async () => {
    const s = await setup();
    const a = await mk(s, { name: 'Alpha' });
    await mk(s, { name: 'Beta' });
    const n = auditRows(s.ctx).length;
    let r = await put(s.app, `/products/${a.id}`, { name: ' beta ' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_NAME');
    expect(r.body.error.fields.name).toBe('Another product already uses this name.');
    expect(auditRows(s.ctx)).toHaveLength(n);
    r = await put(s.app, `/products/${a.id}`, { name: 'ALPHA' });
    expect(r.status).toBe(200);
    expect(r.body.item.name).toBe('ALPHA');
    r = await put(s.app, `/products/${a.id}`, { name: '' });
    expect(r.body.error.fields.name).toBe('Name is required.');
    r = await put(s.app, `/products/${a.id}`, { name: 'n'.repeat(121) });
    expect(r.body.error.fields.name).toBe('Name must be at most 120 characters.');
    r = await put(s.app, `/products/${a.id}`, { description: 'd'.repeat(501) });
    expect(r.body.error.fields.description).toBe('Description must be at most 500 characters.');
  });

  // Changing only the sell price must still respect the stored minimum (and vice versa).
  it('price rules are validated against merged (existing + patch) values', async () => {
    const s = await setup();
    const p = await mk(s, { sellPriceCents: 100, minPriceCents: 50 });
    let r = await put(s.app, `/products/${p.id}`, { minPriceCents: 150 });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.minPriceCents).toBe('Minimum price cannot be higher than the selling price.');
    r = await put(s.app, `/products/${p.id}`, { sellPriceCents: 40 });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.minPriceCents).toBe('Minimum price cannot be higher than the selling price.');
    r = await put(s.app, `/products/${p.id}`, { sellPriceCents: 200, minPriceCents: 150 });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ sellPriceCents: 200, minPriceCents: 150 });
    r = await put(s.app, `/products/${p.id}`, { sellPriceCents: 150 }); // merged min 150 <= 150
    expect(r.status).toBe(200);
    r = await put(s.app, `/products/${p.id}`, { minPriceCents: 0, sellPriceCents: 0 });
    expect(r.status).toBe(200);
    r = await put(s.app, `/products/${p.id}`, { sellPriceCents: 999999999 });
    expect(r.status).toBe(200);
    for (const v of [1000000000, -1, 1.5, '5', null]) {
      for (const f of ['sellPriceCents', 'minPriceCents']) {
        const x = await put(s.app, `/products/${p.id}`, { [f]: v });
        expect(x.status, `${f}=${String(v)}`).toBe(400);
        expect(x.body.error.fields[f]).toBeDefined();
      }
    }
    expect((await get(s.app, `/products/${p.id}`)).body.item).toMatchObject({ sellPriceCents: 999999999, minPriceCents: 0 });
  });

  it('reorderLevel rules on merged values; services stay at 0', async () => {
    const s = await setup();
    const p = await mk(s, { reorderLevel: 3 });
    const svc = await mk(s, { name: 'Svc', kind: 'service' });
    expect((await put(s.app, `/products/${p.id}`, { reorderLevel: 0 })).body.item.reorderLevel).toBe(0);
    for (const v of [-1, 1.5, '2', null]) {
      const r = await put(s.app, `/products/${p.id}`, { reorderLevel: v });
      expect(r.status, String(v)).toBe(400);
      expect(r.body.error.fields.reorderLevel).toBeDefined();
    }
    const bad = await put(s.app, `/products/${svc.id}`, { reorderLevel: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.reorderLevel).toBe('Services do not hold stock, so the reorder level must be 0.');
    expect((await put(s.app, `/products/${svc.id}`, { reorderLevel: 0 })).status).toBe(200);
    expect((await put(s.app, `/products/${svc.id}`, { name: 'Svc renamed' })).body.item.kind).toBe('service');
  });

  // A product may only move to a category of the same book (segments are disjoint).
  it('category moves: same book OK; other book -> CATEGORY_BOOK_MISMATCH; inactive -> CATEGORY_INACTIVE; unknown -> Choose a category.', async () => {
    const s = await setup();
    const p = await mk(s);
    const own = (await post(s.app, '/categories', { name: 'Mine', book: 'shop' })).body.item;
    let r = await put(s.app, `/products/${p.id}`, { categoryId: s.ids.Stationery });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ categoryId: s.ids.Stationery, categoryName: 'Stationery', book: 'shop' });
    const cats = (await get(s.app, '/categories')).body.items;
    expect(cats.find((c: any) => c.id === s.ids.Stationery).productCount).toBe(1);
    expect(cats.find((c: any) => c.id === s.ids.Electronics).productCount).toBe(0);
    r = await put(s.app, `/products/${p.id}`, { categoryId: s.ids['Scratch Cards'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CATEGORY_BOOK_MISMATCH');
    expect(r.body.error.fields.categoryId).toBe('A product can only move to a category in the same book.');
    await put(s.app, `/categories/${own.id}`, { active: false });
    r = await put(s.app, `/products/${p.id}`, { categoryId: own.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CATEGORY_INACTIVE');
    expect(r.body.error.fields.categoryId).toBeDefined();
    r = await put(s.app, `/products/${p.id}`, { categoryId: 99999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: { categoryId: 'Choose a category.' } });
    for (const v of [0, -1, 1.5, '3', null]) expect((await put(s.app, `/products/${p.id}`, { categoryId: v })).status, String(v)).toBe(400);
    expect((await get(s.app, `/products/${p.id}`)).body.item.categoryId).toBe(s.ids.Stationery);
    // telecom product cannot move to a shop category either
    const t = await mk(s, { name: 'Card', categoryId: s.ids['Scratch Cards'], kind: 'service' });
    r = await put(s.app, `/products/${t.id}`, { categoryId: s.ids.Other });
    expect(r.body.error.code).toBe('CATEGORY_BOOK_MISMATCH');
    // a product in a now-inactive category can still be edited if its category is unchanged
    await put(s.app, `/categories/${s.ids.Stationery}`, { active: false });
    r = await put(s.app, `/products/${p.id}`, { name: 'Still editable', categoryId: s.ids.Stationery });
    expect(r.status).toBe(200);
    expect(r.body.item.name).toBe('Still editable');
  });

  // Retiring an item is allowed even with stock on hand; history is never deleted.
  it('deactivate / reactivate always allowed, even with stock and in an inactive category', async () => {
    const s = await setup();
    const p = await mk(s);
    setStock(s, p.id, 4, 400);
    let r = await put(s.app, `/products/${p.id}`, { active: false });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ active: false, qtyOnHand: 4, stockValueCents: 400 });
    await put(s.app, `/categories/${s.ids.Electronics}`, { active: false });
    r = await put(s.app, `/products/${p.id}`, { active: true });
    expect(r.status).toBe(200);
    expect(r.body.item.active).toBe(true);
    expect((await put(s.app, `/products/${p.id}`, { active: 'false' })).status).toBe(400);
  });

  it('no-op PUT returns the item and writes NO audit row', async () => {
    const s = await setup();
    const p = await mk(s, { code: 'K', description: 'd', reorderLevel: 1 });
    const n = auditRows(s.ctx).length;
    for (const b of [
      { name: 'Widget' }, { name: '  Widget  ' }, { code: 'K' }, { code: ' K ' }, { description: 'd' }, { active: true },
      { categoryId: p.categoryId }, { sellPriceCents: 1000, minPriceCents: 800, reorderLevel: 1 },
      { name: 'Widget', code: 'K', description: 'd', categoryId: p.categoryId, sellPriceCents: 1000, minPriceCents: 800, reorderLevel: 1, active: true },
    ]) {
      const r = await put(s.app, `/products/${p.id}`, b);
      expect(r.status, JSON.stringify(b)).toBe(200);
      expect(r.body.item).toEqual(p);
    }
    expect(auditRows(s.ctx)).toHaveLength(n);
  });

  // The audit trail chains: each entry's "before" is the previous entry's "after".
  it('one real change = exactly one audit row; each subsequent change chains before -> after', async () => {
    const s = await setup();
    const p = await mk(s);
    await put(s.app, `/products/${p.id}`, { active: false });
    await put(s.app, `/products/${p.id}`, { active: true });
    await put(s.app, `/products/${p.id}`, { name: 'Z' });
    const rows = auditRows(s.ctx, 'product');
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'update', 'update']);
    for (let i = 2; i < rows.length; i++) expect(rows[i]!.before).toEqual(rows[i - 1]!.after);
    expect(rows[1]!.before.active).toBe(true);
    expect(rows[1]!.after.active).toBe(false);
  });

  it('failed writes leave no audit row and no partial data (duplicate name/code, validation, category errors)', async () => {
    const s = await setup();
    const a = await mk(s, { name: 'Alpha', code: 'A' });
    const b = await mk(s, { name: 'Beta', code: 'B' });
    const n = auditRows(s.ctx).length;
    await put(s.app, `/products/${a.id}`, { name: 'Beta', description: 'changed', sellPriceCents: 5000 });
    await put(s.app, `/products/${a.id}`, { code: 'B', description: 'changed' });
    await put(s.app, `/products/${a.id}`, { description: 'changed', categoryId: s.ids['Scratch Cards'] });
    await put(s.app, `/products/${a.id}`, { description: 'changed', minPriceCents: 99999 });
    expect(auditRows(s.ctx)).toHaveLength(n);
    expect((await get(s.app, `/products/${a.id}`)).body.item).toEqual(a);
    expect((await get(s.app, `/products/${b.id}`)).body.item).toEqual(b);
  });

  it('rolls back the update when its audit write fails', async () => {
    const s = await setup();
    const p = await mk(s);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    breakAudit(s.ctx, 'product');
    const r = await put(s.app, `/products/${p.id}`, { name: 'Changed', sellPriceCents: 5000 });
    expect(r.status).toBe(500);
    expect((await get(s.app, `/products/${p.id}`)).body.item).toEqual(p);
  });
});

// Data must still be there after the app is stopped and started again on the same folder.
describe('persistence', () => {
  it('products survive re-opening the same data directory', async () => {
    const first = await env.build();
    const ids = await catIds(first.app);
    const p = (await post(first.app, '/products', body(ids, { code: 'KEEP' }))).body.item;
    await put(first.app, `/products/${p.id}`, { reorderLevel: 4 });
    await first.app.close();
    env.apps = env.apps.filter((a) => a !== first.app);
    const second = await env.build({ dataDir: first.dataDir });
    const list = await get(second.app, '/products');
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: p.id, name: 'Widget', code: 'KEEP', reorderLevel: 4, book: 'shop' });
    expect(auditRows(second.ctx, 'product').map((a) => a.action)).toEqual(['create', 'update']);
    // uniqueness still enforced after re-open
    expect((await post(second.app, '/products', body(ids, { name: 'widget' }))).status).toBe(409);
  });
});
