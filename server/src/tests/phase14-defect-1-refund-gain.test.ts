// PHASE 14 DEFECT 1 FIX - hand-calculated tests of the "purchase refund above the stock value removed" gain (BUSINESS_RULES R4, C7).
//
// Rule: a purchase RETURN / VOID refunds (cash) the full purchase value, but stock only loses min(purchase-cost value, pool value). The difference is a
// gain reported as a NEGATIVE Stock adjustment (adjustments.purchaseRefundGainCents is positive, netCents = losses + stocktake losses + sweeps - stocktake
// gains - gain). The residual sweep (R4 'adjustment' movement) is a separate cost line and is never part of the gain.
// Every figure below is independent arithmetic (comments), checked against the cash + stock identity: profit = cash taken in - cash paid + stock value left.
// Amounts are cents.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct, mkTelecom, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post } from './helpers/catalog.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { shopIdentity } from './helpers/phase14.ts';

const env = new TestEnv();
const env2 = new TestEnv();
afterEach(async () => { await env.cleanup(); await env2.cleanup(); });

type S = ApiBase;
const pnl = async (s: S, seg: 'shop' | 'telecom' | 'combined', from: string, to: string, g: 'day' | 'month' = 'month') =>
  (await get(s.app, `/reports/pnl/${seg}?from=${from}&to=${to}&granularity=${g}`)).body;
const sum = (xs: any[], pick: (x: any) => number): number => xs.reduce((a, x) => a + pick(x), 0);
const mk = (s: S, telecom: boolean) => (telecom ? mkTelecom(s, { sellPriceCents: 1000, minPriceCents: 1 }) : mkProduct(s, { sellPriceCents: 1000, minPriceCents: 1 }));

/**
 * The common world: P1 = 10 units for 60,000 (6,000 each) on 05-01, P2 = 10 units for 2,000 (200 each) on 05-02.
 * Pool 20 / 62,000 (average 3,100). Sell 12 at 1,000 on 05-03: cogs 62,000 x 12 / 20 = 37,200, revenue 12,000; pool 8 / 24,800.
 */
async function world(s: S, telecom: boolean) {
  const Z = (await mk(s, telecom)).id;
  const p1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 60000 }], { businessDate: '2025-05-01' });
  await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 2000 }], { businessDate: '2025-05-02' });
  await sellOk(s, [cl(Z, 12, 1000)], { businessDate: '2025-05-03' });
  return { Z, p1 };
}
const ret = (s: S, p1: any, date: string, units: number) =>
  post(s.app, `/purchases/${p1.id}/returns`, { businessDate: date, items: [{ purchaseItemId: p1.items[0].id, units }], clientRef: ref() });

describe('purchase refund gain (R4) - hand-calculated', () => {
  it('pool above the purchase cost: partial return gives gain 0 and no adjustment', async () => {
    const s = await apiBase(await env.build());
    const Z = (await mkProduct(s, { sellPriceCents: 1000, minPriceCents: 1 })).id;
    // P1 10 units for 1,000 (100 each); P2 10 units for 100,000 (10,000 each): pool 20 / 101,000.
    const p1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-05-01' });
    await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 100000 }], { businessDate: '2025-05-02' });
    // return 4 of P1: refund 4 x 100 = 400; stock removed min(400, 101,000) = 400 -> gain 400 - 400 = 0
    expect((await ret(s, p1, '2025-05-04', 4)).status).toBe(201);
    const p = await pnl(s, 'shop', '2025-05-01', '2025-05-31');
    expect(p.totals.adjustments).toMatchObject({ purchaseRefundGainCents: 0, residualSweepsCents: 0, netCents: 0 });
    // cash -1,000 - 100,000 + 400 = -100,600; stock 100,600 (16 units: 101,000 - 400) -> profit 0
    expect(p.totals.netProfitCents).toBe(0);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
  });

  it('pool below the purchase cost: refund 36,000 - stock removed 24,800 = gain 11,200 (a -11,200 adjustment); profit -14,000', async () => {
    const s = await apiBase(await env.build());
    const { p1 } = await world(s, false);
    // return 6 of P1 on 05-04: refund 6 x 6,000 = 36,000; pool 8 / 24,800 -> removed min(36,000, 24,800) = 24,800; qty 8 -> 2 (no sweep, pool value 0)
    expect((await ret(s, p1, '2025-05-04', 6)).status).toBe(201);
    const p = await pnl(s, 'shop', '2025-05-01', '2025-05-31');
    expect(p.totals.adjustments).toMatchObject({ purchaseRefundGainCents: 11200, residualSweepsCents: 0, netCents: -11200 });
    // revenue 12,000 - cogs 37,200 = -25,200; gain +11,200 -> -14,000.  Cash: -60,000 - 2,000 + 12,000 + 36,000 = -14,000, stock value 0.
    expect(p.totals.netProfitCents).toBe(-14000);
    expect(p.table.columns.map((c: any) => c.label)).toContain('Purchase refund above stock value removed (R4)');
    expect(p.table.totals.purchaseRefundGain).toBe(11200);
    expect(p.table.totals.adjustments).toBe(-11200);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
    expect(id.reportProfit).toBe(-14000);
  });

  it('return that empties the pool: the residual sweep stays a separate cost and the gain is 0 (refund = value removed)', async () => {
    const s = await apiBase(await env.build());
    const Z = (await mkProduct(s, { sellPriceCents: 8000, minPriceCents: 1 })).id;
    // P1 10 units for 10,000 (1,000 each); P2 10 units for 100,000 (10,000 each): pool 20 / 110,000. Sell 10 at 8,000: cogs 110,000 x 10 / 20 = 55,000; pool 10 / 55,000.
    const p1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: '2025-05-01' });
    await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 100000 }], { businessDate: '2025-05-02' });
    await sellOk(s, [cl(Z, 10, 8000)], { businessDate: '2025-05-03' });
    // return all 10 of P1: refund 10,000; removed min(10,000, 55,000) = 10,000; the pool empties (qty 0) so the 45,000 left is swept (R4 residual).
    expect((await ret(s, p1, '2025-05-04', 10)).status).toBe(201);
    const p = await pnl(s, 'shop', '2025-05-01', '2025-05-31');
    expect(p.totals.adjustments).toMatchObject({ residualSweepsCents: 45000, purchaseRefundGainCents: 0, netCents: 45000 });
    // revenue 80,000 - cogs 55,000 - sweep 45,000 = -20,000.  Cash: -10,000 - 100,000 + 80,000 + 10,000 = -20,000; stock 0.
    expect(p.totals.netProfitCents).toBe(-20000);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
  });

  it('one return with a gain line (product A) and a sweep line (product B): total adjustments = sweep 45,000 - gain 11,200 = 33,800', async () => {
    const s = await apiBase(await env.build());
    const A = (await mkProduct(s, { sellPriceCents: 1000, minPriceCents: 1 })).id;
    const B = (await mkProduct(s, { sellPriceCents: 8000, minPriceCents: 1 })).id;
    // P1: A 10 for 60,000, B 10 for 10,000.  P2: A 10 for 2,000, B 10 for 100,000.
    const p1 = await buy(s, [{ productId: A, packs: 1, packSize: 10, lineTotalCents: 60000 }, { productId: B, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: '2025-05-01' });
    await buy(s, [{ productId: A, packs: 1, packSize: 10, lineTotalCents: 2000 }, { productId: B, packs: 1, packSize: 10, lineTotalCents: 100000 }], { businessDate: '2025-05-02' });
    // A: sell 12 at 1,000 -> cogs 37,200, pool 8 / 24,800.  B: sell 10 at 8,000 -> cogs 55,000, pool 10 / 55,000.   revenue 12,000 + 80,000 = 92,000
    await sellOk(s, [cl(A, 12, 1000), cl(B, 10, 8000)], { businessDate: '2025-05-03' });
    // return A 6 (refund 36,000, removed 24,800, gain 11,200) and B 10 (refund 10,000, removed 10,000, gain 0, sweep 45,000)
    const r = await post(s.app, `/purchases/${p1.id}/returns`, {
      businessDate: '2025-05-04', clientRef: ref(), items: [{ purchaseItemId: p1.items[0].id, units: 6 }, { purchaseItemId: p1.items[1].id, units: 10 }],
    });
    expect(r.status).toBe(201);
    const p = await pnl(s, 'shop', '2025-05-01', '2025-05-31');
    expect(p.totals.adjustments).toMatchObject({ residualSweepsCents: 45000, purchaseRefundGainCents: 11200, netCents: 33800 });
    // 92,000 - cogs 92,200 - 33,800 = -34,000.  Cash: -72,000 - 102,000 + 92,000 + 46,000 = -34,000; stock 0.
    expect(p.totals.netProfitCents).toBe(-34000);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
  });

  it('void with the pool lower: gain = 60,000 - 37,200 = 22,800 lands in the ORIGINAL month (April); May and the total add up', async () => {
    const s = await apiBase(await env.build());
    const Z = (await mkProduct(s, { sellPriceCents: 1000, minPriceCents: 1 })).id;
    const p1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 60000 }], { businessDate: '2025-04-28' });
    await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 2000 }], { businessDate: '2025-05-02' });
    // sell 8 at 1,000 on 05-03: pool 62,000, cogs 62,000 x 8 / 20 = 24,800; pool 12 / 37,200
    await sellOk(s, [cl(Z, 8, 1000)], { businessDate: '2025-05-03' });
    // void P1 (10 units on hand): cash +60,000; stock removed min(60,000, 37,200) = 37,200 (qty 12 -> 2, value 0); gain 22,800, booked on 2025-04-28
    expect((await post(s.app, `/purchases/${p1.id}/void`, { reason: 'wrong bill' })).status).toBe(200);
    const m = await pnl(s, 'shop', '2025-04-01', '2025-05-31');
    expect(m.rows.map((r: any) => [r.period.label, r.adjustments.purchaseRefundGainCents, r.adjustments.netCents, r.netProfitCents])).toEqual([
      ['2025-04', 22800, -22800, 22800],
      ['2025-05', 0, 0, -16800], // revenue 8,000 - cogs 24,800
    ]);
    // total 6,000 = cash -60,000 - 2,000 + 8,000 + 60,000 = 6,000 with stock value 0
    expect(m.totals.netProfitCents).toBe(6000);
    const d = await pnl(s, 'shop', '2025-04-01', '2025-05-31', 'day');
    expect(sum(d.rows, (r) => r.adjustments.purchaseRefundGainCents)).toBe(22800);
    expect(sum(d.rows, (r) => r.netProfitCents)).toBe(6000);
    expect(d.rows.find((r: any) => r.period.label === '2025-04-28').adjustments.purchaseRefundGainCents).toBe(22800);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
  });

  it('a return dated in a LATER month than the purchase: the gain lands in the return month (June); day rows add up to the months', async () => {
    const s = await apiBase(await env.build());
    const { p1 } = await world(s, false);
    expect((await ret(s, p1, '2025-06-10', 6)).status).toBe(201); // refund 36,000, removed 24,800, gain 11,200 (as above)
    const m = await pnl(s, 'shop', '2025-05-01', '2025-06-30');
    expect(m.rows.map((r: any) => [r.period.label, r.adjustments.purchaseRefundGainCents, r.netProfitCents])).toEqual([
      ['2025-05', 0, -25200], ['2025-06', 11200, 11200],
    ]);
    expect(m.totals.netProfitCents).toBe(-14000);
    const d = await pnl(s, 'shop', '2025-05-01', '2025-06-30', 'day');
    expect(d.rows).toHaveLength(61);
    expect(sum(d.rows, (r) => r.adjustments.netCents)).toBe(m.totals.adjustments.netCents);
    expect(sum(d.rows, (r) => r.adjustments.purchaseRefundGainCents)).toBe(11200);
    expect(sum(d.rows, (r) => r.netProfitCents)).toBe(-14000);
    expect(d.rows.find((r: any) => r.period.label === '2025-06-10').adjustments.purchaseRefundGainCents).toBe(11200);
    // the May-only view has no gain at all
    expect((await pnl(s, 'shop', '2025-05-01', '2025-05-31')).totals.adjustments.purchaseRefundGainCents).toBe(0);
  });

  it('Telecom card purchase: return gain 11,200 and void gain 22,800 are Telecom adjustments; Shop is untouched', async () => {
    const s = await apiBase(await env.build());
    const { p1 } = await world(s, true);
    expect((await ret(s, p1, '2025-05-04', 6)).status).toBe(201);
    let t = await pnl(s, 'telecom', '2025-05-01', '2025-05-31');
    expect(t.totals.adjustments).toMatchObject({ purchaseRefundGainCents: 11200, netCents: -11200 });
    // card revenue 12,000 - cost 37,200 + gain 11,200 = -14,000 (no commissions, no expenses)
    expect(t.totals.netProfitCents).toBe(-14000);
    expect(t.table.totals.purchaseRefundGain).toBe(11200);
    const sh = await pnl(s, 'shop', '2025-05-01', '2025-05-31');
    expect(sh.totals.adjustments).toMatchObject({ purchaseRefundGainCents: 0, netCents: 0 });
    expect(sh.totals.netProfitCents).toBe(0);

    // void on a second Telecom product: P1 10 for 60,000 (04-28), P2 10 for 2,000, sell 8 at 1,000 -> void P1: gain 60,000 - 37,200 = 22,800 on 04-28
    const Z = (await mkTelecom(s, { sellPriceCents: 1000, minPriceCents: 1 })).id;
    const q1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 60000 }], { businessDate: '2025-04-28' });
    await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 2000 }], { businessDate: '2025-05-02' });
    await sellOk(s, [cl(Z, 8, 1000)], { businessDate: '2025-05-03' });
    expect((await post(s.app, `/purchases/${q1.id}/void`, { reason: 'wrong bill' })).status).toBe(200);
    t = await pnl(s, 'telecom', '2025-04-01', '2025-05-31');
    expect(t.rows.map((r: any) => [r.period.label, r.adjustments.purchaseRefundGainCents])).toEqual([['2025-04', 22800], ['2025-05', 11200]]);
    // April +22,800; May: (12,000 - 37,200 + 11,200) + (8,000 - 24,800) = -14,000 - 16,800 = -30,800; total -8,000
    expect(t.rows.map((r: any) => r.netProfitCents)).toEqual([22800, -30800]);
    expect(t.totals.netProfitCents).toBe(-8000);
    expect(sum((await pnl(s, 'telecom', '2025-04-01', '2025-05-31', 'day')).rows, (r) => r.netProfitCents)).toBe(-8000);
  });

  it('Combined and Dashboard include the gain (Shop world: profit -14,000; gain 11,200 on the return day)', async () => {
    const s = await apiBase(await env.build());
    const { p1 } = await world(s, false);
    expect((await ret(s, p1, '2025-05-04', 6)).status).toBe(201);
    const c = await pnl(s, 'combined', '2025-05-01', '2025-05-31');
    expect(c.totals.segments.shop.recognizedProfitCents).toBe(-14000);
    expect(c.totals.recognizedProfitCents).toBe(-14000);
    const cd = await pnl(s, 'combined', '2025-05-01', '2025-05-31', 'day');
    expect(sum(cd.rows, (r) => r.recognizedProfitCents)).toBe(-14000);
    // dashboard, today = 05-04 : profit = the gain only (no sales that day); month so far: sales 12,000, profit -14,000
    const d4 = (await get(s.app, '/dashboard?asOf=2025-05-04')).body;
    expect(d4.today.bySegment.shop).toEqual({ salesCents: 0, profitCents: 11200 });
    expect(d4.month.bySegment.shop).toEqual({ salesCents: 12000, profitCents: -14000 });
    expect(d4.month.profitCents).toBe(-14000);
    const d3 = (await get(s.app, '/dashboard?asOf=2025-05-03')).body;
    expect(d3.month.profitCents).toBe(-25200); // before the return: revenue 12,000 - cogs 37,200
  });

  it('the stock-losses memo shows the same net stock adjustments as the P&L (-11,200) and honours the book filter', async () => {
    const s = await apiBase(await env.build());
    const { p1 } = await world(s, false);
    expect((await ret(s, p1, '2025-05-04', 6)).status).toBe(201);
    const r = (await get(s.app, '/reports/stock-losses?from=2025-05-01&to=2025-05-31&granularity=month')).body;
    expect(r.totals).toMatchObject({ purchaseRefundGainCents: 11200, sweepCents: 0, stockAdjustmentsNetCents: -11200 });
    expect((await get(s.app, '/reports/stock-losses?from=2025-05-01&to=2025-05-31&granularity=month&book=telecom')).body.totals.stockAdjustmentsNetCents).toBe(0);
  });

  it('voided-then-never-recorded: a purchase voided right away leaves the P&L identical to a world without it', async () => {
    const a = await apiBase(await env.build());
    const b = await apiBase(await env2.build());
    const run = async (s: S, withVoid: boolean) => {
      const Z = (await mkProduct(s, { sellPriceCents: 1000, minPriceCents: 1 })).id;
      await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 5000 }], { businessDate: '2025-05-01' });
      if (withVoid) {
        const v = await buy(s, [{ productId: Z, packs: 1, packSize: 4, lineTotalCents: 8000 }], { businessDate: '2025-05-02' });
        // pool 10 / 5,000 + 4 / 8,000: nothing sold, void removes min(8,000, 13,000) = 8,000 -> gain 0, identical figures
        expect((await post(s.app, `/purchases/${v.id}/void`, { reason: 'typo' })).status).toBe(200);
      }
      await sellOk(s, [cl(Z, 3, 1000)], { businessDate: '2025-05-03' });
      return pnl(s, 'shop', '2025-05-01', '2025-05-31');
    };
    const x = await run(a, true);
    const y = await run(b, false);
    expect(x.totals).toEqual(y.totals);
    expect(x.totals.adjustments.purchaseRefundGainCents).toBe(0);
  });
});
