// PHASE 19 - AUDIT of R-VR: WEIGHTED-AVERAGE VALUATION, GAIN / SWEEP PATHS and every REPORT (Shop + Telecom day and month rows, Combined, dashboard, valuation,
// sales list, profitability, stock-losses report). Items (4), (5), (10), (11) of the audit brief. All numbers are NEW and worked out by hand.
//
// THE WORLD (all through the API; Shop opening 1,000,000 and Telecom opening 500,000 on 11-01; every purchase pays cash in full)
//   Step 1 (11-01) buys: G 10 units/1,000 (Shop); H 6/600 (Shop); T 8/800 (Telecom card); T2 4/600 (Telecom card).
//   Step 2 (11-02) sales: Shop cart  G x4 @300 (cashier cost 120 -> 480, extra 80; cogs round(1,000x4/10)=400) and H x3 @250 (cogs round(600x3/6)=300): shop sale 1,200+750 = 1,950.
//                          Telecom cart T x5 @150 = 750 (cogs round(800x5/8)=500, cost 110 -> 550, extra 50) and T2 x2 @400 = 800 (cogs round(600x2/4)=300, cost 160 -> 320, extra 20): 1,550.
//                          pools: G 6/600, H 3/300, T 3/300, T2 2/300.
//   Step 3 (11-03) returns: Rg = G x4 res (whole line: refund 1,200, cogs 400, extra 80)           -> G 10/1,000
//                           Rh = H x3 res (whole line: refund 750, cogs 300)                        -> H 6/600
//                           Rt = T x2 res (rev 300, cogs round(500x2/5)=200, extra round(50x2/5)=20) + T2 x1 DAMAGED (rev 400, cogs round(300/2)=150, extra round(20/2)=10):
//                                refund 700, cogs 350, extra 30; T 5/500; T2 unchanged 2/300; loss row 150 (no movement).
//   Step 4 (11-04) buys at DIFFERENT costs: G 5/250 (-> 15/1,250); H 3/450 (-> 9/1,050); T 5/100 (-> 10/600).
//   Step 5 (11-05) sales: Shop G x11 @300 = 3,300 (cogs round(1,250x11/15)=round(916.67)=917 -> G 4/333), H x6 @250 = 1,500 (cogs round(1,050x6/9)=700 -> H 3/350);
//                         Telecom T x7 @150 = 1,050 (cogs round(600x7/10)=420 -> T 3/180).
//   STATE A (before any void), by hand:
//     Shop cash: 1,000,000-1,600+1,950-1,950-700+4,800 = 1,002,500.  Telecom cash: 500,000-1,400+1,550-700-100+1,050 = 500,400.
//     Shop goods: sales 6,750, returns 1,950, revenue 4,800, auto 2,317-700 = 1,617, extra 80-80 = 0, gross 3,183, adjustments 0, net 3,183.
//     Telecom cards: sales 2,600, returns 700, revenue 1,900, auto 1,220-350 = 870, extra 70-30 = 40, gross 990, damaged-return loss 150, net 840.   Combined 4,023.
//   VOIDS (Rg, Rh, Rt, in that order of posting; none depends on another):
//     Rg: 4 units leave G; pool 4/333 -> removed min(400,333) = 333 -> 0/0 (333-333 = 0, no sweep). GAIN 400-333 = 67 (dated 11-03).
//     Rh: 3 units leave H; pool 3/350 -> removed min(300,350) = 300; qty reaches 0 with 50 left -> SWEEP 50 first (value-only), then 300 -> 0/0. gain 0, sweep 50 (11-03).
//     Rt: 2 units leave T; pool 3/180 -> removed min(200,180) = 180 -> 1/0 (ONE UNIT WITH ZERO VALUE stays: qty above 0 so no sweep). GAIN 20 (11-03). T2 loss row void.
//   STATE B (after the voids): shop goods: sales 6,750, returns 0, auto 2,317, extra 80, gross 4,353; adjustments: gain 67, sweep 50 -> net 50-67 = -17; net profit 4,353+17 = 4,370.
//     day rows shop: 11-02 = (1,200-480)+(750-300) = 1,170; 11-03 = +67-50 = +17; 11-05 = (3,300-917)+(1,500-700) = 3,183.   total 4,370.
//     telecom goods: sales 2,600, auto 1,220, extra 70, gross 1,310; gain 20 -> net 1,330; day rows: 11-02 = 750-500-50+800-300-20 = 680; 11-03 = +20; 11-05 = 1,050-420 = 630.
//     Combined: 5,700; day rows 1,850 / 37 / 3,813.
//     Cash B: shop 1,002,500+1,200+750 = 1,004,450; telecom 500,400+700 = 501,100. Stock B: G 0/0, H 0/0, T 1/0, T2 2/300.
//     identity shop: cash 1,004,450 - 1,000,000 = 4,450 (stock 0) minus net extra 80 = 4,370 ok.   telecom: 1,100 + stock 300 = 1,400 minus extra 70 = 1,330 ok.
//     valuation as of 11-03 (business-date basis, movements dated <= 11-03 incl. each void's two rows): G 6/(1,000-400+400-333)=667; H 3/(600-300+300-50-300)=250; T 3/(800-500+200-180)=320; T2 2/300.
//        (these include the gains/sweeps that the day row 11-03 shows: P&L and stock agree on every date: shop cash as of 11-03 = 1,000,350, + stock 917 = 1,001,267 -> +1,267 - 80 = 1,187
//         = 1,170 + 17.)
// =====================================================================================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct, mkTelecom } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { mvsByRef, poolOf } from './helpers/phase4.ts';
import { openNew } from './helpers/phase8.ts';
import { cashOfRef, cl, clc, returnOk, rl, sellOk } from './helpers/phase5.ts';
import { segNetFromTables, shopIdentity } from './helpers/phase14.ts';
import { dash } from './helpers/phase12.ts';
import { voidReturnOk } from './helpers/phase17.ts';
import { assertReturnLedgers, cashOf, dayRow, pnl, reconAll, rows } from './helpers/phase19rv.ts';
import { returnedQtyMismatches } from './helpers/phase17.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const mk = (s: ApiBase) => mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 });
const mkT = (s: ApiBase) => mkTelecom(s, { sellPriceCents: 10000, minPriceCents: 0 });
const check = async (s: ApiBase): Promise<void> => { await reconAll(s); assertReturnLedgers(s.ctx); expect(returnedQtyMismatches(s.ctx)).toBe(0); };

describe('W: gain, sweep and zero-value remainder paths across Shop, Telecom, Combined, dashboard', () => {
  it('states A (returns posted) and B (returns void) agree with the hand figures in every report', async () => {
    const s = await setup();
    const G = await mk(s); const H = await mk(s); const T = await mkT(s); const T2 = await mkT(s);
    await openNew(s, 'shop', { businessDate: '2025-11-01', amountCents: 1000000 });
    await openNew(s, 'telecom', { businessDate: '2025-11-01', amountCents: 500000 });
    await buy(s, [{ productId: G.id, packs: 1, packSize: 10, lineTotalCents: 1000 }, { productId: H.id, packs: 1, packSize: 6, lineTotalCents: 600 }], { businessDate: '2025-11-01' });
    await buy(s, [{ productId: T.id, packs: 1, packSize: 8, lineTotalCents: 800 }, { productId: T2.id, packs: 1, packSize: 4, lineTotalCents: 600 }], { businessDate: '2025-11-01' });
    expect(cashOf(s, 'shop')).toBe(998400);
    expect(cashOf(s, 'telecom')).toBe(498600);

    // step 2
    const sh = (await sellOk(s, [clc(G.id, 4, 300, 120), cl(H.id, 3, 250)], { businessDate: '2025-11-02' })).sales[0];
    expect(sh.items.map((x: any) => [x.revenueCents, x.cogsCents, x.extraCostCents])).toEqual([[1200, 400, 80], [750, 300, 0]]);
    const te = (await sellOk(s, [clc(T.id, 5, 150, 110), clc(T2.id, 2, 400, 160)], { businessDate: '2025-11-02' })).sales[0];
    expect(te.book).toBe('telecom');
    expect(te.items.map((x: any) => [x.revenueCents, x.cogsCents, x.extraCostCents])).toEqual([[750, 500, 50], [800, 300, 20]]);
    expect([poolOf(s, G.id), poolOf(s, H.id), poolOf(s, T.id), poolOf(s, T2.id)]).toEqual([{ qty: 6, value: 600 }, { qty: 3, value: 300 }, { qty: 3, value: 300 }, { qty: 2, value: 300 }]);

    // step 3
    const Rg = (await returnOk(s, sh.id, [rl(sh.items[0].id, 4, true)], { businessDate: '2025-11-03' })).item;
    const Rh = (await returnOk(s, sh.id, [rl(sh.items[1].id, 3, true)], { businessDate: '2025-11-03' })).item;
    const Rt = (await returnOk(s, te.id, [rl(te.items[0].id, 2, true), rl(te.items[1].id, 1, false)], { businessDate: '2025-11-03' })).item;
    expect([Rg, Rh, Rt].map((r) => [r.refundCents, r.cogsReversedCents, r.extraCostReversedCents])).toEqual([[1200, 400, 80], [750, 300, 0], [700, 350, 30]]);
    expect([poolOf(s, G.id), poolOf(s, H.id), poolOf(s, T.id), poolOf(s, T2.id)]).toEqual([{ qty: 10, value: 1000 }, { qty: 6, value: 600 }, { qty: 5, value: 500 }, { qty: 2, value: 300 }]);
    await check(s);

    // step 4 (different costs)
    await buy(s, [{ productId: G.id, packs: 1, packSize: 5, lineTotalCents: 250 }, { productId: H.id, packs: 1, packSize: 3, lineTotalCents: 450 }], { businessDate: '2025-11-04' });
    await buy(s, [{ productId: T.id, packs: 1, packSize: 5, lineTotalCents: 100 }], { businessDate: '2025-11-04' });
    expect([poolOf(s, G.id), poolOf(s, H.id), poolOf(s, T.id)]).toEqual([{ qty: 15, value: 1250 }, { qty: 9, value: 1050 }, { qty: 10, value: 600 }]);

    // step 5
    const sh2 = (await sellOk(s, [cl(G.id, 11, 300), cl(H.id, 6, 250)], { businessDate: '2025-11-05' })).sales[0];
    expect(sh2.items.map((x: any) => x.cogsCents)).toEqual([917, 700]);
    const te2 = (await sellOk(s, [cl(T.id, 7, 150)], { businessDate: '2025-11-05' })).sales[0];
    expect(te2.items[0].cogsCents).toBe(420);
    expect([poolOf(s, G.id), poolOf(s, H.id), poolOf(s, T.id), poolOf(s, T2.id)]).toEqual([{ qty: 4, value: 333 }, { qty: 3, value: 350 }, { qty: 3, value: 180 }, { qty: 2, value: 300 }]);
    await check(s);

    // ---- STATE A
    expect([cashOf(s, 'shop'), cashOf(s, 'telecom')]).toEqual([1002500, 500400]);
    let shop = (await pnl(s, 'shop', '2025-11-01', '2025-11-30')).totals;
    expect(shop.goods).toMatchObject({ salesCents: 6750, returnsCents: 1950, revenueCents: 4800, costAutomaticCents: 1617, costExtraCents: 0, grossProfitCents: 3183 });
    expect(shop.adjustments).toMatchObject({ netCents: 0, salesReturnVoidGainCents: 0 });
    expect(shop.netProfitCents).toBe(3183);
    let tel = (await pnl(s, 'telecom', '2025-11-01', '2025-11-30')).totals;
    expect(tel.cards).toMatchObject({ salesCents: 2600, returnsCents: 700, revenueCents: 1900, costAutomaticCents: 870, costExtraCents: 40, grossProfitCents: 990 });
    expect(tel.adjustments).toMatchObject({ damagedReturnLossesCents: 150, netCents: 150 });
    expect(tel.netProfitCents).toBe(840);
    let comb = (await pnl(s, 'combined', '2025-11-01', '2025-11-30')).totals;
    expect(comb.recognizedProfitCents).toBe(4023);
    let days = await pnl(s, 'shop', '2025-11-01', '2025-11-30', 'day');
    expect([dayRow(days, '2025-11-02'), dayRow(days, '2025-11-03'), dayRow(days, '2025-11-05')].map((r) => r.netProfitCents)).toEqual([1170, -1170, 3183]);
    days = await pnl(s, 'telecom', '2025-11-01', '2025-11-30', 'day');
    expect([dayRow(days, '2025-11-02'), dayRow(days, '2025-11-03'), dayRow(days, '2025-11-05')].map((r) => r.netProfitCents)).toEqual([680, -470, 630]);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 3183, ledgerProfit: 3183 });
    expect(segNetFromTables(s.ctx, 'shop', '2025-11-01', '2025-11-30')).toBe(3183);
    expect(segNetFromTables(s.ctx, 'telecom', '2025-11-01', '2025-11-30')).toBe(840);

    // ---- THE VOIDS
    const vg = await voidReturnOk(s, sh.id, Rg.id);
    expect(poolOf(s, G.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', Rg.id).map((m) => [m.type, m.qty, m.value, m.unit, m.date])).toEqual([['sale_return', 4, 400, 100, '2025-11-03'], ['sale_return', -4, -333, 83, '2025-11-03']]);
    expect(vg.warnings).toEqual([]);
    const vh = await voidReturnOk(s, sh.id, Rh.id);
    expect(poolOf(s, H.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', Rh.id).map((m) => [m.type, m.qty, m.value])).toEqual([['sale_return', 3, 300], ['adjustment', 0, -50], ['sale_return', -3, -300]]);
    expect(vh.item.status).toBe('void');
    await voidReturnOk(s, te.id, Rt.id);
    expect(poolOf(s, T.id)).toEqual({ qty: 1, value: 0 });
    expect(poolOf(s, T2.id)).toEqual({ qty: 2, value: 300 });
    expect(mvsByRef(s, 'sales_returns', Rt.id).map((m) => [m.type, m.qty, m.value, m.unit])).toEqual([['sale_return', 2, 200, 100], ['sale_return', -2, -180, 90]]);
    expect(rows(s.ctx, "SELECT status FROM stock_losses WHERE sales_return_id = ?", Rt.id)).toEqual([{ status: 'void' }]);
    expect(cashOfRef(s, 'sales_returns', Rt.id).map((c) => [c.book, c.type, c.amount_cents, c.business_date])).toEqual([['telecom', 'card_refund', -700, '2025-11-03'], ['telecom', 'card_refund', 700, '2025-11-03']]);
    await check(s);

    // ---- STATE B
    expect([cashOf(s, 'shop'), cashOf(s, 'telecom')]).toEqual([1004450, 501100]);
    shop = (await pnl(s, 'shop', '2025-11-01', '2025-11-30')).totals;
    expect(shop.goods).toMatchObject({ salesCents: 6750, returnsCents: 0, revenueCents: 6750, costAutomaticCents: 2317, costExtraCents: 80, grossProfitCents: 4353 });
    expect(shop.adjustments).toMatchObject({ salesReturnVoidGainCents: 67, residualSweepsCents: 50, damagedReturnLossesCents: 0, purchaseRefundGainCents: 0, netCents: -17 });
    expect(shop.netProfitCents).toBe(4370);
    tel = (await pnl(s, 'telecom', '2025-11-01', '2025-11-30')).totals;
    expect(tel.cards).toMatchObject({ salesCents: 2600, returnsCents: 0, revenueCents: 2600, costAutomaticCents: 1220, costExtraCents: 70, grossProfitCents: 1310 });
    expect(tel.adjustments).toMatchObject({ salesReturnVoidGainCents: 20, residualSweepsCents: 0, damagedReturnLossesCents: 0, netCents: -20 });
    expect(tel.netProfitCents).toBe(1330);
    comb = (await pnl(s, 'combined', '2025-11-01', '2025-11-30')).totals;
    expect(comb.recognizedProfitCents).toBe(5700);
    expect(comb.segments).toMatchObject({ shop: { recognizedProfitCents: 4370 }, telecom: { recognizedProfitCents: 1330 }, icecream: { recognizedProfitCents: 0 } });
    const sd = await pnl(s, 'shop', '2025-11-01', '2025-11-30', 'day');
    expect([dayRow(sd, '2025-11-02'), dayRow(sd, '2025-11-03'), dayRow(sd, '2025-11-05')].map((r) => r.netProfitCents)).toEqual([1170, 17, 3183]);
    expect(dayRow(sd, '2025-11-03').adjustments).toMatchObject({ salesReturnVoidGainCents: 67, residualSweepsCents: 50, netCents: -17 });
    expect(dayRow(sd, '2025-11-04').netProfitCents).toBe(0);
    const td = await pnl(s, 'telecom', '2025-11-01', '2025-11-30', 'day');
    expect([dayRow(td, '2025-11-02'), dayRow(td, '2025-11-03'), dayRow(td, '2025-11-05')].map((r) => r.netProfitCents)).toEqual([680, 20, 630]);
    const cd = await pnl(s, 'combined', '2025-11-01', '2025-11-30', 'day');
    expect([dayRow(cd, '2025-11-02'), dayRow(cd, '2025-11-03'), dayRow(cd, '2025-11-05')].map((r) => r.recognizedProfitCents)).toEqual([1850, 37, 3813]);
    // month granularity too, and the two granularities add up
    const sm = await pnl(s, 'shop', '2025-11-01', '2025-11-30', 'month');
    expect(sm.rows).toHaveLength(1);
    expect(sm.rows[0].netProfitCents).toBe(4370);
    expect(sd.rows.reduce((a: number, r: any) => a + r.netProfitCents, 0)).toBe(4370);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 4370, ledgerProfit: 4370 });
    expect(segNetFromTables(s.ctx, 'shop', '2025-11-01', '2025-11-30')).toBe(4370);
    expect(segNetFromTables(s.ctx, 'telecom', '2025-11-01', '2025-11-30')).toBe(1330);
    // telecom identity by hand: cash +1,100 + stock 300 = 1,400; minus extra 70 = 1,330
    expect(cashOf(s, 'telecom') - 500000 + 300 - 70).toBe(1330);

    // stock-losses report: memo lines
    const sl = (await get(s.app, '/reports/stock-losses?from=2025-11-01&to=2025-11-30&granularity=month')).body;
    expect(sl.totals).toMatchObject({ salesReturnVoidGainCents: 87, sweepCents: 50, stockAdjustmentsNetCents: -37 });
    const slShop = (await get(s.app, '/reports/stock-losses?from=2025-11-01&to=2025-11-30&granularity=month&book=shop')).body;
    expect(slShop.totals).toMatchObject({ salesReturnVoidGainCents: 67, sweepCents: 50, stockAdjustmentsNetCents: -17 });
    const slTel = (await get(s.app, '/reports/stock-losses?from=2025-11-01&to=2025-11-30&granularity=month&book=telecom')).body;
    expect(slTel.totals).toMatchObject({ salesReturnVoidGainCents: 20, sweepCents: 0, stockAdjustmentsNetCents: -20 });

    // sales list totals and product profitability: the voided returns are invisible
    const lst = (await get(s.app, '/sales?from=2025-11-01&to=2025-11-30&book=shop')).body.totals;
    expect(lst).toEqual({ revenueCents: 6750, cogsCents: 2317, extraCostCents: 80, costCents: 2397, refundsCents: 0 });
    const lstT = (await get(s.app, '/sales?from=2025-11-01&to=2025-11-30&book=telecom')).body.totals;
    expect(lstT).toEqual({ revenueCents: 2600, cogsCents: 1220, extraCostCents: 70, costCents: 1290, refundsCents: 0 });
    const prof = (await get(s.app, '/reports/product-profitability?from=2025-11-01&to=2025-11-30')).body.rows;
    const pr = (id: number) => prof.find((x: any) => x.productId === id);
    expect(pr(G.id)).toMatchObject({ soldQty: 15, returnedQty: 0, netQty: 15, revenueCents: 4500, costAutoCents: 1317, costExtraCents: 80, grossProfitCents: 3103 });
    expect(pr(H.id)).toMatchObject({ soldQty: 9, returnedQty: 0, revenueCents: 2250, costAutoCents: 1000, grossProfitCents: 1250 });
    expect(pr(T.id)).toMatchObject({ soldQty: 12, returnedQty: 0, revenueCents: 1800, costAutoCents: 920, costExtraCents: 50, grossProfitCents: 830 });
    expect(pr(T2.id)).toMatchObject({ soldQty: 2, returnedQty: 0, revenueCents: 800, costAutoCents: 300, costExtraCents: 20, grossProfitCents: 480 });
    const sr = (await get(s.app, '/reports/sales?from=2025-11-01&to=2025-11-30&granularity=month')).body;
    expect(sr.totals).toMatchObject({ salesRevenueCents: 9350, returnsCents: 0, revenueCents: 9350, costAutoCents: 3537, costExtraCents: 150, grossProfitCents: 5663 });

    // valuation: now, and as of 11-03 (business-date basis)
    const val = (await get(s.app, '/reports/inventory/valuation?includeZero=true')).body;
    const bb = (v: any, b: string) => v.byBook.find((x: any) => x.book === b);
    expect([bb(val, 'shop').qty, bb(val, 'shop').valueCents, bb(val, 'telecom').qty, bb(val, 'telecom').valueCents]).toEqual([0, 0, 3, 300]);
    expect(val.totals).toMatchObject({ qty: 3, valueCents: 300 });
    const val3 = (await get(s.app, '/reports/inventory/valuation?asOf=2025-11-03&includeZero=true')).body;
    const vi = (id: number) => val3.rows.find((x: any) => x.productId === id);
    expect([vi(G.id), vi(H.id), vi(T.id), vi(T2.id)].map((x) => [x.qty, x.valueCents])).toEqual([[6, 667], [3, 250], [3, 320], [2, 300]]);
    expect([bb(val3, 'shop').qty, bb(val3, 'shop').valueCents, bb(val3, 'telecom').qty, bb(val3, 'telecom').valueCents]).toEqual([9, 917, 5, 620]);
    // P&L and stock agree on a past date: shop cash as of 11-03 + stock as of 11-03 - 1,000,000 - extra 80 = cumulative profit to 11-03 (1,170 + 17)
    const cashTo3 = rows(s.ctx, "SELECT COALESCE(SUM(amount_cents),0) c FROM cash_entries WHERE book='shop' AND business_date <= '2025-11-03'")[0]!.c;
    expect(Number(cashTo3)).toBe(1000350);
    expect(Number(cashTo3) + 917 - 1000000 - 80).toBe(1187);
    expect((await pnl(s, 'shop', '2025-11-01', '2025-11-03')).totals.netProfitCents).toBe(1187);

    // dashboard
    const d5 = (await dash(s, '2025-11-05')).body;
    expect(d5.today.bySegment.shop).toEqual({ salesCents: 4800, profitCents: 3183 });
    expect(d5.today.bySegment.telecom).toEqual({ salesCents: 1050, profitCents: 630 });
    expect(d5.month.bySegment.shop).toEqual({ salesCents: 6750, profitCents: 4370 });
    expect(d5.month.bySegment.telecom).toEqual({ salesCents: 2600, profitCents: 1330 });
    expect(d5.month.profitCents).toBe(5700);
    const d3 = (await dash(s, '2025-11-03')).body;
    expect(d3.today.bySegment.shop).toEqual({ salesCents: 0, profitCents: 17 });
    expect(d3.today.bySegment.telecom).toEqual({ salesCents: 0, profitCents: 20 });
    expect(d3.month.bySegment.shop).toEqual({ salesCents: 1950, profitCents: 1187 });
    expect(d3.month.bySegment.telecom).toEqual({ salesCents: 1550, profitCents: 700 });
    const cashApi = (await get(s.app, '/cashbooks')).body.books;
    expect(cashApi.find((b: any) => b.book === 'shop').balanceCents).toBe(1004450);
    expect(cashApi.find((b: any) => b.book === 'telecom').balanceCents).toBe(501100);
    await check(s);
  });
});

// =====================================================================================================================================
// S13 - ONE return with TWO LINES OF THE SAME PRODUCT, sweep on the LAST line of the void (pre-check adds both lines; the sweep happens once).
//   K: buy 5 units for 1,001 (11-10). Cart (11-11): line1 K x3 @500 = 1,500 (cogs round(1,001x3/5)=round(600.6)=601 -> 2/400); line2 K x2 @500 = 1,000 (cogs: whole pool 400 -> 0/0).
//   Return RK (11-12): both lines fully, resalable: line1 cogs 601 (whole line), line2 400 -> two restock movements: 3/601 then 2/400 -> pool 5/1,001. refund 2,500.
//   Buy K 5 units for 2,000 (11-13) -> 10/3,001. Sale (11-14) K x5 @500: cogs round(3,001x5/10)=round(1,500.5)=1,501 -> 5/1,500.
//   Void RK: onHand 5 >= needed 5. line1: 3 units at min(601,1,500)=601 -> 2/899. line2: 2 units at min(400,899)=400, qty reaches 0 with 899-400 = 499 left -> SWEEP 499 first, then 400 -> 0/0.
//   profit: revenue 1,500+1,000+2,500 = 5,000; cost 601+400+1,501 = 2,502; sweep 499 -> 1,999.  cash: -1,001+2,500-2,500-2,000+2,500+2,500 = +1,999, stock 0 -> ok.
// =====================================================================================================================================
describe('S13: two lines of one product in a single return', () => {
  it('both lines come out, exactly one sweep, hand figures', async () => {
    const s = await setup();
    const K = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-11-10', amountCents: 50000 });
    await buy(s, [{ productId: K.id, packs: 1, packSize: 5, lineTotalCents: 1001 }], { businessDate: '2025-11-10' });
    const sale = (await sellOk(s, [cl(K.id, 3, 500), cl(K.id, 2, 500)], { businessDate: '2025-11-11' })).sales[0];
    expect(sale.items.map((x: any) => x.cogsCents)).toEqual([601, 400]);
    const RK = (await returnOk(s, sale.id, [rl(sale.items[0].id, 3, true), rl(sale.items[1].id, 2, true)], { businessDate: '2025-11-12' })).item;
    expect([RK.refundCents, RK.cogsReversedCents]).toEqual([2500, 1001]);
    expect(poolOf(s, K.id)).toEqual({ qty: 5, value: 1001 });
    await buy(s, [{ productId: K.id, packs: 1, packSize: 5, lineTotalCents: 2000 }], { businessDate: '2025-11-13' });
    const sale2 = (await sellOk(s, [cl(K.id, 5, 500)], { businessDate: '2025-11-14' })).sales[0];
    expect(sale2.items[0].cogsCents).toBe(1501);
    expect(poolOf(s, K.id)).toEqual({ qty: 5, value: 1500 });
    await check(s);
    await voidReturnOk(s, sale.id, RK.id);
    expect(poolOf(s, K.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', RK.id).map((m) => [m.type, m.qty, m.value])).toEqual([
      ['sale_return', 3, 601], ['sale_return', 2, 400], ['sale_return', -3, -601], ['adjustment', 0, -499], ['sale_return', -2, -400]]);
    const t = (await pnl(s, 'shop', '2025-11-01', '2025-11-30')).totals;
    expect(t.adjustments).toMatchObject({ residualSweepsCents: 499, salesReturnVoidGainCents: 0, netCents: 499 });
    expect(t.netProfitCents).toBe(1999);
    expect(cashOf(s, 'shop')).toBe(50000 + 1999);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 1999, ledgerProfit: 1999 });
    await check(s);
  });
});

// =====================================================================================================================================
// S14 - ZERO values. (a) F: 4 units for 100; a FREE sale of 2 (price 0: revenue 0, no cash entry, cogs round(100x2/4)=50 -> 2/50). Return 1 unit: refund 0 (no cash entry), cogs round(50/2)=25 -> 3/75.
//   Void: no cash entry to reverse; 1 unit leaves at min(25,75)=25 -> 2/50. profit: -50 (state sale), -25 (returned), -50 (voided).
//   (b) Y: 3 units bought for 0 (zero-value stock). Sale 3 @100 = 300 (cogs 0, ZERO_COST warning). Return 2: refund 200, cogs 0, restock 2/0. Void: 2 units at min(0,0)=0 -> 0/0.
// =====================================================================================================================================
describe('S14: zero refund and zero cost returns', () => {
  it('a return with refund 0 has no cash entry and its void none either; a zero-cost return voids cleanly', async () => {
    const s = await setup();
    const F = await mk(s); const Y = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-12-01', amountCents: 10000 });
    await buy(s, [{ productId: F.id, packs: 1, packSize: 4, lineTotalCents: 100 }, { productId: Y.id, packs: 1, packSize: 3, lineTotalCents: 0 }], { businessDate: '2025-12-01' });
    const free = (await sellOk(s, [cl(F.id, 2, 0)], { businessDate: '2025-12-02' })).sales[0];
    expect(free).toMatchObject({ totalCents: 0 });
    expect(free.items[0]).toMatchObject({ revenueCents: 0, cogsCents: 50 });
    expect(cashOf(s, 'shop')).toBe(9900);
    const r = (await returnOk(s, free.id, [rl(free.items[0].id, 1, true)], { businessDate: '2025-12-03' })).item;
    expect([r.refundCents, r.cogsReversedCents]).toEqual([0, 25]);
    expect(poolOf(s, F.id)).toEqual({ qty: 3, value: 75 });
    expect(cashOfRef(s, 'sales_returns', r.id)).toEqual([]);
    expect((await pnl(s, 'shop', '2025-12-01', '2025-12-31')).totals.netProfitCents).toBe(-25);
    await check(s);
    const v = await voidReturnOk(s, free.id, r.id);
    expect(v.warnings).toEqual([]);
    expect(poolOf(s, F.id)).toEqual({ qty: 2, value: 50 });
    expect(cashOfRef(s, 'sales_returns', r.id)).toEqual([]);
    expect((await pnl(s, 'shop', '2025-12-01', '2025-12-31')).totals.netProfitCents).toBe(-50);
    expect(cashOf(s, 'shop')).toBe(9900);
    await check(s);

    const sy = await sellOk(s, [cl(Y.id, 3, 100)], { businessDate: '2025-12-04' });
    expect(sy.warnings.map((w: any) => w.code)).toContain('ZERO_COST');
    const ry = (await returnOk(s, sy.sales[0].id, [rl(sy.sales[0].items[0].id, 2, true)], { businessDate: '2025-12-05' })).item;
    expect([ry.refundCents, ry.cogsReversedCents]).toEqual([200, 0]);
    expect(poolOf(s, Y.id)).toEqual({ qty: 2, value: 0 });
    await voidReturnOk(s, sy.sales[0].id, ry.id);
    expect(poolOf(s, Y.id)).toEqual({ qty: 0, value: 0 });
    expect(cashOf(s, 'shop')).toBe(9900 + 300);
    expect((await pnl(s, 'shop', '2025-12-01', '2025-12-31')).totals.netProfitCents).toBe(-50 + 300);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 250, ledgerProfit: 250 });
    await check(s);
  });
});
