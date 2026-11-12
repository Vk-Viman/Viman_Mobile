// Phase 11 (agent B) - activity reports: sales, purchases, drawings (with capital/transfer memo), printing variance.
// Figures are hand-calculated from the shared scenario (helpers/phase11ops.ts); the working is beside each assertion.
// Protects: API_CONTRACTS Wave 4 line definitions (revenue net of returns dated in the period, automatic + extra cost C13, voided excluded R1),
// BUSINESS_RULES 6/R12 (supplies are not P&L; variance), 9 (drawings and capital are below the line), R7 (business-date periods, additive rows).
//
// Window = ten days ago (D10) .. today (D0), day by day. Cents.
// SALES  D7: S1 6 x 2,000 = 12,000; automatic 6,667; extra 6 x 1,120 - 6,667 = 53.
//        D6: cart: shop P1 2 x 2,000 + P2 40 x 100 = 8,000 (automatic 2,222 + 2,000); telecom P3 20 x 100 = 2,000 (1,800).
//        D5: voided S5 (nothing); return R1 of 2 units: 4,000, automatic 2,222, extra 18.   D4: return R2 (1 unit damaged): 2,000, 1,111, 9.
// PURCHASES D10 PU1 10,000 | D9 PU2 12,000 + PU3 5,000 + PU4 4,500 (telecom) + PU6 600 = 22,100 | D8 PU5 3,000 voided (nothing), return PR1 2,000.
// DRAWINGS D3 cash shop 5,000, cash telecom 2,000 (a 700 one is voided) | D2 goods P1 1,111 (average cost), cash Ice Cream 3,000 (fund profit);
//          memo: capital D9 shop 20,000 + Ice Cream 4,000 (the 10,000,000 opening balance is NOT capital); transfer D5 6,000 (a 999 one is voided).
// PRINTING D6 BW 3 pages 4,500/1,950 + Colour 2 pages 4,000/1,300 | D5 BW 10 pages 15,000/6,500 (a 5-page one voided) | supplies D7 10,000, D5 3,000 (a 999 one voided).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { buy } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { cl, sellOk, voidSaleNew } from './helpers/phase5.ts';
import { lossNew, lossVoid, drawNew, drawVoid } from './helpers/phase4.ts';
import { drawCash, capNew, trNew, trVoid } from './helpers/phase9.ts';
import { capVoid } from './helpers/phase8.ts';
import { psNew, psVoid, supNew, supVoid } from './helpers/phase7.ts';
import { post } from './helpers/catalog.ts';
import { D, WINDOW, addMoneyRecords, buildScenario, rep, repXlsx } from './helpers/phase11ops.ts';
import type { Scenario } from './helpers/phase11ops.ts';

const env = new TestEnv();
let sc: Scenario;
let s: ApiBase;
beforeAll(async () => { sc = await buildScenario(env); s = sc.s; await addMoneyRecords(sc); }, 120000);
afterAll(async () => { await env.cleanup(); });

const day = (rows: any[], n: number) => rows.find((r) => r.period.label === D(n));

describe('GET /reports/sales', () => {
  it('per day: revenue net of returns, automatic + extra cost, gross profit, counts', async () => {
    const r = await rep(s, '/reports/sales', WINDOW());
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBe(11);
    expect(day(r.body.rows, 7)).toMatchObject({ salesCount: 1, returnCount: 0, salesRevenueCents: 12000, returnsCents: 0, revenueCents: 12000, costAutoCents: 6667, costExtraCents: 53, costCents: 6720, grossProfitCents: 5280 });
    // D6: revenue 4,000 + 4,000 + 2,000 = 10,000; automatic 2,222 + 2,000 + 1,800 = 6,022; profit 3,978. Two sales (one per book).
    expect(day(r.body.rows, 6)).toMatchObject({ salesCount: 2, salesRevenueCents: 10000, revenueCents: 10000, costAutoCents: 6022, costExtraCents: 0, grossProfitCents: 3978 });
    expect(day(r.body.rows, 6).byBook.shop).toMatchObject({ salesCount: 1, revenueCents: 8000, costCents: 4222, grossProfitCents: 3778 });
    expect(day(r.body.rows, 6).byBook.telecom).toMatchObject({ salesCount: 1, revenueCents: 2000, costCents: 1800, grossProfitCents: 200 });
    // D5: the return lands here, not on the sale's day; the voided S5 contributes nothing (0 sales)
    expect(day(r.body.rows, 5)).toMatchObject({ salesCount: 0, returnCount: 1, returnsCents: 4000, revenueCents: -4000, costAutoCents: -2222, costExtraCents: -18, costCents: -2240, grossProfitCents: -1760 });
    expect(day(r.body.rows, 4)).toMatchObject({ returnCount: 1, returnsCents: 2000, revenueCents: -2000, costAutoCents: -1111, costExtraCents: -9, costCents: -1120, grossProfitCents: -880 });
    // totals: sales revenue 22,000; returns 6,000; revenue 16,000; automatic 6,667 + 6,022 - 2,222 - 1,111 = 9,356; extra 53 - 18 - 9 = 26; cost 9,382; profit 6,618
    expect(r.body.totals).toMatchObject({ salesCount: 3, returnCount: 2, salesRevenueCents: 22000, returnsCents: 6000, revenueCents: 16000, costAutoCents: 9356, costExtraCents: 26, costCents: 9382, grossProfitCents: 6618, marginBp: 4136 });
    // shop: revenue 14,000 (20,000 - 6,000), automatic 7,556, extra 26, profit 6,418 | telecom: 2,000 / 1,800 / 200
    expect(r.body.totalsByBook.shop).toMatchObject({ salesCount: 2, salesRevenueCents: 20000, returnsCents: 6000, revenueCents: 14000, costAutoCents: 7556, costExtraCents: 26, grossProfitCents: 6418 });
    expect(r.body.totalsByBook.telecom).toMatchObject({ salesCount: 1, revenueCents: 2000, costCents: 1800, grossProfitCents: 200 });
    // additivity: day rows sum to the total
    for (const k of ['salesCount', 'returnCount', 'salesRevenueCents', 'returnsCents', 'revenueCents', 'costAutoCents', 'costExtraCents', 'costCents', 'grossProfitCents']) {
      expect(r.body.rows.reduce((a: number, x: any) => a + x[k], 0)).toBe(r.body.totals[k]);
    }
    expect(r.body.table.totals.grossProfitCents).toBe(6618);
  });

  it('top products come from the same figures; topN and book filter', async () => {
    const r = await rep(s, '/reports/sales', `${WINDOW()}&topN=2`);
    expect(r.body.topProducts.map((p: any) => [p.productName, p.grossProfitCents])).toEqual([['Cable', 4418], ['Pen', 2000]]);
    const t = await rep(s, '/reports/sales', `${WINDOW()}&book=telecom`);
    expect(t.body.totals).toMatchObject({ salesCount: 1, revenueCents: 2000, costCents: 1800, grossProfitCents: 200 });
    expect(t.body.topProducts.map((p: any) => p.productName)).toEqual(['Dialog card']);
  });

  it('months add up to the same total as days (grouped by month in the test)', async () => {
    const days = await rep(s, '/reports/sales', WINDOW());
    const months = await rep(s, '/reports/sales', `?from=${D(10)}&to=${D(0)}&granularity=month`);
    expect(months.body.totals).toEqual(days.body.totals);
    for (const m of months.body.rows) {
      const inMonth = days.body.rows.filter((x: any) => x.period.label.slice(0, 7) === m.period.label);
      expect(m.grossProfitCents).toBe(inMonth.reduce((a: number, x: any) => a + x.grossProfitCents, 0));
      expect(m.revenueCents).toBe(inMonth.reduce((a: number, x: any) => a + x.revenueCents, 0));
    }
    // a month row is clipped to the range
    expect(months.body.rows[0].period.from).toBe(D(10));
  });

  it('single day and empty range', async () => {
    const one = await rep(s, '/reports/sales', `?from=${D(6)}&to=${D(6)}`);
    expect(one.body.rows).toHaveLength(1);
    expect(one.body.totals.grossProfitCents).toBe(3978);
    const none = await rep(s, '/reports/sales', `?from=${D(20)}&to=${D(15)}`);
    expect(none.body.totals).toMatchObject({ salesCount: 0, revenueCents: 0, costCents: 0, grossProfitCents: 0, marginBp: null });
    expect(none.body.topProducts).toEqual([]);
  });
});

describe('GET /reports/purchases', () => {
  it('per day, net of purchase returns; voided purchase excluded; return in the return\'s period', async () => {
    const r = await rep(s, '/reports/purchases', WINDOW());
    expect(r.status).toBe(200);
    expect(day(r.body.rows, 10)).toMatchObject({ purchaseCount: 1, purchasesCents: 10000, returnsCents: 0, netCents: 10000 });
    expect(day(r.body.rows, 9)).toMatchObject({ purchaseCount: 4, purchasesCents: 22100, netCents: 22100 });     // 12,000 + 5,000 + 4,500 + 600
    expect(day(r.body.rows, 8)).toMatchObject({ purchaseCount: 0, purchasesCents: 0, returnCount: 1, returnsCents: 2000, netCents: -2000 });
    expect(r.body.totals).toEqual({ purchaseCount: 5, purchasesCents: 32100, returnCount: 1, returnsCents: 2000, netCents: 30100 });
    expect(r.body.rows.reduce((a: number, x: any) => a + x.netCents, 0)).toBe(30100);
  });

  // Supplier A: PU1 10,000 + PU2 12,000 + PU4 4,500 = 26,500 (3), returned 2,000 -> net 24,500. Supplier B: PU3 5,000 + PU6 600 = 5,600 (2).
  // Products: Cable 20 units 22,000, returned 2 / 2,000 -> net 18 / 20,000; Pen 100 / 5,000 (the voided 10 / 3,000 is not counted);
  //           Dialog card 50 / 4,500; Above minimum 6 / 600.
  it('by supplier and by product', async () => {
    const r = await rep(s, '/reports/purchases', WINDOW());
    expect(r.body.bySupplier.map((x: any) => [x.supplierName, x.purchaseCount, x.purchasesCents, x.returnsCents, x.netCents])).toEqual([
      ['Supplier A', 3, 26500, 2000, 24500], ['Supplier B', 2, 5600, 0, 5600],
    ]);
    expect(r.body.bySupplier.reduce((a: number, x: any) => a + x.netCents, 0)).toBe(30100);
    expect(r.body.byProduct.map((x: any) => [x.productName, x.unitsBought, x.boughtCents, x.unitsReturned, x.returnedCents, x.netUnits, x.netCents])).toEqual([
      ['Cable', 20, 22000, 2, 2000, 18, 20000], ['Pen', 100, 5000, 0, 0, 100, 5000], ['Dialog card', 50, 4500, 0, 0, 50, 4500], ['Above minimum', 6, 600, 0, 0, 6, 600],
    ]);
    expect(r.body.byProduct.reduce((a: number, x: any) => a + x.netCents, 0)).toBe(30100);
  });

  it('filters: book, supplier; months = days; single day; empty', async () => {
    expect((await rep(s, '/reports/purchases', `${WINDOW()}&book=telecom`)).body.totals).toMatchObject({ purchaseCount: 1, purchasesCents: 4500, netCents: 4500 });
    expect((await rep(s, '/reports/purchases', `${WINDOW()}&supplierId=${sc.supB}`)).body.totals).toMatchObject({ purchasesCents: 5600, returnsCents: 0 });
    expect((await rep(s, '/reports/purchases', `?from=${D(10)}&to=${D(0)}&granularity=month`)).body.totals)
      .toEqual((await rep(s, '/reports/purchases', WINDOW())).body.totals);
    expect((await rep(s, '/reports/purchases', `?from=${D(8)}&to=${D(8)}`)).body.totals).toMatchObject({ purchasesCents: 0, returnsCents: 2000, netCents: -2000 });
    expect((await rep(s, '/reports/purchases', `?from=${D(0)}&to=${D(0)}`)).body.totals.netCents).toBe(0);
  });
});

describe('GET /reports/drawings', () => {
  it('cash and goods drawings by book and period; capital and transfers only as memo lines', async () => {
    const r = await rep(s, '/reports/drawings', WINDOW());
    expect(r.status).toBe(200);
    expect(day(r.body.rows, 3)).toMatchObject({ cashShopCents: 5000, cashTelecomCents: 2000, cashCents: 7000, goodsCents: 0, totalCents: 7000 });   // the voided 700 is not counted
    expect(day(r.body.rows, 2)).toMatchObject({ goodsShopCents: 1111, cashIcecreamCents: 3000, cashCents: 3000, goodsCents: 1111, totalCents: 4111 });
    expect(day(r.body.rows, 9)).toMatchObject({ capitalCents: 24000, totalCents: 0 });                       // capital never inside the drawings total
    expect(day(r.body.rows, 5)).toMatchObject({ transfersCents: 6000, transferCount: 1, totalCents: 0 });    // voided 999 transfer not counted
    expect(day(r.body.rows, 10)).toMatchObject({ capitalCents: 0 });                                          // opening balance (10,000,000) is not capital
    expect(r.body.totals).toMatchObject({ cashCents: 10000, goodsCents: 1111, totalCents: 11111, capitalCents: 24000, transfersCents: 6000, transferCount: 1 });
    expect(r.body.byBook).toEqual([
      { book: 'shop', cashCents: 5000, goodsCents: 1111, totalCents: 6111, capitalCents: 20000 },
      { book: 'telecom', cashCents: 2000, goodsCents: 0, totalCents: 2000, capitalCents: 0 },
      { book: 'icecream', cashCents: 3000, goodsCents: 0, totalCents: 3000, capitalCents: 4000 },
    ]);
    expect(r.body.icecreamByFund).toEqual([{ fund: 'profit', cashCents: 3000 }]);
    expect(r.body.rows.reduce((a: number, x: any) => a + x.totalCents, 0)).toBe(11111);
  });

  it('book filter; months = days; empty and single day', async () => {
    const ice = await rep(s, '/reports/drawings', `${WINDOW()}&book=icecream`);
    expect(ice.body.totals).toMatchObject({ cashCents: 3000, goodsCents: 0, capitalCents: 4000, transfersCents: 0, transferCount: 0 });
    const tel = await rep(s, '/reports/drawings', `${WINDOW()}&book=telecom`);
    expect(tel.body.totals).toMatchObject({ cashCents: 2000, transfersCents: 6000, transferCount: 1 });   // the shop -> telecom transfer touches telecom too
    expect((await rep(s, '/reports/drawings', `?from=${D(10)}&to=${D(0)}&granularity=month`)).body.totals)
      .toEqual((await rep(s, '/reports/drawings', WINDOW())).body.totals);
    expect((await rep(s, '/reports/drawings', `?from=${D(3)}&to=${D(3)}`)).body.totals).toMatchObject({ totalCents: 7000 });
    expect((await rep(s, '/reports/drawings', `?from=${D(30)}&to=${D(20)}`)).body.totals).toMatchObject({ totalCents: 0, capitalCents: 0 });
  });
});

describe('GET /reports/printing-variance', () => {
  // D7 supplies 10,000 -> variance 10,000 | D6 sales 5 pages, revenue 8,500, standard cost 3 x 650 + 2 x 650 = 3,250, profit 5,250, variance -3,250
  // D5 sales 10 pages 15,000 / 6,500 profit 8,500, supplies 3,000 -> variance -3,500 | totals: 3 sales, 15 pages, revenue 23,500, standard 9,750,
  // profit 13,750, supplies 13,000, variance 13,000 - 9,750 = 3,250. The voided print sale and voided supplies change nothing.
  it('standard cost charged vs supplies spent, per period; supplies are not in gross profit', async () => {
    const r = await rep(s, '/reports/printing-variance', WINDOW());
    expect(r.status).toBe(200);
    expect(day(r.body.rows, 7)).toMatchObject({ salesCount: 0, revenueCents: 0, standardCostChargedCents: 0, grossProfitCents: 0, suppliesSpentCents: 10000, supplyCount: 1, varianceCents: 10000 });
    expect(day(r.body.rows, 6)).toMatchObject({ salesCount: 2, pages: 5, revenueCents: 8500, standardCostChargedCents: 3250, grossProfitCents: 5250, suppliesSpentCents: 0, varianceCents: -3250 });
    expect(day(r.body.rows, 5)).toMatchObject({ salesCount: 1, pages: 10, revenueCents: 15000, standardCostChargedCents: 6500, grossProfitCents: 8500, suppliesSpentCents: 3000, varianceCents: -3500 });
    expect(r.body.totals).toEqual({ salesCount: 3, pages: 15, revenueCents: 23500, standardCostChargedCents: 9750, grossProfitCents: 13750, suppliesSpentCents: 13000, supplyCount: 2, varianceCents: 3250 });
    expect(r.body.rows.reduce((a: number, x: any) => a + x.varianceCents, 0)).toBe(3250);
    // B/W: 4,500 + 15,000 = 19,500 revenue, 1,950 + 6,500 = 8,450 cost, profit 11,050, margin 11,050 / 19,500 = 56.67% = 5,667 bp; Colour 4,000 / 1,300 / 2,700 / 6,750 bp
    expect(r.body.byServiceType.map((x: any) => [x.code, x.salesCount, x.pages, x.revenueCents, x.standardCostCents, x.grossProfitCents, x.marginBp])).toEqual([
      ['BW_1S', 2, 13, 19500, 8450, 11050, 5667], ['CLR_1S', 1, 2, 4000, 1300, 2700, 6750],
    ]);
  });

  it('months = days, single day, empty', async () => {
    expect((await rep(s, '/reports/printing-variance', `?from=${D(10)}&to=${D(0)}&granularity=month`)).body.totals)
      .toEqual((await rep(s, '/reports/printing-variance', WINDOW())).body.totals);
    expect((await rep(s, '/reports/printing-variance', `?from=${D(6)}&to=${D(6)}`)).body.totals).toMatchObject({ revenueCents: 8500, varianceCents: -3250 });
    expect((await rep(s, '/reports/printing-variance', `?from=${D(30)}&to=${D(20)}`)).body.totals).toMatchObject({ revenueCents: 0, varianceCents: 0 });
  });
});

describe('voided records change nothing (R1)', () => {
  it('recording and then voiding records of every kind leaves every report identical', async () => {
    const ask = async () => JSON.stringify({
      sales: (await rep(s, '/reports/sales', WINDOW())).body, purchases: (await rep(s, '/reports/purchases', WINDOW())).body,
      drawings: (await rep(s, '/reports/drawings', WINDOW())).body, printing: (await rep(s, '/reports/printing-variance', WINDOW())).body,
      losses: (await rep(s, '/reports/stock-losses', WINDOW())).body, profit: (await rep(s, '/reports/product-profitability', WINDOW())).body,
      value: (await rep(s, '/reports/inventory/valuation')).body, valueD3: (await rep(s, '/reports/inventory/valuation', `?asOf=${D(3)}`)).body,
    });
    const before = await ask();
    const ok = (r: { status: number; body: any }) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r.body; };
    // a sale of 5 pens, a purchase of 5 pens, a loss, a goods drawing: each voided straight away
    const sale = (await sellOk(s, [cl(sc.p2, 5, 100)], { businessDate: D(3) })).sales[0];
    await voidSaleNew(s, sale.id);
    const pu = await buy(s, [{ productId: sc.p2, packs: 1, packSize: 5, lineTotalCents: 400 }], { businessDate: D(3) });
    await post(s.app, `/purchases/${pu.id}/void`, { reason: 'x' });
    await lossVoid(s, ok(await lossNew(s, sc.p2, 2, { businessDate: D(3) })).item.id);
    await drawVoid(s, ok(await drawNew(s, sc.p2, 2, { businessDate: D(3) })).item.id);
    await post(s.app, `/drawings/${ok(await drawCash(s, { businessDate: D(3), amountCents: 123 })).item.id}/void`, { reason: 'x' });
    await capVoid(s, ok(await capNew(s, { businessDate: D(3), amountCents: 321 })).item.id);
    await trVoid(s, ok(await trNew(s, { businessDate: D(3), amountCents: 77 })).item.id);
    await psVoid(s, ok(await psNew(s, { businessDate: D(3), qty: 4 })).item.id);
    await supVoid(s, ok(await supNew(s, { businessDate: D(3), amountCents: 555 })).item.id);
    expect(await ask()).toBe(before);
  });
});

describe('validation, xlsx and empty/future ranges (all period reports)', () => {
  const periodPaths = ['/reports/sales', '/reports/purchases', '/reports/drawings', '/reports/printing-variance', '/reports/stock-losses', '/reports/product-profitability', '/reports/backdated'];

  it.each(periodPaths)('%s: bad requests are 400', async (path) => {
    const f = D(5); const t = D(1);
    expect((await rep(s, path, `?to=${t}`)).status).toBe(400);                                  // from missing
    expect((await rep(s, path, `?from=${f}`)).status).toBe(400);                                // to missing
    expect((await rep(s, path, `?from=${t}&to=${f}`)).status).toBe(400);                        // from after to
    expect((await rep(s, path, '?from=2026-02-30&to=2026-03-01')).status).toBe(400);            // not a real date
    expect((await rep(s, path, '?from=yesterday&to=today')).status).toBe(400);
    expect((await rep(s, path, `?from=${f}&to=${t}&granularity=week`)).status).toBe(400);
    expect((await rep(s, path, '?from=2000-01-01&to=2030-01-01')).status).toBe(400);            // more than 3,660 days
    expect((await rep(s, path, `?from=${f}&to=${t}&format=pdf`)).status).toBe(400);
  });

  it('filters are validated', async () => {
    expect((await rep(s, '/reports/sales', `${WINDOW()}&book=icecream`)).status).toBe(400);     // sales are shop/telecom only
    expect((await rep(s, '/reports/sales', `${WINDOW()}&topN=0`)).status).toBe(400);
    expect((await rep(s, '/reports/drawings', `${WINDOW()}&book=other`)).status).toBe(400);
    expect((await rep(s, '/reports/stock-movements', '?type=bogus')).status).toBe(400);
    expect((await rep(s, '/reports/stock-movements', '?limit=0')).status).toBe(400);
    expect((await rep(s, '/reports/stock-movements', '?limit=201')).status).toBe(400);
    expect((await rep(s, '/reports/stock-movements', `?from=${D(1)}&to=${D(5)}`)).status).toBe(400);
    expect((await rep(s, '/reports/stock-movements', '?from=2026-13-01')).status).toBe(400);
    expect((await rep(s, '/reports/inventory/valuation', '?asOf=2026-02-30')).status).toBe(400);
    expect((await rep(s, '/reports/inventory/valuation', '?book=icecream')).status).toBe(400);
    expect((await rep(s, '/reports/low-stock', '?book=icecream')).status).toBe(400);
    expect((await rep(s, '/reports/backdated', `${WINDOW()}&limit=0`)).status).toBe(400);
  });

  it.each(periodPaths)('%s: a future range is accepted (queries are never rejected for the future) and shows nothing', async (path) => {
    const r = await rep(s, path, '?from=2099-01-01&to=2099-01-03');
    expect(r.status).toBe(200);
    expect(r.body.table.columns.length).toBeGreaterThan(0);
    expect(Array.isArray(r.body.warnings)).toBe(true);
  });

  it.each(periodPaths)('%s: xlsx download', async (path) => {
    const x = await repXlsx(s, path, WINDOW());
    expect(x.status).toBe(200);
    expect(x.isZip).toBe(true);
    expect(x.disposition).toContain('.xlsx');
  });

  it('JSON bodies carry table and warnings; reports are read-only (no audit rows written)', async () => {
    const before = (s.ctx.database.conn.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as unknown as { n: number }).n;
    for (const p of periodPaths) {
      const r = await rep(s, p, WINDOW());
      expect(r.body.table).toBeTruthy();
      expect(r.body.table.title).toBeTruthy();
    }
    expect((s.ctx.database.conn.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as unknown as { n: number }).n).toBe(before);
  });
});
