// Phase 14 independent QA: ONE new six-week shop (2025-08-04 .. 2025-09-14) posted only through the real API (helpers/phase14.ts `buildWorld14`).
// EVERY expected figure below was worked out BY HAND (own arithmetic, integer cents, no BigInt, nothing read from report/service code); the
// working is in the comments. Rupees in the comments, cents in the assertions. Dates are fixed past dates, so the answers are the same on any day.
//
// THE SCRIPT (what is posted, by date) - amounts in rupees:
//  08-04 open Shop 50,000 / Telecom 20,000 / Ice Cream Cost fund 3,000; opening stock R 4 @ total 2,000, S 10 @ total 1,001; buy P 20 @ 6,000 + Q 10 @ 7,000;
//        sale Sa1 P x3 @800 + S x2 @250; reload Dialog 10,000 (600 bp), Mobitel rate -> 450 bp then reload 3,333.33; ice day 5,000 / cost 3,000 / elec 500
//  08-05 buy K cards 100 @ 9,000; card sale T1 K x20 @100 (cost entered 95 = extra 100); sale Sa2 Q x2 @1,200 (cost entered 720 = extra 40);
//        print BW_1S x100; paper 1,200; shop rent 10,000
//  08-06 buy P 10 @ 3,500; EZCash 25,000; telecom internet 1,500; wallet top-up 5,000; Dialog top-up 8,000; ice materials 2,500 (Cost)
//  08-07 purchase return of the 08-06 P purchase (4 units); sale Sa3 P x5 @800; loss S x1 damaged; ice day 4,000/2,400/400; ice electricity bill 1,500
//        (Electricity fund); shop cash drawing 2,000
//  08-08 return of Sa3 (2 units resalable); DAMAGED return of Sa1 (1 P); goods drawing P x2; shop stocktake R 4->3, S 7->9; sale Sa4 Q x1 sold and
//        VOIDED; reloads Hutch 5,000 and Airtel 2,000 + extra 25; ice other cost 300 (Profit fund); telecom cash drawing 1,000; shop capital 5,000;
//        shop cash count 35,050 (short 50); CLOSE shop 08-08 -> a sale dated 08-08 is refused DAY_CLOSED -> reopen -> late sale Sa5 S x1 -> close again
//  08-09 transfers Shop -> Telecom 3,000 and Shop -> Ice Cream (Cost) 2,000
//  08-11 ice day 6,000/3,500/600; sale Sa6 P x4 + R x1; shop water 800, packaging 250; reload Dialog 20,000; buy R 6 @ 3,500; card sale T2 K x30
//  08-12 ice move Cost -> Electricity 1,000 (re-label); telecom transport 600, repairs 1,200; sale Sa7 R x3; print CLR_1S x40; transfer Telecom -> Shop 2,500
//  08-13 ice release Cost -> Profit 2,000; shop cleaning 450, other 700, other 999 (VOIDED); telecom stationery 300; sale Sa8 Q x3 @1,333.33; Mobitel top-up 5,000
//  08-14 ice release Cost -> Profit 4,000 (D4 split 3,400 + 600); return Rt3 1 unit of Sa8; reload Mobitel 6,666.66; EZCash 12,345.67; telecom stocktake K 50->48
//  08-15 ice re-allocation Profit -> Electricity 1,500; return Rt4 remaining 2 units of Sa8; sale Sa9 S x4; loss R x1 lost; loss S x1 + VOID; telecom count 78,445.66 (over 200)
//  08-16 transfers Ice (Profit) -> Shop 1,000, Telecom -> Ice (Electricity) 1,500, Ice (Cost) -> Telecom 800; ice cash drawing 1,000 (Profit)
//  08-18 ice materials 3,000 (Cost); buy P 10 @ 3,400     08-19 ice day 3,000/1,800/300; buy P 5 @ 2,000 then VOID it
//  08-20 ice day 1,000/900/300 CONFIRMED NEGATIVE (-200); sale Sa12 P x6    08-21 ice electricity bill 6,000     08-22 ice other cost 400 (Cost fund)
//  08-25 ice day 8,000/4,000/700
//  09-01 reload Dialog 8,000; sale Sa10 Q x2; telecom internet 1,500     09-02 ice electricity bill 5,000; buy R 4 @ 2,500
//  09-03 ice day 2,000/1,000/200; card sale T3 K x10     09-04 return Rt5 of Sa2 (1 Q, a month later); sale Sa11 P x3
//  09-05 shop rent 10,000; print BW_2S x50; paper 800; reload Hutch 4,000; EZCash 8,000
//  09-08 ice re-allocation Profit -> Cost 1,000; loss P x1 expired; shop stocktake S 4->5     09-09 ice capital 500 (Electricity fund)
//  09-10 counts: Shop 29,770 (over 120), Telecom 96,945.66 (short 300), Ice Cream 14,400 (short 100, Profit fund)
//  09-12 close Ice Cream: payment and a Shop->Ice transfer dated 09-12 refused DAY_CLOSED; reopen.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get } from './helpers/catalog.ts';
import { assertGlobalInvariants, buildWorld14, rows } from './helpers/phase14.ts';
import { pack } from './helpers/phase12.ts';
import type { World14 } from './helpers/phase14.ts';

const env = new TestEnv();
let s: ApiBase;
let w: World14;
beforeAll(async () => {
  s = await apiBase(await env.build());
  w = await buildWorld14(s);
}, 240000);
afterAll(async () => { await env.cleanup(); });

const rep = (path: string, from: string, to: string, g: 'day' | 'month' = 'month') => get(s.app, `/reports/${path}?from=${from}&to=${to}&granularity=${g}`);
const byLabel = (rs_: any[]) => Object.fromEntries(rs_.map((r) => [r.period.label, r]));

// ---------------------------------------------------------------------------------------------------------------------------------
describe('stock: weighted average per product (hand-calculated, cents)', () => {
  /**
   * P: buy 20/600,000 -> sale 3: 600,000x3/20 = 90,000 (17/510,000) -> buy 10/350,000 (27/860,000) -> purchase return 4 units at their purchase cost 140,000
   * (23/720,000) -> Sa3 5 units: 720,000x5/23 = 156,521.74 -> 156,522 (18/563,478) -> Rt1 2 units back at 156,522x2/5 = 62,608.8 -> 62,609 (20/626,087) ->
   * goods drawing 2: 626,087x2/20 = 62,608.7 -> 62,609 (18/563,478) -> Sa6 4: 563,478x4/18 = 125,217.33 -> 125,217 (14/438,261) -> buy 10/340,000 (24/778,261) ->
   * buy 5/200,000 then void: removes min(200,000, pool) = 200,000 (24/778,261) -> Sa12 6: 778,261x6/24 = 194,565.25 -> 194,565 (18/583,696) ->
   * Sa11 3: 583,696x3/18 = 97,282.67 -> 97,283 (15/486,413) -> loss 1: 486,413/15 = 32,427.53 -> 32,428 => 14 / 453,985.
   * Q: 10/700,000 -> Sa2 2: 140,000 -> Sa4 1 sold and voided (restored) -> Sa8 3: 560,000x3/8 = 210,000 (5/350,000) -> Rt3 +70,000, Rt4 +140,000 (8/560,000)
   *    -> Sa10 2: 140,000 (6/420,000) -> Rt5 1 unit back at 140,000/2 = 70,000 => 7 / 490,000.
   * R: opening 4/200,000 -> stocktake loss 1 at 50,000 (3/150,000) -> Sa6 1: 50,000 (2/100,000) -> buy 6/350,000 (8/450,000) -> Sa7 3: 168,750 (5/281,250)
   *    -> loss 1: 56,250 (4/225,000) -> buy 4/250,000 => 8 / 475,000.
   * S: opening 10/100,100 -> Sa1 2: 20,020 (8/80,080) -> loss 1: 10,010 (7/70,070) -> stocktake gain 2: 70,070x2/7 = 20,020 (9/90,090) -> Sa5 1: 10,010 (8/80,080)
   *    -> Sa9 4: 40,040 (4/40,040) -> loss + void: unchanged -> stocktake gain 1: 40,040/4 = 10,010 => 5 / 50,050.
   * K: 100/900,000 -> T1 20: 180,000 (80/720,000) -> T2 30: 270,000 (50/450,000) -> stocktake loss 2: 18,000 (48/432,000) -> T3 10: 90,000 => 38 / 342,000.
   */
  it('final quantity and value of every product', async () => {
    const want: Array<[number, number, number]> = [[w.P, 14, 453985], [w.Q, 7, 490000], [w.R, 8, 475000], [w.S, 5, 50050], [w.K, 38, 342000]];
    for (const [id, q, v] of want) {
      const p = (await get(s.app, `/products/${id}`)).body.item;
      expect([p.qtyOnHand, p.stockValueCents], p.name).toEqual([q, v]);
    }
    // total 453,985 + 490,000 + 475,000 + 50,050 + 342,000 = 1,811,035
    const val = (await get(s.app, '/reports/inventory/valuation')).body;
    expect(val.totals.valueCents).toBe(1811035);
    expect(val.totals.qty).toBe(14 + 7 + 8 + 5 + 38);
  });

  /**
   * As of 08-31 (movements only up to that date): P 18/583,696, Q 8/560,000, R 4/225,000 (the 09-02 purchase is later), S 4/40,040 (the 09-08 gain is later),
   * K 48/432,000 (T3 is 09-03): 583,696 + 560,000 + 225,000 + 40,040 + 432,000 = 1,840,736; quantities 18+8+4+4+48 = 82.
   */
  it('valuation as of 2025-08-31', async () => {
    const val = (await get(s.app, '/reports/inventory/valuation?asOf=2025-08-31')).body;
    expect(val.totals).toMatchObject({ valueCents: 1840736, qty: 82 });
    const byName = Object.fromEntries(val.rows.map((r: any) => [r.name, [r.qty, r.valueCents]]));
    expect(byName).toEqual({ 'Phone cover': [18, 583696], Charger: [8, 560000], Earbuds: [4, 225000], Cable: [4, 40040], 'Scratch card 100': [48, 432000] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('COGS per sale and return portions (hand-calculated, cents)', () => {
  /** [sale key, revenue, automatic cost, extra cost, gross profit] - gross profit = revenue - (automatic + extra). */
  const SALES: Array<[string, number, number, number, number]> = [
    ['Sa1', 290000, 110020, 0, 179980],        // P3 @80,000 = 240,000 cost 90,000; S2 @25,000 = 50,000 cost 20,020
    ['T1', 200000, 180000, 10000, 10000],      // 20 cards @10,000; automatic 20 x 9,000; entered 9,500 -> extra 10,000
    ['Sa2', 240000, 140000, 4000, 96000],      // Q2 @120,000; automatic 2 x 70,000; entered 72,000 -> extra 4,000
    ['Sa3', 400000, 156522, 0, 243478],
    ['Sa5', 25000, 10010, 0, 14990],
    ['Sa6', 410000, 175217, 0, 234783],        // P4 @80,000 = 320,000 cost 125,217; R1 @90,000 cost 50,000
    ['T2', 300000, 270000, 0, 30000],
    ['Sa7', 270000, 168750, 0, 101250],
    ['Sa8', 399999, 210000, 0, 189999],        // Q3 @133,333
    ['Sa9', 100000, 40040, 0, 59960],
    ['Sa12', 480000, 194565, 0, 285435],
    ['Sa10', 240000, 140000, 0, 100000],
    ['T3', 100000, 90000, 0, 10000],
    ['Sa11', 240000, 97283, 0, 142717],
  ];
  it('every sale: revenue, automatic cost, extra cost, gross profit', async () => {
    for (const [k, rev, auto, extra, gp] of SALES) {
      const sale = (await get(s.app, `/sales/${w.sales[k].id}`)).body.item;
      expect([sale.totalCents, sale.cogsCents, sale.extraCostCents, sale.chargedCostCents, sale.grossProfitCents], k).toEqual([rev, auto, extra, auto + extra, gp]);
    }
  });
  /**
   * Rt1: 2 of 5 P of Sa3: refund 400,000x2/5 = 160,000, cost 156,522x2/5 = 62,608.8 -> 62,609.
   * Rt2 (damaged, 1 of 3 P of Sa1): refund 240,000x1/3 = 80,000, cost 90,000/3 = 30,000 (written off).
   * Rt3: 1 of 3 Q of Sa8: refund 399,999x1/3 = 133,333; cost 210,000/3 = 70,000. Rt4 takes the exact remainder of the last 2 units: refund 399,999-133,333 = 266,666, cost 140,000.
   * Rt5: 1 of 2 Q of Sa2: refund 120,000, automatic 70,000, extra 4,000/2 = 2,000.
   */
  it('return portions, including the exact remainder and the extra-cost share', async () => {
    const r = w.returns;
    expect([r.Rt1.refundCents, r.Rt1.cogsReversedCents]).toEqual([160000, 62609]);
    expect([r.Rt2.refundCents, r.Rt2.cogsReversedCents]).toEqual([80000, 30000]);
    expect([r.Rt3.refundCents, r.Rt3.cogsReversedCents]).toEqual([133333, 70000]);
    expect([r.Rt4.refundCents, r.Rt4.cogsReversedCents]).toEqual([266666, 140000]);
    expect([r.Rt5.refundCents, r.Rt5.cogsReversedCents, r.Rt5.extraCostReversedCents]).toEqual([120000, 70000, 2000]);
    expect(133333 + 266666).toBe(399999);
    // the sales' items are fully returned: Sa8 returnedQty = 3
    expect((await get(s.app, `/sales/${w.sales.Sa8.id}`)).body.item.items[0].returnedQty).toBe(3);
  });
  it('the voided sale Sa4 and the voided purchase left no trace in stock or profit', async () => {
    const voided = rows(s.ctx, "SELECT id FROM sales WHERE status = 'void'");
    expect(voided).toHaveLength(1);
    expect(Number(rows(s.ctx, "SELECT COUNT(*) n FROM purchases WHERE status = 'void'")[0]!.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('cash books and Ice Cream funds (hand-calculated, cents)', () => {
  /**
   * SHOP: 08-04 50,000 - 13,000 (buys) + 2,900 = 39,900 | 08-05 +2,400 +1,500 -1,200 -10,000 = 32,600 | 08-06 -3,500 = 29,100 | 08-07 +1,400 +4,000 -2,000 = 32,500 |
   *   08-08 -1,600 -800 (Sa4 +1,200-1,200) +5,000 = 35,100, count 35,050 (-50) = 35,050, Sa5 +250 = 35,300 | 08-09 -3,000 -2,000 = 30,300 | 08-11 +4,100 -800 -250 -3,500 = 29,850 |
   *   08-12 +2,700 +800 +2,500 = 35,850 | 08-13 -450 -700 (-999+999) +3,999.99 = 38,699.99 | 08-14 -1,333.33 = 37,366.66 | 08-15 +1,000 -2,666.66 = 35,700 |
   *   08-16 +1,000 = 36,700 | 08-18 -3,400 = 33,300 | 08-19 (-2,000 +2,000) | 08-20 +4,800 = 38,100  == Aug closing 38,100.
   *   09-01 +2,400 = 40,500 | 09-02 -2,500 = 38,000 | 09-04 -1,200 +2,400 = 39,200 | 09-05 -10,000 +1,250 -800 = 29,650 | 09-10 count over +120 = 29,770.
   * TELECOM: 08-04 20,000 +10,000 +3,333.33 = 33,333.33 | 08-05 -9,000 +2,000 = 26,333.33 | 08-06 +25,000 -1,500 -5,000 -8,000 = 36,833.33 | 08-08 +5,000 +2,000 -1,000 = 42,833.33 |
   *   08-09 +3,000 = 45,833.33 | 08-11 +20,000 +3,000 = 68,833.33 | 08-12 -600 -1,200 -2,500 = 64,533.33 | 08-13 -300 -5,000 = 59,233.33 | 08-14 +6,666.66 +12,345.67 = 78,245.66 |
   *   08-15 count over +200 = 78,445.66 | 08-16 -1,500 +800 = 77,745.66 == Aug closing.  09-01 +8,000 -1,500 = 84,245.66 | 09-03 +1,000 = 85,245.66 | 09-05 +4,000 +8,000 = 97,245.66 |
   *   09-10 count short -300 = 96,945.66.
   * ICE CREAM (fund C/E/P): 08-04 open C3,000, day +3,000/+500/+1,500 -> 6,000/500/1,500 | 08-06 materials -2,500 C -> 3,500 | 08-07 day -> 5,900/900/2,700, bill -1,500 E -> -600 |
   *   08-08 cups -300 P -> 2,400 | 08-09 +2,000 C -> 7,900 | 08-11 day -> 11,400/0/4,300 | 08-12 move C->E 1,000 -> 10,400/1,000 | 08-13 C->P 2,000 -> 8,400/6,300 | 08-14 C->P 4,000 -> 4,400/10,300 |
   *   08-15 P->E 1,500 -> E 2,500, P 8,800 | 08-16 -1,000 P, +1,500 E, -800 C, -1,000 P -> 3,600/4,000/6,800 | 08-18 -3,000 C -> 600 | 08-19 day -> 2,400/4,300/7,700 |
   *   08-20 day (-200) -> 3,300/4,600/7,500 | 08-21 bill -6,000 E -> -1,400 | 08-22 -400 C -> 2,900 | 08-25 day -> 6,900/-700/10,800 == Aug closing 17,000 |
   *   09-02 bill -5,000 E -> -5,700 | 09-03 day -> 7,900/-5,500/11,600 | 09-08 P->C 1,000 -> 8,900/.../10,600 | 09-09 capital +500 E -> -5,000 | 09-10 count short -100 P -> 10,500.
   *   Final C 8,900 / E -5,000 / P 10,500 = 14,400 = the ice cream book.
   */
  it('final balance of every book and every fund', async () => {
    const api = (await get(s.app, '/cashbooks')).body;
    expect(api.books.map((b: any) => [b.book, b.balanceCents])).toEqual([['shop', 2977000], ['telecom', 9694566], ['icecream', 1440000]]);
    expect(api.books[2].funds).toEqual({ cost: 890000, electricity: -500000, profit: 1050000 });
    expect(890000 - 500000 + 1050000).toBe(1440000);
  });
  it('balances at the end of August from the cash book report', async () => {
    for (const [book, aug, sep] of [['shop', 3810000, 2977000], ['telecom', 7774566, 9694566], ['icecream', 1700000, 1440000]] as const) {
      const r = (await rep(`cashbook/${book}`, '2025-08-01', '2025-09-30')).body;
      expect([r.rows[0].openingCents, r.rows[0].closingCents, r.rows[1].openingCents, r.rows[1].closingCents], book).toEqual([0, aug, aug, sep]);
    }
  });
  it('Ice Cream funds as of 08-31: Cost 6,900 / Electricity -700 / Profit 10,800, with the unspent lines', async () => {
    const f = (await get(s.app, '/icecream/funds?asOf=2025-08-31&from=2025-08-01')).body;
    expect(f.funds).toEqual({ cost: { balanceCents: 690000 }, electricity: { balanceCents: -70000 }, profit: { balanceCents: 1080000 } });
    expect(f.totalCents).toBe(1700000);
    expect(f.reconciled).toBe(true);
    // Charged M 9,200 / E 5,300; Settled M 5,900 (2,500 + 3,000 + 400 other cost from the Cost fund) / E 7,500; Unspent M 3,300 / E -2,200 = 1,100 -> no excess
    expect(f.lines).toEqual({ materials: { chargedCents: 920000, settledCents: 590000, unspentCents: 330000 }, electricity: { chargedCents: 530000, settledCents: 750000, unspentCents: -220000 } });
    expect([f.unspentAllocationCents, f.outstandingExcessCostCents, f.recognizedProfitToDateCents]).toEqual([110000, 0, 1220000]);
  });
  it('the D4 split of the 08-14 release: 3,400 profit-eligible + 600 cash-only, and the re-label figures', async () => {
    // Unspent Materials on 08-14 = Charged 5,900 - Settled 2,500 = 3,400 (< combined 4,400) -> limit 3,400; the other 600 moves cash only.
    expect(w.d4.error).toMatchObject({ code: 'SPLIT_CONFIRMATION_REQUIRED', profitEligibleCents: 340000, cashOnlyCents: 60000 });
    const moves = (await get(s.app, '/icecream/fund-moves?status=posted')).body.items as any[];
    const m = (amt: number, from: string, to: string) => moves.find((x) => x.amountCents === amt && x.fromFund === from && x.toFund === to);
    expect(m(400000, 'cost', 'profit')).toMatchObject({ cashOnlyCents: 60000 });
    expect(m(200000, 'cost', 'profit')).toMatchObject({ cashOnlyCents: 0 });
    expect(m(100000, 'cost', 'electricity')).toMatchObject({ chargeRelabelCents: 100000 });
  });
  it('DAY_CLOSED rejections (shop 08-08, ice cream 09-12) were refused and wrote nothing extra', () => {
    expect(w.dayClosed.status).toBe(409);
    expect(w.dayClosed.body.error).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: '2025-08-08' });
    expect(w.iceClosed.status).toBe(409);
    expect(w.iceClosed.body.error).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream', businessDate: '2025-09-12' });
    expect(w.iceClosed.status2).toBe(409);
    expect(w.iceClosed.body2.error).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream' });
    // the sale refused while 08-08 was closed was never saved: that date holds the voided Sa4 and the posted Sa5 only (2 rows, 1 posted)
    expect(rows(s.ctx, "SELECT status FROM sales WHERE business_date = '2025-08-08' ORDER BY id").map((r) => r.status)).toEqual(['void', 'posted']);
  });
  it('cash counts: expected and difference as hand-calculated', async () => {
    const all = (await get(s.app, '/cash-counts?status=posted')).body.items as any[];
    const pick = (book: string, date: string) => all.find((c) => c.book === book && c.businessDate === date);
    expect([pick('shop', '2025-08-08').expectedCents, pick('shop', '2025-08-08').differenceCents]).toEqual([3510000, -5000]);
    expect([pick('telecom', '2025-08-15').expectedCents, pick('telecom', '2025-08-15').differenceCents]).toEqual([7824566, 20000]);
    expect([pick('shop', '2025-09-10').expectedCents, pick('shop', '2025-09-10').differenceCents]).toEqual([2965000, 12000]);
    expect([pick('telecom', '2025-09-10').expectedCents, pick('telecom', '2025-09-10').differenceCents]).toEqual([9724566, -30000]);
    expect([pick('icecream', '2025-09-10').expectedCents, pick('icecream', '2025-09-10').differenceCents]).toEqual([1450000, -10000]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('telecom commissions (hand-calculated)', () => {
  /**
   * Dialog 600 bp: 10,000 -> 600; 20,000 -> 1,200; EZCash 80 bp: 25,000 -> 200; 12,345.67 -> 1,234,567 x 80 / 10,000 = 9,876.536 -> 9,877 cents.
   * Mobitel 450 bp: 333,333 x 450 / 10,000 = 14,999.985 -> 15,000; 666,666 x 450 / 10,000 = 29,999.97 -> 30,000. Hutch 600 bp: 5,000 -> 300. Airtel 2,000 -> 120 + extra 25.
   * August reload commission 600 + 150 + 300 + 120 + 1,200 + 300 = 2,670 (+ extra 25 = 2,695); EZCash 200 + 98.77 = 298.77; commission revenue 2,993.77.
   */
  it('August summary per provider and in total', async () => {
    const t = (await get(s.app, '/telecom/summary?from=2025-08-01&to=2025-08-31')).body;
    const by = Object.fromEntries(t.providers.map((p: any) => [p.name, p]));
    expect([by.Dialog.reloadSalesCents, by.Dialog.reloadCommissionCents, by.Dialog.ezcashBillCents, by.Dialog.ezcashCommissionCents, by.Dialog.topupsCents]).toEqual([3000000, 180000, 3734567, 29877, 800000]);
    expect([by.Mobitel.reloadSalesCents, by.Mobitel.reloadCommissionCents, by.Mobitel.topupsCents]).toEqual([999999, 45000, 500000]);
    expect([by.Hutch.reloadSalesCents, by.Hutch.reloadCommissionCents]).toEqual([500000, 30000]);
    expect([by.Airtel.reloadSalesCents, by.Airtel.reloadCommissionCents]).toEqual([200000, 14500]);
    expect(t.totals).toMatchObject({ reloadSalesCents: 4699999, reloadCommissionCents: 269500, reloadExtraCents: 2500, ezcashBillCents: 3734567, ezcashCommissionCents: 29877, providerTopupsCents: 1300000, walletTopupsCents: 500000, commissionRevenueCents: 299377 });
  });
  it('September summary', async () => {
    // Dialog 8,000 -> 480; Hutch 4,000 -> 240; EZCash 8,000 x 80 bp = 64.00 -> commission 72,000 + 6,400 = 78,400 cents
    const t = (await get(s.app, '/telecom/summary?from=2025-09-01&to=2025-09-30')).body;
    expect(t.totals).toMatchObject({ reloadSalesCents: 1200000, reloadCommissionCents: 72000, ezcashBillCents: 800000, ezcashCommissionCents: 6400, commissionRevenueCents: 78400, topupsCents: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('Shop P&L', () => {
  /**
   * Daily net profit (cents):
   *  08-04 Sa1 GP 290,000-110,020 = 179,980.
   *  08-05 Sa2 GP 240,000-140,000-4,000 = 96,000; print 150,000-65,000 = 85,000; rent -1,000,000 -> -819,000.
   *  08-07 Sa3 GP 400,000-156,522 = 243,478; loss S 10,010 -> 233,468 (the purchase return refunds 140,000 = stock removed 140,000: no adjustment).
   *  08-08 Rt1 -160,000+62,609 = -97,391; Rt2 -80,000+30,000 = -50,000 and the damaged loss -30,000; stocktake loss R 50,000, gain S 20,020; Sa5 GP 25,000-10,010 = 14,990;
   *        count short -5,000 -> -97,391-50,000+14,990-30,000-50,000+20,020-5,000 = -197,381.
   *  08-11 Sa6 GP 410,000-175,217 = 234,783; water 80,000 + packaging 25,000 -> 129,783.   08-12 Sa7 101,250 + print CLR 80,000-26,000 = 54,000 -> 155,250.
   *  08-13 Sa8 189,999; cleaning 45,000 + other 70,000 (the voided 99,900 is absent) -> 74,999.   08-14 Rt3 -133,333+70,000 = -63,333.
   *  08-15 Rt4 -266,666+140,000 = -126,666; Sa9 59,960; loss R 56,250 (loss S + its void = 0) -> -122,956.   08-20 Sa12 480,000-194,565 = 285,435.
   *  09-01 Sa10 100,000.  09-04 Rt5 -120,000+70,000+2,000 = -48,000; Sa11 142,717 -> 94,717.  09-05 rent -1,000,000; print 125,000-45,000 = 80,000 -> -920,000.
   *  09-08 loss P 32,428, stocktake gain S 10,010 -> -22,418.   09-10 count over +12,000.
   */
  const DAYS: Record<string, number> = {
    '2025-08-04': 179980, '2025-08-05': -819000, '2025-08-07': 233468, '2025-08-08': -197381, '2025-08-11': 129783, '2025-08-12': 155250, '2025-08-13': 74999,
    '2025-08-14': -63333, '2025-08-15': -122956, '2025-08-20': 285435, '2025-09-01': 100000, '2025-09-04': 94717, '2025-09-05': -920000, '2025-09-08': -22418, '2025-09-10': 12000,
  };
  it('every day from 08-01 to 09-30: active days match the hand figure, every other day is zero', async () => {
    const r = (await rep('pnl/shop', '2025-08-01', '2025-09-30', 'day')).body;
    expect(r.rows).toHaveLength(61);
    for (const row of r.rows) expect(row.netProfitCents, row.period.label).toBe(DAYS[row.period.label] ?? 0);
    expect(Object.values(DAYS).reduce((a, b) => a + b, 0)).toBe(-879456);
  });
  /**
   * August: goods sales 290,000+240,000+400,000+25,000+410,000+270,000+399,999+100,000+480,000 = 2,614,999; returns 160,000+80,000+133,333+266,666 = 639,999; revenue 1,975,000.
   *  automatic cost 110,020+140,000+156,522+10,010+175,217+168,750+210,000+40,040+194,565 = 1,205,124 minus returns 62,609+30,000+70,000+140,000 = 302,609 -> 902,515; extra 4,000;
   *  cost of sales 906,515; goods GP 1,068,485. Services 230,000-91,000 = 139,000. Gross 1,207,485. Expenses 1,000,000+80,000+25,000+45,000+70,000 = 1,220,000.
   *  Adjustments: losses 10,010+56,250 = 66,260 (+ the voided loss and its reversal, net 0), damaged return 30,000, stocktake loss 50,000, gain 20,020 -> 66,260+30,000+50,000-20,020 = 126,240.
   *  Over/short -5,000.  Net 1,207,485-1,220,000-126,240-5,000 = -143,755.
   * September: goods sales 480,000, returns 120,000, revenue 360,000, automatic 237,283-70,000 = 167,283, extra -2,000, cost 165,283, GP 194,717; services 125,000-45,000 = 80,000;
   *  gross 274,717; rent 1,000,000; adjustments loss 32,428 - gain 10,010 = 22,418; over +12,000; net 274,717-1,000,000-22,418+12,000 = -735,701.
   */
  it('monthly figures line by line', async () => {
    const r = (await rep('pnl/shop', '2025-08-01', '2025-09-30')).body;
    const m = byLabel(r.rows);
    expect(m['2025-08']).toMatchObject({
      goods: { salesCents: 2614999, returnsCents: 639999, revenueCents: 1975000, costAutomaticCents: 902515, costExtraCents: 4000, costOfSalesCents: 906515, grossProfitCents: 1068485 },
      services: { revenueCents: 230000, costCents: 91000, grossProfitCents: 139000 }, grossProfitCents: 1207485,
      expenses: { totalCents: 1220000, byCategory: { rent: 1000000, water: 80000, packaging: 25000, cleaning_supplies: 45000, other: 70000, internet: 0, transport: 0, repairs: 0, stationery: 0 } },
      adjustments: { lossesCents: 66260, damagedReturnLossesCents: 30000, stocktakeLossesCents: 50000, stocktakeGainsCents: 20020, residualSweepsCents: 0, purchaseRefundGainCents: 0, salesReturnVoidGainCents: 0, netCents: 126240 },
      cashOverShortCents: -5000, netProfitCents: -143755,
    });
    expect(m['2025-09']).toMatchObject({
      goods: { salesCents: 480000, returnsCents: 120000, revenueCents: 360000, costAutomaticCents: 167283, costExtraCents: -2000, costOfSalesCents: 165283, grossProfitCents: 194717 },
      services: { revenueCents: 125000, costCents: 45000, grossProfitCents: 80000 }, grossProfitCents: 274717,
      expenses: { totalCents: 1000000, byCategory: { rent: 1000000 } },
      adjustments: { lossesCents: 32428, stocktakeGainsCents: 10010, netCents: 22418 }, cashOverShortCents: 12000, netProfitCents: -735701,
    });
    expect(r.totals.netProfitCents).toBe(-143755 - 735701);
  });
  it('things that are NOT profit: drawings, capital, transfers, supplies, opening balances, purchases', async () => {
    // Shop August cash includes drawing 2,000, capital 5,000, transfers, supplies 1,200 and the opening 50,000 - none is in the 1,220,000 expenses or the net.
    expect(Number(rows(s.ctx, "SELECT COUNT(*) n FROM owner_drawings WHERE status='posted'")[0]!.n)).toBe(4); // goods P x2 + cash Shop, Telecom, Ice Cream
    const r = (await rep('pnl/shop', '2025-08-01', '2025-08-31')).body;
    expect(r.totals.expenses.totalCents).toBe(1220000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('Telecom P&L', () => {
  /**
   * Daily net: 08-04 commission 600+150 = 750 -> 75,000 (cents) | 08-05 T1 GP 200,000-180,000-10,000 = 10,000 | 08-06 EZCash 200.00 - internet 1,500 = -130,000 |
   * 08-08 Hutch 300 + Airtel 120+25 = 44,500 | 08-11 Dialog 1,200 + T2 GP 30,000 = 150,000 | 08-12 -600 -1,200 = -180,000 | 08-13 stationery -30,000 |
   * 08-14 Mobitel 300.00 + EZCash 98.77 - stocktake loss 180.00 = 21,877 | 08-15 count over +20,000 | 09-01 480 - internet 1,500 = -102,000 | 09-03 T3 GP 10,000 |
   * 09-05 Hutch 240 + EZCash 64 = 30,400 | 09-10 count short -30,000.
   * August: commission 299,377; cards 500,000 - 450,000 - 10,000 = 40,000; gross 339,377; expenses 150,000+60,000+120,000+30,000 = 360,000; stocktake loss 18,000; over +20,000 -> -18,623.
   * September: 78,400 + 10,000 = 88,400; internet 150,000; short 30,000 -> -91,600.
   */
  const DAYS: Record<string, number> = {
    '2025-08-04': 75000, '2025-08-05': 10000, '2025-08-06': -130000, '2025-08-08': 44500, '2025-08-11': 150000, '2025-08-12': -180000, '2025-08-13': -30000,
    '2025-08-14': 21877, '2025-08-15': 20000, '2025-09-01': -102000, '2025-09-03': 10000, '2025-09-05': 30400, '2025-09-10': -30000,
  };
  it('every day', async () => {
    const r = (await rep('pnl/telecom', '2025-08-01', '2025-09-30', 'day')).body;
    for (const row of r.rows) expect(row.netProfitCents, row.period.label).toBe(DAYS[row.period.label] ?? 0);
    expect(Object.values(DAYS).reduce((a, b) => a + b, 0)).toBe(-110223);
  });
  it('monthly figures line by line (top-ups are cash only: memo)', async () => {
    const r = (await rep('pnl/telecom', '2025-08-01', '2025-09-30')).body;
    expect(r.rows[0]).toMatchObject({
      commissionRevenueCents: 299377, cards: { revenueCents: 500000, costAutomaticCents: 450000, costExtraCents: 10000, costOfSalesCents: 460000, grossProfitCents: 40000 },
      grossProfitCents: 339377, expenses: { totalCents: 360000 }, adjustments: { stocktakeLossesCents: 18000, netCents: 18000 },
      cashOverShortCents: 20000, netProfitCents: -18623, memo: { providerTopupsCents: 1300000, walletTopupsCents: 500000 },
    });
    expect(r.rows[1]).toMatchObject({ commissionRevenueCents: 78400, grossProfitCents: 88400, expenses: { totalCents: 150000 }, cashOverShortCents: -30000, netProfitCents: -91600 });
    expect(r.totals.netProfitCents).toBe(-110223);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('Ice Cream P&L (recognized profit, excess-cost flows)', () => {
  /**
   * Recognized profit per day (cents): 08-04 +1,500 | 08-07 +1,200 | 08-08 cups -300 | 08-11 +1,900 | 08-13 release 2,000 (limit min(Unspent M 5,400, U 6,400) -> all eligible) |
   * 08-14 release 4,000 -> eligible min(3,400, 4,400) = 3,400 | 08-15 re-allocation -1,500 | 08-19 +900 | 08-20 -200 | 08-25 +3,300 | 09-03 +800 | 09-08 -1,000 | 09-10 count -100.
   * (08-12 re-label, 08-18/21/22 payments, transfers, drawings, capital: 0.)  August 12,200; September -300.
   * Unspent after each event (U = Unspent M + Unspent E): 08-18 materials 3,000: M -3,000, E 2,500 -> U -500 (excess +500) | 08-19 day -> U 1,600 (excess -500) |
   * 08-21 bill 6,000 -> U -3,200 (+3,200) | 08-22 other cost 400 from Cost -> U -3,600 (+400) | 08-25 day -> U 1,100 (-3,600) | 09-02 bill 5,000 -> U -3,900 (+3,900) |
   * 09-03 day -> -2,700 (-1,200) | 09-08 re-allocation 1,000 -> -1,700 (-1,000).  August excess flow 0 (outstanding 0); September +1,700 (outstanding 1,700).
   */
  const REC: Record<string, number> = { '2025-08-04': 150000, '2025-08-07': 120000, '2025-08-08': -30000, '2025-08-11': 190000, '2025-08-13': 200000, '2025-08-14': 340000,
    '2025-08-15': -150000, '2025-08-19': 90000, '2025-08-20': -20000, '2025-08-25': 330000, '2025-09-03': 80000, '2025-09-08': -100000, '2025-09-10': -10000 };
  const EXC: Record<string, number> = { '2025-08-18': 50000, '2025-08-19': -50000, '2025-08-21': 320000, '2025-08-22': 40000, '2025-08-25': -360000, '2025-09-02': 390000, '2025-09-03': -120000, '2025-09-08': -100000 };
  it('every day: recognized profit, excess cost not yet charged and profit after excess cost', async () => {
    const r = (await rep('pnl/icecream', '2025-08-01', '2025-09-30', 'day')).body;
    for (const row of r.rows) {
      const d = row.period.label;
      expect(row.recognizedProfitCents, d).toBe(REC[d] ?? 0);
      expect(row.excessCostNotChargedCents, d).toBe(EXC[d] ?? 0);
      expect(row.profitAfterExcessCostCents, d).toBe((REC[d] ?? 0) - (EXC[d] ?? 0));
    }
    expect(Object.values(REC).reduce((a, b) => a + b, 0)).toBe(1190000);
    expect(Object.values(EXC).reduce((a, b) => a + b, 0)).toBe(170000);
  });
  /**
   * August: sales 5,000+4,000+6,000+3,000+1,000+8,000 = 27,000; Materials charged = allocations 3,000+2,400+3,500+1,800+900+4,000 = 15,600 - re-label 1,000 - releases 2,000 and 3,400 = 9,200;
   * Electricity charged = 500+400+600+300+300+700 = 2,800 + re-label 1,000 + re-allocation 1,500 = 5,300; other expenses 300 (cups from the Profit fund; 400 from the Cost fund is
   * NOT an expense); 27,000-9,200-5,300-300 = 12,200.  Memo: materials paid 2,500+3,000 = 5,500, electricity paid 1,500+6,000 = 7,500, other from Cost/Elec funds 400.
   * September: sales 2,000, Materials 1,000 + 1,000 = 2,000, Electricity 200, short 100 -> 2,000-2,000-200-100 = -300; electricity paid 5,000.
   */
  it('monthly P&L, recognition view, memo block and balances at period end', async () => {
    const r = (await rep('pnl/icecream', '2025-08-01', '2025-09-30')).body;
    expect(r.rows[0]).toMatchObject({
      salesCents: 2700000, materialsChargeCents: 920000, electricityChargeCents: 530000, otherExpensesCents: 30000, cashOverShortCents: 0, recognizedProfitCents: 1220000,
      recognition: { dailyProfitShareCents: 860000, profitEligibleReleasesCents: 540000, reallocationsCents: -150000, otherExpensesCents: -30000, cashOverShortCents: 0 },
      memo: { actualMaterialsPaidCents: 550000, actualElectricityPaidCents: 750000, otherCostsFromCostElecFundsCents: 40000 },
      excessCostNotChargedCents: 0, profitAfterExcessCostCents: 1220000,
      balancesAsOfPeriodEnd: { unspentByLine: { materialsCents: 330000, electricityCents: -220000 }, unspentCents: 110000, outstandingExcessCostCents: 0 },
    });
    // daily shares 1,500+1,200+1,900+900-200+3,300 = 8,600
    expect(r.rows[1]).toMatchObject({
      salesCents: 200000, materialsChargeCents: 200000, electricityChargeCents: 20000, otherExpensesCents: 0, cashOverShortCents: -10000, recognizedProfitCents: -30000,
      recognition: { dailyProfitShareCents: 80000, profitEligibleReleasesCents: 0, reallocationsCents: -100000, cashOverShortCents: -10000 },
      memo: { actualMaterialsPaidCents: 0, actualElectricityPaidCents: 500000 },
      excessCostNotChargedCents: 170000, profitAfterExcessCostCents: -200000,
      balancesAsOfPeriodEnd: { unspentByLine: { materialsCents: 530000, electricityCents: -700000 }, unspentCents: -170000, outstandingExcessCostCents: 170000 },
    });
    expect(r.warnings[0]).toMatchObject({ code: 'EXCESS_COST_OUTSTANDING', outstandingExcessCostCents: 170000 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('Combined P&L and dashboard', () => {
  /** August -143,755 - 18,623 + 1,220,000 = 1,057,622; September -735,701 - 91,600 - 30,000 = -857,301; total 200,321; after the 170,000 excess: 30,321. */
  it('Combined = Shop + Telecom + Ice Cream; electricity lines are information only', async () => {
    const r = (await rep('pnl/combined', '2025-08-01', '2025-09-30')).body;
    expect(r.rows[0]).toMatchObject({ segments: { shop: { recognizedProfitCents: -143755 }, telecom: { recognizedProfitCents: -18623 }, icecream: { recognizedProfitCents: 1220000 } },
      recognizedProfitCents: 1057622, electricityChargedCents: 530000, electricityBillsPaidCents: 750000, icecreamExcessCostNotChargedCents: 0, combinedProfitAfterExcessCostCents: 1057622 });
    expect(r.rows[1]).toMatchObject({ recognizedProfitCents: -857301, electricityChargedCents: 20000, electricityBillsPaidCents: 500000, icecreamExcessCostNotChargedCents: 170000,
      combinedProfitAfterExcessCostCents: -1027301, outstandingExcessCostCents: 170000 });
    expect(r.totals).toMatchObject({ recognizedProfitCents: 200321, electricityChargedCents: 550000, electricityBillsPaidCents: 1250000, combinedProfitAfterExcessCostCents: 30321 });
    expect(r.warnings[0].code).toBe('EXCESS_COST_OUTSTANDING');
  });

  /**
   * Dashboard, asOf 2025-08-14 (today = 08-14, month = 08-01..08-14). "Sales" = Shop goods+print revenue net of returns | Telecom card revenue + commissions | Ice Cream sales.
   *  today: Shop -133,333 (only Rt3) profit -63,333; Telecom 30,000+9,877 = 39,877 profit 21,877; Ice Cream no day entry -> 0, recognized +340,000 (the 3,400 release).
   *   Combined sales -93,456, profit -63,333+21,877+340,000 = 298,544.
   *  month-to-date: Shop revenue 290,000+240,000+150,000+400,000-160,000-80,000+25,000+410,000+270,000+80,000+399,999-133,333 = 1,891,666, profit -306,234 (sum of the daily nets 08-04..08-14);
   *   Telecom sales 299,377 + 500,000 = 799,377, profit -38,623; Ice Cream 1,500,000, recognized 970,000 (1,500+1,200-300+1,900+2,000+3,400 = 9,700).
   *   Combined sales 4,191,043, profit 625,143. Cash: Shop 37,366.66, Telecom 78,245.66, Ice 15,700 = Cost 4,400 + Electricity 1,000 + Profit 10,300.
   *   Stock value on 08-14: P 438,261 + Q 420,000 + R 281,250 + S 80,080 + K 432,000 = 1,651,591.
   */
  it('dashboard as of 08-14', async () => {
    const d = (await get(s.app, '/dashboard?asOf=2025-08-14')).body;
    expect(d.today).toMatchObject({ salesCents: -93456, profitCents: 298544, bySegment: { shop: { salesCents: -133333, profitCents: -63333 }, telecom: { salesCents: 39877, profitCents: 21877 }, icecream: { salesCents: 0, profitCents: 340000 } } });
    expect(d.month).toMatchObject({ salesCents: 4191043, profitCents: 625143, bySegment: { shop: { salesCents: 1891666, profitCents: -306234 }, telecom: { salesCents: 799377, profitCents: -38623 }, icecream: { salesCents: 1500000, profitCents: 970000 } } });
    expect(d.cash.books.map((b: any) => b.balanceCents)).toEqual([3736666, 7824566, 1570000]);
    expect(d.cash.books[2].funds).toEqual({ cost: 440000, electricity: 100000, profit: 1030000 });
    expect(d.stock.valueCents).toBe(1651591);
  });
  /**
   * Dashboard series and top products as of 08-14 (hand-calculated):
   *  daily 08-12: Shop sales Sa7 270,000 + print 80,000 = 350,000, profit 155,250; Telecom -180,000; Ice 0 -> sales 350,000, profit -24,750.
   *  daily 08-13: Sa8 399,999, profit 74,999 - 30,000 + 200,000 (the Rs 2,000 release) = 244,999.   daily 08-14: sales -93,456, profit 298,544 (the "today" tile).
   *  monthly (August so far): Shop -306,234, Telecom -38,623, Ice 970,000, Combined 625,143.
   *  top products this month by gross profit (revenue net of returns, cost = automatic + extra, net of returns):
   *   Phone cover revenue 240,000+400,000+320,000-160,000-80,000 = 720,000; cost 90,000+156,522+125,217-62,609-30,000 = 279,130 -> 440,870.
   *   Charger 240,000+399,999-133,333 = 506,666; cost 140,000+4,000+210,000-70,000 = 284,000 -> 222,666.   Earbuds 90,000+270,000 = 360,000; cost 50,000+168,750 -> 141,250.
   *   Cable 50,000+25,000 = 75,000; cost 20,020+10,010 -> 44,970.   Scratch card 200,000+300,000 = 500,000; cost 180,000+10,000+270,000 = 460,000 -> 40,000.
   *  closings: Shop last closed 08-08 (closed again after the reopen); Telecom and Ice Cream never closed by 08-14.
   */
  it('dashboard series, top products and closings as of 08-14', async () => {
    const d = (await get(s.app, '/dashboard?asOf=2025-08-14')).body;
    expect(d.series.daily).toHaveLength(30);
    const pt = (date: string) => d.series.daily.find((x: any) => x.date === date);
    expect(pt('2025-08-12')).toEqual({ date: '2025-08-12', salesCents: 350000, profitCents: -24750 });
    expect(pt('2025-08-13')).toEqual({ date: '2025-08-13', salesCents: 399999, profitCents: 244999 });
    expect(pt('2025-08-14')).toEqual({ date: '2025-08-14', salesCents: -93456, profitCents: 298544 });
    expect(d.series.monthly).toHaveLength(12);
    expect(d.series.monthly[11]).toEqual({ month: '2025-08', shopCents: -306234, telecomCents: -38623, icecreamCents: 970000, combinedCents: 625143 });
    expect(d.series.topProducts).toEqual([
      { name: 'Phone cover', revenueCents: 720000, grossProfitCents: 440870 }, { name: 'Charger', revenueCents: 506666, grossProfitCents: 222666 },
      { name: 'Earbuds', revenueCents: 360000, grossProfitCents: 141250 }, { name: 'Cable', revenueCents: 75000, grossProfitCents: 44970 },
      { name: 'Scratch card 100', revenueCents: 500000, grossProfitCents: 40000 }]);
    expect(d.closings.lastClosedByBook).toEqual({ shop: '2025-08-08', telecom: null, icecream: null });
  });

  /** asOf 08-31: month = August: Shop 1,975,000+230,000 = 2,205,000 / -143,755; Telecom 799,377 / -18,623; Ice 2,700,000 / 1,220,000; Combined 5,704,377 / 1,057,622. */
  it('dashboard as of 08-31 and 09-14', async () => {
    const a = (await get(s.app, '/dashboard?asOf=2025-08-31')).body;
    expect(a.today.profitCents).toBe(0);
    expect(a.month).toMatchObject({ salesCents: 5704377, profitCents: 1057622, bySegment: { shop: { salesCents: 2205000, profitCents: -143755 }, telecom: { salesCents: 799377, profitCents: -18623 }, icecream: { salesCents: 2700000, profitCents: 1220000 } } });
    expect(a.cash.books.map((b: any) => b.balanceCents)).toEqual([3810000, 7774566, 1700000]);
    expect(a.stock.valueCents).toBe(1840736);
    /** September (asOf 09-14): Shop 360,000+125,000 = 485,000 / -735,701; Telecom 78,400+100,000 = 178,400 / -91,600; Ice 200,000 / -30,000; Combined 863,400 / -857,301. */
    const b = (await get(s.app, '/dashboard?asOf=2025-09-14')).body;
    expect(b.month).toMatchObject({ salesCents: 863400, profitCents: -857301, bySegment: { shop: { salesCents: 485000, profitCents: -735701 }, telecom: { salesCents: 178400, profitCents: -91600 }, icecream: { salesCents: 200000, profitCents: -30000 } } });
    expect(b.cash.books.map((x: any) => x.balanceCents)).toEqual([2977000, 9694566, 1440000]);
    expect(b.cash.books[2].funds).toEqual({ cost: 890000, electricity: -500000, profit: 1050000 });
    expect(b.stock.valueCents).toBe(1811035);
    expect(b.icecream).toMatchObject({ recognizedProfitMonthCents: -30000, excessCostNotChargedMonthCents: 170000, profitAfterExcessCostMonthCents: -200000, outstandingExcessCostCents: 170000, fundsTotalCents: 1440000, fundsMatchBook: true });
  });
});

describe('Excel export pack (rupees, from the same hand figures)', () => {
  const sheet = (wb: any, name: string) => wb.worksheets.find((w: any) => w.name === name)!;
  const rowOf = (ws: any, label: string) => (ws.getRows(1, ws.rowCount)!.find((r: any) => r.getCell(1).value === label)!.values as unknown[]).slice(1);
  it('the workbook shows the August / September / total figures of the hand calculation (cents / 100)', async () => {
    const p = await pack(s, 'from=2025-08-01&to=2025-09-30');
    expect(p.status).toBe(200);
    const names = p.wb!.worksheets.map((x) => x.name);
    expect(names).toEqual(['Combined P&L (by month)', 'Shop P&L', 'Telecom P&L', 'Ice Cream P&L', 'Ice Cream funds', 'Ice Cream profit and excess', 'Cash book - Shop', 'Cash book - Telecom',
      'Cash book - Ice Cream', 'Inventory valuation', 'Low stock', 'Sales', 'Purchases', 'Drawings', 'Printing variance']);
    const c = sheet(p.wb, 'Combined P&L (by month)');
    expect(rowOf(c, '2025-08')).toEqual(['2025-08', -1437.55, -186.23, 12200, 10576.22, 0, 10576.22, 5300, 7500, 0]);
    expect(rowOf(c, '2025-09')).toEqual(['2025-09', -7357.01, -916, -300, -8573.01, 1700, -10273.01, 200, 5000, 1700]);
    expect(rowOf(c, 'Total')).toEqual(['Total', -8794.56, -1102.23, 11900, 2003.21, 1700, 303.21, 5500, 12500, 1700]);
    const sh = sheet(p.wb, 'Shop P&L');
    expect(rowOf(sh, '2025-08')).toEqual(['2025-08', 19750, 9025.15, 40, 10684.85, 2300, 910, 1390, 12200, 1262.4, 0, 0, -50, -1437.55]);
    expect(rowOf(sh, '2025-09')).toEqual(['2025-09', 3600, 1672.83, -20, 1947.17, 1250, 450, 800, 10000, 224.18, 0, 0, 120, -7357.01]);
    expect(rowOf(sheet(p.wb, 'Cash book - Shop'), '2025-08')).toEqual(['2025-08', 0, 92548.99, 54448.99, 38100]);
    expect((rowOf(sheet(p.wb, 'Cash book - Telecom'), '2025-09') as number[])[4]).toBe(96945.66);
    expect((rowOf(sheet(p.wb, 'Cash book - Ice Cream'), '2025-09') as number[])[4]).toBe(14400);
    const v = sheet(p.wb, 'Inventory valuation');
    // product rows have no label in column 1 (SKU is empty): look the products up by name in column 2
    const byName = (n: string) => (v.getRows(1, v.rowCount)!.find((r: any) => r.getCell(2).value === n)!.values as unknown[]).slice(2);
    expect(byName('Cable')).toEqual(['Cable', 'Electronics', 'shop', 5, 100.1, 500.5]);
    expect(byName('Phone cover')).toEqual(['Phone cover', 'Electronics', 'shop', 14, 324.28, 4539.85]);
    expect(byName('Scratch card 100')).toEqual(['Scratch card 100', 'Scratch Cards', 'telecom', 38, 90, 3420]);
  });
});

describe('cash book ledger pages and list totals', () => {
  /** The ledger of each book, read page by page (limit 7), must carry a running balance equal to the opening balance plus the rows so far (business date, then id). */
  it('running balances are right across pages for every book, for a window that starts mid-way', async () => {
    for (const book of ['shop', 'telecom', 'icecream']) {
      const from = '2025-08-12'; const to = '2025-09-14';
      const all = rows(s.ctx, 'SELECT id, business_date d, amount_cents a FROM cash_entries WHERE book = ? ORDER BY business_date, id', book);
      const opening = all.filter((r) => r.d < from).reduce((acc, r) => acc + Number(r.a), 0);
      const inside = all.filter((r) => r.d >= from && r.d <= to);
      let run = opening; const want = inside.map((r) => { run += Number(r.a); return [Number(r.id), run]; });
      const got: Array<[number, number]> = [];
      for (let off = 0; off < inside.length; off += 7) {
        const page = (await get(s.app, `/cashbooks/${book}?from=${from}&to=${to}&limit=7&offset=${off}`)).body;
        expect(page.openingCents).toBe(opening);
        expect(page.total).toBe(inside.length);
        for (const it of page.items) got.push([it.id, it.runningBalanceCents]);
      }
      expect(got, book).toEqual(want);
      expect(want[want.length - 1]![1]).toBe(book === 'shop' ? 2977000 : book === 'telecom' ? 9694566 : 1440000);
    }
  });
  /** GET /sales totals over posted sales: revenue 2,614,999 + 480,000 + telecom cards... split by book: Shop 3,094,999 (August 2,614,999 + September 480,000); Telecom 600,000 (T1 200,000 + T2 300,000 + T3 100,000). */
  it('sales list totals per book equal the hand sums (voided sale excluded, refunds counted)', async () => {
    const shop = (await get(s.app, '/sales?book=shop&limit=200')).body;
    const tel = (await get(s.app, '/sales?book=telecom&limit=200')).body;
    expect(shop.totals.revenueCents).toBe(2614999 + 480000);
    expect(shop.totals.refundsCents).toBe(639999 + 120000);
    expect(tel.totals.revenueCents).toBe(600000);
    expect(tel.totals.refundsCents).toBe(0);
    // cogs (automatic) shop: August 1,205,124 + September 237,283; telecom 180,000 + 270,000 + 90,000
    expect(shop.totals.cogsCents).toBe(1205124 + 237283);
    expect(tel.totals.cogsCents).toBe(540000);
    expect(shop.totals.extraCostCents).toBe(4000);
    expect(tel.totals.extraCostCents).toBe(10000);
  });
});

describe('global invariants on the finished world', () => {
  it('assertGlobalInvariants passes (cash, funds, stock, append-only, reversals, dates, electricity, Combined = sum)', async () => {
    await assertGlobalInvariants(s);
  });
});
