// Telecom segments, package D (catalog and products, BUSINESS_RULES 13D): a Telecom stock product needs a provider category, products carry
// their Cards segment and provider, the list filters, the segment lock on a category move and the Excel opening-stock preview columns.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post, put } from './helpers/catalog.ts';
import { apiBase, cardProduct, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { makeProviderCategory, providerIdByName } from './helpers/segments.ts';
import { HEADERS, validateRows } from '../services/excel-opening-stock.ts';
import type { ParsedRow, ProductRef } from '../services/excel-opening-stock.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const err = (r: { body: any }): any => r.body.error;
const body = (categoryId: number | undefined, name: string, over: Record<string, unknown> = {}) =>
  ({ name, categoryId, kind: 'stock', sellPriceCents: 5000, minPriceCents: 4000, ...over });
const FRIENDLY = 'Choose a Telecom category that is linked to a provider (Dialog, Mobitel, Airtel or Hutch) first.';
const n = (s: ApiBase, sql: string): number => Number((s.ctx.database.conn.prepare(sql).get() as { n: number | bigint }).n);
const addMovement = (s: ApiBase, productId: number): void => {
  s.ctx.database.conn.prepare(
    "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason) VALUES (?, '2025-01-01', 'opening', 3, 300, 100, 'seed')",
  ).run(productId);
};
const svc = { kind: 'service', reorderLevel: 0, minPriceCents: 0 };

describe('PRODUCT_NEEDS_PROVIDER (answered by the service, friendly message)', () => {
  it('a Telecom STOCK product in a provider-less category is refused 400 with the friendly text; nothing is written', async () => {
    const s = await setup();
    const loose = (await post(s.app, '/categories', { name: 'Loose cards', book: 'telecom' })).body.item;
    const r = await post(s.app, '/products', body(loose.id, 'Card 50'));
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'PRODUCT_NEEDS_PROVIDER', message: FRIENDLY, fields: { categoryId: FRIENDLY } });
    expect(n(s, 'SELECT COUNT(*) AS n FROM products')).toBe(0);
    expect(n(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'product'")).toBe(0);
  });

  it('the default Scratch Cards category needs a provider too; once linked it accepts stock products', async () => {
    const s = await setup();
    const scratch = s.ids['Scratch Cards']!;
    expect(err(await post(s.app, '/products', body(scratch, 'Card')))).toMatchObject({ code: 'PRODUCT_NEEDS_PROVIDER' });
    const dialog = (await providerIdByName(s.app)).Dialog;
    expect((await put(s.app, `/categories/${scratch}`, { providerId: dialog })).status).toBe(200);
    const ok = await post(s.app, '/products', body(scratch, 'Card'));
    expect(ok.status).toBe(201);
    expect(ok.body.item).toMatchObject({ segment: 'dialog_cards', providerName: 'Dialog' });
  });

  it('services (Telecom, provider-less category) and Shop products are unaffected; such a service is legacy-segment, a Shop product has none', async () => {
    const s = await setup();
    const loose = (await post(s.app, '/categories', { name: 'Loose', book: 'telecom' })).body.item;
    const a = await post(s.app, '/products', body(loose.id, 'Service', svc));
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ segment: 'legacy', providerId: null, providerName: null });
    const shop = await post(s.app, '/products', body(s.ids['Other'], 'Shop item'));
    expect(shop.status).toBe(201);
    expect(shop.body.item).toMatchObject({ book: 'shop', segment: null, providerId: null, providerName: null });
  });

  it('newCategory: a Telecom stock product needs providerId; with it category and product are created together; a Shop newCategory refuses a provider', async () => {
    const s = await setup();
    const before = n(s, 'SELECT COUNT(*) AS n FROM categories');
    const noProv = await post(s.app, '/products', { ...body(undefined, 'Card'), newCategory: { name: 'Fresh', book: 'telecom' } });
    expect(noProv.status).toBe(400);
    expect(err(noProv)).toMatchObject({ code: 'PRODUCT_NEEDS_PROVIDER', message: FRIENDLY });
    expect(n(s, 'SELECT COUNT(*) AS n FROM categories')).toBe(before); // the failed request left no category behind
    const hutch = (await providerIdByName(s.app)).Hutch;
    const ok = await post(s.app, '/products', { ...body(undefined, 'Card'), newCategory: { name: 'Fresh', book: 'telecom', providerId: hutch } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.item).toMatchObject({ categoryName: 'Fresh', segment: 'hutch_cards', providerName: 'Hutch', providerId: hutch });
    expect(n(s, 'SELECT COUNT(*) AS n FROM categories')).toBe(before + 1);
    const shop = await post(s.app, '/products', { ...body(undefined, 'Thing'), newCategory: { name: 'Shop fresh', book: 'shop', providerId: hutch } });
    expect(shop.status).toBe(400);
    expect(err(shop).code).toBe('CATEGORY_PROVIDER_NOT_ALLOWED');
    const service = await post(s.app, '/products', { ...body(undefined, 'Svc', svc), newCategory: { name: 'Tel svc', book: 'telecom' } });
    expect(service.status).toBe(201); // a service needs no provider
  });
});

describe('segment and providerName in responses and filters', () => {
  it('every provider category gives its products <provider>_cards; item, list and GET :id agree', async () => {
    const s = await setup();
    const made: Record<string, any> = {};
    for (const prov of ['Dialog', 'Mobitel', 'Airtel', 'Hutch'] as const) made[prov] = await cardProduct(s, { provider: prov, name: `${prov} 100` });
    for (const prov of Object.keys(made)) {
      expect(made[prov]).toMatchObject({ segment: `${prov.toLowerCase()}_cards`, providerName: prov });
      const one = (await get(s.app, `/products/${made[prov].id}`)).body.item;
      expect(one).toMatchObject({ segment: `${prov.toLowerCase()}_cards`, providerName: prov });
    }
    const list = (await get(s.app, '/products?book=telecom')).body.items as any[];
    expect(list.map((p) => [p.name, p.segment]).sort()).toEqual(
      [['Airtel 100', 'airtel_cards'], ['Dialog 100', 'dialog_cards'], ['Hutch 100', 'hutch_cards'], ['Mobitel 100', 'mobitel_cards']]);
  });

  it('?segment= and ?providerId= filter list and total; legacy is a filter value; a bad segment is a 400', async () => {
    const s = await setup();
    await cardProduct(s, { provider: 'Dialog', name: 'D1' });
    await cardProduct(s, { provider: 'Dialog', name: 'D2' });
    await cardProduct(s, { provider: 'Airtel', name: 'A1' });
    await mkProduct(s, { categoryId: s.ids['Other'], name: 'Shop one' });
    const loose = (await post(s.app, '/categories', { name: 'Loose', book: 'telecom' })).body.item;
    await post(s.app, '/products', body(loose.id, 'Old service', svc));
    const names = (r: { body: any }): string[] => r.body.items.map((p: any) => p.name);
    const dialog = await get(s.app, '/products?segment=dialog_cards');
    expect(names(dialog)).toEqual(['D1', 'D2']);
    expect(dialog.body.total).toBe(2);
    expect(names(await get(s.app, '/products?segment=airtel_cards'))).toEqual(['A1']);
    expect(names(await get(s.app, '/products?segment=hutch_cards'))).toEqual([]);
    expect(names(await get(s.app, '/products?segment=legacy'))).toEqual(['Old service']);
    const ids = await providerIdByName(s.app);
    expect(names(await get(s.app, `/products?providerId=${ids.Dialog}`))).toEqual(['D1', 'D2']);
    expect(names(await get(s.app, `/products?providerId=${ids.Airtel}&segment=airtel_cards`))).toEqual(['A1']);
    expect(names(await get(s.app, `/products?providerId=${ids.Airtel}&segment=dialog_cards`))).toEqual([]);
    expect((await get(s.app, '/products?segment=nonsense')).status).toBe(400);
  });
});

describe('provider and segment locks through the API', () => {
  it('a category provider is settable while it has no products and locked after (CATEGORY_PROVIDER_LOCKED)', async () => {
    const s = await setup();
    const cat = (await post(s.app, '/categories', { name: 'Late', book: 'telecom' })).body.item;
    const ids = await providerIdByName(s.app);
    expect((await put(s.app, `/categories/${cat.id}`, { providerId: ids.Mobitel })).body.item).toMatchObject({ providerName: 'Mobitel' });
    expect((await post(s.app, '/products', body(cat.id, 'M50'))).status).toBe(201);
    const locked = await put(s.app, `/categories/${cat.id}`, { providerId: ids.Hutch });
    expect(locked.status).toBe(409);
    expect(err(locked).code).toBe('CATEGORY_PROVIDER_LOCKED');
  });

  it('moving a stock product to another provider: allowed before stock movements, PRODUCT_SEGMENT_LOCKED (409, friendly) after; same provider always', async () => {
    const s = await setup();
    const dialogA = await makeProviderCategory(s.app, 'Dialog');
    const dialogB = await makeProviderCategory(s.app, 'Dialog', 'Dialog Extra');
    const airtel = await makeProviderCategory(s.app, 'Airtel');
    const p = await mkProduct(s, { categoryId: dialogA.id });
    const fresh = await mkProduct(s, { categoryId: dialogA.id });
    expect((await put(s.app, `/products/${fresh.id}`, { categoryId: airtel.id })).body.item).toMatchObject({ segment: 'airtel_cards', providerName: 'Airtel' });
    addMovement(s, p.id);
    const locked = await put(s.app, `/products/${p.id}`, { categoryId: airtel.id });
    expect(locked.status).toBe(409);
    expect(err(locked)).toMatchObject({ code: 'PRODUCT_SEGMENT_LOCKED', fields: { categoryId: 'Choose a category of the same provider.' } });
    expect(err(locked).message).toContain('Dialog Cards');
    expect((await get(s.app, `/products/${p.id}`)).body.item.categoryId).toBe(dialogA.id); // nothing changed
    expect((await put(s.app, `/products/${p.id}`, { categoryId: dialogB.id })).status).toBe(200);
  });

  it('a stock product cannot move into a provider-less Telecom category (it would become legacy): PRODUCT_NEEDS_PROVIDER; a Shop move is still the book mismatch', async () => {
    const s = await setup();
    const loose = (await post(s.app, '/categories', { name: 'Loose', book: 'telecom' })).body.item;
    const p = await cardProduct(s, { provider: 'Dialog' });
    const r = await put(s.app, `/products/${p.id}`, { categoryId: loose.id });
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'PRODUCT_NEEDS_PROVIDER', message: FRIENDLY });
    expect(err(await put(s.app, `/products/${p.id}`, { categoryId: s.ids['Other'] })).code).toBe('CATEGORY_BOOK_MISMATCH');
  });
});

describe('Excel opening-stock preview: provider and segment per row', () => {
  const row = (rowNo: number, sku: string): ParsedRow =>
    ({ rowNo, sku, productNameInFile: '', qty: 5, unitCostCents: 100, totalValueCents: null, notes: '', issues: [] });
  const prods: Record<string, ProductRef> = {
    D1: { id: 1, name: 'Dialog 100', active: true, kind: 'stock', categoryName: 'Dialog Cards', book: 'telecom', segment: 'dialog_cards', providerName: 'Dialog' },
    OLD: { id: 2, name: 'Old card', active: true, kind: 'stock', categoryName: 'Loose', book: 'telecom', segment: 'legacy', providerName: null },
    SH: { id: 3, name: 'Pen', active: true, kind: 'stock', categoryName: 'Other', book: 'shop', segment: null, providerName: null },
  };
  const lookup = (sku: string): ProductRef | undefined => prods[sku.toUpperCase()];

  it('rows carry segment and providerName; Shop rows have none; unmatched rows have null', () => {
    const rows = validateRows([row(2, 'D1'), row(3, 'SH'), row(4, 'NOPE')], lookup, false);
    expect(rows[0]).toMatchObject({ status: 'ok', book: 'telecom', segment: 'dialog_cards', providerName: 'Dialog' });
    expect(rows[1]).toMatchObject({ status: 'ok', book: 'shop', segment: null, providerName: null });
    expect(rows[2]).toMatchObject({ status: 'error', segment: null, providerName: null });
  });

  it('a legacy (provider-less) Telecom product is refused with a clear message on the SKU cell', () => {
    const [r] = validateRows([row(2, 'OLD')], lookup, false);
    expect(r!.status).toBe('error');
    expect(r!.issues[0]).toMatchObject({ code: 'LEGACY_PRODUCT' });
    expect(r!.issues[0]!.message).toContain('without a provider');
    expect(r!.issues[0]!.message).toContain('Dialog, Mobitel, Airtel or Hutch');
    expect(r!.issueColumns).toEqual([HEADERS.sku]);
    expect(r!.segment).toBe('legacy');
  });
});
