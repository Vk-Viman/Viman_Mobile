// Sales API (POST /sales, GET /sales, GET /sales/:id) - API level (Fastify inject, real temp database).
// Protects BUSINESS_RULES: section 4 (a cart is split by product book into one sale per book, Shop first; lines keep cart order;
// quantity checked cumulatively per product), section 3 / C5 (stock leaves at the live weighted average, that value is the line's
// COGS snapshot), section 2 (cash types sale_goods for Shop and card_sale for Telecom, one entry per sale), R13 (low prices WARN
// and never block), R-FD (no future dates; backdating allowed and flagged, costing follows POSTING order), section 12
// (clientRef makes a double click harmless, every sale is audited with its business date) and atomicity (one transaction per cart).
// Organised as: create (shop, telecom, multi-line, mixed cart), stock rules, product rules, validation, R13 warnings, duplicate
// submission, dates, list + totals, get, audit, atomic rollback.
// All money is in cents; every expected figure has its hand calculation in the comment above the test.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post, put } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, mkTelecom, productOf, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, FUTURE_MSG, mvs, mvsByRef, num, poolOf, productsSnap, reconOk, sql } from './helpers/phase4.ts';
import {
  breakCash, cashBal, cashOfRef, cl, returnOk, rl, sellNew, sellOk, SALE_ITEM_KEYS, SALE_KEYS, snap5, stocked, stocked20, voidSaleNew,
} from './helpers/phase5.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
// Products with minimum price 0 so ordinary test prices never raise the R13 "below minimum" warning by accident.
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });
const ids = (rows: any[]) => rows.map((r) => r.id);

// =============================================================================================
// Creating sales: shop, telecom, several lines, mixed carts.
describe('POST /sales - create', () => {
  // Hand calculation: pool 20 / 700,000 (average 35,000). Sell 2 @ 100,000: revenue 200,000; COGS 700,000 x 2 / 20 = 70,000;
  // unit cost 35,000; profit 130,000; pool 18 / 630,000. One shop cash entry +200,000 (sale_goods), one movement -2 / -70,000.
  it('shop cash sale: 201, exact shape, sale_goods cash entry, one sale movement, pool at the average', async () => {
    const s = await setup();
    const P = await stocked20(s, shop0, { name: 'Charger', code: 'CH-1' });
    const r = await sellNew(s, [cl(P.id, 2, 100000)], { clientRef: 'shop-sale-0001', notes: '  walk-in  ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['sales', 'warnings']);
    expect(r.body.warnings).toEqual([]);
    expect(r.body.sales).toHaveLength(1);
    const sale = r.body.sales[0];
    expect(Object.keys(sale).sort()).toEqual(SALE_KEYS);
    expect(sale).toMatchObject({
      businessDate: today(), backdated: false, book: 'shop', totalCents: 200000, cogsCents: 70000, grossProfitCents: 130000,
      status: 'posted', notes: 'walk-in', voidedAt: null, voidReason: null, clientRef: 'shop-sale-0001', returns: [],
    });
    expect(sale.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(sale.items).toHaveLength(1);
    expect(Object.keys(sale.items[0]).sort()).toEqual(SALE_ITEM_KEYS);
    expect(sale.items[0]).toMatchObject({
      lineNo: 1, lineType: 'goods', productId: P.id, productName: 'Charger', productCode: 'CH-1', qty: 2, unitPriceCents: 100000,
      unitCostCents: 35000, revenueCents: 200000, cogsCents: 70000, returnedQty: 0,
    });
    expect(poolOf(s, P.id)).toEqual({ qty: 18, value: 630000 });
    const m = mvsByRef(s, 'sales', sale.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ productId: P.id, type: 'sale', qty: -2, value: -70000, unit: 35000, date: today() });
    const cash = cashOfRef(s, 'sales', sale.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'sale_goods', amount_cents: 200000, business_date: today(), reverses_entry_id: null });
    expect((await get(s.app, `/sales/${sale.id}`)).body.item).toEqual(sale);
    await reconOk(s);
  });

  // Hand calculation: scratch cards 100 / 50,000 (average 500). Sell 10 @ 600: revenue 6,000; COGS 50,000 x 10 / 100 = 5,000;
  // unit cost 500; profit 1,000; pool 90 / 45,000. Telecom cash entry card_sale +6,000 in book telecom (not shop).
  it('telecom cash sale of scratch cards: line type card, card_sale cash entry in the telecom book', async () => {
    const s = await setup();
    const T = await stocked(s, tel0, 100, 50000, { name: 'Dialog 100' });
    const shopBefore = cashBal(s, 'shop');
    const sale = (await sellOk(s, [cl(T.id, 10, 600)])).sales[0];
    expect(sale).toMatchObject({ book: 'telecom', totalCents: 6000, cogsCents: 5000, grossProfitCents: 1000 });
    expect(sale.items[0]).toMatchObject({ lineType: 'card', qty: 10, revenueCents: 6000, cogsCents: 5000, unitCostCents: 500 });
    expect(poolOf(s, T.id)).toEqual({ qty: 90, value: 45000 });
    const cash = cashOfRef(s, 'sales', sale.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'telecom', type: 'card_sale', amount_cents: 6000 });
    expect(cashBal(s, 'shop')).toBe(shopBefore);                              // shop drawer untouched
    await reconOk(s);
  });

  // Hand calculation: A pool 10 / 10,000 (avg 1,000), B pool 5 / 2,500 (avg 500).
  // Line 1: 3 x 1,500 = 4,500, COGS 10,000 x 3 / 10 = 3,000. Line 2: 2 x 800 = 1,600, COGS 2,500 x 2 / 5 = 1,000.
  // Total 6,100; COGS 4,000; profit 2,100. Pools A 7 / 7,000 and B 3 / 1,500. ONE cash entry of 6,100, TWO movements.
  it('several products and quantities in one sale: lines in cart order, totals are sums, one cash entry', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 3, 1500), cl(B.id, 2, 800)])).sales[0];
    expect(sale).toMatchObject({ totalCents: 6100, cogsCents: 4000, grossProfitCents: 2100 });
    expect(sale.items.map((i: any) => [i.lineNo, i.productId, i.qty, i.revenueCents, i.cogsCents, i.unitCostCents]))
      .toEqual([[1, A.id, 3, 4500, 3000, 1000], [2, B.id, 2, 1600, 1000, 500]]);
    expect(poolOf(s, A.id)).toEqual({ qty: 7, value: 7000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 3, value: 1500 });
    expect(mvsByRef(s, 'sales', sale.id)).toHaveLength(2);
    expect(cashOfRef(s, 'sales', sale.id).map((c) => c.amount_cents)).toEqual([6100]);
    await reconOk(s);
  });

  // Hand calculation. Pools: SA 10/10,000 (1,000 each), SB 5/2,500 (500), TX 100/50,000 (500), TY 20/4,000 (200).
  // Cart order: SA 2 @1,500 | TX 10 @600 | SB 1 @900 | TY 5 @250.
  // Shop sale: SA rev 3,000 cogs 2,000; SB rev 900 cogs 500 -> total 3,900, COGS 2,500, profit 1,400, lines 1,2 in cart order.
  // Telecom sale: TX rev 6,000 cogs 5,000; TY rev 1,250 cogs 1,000 -> total 7,250, COGS 6,000, profit 1,250, lines 1,2.
  it('mixed-book cart creates TWO sales (shop first) with separate totals, COGS, cash entries and the same clientRef', async () => {
    const s = await setup();
    const SA = await stocked(s, shop0, 10, 10000);
    const SB = await stocked(s, shop0, 5, 2500);
    const TX = await stocked(s, tel0, 100, 50000);
    const TY = await stocked(s, tel0, 20, 4000);
    // cart deliberately lists the telecom line first to prove the order is shop-first regardless
    const r = await sellNew(s, [cl(TX.id, 10, 600), cl(SA.id, 2, 1500), cl(TY.id, 5, 250), cl(SB.id, 1, 900)], { clientRef: 'mixed-cart-0001' });
    expect(r.status).toBe(201);
    const [shop, tel] = r.body.sales;
    expect(r.body.sales).toHaveLength(2);
    expect(shop.id).toBeLessThan(tel.id);
    expect([shop.book, tel.book]).toEqual(['shop', 'telecom']);
    expect([shop.clientRef, tel.clientRef]).toEqual(['mixed-cart-0001', 'mixed-cart-0001']);
    expect(shop).toMatchObject({ totalCents: 3900, cogsCents: 2500, grossProfitCents: 1400 });
    expect(tel).toMatchObject({ totalCents: 7250, cogsCents: 6000, grossProfitCents: 1250 });
    // lines keep cart order within their own sale, numbered 1..n per sale
    expect(shop.items.map((i: any) => [i.lineNo, i.productId, i.lineType])).toEqual([[1, SA.id, 'goods'], [2, SB.id, 'goods']]);
    expect(tel.items.map((i: any) => [i.lineNo, i.productId, i.lineType])).toEqual([[1, TX.id, 'card'], [2, TY.id, 'card']]);
    // separate cash entries in their own books
    expect(cashOfRef(s, 'sales', shop.id).map((c) => [c.book, c.type, c.amount_cents])).toEqual([['shop', 'sale_goods', 3900]]);
    expect(cashOfRef(s, 'sales', tel.id).map((c) => [c.book, c.type, c.amount_cents])).toEqual([['telecom', 'card_sale', 7250]]);
    expect(mvsByRef(s, 'sales', shop.id)).toHaveLength(2);
    expect(mvsByRef(s, 'sales', tel.id)).toHaveLength(2);
    expect(poolOf(s, TX.id)).toEqual({ qty: 90, value: 45000 });
    // one audit row per sale
    expect(auditRows(s.ctx, 'sale').map((a) => a.entityId)).toEqual([String(shop.id), String(tel.id)]);
    await reconOk(s);
  });

  // The same mixed cart where the LAST (telecom) line lacks stock: the shop sale that was already written must disappear too.
  it('mixed cart: a failing telecom line rolls back the earlier shop sale (one transaction)', async () => {
    const s = await setup();
    const SA = await stocked(s, shop0, 10, 10000);
    const TY = await stocked(s, tel0, 20, 4000);
    const cartSnap = snap5(s);
    const stockSnap = productsSnap(s);
    const r = await sellNew(s, [cl(SA.id, 2, 1500), cl(TY.id, 21, 250)]);
    expect(r.status).toBe(422);
    expect(err(r)).toMatchObject({ code: 'INSUFFICIENT_STOCK', onHand: 20 });
    expect(err(r).fields['items.1.qty']).toBeTruthy();
    expect(snap5(s)).toEqual(cartSnap);
    expect(productsSnap(s)).toBe(stockSnap);
    await reconOk(s);
  });

  // 100 lines is the limit; the lines are numbered 1..100.
  it('a cart of exactly 100 lines is accepted and numbered 1..100', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 150, 150000);
    const sale = (await sellOk(s, Array.from({ length: 100 }, () => cl(P.id, 1, 2000)))).sales[0];
    expect(sale.items).toHaveLength(100);
    expect(sale.items.map((i: any) => i.lineNo)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(sale).toMatchObject({ totalCents: 200000, cogsCents: 100000 });       // 100 x 2,000 and 100 x 1,000
    expect(poolOf(s, P.id)).toEqual({ qty: 50, value: 50000 });
  });

  // Hand calculation: price 0 -> revenue 0, total 0: the sale exists and stock leaves, but no cash entry (nothing was paid).
  it('a free sale (price 0) is saved with total 0, moves stock, writes no cash entry', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const cashBefore = num(s, 'SELECT COUNT(*) FROM cash_entries');
    const r = await sellOk(s, [cl(P.id, 2, 0)]);
    expect(r.sales[0]).toMatchObject({ totalCents: 0, cogsCents: 2000, grossProfitCents: -2000 });
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cashBefore);
    expect(poolOf(s, P.id)).toEqual({ qty: 8, value: 8000 });
  });

  // Maximum unit price is accepted: 1 x 999,999,999.
  it('the maximum unit price 999999999 is accepted', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 3, 3000);
    const r = await sellOk(s, [cl(P.id, 1, 999999999)]);
    expect(r.sales[0].totalCents).toBe(999999999);
  });
});

// =============================================================================================
// Stock rules: cumulative check, INSUFFICIENT_STOCK, nothing saved.
describe('POST /sales - stock rules', () => {
  // Hand calculation: pool 5 / 1,000 (avg 200). Lines 3 then 3: line 1 leaves 2 -> line 2 needs 3 > 2 -> refused on line index 1
  // (so the check is CUMULATIVE across lines, not 3 <= 5 twice). Lines 3 then 2 work: COGS 1,000 x 3 / 5 = 600, then the last 2 take
  // the whole remaining 400 (no residue); pool 0 / 0.
  it('same product on two lines: checked cumulatively (3+3 of 5 refused at items.1.qty; 3+2 fine, last line takes the rest)', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 1000);
    const before = snap5(s);
    const bad = await sellNew(s, [cl(P.id, 3, 500), cl(P.id, 3, 500)]);
    expect(bad.status).toBe(422);
    expect(err(bad).code).toBe('INSUFFICIENT_STOCK');
    expect(err(bad).onHand).toBe(2);
    expect(Object.keys(err(bad).fields)).toEqual(['items.1.qty']);
    expect(snap5(s)).toEqual(before);
    expect(poolOf(s, P.id)).toEqual({ qty: 5, value: 1000 });

    const ok = (await sellOk(s, [cl(P.id, 3, 500), cl(P.id, 2, 500)])).sales[0];
    expect(ok.items.map((i: any) => [i.qty, i.cogsCents, i.unitCostCents])).toEqual([[3, 600, 200], [2, 400, 200]]);
    expect(ok.cogsCents).toBe(1000);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  it('INSUFFICIENT_STOCK: 422 with fields["items.N.qty"] and onHand; a product with no stock has onHand 0; nothing saved', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 4, 4000);
    const empty = await shop0(s);
    const before = snap5(s);
    const r = await sellNew(s, [cl(P.id, 5, 1000)]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('INSUFFICIENT_STOCK');
    expect(err(r).onHand).toBe(4);
    expect(err(r).productId).toBe(P.id);
    expect(err(r).fields['items.0.qty']).toBe('Only 4 in stock.');
    const r2 = await sellNew(s, [cl(P.id, 1, 1000), cl(empty.id, 1, 1000)]);
    expect(r2.status).toBe(422);
    expect(err(r2).onHand).toBe(0);
    expect(Object.keys(err(r2).fields)).toEqual(['items.1.qty']);
    expect(snap5(s)).toEqual(before);
    expect(poolOf(s, P.id)).toEqual({ qty: 4, value: 4000 });
    // selling exactly what is there is fine
    expect((await sellNew(s, [cl(P.id, 4, 1000)])).status).toBe(201);
    await reconOk(s);
  });
});

// =============================================================================================
// Product rules: services, inactive, unknown.
describe('POST /sales - product rules', () => {
  it('service product -> 400 PRODUCT_NOT_SELLABLE_YET (Phase 7); fields point at the line; nothing saved', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const svc = await mkProduct(s, { kind: 'service', reorderLevel: 0, name: 'Photocopy' });
    const before = snap5(s);
    const r = await sellNew(s, [cl(P.id, 1, 1000), cl(svc.id, 1, 1000)]);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('PRODUCT_NOT_SELLABLE_YET');
    expect(Object.keys(err(r).fields)).toEqual(['items.1.productId']);
    expect(snap5(s)).toEqual(before);
  });

  it('inactive product -> 400 PRODUCT_INACTIVE; unknown product -> 400 VALIDATION_ERROR items.N.productId', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const Q = await stocked(s, shop0, 5, 5000);
    expect((await put(s.app, `/products/${Q.id}`, { active: false })).status).toBe(200);
    const before = snap5(s);
    const r = await sellNew(s, [cl(Q.id, 1, 1000), cl(P.id, 1, 1000)]);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('PRODUCT_INACTIVE');
    expect(Object.keys(err(r).fields)).toEqual(['items.0.productId']);
    const u = await sellNew(s, [cl(P.id, 1, 1000), cl(999999, 1, 1000)]);
    expect(u.status).toBe(400);
    expect(err(u).code).toBe('VALIDATION_ERROR');
    expect(Object.keys(err(u).fields)).toEqual(['items.1.productId']);
    expect(snap5(s)).toEqual(before);
  });

  // Order of the product checks: unknown first, then service, then inactive - each reported once for all lines.
  it('check order: unknown product beats service beats inactive', async () => {
    const s = await setup();
    const Q = await stocked(s, shop0, 5, 5000);
    await put(s.app, `/products/${Q.id}`, { active: false });
    const svc = await mkProduct(s, { kind: 'service', reorderLevel: 0 });
    expect(err(await sellNew(s, [cl(Q.id, 1, 1), cl(svc.id, 1, 1)])).code).toBe('PRODUCT_NOT_SELLABLE_YET');
    expect(err(await sellNew(s, [cl(Q.id, 1, 1), cl(svc.id, 1, 1), cl(999999, 1, 1)])).code).toBe('VALIDATION_ERROR');
  });
});

// =============================================================================================
// Request validation: bounds, no coercion, unknown fields, clientRef.
describe('POST /sales - validation', () => {
  it('bounds: qty 1..1000000, unit price 0..999999999, items 1..100', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const bad = async (items: unknown[], key: string) => {
      const r = await sellNew(s, items);
      expect(r.status, key).toBe(400);
      expect(err(r).fields[key], key).toBeTruthy();
    };
    await bad([cl(P.id, 0, 100)], 'items.0.qty');
    await bad([cl(P.id, -1, 100)], 'items.0.qty');
    await bad([cl(P.id, 1000001, 100)], 'items.0.qty');
    await bad([cl(P.id, 1, -1)], 'items.0.unitPriceCents');
    await bad([cl(P.id, 1, 1000000000)], 'items.0.unitPriceCents');
    await bad([cl(0, 1, 100)], 'items.0.productId');
    await bad([], 'items');
    await bad(Array.from({ length: 101 }, () => cl(P.id, 1, 100)), 'items');
    // qty 1,000,000 passes the schema; only the stock rule refuses it
    const r = await sellNew(s, [cl(P.id, 1000000, 100)]);
    expect(r.status).toBe(422);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(0);
  });

  // No type coercion: "5", null, 1.5 are errors, never silently converted.
  it('no coercion: strings, null, decimals, wrong containers are 400 and nothing is saved', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const cases: Array<[string, unknown[]]> = [
      ['items.0.qty', [{ productId: P.id, qty: '5', unitPriceCents: 100 }]],
      ['items.0.qty', [{ productId: P.id, qty: null, unitPriceCents: 100 }]],
      ['items.0.qty', [{ productId: P.id, qty: 1.5, unitPriceCents: 100 }]],
      ['items.0.unitPriceCents', [{ productId: P.id, qty: 1, unitPriceCents: '100' }]],
      ['items.0.unitPriceCents', [{ productId: P.id, qty: 1, unitPriceCents: null }]],
      ['items.0.unitPriceCents', [{ productId: P.id, qty: 1, unitPriceCents: 10.5 }]],
      ['items.0.productId', [{ productId: String(P.id), qty: 1, unitPriceCents: 100 }]],
      ['items.0.unitPriceCents', [{ productId: P.id, qty: 1 }]],
      ['items.0.qty', [{ productId: P.id, unitPriceCents: 100 }]],
      ['items.0.productId', [{ qty: 1, unitPriceCents: 100 }]],
    ];
    for (const [key, items] of cases) {
      const r = await sellNew(s, items);
      expect(r.status, key + JSON.stringify(items)).toBe(400);
      expect(err(r).fields[key], key).toBeTruthy();
    }
    for (const bad of ['x', 5, null, { a: 1 }]) {
      const r = await sellNew(s, bad as unknown as unknown[]);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(0);
  });

  it('unknown fields (body and line) are 400; postedAt can never be sent', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const r1 = await post(s.app, '/sales', { businessDate: today(), items: [cl(P.id, 1, 100)], clientRef: ref(), postedAt: '2020-01-01T00:00:00.000Z' });
    expect(r1.status).toBe(400);
    expect(err(r1).fields.postedAt).toBe('Unknown field.');
    const r2 = await post(s.app, '/sales', { businessDate: today(), items: [cl(P.id, 1, 100)], clientRef: ref(), book: 'telecom' });
    expect(err(r2).fields.book).toBe('Unknown field.');
    const r3 = await post(s.app, '/sales', { businessDate: today(), items: [{ ...cl(P.id, 1, 100), cogsCents: 1 }], clientRef: ref() });
    expect(err(r3).fields['items.0.cogsCents']).toBe('Unknown field.');
    const r4 = await post(s.app, '/sales', { businessDate: today(), items: [{ ...cl(P.id, 1, 100), unitCostCents: 1 }], clientRef: ref() });
    expect(r4.status).toBe(400);
    for (const k of ['status', 'totalCents', 'id', 'paid']) {
      const r = await post(s.app, '/sales', { businessDate: today(), items: [cl(P.id, 1, 100)], clientRef: ref(), [k]: 1 });
      expect(r.status, k).toBe(400);
    }
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(0);
  });

  it('required fields, malformed dates, notes length and clientRef pattern', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    for (const k of ['businessDate', 'items', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), items: [cl(P.id, 1, 100)], clientRef: ref() };
      delete body[k];
      const r = await post(s.app, '/sales', body);
      expect(r.status, k).toBe(400);
      expect(err(r).fields[k], k).toBeTruthy();
    }
    for (const d of ['2026-02-31', '2025-02-29', 'not-a-date', '2026-1-1', '', 20260101]) {
      const r = await sellNew(s, [cl(P.id, 1, 100)], { businessDate: d });
      expect(r.status, String(d)).toBe(400);
      expect(err(r).fields.businessDate, String(d)).toBeTruthy();
    }
    expect((await sellNew(s, [cl(P.id, 1, 100)], { notes: 'n'.repeat(501) })).status).toBe(400);
    expect((await sellNew(s, [cl(P.id, 1, 100)], { notes: 5 })).status).toBe(400);
    expect((await sellNew(s, [cl(P.id, 1, 100)], { notes: 'n'.repeat(500) })).status).toBe(201);
    for (const c of ['short', 'with space 1234', 'y'.repeat(65), 'bad/char/1234', '']) {
      expect((await sellNew(s, [cl(P.id, 1, 100)], { clientRef: c })).status, c).toBe(400);
    }
    expect((await sellNew(s, [cl(P.id, 1, 100)], { clientRef: 'y'.repeat(64) })).status).toBe(201);
    expect((await sellNew(s, [cl(P.id, 1, 100)], { clientRef: 'abcdefgh' })).status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(3);
  });
});

// =============================================================================================
// R13: price warnings never block the sale.
describe('POST /sales - R13 warnings', () => {
  // Product W: minimum price 50,000, pool 20 / 700,000 (every single unit costs exactly 35,000).
  //  line 0: 100,000 -> none.        line 1: 49,999 < 50,000 -> PRICE_BELOW_MINIMUM only (still above cost).
  //  line 2: 50,000 = minimum -> none.   line 3: 34,999 -> below minimum AND below the cost 35,000 -> PRICE_BELOW_MINIMUM + PRICE_BELOW_COST.
  // The sale is still saved: 100,000 + 49,999 + 50,000 + 34,999 = 234,998.
  it('PRICE_BELOW_MINIMUM and PRICE_BELOW_COST carry the cart lineIndex and never block', async () => {
    const s = await setup();
    const W = await stocked20(s, mkProduct, { minPriceCents: 50000, sellPriceCents: 100000 });
    const r = await sellNew(s, [cl(W.id, 1, 100000), cl(W.id, 1, 49999), cl(W.id, 1, 50000), cl(W.id, 1, 34999)]);
    expect(r.status).toBe(201);
    expect(r.body.sales[0].totalCents).toBe(234998);
    expect(r.body.warnings.map((w: any) => [w.lineIndex, w.code])).toEqual([
      [1, 'PRICE_BELOW_MINIMUM'], [3, 'PRICE_BELOW_MINIMUM'], [3, 'PRICE_BELOW_COST'],
    ]);
    for (const w of r.body.warnings) {
      expect(Object.keys(w).sort()).toEqual(['code', 'lineIndex', 'message']);
      expect(typeof w.message).toBe('string');
    }
    expect(poolOf(s, W.id)).toEqual({ qty: 16, value: 560000 });
    await reconOk(s);
  });

  // Hand calculation (minimum 0): unit cost 35,000. 34,999 < 35,000 -> PRICE_BELOW_COST. 35,000 is not below cost -> no warning.
  it('PRICE_BELOW_COST is strict: price == cost is fine, one cent less warns', async () => {
    const s = await setup();
    const C = await stocked20(s, shop0);
    const r = await sellOk(s, [cl(C.id, 1, 34999), cl(C.id, 1, 35000)]);
    expect(r.warnings.map((w: any) => [w.lineIndex, w.code])).toEqual([[0, 'PRICE_BELOW_COST']]);
  });

  // Hand calculation: pool 5 units worth 0 -> COGS 0 -> ZERO_COST. Price 10,000 is not below the cost 0, and minimum is 0.
  it('ZERO_COST when the stock carries no recorded cost; the sale shows full profit', async () => {
    const s = await setup();
    const Z = await stocked(s, shop0, 5, 0);
    const r = await sellOk(s, [cl(Z.id, 2, 10000)]);
    expect(r.warnings.map((w: any) => [w.lineIndex, w.code])).toEqual([[0, 'ZERO_COST']]);
    expect(r.sales[0]).toMatchObject({ cogsCents: 0, grossProfitCents: 20000 });
  });

  // lineIndex is the position in the SUBMITTED cart even though the telecom line lands in the second sale.
  it('lineIndex is the cart position across a mixed cart', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 5, 5000);
    const T = await stocked(s, mkTelecom, 5, 2500, { minPriceCents: 500, sellPriceCents: 1000 });
    const r = await sellOk(s, [cl(A.id, 1, 2000), cl(A.id, 1, 2000), cl(T.id, 1, 100)]);
    expect(r.warnings.map((w: any) => [w.lineIndex, w.code])).toEqual([[2, 'PRICE_BELOW_MINIMUM'], [2, 'PRICE_BELOW_COST']]);
    expect(r.sales).toHaveLength(2);
  });

  it('a sale priced at 0 warns (cost) and is still created', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 5, 5000);
    const r = await sellNew(s, [cl(A.id, 1, 0)]);
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: any) => w.code)).toEqual(['PRICE_BELOW_COST']);
  });
});

// =============================================================================================
// Duplicate submission (section 12): clientRef.
describe('POST /sales - duplicate submission', () => {
  // The repeat returns the ORIGINAL sales of ALL books of the cart with 200, no warnings, and writes nothing more.
  it('same clientRef for a mixed cart: 200, same sale ids for both books, no second movement / cash / audit row', async () => {
    const s = await setup();
    const SA = await stocked(s, shop0, 10, 10000);
    const TX = await stocked(s, tel0, 100, 50000);
    const body = { businessDate: today(), items: [cl(SA.id, 2, 1500), cl(TX.id, 10, 600)], clientRef: 'dup-cart-0001' };
    const first = await post(s.app, '/sales', body);
    expect(first.status).toBe(201);
    const counts = snap5(s);
    const poolsBefore = productsSnap(s);
    const again = await post(s.app, '/sales', body);
    expect(again.status).toBe(200);
    expect(ids(again.body.sales)).toEqual(ids(first.body.sales));
    expect(again.body.sales).toEqual(first.body.sales);
    expect(again.body.warnings).toEqual([]);
    expect(snap5(s)).toEqual(counts);
    expect(productsSnap(s)).toBe(poolsBefore);
    // even when the retry carries different items, the original is returned and nothing new is written
    const changed = await post(s.app, '/sales', { ...body, items: [cl(SA.id, 5, 100)] });
    expect(changed.status).toBe(200);
    expect(ids(changed.body.sales)).toEqual(ids(first.body.sales));
    expect(snap5(s)).toEqual(counts);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(2);
    await reconOk(s);
  });

  // A retry must succeed even when the stock is gone or the product was deactivated meanwhile.
  it('retry still returns the original after the stock was sold out and the product deactivated', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 2, 2000);
    const body = { businessDate: today(), items: [cl(P.id, 2, 1500)], clientRef: 'dup-late-0001' };
    expect((await post(s.app, '/sales', body)).status).toBe(201);
    await put(s.app, `/products/${P.id}`, { active: false });
    const again = await post(s.app, '/sales', body);
    expect(again.status).toBe(200);
    expect(again.body.sales).toHaveLength(1);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(1);
  });

  it('a different clientRef is a new sale', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    await sellOk(s, [cl(P.id, 1, 1500)], { clientRef: 'new-ref-0001' });
    await sellOk(s, [cl(P.id, 1, 1500)], { clientRef: 'new-ref-0002' });
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(2);
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
  });
});

// =============================================================================================
// Dates (R-FD and backdating).
describe('POST /sales - dates', () => {
  it('future date -> 400 FUTURE_DATE_NOT_ALLOWED with the exact owner-approved message; nothing saved', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const before = snap5(s);
    for (const d of [daysAhead(1), daysAhead(30)]) {
      const r = await sellNew(s, [cl(P.id, 1, 1000)], { businessDate: d });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('FUTURE_DATE_NOT_ALLOWED');
      expect(err(r).message).toBe(FUTURE_MSG);
      expect(err(r).fields.businessDate).toBe(FUTURE_MSG);
    }
    expect(snap5(s)).toEqual(before);
  });

  // R-FD is checked before the product lookups, so a future date with an unknown product reports the date.
  it('R-FD is checked before product lookups', async () => {
    const s = await setup();
    const r = await sellNew(s, [cl(999999, 1, 1000)], { businessDate: daysAhead(1) });
    expect(err(r).code).toBe('FUTURE_DATE_NOT_ALLOWED');
  });

  // Hand calculation: P bought on day-10: 10 / 10,000 (avg 1,000); bought today: 10 / 30,000 -> pool 20 / 40,000 (avg 2,000).
  // A sale dated day-5 is costed by POSTING order (live pool): 40,000 x 1 / 20 = 2,000. (Business-date order would wrongly give 1,000.)
  it('backdated sale: accepted, backdated true, movement/cash carry the business date, costed at the live pool (posting order)', async () => {
    const s = await setup();
    const P = await shop0(s);
    await buy(s, [{ productId: P.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: daysAgo(10) });
    const purchase2 = await buy(s, [{ productId: P.id, packs: 1, packSize: 10, lineTotalCents: 30000 }]);
    const r = await sellNew(s, [cl(P.id, 1, 5000)], { businessDate: daysAgo(5) });
    expect(r.status).toBe(201);
    const sale = r.body.sales[0];
    expect(sale).toMatchObject({ businessDate: daysAgo(5), backdated: true, cogsCents: 2000 });
    const m = mvsByRef(s, 'sales', sale.id)[0]!;
    expect(m).toMatchObject({ type: 'sale', date: daysAgo(5), value: -2000 });
    const purchaseMoves = mvsByRef(s, 'purchases', purchase2.id);
    expect(m.id).toBeGreaterThan(purchaseMoves[0]!.id);                         // posted after the purchase
    expect(cashOfRef(s, 'sales', sale.id)[0]).toMatchObject({ business_date: daysAgo(5), amount_cents: 5000 });
    const audit = sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'sale'");
    expect(audit).toEqual([{ business_date: daysAgo(5), backdated: 1 }]);
    // a sale dated today is not backdated
    const t = (await sellOk(s, [cl(P.id, 1, 5000)])).sales[0];
    expect(t.backdated).toBe(false);
    await reconOk(s);
  });

  it('yesterday and today are both fine', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    expect((await sellNew(s, [cl(P.id, 1, 1000)], { businessDate: daysAgo(1) })).status).toBe(201);
    expect((await sellNew(s, [cl(P.id, 1, 1000)], { businessDate: today() })).status).toBe(201);
  });
});

// =============================================================================================
// Listing, filters, totals, single sale.
describe('GET /sales - list, filters and totals', () => {
  // Data (hand calculation; P1 50/50,000 avg 1,000; P2 50/25,000 avg 500; T1 20/10,000 avg 500):
  //   s1 day-10 shop P1 1 @2,000: rev 2,000 cogs 1,000     s2 day-5 shop P2 2 @1,000: rev 2,000 cogs 1,000
  //   s3 day-5 telecom T1 1 @500: rev 500 cogs 500          s4 today shop P1 3 @2,000: rev 6,000 cogs 3,000
  //   s5 today shop P2 1 @1,000: rev 1,000 cogs 500 -> later VOIDED (listed, never summed).
  async function fixture() {
    const s = await setup();
    const P1 = await stocked(s, shop0, 50, 50000);
    const P2 = await stocked(s, shop0, 50, 25000);
    const T1 = await stocked(s, tel0, 20, 10000);
    const s1 = (await sellOk(s, [cl(P1.id, 1, 2000)], { businessDate: daysAgo(10) })).sales[0];
    const s2 = (await sellOk(s, [cl(P2.id, 2, 1000)], { businessDate: daysAgo(5) })).sales[0];
    const s3 = (await sellOk(s, [cl(T1.id, 1, 500)], { businessDate: daysAgo(5) })).sales[0];
    const s4 = (await sellOk(s, [cl(P1.id, 3, 2000)])).sales[0];
    const s5 = (await sellOk(s, [cl(P2.id, 1, 1000)])).sales[0];
    expect((await voidSaleNew(s, s5.id)).status).toBe(200);
    return { s, P1, P2, T1, s1, s2, s3, s4, s5 };
  }
  const list = async (s: ApiBase, q = '') => (await get(s.app, `/sales${q}`)).body;

  it('default list: newest business date first, then id desc; shape { items, total, totals }; items are full sales', async () => {
    const { s, s1, s2, s3, s4, s5 } = await fixture();
    const r = await get(s.app, '/sales');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'total', 'totals']);
    expect(Object.keys(r.body.totals).sort()).toEqual(['cogsCents', 'refundsCents', 'revenueCents']);
    expect(ids(r.body.items)).toEqual([s5.id, s4.id, s3.id, s2.id, s1.id]);
    expect(r.body.total).toBe(5);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(SALE_KEYS);
    expect(r.body.items[0].items).toHaveLength(1);
    expect(r.body.items[0].status).toBe('void');
  });

  it('filters: from / to (inclusive), book, status, productId', async () => {
    const { s, P1, s1, s2, s3, s4, s5 } = await fixture();
    expect(ids((await list(s, `?from=${daysAgo(5)}`)).items)).toEqual([s5.id, s4.id, s3.id, s2.id]);
    expect(ids((await list(s, `?to=${daysAgo(5)}`)).items)).toEqual([s3.id, s2.id, s1.id]);
    expect(ids((await list(s, `?from=${daysAgo(5)}&to=${daysAgo(5)}`)).items)).toEqual([s3.id, s2.id]);
    expect(ids((await list(s, `?from=${daysAgo(9)}&to=${daysAgo(6)}`)).items)).toEqual([]);
    expect(ids((await list(s, '?book=telecom')).items)).toEqual([s3.id]);
    expect(ids((await list(s, '?book=shop')).items)).toEqual([s5.id, s4.id, s2.id, s1.id]);
    expect(ids((await list(s, '?status=void')).items)).toEqual([s5.id]);
    expect(ids((await list(s, '?status=posted')).items)).toEqual([s4.id, s3.id, s2.id, s1.id]);
    expect(ids((await list(s, `?productId=${P1.id}`)).items)).toEqual([s4.id, s1.id]);
    expect(ids((await list(s, '?productId=999999')).items)).toEqual([]);
    expect(ids((await list(s, `?book=shop&status=posted&productId=${P1.id}&from=${daysAgo(2)}`)).items)).toEqual([s4.id]);
  });

  it('paging: limit / offset slice the list; total ignores paging', async () => {
    const { s, s1, s3, s4 } = await fixture();
    const a = await list(s, '?limit=2&offset=1');
    expect(ids(a.items)).toEqual([s4.id, s3.id]);
    expect(a.total).toBe(5);
    expect(ids((await list(s, '?limit=2&offset=4')).items)).toEqual([s1.id]);
    const beyond = await list(s, '?offset=50');
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(5);
    expect((await get(s.app, '/sales?limit=200')).status).toBe(200);
    expect((await list(s, '?limit=1')).items).toHaveLength(1);
  });

  it('bad parameters -> 400 VALIDATION_ERROR (dates, book, status, limit, offset, productId, unknown parameter)', async () => {
    const { s } = await fixture();
    for (const q of ['from=abc', 'from=2026-02-31', 'to=2025-13-01', 'to=2026-1-1', 'book=icecream', 'status=draft', 'limit=0', 'limit=201',
      'limit=abc', 'limit=-1', 'offset=-1', 'offset=abc', 'productId=abc', 'productId=-1', 'foo=1']) {
      const r = await get(s.app, `/sales?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe('VALIDATION_ERROR');
    }
  });

  // Hand calculation (posted sales only; s5 is void and excluded):
  //  all:        revenue 2,000 + 2,000 + 500 + 6,000 = 10,500; COGS 1,000 + 1,000 + 500 + 3,000 = 5,500; refunds 0.
  //  to day-5:   s1 + s2 + s3 -> revenue 4,500, COGS 2,500.   telecom: 500 / 500.   status=void: nothing posted -> 0 / 0 / 0.
  //  After a return of 1 unit of s4 (resalable, 2,000 each): refunds 2,000 for the unfiltered and shop lists, 0 for telecom.
  it('totals cover POSTED sales matching the filter only; voided excluded; refunds come from returns', async () => {
    const { s, s3, s4 } = await fixture();
    expect((await list(s)).totals).toEqual({ revenueCents: 10500, cogsCents: 5500, refundsCents: 0 });
    expect((await list(s, `?to=${daysAgo(5)}`)).totals).toEqual({ revenueCents: 4500, cogsCents: 2500, refundsCents: 0 });
    expect((await list(s, '?book=telecom')).totals).toEqual({ revenueCents: 500, cogsCents: 500, refundsCents: 0 });
    expect((await list(s, '?status=void')).totals).toEqual({ revenueCents: 0, cogsCents: 0, refundsCents: 0 });
    // paging does not change totals
    expect((await list(s, '?limit=1')).totals).toEqual({ revenueCents: 10500, cogsCents: 5500, refundsCents: 0 });
    await returnOk(s, s4.id, [rl(s4.items[0].id, 1, true)]);
    expect((await list(s)).totals).toEqual({ revenueCents: 10500, cogsCents: 5500, refundsCents: 2000 });
    expect((await list(s, '?book=shop')).totals.refundsCents).toBe(2000);
    expect((await list(s, '?book=telecom')).totals.refundsCents).toBe(0);
    expect((await list(s, `?to=${daysAgo(5)}`)).totals.refundsCents).toBe(0);
    expect(s3.id).toBeGreaterThan(0);
    await reconOk(s);
  });
});

describe('GET /sales/:id', () => {
  it('404 NOT_FOUND for an unknown id; 400 for a non-numeric id', async () => {
    const s = await setup();
    const r = await get(s.app, '/sales/99999');
    expect(r.status).toBe(404);
    expect(err(r).code).toBe('NOT_FOUND');
    expect((await get(s.app, '/sales/abc')).status).toBe(400);
  });

  it('returns { item } with lines and returns', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    const r = await get(s.app, `/sales/${sale.id}`);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(r.body.item.items).toHaveLength(1);
    expect(r.body.item.returns).toEqual([]);
  });
});

// =============================================================================================
// Audit (section 12).
describe('sale audit', () => {
  it('one audit row per sale: entity sale, action create, before null, after = the sale; business date and backdated flag stored', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 1, 1500)])).sales[0];
    const rows = auditRows(s.ctx, 'sale');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'sale', entityId: String(sale.id), action: 'create', before: null });
    expect(rows[0]!.after).toEqual(sale);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'sale'")).toEqual([{ business_date: today(), backdated: 0 }]);
    // GET /audit-logs exposes it with the business date
    const api = (await get(s.app, '/audit-logs?entity=sale')).body;
    expect(api.items[0]).toMatchObject({ entity: 'sale', action: 'create', businessDate: today(), backdated: false });
  });
});

// =============================================================================================
// Atomic rollback: sale + lines + movements + cash + audit are one transaction.
describe('atomic rollback (nothing persists when any step fails)', () => {
  it('audit insert fails after movements and cash were written -> no sale, items, movements, cash or audit; stock unchanged; retry works', async () => {
    quiet();
    const s = await setup();
    const SA = await stocked(s, shop0, 10, 10000);
    const TX = await stocked(s, tel0, 100, 50000);
    const before = snap5(s);
    const stockBefore = productsSnap(s);
    breakAudit(s.ctx, 'sale');
    const body = { businessDate: today(), items: [cl(SA.id, 2, 1500), cl(TX.id, 10, 600)], clientRef: 'atomic-0001' };
    const r = await post(s.app, '/sales', body);
    expect(r.status).toBe(500);
    expect(err(r).code).toBe('INTERNAL_ERROR');
    expect(snap5(s)).toEqual(before);
    expect(productsSnap(s)).toBe(stockBefore);
    await reconOk(s);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    const retry = await post(s.app, '/sales', body);
    expect(retry.status).toBe(201);                                              // nothing was saved, so it is a new sale
    expect(retry.body.sales).toHaveLength(2);
    await reconOk(s);
  });

  it('a cash-entry failure on the SECOND sale (telecom) rolls back the first (shop) sale and its cash entry too', async () => {
    quiet();
    const s = await setup();
    const SA = await stocked(s, shop0, 10, 10000);
    const TX = await stocked(s, tel0, 100, 50000);
    const before = snap5(s);
    const stockBefore = productsSnap(s);
    const shopCash = cashBal(s, 'shop');
    breakCash(s.ctx, 'card_sale');
    const r = await sellNew(s, [cl(SA.id, 2, 1500), cl(TX.id, 10, 600)]);
    expect(r.status).toBe(500);
    expect(snap5(s)).toEqual(before);
    expect(productsSnap(s)).toBe(stockBefore);
    expect(cashBal(s, 'shop')).toBe(shopCash);
    expect((await productOf(s, SA.id)).qtyOnHand).toBe(10);
    await reconOk(s);
  });
});
