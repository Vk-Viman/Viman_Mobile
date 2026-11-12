// Phase 11 (agent B) - stock reports: inventory valuation, stock movements, stock losses, low stock, product profitability.
// Every figure is hand-calculated from the shared scenario in helpers/phase11ops.ts (see its header for the posting order);
// the working is written next to each assertion. No expectation is derived from report code.
// Protects: BUSINESS_RULES 3 (SUM(movements) = cache; weighted average), 4 (returns hit the return's period, C5), 11 (stock adjustments),
// C13 (extra cost), R1 (voided records change nothing), R7 (reports follow the business date), R4 (purchase return capped at the pool).
//
// Scenario state after everything (hand-calculated, cents):
//   P1 Cable      qty 11, value 12,222   (see the chain below)
//   P2 Pen        qty 60, value 3,000    (100 for 5,000; sold 40 for 2,000)
//   P3 Dialog     qty 28, value 2,520    (50 for 4,500; sold 20 for 1,800; lost 2 for 180)
//   P6 Above-min  qty  6, value   600
// P1 chain: +10/10,000 (D10) +10/12,000 (D9) -2/2,000 purchase return (D8) = 18/20,000;
//   S1 sells 6: 20,000 x 6/18 = 6,666.67 -> 6,667 -> 12/13,333; cart sells 2: 13,333 x 2/12 = 2,222.17 -> 2,222 -> 10/11,111;
//   R1 restocks 2 at 6,667 x 2/6 = 2,222.33 -> 2,222 -> 12/13,333; R2 damaged: no stock movement;
//   L1 lost 1: 13,333/12 = 1,111.08 -> 1,111 -> 11/12,222; G1 personal use 1: 12,222/11 = 1,111.09 -> 1,111 -> 10/11,111;
//   T1 gain 2: 11,111 x 2/10 = 2,222.2 -> 2,222 -> 12/13,333; T2 loss 1: 13,333/12 = 1,111.08 -> 1,111 -> 11/12,222.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { num } from './helpers/phase4.ts';
import { D, buildScenario, rep, repXlsx } from './helpers/phase11ops.ts';
import type { Scenario } from './helpers/phase11ops.ts';

const env = new TestEnv();
let sc: Scenario;
let s: ApiBase;
beforeAll(async () => { sc = await buildScenario(env); s = sc.s; }, 120000);
afterAll(async () => { await env.cleanup(); });

const byName = (rows: any[], name: string) => rows.find((r) => r.name === name);

describe('GET /reports/inventory/valuation', () => {
  // Today: P1 11/12,222 + P2 60/3,000 + P3 28/2,520 + P6 6/600 = qty 105, value 18,342.
  // Books: shop = P1+P2+P6 = qty 77, value 15,822; telecom = P3 = qty 28, value 2,520. Average cost = value / qty rounded:
  //   P1 12,222/11 = 1,111.09 -> 1,111; P2 3,000/60 = 50; P3 2,520/28 = 90; P6 600/6 = 100.
  it('today: per product, per book and per category; total = Sigma stock cache = Sigma movements', async () => {
    const r = await rep(s, '/reports/inventory/valuation');
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.rows.map((x: any) => [x.qty, x.valueCents])).toEqual([[6, 600], [11, 12222], [60, 3000], [28, 2520]]);
    // order is book, category, name: shop (Electronics) products by name, then telecom
    expect(b.rows.map((x: any) => x.name)).toEqual(['Above minimum', 'Cable', 'Pen', 'Dialog card']);
    expect(b.rows.map((x: any) => x.avgUnitCostCents)).toEqual([100, 1111, 50, 90]);
    expect(b.totals).toEqual({ qty: 105, valueCents: 18342, products: 4 });
    expect(b.byBook).toEqual([{ book: 'shop', qty: 77, valueCents: 15822, products: 3 }, { book: 'telecom', qty: 28, valueCents: 2520, products: 1 }]);
    expect(b.byCategory.map((c: any) => [c.categoryName, c.qty, c.valueCents, c.products])).toEqual([['Electronics', 77, 15822, 3], ['Scratch Cards', 28, 2520, 1]]);
    // the three-way reconciliation, computed independently from the database
    const cache = num(s, 'SELECT COALESCE(SUM(qty_on_hand),0) FROM products');
    const cacheV = num(s, 'SELECT COALESCE(SUM(stock_value_cents),0) FROM products');
    const mvQ = num(s, 'SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements');
    const mvV = num(s, 'SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements');
    expect([cache, cacheV, mvQ, mvV]).toEqual([105, 18342, 105, 18342]);
    expect(b.reconciliation).toEqual({ asOfIsLive: true, cacheQty: 105, cacheValueCents: 18342, matchesCache: true });
    expect(b.warnings).toEqual([]);
    expect(b.table.totals.value).toBe(18342);
  });

  // As of a past date = sum of movements dated on or before it, even though later activity has happened (working in the file header):
  //  D10: P1 10/10,000.                                   total 10 / 10,000
  //  D9 : P1 20/22,000 + P2 100/5,000 + P3 50/4,500 + P6 6/600           = 176 / 32,100
  //  D8 : P1 18/20,000 (return 2 for 2,000); P2 100/5,000 (PU5 +10/3,000 and its void -10/-3,000 both dated D8 net 0) = 174 / 30,100
  //  D7 : P1 12/13,333                                                    = 168 / 23,433
  //  D6 : P1 10/11,111, P2 60/3,000, P3 30/2,700, P6 6/600                = 106 / 17,411
  //  D5 : P1 12/13,333 (R1 restock), P2 60/3,000 (S5 sale and its void net 0) = 108 / 19,633
  //  D4 : same as D5 (the damaged return writes no stock movement)        = 108 / 19,633
  //  D3 : P1 11/12,222, P3 28/2,520 (L3 and its void net 0)               = 105 / 18,342
  //  D2 : P1 10/11,111 (personal use)                                     = 104 / 17,231
  //  D1 : P1 11/12,222 (T1 +2/2,222, T2 -1/1,111)                         = 105 / 18,342
  it.each([
    [10, 10, 10000], [9, 176, 32100], [8, 174, 30100], [7, 168, 23433], [6, 106, 17411], [5, 108, 19633],
    [4, 108, 19633], [3, 105, 18342], [2, 104, 17231], [1, 105, 18342],
  ])('as of %i days ago: quantity %i, value %i', async (n, qty, value) => {
    const r = await rep(s, '/reports/inventory/valuation', `?asOf=${D(n)}`);
    expect(r.body.totals.qty).toBe(qty);
    expect(r.body.totals.valueCents).toBe(value);
    expect(r.body.reconciliation.asOfIsLive).toBe(false);
    expect(r.body.reconciliation.matchesCache).toBeNull();
    // additivity: product rows sum to the totals, books sum to the totals
    expect(r.body.rows.reduce((a: number, x: any) => a + x.valueCents, 0)).toBe(value);
    expect(r.body.byBook.reduce((a: number, x: any) => a + x.valueCents, 0)).toBe(value);
  });

  it('a future date shows today\'s figures (never rejected, R-FD is for writes)', async () => {
    const r = await rep(s, '/reports/inventory/valuation', '?asOf=2099-01-01');
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ qty: 105, valueCents: 18342, products: 4 });
    expect(r.body.reconciliation.matchesCache).toBe(true);
  });

  it('filters: book, category, includeZero, includeInactive', async () => {
    expect((await rep(s, '/reports/inventory/valuation', '?book=telecom')).body.totals).toEqual({ qty: 28, valueCents: 2520, products: 1 });
    const all = await rep(s, '/reports/inventory/valuation', '?includeZero=true');
    // P4 and the inactive P5 hold nothing: 6 stock products now
    expect(all.body.rows.length).toBe(6);
    expect((await rep(s, '/reports/inventory/valuation', '?includeZero=true&includeInactive=false')).body.rows.length).toBe(5);
    const cat = (await rep(s, '/reports/inventory/valuation')).body.byCategory.find((c: any) => c.categoryName === 'Scratch Cards').categoryId;
    expect((await rep(s, '/reports/inventory/valuation', `?categoryId=${cat}`)).body.totals.valueCents).toBe(2520);
  });

  it('a backdated sale makes an earlier date negative: the report keeps the true sums and warns', async () => {
    const env2 = new TestEnv();
    try {
      const b = await apiBase(await env2.build());
      const p = await mkProduct(b, { minPriceCents: 0 });
      await buy(b, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 1000 }]);          // today: 10 units for 1,000
      await sellOk(b, [cl(p.id, 4, 500)], { businessDate: D(5) });                                  // sold 4 dated 5 days ago: cost 1,000 x 4/10 = 400
      // as of 3 days ago only the sale (-4 / -400) is dated; the purchase is dated today
      const r = await rep(b, '/reports/inventory/valuation', `?asOf=${D(3)}&includeZero=true`);
      expect(r.body.totals).toEqual({ qty: -4, valueCents: -400, products: 1 });
      expect(r.body.warnings.map((w: any) => w.code)).toEqual(['NEGATIVE_STOCK_AS_OF']);
      const now = await rep(b, '/reports/inventory/valuation');
      expect(now.body.totals).toEqual({ qty: 6, valueCents: 600, products: 1 });
      expect(now.body.warnings).toEqual([]);
    } finally { await env2.cleanup(); }
  });

  it('xlsx download works', async () => {
    const x = await repXlsx(s, '/reports/inventory/valuation', `?asOf=${D(5)}`);
    expect(x.status).toBe(200);
    expect(x.isZip).toBe(true);
    expect(x.type).toContain('spreadsheetml');
    expect(x.disposition).toContain('inventory-valuation');
  });
});

describe('GET /reports/stock-movements', () => {
  // Counts by type over the whole window (working in helpers/phase11ops.ts):
  //  purchase 6 rows qty +186 value +35,100 | purchase_return 1 (-2/-2,000) | purchase_void 1 (-10/-3,000)
  //  sale 6 rows (S1 -6/-6,667; cart -2/-2,222, -40/-2,000, -20/-1,800; S5 -10/-500 and its reversal +10/+500) = -68/-12,689
  //  sale_return 1 (+2/+2,222) | loss 4 rows (-1/-1,111 P1, -2/-180 P3, L3 -3/-150 and reversal +3/+150) = -3/-1,291
  //  personal_use 1 (-1/-1,111) | stocktake_gain 1 (+2/+2,222) | stocktake_loss 3 (-1/-1,111, T3 -1/-50 and reversal +1/+50) = -1/-1,111
  //  total 24 rows, qty 105, value 18,342 (= valuation).
  it('whole ledger: totals by type add up to the valuation', async () => {
    const r = await rep(s, '/reports/stock-movements', `?from=${D(10)}&to=${D(0)}&limit=200`);
    expect(r.body.total).toBe(24);
    expect(r.body.totals).toEqual({ count: 24, qtyDelta: 105, valueDeltaCents: 18342 });
    const t = Object.fromEntries(r.body.byType.map((x: any) => [x.type, [x.count, x.qtyDelta, x.valueDeltaCents]]));
    expect(t).toEqual({
      purchase: [6, 186, 35100], purchase_return: [1, -2, -2000], purchase_void: [1, -10, -3000], sale: [6, -68, -12689], sale_return: [1, 2, 2222],
      loss: [4, -3, -1291], personal_use: [1, -1, -1111], stocktake_gain: [1, 2, 2222], stocktake_loss: [3, -1, -1111],
    });
    expect(r.body.rows.length).toBe(24);
    expect(r.body.table.totals.qty).toBe(105);
  });

  it('filters: type, book, product, dates', async () => {
    const loss = await rep(s, '/reports/stock-movements', `?type=loss&from=${D(3)}&to=${D(3)}`);
    expect(loss.body.totals).toEqual({ count: 4, qtyDelta: -3, valueDeltaCents: -1291 });
    const tel = await rep(s, '/reports/stock-movements', '?book=telecom');
    // P3: +50/4,500, sale -20/-1,800, expired loss -2/-180 = 28 / 2,520
    expect(tel.body.totals).toEqual({ count: 3, qtyDelta: 28, valueDeltaCents: 2520 });
    const p6 = await rep(s, '/reports/stock-movements', `?productId=${sc.p6}`);
    expect(p6.body.totals).toEqual({ count: 1, qtyDelta: 6, valueDeltaCents: 600 });
    const day = await rep(s, '/reports/stock-movements', `?from=${D(1)}&to=${D(1)}`);
    expect(day.body.totals).toEqual({ count: 2, qtyDelta: 1, valueDeltaCents: 1111 });   // T1 +2/+2,222 and T2 -1/-1,111
    expect(day.body.rows[0].type).toBe('stocktake_loss');                                // newest posting first within the day
    expect((await rep(s, '/reports/stock-movements', `?from=${D(0)}&to=${D(0)}`)).body.total).toBe(0);
  });

  it('paging: pages of 10 cover all 24 rows exactly once, newest business date first', async () => {
    const ids: number[] = [];
    let last = '9999-99-99';
    for (const off of [0, 10, 20]) {
      const r = await rep(s, '/reports/stock-movements', `?limit=10&offset=${off}`);
      expect(r.body.total).toBe(24);
      for (const row of r.body.rows) { ids.push(row.id); expect(row.businessDate <= last).toBe(true); last = row.businessDate; }
    }
    expect(ids.length).toBe(24);
    expect(new Set(ids).size).toBe(24);
  });

  it('a voided sale nets to zero in the ledger (reversal rows are listed)', async () => {
    // S5: sale -10/-500 then its reversal +10/+500, both dated D5 -> product Pen, type sale, qty 0 value 0 together
    const r = await rep(s, '/reports/stock-movements', `?from=${D(5)}&to=${D(5)}&type=sale`);
    expect(r.body.totals).toEqual({ count: 2, qtyDelta: 0, valueDeltaCents: 0 });
  });

  it('xlsx works', async () => { expect((await repXlsx(s, '/reports/stock-movements', `?from=${D(10)}&to=${D(0)}`)).isZip).toBe(true); });
});

describe('GET /reports/stock-losses', () => {
  // Posted losses: L1 D3 P1 lost 1,111 | damaged return D4 P1 damaged 1,111 (source damaged_return, no movement) | L2 D3 P3 expired 180.
  // The voided L3 (150) is not counted. Per day: D4 = 1 loss, 1 unit, 1,111 | D3 = 2 losses, 3 units (1 + 2), 1,291. Total 3 losses, 4 units, 2,402.
  // Memo (section 11): stocktake T1 gain 2,222 and T2 loss 1,111 on D1; T3 loss/void on D2 nets to 0.
  //   net adjustments: D4 1,111; D3 1,291; D1 = 0 losses + 1,111 stocktake loss - 2,222 gain = -1,111; total 1,111 + 1,291 - 1,111 = 1,291.
  it('by period, reason, book and product; voided loss and damaged return counted once', async () => {
    const r = await rep(s, '/reports/stock-losses', `?from=${D(10)}&to=${D(0)}&granularity=day`);
    expect(r.status).toBe(200);
    const row = (n: number) => r.body.rows.find((x: any) => x.period.label === D(n));
    expect([row(4).lossCount, row(4).qty, row(4).costCents, row(4).damagedCents, row(4).fromReturnsCents]).toEqual([1, 1, 1111, 1111, 1111]);
    expect([row(3).lossCount, row(3).qty, row(3).costCents, row(3).lostCents, row(3).expiredCents]).toEqual([2, 3, 1291, 1111, 180]);
    expect(r.body.totals).toMatchObject({ lossCount: 3, qty: 4, costCents: 2402, damagedCents: 1111, lostCents: 1111, expiredCents: 180, otherCents: 0, fromReturnsCents: 1111 });
    expect([row(4).stockAdjustmentsNetCents, row(3).stockAdjustmentsNetCents, row(2).stockAdjustmentsNetCents, row(1).stockAdjustmentsNetCents]).toEqual([1111, 1291, 0, -1111]);
    expect(row(1)).toMatchObject({ stocktakeLossCents: 1111, stocktakeGainCents: 2222, sweepCents: 0 });
    expect(r.body.totals.stockAdjustmentsNetCents).toBe(1291);
    expect(r.body.byReason.map((x: any) => [x.reason, x.lossCount, x.costCents])).toEqual([['damaged', 1, 1111], ['lost', 1, 1111], ['expired', 1, 180]]);
    expect(r.body.byBook.map((x: any) => [x.book, x.lossCount, x.qty, x.costCents])).toEqual([['shop', 2, 2, 2222], ['telecom', 1, 2, 180]]);
    expect(r.body.byProduct.map((x: any) => [x.productName, x.lossCount, x.costCents])).toEqual([['Cable', 2, 2222], ['Dialog card', 1, 180]]);
    // additivity: days add up to the total, and months add up to the same total
    expect(r.body.rows.reduce((a: number, x: any) => a + x.costCents, 0)).toBe(2402);
    const m = await rep(s, '/reports/stock-losses', `?from=${D(10)}&to=${D(0)}&granularity=month`);
    expect(m.body.totals).toEqual(r.body.totals);
    expect(m.body.rows.reduce((a: number, x: any) => a + x.costCents, 0)).toBe(2402);
    // cross-check against the ledger: manual-loss cost = -(sum of `loss` movements) = 1,111 + 180 + (150 - 150)
    expect(-num(s, "SELECT SUM(value_delta_cents) FROM stock_movements WHERE type = 'loss'")).toBe(1291);
  });

  it('book filter and empty range', async () => {
    const t = await rep(s, '/reports/stock-losses', `?from=${D(10)}&to=${D(0)}&book=telecom`);
    expect(t.body.totals.costCents).toBe(180);
    const e = await rep(s, '/reports/stock-losses', `?from=${D(20)}&to=${D(15)}`);
    expect(e.status).toBe(200);
    expect(e.body.rows.length).toBe(6);
    expect(e.body.totals.costCents).toBe(0);
  });

  it('xlsx works', async () => { expect((await repXlsx(s, '/reports/stock-losses', `?from=${D(10)}&to=${D(0)}`)).isZip).toBe(true); });
});

describe('GET /reports/low-stock', () => {
  // reorder levels: P1 10 (qty 11: above), P2 60 (qty 60: EQUAL -> included), P3 5 (qty 28: above), P4 0 (no minimum: never listed),
  // P5 5 inactive qty 0 (excluded unless includeInactive), P6 5 (qty 6: above).
  // A product with qty exactly at its minimum IS low stock ("at or below"); a minimum of 0 means "not set".
  it('lists products at or below their minimum; boundary equal is included', async () => {
    const r = await rep(s, '/reports/low-stock');
    expect(r.body.rows.map((x: any) => [x.name, x.qtyOnHand, x.reorderLevel, x.shortfall])).toEqual([['Pen', 60, 60, 0]]);
    expect(r.body.totals).toEqual({ products: 1, outOfStock: 0, stockValueCents: 3000 });
    const inc = await rep(s, '/reports/low-stock', '?includeInactive=true');
    expect(inc.body.rows.map((x: any) => [x.name, x.qtyOnHand, x.shortfall, x.outOfStock])).toEqual([['Inactive item', 0, 5, true], ['Pen', 60, 0, false]]);
  });

  it('moves in and out of the list with stock (live)', async () => {
    const env2 = new TestEnv();
    try {
      const b = await apiBase(await env2.build());
      const p = await mkProduct(b, { minPriceCents: 0, reorderLevel: 5 });
      await buy(b, [{ productId: p.id, packs: 1, packSize: 6, lineTotalCents: 600 }]);
      expect((await rep(b, '/reports/low-stock')).body.rows.length).toBe(0);                // 6 > 5
      await sellOk(b, [cl(p.id, 1, 500)]);                                                   // 5 = minimum -> listed
      expect((await rep(b, '/reports/low-stock')).body.rows.map((x: any) => x.qtyOnHand)).toEqual([5]);
      await sellOk(b, [cl(p.id, 5, 500)]);                                                   // 0 -> out of stock, short by 5
      const r = await rep(b, '/reports/low-stock');
      expect(r.body.rows.map((x: any) => [x.qtyOnHand, x.shortfall, x.outOfStock])).toEqual([[0, 5, true]]);
      expect(r.body.totals.outOfStock).toBe(1);
    } finally { await env2.cleanup(); }
  });

  it('book filter and xlsx', async () => {
    expect((await rep(s, '/reports/low-stock', '?book=telecom')).body.rows).toEqual([]);
    expect((await repXlsx(s, '/reports/low-stock', '')).isZip).toBe(true);
  });
});

describe('GET /reports/product-profitability', () => {
  // Whole window. Working (cents), per product:
  //  P1 Cable: sold 6 (S1: revenue 12,000, automatic 6,667, extra 6 x 1,120 - 6,667 = 53) + 2 (cart: 4,000, 2,222, 0) = 8 units, revenue 16,000
  //    returns: R1 2 units: revenue 12,000 x 2/6 = 4,000, automatic 6,667 x 2/6 = 2,222.33 -> 2,222, extra 53 x 2/6 = 17.67 -> 18
  //             R2 1 unit (damaged): 2,000, 6,667/6 = 1,111.17 -> 1,111, 53/6 = 8.83 -> 9
  //    net units 8 - 3 = 5; revenue 16,000 - 6,000 = 10,000; automatic 6,667 + 2,222 - 2,222 - 1,111 = 5,556; extra 53 - 18 - 9 = 26;
  //    cost 5,582; gross profit 4,418; margin 4,418 / 10,000 = 4,418 bp
  //  P2 Pen: 40 sold in the cart, revenue 4,000, cost 2,000 (5,000 x 40/100), gross profit 2,000, margin 5,000 bp. (The voided S5 counts for nothing.)
  //  P3 Dialog card: 20 sold, revenue 2,000, cost 1,800, gross profit 200, margin 1,000 bp.
  //  Totals: revenue 16,000, cost 9,382, gross profit 6,618.
  it('after returns, with extra cost, voided sale excluded', async () => {
    const r = await rep(s, '/reports/product-profitability', `?from=${D(10)}&to=${D(0)}`);
    expect(r.status).toBe(200);
    const row = (name: string) => r.body.rows.find((x: any) => x.productName === name);
    expect(row('Cable')).toMatchObject({
      soldQty: 8, returnedQty: 3, netQty: 5, salesRevenueCents: 16000, returnsRevenueCents: 6000, revenueCents: 10000,
      costAutoCents: 5556, costExtraCents: 26, costCents: 5582, grossProfitCents: 4418, marginBp: 4418,
    });
    expect(row('Pen')).toMatchObject({ soldQty: 40, netQty: 40, revenueCents: 4000, costCents: 2000, costExtraCents: 0, grossProfitCents: 2000, marginBp: 5000 });
    expect(row('Dialog card')).toMatchObject({ soldQty: 20, revenueCents: 2000, costCents: 1800, grossProfitCents: 200, marginBp: 1000, book: 'telecom' });
    expect(r.body.rows.map((x: any) => x.productName)).toEqual(['Cable', 'Pen', 'Dialog card']);        // by gross profit
    expect(r.body.totals).toMatchObject({ revenueCents: 16000, costCents: 9382, costAutoCents: 9356, costExtraCents: 26, grossProfitCents: 6618, marginBp: 4136 });
    // margin: 6,618 x 10,000 / 16,000 = 4,136.25 -> 4,136
  });

  it('returns land in the return\'s period, not the sale\'s', async () => {
    // only S1's day: the returns (D5, D4) are outside, so Cable shows 6 units and no returns
    const sold = await rep(s, '/reports/product-profitability', `?from=${D(7)}&to=${D(7)}`);
    expect(sold.body.rows).toHaveLength(1);
    expect(sold.body.rows[0]).toMatchObject({ soldQty: 6, returnedQty: 0, revenueCents: 12000, costAutoCents: 6667, costExtraCents: 53, costCents: 6720, grossProfitCents: 5280 });
    // only the return days: R1 reverses 4,000 revenue / 2,222 + 18 cost, R2 reverses 2,000 / 1,111 + 9 -> revenue -6,000, cost -3,360, profit -2,640;
    // the margin is not shown (no positive revenue)
    const ret = await rep(s, '/reports/product-profitability', `?from=${D(5)}&to=${D(4)}`);
    expect(ret.body.rows).toHaveLength(1);
    expect(ret.body.rows[0]).toMatchObject({ soldQty: 0, returnedQty: 3, netQty: -3, revenueCents: -6000, costCents: -3360, grossProfitCents: -2640, marginBp: null });
  });

  it('book and category filters; empty and single-day ranges', async () => {
    const tel = await rep(s, '/reports/product-profitability', `?from=${D(10)}&to=${D(0)}&book=telecom`);
    expect(tel.body.rows.map((x: any) => x.productName)).toEqual(['Dialog card']);
    expect(tel.body.totals.grossProfitCents).toBe(200);
    const empty = await rep(s, '/reports/product-profitability', `?from=${D(0)}&to=${D(0)}`);
    expect(empty.body.rows).toEqual([]);
    expect(empty.body.totals).toMatchObject({ revenueCents: 0, costCents: 0, marginBp: null });
  });

  it('xlsx works', async () => { expect((await repXlsx(s, '/reports/product-profitability', `?from=${D(10)}&to=${D(0)}`)).isZip).toBe(true); });
});
