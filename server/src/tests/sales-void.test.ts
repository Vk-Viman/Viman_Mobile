// Sale voids (POST /sales/:id/void) - API level (Fastify inject, real temp database).
// Protects BUSINESS_RULES: R1 (a void never edits or deletes: status posted -> void, history stays), C6 (a void is the EXACT negation of
// the original: stock movements of the same type with negated quantity and value, the cash entry reversed by a negated entry that
// points back at it, both keeping the ORIGINAL business date and getting their own posting time), section 3 / C5 (stock and value
// return at the original snapshot cost, even after later purchases changed the average), HAS_RETURNS (a sale with returns cannot be
// voided - it would reverse the same goods twice), ALREADY_VOID, reason rules, audit, atomicity.
// Organised as: void effects (shop, telecom, backdated), refusals, reason validation, interplay with later stock changes and mixed
// carts, atomic rollback.
// NOTE closed days: the DAY_CLOSED refusal for voids inside a closed day arrives with Phase 8 (cash books and day close);
// there is nothing to test for it yet, so no test exists on purpose.
// Money in cents; hand calculations are in the comments.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, mvsByRef, num, poolOf, productsSnap, reconOk, sql } from './helpers/phase4.ts';
import {
  breakCash, cashBal, cashOfRef, cl, returnOk, rl, sellOk, snap5, stocked, stocked20, voidSaleNew,
} from './helpers/phase5.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });
const saleOf = async (s: ApiBase, id: number) => (await get(s.app, `/sales/${id}`)).body.item;

// =============================================================================================
// What a void writes.
describe('POST /sales/:id/void - effects', () => {
  // Hand calculation: pool 20 / 700,000. Sale of 4 @ 100,000: revenue 400,000, COGS 140,000 -> pool 16 / 560,000, shop cash +400,000.
  // Void: movement of type sale with +4 / +140,000 (exact negation, same ref, same date, same unit cost 35,000) -> pool 20 / 700,000;
  // cash entry sale_goods -400,000 with reverses_entry_id = the original; the sale's net cash is 0.
  it('restores stock and value exactly; reverses movements and cash exactly; sale marked void', async () => {
    const s = await setup();
    const P = await stocked20(s, shop0);
    const poolBefore = poolOf(s, P.id);
    const cashBefore = cashBal(s, 'shop');
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    expect(poolOf(s, P.id)).toEqual({ qty: 16, value: 560000 });

    const r = await voidSaleNew(s, sale.id, '  customer cancelled  ');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(r.body.item).toMatchObject({ id: sale.id, status: 'void', voidReason: 'customer cancelled', totalCents: 400000, cogsCents: 140000 });
    expect(r.body.item.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r.body.item.items).toEqual(sale.items);                               // lines never change
    expect(await saleOf(s, sale.id)).toEqual(r.body.item);

    // stock: back to exactly the pool before the sale
    expect(poolOf(s, P.id)).toEqual(poolBefore);
    const m = mvsByRef(s, 'sales', sale.id);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ type: 'sale', qty: -4, value: -140000, unit: 35000, date: today() });
    expect(m[1]).toMatchObject({ type: 'sale', qty: 4, value: 140000, unit: 35000, date: today(), productId: P.id });
    expect(m[1]!.id).toBeGreaterThan(m[0]!.id);
    expect(m[0]!.qty + m[1]!.qty).toBe(0);
    expect(m[0]!.value + m[1]!.value).toBe(0);

    // cash: reversal entry
    const cash = cashOfRef(s, 'sales', sale.id);
    expect(cash).toHaveLength(2);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'sale_goods', amount_cents: 400000, reverses_entry_id: null });
    expect(cash[1]).toMatchObject({ book: 'shop', type: 'sale_goods', amount_cents: -400000, reverses_entry_id: cash[0]!.id, business_date: today() });
    expect(cashBal(s, 'shop')).toBe(cashBefore);                                   // net cash 0
    await reconOk(s);
  });

  it('telecom sale void: card_sale reversal in the telecom book, shop untouched', async () => {
    const s = await setup();
    const T = await stocked(s, tel0, 100, 50000);
    const shopCash = cashBal(s, 'shop');
    const telBefore = cashBal(s, 'telecom');
    const sale = (await sellOk(s, [cl(T.id, 10, 600)])).sales[0];
    await voidSaleNew(s, sale.id);
    expect(poolOf(s, T.id)).toEqual({ qty: 100, value: 50000 });
    const cash = cashOfRef(s, 'sales', sale.id);
    expect(cash.map((c) => [c.book, c.type, c.amount_cents])).toEqual([['telecom', 'card_sale', 6000], ['telecom', 'card_sale', -6000]]);
    expect(cashBal(s, 'telecom')).toBe(telBefore);                                 // +6,000 then -6,000
    expect(cashBal(s, 'shop')).toBe(shopCash);
    await reconOk(s);
  });

  // The reversal belongs to the ORIGINAL business day (so that day's report is corrected), while its posting time is now.
  it('backdated sale: reversal movement and cash entry keep the ORIGINAL business date; audit records it', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)], { businessDate: daysAgo(5) })).sales[0];
    const r = await voidSaleNew(s, sale.id, 'wrong day');
    expect(r.status).toBe(200);
    expect(r.body.item.businessDate).toBe(daysAgo(5));
    expect(mvsByRef(s, 'sales', sale.id).map((m) => m.date)).toEqual([daysAgo(5), daysAgo(5)]);
    expect(cashOfRef(s, 'sales', sale.id).map((c) => c.business_date)).toEqual([daysAgo(5), daysAgo(5)]);
    const mv = mvsByRef(s, 'sales', sale.id);
    expect(mv[1]!.postedAt >= mv[0]!.postedAt).toBe(true);                         // own posting time, later than the original
    expect(sql(s, "SELECT business_date, backdated, action FROM audit_logs WHERE entity = 'sale' AND action = 'void'"))
      .toEqual([{ business_date: daysAgo(5), backdated: 1, action: 'void' }]);
  });

  // One audit row per void with the full before and after.
  it('audit: action void, before = the posted sale, after = the void sale, reason as the note', async () => {
    const { s, sale } = await (async () => {
      const s = await setup();
      const P = await stocked(s, shop0, 5, 5000);
      return { s, sale: (await sellOk(s, [cl(P.id, 1, 1500)])).sales[0] };
    })();
    const r = await voidSaleNew(s, sale.id, 'oops');
    const rowsA = auditRows(s.ctx, 'sale');
    expect(rowsA.map((a) => a.action)).toEqual(['create', 'void']);
    expect(rowsA[1]).toMatchObject({ entityId: String(sale.id) });
    expect(rowsA[1]!.before).toEqual(sale);
    expect(rowsA[1]!.after).toEqual(r.body.item);
    expect(sql(s, "SELECT note FROM audit_logs WHERE entity = 'sale' AND action = 'void'")).toEqual([{ note: 'oops' }]);
  });

  // A free sale had no cash entry, so there is nothing to reverse; stock is still restored.
  it('free sale (total 0): void restores stock and writes no cash reversal', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 0)])).sales[0];
    const cashBefore = num(s, 'SELECT COUNT(*) FROM cash_entries');
    expect((await voidSaleNew(s, sale.id)).status).toBe(200);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cashBefore);
    expect(poolOf(s, P.id)).toEqual({ qty: 5, value: 5000 });
  });

  // After a void, the same cart reference still answers with the original (now void) sale and creates nothing.
  it('a retry of the original cart (same clientRef) after the void returns the void sale and creates nothing', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const body = { businessDate: today(), items: [cl(P.id, 1, 1500)], clientRef: 'void-retry-001' };
    const first = await post(s.app, '/sales', body);
    await voidSaleNew(s, first.body.sales[0].id);
    const counts = snap5(s);
    const again = await post(s.app, '/sales', body);
    expect(again.status).toBe(200);
    expect(again.body.sales[0]).toMatchObject({ id: first.body.sales[0].id, status: 'void' });
    expect(snap5(s)).toEqual(counts);
  });
});

// =============================================================================================
// Refusals.
describe('POST /sales/:id/void - refusals', () => {
  it('second void -> 409 ALREADY_VOID; nothing more written', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    await voidSaleNew(s, sale.id, 'first');
    const counts = snap5(s);
    const r = await voidSaleNew(s, sale.id, 'second');
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('ALREADY_VOID');
    expect(snap5(s)).toEqual(counts);
    expect((await saleOf(s, sale.id)).voidReason).toBe('first');
    expect(poolOf(s, P.id)).toEqual({ qty: 5, value: 5000 });
    await reconOk(s);
  });

  // The restriction holds for every kind of return (resalable or damaged, partial or full): the sale stays posted.
  it.each([[true], [false]])('a sale with a return (resalable=%s) -> 409 HAS_RETURNS with the exact message; sale stays posted', async (resalable) => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    await returnOk(s, sale.id, [rl(sale.items[0].id, 1, resalable)]);
    const counts = snap5(s);
    const stock = productsSnap(s);
    const r = await voidSaleNew(s, sale.id);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('HAS_RETURNS');
    expect(err(r).message).toBe('This sale has returns, so it cannot be voided.');
    expect(snap5(s)).toEqual(counts);
    expect(productsSnap(s)).toBe(stock);
    expect((await saleOf(s, sale.id)).status).toBe('posted');
    await reconOk(s);
  });

  it('unknown sale -> 404 NOT_FOUND; non-numeric id -> 400', async () => {
    const s = await setup();
    const r = await voidSaleNew(s, 99999);
    expect(r.status).toBe(404);
    expect(err(r).code).toBe('NOT_FOUND');
    expect((await post(s.app, '/sales/abc/void', { reason: 'x' })).status).toBe(400);
  });
});

// =============================================================================================
// Reason validation.
describe('POST /sales/:id/void - reason', () => {
  it('reason is required, 1..200 characters after trimming, a string, and no other field is accepted', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 1, 1500)])).sales[0];
    const counts = snap5(s);
    for (const bad of [undefined, '', '   ', 'x'.repeat(201), 5, null, true]) {
      const body = bad === undefined ? {} : { reason: bad };
      const r = await post(s.app, `/sales/${sale.id}/void`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(err(r).fields.reason, JSON.stringify(body)).toBeTruthy();
    }
    const extra = await post(s.app, `/sales/${sale.id}/void`, { reason: 'ok', status: 'void' });
    expect(extra.status).toBe(400);
    expect(snap5(s)).toEqual(counts);
    expect((await saleOf(s, sale.id)).status).toBe('posted');
    const ok = await voidSaleNew(s, sale.id, 'x'.repeat(200));
    expect(ok.status).toBe(200);
    expect(ok.body.item.voidReason).toHaveLength(200);
  });
});

// =============================================================================================
// Interplay with later stock changes and mixed carts.
describe('POST /sales/:id/void - later activity and mixed carts', () => {
  // Hand calculation: P 10 / 10,000. Sale 1 sells 4 (COGS 4,000, pool 6 / 6,000). Sale 2 sells the remaining 6 (COGS 6,000, pool 0 / 0).
  // Voiding sale 1 is an INFLOW so it is still allowed: pool 4 / 4,000 (its snapshot cost back, nothing else).
  it('voiding a sale whose goods were later sold out is still allowed (inflow at the snapshot cost)', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const one = (await sellOk(s, [cl(P.id, 4, 1500)])).sales[0];
    await sellOk(s, [cl(P.id, 6, 1500)]);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    expect((await voidSaleNew(s, one.id)).status).toBe(200);
    expect(poolOf(s, P.id)).toEqual({ qty: 4, value: 4000 });
    await reconOk(s);
  });

  // Hand calculation: after sale 1 the pool is 6 / 6,000. A later purchase of 6 for 60,000 -> 12 / 66,000 (avg 5,500).
  // Voiding sale 1 adds back exactly its snapshot 4,000 (not 4 x 5,500 = 22,000): pool 16 / 70,000.
  it('void after a later purchase changed the average: value returns at the ORIGINAL snapshot (+4,000 exactly)', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const one = (await sellOk(s, [cl(P.id, 4, 1500)])).sales[0];
    await buy(s, [{ productId: P.id, packs: 1, packSize: 6, lineTotalCents: 60000 }]);
    expect(poolOf(s, P.id)).toEqual({ qty: 12, value: 66000 });
    await voidSaleNew(s, one.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 16, value: 70000 });
    await reconOk(s);
  });

  // Hand calculation: shop sale 2 x 1,500 = 3,000; telecom sale 4 x 700 = 2,800. Voiding the shop sale leaves the telecom sale posted
  // with its stock outflow and cash entry; list totals count only the telecom sale (revenue 2,800, COGS 4 x 500 = 2,000).
  it('mixed cart: voiding the shop sale leaves the telecom sale intact; GET /sales totals exclude the voided sale', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 5, 5000);
    const T = await stocked(s, tel0, 10, 5000);
    const [shop, tel] = (await sellOk(s, [cl(A.id, 2, 1500), cl(T.id, 4, 700)])).sales;
    await voidSaleNew(s, shop.id);
    expect((await saleOf(s, shop.id)).status).toBe('void');
    const telAfter = await saleOf(s, tel.id);
    expect(telAfter).toEqual(tel);                                                 // untouched, byte for byte
    expect(poolOf(s, A.id)).toEqual({ qty: 5, value: 5000 });
    expect(poolOf(s, T.id)).toEqual({ qty: 6, value: 3000 });
    expect(cashOfRef(s, 'sales', tel.id)).toHaveLength(1);
    const list = (await get(s.app, '/sales')).body;
    expect(list.total).toBe(2);                                                    // the void sale is still listed ...
    expect(list.totals).toEqual({ revenueCents: 2800, cogsCents: 2000, extraCostCents: 0, costCents: 2000, refundsCents: 0 });   // ... but never summed (C13: no extra, cost = COGS)
    expect((await get(s.app, '/sales?status=void')).body.items.map((x: any) => x.id)).toEqual([shop.id]);
    expect((await get(s.app, '/sales?status=posted')).body.items.map((x: any) => x.id)).toEqual([tel.id]);
    // the telecom sale can still be returned after the shop sale was voided
    expect((await post(s.app, `/sales/${tel.id}/returns`, { businessDate: today(), items: [rl(tel.items[0].id, 1, true)], clientRef: ref() })).status).toBe(201);
    await reconOk(s);
  });

  it('and the other way round: voiding the telecom sale leaves the shop sale intact', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 5, 5000);
    const T = await stocked(s, tel0, 10, 5000);
    const [shop, tel] = (await sellOk(s, [cl(A.id, 2, 1500), cl(T.id, 4, 700)])).sales;
    await voidSaleNew(s, tel.id);
    expect(await saleOf(s, shop.id)).toEqual(shop);
    expect(poolOf(s, T.id)).toEqual({ qty: 10, value: 5000 });
    expect(poolOf(s, A.id)).toEqual({ qty: 3, value: 3000 });
    await reconOk(s);
  });

  it('a multi-line sale is voided as a whole: every line\'s stock comes back', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 3, 1500), cl(B.id, 2, 800), cl(A.id, 1, 1500)])).sales[0];
    expect(mvsByRef(s, 'sales', sale.id)).toHaveLength(3);
    await voidSaleNew(s, sale.id);
    expect(poolOf(s, A.id)).toEqual({ qty: 10, value: 10000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 5, value: 2500 });
    expect(mvsByRef(s, 'sales', sale.id)).toHaveLength(6);
    await reconOk(s);
  });
});

// =============================================================================================
// Atomic rollback.
describe('atomic rollback (a failed void changes nothing)', () => {
  it('audit insert fails after the reversal movement and cash entry were written -> sale still posted, nothing reversed; retry works', async () => {
    quiet();
    const s = await setup();
    const P = await stocked20(s, shop0);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const counts = snap5(s);
    const stock = productsSnap(s);
    // break only the audit row of the void (the create row of the sale already exists)
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs
      WHEN NEW.entity = 'sale' AND NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    const r = await voidSaleNew(s, sale.id);
    expect(r.status).toBe(500);
    expect(snap5(s)).toEqual(counts);
    expect(productsSnap(s)).toBe(stock);
    expect((await saleOf(s, sale.id)).status).toBe('posted');
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await voidSaleNew(s, sale.id)).status).toBe(200);
    expect(poolOf(s, P.id)).toEqual({ qty: 20, value: 700000 });
    await reconOk(s);
  });

  it('the cash reversal fails -> the stock reversal is rolled back too', async () => {
    quiet();
    const s = await setup();
    const P = await stocked20(s, shop0);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const counts = snap5(s);
    const stock = productsSnap(s);
    breakCash(s.ctx, 'sale_goods');
    const r = await voidSaleNew(s, sale.id);
    expect(r.status).toBe(500);
    expect(snap5(s)).toEqual(counts);
    expect(productsSnap(s)).toBe(stock);
    expect((await saleOf(s, sale.id)).status).toBe('posted');
    await reconOk(s);
  });
});
