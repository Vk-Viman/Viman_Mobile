// PHASE 23 - "correct this entry" for POS sales: GET /sales/:id/correct-check, POST /sales/:id/correct-preview, POST /sales/:id/correct.
// A correction = the EXISTING void + the EXISTING create in ONE transaction (see API_CONTRACTS "Correction contract, Phase 1").
// Groups follow the eleven required test groups of the contract. Money in cents; hand calculations are in the comments.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, mvsByRef, poolOf, reconOk, sql } from './helpers/phase4.ts';
import { cashBal, cl, clc, returnOk, rl, sellOk, voidSaleNew } from './helpers/phase5.ts';
import { closeOk, expNew } from './helpers/phase8.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
const env2 = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); await env2.cleanup(); });
const setup = async (e: TestEnv = env): Promise<ApiBase> => apiBase(await e.build());
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });

const check = (s: ApiBase, id: number) => get(s.app, `/sales/${id}/correct-check`);
const preview = (s: ApiBase, id: number, items: unknown[], over: Record<string, unknown> = {}, reason = 'wrong quantity') =>
  post(s.app, `/sales/${id}/correct-preview`, { reason, replacement: { items, clientRef: ref(), ...over } });
const correct = (s: ApiBase, id: number, items: unknown[], over: Record<string, unknown> = {}, reason = 'wrong quantity') =>
  post(s.app, `/sales/${id}/correct`, { reason, replacement: { items, clientRef: ref(), ...over } });
const saleOf = async (s: ApiBase, id: number) => (await get(s.app, `/sales/${id}`)).body.item;
const links = async (s: ApiBase, ids: number[]) => (await get(s.app, `/corrections?entity=sales&ids=${ids.join(',')}`)).body.items;

/** Product with exactly `units` units worth `value` cents, bought today. */
async function stockedShop(s: ApiBase, units: number, value: number, over: Record<string, unknown> = {}) {
  const p = await shop0(s, over);
  await buy(s, [{ productId: p.id, packs: 1, packSize: units, lineTotalCents: value }]);
  return p;
}

// =============================================================================================
// (1) success
describe('sales correction - success', () => {
  // Hand calculation: pool 10 / 300,000 (unit 30,000). Sale of 4 @ 100,000 = revenue 400,000, COGS 120,000, cash +400,000, pool 6 / 180,000.
  // Correct to 5 @ 110,000: the void restores pool 10 / 300,000 and cash back to 0; the replacement takes 5 x 30,000 = 150,000 (pool 5 / 150,000),
  // revenue 550,000, cash +550,000. Same figures as a manual void followed by a manual create (checked in a second database).
  it('voids the original with the reason, posts the replacement, links both, ledgers equal manual void + create, nothing is off', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)], { notes: 'first' })).sales[0];

    const r = await correct(s, sale.id, [cl(P.id, 5, 110000)], { notes: 'fixed' }, '  typed 4 instead of 5  ');
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['comparison', 'correction', 'original', 'replacement', 'warnings']);
    expect(r.body.original).toMatchObject({ id: sale.id, status: 'void', voidReason: 'typed 4 instead of 5' });
    expect(r.body.replacement).toMatchObject({
      status: 'posted', book: 'shop', totalCents: 550000, cogsCents: 150000, extraCostCents: 0, businessDate: sale.businessDate, notes: 'fixed',
    });
    expect(r.body.replacement.id).toBeGreaterThan(sale.id);
    expect(r.body.correction).toMatchObject({ entity: 'sales', originalId: sale.id, replacementId: r.body.replacement.id, reason: 'typed 4 instead of 5' });
    expect(await links(s, [sale.id])).toEqual([r.body.correction]);
    expect(await links(s, [r.body.replacement.id])).toEqual([r.body.correction]);

    // both visible in the list
    const list = (await get(s.app, '/sales')).body;
    expect(list.items.map((x: any) => [x.id, x.status]).sort()).toEqual([[sale.id, 'void'], [r.body.replacement.id, 'posted']].sort());
    expect(list.totals.revenueCents).toBe(550000);

    expect(poolOf(s, P.id)).toEqual({ qty: 5, value: 150000 });
    expect(cashBal(s, 'shop')).toBe(550000);
    expect(count(s.ctx, 'corrections')).toBe(1);
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'correction' AND action = 'correct'")[0]!.n).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);
    await reconOk(s);

    // the same by hand in a second database
    const m = await setup(env2);
    const Q = await stockedShop(m, 10, 300000);
    const msale = (await sellOk(m, [cl(Q.id, 4, 100000)], { notes: 'first' })).sales[0];
    expect((await voidSaleNew(m, msale.id, 'typed 4 instead of 5')).status).toBe(200);
    const mrep = await sellOk(m, [cl(Q.id, 5, 110000)], { notes: 'fixed' });
    expect(poolOf(m, Q.id)).toEqual(poolOf(s, P.id));
    expect(cashBal(m, 'shop')).toBe(cashBal(s, 'shop'));
    expect(mrep.sales[0]).toMatchObject({ totalCents: 550000, cogsCents: 150000 });
    expect(mvsByRef(s, 'sales', r.body.replacement.id).map((x) => [x.qty, x.value])).toEqual(mvsByRef(m, 'sales', mrep.sales[0].id).map((x) => [x.qty, x.value]));
  });

  it('keeps the original date by default and takes an explicit businessDate; telecom sales are corrected too', async () => {
    const s = await setup();
    const T = await stockedShop(s, 10, 50000, { categoryId: s.ids['Scratch Cards'] });
    const sale = (await sellOk(s, [cl(T.id, 2, 10000)])).sales[0];
    expect(sale.book).toBe('telecom');
    const r = await correct(s, sale.id, [cl(T.id, 3, 10000)], { businessDate: today() });
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ book: 'telecom', totalCents: 30000, businessDate: today() });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a corrected sale can itself be corrected (chain)', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const s1 = (await sellOk(s, [cl(P.id, 1, 100000)])).sales[0];
    const r2 = (await correct(s, s1.id, [cl(P.id, 2, 100000)])).body;
    const r3 = await correct(s, r2.replacement.id, [cl(P.id, 3, 100000)]);
    expect(r3.status).toBe(201);
    expect(r3.body.original).toMatchObject({ id: r2.replacement.id, status: 'void' });
    expect(r3.body.replacement).toMatchObject({ totalCents: 300000, cogsCents: 90000, status: 'posted' });
    expect((await saleOf(s, s1.id)).status).toBe('void');
    expect(count(s.ctx, 'corrections')).toBe(2);
    expect((await links(s, [r2.replacement.id])).length).toBe(2);
    expect(poolOf(s, P.id)).toEqual({ qty: 7, value: 210000 });
    expect(cashBal(s, 'shop')).toBe(300000);
    expect(allProblems(s.ctx)).toEqual([]);
    // the first original cannot be corrected again
    expect(err(await correct(s, s1.id, [cl(P.id, 1, 100000)])).code).toBe('ALREADY_VOID');
  });
});

// =============================================================================================
// cost drift, comparison, C13
describe('sales correction - weighted-average cost drift and C13', () => {
  // Hand calculation: buy 10 @ 300,000 (unit 30,000). Sale of 4 @ 100,000: COGS 4 x 30,000 = 120,000, pool 6 / 180,000.
  // Buy 10 more @ 400,000 -> pool 16 / 580,000. The void restores 4 / 120,000 -> pool 20 / 700,000 (average 35,000).
  // Replacement 5 @ 100,000: COGS 700,000 x 5 / 20 = 175,000 (unit 35,000), revenue 500,000 -> pool 15 / 525,000.
  // comparison: revenue 400,000 -> 500,000; COGS 120,000 -> 175,000 (+55,000); extra 0 -> 0; unit cost 30,000 -> 35,000.
  it('shows the cost difference to the cent in the preview and in the real answer; the preview saves nothing', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    expect(sale.cogsCents).toBe(120000);
    await buy(s, [{ productId: P.id, packs: 1, packSize: 10, lineTotalCents: 400000 }]);
    expect(poolOf(s, P.id)).toEqual({ qty: 16, value: 580000 });

    const before = fingerprint(s.ctx);
    const pv = await preview(s, sale.id, [cl(P.id, 5, 100000)]);
    expect(pv.status).toBe(200);
    expect(fingerprint(s.ctx)).toBe(before);
    const expected = {
      originalCogsCents: 120000, replacementCogsCents: 175000, cogsDifferenceCents: 55000,
      originalExtraCostCents: 0, replacementExtraCostCents: 0, extraCostDifferenceCents: 0,
      originalRevenueCents: 400000, replacementRevenueCents: 500000,
      lines: [{ productId: P.id, originalUnitCostCents: 30000, replacementUnitCostCents: 35000 }],
    };
    expect(pv.body.comparison).toEqual(expected);
    expect(pv.body.original).toMatchObject({ id: sale.id, status: 'void' }); // what it WOULD be
    expect(pv.body.replacement).toMatchObject({ totalCents: 500000, cogsCents: 175000 });
    expect(Object.keys(pv.body).sort()).toEqual(['comparison', 'original', 'replacement', 'warnings']);
    expect((await saleOf(s, sale.id)).status).toBe('posted');

    const r = await correct(s, sale.id, [cl(P.id, 5, 100000)]);
    expect(r.status).toBe(201);
    expect(r.body.comparison).toEqual(expected);
    expect(r.body.replacement.items[0]).toMatchObject({ unitCostCents: 35000, cogsCents: 175000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 15, value: 525000 });
    // the original keeps its frozen snapshot
    expect((await saleOf(s, sale.id)).items[0]).toMatchObject({ unitCostCents: 30000, cogsCents: 120000 });
    expect(allProblems(s.ctx)).toEqual([]);
    await reconOk(s);
  });

  it('a product on one side only has a null unit cost on the other side; revenue and COGS are summed per sale', async () => {
    const s = await setup();
    const A = await stockedShop(s, 10, 100000); // unit 10,000
    const B = await stockedShop(s, 10, 200000); // unit 20,000
    const sale = (await sellOk(s, [cl(A.id, 2, 30000)])).sales[0]; // COGS 20,000
    const r = await correct(s, sale.id, [cl(B.id, 1, 50000), cl(A.id, 1, 30000)]);
    expect(r.status).toBe(201);
    expect(r.body.comparison).toEqual({
      originalCogsCents: 20000, replacementCogsCents: 30000, cogsDifferenceCents: 10000,
      originalExtraCostCents: 0, replacementExtraCostCents: 0, extraCostDifferenceCents: 0,
      originalRevenueCents: 60000, replacementRevenueCents: 80000,
      lines: [
        { productId: A.id, originalUnitCostCents: 10000, replacementUnitCostCents: 10000 },
        { productId: B.id, originalUnitCostCents: null, replacementUnitCostCents: 20000 },
      ],
    });
  });

  // Pool 10 / 300,000 (30,000). Original: 2 @ 100,000 with C13 unit cost 40,000: COGS 60,000, extra 80,000 - 60,000 = 20,000.
  // The replacement is entered with its own C13 cost 45,000 for 3 units: COGS 90,000, extra 135,000 - 90,000 = 45,000. The extra is
  // preserved exactly as entered in the replacement (the original's extra is NOT carried over), and COGS/stock ignore it.
  it('C13 extra cost is taken from the replacement body as entered; comparison reports both extras', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [clc(P.id, 2, 100000, 40000)])).sales[0];
    expect(sale).toMatchObject({ cogsCents: 60000, extraCostCents: 20000 });
    const r = await correct(s, sale.id, [clc(P.id, 3, 100000, 45000)]);
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ cogsCents: 90000, extraCostCents: 45000, chargedCostCents: 135000 });
    expect(r.body.comparison).toMatchObject({
      originalCogsCents: 60000, replacementCogsCents: 90000, originalExtraCostCents: 20000, replacementExtraCostCents: 45000, extraCostDifferenceCents: 25000,
    });
    expect(poolOf(s, P.id)).toEqual({ qty: 7, value: 210000 });
    // a replacement without a cost carries no extra
    const r2 = await correct(s, r.body.replacement.id, [cl(P.id, 3, 100000)]);
    expect(r2.body.replacement.extraCostCents).toBe(0);
    expect(r2.body.comparison.extraCostDifferenceCents).toBe(-45000);
    // below the automatic cost: refused by the existing C13 rule, nothing saved
    const fp = fingerprint(s.ctx);
    const bad = await correct(s, r2.body.replacement.id, [clc(P.id, 3, 100000, 100)]);
    expect(bad.status).toBe(422);
    expect(err(bad).code).toBe('COST_BELOW_AUTOMATIC');
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(allProblems(s.ctx)).toEqual([]);
  });
});

// =============================================================================================
// (2) atomic failure of the CREATE part, (3) void-side refusal
describe('sales correction - refusals leave the database unchanged', () => {
  it('create part refused (not enough stock, unknown product, future date, inactive) -> original still posted, fingerprint identical', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const fp = fingerprint(s.ctx);
    // restored goods would be 10 but 11 are asked for
    let r = await correct(s, sale.id, [cl(P.id, 11, 100000)]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('INSUFFICIENT_STOCK');
    expect(fingerprint(s.ctx)).toBe(fp);
    r = await correct(s, sale.id, [cl(999999, 1, 100000)]);
    expect(r.status).toBe(400);
    expect(fingerprint(s.ctx)).toBe(fp);
    r = await correct(s, sale.id, [cl(P.id, 1, 100000)], { businessDate: '2999-01-01' });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(fingerprint(s.ctx)).toBe(fp);
    // the same refusals in preview
    expect((await preview(s, sale.id, [cl(P.id, 11, 100000)])).status).toBe(422);
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await saleOf(s, sale.id)).status).toBe('posted');
    // exactly the goods of the original can be asked for again (the void restored them)
    expect((await correct(s, sale.id, [cl(P.id, 10, 100000)])).status).toBe(201);
  });

  it('body shape errors and a missing reason are 400 and save nothing; unknown sale is 404', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 1, 100000)])).sales[0];
    const fp = fingerprint(s.ctx);
    expect((await post(s.app, `/sales/${sale.id}/correct`, { replacement: { items: [cl(P.id, 1, 1)], clientRef: ref() } })).status).toBe(400);
    expect((await post(s.app, `/sales/${sale.id}/correct`, { reason: 'x', replacement: { items: [], clientRef: ref() } })).status).toBe(400);
    expect((await post(s.app, `/sales/${sale.id}/correct`, { reason: 'x', replacement: { items: [cl(P.id, 1, 1)] } })).status).toBe(400);
    const empty = await correct(s, sale.id, [cl(P.id, 1, 100000)], {}, '   ');
    expect(empty.status).toBe(400);
    expect(err(empty).code).toBe('VALIDATION_ERROR');
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await correct(s, 99999, [cl(P.id, 1, 100000)])).status).toBe(404);
    expect((await preview(s, 99999, [cl(P.id, 1, 100000)])).status).toBe(404);
    expect((await check(s, 99999)).status).toBe(404);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('a sale with posted returns is refused HAS_RETURNS by check, preview and correct; nothing changes; a voided return makes it eligible', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const ret = await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)]);
    const fp = fingerprint(s.ctx);
    const c = await check(s, sale.id);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ eligible: false, code: 'HAS_RETURNS' });
    expect(typeof c.body.message).toBe('string');
    for (const call of [preview, correct]) {
      const r = await call(s, sale.id, [cl(P.id, 4, 100000)]);
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('HAS_RETURNS');
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    // take the return back (newest first) -> now eligible
    expect((await post(s.app, `/sales/${sale.id}/returns/${ret.item.id}/void`, { reason: 'undo' })).status).toBe(200);
    expect((await check(s, sale.id)).body).toEqual({ eligible: true });
    expect((await correct(s, sale.id, [cl(P.id, 4, 100000)])).status).toBe(201);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('mixed Shop + Telecom body, a body of the other book and an unknown product-mix are refused 400 VALIDATION_ERROR; nothing saved', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const T = await stockedShop(s, 10, 50000, { categoryId: s.ids['Scratch Cards'] });
    const sale = (await sellOk(s, [cl(P.id, 1, 100000)])).sales[0];
    const fp = fingerprint(s.ctx);
    for (const items of [[cl(P.id, 1, 100000), cl(T.id, 1, 10000)], [cl(T.id, 1, 10000)]]) {
      for (const call of [preview, correct]) {
        const r = await call(s, sale.id, items);
        expect(r.status).toBe(400);
        expect(err(r).code).toBe('VALIDATION_ERROR');
      }
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(count(s.ctx, 'sales')).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a replacement clientRef that belongs to another (or the original) sale is refused 409 and never linked', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const a = (await sellOk(s, [cl(P.id, 1, 100000)], { clientRef: 'cart-a' })).sales[0];
    const b = (await sellOk(s, [cl(P.id, 1, 100000)], { clientRef: 'cart-b' })).sales[0];
    const fp = fingerprint(s.ctx);
    for (const clientRef of ['cart-a', 'cart-b']) {
      const r = await correct(s, a.id, [cl(P.id, 1, 100000)], { clientRef });
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('CLIENT_REF_CONFLICT');
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await saleOf(s, b.id)).status).toBe('posted');
  });
});

// =============================================================================================
// (4) closed day and backdating, (5) negative cash
describe('sales correction - closed days, backdating, negative cash', () => {
  it('a sale on a closed day: check says DAY_CLOSED, preview and correct are refused 409 DAY_CLOSED, nothing changes; reopening makes it work', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 2, 100000)])).sales[0];
    const closing = await closeOk(s, 'shop', today());
    const fp = fingerprint(s.ctx);
    expect((await check(s, sale.id)).body).toMatchObject({ eligible: false, code: 'DAY_CLOSED' });
    for (const call of [preview, correct]) {
      const r = await call(s, sale.id, [cl(P.id, 1, 100000)]);
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('DAY_CLOSED');
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await post(s.app, `/daily-closings/${closing.id}/reopen`, { reason: 'fix' })).status).toBe(200);
    expect((await check(s, sale.id)).body).toEqual({ eligible: true });
    expect((await correct(s, sale.id, [cl(P.id, 1, 100000)])).status).toBe(201);
  });

  it('a replacement dated before a closed day is refused BACKDATE_BEFORE_CLOSED_DAY (create guard); the original stays posted', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 2, 100000)])).sales[0]; // today
    await closeOk(s, 'shop', daysAgo(1));
    const fp = fingerprint(s.ctx);
    expect((await check(s, sale.id)).body).toEqual({ eligible: true }); // the void alone is allowed
    for (const call of [preview, correct]) {
      const r = await call(s, sale.id, [cl(P.id, 1, 100000)], { businessDate: daysAgo(3) });
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await saleOf(s, sale.id)).status).toBe('posted');
    // a date after the closed day is fine
    expect((await correct(s, sale.id, [cl(P.id, 1, 100000)], { businessDate: today() })).status).toBe(201);
  });

  it('a sale dated before a closed day cannot be voided, so it cannot be corrected (BACKDATE_BEFORE_CLOSED_DAY from the void)', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 2, 100000)])).sales[0]; // today
    await closeOk(s, 'shop', today());
    const fp = fingerprint(s.ctx);
    // the sale's own day is closed -> DAY_CLOSED wins over the backdating message
    expect(err(await correct(s, sale.id, [cl(P.id, 1, 100000)])).code).toBe('DAY_CLOSED');
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  // No opening balance: sale +400,000 (cash 400,000), an expense of 350,000 (cash 50,000). Voiding the sale takes cash to -350,000: a
  // WARNING (R13), never a block. The replacement adds +100,000 back, so the final balance is -250,000.
  it('negative cash stays a warning, not a block', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    expect((await expNew(s, { book: 'shop', amountCents: 350000 })).status).toBe(201);
    const fp = fingerprint(s.ctx);
    const pv = await preview(s, sale.id, [cl(P.id, 1, 100000)]);
    expect(pv.status).toBe(200);
    expect(pv.body.warnings.some((w: any) => w.code === 'NEGATIVE_CASH_BALANCE' && w.book === 'shop')).toBe(true);
    expect(fingerprint(s.ctx)).toBe(fp);
    const r = await correct(s, sale.id, [cl(P.id, 1, 100000)]);
    expect(r.status).toBe(201);
    expect(r.body.warnings.filter((w: any) => w.code === 'NEGATIVE_CASH_BALANCE')).toHaveLength(1); // de-duplicated
    expect(cashBal(s, 'shop')).toBe(-250000);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('price below cost / minimum produce the usual non-blocking warnings in the answer', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000, { minPriceCents: 20000 });
    const sale = (await sellOk(s, [cl(P.id, 1, 100000)])).sales[0];
    const r = await correct(s, sale.id, [cl(P.id, 1, 10000)]);
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: any) => w.code).sort()).toEqual(['PRICE_BELOW_COST', 'PRICE_BELOW_MINIMUM']);
  });
});

// =============================================================================================
// (6) double submit, (7) concurrent, (8) check/preview agree, (9) already void
describe('sales correction - idempotency, concurrency, preview agreement, already void', () => {
  it('double submit with the same replacement clientRef: 201 then 200 replay with the same data, exactly one replacement, no second void', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const body = { reason: 'qty', replacement: { items: [cl(P.id, 5, 100000)], clientRef: 'fix-1' } };
    const a = await post(s.app, `/sales/${sale.id}/correct`, body);
    const fp = fingerprint(s.ctx);
    const b = await post(s.app, `/sales/${sale.id}/correct`, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replacement).toEqual(a.body.replacement);
    expect(b.body.original).toEqual(a.body.original);
    expect(b.body.correction).toEqual(a.body.correction);
    expect(b.body.comparison).toEqual(a.body.comparison);
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(count(s.ctx, 'sales')).toBe(2);
    expect(count(s.ctx, 'corrections')).toBe(1);
    // the same clientRef for a different original is a conflict
    const other = (await sellOk(s, [cl(P.id, 1, 100000)])).sales[0];
    const c = await post(s.app, `/sales/${other.id}/correct`, { reason: 'x', replacement: { items: [cl(P.id, 1, 100000)], clientRef: 'fix-1' } });
    expect(c.status).toBe(409);
    expect(err(c).code).toBe('CLIENT_REF_CONFLICT');
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('two concurrent corrections of the same original: exactly one wins, the other gets 409 ALREADY_VOID, no half-applied state', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const rs = await Promise.all([correct(s, sale.id, [cl(P.id, 2, 100000)]), correct(s, sale.id, [cl(P.id, 3, 100000)])]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(err(rs.find((r) => r.status === 409)!).code).toBe('ALREADY_VOID');
    expect(count(s.ctx, 'corrections')).toBe(1);
    expect(count(s.ctx, 'sales')).toBe(2);
    expect(sql(s, "SELECT COUNT(*) AS n FROM sales WHERE status = 'posted'")[0]!.n).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);
    await reconOk(s);
  });

  it('correct-check and correct-preview leave the fingerprint unchanged and agree with what the real call does', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const fp = fingerprint(s.ctx);
    expect((await check(s, sale.id)).body).toEqual({ eligible: true });
    const body = { reason: 'qty', replacement: { items: [cl(P.id, 5, 100000)], clientRef: 'pv-1' } };
    const pv = await post(s.app, `/sales/${sale.id}/correct-preview`, body);
    expect(pv.status).toBe(200);
    expect(fingerprint(s.ctx)).toBe(fp);
    const real = await post(s.app, `/sales/${sale.id}/correct`, body);
    expect(real.status).toBe(201);
    // the preview used the same ids the real call then used? only compare the business content
    const strip = (x: any) => ({ ...x, id: undefined, postedAt: undefined, voidedAt: undefined, items: x.items.map((i: any) => ({ ...i, id: undefined })) });
    expect(strip(pv.body.replacement)).toEqual(strip(real.body.replacement));
    expect(pv.body.comparison).toEqual(real.body.comparison);
    expect(pv.body.warnings).toEqual(real.body.warnings);
    expect({ ...pv.body.original, voidedAt: null }).toEqual({ ...real.body.original, voidedAt: null });
    // after the correction the check says not eligible (already void) and the preview of the voided original is refused
    const after = fingerprint(s.ctx);
    expect((await check(s, sale.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
    expect(err(await preview(s, sale.id, [cl(P.id, 1, 100000)])).code).toBe('ALREADY_VOID');
    expect(fingerprint(s.ctx)).toBe(after);
  });

  it('an already void sale: check says ALREADY_VOID, preview and correct are 409 ALREADY_VOID, nothing changes', async () => {
    const s = await setup();
    const P = await stockedShop(s, 10, 300000);
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    expect((await voidSaleNew(s, sale.id, 'oops')).status).toBe(200);
    const fp = fingerprint(s.ctx);
    expect((await check(s, sale.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
    for (const call of [preview, correct]) {
      const r = await call(s, sale.id, [cl(P.id, 1, 100000)]);
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('ALREADY_VOID');
    }
    expect(fingerprint(s.ctx)).toBe(fp);
  });
});

// =============================================================================================
// stock reconciliation on a mixed workload
describe('sales correction - stock quantities and values reconcile', () => {
  it('after several corrections, purchases and sales in between, every invariant holds and values equal the movements', async () => {
    const s = await setup();
    const A = await stockedShop(s, 10, 300000);
    const B = await stockedShop(s, 5, 100000);
    const s1 = (await sellOk(s, [cl(A.id, 3, 90000), cl(B.id, 2, 50000)])).sales[0];
    await buy(s, [{ productId: A.id, packs: 2, packSize: 5, lineTotalCents: 333333 }]);
    const r1 = (await correct(s, s1.id, [cl(B.id, 3, 50000), cl(A.id, 4, 90000)])).body;
    await sellOk(s, [cl(A.id, 1, 90000)]);
    const r2 = await correct(s, r1.replacement.id, [cl(A.id, 2, 80000)]);
    expect(r2.status).toBe(201);
    expect(allProblems(s.ctx)).toEqual([]);
    await reconOk(s);
    const bad = await correct(s, r2.body.replacement.id, [cl(B.id, 99, 1)]);
    expect(bad.status).toBe(422);
    expect(allProblems(s.ctx)).toEqual([]);
    expect(cashBal(s, 'shop')).toBe(sql(s, "SELECT COALESCE(SUM(total_cents),0) AS n FROM sales WHERE status = 'posted'")[0]!.n);
  });
});
