// Telecom segments, package B (core): the shared segment module, the compat rule, reversal posting, the category provider API and the mapping of
// every segment trigger abort to an API error (BUSINESS_RULES 13D). Pure and API-level; no Telecom / sales / purchase service is involved.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post, put } from './helpers/catalog.ts';
import { apiBase, cardProduct, daysAgo, mkProduct, sqlCardProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { capVoid } from './helpers/phase8.ts';
import { seg } from './helpers/seg.ts';
import { makeProviderCategory, providerIdByName } from './helpers/segments.ts';
import { AppError } from '../lib/errors.ts';
import { getCashEntry, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import { closedDayProbe, getClosingByDay, insertClosing, isDayClosed } from '../repositories/daily-closings.repo.ts';
import { postCash, reverseCash } from '../services/cash-posting.ts';
import { negativeCashWarnings } from '../services/cash-warnings.ts';
import { assertDayNotClosed, assertDayOpen, mapCashAbort } from '../services/day-closing.ts';
import {
  SEGMENT_LABEL, TELECOM_SEGMENTS, isCardsSegment, mapSegmentAbort, mixedSegmentsError, resolveEntrySegment, scopeKey, scopeLabel, scopesOf,
  segmentForProvider, segmentOfProduct,
} from '../services/segments.ts';
import { runWrite } from '../services/stock-common.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const err = (r: { body: any }): any => r.body.error;
const D2 = daysAgo(2);

/** The AppError a function throws (fails the test when nothing or another error is thrown). */
function appErr(fn: () => unknown): AppError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(AppError); return e as AppError; }
  throw new Error('expected an AppError');
}

describe('segments.ts: codes, labels, scopes and the entry rule', () => {
  it('eight segments in display order, a label for each (plus legacy), cards vs reloads', () => {
    expect(TELECOM_SEGMENTS).toEqual(['dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads']);
    expect(TELECOM_SEGMENTS.map((x) => SEGMENT_LABEL[x])).toEqual(['Dialog Cards', 'Dialog Reloads', 'Mobitel Cards', 'Mobitel Reloads', 'Airtel Cards', 'Airtel Reloads', 'Hutch Cards', 'Hutch Reloads']);
    expect(SEGMENT_LABEL.legacy).toBe('Telecom before segments');
    expect(TELECOM_SEGMENTS.filter(isCardsSegment)).toEqual(['dialog_cards', 'mobitel_cards', 'airtel_cards', 'hutch_cards']);
  });

  it('scopeKey / scopeLabel / scopesOf: distinct, sorted shop -> telecom (display order, legacy last) -> icecream', () => {
    expect(scopeKey({ book: 'shop', segment: null })).toBe('shop');
    expect(scopeKey({ book: 'telecom', segment: 'hutch_cards' })).toBe('telecom:hutch_cards');
    expect(scopeLabel({ book: 'telecom', segment: 'dialog_reloads' })).toBe('Telecom - Dialog Reloads');
    expect(scopeLabel({ book: 'telecom', segment: 'legacy' })).toBe('Telecom - Telecom before segments');
    expect(scopeLabel({ book: 'shop', segment: null })).toBe('Shop');
    const out = scopesOf([
      'icecream', { book: 'telecom', segment: 'legacy' }, { book: 'telecom', segment: 'hutch_cards' }, 'shop',
      { book: 'telecom', segment: 'dialog_reloads' }, { book: 'telecom', segment: 'hutch_cards' }, 'shop',
    ]);
    expect(out.map(scopeKey)).toEqual(['shop', 'telecom:dialog_reloads', 'telecom:hutch_cards', 'telecom:legacy', 'icecream']);
  });

  it('segmentForProvider: provider + kind; unknown provider is a bug (plain Error)', () => {
    expect(segmentForProvider({ name: 'Dialog' }, 'reloads')).toBe('dialog_reloads');
    expect(segmentForProvider({ name: 'Hutch' }, 'cards')).toBe('hutch_cards');
    expect(segmentForProvider({ name: 'Airtel' }, 'cards')).toBe('airtel_cards');
    expect(() => segmentForProvider({ name: 'Etisalat' }, 'cards')).toThrow(/Unknown Telecom provider/);
  });

  it('resolveEntrySegment: Telecom requires one of the eight, other books forbid one, legacy only on request', () => {
    expect(resolveEntrySegment('telecom', 'mobitel_cards')).toBe('mobitel_cards');
    expect(resolveEntrySegment('shop', undefined)).toBeNull();
    expect(resolveEntrySegment('icecream', null)).toBeNull();
    expect(appErr(() => resolveEntrySegment('telecom', undefined))).toMatchObject({ statusCode: 400, code: 'SEGMENT_REQUIRED', fields: { segment: 'Choose a segment.' } });
    expect(appErr(() => resolveEntrySegment('telecom', 'dialog'))).toMatchObject({ code: 'SEGMENT_REQUIRED' });
    expect(appErr(() => resolveEntrySegment('shop', 'dialog_cards'))).toMatchObject({ statusCode: 400, code: 'SEGMENT_NOT_ALLOWED' });
    expect(appErr(() => resolveEntrySegment('telecom', 'legacy'))).toMatchObject({ statusCode: 409, code: 'SEGMENT_LEGACY_REFUSED' });
    expect(resolveEntrySegment('telecom', 'legacy', { allowLegacy: true })).toBe('legacy');
    expect(appErr(() => resolveEntrySegment('shop', 'x', { field: 'fromSegment' })).fields).toEqual({ fromSegment: 'Segments exist only for the Telecom book.' });
    expect(mixedSegmentsError()).toMatchObject({ statusCode: 400, code: 'MIXED_SEGMENTS' });
  });

  it('segmentOfProduct: provider + _cards for a card product, legacy for a provider-less Telecom service, null for Shop and unknown ids', async () => {
    const s = await setup();
    const mob = await cardProduct(s, { provider: 'Mobitel' });
    const conn = s.ctx.database.conn;
    expect(segmentOfProduct(conn, mob.id)).toBe('mobitel_cards');
    expect(segmentOfProduct(conn, (await mkProduct(s)).id)).toBeNull();
    expect(segmentOfProduct(conn, 999999)).toBeNull();
    const old = (await post(s.app, '/categories', { name: 'Old cards', book: 'telecom' })).body.item;
    const svc = await mkProduct(s, { categoryId: old.id, kind: 'service', reorderLevel: 0 });
    expect(segmentOfProduct(conn, svc.id)).toBe('legacy');
    expect(segmentOfProduct(conn, sqlCardProduct(conn, 'Hutch'))).toBe('hutch_cards');
  });
});

describe('compat rule: a bare Telecom book on a one-scope signature is TELECOM_SEGMENT_REQUIRED', () => {
  it('assertDayOpen / assertDayNotClosed / probes / closings / warnings / scopesOf all throw it for a bare telecom (and for a Telecom scope without a segment)', async () => {
    const s = await setup();
    const c = s.ctx.database.conn;
    const bare = (fn: () => unknown) => expect(appErr(fn), 'bare telecom').toMatchObject({ statusCode: 400, code: 'TELECOM_SEGMENT_REQUIRED' });
    bare(() => assertDayOpen(c, ['telecom'], D2));
    bare(() => assertDayOpen(c, ['shop', 'telecom'], D2));
    bare(() => assertDayNotClosed(c, ['telecom'], D2));
    bare(() => assertDayOpen(c, [{ book: 'telecom', segment: null }], D2));
    bare(() => closedDayProbe(c, 'telecom', D2));
    bare(() => isDayClosed(c, 'telecom', D2));
    bare(() => getClosingByDay(c, 'telecom', D2));
    bare(() => negativeCashWarnings(c, ['telecom']));
    bare(() => scopesOf(['telecom']));
    bare(() => insertClosing(c, { scope: { book: 'telecom', segment: null }, businessDate: D2, expectedCents: 0, countedCents: null, overShortCents: 0, cashCountId: null }));
    bare(() => insertCashEntry(c, { book: 'telecom', businessDate: D2, type: 'cash_adjustment', amountCents: 1, refTable: null, refId: null }));
    bare(() => postCash(c, { book: 'telecom', fund: null, businessDate: D2, type: 'cash_adjustment', amountCents: 1, refTable: 'x', refId: 1, fundKind: 'cash_over_short' }));
    // the other books keep the old book-only form
    expect(() => assertDayOpen(c, ['shop', 'icecream'], D2)).not.toThrow();
    expect(negativeCashWarnings(c, ['shop', 'icecream'])).toEqual([]);
    expect(closedDayProbe(c, 'shop', D2)).toEqual({ latest: null, onDay: false });
    // reads of the Telecom TOTAL stay available (they have a meaning)
    expect(seg.total(s)).toBe(0);
    expect(c.prepare('SELECT COUNT(*) AS n FROM cash_entries').get()).toEqual({ n: 0 });
  });

  it('a bare Telecom request through an un-updated service ends as the 400 API error, never a 500', async () => {
    const s = await setup();
    // POST /cash-transfers is owned by package G; until it passes scopes, the compat rule answers 400 (here a Shop -> Telecom transfer, no segments)
    const r = await post(s.app, '/cash-transfers', { businessDate: D2, fromBook: 'shop', toBook: 'telecom', amountCents: 100, clientRef: `ref-${Date.now()}-a` });
    expect([400, 201]).toContain(r.status); // 201 once package G reads the segments, 400 (TELECOM_SEGMENT_REQUIRED / SEGMENT_REQUIRED) until then
    if (r.status === 400) expect(['TELECOM_SEGMENT_REQUIRED', 'SEGMENT_REQUIRED', 'VALIDATION_ERROR']).toContain(err(r).code);
  });
});

describe('postCash / reverseCash keep the segment', () => {
  it('postCash writes the segment; reverseCash copies the ORIGINAL segment (also for Shop: null) and stays in the same day', async () => {
    const s = await setup();
    const c = s.ctx.database.conn;
    const id = postCash(c, { book: 'telecom', fund: null, segment: 'airtel_cards', businessDate: D2, type: 'cash_adjustment', amountCents: 700, refTable: 'cash_counts', refId: 1, fundKind: 'cash_over_short' });
    const orig = getCashEntry(c, id)!;
    expect(orig).toMatchObject({ book: 'telecom', segment: 'airtel_cards', amountCents: 700 });
    const rev = getCashEntry(c, reverseCash(c, orig, 'void'))!;
    expect(rev).toMatchObject({ book: 'telecom', segment: 'airtel_cards', amountCents: -700, businessDate: D2, reversesEntryId: id, type: 'cash_adjustment' });
    expect(() => reverseCash(c, orig, 'again')).toThrow(/already reversed/);
    const shop = getCashEntry(c, postCash(c, { book: 'shop', fund: null, businessDate: D2, type: 'cash_adjustment', amountCents: 5, refTable: 'cash_counts', refId: 2, fundKind: 'cash_over_short' }))!;
    expect(shop.segment).toBeNull();
    expect(getCashEntry(c, reverseCash(c, shop, 'void'))!.segment).toBeNull();
    expect(seg.balance(s, 'airtel_cards')).toBe(0);
  });

  it('voiding a capital entry, an opening balance and a count reverses each in ITS segment (API level)', async () => {
    const s = await setup();
    const open = await seg.open(s, 'hutch_cards', 5000, { businessDate: D2 });
    const cap = await seg.capital(s, 'mobitel_reloads', 300, { businessDate: D2 });
    expect((await capVoid(s, open.body.item.id)).status).toBe(200);
    expect((await capVoid(s, cap.body.item.id)).status).toBe(200);
    for (const [segment, amount] of [['hutch_cards', 5000], ['mobitel_reloads', 300]] as const) {
      const rows = seg.rows(s, segment);
      expect(rows.map((r) => [r.amount_cents, r.segment])).toEqual([[amount, segment], [-amount, segment]]);
      expect(rows[1]!.reverses_entry_id).toBe(rows[0]!.id);
      expect(seg.balance(s, segment)).toBe(0);
    }
    expect(seg.total(s)).toBe(0);
    expect(seg.sumOfSegments(s)).toBe(0);
  });
});

describe('every segment trigger abort is an API error, never a 500', () => {
  const RAW: Array<[code: string, status: number]> = [
    ['SEGMENT_REQUIRED', 400], ['SEGMENT_NOT_ALLOWED', 400], ['SEGMENT_LEGACY_REFUSED', 409], ['SEGMENT_READ_ONLY', 409], ['SEGMENT_MISMATCH', 400],
    ['REVERSAL_MISMATCH', 409], ['TRANSFER_LEG_MISMATCH', 409], ['CATEGORY_PROVIDER_NOT_ALLOWED', 400], ['CATEGORY_PROVIDER_LOCKED', 409],
    ['PRODUCT_NEEDS_PROVIDER', 400], ['PRODUCT_SEGMENT_LOCKED', 409],
  ];
  it.each(RAW)('%s -> AppError %i through mapSegmentAbort and through mapCashAbort', (code, status) => {
    for (const map of [mapSegmentAbort, mapCashAbort]) {
      const e = appErr(() => map(new Error(code)));
      expect(e.code).toBe(code);
      expect(e.statusCode).toBe(status);
      expect(e.message.length).toBeGreaterThan(10);
    }
    expect(() => mapSegmentAbort(new Error('SOMETHING_ELSE'))).not.toThrow(); // other errors pass through untouched
  });

  it('real trigger aborts of migrations 024-026, raised inside runWrite, come out as the mapped AppError', async () => {
    const s = await setup();
    const c = s.ctx.database.conn;
    const shopCat = Number((c.prepare("SELECT id FROM categories WHERE name = 'Other'").get() as { id: number | bigint }).id);
    const dialog = (await providerIdByName(s.app)).Dialog;
    const mobitel = (await providerIdByName(s.app)).Mobitel;
    const cap = Number(c.prepare("INSERT INTO capital_entries (business_date, book, segment, kind, amount_cents, client_ref) VALUES (?, 'telecom', 'dialog_reloads', 'capital', 100, 'rawcap-1') ").run(D2).lastInsertRowid);
    const orig = Number(c.prepare("INSERT INTO cash_entries (book, segment, business_date, type, amount_cents, ref_table, ref_id) VALUES ('telecom', 'dialog_reloads', ?, 'capital', 100, 'capital_entries', ?)").run(D2, cap).lastInsertRowid);
    const scratch = Number((c.prepare("SELECT id FROM categories WHERE name = 'Scratch Cards'").get() as { id: number | bigint }).id);
    const cases: Array<[string, string, number, string[]]> = [
      ['SEGMENT_REQUIRED', "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('telecom', '" + D2 + "', 'cash_adjustment', 1)", 400, []],
      ['SEGMENT_NOT_ALLOWED', "INSERT INTO cash_entries (book, segment, business_date, type, amount_cents) VALUES ('shop', 'dialog_cards', '" + D2 + "', 'cash_adjustment', 1)", 400, []],
      ['SEGMENT_LEGACY_REFUSED', "INSERT INTO cash_entries (book, segment, business_date, type, amount_cents) VALUES ('telecom', 'legacy', '" + D2 + "', 'cash_adjustment', 1)", 409, []],
      ['SEGMENT_MISMATCH', "INSERT INTO cash_entries (book, segment, business_date, type, amount_cents, ref_table, ref_id) VALUES ('telecom', 'mobitel_reloads', '" + D2 + "', 'capital', 5, 'capital_entries', " + cap + ')', 400, []],
      ['REVERSAL_MISMATCH', "INSERT INTO cash_entries (book, segment, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('telecom', 'mobitel_reloads', '" + D2 + "', 'capital', -100, 'capital_entries', " + cap + ', ' + orig + ')', 409, []],
      ['CATEGORY_PROVIDER_NOT_ALLOWED', 'UPDATE categories SET provider_id = ' + dialog + ' WHERE id = ' + shopCat, 400, []],
      ['PRODUCT_NEEDS_PROVIDER', "INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('needs-provider', " + scratch + ", 'stock', 'telecom', 1000, 100)", 400, []],
    ];
    for (const [code, statement, status] of cases) {
      const e = appErr(() => runWrite(s.ctx, (conn) => { conn.exec(statement); }));
      expect(e, code).toMatchObject({ code, statusCode: status });
    }
    // CATEGORY_PROVIDER_LOCKED: a category with products
    const withProducts = await makeProviderCategory(s.app, 'Dialog');
    await mkProduct(s, { categoryId: withProducts.id });
    const locked = appErr(() => runWrite(s.ctx, (conn) => { conn.exec('UPDATE categories SET provider_id = ' + mobitel + ' WHERE id = ' + withProducts.id); }));
    expect(locked).toMatchObject({ code: 'CATEGORY_PROVIDER_LOCKED', statusCode: 409 });
    // PRODUCT_SEGMENT_LOCKED: a product with stock history moved to another provider's category
    const product = sqlCardProduct(c, 'Airtel');
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason) VALUES (?, '2025-01-01', 'opening', 2, 200, 100, 'seed')").run(product);
    const hutchCat = (await makeProviderCategory(s.app, 'Hutch')).id;
    const moved = appErr(() => runWrite(s.ctx, (conn) => { conn.exec('UPDATE products SET category_id = ' + hutchCat + ' WHERE id = ' + product); }));
    expect(moved).toMatchObject({ code: 'PRODUCT_SEGMENT_LOCKED', statusCode: 409 });
    // the refusals wrote nothing
    expect(Number((c.prepare("SELECT COUNT(*) AS n FROM cash_entries WHERE business_date = ? AND amount_cents IN (1, 5, -100)").get(D2) as { n: number | bigint }).n)).toBe(0);
  });
});

describe('category provider API (13D): Telecom categories only, locked once the category has products', () => {
  it('create a Telecom category with a provider; the list returns providerId and providerName; Shop categories have null', async () => {
    const s = await setup();
    const ids = await providerIdByName(s.app);
    const r = await post(s.app, '/categories', { name: 'Mobitel Crds', book: 'telecom', providerId: ids.Mobitel });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ name: 'Mobitel Crds', book: 'telecom', providerId: ids.Mobitel, providerName: 'Mobitel', productCount: 0 });
    const noProvider = await post(s.app, '/categories', { name: 'Loose', book: 'telecom' });
    expect(noProvider.body.item).toMatchObject({ providerId: null, providerName: null });
    const list = (await get(s.app, '/categories')).body.items as any[];
    expect(list.find((c) => c.name === 'Other')).toMatchObject({ book: 'shop', providerId: null, providerName: null });
    expect(list.find((c) => c.name === 'Mobitel Crds')).toMatchObject({ providerName: 'Mobitel' });
    // null on create is the same as none
    expect((await post(s.app, '/categories', { name: 'Loose 2', book: 'telecom', providerId: null })).body.item.providerId).toBeNull();
  });

  it('a Shop category cannot have a provider (400 CATEGORY_PROVIDER_NOT_ALLOWED); an unknown provider is a field error', async () => {
    const s = await setup();
    const ids = await providerIdByName(s.app);
    const shop = await post(s.app, '/categories', { name: 'Gadgets', book: 'shop', providerId: ids.Dialog });
    expect(shop.status).toBe(400);
    expect(err(shop)).toMatchObject({ code: 'CATEGORY_PROVIDER_NOT_ALLOWED', fields: { providerId: 'Only Telecom categories have a provider.' } });
    const unknown = await post(s.app, '/categories', { name: 'Ghost', book: 'telecom', providerId: 9999 });
    expect(unknown.status).toBe(400);
    expect(err(unknown)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { providerId: 'Choose a provider.' } });
    expect((await post(s.app, '/categories', { name: 'Bad', book: 'telecom', providerId: 'dialog' })).status).toBe(400);
    expect((await post(s.app, '/categories', { name: 'Bad2', book: 'telecom', providerId: 0 })).status).toBe(400);
    const other = (await get(s.app, '/categories')).body.items.find((c: any) => c.name === 'Other');
    expect(err(await put(s.app, `/categories/${other.id}`, { providerId: ids.Dialog })).code).toBe('CATEGORY_PROVIDER_NOT_ALLOWED');
    expect((await get(s.app, '/categories')).body.items.some((c: any) => c.name === 'Gadgets' || c.name === 'Ghost')).toBe(false); // nothing created
  });

  it('the default "Scratch Cards" category may get a provider while it has no products; its name and book stay locked', async () => {
    const s = await setup();
    const ids = await providerIdByName(s.app);
    const r = await put(s.app, `/categories/${s.ids['Scratch Cards']}`, { providerId: ids.Hutch });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ name: 'Scratch Cards', isDefault: true, providerId: ids.Hutch, providerName: 'Hutch' });
    expect(err(await put(s.app, `/categories/${s.ids['Scratch Cards']}`, { name: 'Cards' })).code).toBe('DEFAULT_CATEGORY_LOCKED');
    // while it has no products the provider may still change or be cleared
    expect((await put(s.app, `/categories/${s.ids['Scratch Cards']}`, { providerId: ids.Dialog })).body.item.providerName).toBe('Dialog');
    expect((await put(s.app, `/categories/${s.ids['Scratch Cards']}`, { providerId: null })).body.item.providerId).toBeNull();
  });

  it('CATEGORY_PROVIDER_LOCKED: once a category has products its provider cannot change or be cleared (the same value is a no-op); audit records the change', async () => {
    const s = await setup();
    const ids = await providerIdByName(s.app);
    const cat = await makeProviderCategory(s.app, 'Dialog');
    expect((await put(s.app, `/categories/${cat.id}`, { providerId: ids.Mobitel })).status).toBe(200); // still empty
    await mkProduct(s, { categoryId: cat.id });
    for (const providerId of [ids.Dialog, null]) {
      const r = await put(s.app, `/categories/${cat.id}`, { providerId });
      expect(r.status).toBe(409);
      expect(err(r)).toMatchObject({ code: 'CATEGORY_PROVIDER_LOCKED', fields: { providerId: 'Locked: this category has products.' } });
    }
    const same = await put(s.app, `/categories/${cat.id}`, { providerId: ids.Mobitel }); // unchanged value: nothing to lock
    expect(same.status).toBe(200);
    expect(same.body.item).toMatchObject({ providerName: 'Mobitel', productCount: 1 });
    // other edits of a category with products still work
    expect((await put(s.app, `/categories/${cat.id}`, { name: 'Mobitel cards renamed' })).status).toBe(200);
    const updates = s.ctx.database.conn.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'category' AND action = 'update'").get() as { n: number | bigint };
    expect(Number(updates.n)).toBe(2); // the provider change while empty and the rename
  });

  it('moving a category to Shop clears its provider (empty categories only); a Shop category can become a Telecom one with a provider in the same edit', async () => {
    const s = await setup();
    const ids = await providerIdByName(s.app);
    const cat = (await post(s.app, '/categories', { name: 'Movable', book: 'telecom', providerId: ids.Airtel })).body.item;
    const moved = await put(s.app, `/categories/${cat.id}`, { book: 'shop' });
    expect(moved.status).toBe(200);
    expect(moved.body.item).toMatchObject({ book: 'shop', providerId: null, providerName: null });
    const back = await put(s.app, `/categories/${cat.id}`, { book: 'telecom', providerId: ids.Hutch });
    expect(back.body.item).toMatchObject({ book: 'telecom', providerName: 'Hutch' });
    // a category with products cannot change book at all (existing rule), whatever its provider
    await mkProduct(s, { categoryId: cat.id });
    expect(err(await put(s.app, `/categories/${cat.id}`, { book: 'shop' })).code).toBe('CATEGORY_HAS_PRODUCTS');
  });

  it('PRODUCT_NEEDS_PROVIDER: a new Telecom STOCK product needs a provider category (400 with the categoryId field); services and Shop are unaffected', async () => {
    const s = await setup();
    const loose = (await post(s.app, '/categories', { name: 'Loose cards', book: 'telecom' })).body.item;
    const r = await post(s.app, '/products', { name: 'Card 50', categoryId: loose.id, kind: 'stock', sellPriceCents: 5000, minPriceCents: 4000 });
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'PRODUCT_NEEDS_PROVIDER', fields: { categoryId: 'Choose a category linked to a provider.' } });
    expect(Number((s.ctx.database.conn.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number | bigint }).n)).toBe(0);
    expect((await post(s.app, '/products', { name: 'Service', categoryId: loose.id, kind: 'service', sellPriceCents: 5000, minPriceCents: 0, reorderLevel: 0 })).status).toBe(201);
    expect((await post(s.app, '/products', { name: 'Shop item', categoryId: s.ids['Other'], kind: 'stock', sellPriceCents: 5000, minPriceCents: 0 })).status).toBe(201);
    const good = await cardProduct(s, { provider: 'Hutch', name: 'Hutch 100' });
    expect(good).toMatchObject({ book: 'telecom', categoryName: 'Hutch Cards' });
  });

  it('PRODUCT_SEGMENT_LOCKED: a product with stock history cannot move to a category of another provider; the same provider and untouched products can', async () => {
    const s = await setup();
    const dialogA = await makeProviderCategory(s.app, 'Dialog');
    const dialogB = await makeProviderCategory(s.app, 'Dialog', 'Dialog Extra');
    const airtel = await makeProviderCategory(s.app, 'Airtel');
    const p = await mkProduct(s, { categoryId: dialogA.id });
    const fresh = await mkProduct(s, { categoryId: dialogA.id });
    s.ctx.database.conn.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason) VALUES (?, '2025-01-01', 'opening', 3, 300, 100, 'seed')").run(p.id);
    const locked = await put(s.app, `/products/${p.id}`, { categoryId: airtel.id });
    expect(locked.status).toBe(409);
    expect(err(locked)).toMatchObject({ code: 'PRODUCT_SEGMENT_LOCKED', fields: { categoryId: 'Choose a category of the same provider.' } });
    expect((await put(s.app, `/products/${p.id}`, { categoryId: dialogB.id })).status).toBe(200); // same provider: the segment is unchanged
    expect((await put(s.app, `/products/${fresh.id}`, { categoryId: airtel.id })).status).toBe(200); // no history: free to move
    expect(segmentOfProduct(s.ctx.database.conn, p.id)).toBe('dialog_cards');
    expect(segmentOfProduct(s.ctx.database.conn, fresh.id)).toBe('airtel_cards');
  });

  it('makeProviderCategory helper is idempotent and links an unlinked category of the same name', async () => {
    const s = await setup();
    const a = await makeProviderCategory(s.app, 'Mobitel');
    const b = await makeProviderCategory(s.app, 'Mobitel');
    expect(b.id).toBe(a.id);
    const loose = (await post(s.app, '/categories', { name: 'Hutch Cards', book: 'telecom' })).body.item;
    expect((await makeProviderCategory(s.app, 'Hutch')).id).toBe(loose.id);
    expect(seg.balance(s, 'mobitel_cards')).toBe(0);
  });
});
