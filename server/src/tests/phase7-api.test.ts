// Phase 7 API tests: service types, print sales and printing supplies (BUSINESS_RULES sections 2, 6, 12; R1, R12, R13, R-FD).
// API level (Fastify inject, real temp database). Protects: the seeded price list and its editing, the R12 cost snapshot,
// revenue = qty x price, the shop cash entry of every sale / supply (+revenue `sale_service`, -amount `printing_supplies`),
// void by reversal (R1), warnings that never block (R13), idempotent `clientRef`, validation and error codes
// (400 / 404 / 409), R-FD future dates and the audit trail (with the backdated flag).
// Organised by endpoint: service types, print sales (create / list / get / void), printing supplies.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, get, post, put } from './helpers/catalog.ts';
import { apiBase, cashRows, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, FUTURE_MSG, num, sql } from './helpers/phase4.ts';
import {
  psNew, psVoid, SALE_KEYS, SEEDED, shopBalance, supNew, supVoid, SUPPLY_KEYS, TYPE_KEYS, typeIdOf, typeNew, typePut, typesGet,
} from './helpers/phase7.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

// =============================================================================================
describe('GET /print-service-types', () => {
  it('lists the seven seeded types in display order with the default price and standard cost; exact shape', async () => {
    const s = await setup();
    const r = await typesGet(s);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['items']);
    expect(r.body.items.map((t: any) => t.code)).toEqual(['BW_1S', 'BW_2S', 'CLR_1S', 'CLR_2S', 'PC_BW_1S', 'PC_BW_2S', 'CUSTOM']);
    for (const t of r.body.items) {
      expect(Object.keys(t).sort()).toEqual(TYPE_KEYS);
      expect([t.priceCents, t.costCents]).toEqual(SEEDED[t.code]);
      expect(t.active).toBe(true);
    }
    expect(r.body.items[0]).toMatchObject({ code: 'BW_1S', name: 'B/W print – one side', priceCents: 1500, costCents: 650, sortOrder: 1 });
  });

  it('?active=true / false filters; a bad value is 400; unknown query parameter is 400', async () => {
    const s = await setup();
    const id = await typeIdOf(s, 'CUSTOM');
    await typePut(s, id, { name: 'Custom image print', priceCents: 4000, costCents: 650, active: false });
    expect((await typesGet(s, '?active=true')).body.items.map((t: any) => t.code)).not.toContain('CUSTOM');
    expect((await typesGet(s, '?active=true')).body.items).toHaveLength(6);
    expect((await typesGet(s, '?active=false')).body.items.map((t: any) => t.code)).toEqual(['CUSTOM']);
    expect((await typesGet(s)).body.items).toHaveLength(7);
    expect((await typesGet(s, '?active=maybe')).status).toBe(400);
    expect((await typesGet(s, '?bogus=1')).status).toBe(400);
  });
});

describe('POST /print-service-types', () => {
  it('creates an active type at the end of the list (201) and audits it', async () => {
    const s = await setup();
    const r = await typeNew(s);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(TYPE_KEYS);
    expect(r.body.item).toMatchObject({ code: 'POSTER_A3', name: 'Poster A3', priceCents: 15000, costCents: 4000, active: true, sortOrder: 8 });
    expect((await typesGet(s)).body.items.at(-1).code).toBe('POSTER_A3');
    const a = auditRows(s.ctx, 'print_service_type');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', entityId: String(r.body.item.id), before: null });
    expect(a[0]!.after).toMatchObject({ code: 'POSTER_A3', priceCents: 15000 });
  });

  it('trims the name; a zero price / cost is allowed', async () => {
    const s = await setup();
    const r = await typeNew(s, { code: 'FREE_1', name: '  Free page  ', priceCents: 0, costCents: 0 });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ name: 'Free page', priceCents: 0, costCents: 0 });
  });

  it('duplicate code -> 409 DUPLICATE_CODE (also for a seeded code); nothing is created', async () => {
    const s = await setup();
    const before = num(s, 'SELECT COUNT(*) FROM print_service_types');
    const r = await typeNew(s, { code: 'BW_1S' });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('DUPLICATE_CODE');
    expect(err(r).fields.code).toBeTruthy();
    expect(num(s, 'SELECT COUNT(*) FROM print_service_types')).toBe(before);
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_service_type'")).toBe(0);
  });

  it('validation: code shape, blank name, negative / fractional / huge / string money, unknown or missing fields -> 400', async () => {
    const s = await setup();
    const bad: Array<Record<string, unknown>> = [
      { code: 'lower' }, { code: 'A' }, { code: 'A'.repeat(21) }, { code: 'HAS SPACE' }, { code: 'BAD-DASH' },
      { priceCents: -1 }, { costCents: -1 }, { priceCents: 10.5 }, { costCents: 0.1 }, { priceCents: '1500' }, { priceCents: null },
      { priceCents: 1_000_000_001 }, { name: 42 }, { extra: 1 },
    ];
    for (const over of bad) expect((await typeNew(s, over)).status, JSON.stringify(over)).toBe(400);
    expect((await typeNew(s, { name: '   ' })).status).toBe(400);
    expect(err(await typeNew(s, { name: '   ' })).code).toBe('VALIDATION_ERROR');
    expect((await typeNew(s, { name: 'x'.repeat(101) })).status).toBe(400);
    for (const k of ['code', 'name', 'priceCents', 'costCents']) {
      const body: Record<string, unknown> = { code: 'OK_1', name: 'Ok', priceCents: 1, costCents: 1 };
      delete body[k];
      expect((await post(s.app, '/print-service-types', body)).status, k).toBe(400);
    }
    expect(num(s, 'SELECT COUNT(*) FROM print_service_types')).toBe(7);
  });
});

describe('PUT /print-service-types/:id', () => {
  it('changes name, price, cost, active (audited with before/after); the code is unchanged', async () => {
    const s = await setup();
    const id = await typeIdOf(s, 'BW_1S');
    const r = await typePut(s, id, { name: 'B/W print 1 side', priceCents: 1800, costCents: 700, active: false });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id, code: 'BW_1S', name: 'B/W print 1 side', priceCents: 1800, costCents: 700, active: false });
    const a = auditRows(s.ctx, 'print_service_type');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'update' });
    expect(a[0]!.before).toMatchObject({ priceCents: 1500, costCents: 650, active: true });
    expect(a[0]!.after).toMatchObject({ priceCents: 1800, costCents: 700, active: false });
  });

  it('an unchanged save writes no audit row', async () => {
    const s = await setup();
    const id = await typeIdOf(s, 'BW_1S');
    const r = await typePut(s, id, { name: 'B/W print – one side', priceCents: 1500, costCents: 650, active: true });
    expect(r.status).toBe(200);
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_service_type'")).toBe(0);
  });

  it('404 for an unknown id; 400 for code in the body, missing fields, bad types, bad id', async () => {
    const s = await setup();
    const id = await typeIdOf(s, 'BW_1S');
    const ok = { name: 'X', priceCents: 1, costCents: 1, active: true };
    expect((await typePut(s, 9999, ok)).status).toBe(404);
    expect(err(await typePut(s, 9999, ok)).code).toBe('NOT_FOUND');
    expect((await typePut(s, id, { ...ok, code: 'NEW' })).status).toBe(400);
    expect((await typePut(s, id, { name: 'X', priceCents: 1, costCents: 1 })).status).toBe(400);
    expect((await typePut(s, id, { ...ok, active: 1 })).status).toBe(400);
    expect((await typePut(s, id, { ...ok, priceCents: -5 })).status).toBe(400);
    expect((await typePut(s, id, { ...ok, name: '  ' })).status).toBe(400);
    expect((await put(s.app, '/print-service-types/abc', ok)).status).toBe(400);
  });

  it('R12: a price / cost change never touches past sales; new sales snapshot the new values', async () => {
    const s = await setup();
    const id = await typeIdOf(s, 'BW_1S');
    const first = (await psNew(s, { qty: 2 })).body.item; // 2 x 1500 / 2 x 650
    await typePut(s, id, { name: 'B/W print – one side', priceCents: 2000, costCents: 800, active: true });
    const again = (await get(s.app, `/print-sales/${first.id}`)).body.item;
    expect(again).toMatchObject({ unitPriceCents: 1500, unitCostCents: 650, revenueCents: 3000, cogsCents: 1300 });
    const second = (await psNew(s, { qty: 2 })).body.item; // 2 x 2000 / 2 x 800
    expect(second).toMatchObject({ unitPriceCents: 2000, unitCostCents: 800, revenueCents: 4000, cogsCents: 1600 });
    // the description is the type name at the time of sale
    await typePut(s, id, { name: 'Renamed', priceCents: 2000, costCents: 800, active: true });
    expect((await get(s.app, `/print-sales/${second.id}`)).body.item.description).toBe('B/W print – one side');
  });
});

// =============================================================================================
describe('POST /print-sales', () => {
  it('3 B/W pages at the type price: revenue 4500, cost 1950, profit 2550; exact shape; +4500 shop cash `sale_service`', async () => {
    const s = await setup();
    const typeId = await typeIdOf(s, 'BW_1S');
    const r = await psNew(s, { qty: 3, clientRef: 'ps-create-0001', notes: '  for school  ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['item', 'warnings']);
    expect(r.body.warnings).toEqual([]);
    expect(Object.keys(r.body.item).sort()).toEqual(SALE_KEYS);
    expect(r.body.item).toMatchObject({
      businessDate: today(), backdated: false, serviceTypeId: typeId, serviceTypeCode: 'BW_1S', description: 'B/W print – one side', qty: 3,
      unitPriceCents: 1500, unitCostCents: 650, revenueCents: 4500, cogsCents: 1950, grossProfitCents: 2550, status: 'posted',
      voidedAt: null, voidReason: null, notes: 'for school', clientRef: 'ps-create-0001',
    });
    expect(r.body.item.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const cash = cashRows(s.ctx);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'sale_service', amount_cents: 4500, fund: null, ref_table: 'print_sales', ref_id: r.body.item.id,
      reverses_entry_id: null, business_date: today() });
    expect(shopBalance(s)).toBe(4500);
    expect((await get(s.app, `/print-sales/${r.body.item.id}`)).body.item).toEqual(r.body.item);
  });

  it('every seeded type sells at its own price and cost (hand-calculated, 5 pages)', async () => {
    const s = await setup();
    const expected: Record<string, [number, number]> = {
      BW_1S: [7500, 3250], BW_2S: [12500, 4500], CLR_1S: [10000, 3250], CLR_2S: [15000, 4500],
      PC_BW_1S: [5000, 3250], PC_BW_2S: [7500, 4500], CUSTOM: [20000, 3250],
    };
    let cash = 0;
    for (const [code, [rev, cogs]] of Object.entries(expected)) {
      const r = await psNew(s, { qty: 5 }, code);
      expect(r.status).toBe(201);
      expect([r.body.item.revenueCents, r.body.item.cogsCents, r.body.item.grossProfitCents]).toEqual([rev, cogs, rev - cogs]);
      cash += rev;
    }
    expect(shopBalance(s)).toBe(cash); // 7500+12500+10000+15000+5000+7500+20000 = 77500
    expect(cash).toBe(77500);
  });

  it('the unit price can be changed for one sale; the cost snapshot stays the type cost', async () => {
    const s = await setup();
    const r = await psNew(s, { qty: 4, unitPriceCents: 2200 }, 'CUSTOM');
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ unitPriceCents: 2200, unitCostCents: 650, revenueCents: 8800, cogsCents: 2600, grossProfitCents: 6200 });
    expect(r.body.warnings).toEqual([]);
    expect(shopBalance(s)).toBe(8800);
  });

  it('R13: price below the standard cost warns PRICE_BELOW_COST but is saved; price equal to cost does not warn', async () => {
    const s = await setup();
    const low = await psNew(s, { qty: 10, unitPriceCents: 649 }); // cost 650
    expect(low.status).toBe(201);
    expect(low.body.warnings).toEqual(['PRICE_BELOW_COST']);
    expect(low.body.item).toMatchObject({ revenueCents: 6490, cogsCents: 6500, grossProfitCents: -10 });
    const equal = await psNew(s, { qty: 1, unitPriceCents: 650 });
    expect(equal.body.warnings).toEqual([]);
    expect(equal.body.item.grossProfitCents).toBe(0);
    expect(shopBalance(s)).toBe(6490 + 650);
  });

  it('a free print (price 0) is saved with a warning and creates no cash entry; its void creates no reversal', async () => {
    const s = await setup();
    const r = await psNew(s, { qty: 2, unitPriceCents: 0 });
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual(['PRICE_BELOW_COST']);
    expect(r.body.item).toMatchObject({ revenueCents: 0, cogsCents: 1300, grossProfitCents: -1300 });
    expect(cashRows(s.ctx)).toHaveLength(0);
    const v = await psVoid(s, r.body.item.id);
    expect(v.status).toBe(200);
    expect(cashRows(s.ctx)).toHaveLength(0);
  });

  it('accepted extremes: qty 1 and qty 1,000,000; rejected: 0, -1, 1,000,001, fractional, string, null', async () => {
    const s = await setup();
    expect((await psNew(s, { qty: 1 })).status).toBe(201);
    const big = await psNew(s, { qty: 1_000_000 });
    expect(big.status).toBe(201);
    expect(big.body.item.revenueCents).toBe(1_500_000_000);
    for (const qty of [0, -1, 1_000_001, 2.5, '3', null]) expect((await psNew(s, { qty })).status, String(qty)).toBe(400);
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(2);
  });

  it('validation: unit price, ids, dates, notes, unknown / missing fields -> 400 VALIDATION_ERROR with fields', async () => {
    const s = await setup();
    for (const over of [{ unitPriceCents: -1 }, { unitPriceCents: 1.5 }, { unitPriceCents: '10' }, { unitPriceCents: 1_000_000_001 },
      { serviceTypeId: 0 }, { serviceTypeId: '1' }, { serviceTypeId: 1.5 }, { businessDate: '2026/01/01' }, { businessDate: 20260101 },
      { clientRef: 'short' }, { clientRef: 'has space in it' }, { extra: true }, { notes: 5 }]) {
      expect((await psNew(s, over)).status, JSON.stringify(over)).toBe(400);
    }
    for (const k of ['businessDate', 'serviceTypeId', 'qty', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), serviceTypeId: 1, qty: 1, clientRef: ref() };
      delete body[k];
      expect((await post(s.app, '/print-sales', body)).status, k).toBe(400);
    }
    const unknownType = await psNew(s, { serviceTypeId: 9999 });
    expect(unknownType.status).toBe(400);
    expect(err(unknownType)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { serviceTypeId: 'Service type not found.' } });
    const nonexistentDate = await psNew(s, { businessDate: '2026-02-30' });
    expect(nonexistentDate.status).toBe(400);
    expect(err(nonexistentDate).code).toBe('VALIDATION_ERROR');
    const longNote = await psNew(s, { notes: 'n'.repeat(501) });
    expect(longNote.status).toBe(400);
    expect(err(longNote).fields.notes).toBeTruthy();
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(0);
    expect(cashRows(s.ctx)).toHaveLength(0);
  });

  it('an inactive service type is refused with 409 SERVICE_TYPE_INACTIVE and nothing is saved; reactivating allows it again', async () => {
    const s = await setup();
    const id = await typeIdOf(s, 'CLR_1S');
    await typePut(s, id, { name: 'Colour print – one side', priceCents: 2000, costCents: 650, active: false });
    const r = await psNew(s, {}, 'CLR_1S');
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('SERVICE_TYPE_INACTIVE');
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(0);
    expect(cashRows(s.ctx)).toHaveLength(0);
    await typePut(s, id, { name: 'Colour print – one side', priceCents: 2000, costCents: 650, active: true });
    expect((await psNew(s, {}, 'CLR_1S')).status).toBe(201);
  });

  it('R-FD: tomorrow / a far future date -> 400 FUTURE_DATE_NOT_ALLOWED with the exact message; nothing saved', async () => {
    const s = await setup();
    for (const d of [daysAhead(1), daysAhead(400), '2999-12-31']) {
      const r = await psNew(s, { businessDate: d });
      expect(r.status, d).toBe(400);
      expect(err(r).code).toBe('FUTURE_DATE_NOT_ALLOWED');
      expect(err(r).message).toBe(FUTURE_MSG);
      expect(err(r).fields.businessDate).toBe(FUTURE_MSG);
    }
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(0);
    expect(cashRows(s.ctx)).toHaveLength(0);
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_sale'")).toBe(0);
  });

  it('backdated sale: allowed, flagged backdated in the response, and the audit row carries business_date + backdated=1', async () => {
    const s = await setup();
    const d = daysAgo(5);
    const r = await psNew(s, { businessDate: d });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ businessDate: d, backdated: true });
    expect(cashRows(s.ctx)[0]).toMatchObject({ business_date: d });
    const a = sql(s, "SELECT business_date, backdated, action FROM audit_logs WHERE entity = 'print_sale'");
    expect(a).toEqual([{ business_date: d, backdated: 1, action: 'create' }]);
    // today's sale is not backdated
    const t = await psNew(s, { businessDate: today() });
    expect(t.body.item.backdated).toBe(false);
    expect(sql(s, "SELECT backdated FROM audit_logs WHERE entity = 'print_sale' ORDER BY id").map((x) => x.backdated)).toEqual([1, 0]);
  });

  it('writes exactly one sale, one cash entry and one audit row (after = the saved sale)', async () => {
    const s = await setup();
    const r = await psNew(s);
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(1);
    const a = auditRows(s.ctx, 'print_sale');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', entityId: String(r.body.item.id), before: null });
    expect(a[0]!.after).toMatchObject({ qty: 3, revenueCents: 4500, cogsCents: 1950 });
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(0); // services hold no stock
  });

  it('idempotent: the same clientRef returns 200 with the ORIGINAL sale (even if the price changed) and writes nothing more', async () => {
    const s = await setup();
    const clientRef = 'ps-idem-000001';
    const a = await psNew(s, { clientRef, unitPriceCents: 600 }); // below cost -> warning on the first call only
    expect(a.status).toBe(201);
    expect(a.body.warnings).toEqual(['PRICE_BELOW_COST']);
    await typePut(s, await typeIdOf(s, 'BW_1S'), { name: 'B/W print – one side', priceCents: 3000, costCents: 650, active: false });
    const b = await psNew(s, { clientRef, qty: 99, unitPriceCents: 1 }, 'BW_1S');
    expect(b.status).toBe(200);
    expect(b.body.item).toEqual(a.body.item);
    expect(b.body.warnings).toEqual([]);
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_sale'")).toBe(1);
  });

  it('duplicate submission: two simultaneous identical requests save one sale (one 201, one 200)', async () => {
    const s = await setup();
    const body = { businessDate: today(), serviceTypeId: await typeIdOf(s, 'BW_1S'), qty: 2, clientRef: 'ps-double-0001' };
    const [x, y] = await Promise.all([post(s.app, '/print-sales', body), post(s.app, '/print-sales', body)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.item.id).toBe(y.body.item.id);
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(1);
    expect(shopBalance(s)).toBe(3000);
  });
});

// =============================================================================================
describe('GET /print-sales and /print-sales/:id', () => {
  it('lists newest business date first with totals of POSTED sales; voided sales are listed but not summed', async () => {
    const s = await setup();
    const a = (await psNew(s, { qty: 2, businessDate: daysAgo(2) })).body.item; // 3000 / 1300
    const b = (await psNew(s, { qty: 1, businessDate: daysAgo(1) }, 'CLR_2S')).body.item; // 3000 / 900
    const c = (await psNew(s, { qty: 4, businessDate: today() }, 'PC_BW_1S')).body.item; // 4000 / 2600
    await psVoid(s, b.id);
    const r = await get(s.app, '/print-sales');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'total', 'totals']);
    expect(r.body.items.map((x: any) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(r.body.total).toBe(3);
    // posted: a + c => revenue 3000 + 4000 = 7000, cost 1300 + 2600 = 3900, profit 3100
    expect(r.body.totals).toEqual({ revenueCents: 7000, cogsCents: 3900, grossProfitCents: 3100 });
  });

  it('filters: from / to (inclusive), serviceTypeId, status, and their combination', async () => {
    const s = await setup();
    const bw = await typeIdOf(s, 'BW_1S');
    const clr = await typeIdOf(s, 'CLR_1S');
    const s1 = (await psNew(s, { businessDate: daysAgo(10) })).body.item;
    const s2 = (await psNew(s, { businessDate: daysAgo(5) }, 'CLR_1S')).body.item;
    const s3 = (await psNew(s, { businessDate: daysAgo(5) })).body.item;
    const s4 = (await psNew(s, { businessDate: daysAgo(0) })).body.item;
    await psVoid(s, s3.id);
    const ids = async (q: string) => (await get(s.app, `/print-sales${q}`)).body.items.map((x: any) => x.id).sort((p: number, q2: number) => p - q2);
    expect(await ids(`?from=${daysAgo(5)}`)).toEqual([s2.id, s3.id, s4.id]);
    expect(await ids(`?to=${daysAgo(5)}`)).toEqual([s1.id, s2.id, s3.id]);
    expect(await ids(`?from=${daysAgo(5)}&to=${daysAgo(5)}`)).toEqual([s2.id, s3.id]);
    expect(await ids(`?serviceTypeId=${clr}`)).toEqual([s2.id]);
    expect(await ids(`?serviceTypeId=${bw}&status=posted`)).toEqual([s1.id, s4.id]);
    expect(await ids('?status=void')).toEqual([s3.id]);
    const v = await get(s.app, '/print-sales?status=void');
    expect(v.body.totals).toEqual({ revenueCents: 0, cogsCents: 0, grossProfitCents: 0 });
    expect(v.body.total).toBe(1);
    expect(await ids(`?from=${daysAhead(3)}`)).toEqual([]); // report dates in the future are not rejected (R-FD is for transactions)
  });

  it('paging: limit / offset slice the list, `total` and `totals` stay those of the whole filter', async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await psNew(s, { qty: 1, businessDate: daysAgo(i) });
    const p1 = await get(s.app, '/print-sales?limit=2&offset=0');
    const p2 = await get(s.app, '/print-sales?limit=2&offset=2');
    const p3 = await get(s.app, '/print-sales?limit=2&offset=4');
    expect([p1.body.items.length, p2.body.items.length, p3.body.items.length]).toEqual([2, 2, 1]);
    for (const p of [p1, p2, p3]) { expect(p.body.total).toBe(5); expect(p.body.totals.revenueCents).toBe(7500); }
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((x: any) => x.businessDate);
    expect(all).toEqual([0, 1, 2, 3, 4].map(daysAgo)); // newest first
  });

  it('bad query values -> 400 (limit 0 / 201, bad date, bad status, non-numeric id, unknown parameter); GET :id 404 / 400', async () => {
    const s = await setup();
    for (const q of ['?limit=0', '?limit=201', '?from=2026-13-01', '?to=2026-02-30', '?status=gone', '?serviceTypeId=x', '?offset=-1', '?foo=1']) {
      expect((await get(s.app, `/print-sales${q}`)).status, q).toBe(400);
    }
    expect((await get(s.app, '/print-sales?limit=200')).status).toBe(200);
    const nf = await get(s.app, '/print-sales/9999');
    expect(nf.status).toBe(404);
    expect(err(nf).code).toBe('NOT_FOUND');
    expect((await get(s.app, '/print-sales/abc')).status).toBe(400);
  });
});

describe('POST /print-sales/:id/void', () => {
  it('R1: marks the sale void, adds one reversing shop cash entry (-4500, reverses_entry_id, same business date); balance returns to 0', async () => {
    const s = await setup();
    const d = daysAgo(3);
    const created = (await psNew(s, { businessDate: d })).body.item;
    expect(shopBalance(s)).toBe(4500);
    const r = await psVoid(s, created.id, '  wrong qty  ');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(r.body.item).toMatchObject({ id: created.id, status: 'void', voidReason: 'wrong qty', revenueCents: 4500, cogsCents: 1950, businessDate: d });
    expect(r.body.item.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const cash = cashRows(s.ctx);
    expect(cash).toHaveLength(2);
    expect(cash[1]).toMatchObject({ book: 'shop', type: 'sale_service', amount_cents: -4500, reverses_entry_id: cash[0]!.id, ref_table: 'print_sales',
      ref_id: created.id, business_date: d });
    expect(shopBalance(s)).toBe(0);
    // the original cash row is untouched (append-only ledger)
    expect(cash[0]).toMatchObject({ amount_cents: 4500, reverses_entry_id: null });
  });

  it('audits the void (before posted, after void, reason as note, business date + backdated flag of the original date)', async () => {
    const s = await setup();
    const created = (await psNew(s, { businessDate: daysAgo(2) })).body.item;
    await psVoid(s, created.id, 'duplicate job');
    const rows = sql(s, "SELECT action, note, business_date, backdated, before_json, after_json FROM audit_logs WHERE entity = 'print_sale' ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'void', note: 'duplicate job', business_date: daysAgo(2), backdated: 1 });
    expect(JSON.parse(rows[1]!.before_json).status).toBe('posted');
    expect(JSON.parse(rows[1]!.after_json).status).toBe('void');
  });

  it('a second void -> 409 ALREADY_VOID and adds nothing', async () => {
    const s = await setup();
    const created = (await psNew(s)).body.item;
    expect((await psVoid(s, created.id)).status).toBe(200);
    const again = await psVoid(s, created.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(cashRows(s.ctx)).toHaveLength(2);
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_sale' AND action = 'void'")).toBe(1);
  });

  it('validation: reason required / blank / > 200 chars / wrong type -> 400; unknown id 404; unknown property 400', async () => {
    const s = await setup();
    const created = (await psNew(s)).body.item;
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'r'.repeat(201) }, { reason: 5 }, { reason: 'ok', extra: 1 }]) {
      expect((await post(s.app, `/print-sales/${created.id}/void`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(s.app, '/print-sales/9999/void', { reason: 'x' })).status).toBe(404);
    expect((await get(s.app, `/print-sales/${created.id}`)).body.item.status).toBe('posted');
    expect((await psVoid(s, created.id, 'r'.repeat(200))).status).toBe(200);
  });
});

// =============================================================================================
describe('POST /printing-supplies', () => {
  it('Rs 2,500.50 of toner: shop cash -250050 (`printing_supplies`), exact shape, audited, NO effect on print profit totals', async () => {
    const s = await setup();
    const r = await supNew(s, { amountCents: 250050, description: '  Toner HP 12A  ', clientRef: 'sup-create-001' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['item', 'warnings']);
    expect(Object.keys(r.body.item).sort()).toEqual(SUPPLY_KEYS);
    expect(r.body.item).toMatchObject({
      businessDate: today(), backdated: false, amountCents: 250050, description: 'Toner HP 12A', status: 'posted', voidedAt: null, voidReason: null,
      clientRef: 'sup-create-001',
    });
    const cash = cashRows(s.ctx);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'printing_supplies', amount_cents: -250050, fund: null, ref_table: 'printing_supplies',
      ref_id: r.body.item.id, reverses_entry_id: null });
    const a = auditRows(s.ctx, 'printing_supply');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', before: null });
    // R12: no P&L effect - print totals are untouched
    const totals = (await get(s.app, '/print-sales')).body.totals;
    expect(totals).toEqual({ revenueCents: 0, cogsCents: 0, grossProfitCents: 0 });
    expect((await get(s.app, `/printing-supplies/${r.body.item.id}`)).body.item).toEqual(r.body.item);
  });

  it('R13: warns NEGATIVE_CASH_BALANCE when the shop book goes below zero (saved anyway); no warning when sales cover it', async () => {
    const s = await setup();
    const neg = await supNew(s, { amountCents: 1000 });
    expect(neg.status).toBe(201);
    // Phase 8: the one shared warning shape (cash-warnings.ts). -1000 cents = -Rs. 10.00.
    expect(neg.body.warnings).toEqual([{
      code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -1000,
      message: 'The Shop cash book is now below zero (-Rs. 10.00). Check that the opening balance and sales are recorded.',
    }]);
    expect(shopBalance(s)).toBe(-1000);
    await psNew(s, { qty: 100 }); // +150000
    const ok = await supNew(s, { amountCents: 50000 });
    expect(ok.body.warnings).toEqual([]);
    expect(shopBalance(s)).toBe(-1000 + 150000 - 50000);
    // exact boundary: spend what is left -> balance 0 -> no warning
    const exact = await supNew(s, { amountCents: 99000 });
    expect(shopBalance(s)).toBe(0);
    expect(exact.body.warnings).toEqual([]);
  });

  it('validation: amount 0 / negative / fractional / string / above the cap, blank or long description, unknown / missing fields -> 400', async () => {
    const s = await setup();
    for (const over of [{ amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: '100' }, { amountCents: 1_000_000_000_001 },
      { description: '' }, { description: '   ' }, { description: 'd'.repeat(101) }, { description: 7 }, { businessDate: 'x' }, { clientRef: 'short' }, { extra: 1 }]) {
      expect((await supNew(s, over)).status, JSON.stringify(over)).toBe(400);
    }
    for (const k of ['businessDate', 'amountCents', 'description', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), amountCents: 100, description: 'x', clientRef: ref() };
      delete body[k];
      expect((await post(s.app, '/printing-supplies', body)).status, k).toBe(400);
    }
    expect((await supNew(s, { amountCents: 1_000_000_000_000 })).status).toBe(201);
    expect((await supNew(s, { amountCents: 1 })).status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM printing_supplies')).toBe(2);
  });

  it('R-FD: future date -> 400 FUTURE_DATE_NOT_ALLOWED (exact message), nothing saved; backdated is allowed and flagged in the audit', async () => {
    const s = await setup();
    const f = await supNew(s, { businessDate: daysAhead(1) });
    expect(f.status).toBe(400);
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect(num(s, 'SELECT COUNT(*) FROM printing_supplies')).toBe(0);
    expect(cashRows(s.ctx)).toHaveLength(0);
    const b = await supNew(s, { businessDate: daysAgo(7) });
    expect(b.status).toBe(201);
    expect(b.body.item.backdated).toBe(true);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'printing_supply'")).toEqual([{ business_date: daysAgo(7), backdated: 1 }]);
    expect(cashRows(s.ctx)[0]).toMatchObject({ business_date: daysAgo(7) });
  });

  it('idempotent by clientRef: repeat -> 200 original, no second cash entry; repeat with another amount still returns the original', async () => {
    const s = await setup();
    const a = await supNew(s, { clientRef: 'sup-idem-00001', amountCents: 5000 });
    const b = await supNew(s, { clientRef: 'sup-idem-00001', amountCents: 9999, description: 'other' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.item).toEqual(a.body.item);
    expect(b.body.warnings).toEqual([]);
    expect(num(s, 'SELECT COUNT(*) FROM printing_supplies')).toBe(1);
    expect(shopBalance(s)).toBe(-5000);
    const body = { businessDate: today(), amountCents: 700, description: 'ink', clientRef: 'sup-double-001' };
    const [x, y] = await Promise.all([post(s.app, '/printing-supplies', body), post(s.app, '/printing-supplies', body)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(num(s, 'SELECT COUNT(*) FROM printing_supplies')).toBe(2);
  });
});

describe('GET /printing-supplies and /printing-supplies/:id', () => {
  it('lists newest first; totals.amountCents sums POSTED purchases only; filters from / to / status; paging', async () => {
    const s = await setup();
    const a = (await supNew(s, { amountCents: 1000, businessDate: daysAgo(4) })).body.item;
    const b = (await supNew(s, { amountCents: 2000, businessDate: daysAgo(2) })).body.item;
    const c = (await supNew(s, { amountCents: 4000, businessDate: today() })).body.item;
    await supVoid(s, b.id);
    const all = await get(s.app, '/printing-supplies');
    expect(all.status).toBe(200);
    expect(Object.keys(all.body).sort()).toEqual(['items', 'total', 'totals']);
    expect(all.body.items.map((x: any) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(all.body.total).toBe(3);
    expect(all.body.totals).toEqual({ amountCents: 5000 });
    expect((await get(s.app, `/printing-supplies?from=${daysAgo(2)}`)).body.items.map((x: any) => x.id)).toEqual([c.id, b.id]);
    expect((await get(s.app, `/printing-supplies?to=${daysAgo(2)}`)).body.totals).toEqual({ amountCents: 1000 });
    expect((await get(s.app, '/printing-supplies?status=void')).body.items.map((x: any) => x.id)).toEqual([b.id]);
    expect((await get(s.app, '/printing-supplies?status=void')).body.totals).toEqual({ amountCents: 0 });
    const p = await get(s.app, '/printing-supplies?limit=1&offset=1');
    expect(p.body.items.map((x: any) => x.id)).toEqual([b.id]);
    expect(p.body.total).toBe(3);
    for (const q of ['?limit=0', '?limit=201', '?from=nope', '?status=x', '?bogus=1']) expect((await get(s.app, `/printing-supplies${q}`)).status, q).toBe(400);
    expect((await get(s.app, '/printing-supplies/9999')).status).toBe(404);
    expect((await get(s.app, '/printing-supplies/x')).status).toBe(400);
  });
});

describe('POST /printing-supplies/:id/void', () => {
  it('R1: adds a reversing +amount shop entry (reverses_entry_id, original date), the money is back; audited', async () => {
    const s = await setup();
    const d = daysAgo(2);
    const created = (await supNew(s, { amountCents: 123456, businessDate: d })).body.item;
    expect(shopBalance(s)).toBe(-123456);
    const r = await supVoid(s, created.id, 'bought twice');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'void', voidReason: 'bought twice', amountCents: 123456, businessDate: d });
    const cash = cashRows(s.ctx);
    expect(cash).toHaveLength(2);
    expect(cash[1]).toMatchObject({ book: 'shop', type: 'printing_supplies', amount_cents: 123456, reverses_entry_id: cash[0]!.id,
      ref_table: 'printing_supplies', ref_id: created.id, business_date: d });
    expect(shopBalance(s)).toBe(0);
    const a = sql(s, "SELECT action, note, business_date, backdated FROM audit_logs WHERE entity = 'printing_supply' ORDER BY id");
    expect(a[1]).toEqual({ action: 'void', note: 'bought twice', business_date: d, backdated: 1 });
  });

  it('second void 409 ALREADY_VOID; 404 unknown; reason validation 400', async () => {
    const s = await setup();
    const created = (await supNew(s)).body.item;
    expect((await post(s.app, `/printing-supplies/${created.id}/void`, { reason: '  ' })).status).toBe(400);
    expect((await supVoid(s, created.id)).status).toBe(200);
    const again = await supVoid(s, created.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(cashRows(s.ctx)).toHaveLength(2);
    expect((await supVoid(s, 9999)).status).toBe(404);
  });
});
