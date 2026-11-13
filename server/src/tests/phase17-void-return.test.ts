// PHASE 17 - voiding a sales return (BUSINESS_RULES section 4, rule R-VR; API_CONTRACTS "Approved-decisions contract", part B).
// API level (Fastify inject, real temp database). Every expected figure is worked out by hand in the comment above its test
// (cents; the working is independent arithmetic, never read from the code under test).
// Organised as: newest-first and exact remainders, multi-line returns, damaged returns, extra cost (C13), stock availability,
// stock value difference (gain) and the residual sweep, closed days, negative-cash warnings, atomic rollback, double void and
// concurrency, idempotency, validation and order of checks, HAS_RETURNS, audit, purchase flows untouched.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, get, post } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, lossVoid, mvsByRef, num, poolOf, reconOk, sql } from './helpers/phase4.ts';
import { closeOk, openNew, reopenNew } from './helpers/phase8.ts';
import { cashBal, cashOfRef, cl, clc, lossRows, returnNew, returnOk, rl, sellOk, voidSaleNew } from './helpers/phase5.ts';
import { segNetFromTables, shopIdentity, snapshotAll } from './helpers/phase14.ts';
import { fingerprint, returnedQtyMismatches, shopPnlTotals, voidReturnNew, voidReturnOk } from './helpers/phase17.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
type S = ApiBase;

/** A product (shop by default) holding exactly `units` units worth `totalCents`, bought on `date`. */
async function stockedOn(s: S, units: number, totalCents: number, date = '2025-04-01', mk = mkProduct): Promise<any> {
  const P = await mk(s, { sellPriceCents: 10000, minPriceCents: 0 });
  await buy(s, [{ productId: P.id, packs: 1, packSize: units, lineTotalCents: totalCents }], { businessDate: date });
  return P;
}
const pnlDay = async (s: S, from: string, to: string, seg: 'shop' | 'telecom' = 'shop') =>
  (await get(s.app, `/reports/pnl/${seg}?from=${from}&to=${to}&granularity=day`)).body;

// =============================================================================================
describe('newest first and exact remainders (R-VR 1, 7; C5)', () => {
  // Pool: 3 units worth 100 c. Sale of all 3 @ 100: revenue 300, cogs 100 (whole pool), pool 0 / 0.
  // R1 1 unit: revenue 100, cogs round(100x1/3) = 33.  R2 1 unit: 100 / 33.  R3 1 unit completes the line: 100 / 100-66 = 34.
  // After the 3 returns the pool is 3 / 100 (33+33+34).
  // Void order: R1 and R2 are refused while a newer posted return of the same line exists (the error names the NEWEST such return).
  //   void R3 -> removes 1 unit at min(34, 100) = 34: pool 2 / 66.  void R2 -> R2 is newest now: removes 33: 1 / 33.  void R1: 0 / 0.
  it('three partial returns: oldest-first void is refused naming the newer one (nothing written); newest-first works; counters step back', async () => {
    const s = await setup();
    const P = await stockedOn(s, 3, 100);
    const sale = (await sellOk(s, [cl(P.id, 3, 100)], { businessDate: '2025-04-02' })).sales[0];
    const item = sale.items[0];
    expect(item).toMatchObject({ revenueCents: 300, cogsCents: 100 });
    const r1 = (await returnOk(s, sale.id, [rl(item.id, 1, true)], { businessDate: '2025-04-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(item.id, 1, true)], { businessDate: '2025-04-04' })).item;
    const r3 = (await returnOk(s, sale.id, [rl(item.id, 1, true)], { businessDate: '2025-04-05' })).item;
    expect([r1, r2, r3].map((r) => [r.refundCents, r.cogsReversedCents])).toEqual([[100, 33], [100, 33], [100, 34]]);
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 100 });
    expect(num(s, 'SELECT returned_qty FROM sale_items WHERE id = ?', item.id)).toBe(3);

    const before = fingerprint(s.ctx);
    const a = await voidReturnNew(s, sale.id, r1.id);
    expect(a.status).toBe(409);
    expect(err(a)).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r3.id });
    expect(err(a).message).toContain(`#${r3.id}`);
    const b = await voidReturnNew(s, sale.id, r2.id);
    expect(err(b)).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r3.id });
    expect(fingerprint(s.ctx)).toBe(before);

    await voidReturnOk(s, sale.id, r3.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 2, value: 66 });
    expect(num(s, 'SELECT returned_qty FROM sale_items WHERE id = ?', item.id)).toBe(2);
    expect(err(await voidReturnNew(s, sale.id, r1.id))).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r2.id });
    await voidReturnOk(s, sale.id, r2.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 1, value: 33 });
    await voidReturnOk(s, sale.id, r1.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    expect(num(s, 'SELECT returned_qty FROM sale_items WHERE id = ?', item.id)).toBe(0);
    expect(returnedQtyMismatches(s.ctx)).toBe(0);
    // cash: +300 sale, -300 refunds, +300 reversals, purchase -100 -> 200
    expect(cashBal(s, 'shop')).toBe(200);
    // everything voided: the sale stands alone (revenue 300, cost 100, profit 200 = cash 200 + stock 0)
    expect((await shopPnlTotals(s, '2025-04-01', '2025-04-30')).netProfitCents).toBe(200);
    const id = await shopIdentity(s);
    expect(id).toEqual({ reportProfit: 200, ledgerProfit: 200 });
    // the line can be returned again correctly: all 3 units -> exact remainder = the whole line (300 / 100)
    const again = (await returnOk(s, sale.id, [rl(item.id, 3, true)], { businessDate: '2025-04-06' })).item;
    expect([again.refundCents, again.cogsReversedCents]).toEqual([300, 100]);
    await reconOk(s);
  });

  // Pool 3 / 100. Sale 3 @ 100 with entered cost 50 per unit: automatic 100, charged 150, extra 50. Revenue 300.
  // R1 2 units: revenue round(300x2/3)=200, cogs round(100x2/3)=67, extra round(50x2/3)=33.
  // R2 1 unit completes: 100 / 100-67=33 / 50-33=17.
  // Void R2, then return 1 unit again: the voided return no longer counts, so this return again completes the line (2 + 1 = 3 units) and
  // takes the exact remainder 100 / 33 / 17. After voiding R3 and R1 the sale stands in full: revenue 300, auto 100, extra 50.
  it('after a void the next return takes the exact remainder again (extra cost C13 included)', async () => {
    const s = await setup();
    const P = await stockedOn(s, 3, 100);
    const sale = (await sellOk(s, [clc(P.id, 3, 100, 50)], { businessDate: '2025-04-02' })).sales[0];
    const item = sale.items[0];
    expect(item).toMatchObject({ revenueCents: 300, cogsCents: 100, extraCostCents: 50 });
    const r1 = (await returnOk(s, sale.id, [rl(item.id, 2, true)], { businessDate: '2025-04-03' })).item;
    expect([r1.refundCents, r1.cogsReversedCents, r1.extraCostReversedCents]).toEqual([200, 67, 33]);
    const r2 = (await returnOk(s, sale.id, [rl(item.id, 1, true)], { businessDate: '2025-04-04' })).item;
    expect([r2.refundCents, r2.cogsReversedCents, r2.extraCostReversedCents]).toEqual([100, 33, 17]);
    // all returned: revenue 0, cost 0 (auto 0 + extra 0)
    let t = await shopPnlTotals(s, '2025-04-01', '2025-04-30');
    expect(t.goods).toMatchObject({ revenueCents: 0, costAutomaticCents: 0, costExtraCents: 0, grossProfitCents: 0 });
    await voidReturnOk(s, sale.id, r2.id);
    // R1 alone: revenue 300-200=100, auto 100-67=33, extra 50-33=17, profit 100-33-17 = 50
    t = await shopPnlTotals(s, '2025-04-01', '2025-04-30');
    expect(t.goods).toMatchObject({ revenueCents: 100, costAutomaticCents: 33, costExtraCents: 17, grossProfitCents: 50 });
    const r3 = (await returnOk(s, sale.id, [rl(item.id, 1, true)], { businessDate: '2025-04-05' })).item;
    expect([r3.refundCents, r3.cogsReversedCents, r3.extraCostReversedCents]).toEqual([100, 33, 17]);
    // void R3 and R1: the sale stands in full: 300 - (100 + 50) = 150
    await voidReturnOk(s, sale.id, r3.id);
    await voidReturnOk(s, sale.id, r1.id);
    t = await shopPnlTotals(s, '2025-04-01', '2025-04-30');
    expect(t.goods).toMatchObject({ revenueCents: 300, costAutomaticCents: 100, costExtraCents: 50, costOfSalesCents: 150, grossProfitCents: 150 });
    // stock: the extra cost never touched stock; pool back to 0 / 0
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    expect(returnedQtyMismatches(s.ctx)).toBe(0);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 150, ledgerProfit: 150 });
    await reconOk(s);
  });

  // A: 10 units / 10,000 (avg 1,000).  B: 6 units / 3,000 (avg 500).  Sale 04-02: A 4 @ 2,500 (rev 10,000, cogs 4,000), B 2 @ 900 (rev 1,800, cogs 1,000).
  // pools A 6 / 6,000, B 4 / 2,000.  R1 (04-03): A 2 + B 1: A rev 5,000 cogs 2,000, B rev 900 cogs 500 -> refund 5,900, pools A 8 / 8,000, B 5 / 2,500.
  // R2 (04-04): A 2 (completes A: rev 5,000, cogs 2,000) -> A 10 / 10,000.   R3 (04-05): B 1 (completes B: 900 / 500) -> B 6 / 3,000.
  // R1 shares line A with R2 and line B with R3; the NEWEST of them is R3.
  it('one return over two lines: blocked by the newest return on either line; voiding R3, R2, R1 in turn removes both lines in one void', async () => {
    const s = await setup();
    const A = await stockedOn(s, 10, 10000);
    const B = await stockedOn(s, 6, 3000);
    const sale = (await sellOk(s, [cl(A.id, 4, 2500), cl(B.id, 2, 900)], { businessDate: '2025-04-02' })).sales[0];
    const [ia, ib] = sale.items;
    const r1 = (await returnOk(s, sale.id, [rl(ia.id, 2, true), rl(ib.id, 1, true)], { businessDate: '2025-04-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(ia.id, 2, true)], { businessDate: '2025-04-04' })).item;
    const r3 = (await returnOk(s, sale.id, [rl(ib.id, 1, true)], { businessDate: '2025-04-05' })).item;
    expect(r1.refundCents).toBe(5900);
    expect([r2.refundCents, r2.cogsReversedCents, r3.refundCents, r3.cogsReversedCents]).toEqual([5000, 2000, 900, 500]);
    expect(poolOf(s, A.id)).toEqual({ qty: 10, value: 10000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 6, value: 3000 });

    expect(err(await voidReturnNew(s, sale.id, r1.id))).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r3.id });
    await voidReturnOk(s, sale.id, r3.id);                                   // B 5 / 2,500
    expect(poolOf(s, B.id)).toEqual({ qty: 5, value: 2500 });
    expect(err(await voidReturnNew(s, sale.id, r1.id))).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r2.id });
    await voidReturnOk(s, sale.id, r2.id);                                   // A 8 / 8,000
    expect(poolOf(s, A.id)).toEqual({ qty: 8, value: 8000 });
    const v = await voidReturnOk(s, sale.id, r1.id);                         // A 6 / 6,000, B 4 / 2,000
    expect(poolOf(s, A.id)).toEqual({ qty: 6, value: 6000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 4, value: 2000 });
    expect(v.sale.items.map((i: any) => i.returnedQty)).toEqual([0, 0]);
    // R1's void wrote one reversal movement per resalable line (two products) and one cash reversal of 5,900
    expect(mvsByRef(s, 'sales_returns', r1.id).map((m) => [m.productId, m.qty, m.value])).toEqual([[A.id, 2, 2000], [B.id, 1, 500], [A.id, -2, -2000], [B.id, -1, -500]]);
    expect(cashOfRef(s, 'sales_returns', r1.id).map((c) => c.amount_cents)).toEqual([-5900, 5900]);
    // cash: -10,000 - 3,000 + 11,800 = -1,200; every refund was paid back
    expect(cashBal(s, 'shop')).toBe(-1200);
    expect(returnedQtyMismatches(s.ctx)).toBe(0);
    expect((await shopIdentity(s)).reportProfit).toBe(11800 - 5000);       // revenue 11,800 - cost 5,000 = 6,800
    expect(await shopIdentity(s)).toEqual({ reportProfit: 6800, ledgerProfit: 6800 });
    await reconOk(s);
  });

  // Two returns on DIFFERENT lines do not block each other: R1 = line A only, R2 = line B only (newer). R1 may be voided first.
  it('returns of different lines can be voided in any order', async () => {
    const s = await setup();
    const A = await stockedOn(s, 10, 10000);
    const B = await stockedOn(s, 6, 3000);
    const sale = (await sellOk(s, [cl(A.id, 4, 2500), cl(B.id, 2, 900)], { businessDate: '2025-04-02' })).sales[0];
    const r1 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(sale.items[1].id, 1, true)], { businessDate: '2025-04-03' })).item;
    expect((await voidReturnNew(s, sale.id, r1.id)).status).toBe(200);        // older first: allowed, different line
    expect((await voidReturnNew(s, sale.id, r2.id)).status).toBe(200);
    expect(poolOf(s, A.id)).toEqual({ qty: 6, value: 6000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 4, value: 2000 });
    await reconOk(s);
  });
});

// =============================================================================================
describe('damaged returns (R-VR 6)', () => {
  // A: 5 units / 2,500 (avg 500). Sale 04-02: 2 @ 800 -> revenue 1,600, cogs 1,000, pool 3 / 1,500.
  // Return 04-03: 1 damaged -> revenue 800, cogs 500, one loss row of 500, NO movement, pool 3 / 1,500. Refund 800.
  // Void: the loss row becomes void (same reason), nothing moves in stock, refund paid back; revenue 1,600, cost 1,000.
  it('the loss row is voided with the return; no stock movement either way; revenue/cost restored', async () => {
    const s = await setup();
    const A = await stockedOn(s, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 2, 800)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, false)], { businessDate: '2025-04-03' })).item;
    expect(lossRows(s)).toHaveLength(1);
    expect(lossRows(s)[0]).toMatchObject({ status: 'posted', cost_cents: 500, source: 'damaged_return', sales_return_id: r.id });
    const mvBefore = num(s, 'SELECT COUNT(*) FROM stock_movements');
    let t = (await pnlDay(s, '2025-04-01', '2025-04-30')).totals;
    expect(t.adjustments).toMatchObject({ damagedReturnLossesCents: 500, netCents: 500 });
    expect(t.netProfitCents).toBe((1600 - 800) - (1000 - 500) - 500);          // revenue 800 - cost 500 - loss 500 = -200

    // a direct void of the loss is still refused (service guard) while the return is posted
    const lossId = lossRows(s)[0]!.id as number;
    expect(err(await lossVoid(s, lossId))).toMatchObject({ code: 'DAMAGED_RETURN_LOSS' });

    const v = await voidReturnOk(s, sale.id, r.id, 'wrong item');
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(mvBefore);
    expect(poolOf(s, A.id)).toEqual({ qty: 3, value: 1500 });
    expect(lossRows(s)[0]).toMatchObject({ status: 'void', void_reason: 'wrong item' });
    expect(lossRows(s)[0]!.voided_at).toBe(v.item.voidedAt);
    expect(cashOfRef(s, 'sales_returns', r.id).map((c) => c.amount_cents)).toEqual([-800, 800]);
    t = (await pnlDay(s, '2025-04-01', '2025-04-30')).totals;
    expect(t.adjustments).toMatchObject({ damagedReturnLossesCents: 0, netCents: 0, salesReturnVoidGainCents: 0 });
    expect(t.goods).toMatchObject({ revenueCents: 1600, costOfSalesCents: 1000, grossProfitCents: 600 });
    expect(t.netProfitCents).toBe(600);
    const losses = (await get(s.app, '/reports/stock-losses?from=2025-04-01&to=2025-04-30&granularity=month')).body;
    expect(losses.totals).toMatchObject({ lossCount: 0, costCents: 0, fromReturnsCents: 0, stockAdjustmentsNetCents: 0 });
    // the voided loss is still listed (history) but no longer counted
    const list = (await get(s.app, '/stock-losses?from=2025-04-01&to=2025-04-30')).body;
    expect(list.totalCostCents).toBe(0);
    expect(list.items).toHaveLength(1);
    // after the return is void the loss still cannot be voided on its own (service guard keeps the damaged-return rule)
    expect(err(await lossVoid(s, lossId))).toMatchObject({ code: 'DAMAGED_RETURN_LOSS' });
    expect(await shopIdentity(s)).toEqual({ reportProfit: 600 - 0, ledgerProfit: 600 });
    expect(returnedQtyMismatches(s.ctx)).toBe(0);
    await reconOk(s);
  });

  // Mixed return: A 1 resalable + B 1 damaged. Only A's unit leaves stock again.
  // A: 10 / 10,000 (avg 1,000), B: 4 / 2,000 (avg 500). Sale A 2 @ 3,000 (cogs 2,000), B 2 @ 900 (cogs 1,000). Pools A 8 / 8,000, B 2 / 1,000.
  // Return: A 1 resalable (rev 3,000, cogs 1,000) -> A 9 / 9,000; B 1 damaged (rev 900, cogs 500, loss 500) -> B stays 2 / 1,000.
  // Void: A leaves again -> 8 / 8,000; B unchanged 2 / 1,000; loss voided; refund 3,900 back.
  it('mixed resalable + damaged return: only the resalable unit leaves stock; the loss is voided', async () => {
    const s = await setup();
    const A = await stockedOn(s, 10, 10000);
    const B = await stockedOn(s, 4, 2000);
    const sale = (await sellOk(s, [cl(A.id, 2, 3000), cl(B.id, 2, 900)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true), rl(sale.items[1].id, 1, false)], { businessDate: '2025-04-03' })).item;
    expect(r.refundCents).toBe(3900);
    expect(poolOf(s, A.id)).toEqual({ qty: 9, value: 9000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 2, value: 1000 });
    await voidReturnOk(s, sale.id, r.id);
    expect(poolOf(s, A.id)).toEqual({ qty: 8, value: 8000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 2, value: 1000 });
    expect(mvsByRef(s, 'sales_returns', r.id).map((m) => [m.productId, m.qty, m.value])).toEqual([[A.id, 1, 1000], [A.id, -1, -1000]]);
    expect(lossRows(s).map((l) => l.status)).toEqual(['void']);
    // revenue 6,000 + 1,800 = 7,800, cost 2,000 + 1,000 = 3,000 -> profit 4,800. Cash -10,000 - 2,000 + 7,800 = -4,200; stock A 8,000 + B 1,000 = 9,000 -> 4,800.
    expect(await shopIdentity(s)).toEqual({ reportProfit: 4800, ledgerProfit: 4800 });
  });
});

// =============================================================================================
describe('insufficient stock (R-VR 3): refused, nothing written', () => {
  // P: 4 units / 4,000. Sale 04-02: 4 @ 2,000 -> pool 0 / 0. Return 04-03 of 3 resalable: cogs round(4000x3/4)=3,000 -> pool 3 / 3,000.
  // Sale 04-04 of 2 units: cogs round(3000x2/3)=2,000 -> pool 1 / 1,000. Void: needed 3, onHand 1 -> 409, nothing written.
  // Buy 2 more units for 2,000 -> pool 3 / 3,000 -> void works: removes 3 at min(3,000, 3,000) = 3,000 -> pool 0 / 0.
  it('units resold after the return: 409 RETURN_STOCK_NOT_AVAILABLE with productId/onHand/needed and a byte-identical database', async () => {
    const s = await setup();
    const P = await stockedOn(s, 4, 4000);
    const sale = (await sellOk(s, [cl(P.id, 4, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 3, true)], { businessDate: '2025-04-03' })).item;
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
    await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-04' });
    expect(poolOf(s, P.id)).toEqual({ qty: 1, value: 1000 });
    const before = snapshotAll(s.ctx);
    const res = await voidReturnNew(s, sale.id, r.id);
    expect(res.status).toBe(409);
    expect(err(res)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: P.id, onHand: 1, needed: 3 });
    expect(snapshotAll(s.ctx)).toEqual(before);
    await buy(s, [{ productId: P.id, packs: 1, packSize: 2, lineTotalCents: 2000 }], { businessDate: '2025-04-05' });
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
    await voidReturnOk(s, sale.id, r.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  // One return with two lines of the SAME product (the cart had it twice): needed = 1 + 1 = 2, onHand 1 -> refused, needed 2.
  // P: 5 units / 5,000. Sale 04-02: P 2 @ 2,000 and P 2 @ 2,000 (two lines) -> pool 1 / 1,000. Return both lines 1 unit each -> pool 3 / 3,000.
  // Sell 2 units -> pool 1 / 1,000. Void: needed 2, onHand 1.
  it('two lines of one product are added up before the check', async () => {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 2000), cl(P.id, 2, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true), rl(sale.items[1].id, 1, true)], { businessDate: '2025-04-03' })).item;
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
    await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-04' });
    const res = await voidReturnNew(s, sale.id, r.id);
    expect(err(res)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: P.id, onHand: 1, needed: 2 });
  });
});

// =============================================================================================
describe('stock value difference and residual sweep (R-VR 3; R4; section 11)', () => {
  /**
   * GAIN. Z: 10 units / 60,000 on 04-01 (6,000 each). Sale 04-02: 4 @ 10,000 -> revenue 40,000, cogs 24,000, pool 6 / 36,000.
   * Return of all 4 on 04-30 (refund 40,000, restores 24,000): pool 10 / 60,000.
   * Buy 10 units / 2,000 on 05-01: pool 20 / 62,000. Sale 05-02: 16 @ 10,000 -> cogs 62,000 x 16 / 20 = 49,600, pool 4 / 12,400.
   * Void the return (dated 04-30): removes 4 units at min(24,000, 12,400) = 12,400 -> pool 0 / 0 (no sweep).
   *   gain = restored 24,000 - removed 12,400 = 11,600, in the RETURN's period (04-30 / April).
   * Cash: -60,000 + 40,000 - 40,000 + 40,000 - 2,000 + 160,000 = 138,000; stock 0 -> profit 138,000.
   * Report: April = sale 40,000 - 24,000 = 16,000 + gain 11,600 = 27,600 (day 04-30: +11,600); May = 160,000 - 49,600 = 110,400.  Total 138,000.
   */
  it.each([['shop', mkProduct], ['telecom', mkTelecom]] as const)('%s: pool value below the restored value -> gain line in the return period; profit identity closes', async (seg, mk) => {
    const s = await setup();
    const Z = await stockedOn(s, 10, 60000, '2025-04-01', mk);
    const sale = (await sellOk(s, [cl(Z.id, 4, 10000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 4, true)], { businessDate: '2025-04-30' })).item;
    expect(poolOf(s, Z.id)).toEqual({ qty: 10, value: 60000 });
    await buy(s, [{ productId: Z.id, packs: 1, packSize: 10, lineTotalCents: 2000 }], { businessDate: '2025-05-01' });
    await sellOk(s, [cl(Z.id, 16, 10000)], { businessDate: '2025-05-02' });
    expect(poolOf(s, Z.id)).toEqual({ qty: 4, value: 12400 });
    await voidReturnOk(s, sale.id, r.id);
    expect(poolOf(s, Z.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', r.id).map((m) => [m.type, m.qty, m.value, m.date])).toEqual([
      ['sale_return', 4, 24000, '2025-04-30'], ['sale_return', -4, -12400, '2025-04-30'],
    ]);
    const month = (await get(s.app, `/reports/pnl/${seg}?from=2025-04-01&to=2025-05-31&granularity=month`)).body;
    expect(month.rows.map((x: any) => [x.period.label, x.adjustments.salesReturnVoidGainCents, x.adjustments.netCents, x.netProfitCents]))
      .toEqual([['2025-04', 11600, -11600, 27600], ['2025-05', 0, 0, 110400]]);
    expect(month.totals.netProfitCents).toBe(138000);
    expect(month.table.totals.salesReturnVoidGain).toBe(11600);
    expect(month.table.columns.map((c: any) => c.key)).toContain('salesReturnVoidGain');
    const days = (await pnlDay(s, '2025-04-28', '2025-05-02', seg)).rows;
    const d30 = days.find((x: any) => x.period.label === '2025-04-30');
    expect([d30.adjustments.salesReturnVoidGainCents, d30.netProfitCents, (seg === 'shop' ? d30.goods : d30.cards).returnsCents]).toEqual([11600, 11600, 0]);
    // the same figure in the stock-losses memo and the cash identity
    const memo = (await get(s.app, `/reports/stock-losses?from=2025-04-01&to=2025-05-31&granularity=month&book=${seg}`)).body;
    expect(memo.totals).toMatchObject({ salesReturnVoidGainCents: 11600, stockAdjustmentsNetCents: -11600, sweepCents: 0 });
    expect(segNetFromTables(s.ctx, seg, '0000-01-01', '9999-12-31')).toBe(138000);
    if (seg === 'shop') expect(await shopIdentity(s)).toEqual({ reportProfit: 138000, ledgerProfit: 138000 });
    const comb = (await get(s.app, '/reports/pnl/combined?from=2025-04-01&to=2025-05-31&granularity=month')).body;
    expect(comb.totals.recognizedProfitCents).toBe(138000);
    expect(cashBal(s, seg)).toBe(138000);
    await reconOk(s);
  });

  /**
   * SWEEP. Y: 4 units / 24,000 on 04-01. Sale 04-02: 4 @ 10,000 (rev 40,000, cogs 24,000) -> pool 0 / 0.
   * Return 4 on 04-03 (refund 40,000): pool 4 / 24,000. Buy 6 units / 60,000 on 04-04: pool 10 / 84,000.
   * Sale 04-05: 6 @ 10,000: cogs 84,000 x 6 / 10 = 50,400 -> pool 4 / 33,600.
   * Void: 4 units = the whole pool quantity; removed = min(24,000, 33,600) = 24,000; residue 33,600 - 24,000 = 9,600 is swept FIRST by a value-only
   * adjustment (so the pool is never 0 units with value); then the removal. Pool 0 / 0. Gain 0; sweep 9,600 (Stock adjustments cost) on 04-03.
   * Cash: -24,000 + 40,000 - 40,000 + 40,000 - 60,000 + 60,000 = 16,000 = profit: revenue 100,000 - cost 74,400 - sweep 9,600 = 16,000.
   */
  it('pool empties with value left over: residue swept as an adjustment (Stock adjustments line), gain 0, identity closes', async () => {
    const s = await setup();
    const Y = await stockedOn(s, 4, 24000);
    const sale = (await sellOk(s, [cl(Y.id, 4, 10000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 4, true)], { businessDate: '2025-04-03' })).item;
    await buy(s, [{ productId: Y.id, packs: 1, packSize: 6, lineTotalCents: 60000 }], { businessDate: '2025-04-04' });
    await sellOk(s, [cl(Y.id, 6, 10000)], { businessDate: '2025-04-05' });
    expect(poolOf(s, Y.id)).toEqual({ qty: 4, value: 33600 });
    await voidReturnOk(s, sale.id, r.id);
    expect(poolOf(s, Y.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', r.id).map((m) => [m.type, m.qty, m.value, m.date])).toEqual([
      ['sale_return', 4, 24000, '2025-04-03'], ['adjustment', 0, -9600, '2025-04-03'], ['sale_return', -4, -24000, '2025-04-03'],
    ]);
    const t = (await pnlDay(s, '2025-04-01', '2025-04-30')).totals;
    expect(t.adjustments).toMatchObject({ residualSweepsCents: 9600, salesReturnVoidGainCents: 0, netCents: 9600 });
    expect(t.netProfitCents).toBe(16000);
    const d3 = (await pnlDay(s, '2025-04-01', '2025-04-30')).rows.find((x: any) => x.period.label === '2025-04-03');
    expect(d3.adjustments.residualSweepsCents).toBe(9600);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 16000, ledgerProfit: 16000 });
    expect(cashBal(s, 'shop')).toBe(16000);
    await reconOk(s);
  });

  // Pool value equal to the restored value: no gain, no sweep (plain case). Y: 2 units / 2,000; sale 2 @ 3,000; return 2 (restores 2,000); void -> 0 / 0.
  it('pool value equals the restored value: gain 0 and no sweep', async () => {
    const s = await setup();
    const Y = await stockedOn(s, 2, 2000);
    const sale = (await sellOk(s, [cl(Y.id, 2, 3000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: '2025-04-03' })).item;
    await voidReturnOk(s, sale.id, r.id);
    const t = (await pnlDay(s, '2025-04-01', '2025-04-30')).totals;
    expect(t.adjustments).toMatchObject({ residualSweepsCents: 0, salesReturnVoidGainCents: 0, netCents: 0 });
    expect(mvsByRef(s, 'sales_returns', r.id)).toHaveLength(2);
  });
});

// =============================================================================================
describe('closed days (R9, R-VR 5)', () => {
  // The return is dated 04-03. Closing 04-03 for the Shop book makes the void 409 DAY_CLOSED (book + business date), nothing written.
  // After reopening the day the void works. Closing the SALE's day (04-02) does not matter for the void.
  it('DAY_CLOSED on the return date; works after reopening; other closed days do not matter', async () => {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    const c = await closeOk(s, 'shop', '2025-04-03');
    const before = snapshotAll(s.ctx);
    const res = await voidReturnNew(s, sale.id, r.id);
    expect(res.status).toBe(409);
    expect(err(res)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: '2025-04-03' });
    expect(snapshotAll(s.ctx)).toEqual(before);
    expect((await reopenNew(s, c.id, 'fix a mistake')).status).toBe(200);
    expect((await voidReturnNew(s, sale.id, r.id)).status).toBe(200);
    await reconOk(s);
  });

  // ALREADY_VOID and RETURN_NOT_NEWEST are reported before DAY_CLOSED (validation order of the contract).
  it('order: ALREADY_VOID, then RETURN_NOT_NEWEST, then DAY_CLOSED', async () => {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 3, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r1 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-04' })).item;
    await voidReturnOk(s, sale.id, r2.id);
    await closeOk(s, 'shop', '2025-04-03');
    expect(err(await voidReturnNew(s, sale.id, r2.id)).code).toBe('ALREADY_VOID');   // void AND on an open day: ALREADY_VOID
    const r3 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-05' })).item;
    expect(err(await voidReturnNew(s, sale.id, r1.id)).code).toBe('RETURN_NOT_NEWEST'); // r1 is on a closed day AND not newest
    expect(r3.id).toBeGreaterThan(r1.id);
  });
});

// =============================================================================================
describe('negative-cash warning (R13): reported, never blocks', () => {
  // P: 10 units / 10,000 bought (cash -10,000). Sale 1 @ 3,000 (cash -7,000). Return (refund 3,000): cash -10,000. Void: +3,000 -> -7,000, still below zero.
  it('the book is still below zero after the void: the shared warning is returned with the exact balance', async () => {
    const s = await setup();
    const P = await stockedOn(s, 10, 10000);
    const sale = (await sellOk(s, [cl(P.id, 1, 3000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    expect(cashBal(s, 'shop')).toBe(-10000);
    const v = await voidReturnOk(s, sale.id, r.id);
    expect(cashBal(s, 'shop')).toBe(-7000);
    expect(v.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -7000 })]);
  });

  // With an opening balance of 20,000 the book stays positive: no warning.
  it('no warning when the book is not below zero', async () => {
    const s = await setup();
    await openNew(s, 'shop', { businessDate: '2025-04-01', amountCents: 2000000 });
    const P = await stockedOn(s, 10, 10000);
    const sale = (await sellOk(s, [cl(P.id, 1, 3000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    expect((await voidReturnOk(s, sale.id, r.id)).warnings).toEqual([]);
  });
});

// =============================================================================================
describe('atomic rollback: a failure after any write step changes nothing', () => {
  /** Sale of two lines: A resalable (stock 10 / 10,000), B damaged material (5 / 2,500); one return with A 2 resalable + B 1 damaged. */
  async function world() {
    const s = await setup();
    const A = await stockedOn(s, 10, 10000);
    const B = await stockedOn(s, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 4, 1500), cl(B.id, 2, 800)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true), rl(sale.items[1].id, 1, false)], { businessDate: '2025-04-03' })).item;
    return { s, sale, r };
  }
  const faults: Array<[string, string]> = [
    ['return status update', 'CREATE TRIGGER test_f BEFORE UPDATE OF status ON sales_returns BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
    ['loss row void (inside the DB cascade)', 'CREATE TRIGGER test_f BEFORE UPDATE OF status ON stock_losses BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
    ['returned_qty counter (inside the DB cascade)', 'CREATE TRIGGER test_f BEFORE UPDATE OF returned_qty ON sale_items BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
    ['stock reversal movement', 'CREATE TRIGGER test_f BEFORE INSERT ON stock_movements WHEN NEW.qty_delta < 0 BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
    ['refund reversal cash entry', 'CREATE TRIGGER test_f BEFORE INSERT ON cash_entries WHEN NEW.amount_cents > 0 BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
    ['audit row', 'CREATE TRIGGER test_f BEFORE INSERT ON audit_logs WHEN NEW.action = \'void\' BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
  ];
  it.each(faults)('failure at: %s -> 500, no row of any table changed, retry succeeds', async (_name, trigger) => {
    quiet();
    const { s, sale, r } = await world();
    const before = snapshotAll(s.ctx);
    s.ctx.database.conn.exec(trigger);
    const res = await voidReturnNew(s, sale.id, r.id);
    expect(res.status).toBe(500);
    expect(snapshotAll(s.ctx)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_f');
    expect((await voidReturnNew(s, sale.id, r.id)).status).toBe(200);
    expect(returnedQtyMismatches(s.ctx)).toBe(0);
    await reconOk(s);
  });

  it('failure of the residual sweep movement (adjustment) rolls everything back', async () => {
    quiet();
    const s = await setup();
    const Y = await stockedOn(s, 4, 24000);
    const sale = (await sellOk(s, [cl(Y.id, 4, 10000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 4, true)], { businessDate: '2025-04-03' })).item;
    await buy(s, [{ productId: Y.id, packs: 1, packSize: 6, lineTotalCents: 60000 }], { businessDate: '2025-04-04' });
    await sellOk(s, [cl(Y.id, 6, 10000)], { businessDate: '2025-04-05' });
    const before = snapshotAll(s.ctx);
    s.ctx.database.conn.exec("CREATE TRIGGER test_f BEFORE INSERT ON stock_movements WHEN NEW.type = 'adjustment' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect((await voidReturnNew(s, sale.id, r.id)).status).toBe(500);
    expect(snapshotAll(s.ctx)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_f');
    expect((await voidReturnNew(s, sale.id, r.id)).status).toBe(200);
  });
});

// =============================================================================================
describe('double void, concurrency, idempotency', () => {
  async function simple() {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' }, )).item;
    return { s, P, sale, r };
  }

  it('a second void is 409 ALREADY_VOID and posts no second set of reversal rows', async () => {
    const { s, sale, r } = await simple();
    await voidReturnOk(s, sale.id, r.id);
    const counts = () => [num(s, "SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'sales_returns'"), num(s, "SELECT COUNT(*) FROM cash_entries WHERE ref_table = 'sales_returns'"),
      num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'sale_return'")];
    const c0 = counts();
    expect(c0).toEqual([2, 2, 2]);                       // one restock + one reversal, one refund + one reversal, create + void
    const before = snapshotAll(s.ctx);
    const again = await voidReturnNew(s, sale.id, r.id, 'again');
    expect(again.status).toBe(409);
    expect(err(again)).toMatchObject({ code: 'ALREADY_VOID', message: 'This return is already void.' });
    expect(snapshotAll(s.ctx)).toEqual(before);
    expect(counts()).toEqual(c0);
  });

  it('six concurrent voids: exactly one 200, five 409 ALREADY_VOID; reversal rows exist exactly once', async () => {
    const { s, sale, r } = await simple();
    const res = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => voidReturnNew(s, sale.id, r.id, `try ${i}`)));
    expect(res.filter((x) => x.status === 200)).toHaveLength(1);
    expect(res.filter((x) => x.status === 409).map((x) => err(x).code)).toEqual(['ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID']);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE ref_table = 'sales_returns' AND amount_cents > 0")).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'sales_returns' AND qty_delta < 0")).toBe(1);
    expect(returnedQtyMismatches(s.ctx)).toBe(0);
    await reconOk(s);
  });

  // The return's own clientRef stays idempotent after the void: the same request is answered with the saved (now void) return, nothing new is created.
  it('re-sending the original return request (same clientRef) after the void returns the voided return and creates nothing', async () => {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const body = { businessDate: '2025-04-03', items: [rl(sale.items[0].id, 1, true)], clientRef: 'return-idem-0001' };
    const first = await post(s.app, `/sales/${sale.id}/returns`, body);
    expect(first.status).toBe(201);
    await voidReturnOk(s, sale.id, first.body.item.id);
    const before = snapshotAll(s.ctx);
    const again = await post(s.app, `/sales/${sale.id}/returns`, body);
    expect(again.status).toBe(200);
    expect(again.body.item).toMatchObject({ id: first.body.item.id, status: 'void' });
    expect(snapshotAll(s.ctx)).toEqual(before);
    // a NEW return (new clientRef) is possible again and takes the exact remainder of the (unreturned) line
    const next = await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: '2025-04-04' });
    expect([next.item.refundCents, next.item.cogsReversedCents]).toEqual([4000, 2000]);
  });
});

// =============================================================================================
describe('validation, lookups and the order of checks', () => {
  async function simple() {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 3, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    return { s, P, sale, r };
  }

  it('schema: reason required, trimmed, at most 200 characters; unknown body fields and bad ids are 400', async () => {
    const { s, sale, r } = await simple();
    const url = `/sales/${sale.id}/returns/${r.id}/void`;
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(201) }, { reason: 5 }, { reason: 'ok', extra: 1 }]) {
      const res = await post(s.app, url, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(err(res).code).toBe('VALIDATION_ERROR');
    }
    expect((await post(s.app, `/sales/abc/returns/${r.id}/void`, { reason: 'x' })).status).toBe(400);
    expect((await post(s.app, `/sales/${sale.id}/returns/1.5/void`, { reason: 'x' })).status).toBe(400);
    expect(num(s, "SELECT COUNT(*) FROM sales_returns WHERE status = 'void'")).toBe(0);
    // a reason of exactly 200 characters, with surrounding spaces, is accepted and stored trimmed
    const ok = await post(s.app, url, { reason: `  ${'y'.repeat(200)}  ` });
    expect(ok.status).toBe(200);
    expect(ok.body.item.voidReason).toBe('y'.repeat(200));
  });

  it('404 for an unknown sale, an unknown return and a return that belongs to another sale', async () => {
    const { s, P, sale, r } = await simple();
    const other = (await sellOk(s, [cl(P.id, 1, 2000)], { businessDate: '2025-04-02' })).sales[0];
    expect(err(await voidReturnNew(s, 99999, r.id)).code).toBe('NOT_FOUND');
    expect(err(await voidReturnNew(s, sale.id, 99999)).code).toBe('NOT_FOUND');
    expect(err(await voidReturnNew(s, other.id, r.id)).code).toBe('NOT_FOUND');
    expect(num(s, "SELECT COUNT(*) FROM sales_returns WHERE status = 'void'")).toBe(0);
  });

  it('ALREADY_VOID is reported before RETURN_NOT_NEWEST', async () => {
    const { s, sale, r: r1 } = await simple();
    const r2 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-04' })).item;
    await voidReturnOk(s, sale.id, r2.id);
    await voidReturnOk(s, sale.id, r1.id);
    const r3 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-05' })).item;
    expect(err(await voidReturnNew(s, sale.id, r1.id)).code).toBe('ALREADY_VOID');   // r1 is void although r3 (newer) is posted
    expect(r3.status).toBe('posted');
  });
});

// =============================================================================================
describe('sale void guard counts POSTED returns only (R-VR 7)', () => {
  // P: 5 units / 5,000. Sale 2 @ 2,000 (cogs 2,000, pool 3 / 3,000), return 1 (pool 4 / 4,000).
  it('HAS_RETURNS while a posted return exists; once every return is voided the sale can be voided; stock and cash come out exact', async () => {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const r1 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-04' })).item;
    expect(err(await voidSaleNew(s, sale.id)).code).toBe('HAS_RETURNS');
    await voidReturnOk(s, sale.id, r2.id);
    expect(err(await voidSaleNew(s, sale.id)).code).toBe('HAS_RETURNS');          // r1 still posted
    await voidReturnOk(s, sale.id, r1.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
    const v = await voidSaleNew(s, sale.id, 'cancel the sale');
    expect(v.status).toBe(200);
    expect(poolOf(s, P.id)).toEqual({ qty: 5, value: 5000 });                   // sale void puts the 2 units back at their cost
    expect(cashBal(s, 'shop')).toBe(-5000);                                    // only the purchase remains (-5,000)
    expect((await get(s.app, `/sales/${sale.id}`)).body.item.returns.map((x: any) => x.status)).toEqual(['void', 'void']);
    // a void sale accepts no more returns; voiding a return of a void sale is already void
    expect(err(await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-05' })).code).toBe('SALE_VOID');
    expect(await shopIdentity(s)).toEqual({ reportProfit: 0, ledgerProfit: 0 });
    await reconOk(s);
  });
});

// =============================================================================================
describe('audit (section 12)', () => {
  it('void row: entity sale_return, action void, before posted / after void, business date = the return date, backdated flag; the create row is untouched', async () => {
    const s = await setup();
    const P = await stockedOn(s, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 2000)], { businessDate: '2025-04-02' })).sales[0];
    const old = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: '2025-04-03' })).item;
    const todays = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: today() })).item;
    const createRowBefore = JSON.stringify(auditRows(s.ctx, 'sale_return')[0]);
    await voidReturnOk(s, sale.id, todays.id, 'today one');
    await voidReturnOk(s, sale.id, old.id, 'old one');
    const rowsA = auditRows(s.ctx, 'sale_return');
    expect(rowsA.map((a) => [a.action, a.entityId])).toEqual([['create', String(old.id)], ['create', String(todays.id)], ['void', String(todays.id)], ['void', String(old.id)]]);
    expect(JSON.stringify(rowsA[0])).toBe(createRowBefore);
    expect(rowsA[3]!.before).toMatchObject({ status: 'posted', voidedAt: null });
    expect(rowsA[3]!.after).toMatchObject({ status: 'void', voidReason: 'old one' });
    expect(sql(s, "SELECT action, business_date, backdated, note FROM audit_logs WHERE entity = 'sale_return' AND action = 'void' ORDER BY id"))
      .toEqual([{ action: 'void', business_date: today(), backdated: 0, note: 'today one' }, { action: 'void', business_date: '2025-04-03', backdated: 1, note: 'old one' }]);
    // the reversal rows copy the return's date; the void timestamp is "now" (posted_at of the reversal rows is today)
    expect(cashOfRef(s, 'sales_returns', old.id).map((c) => c.business_date)).toEqual(['2025-04-03', '2025-04-03']);
    expect(sql(s, "SELECT COUNT(*) AS n FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? AND date(posted_at, '+330 minutes') = ?", old.id, today())[0]!.n).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================================
describe('purchase flows are untouched', () => {
  // Z: 10 u / 60,000 on 04-01 (purchase P1), 10 u / 2,000 on 04-02 (P2): pool 20 / 62,000. A sales return is voided in the same world.
  // Purchase return of 6 units of P1 on 04-05: refund 36,000, removed min(36,000, pool). The purchase refund gain is the existing figure and
  // salesReturnVoidGainCents stays 0 because only a voided SALES return feeds it.
  it('purchase return gain unchanged next to a voided sales return', async () => {
    const s = await setup();
    const Z = await mkProduct(s, { sellPriceCents: 1000, minPriceCents: 1 });
    const p1 = await buy(s, [{ productId: Z.id, packs: 1, packSize: 10, lineTotalCents: 60000 }], { businessDate: '2025-04-01' });
    await buy(s, [{ productId: Z.id, packs: 1, packSize: 10, lineTotalCents: 2000 }], { businessDate: '2025-04-02' });
    const sale = (await sellOk(s, [cl(Z.id, 12, 1000)], { businessDate: '2025-04-03' })).sales[0];   // cogs 62,000 x 12 / 20 = 37,200 -> pool 8 / 24,800
    const sr = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: '2025-04-04' })).item;  // cogs 37,200 x 2/12 = 6,200 -> pool 10 / 31,000
    await voidReturnOk(s, sale.id, sr.id);                                                         // removes 2 at min(6,200, 31,000)=6,200 -> pool 8 / 24,800
    expect(poolOf(s, Z.id)).toEqual({ qty: 8, value: 24800 });
    const pr = await post(s.app, `/purchases/${p1.id}/returns`, { businessDate: '2025-04-05', items: [{ purchaseItemId: p1.items[0].id, units: 6 }], clientRef: ref() });
    expect(pr.status).toBe(201);
    // refund 6 x 6,000 = 36,000; removed min(36,000, 24,800) = 24,800 -> gain 11,200 (existing rule R4)
    const t = await shopPnlTotals(s, '2025-04-01', '2025-04-30');
    expect(t.adjustments).toMatchObject({ purchaseRefundGainCents: 11200, salesReturnVoidGainCents: 0, netCents: -11200 });
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
    await reconOk(s);
  });
});

