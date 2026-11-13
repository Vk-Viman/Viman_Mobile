// Phase 11 FINANCIAL reports against ONE scripted two-month shop (March-April 2025) built through the real API
// (helpers/phase11fin.ts holds the script). Every expected figure below is calculated BY HAND from that script - the working is
// in the comments - and never taken from report code. Protects (BUSINESS_RULES / API_CONTRACTS Wave 4):
//   Shop P&L      goods revenue and cost net of returns in the RETURN's period (R5), cost = automatic + extra (C13), print services
//                 (R12), expenses by category (E2), stock adjustments net = losses + stocktake losses + sweeps - gains + damaged-return
//                 loss counted once (section 11), cash over/short (C4); printing supplies, drawings, capital, transfers are NOT P&L;
//   Telecom P&L   commission only (section 5, R14), scratch cards, expenses, adjustments, over/short; top-ups are memo cash only;
//   Ice Cream     sections 10.3-10.6: recognized profit, charge lines, memo, excess cost flow, balances at period end, never summed;
//   Combined      = Shop + Telecom + Ice Cream recognized (section 0); electricity info line is never added (E5);
//   Cash books    opening/in/out/closing per period, per type, per fund; last closing = ledger balance (section 8, 10.1);
//   Transfers     posted transfers only, totals by direction;  Funds report  agrees with GET /icecream/funds (10.1, 10.6);
//   Additivity    day rows add up to month rows and to the total row; voided records change nothing compared with never recorded.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get } from './helpers/catalog.ts';
import { num } from './helpers/phase4.ts';
import { buildFinWorld, q, rep } from './helpers/phase11fin.ts';

const env = new TestEnv();
let s: ApiBase;
let sNoVoids: ApiBase;

beforeAll(async () => {
  s = await apiBase(await env.build());
  await buildFinWorld(s, true);
  sNoVoids = await apiBase(await env.build());
  await buildFinWorld(sNoVoids, false);
}, 240000);
afterAll(async () => { await env.cleanup(); });

const CATS = ['water', 'rent', 'internet', 'transport', 'repairs', 'cleaning_supplies', 'packaging', 'stationery', 'other'];
const cats = (o: Record<string, number> = {}) => Object.fromEntries(CATS.map((c) => [c, o[c] ?? 0]));

/** Day rows of a report keyed by label. */
const byLabel = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.period.label, r]));

// ---------------------------------------------------------------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------------------------------------------------------------

/** A full Shop figure record: the given base numbers, everything else zero. Derived lines are written out by hand in each case. */
function shopFig(o: {
  sales?: number; returns?: number; auto?: number; extra?: number; svcRev?: number; svcCost?: number; exp?: Record<string, number>;
  loss?: number; dmg?: number; stl?: number; stg?: number; sweep?: number; os?: number; net: number;
  rev: number; cost: number; gp: number; gross: number; expTotal?: number; adj?: number; svcGp?: number;
}) {
  return {
    goods: {
      salesCents: o.sales ?? 0, returnsCents: o.returns ?? 0, revenueCents: o.rev, costAutomaticCents: o.auto ?? 0, costExtraCents: o.extra ?? 0,
      costOfSalesCents: o.cost, grossProfitCents: o.gp,
    },
    services: { revenueCents: o.svcRev ?? 0, costCents: o.svcCost ?? 0, grossProfitCents: o.svcGp ?? 0 },
    grossProfitCents: o.gross,
    expenses: { totalCents: o.expTotal ?? 0, byCategory: cats(o.exp) },
    adjustments: {
      lossesCents: o.loss ?? 0, damagedReturnLossesCents: o.dmg ?? 0, stocktakeLossesCents: o.stl ?? 0, stocktakeGainsCents: o.stg ?? 0,
      residualSweepsCents: o.sweep ?? 0, purchaseRefundGainCents: 0, salesReturnVoidGainCents: 0, netCents: o.adj ?? 0,
    },
    cashOverShortCents: o.os ?? 0, netProfitCents: o.net,
  };
}
const ZERO_SHOP = shopFig({ rev: 0, cost: 0, gp: 0, gross: 0, net: 0 });

/**
 * Shop, active days (hand-calculated, cents):
 *  03-02 S1 200,000 (cost 120,000 auto + 4,000 extra) + S2 104,000 (cost 60,000): revenue 304,000, auto 180,000, extra 4,000, GP 120,000.
 *  03-03 E1 60,000, cost 30,000 (pool 2/60,000 -> 30,000): GP 30,000.   03-04 S3 sold and voided: nothing.
 *  03-05 R1: 1 of 4 units of S1: revenue 200,000x1/4 = 50,000, auto 120,000x1/4 = 30,000, extra 4,000x1/4 = 1,000 -> GP -50,000+30,000+1,000 = -19,000.
 *  03-06 R2 damaged: 1 of 2 of S2: revenue 52,000, auto 30,000 -> GP -22,000; the written-off cost 30,000 is the ONE loss (damaged return) -> net -52,000.
 *  03-08 print 10 x 1,500 + 4 x 2,000 = 23,000, cost 10 x 650 + 4 x 650 = 9,100 -> 13,900 (the voided CUSTOM sale is absent).
 *  03-10 B1: pool 3/100,000 -> cost round(33,333.33) = 33,333; revenue 40,000 -> GP 6,667; rent 80,000 + water 5,000 = 85,000 -> net -78,333.
 *  03-11 B2: pool 2/66,667 -> round(33,333.5) = 33,334 (half away from zero) -> GP 6,666 (the voided Rs 99.99 expense is absent).
 *  03-12 lost B: pool 1/33,333 -> the whole 33,333 -> net -33,333.   03-15 stocktake A 5 -> 4: 150,000/5 = 30,000 -> -30,000.
 *  03-16 stocktake C 4 -> 6: gain 40,000 x 2/4 = 20,000 -> +20,000.   03-20 loss A: pool 4/120,000 -> 30,000.   03-21 loss C voided: 0.
 *  03-24 purchase return of E's purchase: removes min(10,000, 30,000), qty 1 -> 0 leaves 20,000 -> residual sweep 20,000.
 *  03-25 transport 3,000.  03-28 count short 2,500.   04-02 R3: remaining 3 units: revenue 150,000, auto 90,000, extra 3,000 -> GP -57,000.
 *  04-03 rent 80,000.  04-04 print 20 x 2,500 = 50,000, cost 20 x 900 = 18,000 -> 32,000.   04-05 count over +1,500.
 */
const SHOP_DAYS: Record<string, ReturnType<typeof shopFig>> = {
  '2025-03-02': shopFig({ sales: 304000, auto: 180000, extra: 4000, rev: 304000, cost: 184000, gp: 120000, gross: 120000, net: 120000 }),
  '2025-03-03': shopFig({ sales: 60000, auto: 30000, rev: 60000, cost: 30000, gp: 30000, gross: 30000, net: 30000 }),
  '2025-03-05': shopFig({ returns: 50000, auto: -30000, extra: -1000, rev: -50000, cost: -31000, gp: -19000, gross: -19000, net: -19000 }),
  '2025-03-06': shopFig({ returns: 52000, auto: -30000, rev: -52000, cost: -30000, gp: -22000, gross: -22000, dmg: 30000, adj: 30000, net: -52000 }),
  '2025-03-08': shopFig({ svcRev: 23000, svcCost: 9100, svcGp: 13900, rev: 0, cost: 0, gp: 0, gross: 13900, net: 13900 }),
  '2025-03-10': shopFig({ sales: 40000, auto: 33333, rev: 40000, cost: 33333, gp: 6667, gross: 6667, exp: { rent: 80000, water: 5000 }, expTotal: 85000, net: -78333 }),
  '2025-03-11': shopFig({ sales: 40000, auto: 33334, rev: 40000, cost: 33334, gp: 6666, gross: 6666, net: 6666 }),
  '2025-03-12': shopFig({ loss: 33333, adj: 33333, rev: 0, cost: 0, gp: 0, gross: 0, net: -33333 }),
  '2025-03-15': shopFig({ stl: 30000, adj: 30000, rev: 0, cost: 0, gp: 0, gross: 0, net: -30000 }),
  '2025-03-16': shopFig({ stg: 20000, adj: -20000, rev: 0, cost: 0, gp: 0, gross: 0, net: 20000 }),
  '2025-03-20': shopFig({ loss: 30000, adj: 30000, rev: 0, cost: 0, gp: 0, gross: 0, net: -30000 }),
  '2025-03-24': shopFig({ sweep: 20000, adj: 20000, rev: 0, cost: 0, gp: 0, gross: 0, net: -20000 }),
  '2025-03-25': shopFig({ exp: { transport: 3000 }, expTotal: 3000, rev: 0, cost: 0, gp: 0, gross: 0, net: -3000 }),
  '2025-03-28': shopFig({ os: -2500, rev: 0, cost: 0, gp: 0, gross: 0, net: -2500 }),
  '2025-04-02': shopFig({ returns: 150000, auto: -90000, extra: -3000, rev: -150000, cost: -93000, gp: -57000, gross: -57000, net: -57000 }),
  '2025-04-03': shopFig({ exp: { rent: 80000 }, expTotal: 80000, rev: 0, cost: 0, gp: 0, gross: 0, net: -80000 }),
  '2025-04-04': shopFig({ svcRev: 50000, svcCost: 18000, svcGp: 32000, rev: 0, cost: 0, gp: 0, gross: 32000, net: 32000 }),
  '2025-04-05': shopFig({ os: 1500, rev: 0, cost: 0, gp: 0, gross: 0, net: 1500 }),
};

/**
 * Month rows (sums of the days above, added by hand):
 *  March goods: sales 304,000+60,000+40,000+40,000 = 444,000; returns 50,000+52,000 = 102,000; revenue 342,000;
 *   auto 180,000+30,000+33,333+33,334 = 276,667 - 60,000 = 216,667; extra 4,000-1,000 = 3,000; cost 219,667; GP 122,333.
 *  March gross 122,333 + 13,900 = 136,233; expenses 88,000; adjustments losses 33,333+30,000 = 63,333, damaged 30,000, stocktake loss 30,000,
 *   gain 20,000, sweep 20,000 -> 63,333+30,000+30,000+20,000-20,000 = 123,333; over/short -2,500; net 136,233-88,000-123,333-2,500 = -77,600.
 *  April: revenue -150,000, cost -93,000, GP -57,000; services 32,000; gross -25,000; rent 80,000; over/short +1,500; net -103,500.
 *  Total: net -77,600-103,500 = -181,100; revenue 192,000; auto 126,667; extra 0; GP 65,333; gross 111,233; expenses 168,000 (rent 160,000).
 */
const SHOP_MARCH = shopFig({
  sales: 444000, returns: 102000, auto: 216667, extra: 3000, svcRev: 23000, svcCost: 9100, svcGp: 13900, rev: 342000, cost: 219667, gp: 122333,
  gross: 136233, exp: { rent: 80000, water: 5000, transport: 3000 }, expTotal: 88000, loss: 63333, dmg: 30000, stl: 30000, stg: 20000, sweep: 20000, adj: 123333,
  os: -2500, net: -77600,
});
const SHOP_APRIL = shopFig({
  returns: 150000, auto: -90000, extra: -3000, svcRev: 50000, svcCost: 18000, svcGp: 32000, rev: -150000, cost: -93000, gp: -57000, gross: -25000,
  exp: { rent: 80000 }, expTotal: 80000, os: 1500, net: -103500,
});
const SHOP_TOTAL = shopFig({
  sales: 444000, returns: 252000, auto: 126667, extra: 0, svcRev: 73000, svcCost: 27100, svcGp: 45900, rev: 192000, cost: 126667, gp: 65333, gross: 111233,
  exp: { rent: 160000, water: 5000, transport: 3000 }, expTotal: 168000, loss: 63333, dmg: 30000, stl: 30000, stg: 20000, sweep: 20000, adj: 123333,
  os: -1000, net: -181100,
});

describe('GET /reports/pnl/shop', () => {
  it('every day of March-April: each active day matches the hand calculation, every other day is all zero', async () => {
    const r = await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'day'));
    expect(r.status).toBe(200);
    expect(r.body.segment).toBe('shop');
    expect(r.body.rows).toHaveLength(61); // 31 + 30 days
    const days = byLabel(r.body.rows);
    for (const [label, row] of Object.entries(days)) {
      const { period, ...figures } = row as any;
      expect(period.from).toBe(label); expect(period.to).toBe(label);
      expect(figures, label).toEqual(SHOP_DAYS[label] ?? ZERO_SHOP);
    }
  });

  it('month rows and the total row match the hand calculation; day rows add up to both (additivity)', async () => {
    const m = await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'month'));
    expect(m.body.rows.map((x: any) => x.period.label)).toEqual(['2025-03', '2025-04']);
    const { period: _p1, ...mar } = m.body.rows[0]; const { period: _p2, ...apr } = m.body.rows[1];
    expect(mar).toEqual(SHOP_MARCH);
    expect(apr).toEqual(SHOP_APRIL);
    expect(m.body.totals).toEqual(SHOP_TOTAL);
    // additivity: the day rows sum to the month rows
    const d = await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'day'));
    const sum = (pick: (x: any) => number, from: string, to: string) =>
      d.body.rows.filter((x: any) => x.period.from >= from && x.period.to <= to).reduce((a: number, x: any) => a + pick(x), 0);
    for (const [from, to, expected] of [['2025-03-01', '2025-03-31', SHOP_MARCH], ['2025-04-01', '2025-04-30', SHOP_APRIL]] as const) {
      expect(sum((x) => x.netProfitCents, from, to)).toBe(expected.netProfitCents);
      expect(sum((x) => x.goods.revenueCents, from, to)).toBe(expected.goods.revenueCents);
      expect(sum((x) => x.goods.costOfSalesCents, from, to)).toBe(expected.goods.costOfSalesCents);
      expect(sum((x) => x.adjustments.netCents, from, to)).toBe(expected.adjustments.netCents);
      expect(sum((x) => x.expenses.totalCents, from, to)).toBe(expected.expenses.totalCents);
    }
    expect(d.body.totals).toEqual(SHOP_TOTAL);
    // the same range as ONE custom row gives the same figures as the sum of both months
    const one = await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'month'));
    expect(one.body.totals.netProfitCents).toBe(-181100);
  });

  it('the table: columns, one row per period, totals row and notes; electricity is never an expense column', async () => {
    const r = await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'month'));
    const t = r.body.table;
    expect(t.title).toBe('Shop profit and loss');
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toMatchObject({ period: '2025-03', goodsRevenue: 342000, costAutomatic: 216667, costExtra: 3000, goodsProfit: 122333, serviceProfit: 13900, expenses: 88000, adjustments: 123333, overShort: -2500, netProfit: -77600 });
    expect(t.totals).toMatchObject({ period: 'Total', netProfit: -181100 });
    expect(JSON.stringify(t.columns).toLowerCase()).not.toContain('electric');
    expect(Object.keys(r.body.totals.expenses.byCategory)).not.toContain('electricity');
    expect(t.notes.length).toBeGreaterThan(2);
    expect(r.body.warnings).toEqual([]);
  });

  it('things that are NOT profit: printing supplies, goods drawing, capital, cash drawings, transfers, opening balances change no figure', async () => {
    // The script posts supplies 100,000, a goods drawing, capital 100,000, two cash drawings (Shop 20,000, Ice Cream 20,000) and three transfers; the March total above
    // (-77,600) contains none of them. Cross-check by reading the ledgers: they exist, so their absence from P&L is a real result.
    expect(num(s, "SELECT COUNT(*) FROM printing_supplies WHERE status='posted'")).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM owner_drawings WHERE status='posted'")).toBe(3);
    expect(num(s, "SELECT COUNT(*) FROM capital_entries WHERE kind='capital' AND status='posted'")).toBe(2);
    expect(num(s, "SELECT COUNT(*) FROM cash_transfers WHERE status='posted'")).toBe(3);
    const r = await rep(s, 'pnl/shop', q('2025-03-01', '2025-03-31', 'month'));
    expect(r.body.totals.netProfitCents).toBe(-77600);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Telecom
// ---------------------------------------------------------------------------------------------------------------------------------

function telFig(o: {
  relSales?: number; relBase?: number; relExtra?: number; ezBill?: number; ezComm?: number; commRev: number;
  cSales?: number; cReturns?: number; cAuto?: number; cExtra?: number; cRev?: number; cCost?: number; cGp?: number;
  gross: number; exp?: Record<string, number>; expTotal?: number; loss?: number; stl?: number; adj?: number; os?: number; net: number;
  prov?: number; wallet?: number;
}) {
  return {
    commissions: {
      reloadSalesCents: o.relSales ?? 0, reloadBaseCommissionCents: o.relBase ?? 0, reloadExtraCents: o.relExtra ?? 0,
      reloadCommissionCents: (o.relBase ?? 0) + (o.relExtra ?? 0), ezcashBillCents: o.ezBill ?? 0, ezcashCommissionCents: o.ezComm ?? 0,
    },
    commissionRevenueCents: o.commRev,
    cards: {
      salesCents: o.cSales ?? 0, returnsCents: o.cReturns ?? 0, revenueCents: o.cRev ?? 0, costAutomaticCents: o.cAuto ?? 0, costExtraCents: o.cExtra ?? 0,
      costOfSalesCents: o.cCost ?? 0, grossProfitCents: o.cGp ?? 0,
    },
    grossProfitCents: o.gross,
    expenses: { totalCents: o.expTotal ?? 0, byCategory: cats(o.exp) },
    adjustments: { lossesCents: o.loss ?? 0, damagedReturnLossesCents: 0, stocktakeLossesCents: o.stl ?? 0, stocktakeGainsCents: 0, residualSweepsCents: 0, purchaseRefundGainCents: 0, salesReturnVoidGainCents: 0, netCents: o.adj ?? 0 },
    cashOverShortCents: o.os ?? 0, netProfitCents: o.net,
    memo: { providerTopupsCents: o.prov ?? 0, walletTopupsCents: o.wallet ?? 0 },
  };
}
const ZERO_TEL = telFig({ commRev: 0, gross: 0, net: 0 });

/**
 * Telecom, active days (hand-calculated; default rate 600 bp, EZCash 80 bp):
 *  03-02 reloads Dialog 5,000,000 -> 300,000 and Hutch 123,456 -> 7,407.36 = 7,407: commission 307,407.
 *  03-03 card sale T1 5 x 6,000 = 30,000, cost auto 5 x 5,000 = 25,000 + extra 5 x 100 = 500 -> GP 4,500.   03-04 T2 sold and voided; EZCash 250,000 x 80 bp = 2,000;
 *        the voided card sale T2 and the voided EZCash/reload entries are absent.
 *  03-05 Mobitel 100,000 -> 6,000 + extra 50 = 6,050.   03-06 EZCash 123,457 x 80 bp = 987.656 = 988.
 *  03-07 card return 2 of 5: revenue 12,000, auto 10,000, extra 200 -> GP -1,800; provider top-up 200,000 = cash only (R14).
 *  03-08 wallet top-up 150,000 = cash only.   03-09 loss of a card: pool 17/85,000 -> 5,000.   03-12 internet 30,000.
 *  03-14 stocktake 16 -> 15: 80,000/16 = 5,000 loss.   03-20 count over +800.   04-01 reload 100,000 -> 6,000.  04-02 repairs 7,000.  04-06 count short -300.
 */
const TEL_DAYS: Record<string, ReturnType<typeof telFig>> = {
  '2025-03-02': telFig({ relSales: 5123456, relBase: 307407, commRev: 307407, gross: 307407, net: 307407 }),
  '2025-03-03': telFig({ cSales: 30000, cAuto: 25000, cExtra: 500, cRev: 30000, cCost: 25500, cGp: 4500, commRev: 0, gross: 4500, net: 4500 }),
  '2025-03-04': telFig({ ezBill: 250000, ezComm: 2000, commRev: 2000, gross: 2000, net: 2000 }),
  '2025-03-05': telFig({ relSales: 100000, relBase: 6000, relExtra: 50, commRev: 6050, gross: 6050, net: 6050 }),
  '2025-03-06': telFig({ ezBill: 123457, ezComm: 988, commRev: 988, gross: 988, net: 988 }),
  '2025-03-07': telFig({ cReturns: 12000, cAuto: -10000, cExtra: -200, cRev: -12000, cCost: -10200, cGp: -1800, commRev: 0, gross: -1800, net: -1800, prov: 200000 }),
  '2025-03-08': telFig({ commRev: 0, gross: 0, net: 0, wallet: 150000 }),
  '2025-03-09': telFig({ commRev: 0, gross: 0, loss: 5000, adj: 5000, net: -5000 }),
  '2025-03-12': telFig({ commRev: 0, gross: 0, exp: { internet: 30000 }, expTotal: 30000, net: -30000 }),
  '2025-03-14': telFig({ commRev: 0, gross: 0, stl: 5000, adj: 5000, net: -5000 }),
  '2025-03-20': telFig({ commRev: 0, gross: 0, os: 800, net: 800 }),
  '2025-04-01': telFig({ relSales: 100000, relBase: 6000, commRev: 6000, gross: 6000, net: 6000 }),
  '2025-04-02': telFig({ commRev: 0, gross: 0, exp: { repairs: 7000 }, expTotal: 7000, net: -7000 }),
  '2025-04-06': telFig({ commRev: 0, gross: 0, os: -300, net: -300 }),
};
/**
 * March: reload sales 5,123,456 + 100,000 = 5,223,456 (hmm: 03-02 5,000,000 + 123,456 = 5,123,456; plus Mobitel 100,000 = 5,223,456); base 307,407 + 6,000 = 313,407; extra 50;
 *  EZCash bills 373,457, commission 2,988; commission revenue 313,457 + 2,988 = 316,445; cards sales 30,000, returns 12,000, revenue 18,000, auto 15,000, extra 300,
 *  GP 2,700; gross 319,145; expenses 30,000; adjustments 5,000 + 5,000 = 10,000; over/short +800; net 319,145-30,000-10,000+800 = 279,945.
 * April: reload 100,000 -> 6,000; expenses 7,000; over/short -300 -> net -1,300.  Total net 278,645; reload sales 5,323,456; base 319,407.
 */
const TEL_MARCH = telFig({
  relSales: 5223456, relBase: 313407, relExtra: 50, ezBill: 373457, ezComm: 2988, commRev: 316445, cSales: 30000, cReturns: 12000, cAuto: 15000, cExtra: 300,
  cRev: 18000, cCost: 15300, cGp: 2700, gross: 319145, exp: { internet: 30000 }, expTotal: 30000, loss: 5000, stl: 5000, adj: 10000, os: 800, net: 279945,
  prov: 200000, wallet: 150000,
});
const TEL_APRIL = telFig({ relSales: 100000, relBase: 6000, commRev: 6000, gross: 6000, exp: { repairs: 7000 }, expTotal: 7000, os: -300, net: -1300 });
const TEL_TOTAL = telFig({
  relSales: 5323456, relBase: 319407, relExtra: 50, ezBill: 373457, ezComm: 2988, commRev: 322445, cSales: 30000, cReturns: 12000, cAuto: 15000, cExtra: 300,
  cRev: 18000, cCost: 15300, cGp: 2700, gross: 325145, exp: { internet: 30000, repairs: 7000 }, expTotal: 37000, loss: 5000, stl: 5000, adj: 10000, os: 500,
  net: 278645, prov: 200000, wallet: 150000,
});

describe('GET /reports/pnl/telecom', () => {
  it('every day: commission only, cards net of returns, expenses, adjustments, over/short; top-ups are memo cash only', async () => {
    const r = await rep(s, 'pnl/telecom', q('2025-03-01', '2025-04-30', 'day'));
    expect(r.status).toBe(200);
    const days = byLabel(r.body.rows);
    for (const [label, row] of Object.entries(days)) {
      const { period, ...figures } = row as any;
      expect(period.label).toBe(label);
      expect(figures, label).toEqual(TEL_DAYS[label] ?? ZERO_TEL);
    }
    expect(r.body.totals).toEqual(TEL_TOTAL);
  });

  it('month rows and totals; day rows add up to the months (additivity)', async () => {
    const m = await rep(s, 'pnl/telecom', q('2025-03-01', '2025-04-30', 'month'));
    const { period: _a, ...mar } = m.body.rows[0]; const { period: _b, ...apr } = m.body.rows[1];
    expect(mar).toEqual(TEL_MARCH);
    expect(apr).toEqual(TEL_APRIL);
    expect(m.body.totals).toEqual(TEL_TOTAL);
    const d = await rep(s, 'pnl/telecom', q('2025-03-01', '2025-03-31', 'day'));
    expect(d.body.rows.reduce((a: number, x: any) => a + x.netProfitCents, 0)).toBe(279945);
    expect(m.body.table.totals).toMatchObject({ reloadBase: 319407, reloadExtra: 50, ezcash: 2988, cardProfit: 2700, netProfit: 278645, topups: 350000 });
    expect(JSON.stringify(m.body.table.columns).toLowerCase()).not.toContain('electric');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ice Cream (hand-calculated from the script; see the working in the comments)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Ice Cream working (Charged/Settled by line, M = materials, E = electricity; U = unspent = Charged - Settled):
 *  03-02 day 100,000/60,000/10,000 -> share 30,000.   03-03 day 80,000/50,000/8,000 -> share 22,000.   03-04 day voided -> nothing.
 *  03-05 materials 100,000: SeM 100,000, U_M = 110,000-100,000 = 10,000.   03-06 bill 30,000: SeE 30,000, U_E = 18,000-30,000 = -12,000, U = -2,000 -> excess 2,000 (flow +2,000).
 *  03-07 other cost 2,000 from Profit: expense -2,000.   03-08 other cost 1,000 from Cost: SeM 101,000, U_M = 9,000, U = -3,000 -> excess 3,000 (flow +1,000).
 *  03-09 day 60,000/36,000/6,000 -> share 18,000; ChM 146,000 ChE 24,000; U_M 45,000 U_E -6,000, U = 39,000 -> excess 0 (flow -3,000).
 *  03-12 bill 50,000: SeE 80,000; U_E = 24,000-80,000 = -56,000; U = -11,000 -> excess 11,000 (flow +11,000).
 *  03-13 re-allocation Profit -> Electricity 4,000: ChE 28,000, recognized -4,000, U = -7,000 -> excess 7,000 (flow -4,000).
 *  03-14 Cost -> Profit 5,000: limit = min(max(0,45,000), max(0,-7,000)=0) = 0 -> profit-eligible 0, cash-only 5,000: no profit.
 *  03-15 Cost -> Electricity 10,000: re-label min(10,000, 45,000) = 10,000: ChM 136,000, ChE 38,000, U unchanged.
 *  03-16 count short 500: -500.   03-17/18/19/20: drawing, transfers, capital: no profit.
 *  03-25 day 90,000/50,000/9,000 -> share 31,000; ChM 186,000 ChE 47,000; U_M 85,000, U_E -33,000, U = 52,000 -> excess 0 (flow -7,000).
 *  04-01 bill 80,000: SeE 160,000, U_E -113,000, U = -28,000 -> excess 28,000 (flow +28,000).
 *  04-02 day 20,000/10,000/2,000 -> share 8,000; U_M 95,000, U_E -111,000, U = -16,000 -> excess 16,000 (flow -12,000).   04-03 Cost -> Profit 3,000: cash-only.
 *  March recognized = 30,000+22,000-2,000+18,000-4,000-500+31,000 = 94,500 (shares 101,000, reallocation -4,000, other -2,000, over/short -500).
 *  April recognized = 8,000; excess flow +16,000; profit after excess -8,000.
 */
function ice(o: {
  sales?: number; mat?: number; elec?: number; other?: number; os?: number; rec: number;
  rc?: { share?: number; rel?: number; realloc?: number; other?: number; os?: number };
  memo?: [number, number, number]; excess?: number; after: number; uM: number; uE: number; out: number;
}) {
  return {
    salesCents: o.sales ?? 0, materialsChargeCents: o.mat ?? 0, electricityChargeCents: o.elec ?? 0, otherExpensesCents: o.other ?? 0,
    cashOverShortCents: o.os ?? 0, recognizedProfitCents: o.rec,
    recognition: {
      dailyProfitShareCents: o.rc?.share ?? 0, profitEligibleReleasesCents: o.rc?.rel ?? 0, reallocationsCents: o.rc?.realloc ?? 0,
      otherExpensesCents: o.rc?.other ?? 0, cashOverShortCents: o.rc?.os ?? 0,
    },
    memo: { actualMaterialsPaidCents: o.memo?.[0] ?? 0, actualElectricityPaidCents: o.memo?.[1] ?? 0, otherCostsFromCostElecFundsCents: o.memo?.[2] ?? 0 },
    excessCostNotChargedCents: o.excess ?? 0, profitAfterExcessCostCents: o.after,
    balancesAsOfPeriodEnd: { unspentByLine: { materialsCents: o.uM, electricityCents: o.uE }, unspentCents: o.uM + o.uE, outstandingExcessCostCents: o.out },
  };
}

const ICE_MARCH = ice({
  sales: 330000, mat: 186000, elec: 47000, other: 2000, os: -500, rec: 94500,
  rc: { share: 101000, realloc: -4000, other: -2000, os: -500 }, memo: [100000, 80000, 1000], after: 94500, uM: 85000, uE: -33000, out: 0,
});
const ICE_APRIL = ice({
  sales: 20000, mat: 10000, elec: 2000, rec: 8000, rc: { share: 8000 }, memo: [0, 80000, 0], excess: 16000, after: -8000, uM: 95000, uE: -111000, out: 16000,
});
const ICE_TOTAL = ice({
  sales: 350000, mat: 196000, elec: 49000, other: 2000, os: -500, rec: 102500, rc: { share: 109000, realloc: -4000, other: -2000, os: -500 },
  memo: [100000, 160000, 1000], excess: 16000, after: 86500, uM: 95000, uE: -111000, out: 16000,
});

describe('GET /reports/pnl/icecream', () => {
  it('month rows and totals match the hand calculation (recognized profit, charge lines, memo, excess flow, balances at period end)', async () => {
    const r = await rep(s, 'pnl/icecream', q('2025-03-01', '2025-04-30', 'month'));
    expect(r.status).toBe(200);
    const { period: _a, ...mar } = r.body.rows[0]; const { period: _b, ...apr } = r.body.rows[1];
    expect(mar).toEqual(ICE_MARCH);
    expect(apr).toEqual(ICE_APRIL);
    expect(r.body.totals).toEqual(ICE_TOTAL);
    // D3 warning: outstanding at the END date only
    expect(r.body.warnings).toHaveLength(1);
    expect(r.body.warnings[0]).toMatchObject({ code: 'EXCESS_COST_OUTSTANDING', outstandingExcessCostCents: 16000, asOf: '2025-04-30' });
    const march = await rep(s, 'pnl/icecream', q('2025-03-01', '2025-03-31', 'month'));
    expect(march.body.warnings).toEqual([]); // outstanding at 03-31 is 0
  });

  it('daily rows: each event day (hand-calculated) and additivity of the three period-flow lines', async () => {
    const r = await rep(s, 'pnl/icecream', q('2025-03-01', '2025-04-30', 'day'));
    const d = byLabel(r.body.rows);
    const row = (label: string) => { const { period: _p, ...x } = d[label]; return x; };
    expect(row('2025-03-02')).toEqual(ice({ sales: 100000, mat: 60000, elec: 10000, rec: 30000, rc: { share: 30000 }, after: 30000, uM: 60000, uE: 10000, out: 0 }));
    expect(row('2025-03-04')).toEqual(ice({ rec: 0, after: 0, uM: 110000, uE: 18000, out: 0 })); // voided day: nothing (U at that date = 110,000+18,000)
    expect(row('2025-03-06')).toEqual(ice({ rec: 0, memo: [0, 30000, 0], excess: 2000, after: -2000, uM: 10000, uE: -12000, out: 2000 }));
    expect(row('2025-03-07')).toEqual(ice({ other: 2000, rec: -2000, rc: { other: -2000 }, after: -2000, uM: 10000, uE: -12000, out: 2000 }));
    expect(row('2025-03-08')).toEqual(ice({ rec: 0, memo: [0, 0, 1000], excess: 1000, after: -1000, uM: 9000, uE: -12000, out: 3000 }));
    expect(row('2025-03-09')).toEqual(ice({ sales: 60000, mat: 36000, elec: 6000, rec: 18000, rc: { share: 18000 }, excess: -3000, after: 21000, uM: 45000, uE: -6000, out: 0 }));
    expect(row('2025-03-12')).toEqual(ice({ rec: 0, memo: [0, 50000, 0], excess: 11000, after: -11000, uM: 45000, uE: -56000, out: 11000 }));
    expect(row('2025-03-13')).toEqual(ice({ elec: 4000, rec: -4000, rc: { realloc: -4000 }, excess: -4000, after: 0, uM: 45000, uE: -52000, out: 7000 }));
    expect(row('2025-03-14')).toEqual(ice({ rec: 0, after: 0, uM: 45000, uE: -52000, out: 7000 })); // D4: all cash-only
    expect(row('2025-03-15')).toEqual(ice({ mat: -10000, elec: 10000, rec: 0, after: 0, uM: 35000, uE: -42000, out: 7000 })); // re-label
    expect(row('2025-03-16')).toEqual(ice({ os: -500, rec: -500, rc: { os: -500 }, after: -500, uM: 35000, uE: -42000, out: 7000 }));
    expect(row('2025-03-25')).toEqual(ice({ sales: 90000, mat: 50000, elec: 9000, rec: 31000, rc: { share: 31000 }, excess: -7000, after: 38000, uM: 85000, uE: -33000, out: 0 }));
    expect(row('2025-04-01')).toEqual(ice({ rec: 0, memo: [0, 80000, 0], excess: 28000, after: -28000, uM: 85000, uE: -113000, out: 28000 }));
    expect(row('2025-04-02')).toEqual(ice({ sales: 20000, mat: 10000, elec: 2000, rec: 8000, rc: { share: 8000 }, excess: -12000, after: 20000, uM: 95000, uE: -111000, out: 16000 }));
    // additivity of the flows (balances are never summed)
    const sum = (pick: (x: any) => number) => r.body.rows.reduce((a: number, x: any) => a + pick(x), 0);
    expect(sum((x) => x.recognizedProfitCents)).toBe(102500);
    expect(sum((x) => x.excessCostNotChargedCents)).toBe(16000);
    expect(sum((x) => x.profitAfterExcessCostCents)).toBe(86500);
    expect(sum((x) => x.salesCents)).toBe(350000);
    expect(sum((x) => x.materialsChargeCents)).toBe(196000);
    expect(sum((x) => x.electricityChargeCents)).toBe(49000);
    expect(r.body.totals.balancesAsOfPeriodEnd).toEqual(ICE_TOTAL.balancesAsOfPeriodEnd);
  });

  it('the table carries the three period-flow lines and a balance column that is not a sum', async () => {
    const r = await rep(s, 'pnl/icecream', q('2025-03-01', '2025-04-30', 'month'));
    const t = r.body.table;
    expect(t.rows[1]).toMatchObject({ period: '2025-04', recognized: 8000, excess: 16000, afterExcess: -8000, outstanding: 16000 });
    expect(t.totals).toMatchObject({ recognized: 102500, excess: 16000, afterExcess: 86500, outstanding: 16000, actualElectricity: 160000 });
    expect(t.notes.join(' ')).toContain('Excess cost not yet charged');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------------------------------------------------------------

describe('GET /reports/pnl/combined', () => {
  it('Combined = Shop + Telecom + Ice Cream recognized; electricity lines are information only (E5); excess cost lines beside the official figure', async () => {
    const r = await rep(s, 'pnl/combined', q('2025-03-01', '2025-04-30', 'month'));
    expect(r.status).toBe(200);
    // March: -77,600 + 279,945 + 94,500 = 296,845.  April: -103,500 - 1,300 + 8,000 = -96,800.  Total 200,045.
    // Excess: March flow 0, April +16,000 -> after excess 296,845 / -112,800 / 184,045.
    expect(r.body.rows[0]).toMatchObject({
      segments: { shop: { recognizedProfitCents: -77600 }, telecom: { recognizedProfitCents: 279945 }, icecream: { recognizedProfitCents: 94500 } },
      recognizedProfitCents: 296845, electricityChargedCents: 47000, electricityBillsPaidCents: 80000, icecreamExcessCostNotChargedCents: 0,
      combinedProfitAfterExcessCostCents: 296845, outstandingExcessCostCents: 0,
    });
    expect(r.body.rows[1]).toMatchObject({
      segments: { shop: { recognizedProfitCents: -103500 }, telecom: { recognizedProfitCents: -1300 }, icecream: { recognizedProfitCents: 8000 } },
      recognizedProfitCents: -96800, electricityChargedCents: 2000, electricityBillsPaidCents: 80000, icecreamExcessCostNotChargedCents: 16000,
      combinedProfitAfterExcessCostCents: -112800, outstandingExcessCostCents: 16000,
    });
    expect(r.body.totals).toMatchObject({
      segments: { shop: { recognizedProfitCents: -181100 }, telecom: { recognizedProfitCents: 278645 }, icecream: { recognizedProfitCents: 102500 } },
      recognizedProfitCents: 200045, electricityChargedCents: 49000, electricityBillsPaidCents: 160000, icecreamExcessCostNotChargedCents: 16000,
      combinedProfitAfterExcessCostCents: 184045, outstandingExcessCostCents: 16000,
    });
    expect(r.body.warnings[0]).toMatchObject({ code: 'EXCESS_COST_OUTSTANDING', outstandingExcessCostCents: 16000 });
    // electricity is information only: the combined profit equals the three segment profits exactly (nothing deducted)
    const shop = (await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30'))).body.totals.netProfitCents;
    const tel = (await rep(s, 'pnl/telecom', q('2025-03-01', '2025-04-30'))).body.totals.netProfitCents;
    const ic = (await rep(s, 'pnl/icecream', q('2025-03-01', '2025-04-30'))).body.totals.recognizedProfitCents;
    expect(r.body.totals.recognizedProfitCents).toBe(shop + tel + ic);
    expect(r.body.table.totals).toMatchObject({ combined: 200045, afterExcess: 184045, electricityCharged: 49000, electricityPaid: 160000 });
  });

  it('day rows add up to the total for every flow line; the balance line is the value at the end date', async () => {
    const r = await rep(s, 'pnl/combined', q('2025-03-01', '2025-04-30', 'day'));
    const sum = (pick: (x: any) => number) => r.body.rows.reduce((a: number, x: any) => a + pick(x), 0);
    expect(sum((x) => x.recognizedProfitCents)).toBe(200045);
    expect(sum((x) => x.combinedProfitAfterExcessCostCents)).toBe(184045);
    expect(sum((x) => x.icecreamExcessCostNotChargedCents)).toBe(16000);
    expect(sum((x) => x.electricityChargedCents)).toBe(49000);
    expect(sum((x) => x.electricityBillsPaidCents)).toBe(160000);
    expect(r.body.rows[r.body.rows.length - 1].outstandingExcessCostCents).toBe(16000);
    expect(r.body.totals.outstandingExcessCostCents).toBe(16000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Cash books
// ---------------------------------------------------------------------------------------------------------------------------------

describe('GET /reports/cashbook/:book', () => {
  /**
   * Shop working: March "in" (positive rows) = opening 1,000,000 + capital 100,000 + sales 200,000+104,000+60,000+50,000(S3)+40,000+40,000 + print
   *  15,000+8,000 + voided print sale 20,000 + void-expense reversal 9,999 + purchase refund 10,000 + transfer in 30,000 (+7,777 of the voided transfer) = 1,694,776.
   *  "out" = purchases 300,000+100,000+40,000+10,000 + S3 reversal 50,000 + R1 50,000 + R2 52,000 + voided print reversal 20,000 + supplies 100,000
   *  + expenses 80,000+5,000+9,999 (voided one) + transfers 50,000+10,000 + transport 3,000 + drawing 20,000 + count short 2,500 = 902,499.
   *  The voided Telecom -> Shop transfer of 7,777 adds a transfer-in row (+7,777) and its reversal (-7,777) to the Shop book: in 1,694,776, out 910,276.
   *  closing = 1,694,776 - 910,276 = 784,500.  April: in = print 50,000 + count over 1,500 = 51,500; out = R3 150,000 + rent 80,000 = 230,000;
   *  closing 784,500 + 51,500 - 230,000 = 606,000.
   */
  it('Shop: per month opening / in / out / closing, hand-calculated; the last closing equals the ledger balance', async () => {
    const r = await rep(s, 'cashbook/shop', q('2025-03-01', '2025-04-30', 'month'));
    expect(r.status).toBe(200);
    const [mar, apr] = r.body.rows;
    expect([mar.openingCents, mar.inCents, mar.outCents, mar.closingCents]).toEqual([0, 1694776, 910276, 784500]);
    expect([apr.openingCents, apr.inCents, apr.outCents, apr.closingCents]).toEqual([784500, 51500, 230000, 606000]);
    expect(r.body.totals).toMatchObject({ openingCents: 0, inCents: 1746276, outCents: 1140276, closingCents: 606000 });
    expect(r.body.ledgerBalanceAsOfToCents).toBe(606000);
    expect(num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book='shop'")).toBe(606000);
    // per type (March): purchases out 450,000; refunds (R1 + R2) out 102,000; printing supplies out 100,000; drawings out 20,000; opening in 1,000,000
    const t = Object.fromEntries(mar.byType.map((x: any) => [x.type, x]));
    expect(t.purchase_payment).toMatchObject({ inCents: 0, outCents: 450000, netCents: -450000 });
    expect(t.sale_refund).toMatchObject({ outCents: 102000 });
    expect(t.printing_supplies).toMatchObject({ outCents: 100000 });
    expect(t.drawing_cash).toMatchObject({ outCents: 20000 });
    expect(t.opening_balance).toMatchObject({ inCents: 1000000 });
    expect(t.purchase_refund).toMatchObject({ inCents: 10000 });
    expect(t.capital).toMatchObject({ inCents: 100000 });
    expect(t.cash_adjustment).toMatchObject({ outCents: 2500 });
    expect(t.transfer_out).toMatchObject({ outCents: 60000 });
    expect(t.transfer_in).toMatchObject({ inCents: 37777, outCents: 7777 }); // 30,000 + the voided 7,777 and its reversal
    // the table
    expect(r.body.table.rows[0]).toMatchObject({ period: '2025-03', opening: 0, in: 1694776, out: 910276, closing: 784500 });
    expect(r.body.table.totals).toMatchObject({ closing: 606000 });
    expect(r.body.funds).toBeUndefined();
  });

  it('Shop by day: every row opens with the previous closing; days add up; closing of the last day = ledger balance', async () => {
    const r = await rep(s, 'cashbook/shop', q('2025-03-01', '2025-04-30', 'day'));
    const rows = r.body.rows;
    expect(rows).toHaveLength(61);
    for (let i = 1; i < rows.length; i++) expect(rows[i].openingCents, rows[i].period.label).toBe(rows[i - 1].closingCents);
    for (const row of rows) expect(row.closingCents).toBe(row.openingCents + row.inCents - row.outCents);
    expect(rows[rows.length - 1].closingCents).toBe(606000);
    expect(rows.reduce((a: number, x: any) => a + x.inCents, 0)).toBe(1746276);
    expect(rows.reduce((a: number, x: any) => a + x.outCents, 0)).toBe(1140276);
    // hand-calculated spot days: 03-01 opening 1,000,000 - purchases 440,000 = 560,000; 03-02 -10,000 + 304,000 -> 854,000;
    // 03-28 count: 787,000 -> 784,500; 04-05 count: 604,500 -> 606,000
    const d = byLabel(rows);
    expect(d['2025-03-01']).toMatchObject({ openingCents: 0, inCents: 1000000, outCents: 440000, closingCents: 560000 });
    expect(d['2025-03-02']).toMatchObject({ openingCents: 560000, inCents: 304000, outCents: 10000, closingCents: 854000 });
    expect(d['2025-03-28']).toMatchObject({ openingCents: 787000, inCents: 0, outCents: 2500, closingCents: 784500 });
    expect(d['2025-04-05']).toMatchObject({ openingCents: 604500, inCents: 1500, outCents: 0, closingCents: 606000 });
  });

  /**
   * Telecom working: March "in" = opening 500,000 + reloads 5,000,000+123,456+100,000 + voided reload 77,777 + card sales 30,000 + voided card sale 6,000 + EZCash
   *  250,000+123,457 + voided EZCash 99,999 + transfers in 50,000 + voided transfer reversal 7,777 + count over 800 = 6,369,266;
   *  "out" = card purchase 100,000 + reversals 77,777+6,000+99,999 + card refund 12,000 + top-ups 200,000+150,000 + internet 30,000 + voided transfer 7,777 = 683,553;
   *  closing 5,685,713.  April: in 100,000, out 7,000 + 300 = 7,300 -> 5,778,413.
   */
  it('Telecom: opening / in / out / closing per month and the voided records visible as opposite rows', async () => {
    const r = await rep(s, 'cashbook/telecom', q('2025-03-01', '2025-04-30', 'month'));
    const [mar, apr] = r.body.rows;
    expect([mar.openingCents, mar.inCents, mar.outCents, mar.closingCents]).toEqual([0, 6369266, 683553, 5685713]);
    expect([apr.openingCents, apr.inCents, apr.outCents, apr.closingCents]).toEqual([5685713, 100000, 7300, 5778413]);
    expect(r.body.ledgerBalanceAsOfToCents).toBe(5778413);
    const t = Object.fromEntries(mar.byType.map((x: any) => [x.type, x]));
    expect(t.reload_collection).toMatchObject({ inCents: 5301233, outCents: 77777 }); // 5,000,000 + 123,456 + 100,000 + voided 77,777; the reversal 77,777 out
    expect(t.provider_topup).toMatchObject({ outCents: 200000 });
    expect(t.wallet_topup).toMatchObject({ outCents: 150000 });
    expect(t.ezcash_collection).toMatchObject({ inCents: 473456, outCents: 99999 }); // 250,000 + 123,457 + 99,999 voided
    expect(t.card_sale).toMatchObject({ inCents: 36000, outCents: 6000 });
    expect(t.card_refund).toMatchObject({ outCents: 12000 });
  });

  /**
   * Ice Cream working: "in" March = opening 500,000 + daily cash entries 100,000+80,000+50,000 (voided day) +60,000+90,000 + transfer in 10,000 + capital 40,000 = 930,000;
   *  "out" = materials 100,000 + bills 30,000+50,000 + other costs 2,000+1,000 + count short 500 + drawing 20,000 + transfer out 30,000 + the voided day's reversal 50,000 = 283,500;
   *  closing 646,500.  April: in 20,000, out 80,000 -> 586,500.
   * Funds (fund ledger): March closings Cost 630,000, Electricity -33,000, Profit 49,500; April 637,000 / -111,000 / 60,500.
   *  Internal moves (no cash): Cost -5,000 -10,000 = -15,000; Electricity +4,000 +10,000 = +14,000; Profit +5,000 -4,000 = +1,000 (March).
   */
  it('Ice Cream: book figures and the per-fund breakdown (fund closings add up to the book; internal moves net to zero)', async () => {
    const r = await rep(s, 'cashbook/icecream', q('2025-03-01', '2025-04-30', 'month'));
    const [mar, apr] = r.body.rows;
    expect([mar.openingCents, mar.inCents, mar.outCents, mar.closingCents]).toEqual([0, 930000, 283500, 646500]);
    expect([apr.openingCents, apr.inCents, apr.outCents, apr.closingCents]).toEqual([646500, 20000, 80000, 586500]);
    expect(mar.funds.cost.closingCents).toBe(630000);
    expect(mar.funds.electricity.closingCents).toBe(-33000);
    expect(mar.funds.profit.closingCents).toBe(49500);
    expect(mar.funds.cost.movesNetCents).toBe(-15000);
    expect(mar.funds.electricity.movesNetCents).toBe(14000);
    expect(mar.funds.profit.movesNetCents).toBe(1000);
    expect([apr.funds.cost.closingCents, apr.funds.electricity.closingCents, apr.funds.profit.closingCents]).toEqual([637000, -111000, 60500]);
    for (const row of r.body.rows) {
      const f = row.funds;
      expect(f.cost.closingCents + f.electricity.closingCents + f.profit.closingCents).toBe(row.closingCents); // sum of funds = book
      expect(f.cost.openingCents + f.electricity.openingCents + f.profit.openingCents).toBe(row.openingCents);
      expect(f.cost.inCents + f.electricity.inCents + f.profit.inCents).toBe(row.inCents); // fund in/out are the real cash movements
      expect(f.cost.outCents + f.electricity.outCents + f.profit.outCents).toBe(row.outCents);
      expect(f.cost.movesNetCents + f.electricity.movesNetCents + f.profit.movesNetCents).toBe(0);
    }
    expect(r.body.fundTable.rows).toHaveLength(2);
    expect(r.body.warnings.map((w: any) => w.code)).toContain('NEGATIVE_FUND_BALANCE'); // Electricity -111,000 at the end date (10.2: a warning only)
    expect(r.body.ledgerBalanceAsOfToCents).toBe(586500);
  });

  it('the cash book report agrees with the existing GET /cashbooks/:book totals for the same range', async () => {
    for (const book of ['shop', 'telecom', 'icecream'] as const) {
      const rpt = (await rep(s, `cashbook/${book}`, q('2025-03-01', '2025-04-30', 'month'))).body.totals;
      const led = (await get(s.app, `/cashbooks/${book}?from=2025-03-01&to=2025-04-30&limit=1`)).body;
      expect([rpt.openingCents, rpt.inCents, rpt.outCents, rpt.closingCents]).toEqual([led.openingCents, led.inCents, led.outCents, led.closingCents]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------------------------------------------

describe('GET /reports/transfers', () => {
  it('lists posted transfers with totals by direction; the voided transfer is absent', async () => {
    const r = await rep(s, 'transfers', q('2025-03-01', '2025-04-30', 'month'));
    expect(r.status).toBe(200);
    expect(r.body.items.map((t: any) => [t.businessDate, t.fromBook, t.toBook, t.amountCents, t.fromFund, t.toFund])).toEqual([
      ['2025-03-12', 'shop', 'telecom', 50000, null, null],
      ['2025-03-18', 'icecream', 'shop', 30000, 'profit', null],
      ['2025-03-19', 'shop', 'icecream', 10000, null, 'cost'],
    ]);
    const mar = r.body.rows[0];
    expect(mar.count).toBe(3); expect(mar.totalCents).toBe(90000);
    expect(mar.byDirection['shop>telecom']).toEqual({ count: 1, amountCents: 50000 });
    expect(mar.byDirection['icecream>shop']).toEqual({ count: 1, amountCents: 30000 });
    expect(mar.byDirection['shop>icecream']).toEqual({ count: 1, amountCents: 10000 });
    expect(mar.byDirection['telecom>shop']).toEqual({ count: 0, amountCents: 0 }); // the voided 7,777 transfer
    expect(mar.byBook.shop).toEqual({ outCents: 60000, inCents: 30000, netCents: -30000 });
    expect(mar.byBook.telecom).toEqual({ outCents: 0, inCents: 50000, netCents: 50000 });
    expect(mar.byBook.icecream).toEqual({ outCents: 30000, inCents: 10000, netCents: -20000 });
    expect(r.body.rows[1].count).toBe(0);
    expect(r.body.totals.totalCents).toBe(90000);
    expect(r.body.table.totals).toMatchObject({ count: 3, total: 90000 });
    // additivity by day
    const d = await rep(s, 'transfers', q('2025-03-01', '2025-04-30', 'day'));
    expect(d.body.rows.reduce((a: number, x: any) => a + x.totalCents, 0)).toBe(90000);
    expect(byLabel(d.body.rows)['2025-03-18'].totalCents).toBe(30000);
    // net effect of transfers across the three books is zero
    expect(mar.byBook.shop.netCents + mar.byBook.telecom.netCents + mar.byBook.icecream.netCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ice Cream funds report
// ---------------------------------------------------------------------------------------------------------------------------------

describe('GET /reports/icecream-funds', () => {
  /** Hand calculation, March: see the cash-book working above for the closings; components per fund:
   *  Cost: allocations 60,000+50,000+36,000+50,000 = 196,000 (the voided day's +30,000 and -30,000 net to 0); opening balance 500,000; capital 40,000;
   *        transfer in 10,000; moves out 5,000+10,000 = 15,000; payments 100,000 (materials) + 1,000 (other cost from Cost) = 101,000 -> closing 630,000.
   *  Electricity: allocations 10,000+8,000+6,000+9,000 = 33,000; moves in 4,000 (re-allocation) + 10,000 (re-label) = 14,000; payments 30,000+50,000 = 80,000 -> -33,000.
   *  Profit: allocations 30,000+22,000+18,000+31,000 = 101,000; moves in 5,000 (cash-only: eligible 0) ; moves out 4,000; payments 2,000 (cups); drawings 20,000;
   *        transfers out 30,000; over/short -500 -> 101,000+5,000-4,000-2,000-20,000-30,000-500 = 49,500.
   *  April: Cost +10,000 allocation, -3,000 move -> 637,000; Electricity +2,000 allocation, -80,000 bill -> -111,000; Profit +8,000 + 3,000 (cash-only) -> 60,500.
   */
  it('per fund per month: every component, closings add up to the Ice Cream cash book', async () => {
    const r = await rep(s, 'icecream-funds', q('2025-03-01', '2025-04-30', 'month'));
    expect(r.status).toBe(200);
    const stm = (o: Record<string, any>) => ({
      openingCents: o.openingCents ?? 0, allocationsCents: o.allocationsCents ?? 0, openingBalanceCents: o.openingBalanceCents ?? 0, capitalCents: o.capitalCents ?? 0,
      transfersInCents: o.transfersInCents ?? 0, movesIn: { totalCents: o.movesIn?.[0] ?? 0, profitEligibleCents: o.movesIn?.[1] ?? 0, cashOnlyCents: o.movesIn?.[2] ?? 0 },
      movesOutCents: o.movesOutCents ?? 0, paymentsCents: o.paymentsCents ?? 0, drawingsCents: o.drawingsCents ?? 0, transfersOutCents: o.transfersOutCents ?? 0,
      overShortCents: o.overShortCents ?? 0, closingCents: o.closingCents ?? 0,
    });
    const mar = r.body.rows[0];
    expect(mar.funds.cost).toEqual(stm({ allocationsCents: 196000, openingBalanceCents: 500000, capitalCents: 40000, transfersInCents: 10000, movesOutCents: 15000, paymentsCents: 101000, closingCents: 630000 }));
    expect(mar.funds.electricity).toEqual(stm({ allocationsCents: 33000, movesIn: [14000, 0, 0], paymentsCents: 80000, closingCents: -33000 }));
    expect(mar.funds.profit).toEqual(stm({ allocationsCents: 101000, movesIn: [5000, 0, 5000], movesOutCents: 4000, paymentsCents: 2000, drawingsCents: 20000, transfersOutCents: 30000, overShortCents: -500, closingCents: 49500 }));
    expect(mar.total.closingCents).toBe(646500);
    expect(mar.cashBookClosingCents).toBe(646500);
    expect(mar.reconciled).toBe(true);
    const apr = r.body.rows[1];
    expect(apr.funds.cost).toEqual(stm({ openingCents: 630000, allocationsCents: 10000, movesOutCents: 3000, closingCents: 637000 }));
    expect(apr.funds.electricity).toEqual(stm({ openingCents: -33000, allocationsCents: 2000, paymentsCents: 80000, closingCents: -111000 }));
    expect(apr.funds.profit).toEqual(stm({ openingCents: 49500, allocationsCents: 8000, movesIn: [3000, 0, 3000], closingCents: 60500 }));
    expect(apr.total.closingCents).toBe(586500);
    expect(apr.reconciled).toBe(true);
    // recognized profit and excess cost are a SEPARATE block, equal to the Ice Cream P&L rows
    expect(mar.profit.recognizedProfitCents).toBe(94500);
    expect(apr.profit).toEqual(expect.objectContaining({ recognizedProfitCents: 8000, excessCostNotChargedCents: 16000, profitAfterExcessCostCents: -8000 }));
    expect(apr.profit.balancesAsOfPeriodEnd.outstandingExcessCostCents).toBe(16000);
    expect(r.body.warnings[0]).toMatchObject({ code: 'EXCESS_COST_OUTSTANDING', outstandingExcessCostCents: 16000 });
    // the totals row spans the range
    expect(r.body.totals.funds.cost.openingCents).toBe(0);
    expect(r.body.totals.funds.cost.closingCents).toBe(637000);
    expect(r.body.totals.profit.recognizedProfitCents).toBe(102500);
  });

  it('agrees with GET /icecream/funds: fund balances and recognized profit as of the end of each month', async () => {
    const r = await rep(s, 'icecream-funds', q('2025-03-01', '2025-04-30', 'month'));
    for (const [i, asOf] of ['2025-03-31', '2025-04-30'].entries()) {
      const f = (await get(s.app, `/icecream/funds?asOf=${asOf}`)).body;
      const row = r.body.rows[i];
      expect(row.funds.cost.closingCents).toBe(f.funds.cost.balanceCents);
      expect(row.funds.electricity.closingCents).toBe(f.funds.electricity.balanceCents);
      expect(row.funds.profit.closingCents).toBe(f.funds.profit.balanceCents);
      expect(row.total.closingCents).toBe(f.totalCents);
      expect(row.cashBookClosingCents).toBe(f.cashBookBalanceCents);
      expect(row.profit.balancesAsOfPeriodEnd.outstandingExcessCostCents).toBe(f.outstandingExcessCostCents);
      expect(row.profit.balancesAsOfPeriodEnd.unspentCents).toBe(f.unspentAllocationCents);
    }
    // recognized profit to date (March + April) and the period flows from the first day agree with the Funds summary
    const f = (await get(s.app, '/icecream/funds?asOf=2025-04-30&from=2025-03-01')).body;
    expect(f.recognizedProfitToDateCents).toBe(r.body.totals.profit.recognizedProfitCents);
    expect(f.period.recognizedProfitCents).toBe(102500);
    expect(f.period.excessCostNotChargedCents).toBe(r.body.totals.profit.excessCostNotChargedCents);
    expect(f.period.profitAfterExcessCostCents).toBe(r.body.totals.profit.profitAfterExcessCostCents);
    // the two measures stay apart: profit fund balance (60,500) is not recognized profit (102,500)
    expect(r.body.totals.funds.profit.closingCents).toBe(60500);
    expect(r.body.totals.profit.recognizedProfitCents).toBe(102500);
  });

  it('by day: closings carry forward and every day reconciles with the cash book', async () => {
    const r = await rep(s, 'icecream-funds', q('2025-03-01', '2025-04-30', 'day'));
    for (let i = 1; i < r.body.rows.length; i++) {
      for (const f of ['cost', 'electricity', 'profit']) expect(r.body.rows[i].funds[f].openingCents).toBe(r.body.rows[i - 1].funds[f].closingCents);
    }
    for (const row of r.body.rows) expect(row.reconciled, row.period.label).toBe(true);
    expect(r.body.rows.reduce((a: number, x: any) => a + x.profit.recognizedProfitCents, 0)).toBe(102500);
    expect(r.body.table.rows).toHaveLength(61 * 4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Voids change nothing; returns affect the return's period
// ---------------------------------------------------------------------------------------------------------------------------------

describe('voided records change nothing compared with never recorded', () => {
  it('every P&L, the transfers report, the funds report (net) and the cash book balances are identical in a world without the voided records', async () => {
    const range = q('2025-03-01', '2025-04-30', 'day');
    for (const path of ['pnl/shop', 'pnl/telecom', 'pnl/icecream', 'pnl/combined']) {
      const a = (await rep(s, path, range)).body;
      const b = (await rep(sNoVoids, path, range)).body;
      expect(a.rows, path).toEqual(b.rows);
      expect(a.totals, path).toEqual(b.totals);
      expect(a.table, path).toEqual(b.table);
    }
    expect((await rep(s, 'transfers', range)).body.items.map((t: any) => [t.businessDate, t.amountCents]))
      .toEqual((await rep(sNoVoids, 'transfers', range)).body.items.map((t: any) => [t.businessDate, t.amountCents]));
    const fa = (await rep(s, 'icecream-funds', range)).body;
    const fb = (await rep(sNoVoids, 'icecream-funds', range)).body;
    expect(fa.rows, 'funds').toEqual(fb.rows);
    for (const book of ['shop', 'telecom', 'icecream']) {
      const a = (await rep(s, `cashbook/${book}`, q('2025-03-01', '2025-04-30', 'month'))).body;
      const b = (await rep(sNoVoids, `cashbook/${book}`, q('2025-03-01', '2025-04-30', 'month'))).body;
      // closing balances equal (the voided records only add opposite pairs of rows to in and out)
      expect(a.rows.map((x: any) => x.closingCents)).toEqual(b.rows.map((x: any) => x.closingCents));
      expect(a.rows.map((x: any) => x.inCents - x.outCents)).toEqual(b.rows.map((x: any) => x.inCents - x.outCents));
    }
  });
});

describe('a return affects the period of the return date, not the sale date', () => {
  it('the March sale S1 is fully counted in March; its 3-unit return of 04-02 reduces April only', async () => {
    const mar = (await rep(s, 'pnl/shop', q('2025-03-02', '2025-03-04', 'day'))).body.rows;
    expect(mar[0].goods.salesCents).toBe(304000); // S1 + S2 on their sale date, nothing netted yet
    const apr = (await rep(s, 'pnl/shop', q('2025-04-01', '2025-04-30', 'month'))).body.rows[0];
    expect(apr.goods.salesCents).toBe(0);
    expect(apr.goods.returnsCents).toBe(150000);
    expect(apr.goods.revenueCents).toBe(-150000);
    // the whole range gives the same answer whichever way it is sliced
    const all = (await rep(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'month'))).body.totals;
    expect(all.goods.revenueCents).toBe(342000 - 150000);
  });
});
