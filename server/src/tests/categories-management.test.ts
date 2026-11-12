// Category management (contract 2026-11-13): per-book unique names, book-change rule, delete guard, newCategory on POST /products,
// the `kind` filter and the opening-stock preview rows. Every expectation is stated by hand from the contract.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { auditRows, count, get, post, put } from './helpers/catalog.ts';
import { importFile, previewFile, xlsx } from './helpers/phase13.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const SHOP_DUP = 'A Shop category with this name already exists.';
const TEL_DUP = 'A Telecom category with this name already exists.';

async function setup(): Promise<ApiBase> { return apiBase(await env.build()); }
const mkCat = async (s: ApiBase, name: string, book: 'shop' | 'telecom') => {
  const r = await post(s.app, '/categories', { name, book });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.item;
};
const prodBody = (over: Record<string, unknown> = {}) => ({ name: 'P1', kind: 'stock', sellPriceCents: 1000, minPriceCents: 500, ...over });
const sql = (s: ApiBase, q: string, ...p: any[]) => s.ctx.database.conn.prepare(q).run(...p);

describe('categories: names are unique per book, case-insensitively', () => {
  it('creates Shop and Telecom categories; the SAME name is allowed in both books', async () => {
    const s = await setup();
    const a = await mkCat(s, 'Pens', 'shop');
    const b = await mkCat(s, 'Pens', 'telecom');
    expect(a).toMatchObject({ name: 'Pens', book: 'shop', isDefault: false, active: true, productCount: 0 });
    expect(b).toMatchObject({ name: 'Pens', book: 'telecom', isDefault: false, active: true });
    expect(a.id).not.toBe(b.id);
    const list = (await get(s.app, '/categories')).body.items.filter((c: any) => c.name === 'Pens');
    expect(list.map((c: any) => c.book)).toEqual(['shop', 'telecom']);
  });

  it('duplicate in the same book is refused (pen / PEN / " Pen "): 409 DUPLICATE_NAME with the book in the message', async () => {
    const s = await setup();
    await mkCat(s, 'pen', 'shop');
    await mkCat(s, 'tel pen', 'telecom');
    const audit = auditRows(s.ctx, 'category').length;
    for (const name of ['pen', 'PEN', ' Pen ']) {
      const r = await post(s.app, '/categories', { name, book: 'shop' });
      expect(r.status, name).toBe(409);
      expect(r.body.error.code).toBe('DUPLICATE_NAME');
      expect(r.body.error.message).toBe(SHOP_DUP);
      expect(r.body.error.fields.name).toBe(SHOP_DUP);
    }
    const t = await post(s.app, '/categories', { name: 'TEL PEN', book: 'telecom' });
    expect(t.status).toBe(409);
    expect(t.body.error.fields.name).toBe(TEL_DUP);
    expect(count(s.ctx, 'categories')).toBe(14);
    expect(auditRows(s.ctx, 'category')).toHaveLength(audit);
  });

  it('a default name of one book may be used for a new category of the other book (Scratch Cards in Shop)', async () => {
    const s = await setup();
    const c = await mkCat(s, 'scratch cards', 'shop');
    expect(c.book).toBe('shop');
    expect((await post(s.app, '/categories', { name: 'SCRATCH CARDS', book: 'telecom' })).status).toBe(409);
  });

  it('rename within the book works (incl. case-only); colliding with the same book is refused; the other book is fine', async () => {
    const s = await setup();
    const a = await mkCat(s, 'Alpha', 'shop');
    await mkCat(s, 'Beta', 'shop');
    await mkCat(s, 'Gamma', 'telecom');
    let r = await put(s.app, `/categories/${a.id}`, { name: 'Alpha 2' });
    expect(r.status).toBe(200);
    expect(r.body.item.name).toBe('Alpha 2');
    r = await put(s.app, `/categories/${a.id}`, { name: 'ALPHA 2' });
    expect(r.status).toBe(200);
    expect(r.body.item.name).toBe('ALPHA 2');
    const audit = auditRows(s.ctx, 'category').length;
    r = await put(s.app, `/categories/${a.id}`, { name: ' beta ' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_NAME');
    expect(r.body.error.fields.name).toBe(SHOP_DUP);
    expect(auditRows(s.ctx, 'category')).toHaveLength(audit);
    r = await put(s.app, `/categories/${a.id}`, { name: 'gamma' }); // exists only in Telecom
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ name: 'gamma', book: 'shop' });
  });

  it('names are trimmed and limited to 1..60 characters', async () => {
    const s = await setup();
    expect((await mkCat(s, '  Spaced  ', 'shop')).name).toBe('Spaced');
    expect((await mkCat(s, 'x'.repeat(60), 'shop')).name).toHaveLength(60);
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const r = await post(s.app, '/categories', { name, book: 'shop' });
      expect(r.status, name.length.toString()).toBe(400);
      expect(r.body.error.fields.name).toBeDefined();
    }
  });
});

describe('categories: activation, defaults and deletion', () => {
  it('deactivate and reactivate a custom category', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Temp', 'shop');
    expect((await put(s.app, `/categories/${c.id}`, { active: false })).body.item.active).toBe(false);
    expect((await put(s.app, `/categories/${c.id}`, { active: true })).body.item.active).toBe(true);
  });

  it('default categories: name and book are locked (409 DEFAULT_CATEGORY_LOCKED) but they can be deactivated and reactivated', async () => {
    const s = await setup();
    const def = (await get(s.app, '/categories')).body.items.find((c: any) => c.name === 'Perfume');
    expect(def.isDefault).toBe(true);
    for (const body of [{ name: 'Perfumes' }, { name: 'PERFUME' }, { book: 'telecom' }]) {
      const r = await put(s.app, `/categories/${def.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.error.code).toBe('DEFAULT_CATEGORY_LOCKED');
    }
    expect((await put(s.app, `/categories/${def.id}`, { active: false })).body.item.active).toBe(false);
    expect((await put(s.app, `/categories/${def.id}`, { active: true })).body.item.active).toBe(true);
  });

  it('an inactive category is refused for new products (CATEGORY_INACTIVE) and by newCategory-less create', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Retired', 'shop');
    await put(s.app, `/categories/${c.id}`, { active: false });
    const r = await post(s.app, '/products', prodBody({ categoryId: c.id }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CATEGORY_INACTIVE');
    expect(count(s.ctx, 'products')).toBe(0);
  });

  it('a category can never be deleted: raw SQL DELETE fails with CATEGORY_DELETE_FORBIDDEN (empty, with products, default)', async () => {
    const s = await setup();
    const empty = await mkCat(s, 'Empty', 'shop');
    const used = await mkCat(s, 'Used', 'telecom');
    await mkProduct(s, { categoryId: used.id });
    const def = (await get(s.app, '/categories')).body.items[0];
    for (const id of [empty.id, used.id, def.id]) {
      expect(() => sql(s, 'DELETE FROM categories WHERE id = ?', id), String(id)).toThrow(/CATEGORY_DELETE_FORBIDDEN/);
    }
    expect(count(s.ctx, 'categories')).toBe(14);
  });

  it('the database itself refuses a duplicate (book, name) and allows the same name in the other book', async () => {
    const s = await setup();
    await mkCat(s, 'Dbl', 'shop');
    expect(() => sql(s, "INSERT INTO categories (name, book) VALUES ('DBL', 'shop')")).toThrow(/UNIQUE/);
    sql(s, "INSERT INTO categories (name, book) VALUES ('DBL', 'telecom')");
  });
});

describe('categories: changing the book', () => {
  it('refused when the category has products (409 CATEGORY_HAS_PRODUCTS)', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Has', 'shop');
    await mkProduct(s, { categoryId: c.id });
    const r = await put(s.app, `/categories/${c.id}`, { book: 'telecom' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CATEGORY_HAS_PRODUCTS');
    expect((await get(s.app, '/categories')).body.items.find((x: any) => x.id === c.id).book).toBe('shop');
  });

  it('refused for a default category (409 DEFAULT_CATEGORY_LOCKED)', async () => {
    const s = await setup();
    const def = (await get(s.app, '/categories')).body.items.find((c: any) => c.name === 'Other');
    const r = await put(s.app, `/categories/${def.id}`, { book: 'telecom' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DEFAULT_CATEGORY_LOCKED');
  });

  it('allowed for an empty custom category, unless the name already exists in the target book', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Mover', 'shop');
    await mkCat(s, 'mover', 'telecom');
    const clash = await put(s.app, `/categories/${c.id}`, { book: 'telecom' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DUPLICATE_NAME');
    expect(clash.body.error.fields.name).toBe(TEL_DUP);
    const free = await mkCat(s, 'Free', 'shop');
    const ok = await put(s.app, `/categories/${free.id}`, { book: 'telecom' });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ name: 'Free', book: 'telecom' });
    // rename + move in one request: the NEW name is checked in the NEW book
    const both = await put(s.app, `/categories/${c.id}`, { book: 'telecom', name: 'Mover 2' });
    expect(both.status).toBe(200);
    expect(both.body.item).toMatchObject({ name: 'Mover 2', book: 'telecom' });
  });
});

describe('POST /products: categoryId or newCategory', () => {
  it('existing categoryId behaves as before (book comes from the category)', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Existing', 'telecom');
    const r = await post(s.app, '/products', prodBody({ categoryId: c.id }));
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ categoryId: c.id, categoryName: 'Existing', book: 'telecom', kind: 'stock' });
    expect(auditRows(s.ctx, 'category')).toHaveLength(1); // only the category's own create
  });

  it('newCategory in Shop and in Telecom creates category and product atomically with the right book, plus both audit rows', async () => {
    const s = await setup();
    const before = count(s.ctx, 'categories');
    const a = await post(s.app, '/products', prodBody({ name: 'Shop item', newCategory: { name: '  Fresh Shop  ', book: 'shop' } }));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.item).toMatchObject({ categoryName: 'Fresh Shop', book: 'shop' });
    const b = await post(s.app, '/products', prodBody({ name: 'Tel item', newCategory: { name: 'Fresh Tel', book: 'telecom' } }));
    expect(b.status).toBe(201);
    expect(b.body.item).toMatchObject({ categoryName: 'Fresh Tel', book: 'telecom' });
    expect(count(s.ctx, 'categories')).toBe(before + 2);
    const cats = (await get(s.app, '/categories')).body.items;
    expect(cats.find((c: any) => c.id === a.body.item.categoryId)).toMatchObject({ name: 'Fresh Shop', book: 'shop', isDefault: false, active: true, productCount: 1 });
    expect(cats.find((c: any) => c.id === b.body.item.categoryId)).toMatchObject({ name: 'Fresh Tel', book: 'telecom', productCount: 1 });
    const cAudit = auditRows(s.ctx, 'category');
    const pAudit = auditRows(s.ctx, 'product');
    expect(cAudit.map((r) => [r.action, r.entityId])).toEqual([['create', String(a.body.item.categoryId)], ['create', String(b.body.item.categoryId)]]);
    expect(cAudit[0]!.after).toMatchObject({ name: 'Fresh Shop', book: 'shop' });
    expect(pAudit.map((r) => r.entityId)).toEqual([String(a.body.item.id), String(b.body.item.id)]);
    expect(auditRows(s.ctx).map((r) => r.entity)).toEqual(['category', 'product', 'category', 'product']);
  });

  it('newCategory whose name exists in the same book and is active: 409 DUPLICATE_NAME with existingCategoryId; nothing written', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Taken', 'shop');
    const before = [count(s.ctx, 'categories'), count(s.ctx, 'products'), count(s.ctx, 'audit_logs')];
    const r = await post(s.app, '/products', prodBody({ newCategory: { name: 'TAKEN', book: 'shop' } }));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DUPLICATE_NAME', existingCategoryId: c.id });
    expect(r.body.error.fields.name).toBe(SHOP_DUP);
    const def = (await get(s.app, '/categories')).body.items.find((x: any) => x.name === 'Electronics');
    const d = await post(s.app, '/products', prodBody({ newCategory: { name: 'electronics', book: 'shop' } }));
    expect(d.body.error).toMatchObject({ code: 'DUPLICATE_NAME', existingCategoryId: def.id });
    expect([count(s.ctx, 'categories'), count(s.ctx, 'products'), count(s.ctx, 'audit_logs')]).toEqual(before);
    // the same name in the OTHER book is a different category and is created
    const other = await post(s.app, '/products', prodBody({ newCategory: { name: 'Taken', book: 'telecom' } }));
    expect(other.status).toBe(201);
    expect(other.body.item.book).toBe('telecom');
  });

  it('newCategory whose name matches an INACTIVE category: 409 CATEGORY_INACTIVE (reactivate first) with existingCategoryId', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Old', 'shop');
    await put(s.app, `/categories/${c.id}`, { active: false });
    const r = await post(s.app, '/products', prodBody({ newCategory: { name: 'old', book: 'shop' } }));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'CATEGORY_INACTIVE', existingCategoryId: c.id });
    expect(count(s.ctx, 'products')).toBe(0);
  });

  it('neither or both of categoryId / newCategory: 400 VALIDATION_ERROR on categoryId', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Some', 'shop');
    const none = await post(s.app, '/products', prodBody());
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');
    expect(none.body.error.fields.categoryId).toBeDefined();
    const both = await post(s.app, '/products', prodBody({ categoryId: c.id, newCategory: { name: 'Zed', book: 'shop' } }));
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe('VALIDATION_ERROR');
    expect(both.body.error.fields.categoryId).toBeDefined();
    expect(count(s.ctx, 'products')).toBe(0);
    expect(count(s.ctx, 'categories')).toBe(13);
  });

  it('invalid newCategory (blank name, bad book, extra key) is refused with 400', async () => {
    const s = await setup();
    for (const nc of [{ name: '   ', book: 'shop' }, { name: 'x', book: 'icecream' }, { name: 'x' }, { name: 'x', book: 'shop', active: false }]) {
      const r = await post(s.app, '/products', prodBody({ newCategory: nc }));
      expect(r.status, JSON.stringify(nc)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(count(s.ctx, 'categories')).toBe(12);
  });

  it('rolls back: a product that fails (duplicate name) leaves no new category and no audit rows behind', async () => {
    const s = await setup();
    await mkProduct(s, { name: 'Same name' });
    const before = [count(s.ctx, 'categories'), count(s.ctx, 'products'), count(s.ctx, 'audit_logs')];
    const r = await post(s.app, '/products', prodBody({ name: 'SAME NAME', newCategory: { name: 'Brand new', book: 'telecom' } }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_NAME');
    expect([count(s.ctx, 'categories'), count(s.ctx, 'products'), count(s.ctx, 'audit_logs')]).toEqual(before);
    expect((await get(s.app, '/categories')).body.items.some((c: any) => c.name === 'Brand new')).toBe(false);
    // a duplicate CODE rolls back too
    await mkProduct(s, { name: 'Coded', code: 'ABC' });
    const r2 = await post(s.app, '/products', prodBody({ name: 'Other', code: 'abc', newCategory: { name: 'Brand new', book: 'shop' } }));
    expect(r2.body.error.code).toBe('DUPLICATE_CODE');
    expect((await get(s.app, '/categories')).body.items.some((c: any) => c.name === 'Brand new')).toBe(false);
  });
});

describe('GET /products?kind=', () => {
  it('filters stock / service and combines with the existing filters', async () => {
    const s = await setup();
    const c = await mkCat(s, 'Mixed', 'shop');
    await mkProduct(s, { name: 'Stock A', categoryId: c.id });
    await mkProduct(s, { name: 'Service A', categoryId: c.id, kind: 'service', reorderLevel: 0 });
    const names = async (qs: string) => (await get(s.app, `/products?${qs}`)).body.items.map((p: any) => p.name);
    expect(await names('kind=stock')).toEqual(['Stock A']);
    expect(await names('kind=service')).toEqual(['Service A']);
    expect(await names(`categoryId=${c.id}`)).toEqual(['Service A', 'Stock A']);
    expect(await names(`categoryId=${c.id}&kind=stock&active=true`)).toEqual(['Stock A']);
    expect((await get(s.app, '/products?kind=stock')).body.total).toBe(1);
    expect((await get(s.app, '/products?kind=bogus')).status).toBe(400);
  });
});

describe('opening stock preview rows', () => {
  it('rows carry categoryName and book (null when no product matched); the import is unchanged', async () => {
    const s = await setup();
    const shopCat = await mkCat(s, 'Preview Shop', 'shop');
    const telCat = await mkCat(s, 'Preview Tel', 'telecom');
    const a = await mkProduct(s, { name: 'PA', code: 'PA1', categoryId: shopCat.id });
    const b = await mkProduct(s, { name: 'PB', code: 'PB1', categoryId: telCat.id });
    const file = await xlsx([['PA1', 'PA', 5, 10], ['PB1', 'PB', 2, 20], ['NOPE', 'Ghost', 1, 1]]);
    const r = await previewFile(s, file);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.rows;
    expect(rows[0]).toMatchObject({ sku: 'PA1', productId: a.id, categoryName: 'Preview Shop', book: 'shop', status: 'ok' });
    expect(rows[1]).toMatchObject({ sku: 'PB1', productId: b.id, categoryName: 'Preview Tel', book: 'telecom', status: 'ok' });
    expect(rows[2]).toMatchObject({ sku: 'NOPE', productId: null, categoryName: null, book: null, status: 'error' });
    expect(rows[0].issueColumns).toBeUndefined();
    expect(count(s.ctx, 'stock_movements')).toBe(0); // a preview writes no stock

    const ok = await xlsx([['PA1', 'PA', 5, 10], ['PB1', 'PB', 2, 20]]);
    const imp = await importFile(s, ok);
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const prods = (await get(s.app, '/products')).body.items;
    expect(prods.find((p: any) => p.id === a.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 5000 });
    expect(prods.find((p: any) => p.id === b.id)).toMatchObject({ qtyOnHand: 2, stockValueCents: 4000 });
  });
});
