// PHASE 19 - INDEPENDENT AUDIT of "void a sales return" (BUSINESS_RULES section 4, R-VR; migration 017). HAND-CALCULATED WORLDS.
// Every world is built through the real HTTP API (Fastify inject). Every expected figure below is worked out BY HAND in the comment above its test
// (cents; the working is independent arithmetic and is never read from report code). The scenarios and numbers are NEW (they do not repeat phase 17).
// Covered audit items: (1) multi-product returns, (2) many partial returns of one line with awkward rounding and every possible void order,
// (3) C13 extra cost on every path, (5) damaged + resalable in one return, (6) resold units, (7) newest-first across partly shared lines,
// (8) cash reversal rows, (9) stock reconciliation after every step, (11) profit before / after return / after void, cash book closing balances,
// (12) interleaved purchase return / sale void / re-return, closed-day reopen sequences.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct, mkTelecom, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, mvsByRef, num, poolOf, sql } from './helpers/phase4.ts';
import { closeOk, expNew, expVoid, openNew, reopenNew } from './helpers/phase8.ts';
import { cashOfRef, cl, clc, returnNew, returnOk, rl, sellOk, voidSaleNew } from './helpers/phase5.ts';
import { diffSnapshots, shopIdentity, snapshotAll } from './helpers/phase14.ts';
import { returnedQtyMismatches, voidReturnNew, voidReturnOk } from './helpers/phase17.ts';
import { assertReturnLedgers, cashOf, dayRow, permutations, pnl, reconAll } from './helpers/phase19rv.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const mk = (s: ApiBase) => mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 });
const mkT = (s: ApiBase) => mkTelecom(s, { sellPriceCents: 10000, minPriceCents: 0 });
/** After EVERY step: stock cache = sum of movements for every product (item 9) and the return ledgers have no duplicates (item 12). */
const check = async (s: ApiBase): Promise<void> => { await reconAll(s); assertReturnLedgers(s.ctx); expect(returnedQtyMismatches(s.ctx)).toBe(0); };
const noWrite = async (s: ApiBase, f: () => Promise<any>): Promise<any> => {
  const before = snapshotAll(s.ctx);
  const r = await f();
  expect(diffSnapshots(before, snapshotAll(s.ctx)), 'a refused request must write nothing').toEqual([]);
  return r;
};
const shop = async (s: ApiBase, from: string, to: string) => (await pnl(s, 'shop', from, to)).totals;
const line = (sale: any, i: number) => sale.items[i];
const rline = (ret: any, saleItemId: number) => ret.items.find((x: any) => x.saleItemId === saleItemId);

// =====================================================================================================================================
// S1 - three products, different costs, different extra costs, mixed resalable + damaged in the same returns.
//
// Opening Shop cash 5,000,000 (06-01). One purchase (06-01): P1 7 units for 10,001; P2 3 units for 7,001; P3 5 units for 4,000 -> cash 4,978,998.
// SALE (06-02), cart order:
//   a) P1 x4 @2,501 = 10,004. cogs = round(10,001 x 4 / 7) = round(5,714.857) = 5,715 -> pool 3 / 4,286. cashier cost 1,500/unit = 6,000 -> extra 285.
//   b) P2 x3 @3,000 = 9,000. cogs = whole pool 7,001 -> pool 0/0. cashier cost 2,334/unit = 7,002 -> extra 1.
//   c) P3 x2 @1,000 = 2,000. cogs = round(4,000 x 2 / 5) = 1,600 -> pool 3 / 2,400. extra 0.
//   total 21,004 -> cash 5,000,002. revenue 21,004, auto 14,316, extra 286, profit 21,004 - 14,602 = 6,402.
// R1 (06-03): a x1 resalable, b x2 resalable, c x1 DAMAGED.
//   a: rev 2,501; cogs round(5,715/4)=round(1,428.75)=1,429; extra round(285/4)=round(71.25)=71.
//   b: rev 6,000; cogs round(7,001 x 2/3)=round(4,667.33)=4,667; extra round(1 x 2/3)=round(0.667)=1.
//   c: rev 1,000; cogs round(1,600/2)=800; extra 0 (damaged: loss row 800, no movement).
//   refund 9,501; cogs reversed 6,896; extra reversed 72. Pools P1 4/5,715 (3/4,286 + 1/1,429), P2 2/4,667, P3 3/2,400. cash 4,990,501.
//   P&L: revenue 11,503; auto 7,420; extra 214; gross 3,869; stock adjustments (damaged return loss) 800; net 3,069.
//   identity: cash 4,990,501 + stock (5,715+4,667+2,400 = 12,782) = 5,003,283 -> +3,283 over the 5,000,000 start; minus net extra 214 = 3,069. ok
// R2 (06-04): a x2 resalable, b x1 DAMAGED (completes line b: takes the remainder).
//   a: rev round(10,004 x 2/4)=5,002; cogs round(5,715 x 2/4)=round(2,857.5)=2,858 (half away from zero); extra round(285 x 2/4)=round(142.5)=143.
//   b: remainder rev 9,000-6,000=3,000; cogs 7,001-4,667=2,334; extra 1-1=0.
//   refund 8,002; cogs 5,192; extra 143. P1 6/8,573; P2 2/4,667 (b damaged -> nothing back); P3 3/2,400. cash 4,982,499.
//   P&L: revenue 21,004-17,503=3,501; auto 14,316-12,088=2,228; extra 286-215=71; gross 1,202; loss 800+2,334=3,134; net -1,932.
//   identity: cash 4,982,499 + stock (8,573+4,667+2,400 = 15,640) = 4,998,139 -> -1,861; minus extra 71 -> -1,932. ok
// VOID R1 first -> 409 RETURN_NOT_NEWEST (R2 shares a and b), nothing written. VOID R2 -> cash 4,990,501; P1 4/5,715 (removes 2 x min(2,858, 8,573)); P2 unchanged; loss of R2 void;
//   back to net 3,069. VOID R1 -> cash 5,000,002; P1 3/4,286; P2 2 units leave 4,667 -> 0/0 (pool value = restored value, no sweep, no gain); both losses void; net 6,402.
// R3 (06-05): b x3 resalable: nothing is posted any more on b, so it takes the whole line: rev 9,000, cogs 7,001, extra 1. P2 3/7,001. Then void R3 -> P2 0/0.
// SALE VOID (all returns void): cash 4,978,998; P1 7/10,001; P2 3/7,001; P3 5/4,000; every figure zero; no new return rows.
// =====================================================================================================================================
describe('S1: multi-product sale, mixed resalable/damaged returns, extra cost on every path', () => {
  it('hand-calculated at every step, wrong void order refused without writing, sale void afterwards', async () => {
    const s = await setup();
    const P1 = await mk(s); const P2 = await mk(s); const P3 = await mk(s);
    expect((await openNew(s, 'shop', { businessDate: '2025-06-01', amountCents: 5000000 })).status).toBe(201);
    await buy(s, [
      { productId: P1.id, packs: 1, packSize: 7, lineTotalCents: 10001 },
      { productId: P2.id, packs: 1, packSize: 3, lineTotalCents: 7001 },
      { productId: P3.id, packs: 1, packSize: 5, lineTotalCents: 4000 },
    ], { businessDate: '2025-06-01' });
    expect(cashOf(s, 'shop')).toBe(4978998);

    const sale = (await sellOk(s, [clc(P1.id, 4, 2501, 1500), clc(P2.id, 3, 3000, 2334), cl(P3.id, 2, 1000)], { businessDate: '2025-06-02' })).sales[0];
    const [a, b, c] = [line(sale, 0), line(sale, 1), line(sale, 2)];
    expect(a).toMatchObject({ revenueCents: 10004, cogsCents: 5715, extraCostCents: 285 });
    expect(b).toMatchObject({ revenueCents: 9000, cogsCents: 7001, extraCostCents: 1 });
    expect(c).toMatchObject({ revenueCents: 2000, cogsCents: 1600, extraCostCents: 0 });
    expect(poolOf(s, P1.id)).toEqual({ qty: 3, value: 4286 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, P3.id)).toEqual({ qty: 3, value: 2400 });
    expect(cashOf(s, 'shop')).toBe(5000002);
    let t = await shop(s, '2025-06-01', '2025-06-30');
    expect(t.goods).toMatchObject({ salesCents: 21004, revenueCents: 21004, costAutomaticCents: 14316, costExtraCents: 286, grossProfitCents: 6402 });
    expect(t.netProfitCents).toBe(6402);
    await check(s);

    // ---- R1
    const r1 = (await returnOk(s, sale.id, [rl(a.id, 1, true), rl(b.id, 2, true), rl(c.id, 1, false)], { businessDate: '2025-06-03' })).item;
    expect(r1).toMatchObject({ refundCents: 9501, cogsReversedCents: 6896, extraCostReversedCents: 72, status: 'posted' });
    expect(rline(r1, a.id)).toMatchObject({ revenueCents: 2501, cogsCents: 1429, extraCostCents: 71 });
    expect(rline(r1, b.id)).toMatchObject({ revenueCents: 6000, cogsCents: 4667, extraCostCents: 1 });
    expect(rline(r1, c.id)).toMatchObject({ revenueCents: 1000, cogsCents: 800, extraCostCents: 0 });
    expect(poolOf(s, P1.id)).toEqual({ qty: 4, value: 5715 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 2, value: 4667 });
    expect(poolOf(s, P3.id)).toEqual({ qty: 3, value: 2400 });
    expect(cashOf(s, 'shop')).toBe(4990501);
    t = await shop(s, '2025-06-01', '2025-06-30');
    expect(t.goods).toMatchObject({ returnsCents: 9501, revenueCents: 11503, costAutomaticCents: 7420, costExtraCents: 214, grossProfitCents: 3869 });
    expect(t.adjustments).toMatchObject({ damagedReturnLossesCents: 800, netCents: 800, salesReturnVoidGainCents: 0 });
    expect(t.netProfitCents).toBe(3069);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 3069, ledgerProfit: 3069 });
    await check(s);

    // ---- R2
    const r2 = (await returnOk(s, sale.id, [rl(a.id, 2, true), rl(b.id, 1, false)], { businessDate: '2025-06-04' })).item;
    expect(r2).toMatchObject({ refundCents: 8002, cogsReversedCents: 5192, extraCostReversedCents: 143 });
    expect(rline(r2, a.id)).toMatchObject({ revenueCents: 5002, cogsCents: 2858, extraCostCents: 143 });
    expect(rline(r2, b.id)).toMatchObject({ revenueCents: 3000, cogsCents: 2334, extraCostCents: 0 });
    expect(poolOf(s, P1.id)).toEqual({ qty: 6, value: 8573 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 2, value: 4667 });
    expect(cashOf(s, 'shop')).toBe(4982499);
    t = await shop(s, '2025-06-01', '2025-06-30');
    expect(t.goods).toMatchObject({ returnsCents: 17503, revenueCents: 3501, costAutomaticCents: 2228, costExtraCents: 71, grossProfitCents: 1202 });
    expect(t.adjustments).toMatchObject({ damagedReturnLossesCents: 3134, netCents: 3134 });
    expect(t.netProfitCents).toBe(-1932);
    expect(await shopIdentity(s)).toEqual({ reportProfit: -1932, ledgerProfit: -1932 });
    await check(s);

    // ---- wrong order: refused, nothing written
    const bad = await noWrite(s, () => voidReturnNew(s, sale.id, r1.id));
    expect(bad.status).toBe(409);
    expect(err(bad)).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r2.id });

    // ---- void R2
    const v2 = await voidReturnOk(s, sale.id, r2.id, 'wrong item');
    expect(v2.item).toMatchObject({ status: 'void', refundCents: 8002 });
    expect(v2.warnings).toEqual([]);
    expect(poolOf(s, P1.id)).toEqual({ qty: 4, value: 5715 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 2, value: 4667 });
    expect(cashOf(s, 'shop')).toBe(4990501);
    expect(sql(s, 'SELECT returned_qty q FROM sale_items WHERE sale_id = ? ORDER BY line_no', sale.id).map((r) => Number(r.q))).toEqual([1, 2, 1]);
    expect(sql(s, 'SELECT status FROM stock_losses WHERE sales_return_id = ?', r2.id)).toEqual([{ status: 'void' }]);
    expect(sql(s, 'SELECT status FROM stock_losses WHERE sales_return_id = ?', r1.id)).toEqual([{ status: 'posted' }]);
    t = await shop(s, '2025-06-01', '2025-06-30');
    expect(t.netProfitCents).toBe(3069);
    expect(t.adjustments).toMatchObject({ damagedReturnLossesCents: 800, salesReturnVoidGainCents: 0, residualSweepsCents: 0 });
    expect(await shopIdentity(s)).toEqual({ reportProfit: 3069, ledgerProfit: 3069 });
    await check(s);

    // ---- void R1
    const v1 = await voidReturnOk(s, sale.id, r1.id, 'wrong customer');
    expect(v1.item.status).toBe('void');
    expect(poolOf(s, P1.id)).toEqual({ qty: 3, value: 4286 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, P3.id)).toEqual({ qty: 3, value: 2400 });
    expect(cashOf(s, 'shop')).toBe(5000002);
    t = await shop(s, '2025-06-01', '2025-06-30');
    expect(t.goods).toMatchObject({ returnsCents: 0, revenueCents: 21004, costAutomaticCents: 14316, costExtraCents: 286, grossProfitCents: 6402 });
    expect(t.adjustments.netCents).toBe(0);
    expect(t.netProfitCents).toBe(6402);
    const days = await pnl(s, 'shop', '2025-06-01', '2025-06-30', 'day');
    expect(dayRow(days, '2025-06-03').netProfitCents).toBe(0);
    expect(dayRow(days, '2025-06-04').netProfitCents).toBe(0);
    expect(dayRow(days, '2025-06-02').netProfitCents).toBe(6402);
    expect(sql(s, "SELECT COUNT(*) n FROM stock_losses WHERE status = 'posted'")[0]!.n).toBe(0);
    await check(s);

    // ---- R3 takes the exact remainder of b again, then void it
    const r3 = (await returnOk(s, sale.id, [rl(b.id, 3, true)], { businessDate: '2025-06-05' })).item;
    expect(r3).toMatchObject({ refundCents: 9000, cogsReversedCents: 7001, extraCostReversedCents: 1 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 3, value: 7001 });
    expect(cashOf(s, 'shop')).toBe(4991002);
    await check(s);
    await voidReturnOk(s, sale.id, r3.id, 'again');
    expect(poolOf(s, P2.id)).toEqual({ qty: 0, value: 0 });
    expect(cashOf(s, 'shop')).toBe(5000002);
    await check(s);

    // ---- the sale itself can now be voided (all returns void); the returns' ledger rows are not touched again
    const retRowsBefore = JSON.stringify([sql(s, "SELECT * FROM cash_entries WHERE ref_table = 'sales_returns' ORDER BY id"), sql(s, "SELECT * FROM stock_movements WHERE ref_table = 'sales_returns' ORDER BY id")]);
    const sv = await voidSaleNew(s, sale.id);
    expect(sv.status).toBe(200);
    expect(JSON.stringify([sql(s, "SELECT * FROM cash_entries WHERE ref_table = 'sales_returns' ORDER BY id"), sql(s, "SELECT * FROM stock_movements WHERE ref_table = 'sales_returns' ORDER BY id")])).toBe(retRowsBefore);
    expect(cashOf(s, 'shop')).toBe(4978998);
    expect(poolOf(s, P1.id)).toEqual({ qty: 7, value: 10001 });
    expect(poolOf(s, P2.id)).toEqual({ qty: 3, value: 7001 });
    expect(poolOf(s, P3.id)).toEqual({ qty: 5, value: 4000 });
    t = await shop(s, '2025-06-01', '2025-06-30');
    expect(t.netProfitCents).toBe(0);
    expect(t.goods).toMatchObject({ revenueCents: 0, costAutomaticCents: 0, costExtraCents: 0 });
    expect(await shopIdentity(s)).toEqual({ reportProfit: 0, ledgerProfit: 0 });
    await check(s);
    // after the sale void: no new return, no second void of a void return
    const again = await returnNew(s, sale.id, [rl(a.id, 1, true)], { businessDate: '2025-06-06' });
    expect(err(again)).toMatchObject({ code: 'SALE_VOID' });
    const twice = await voidReturnNew(s, sale.id, r1.id);
    expect(err(twice)).toMatchObject({ code: 'ALREADY_VOID' });
    await check(s);
  });
});

// =====================================================================================================================================
// S2 - three returns that share only SOME lines (item 7). One sale (07-02), lines on three products, all stock sold.
//   Opening 10,000,000 (07-01); purchases P4 6 units 9,999; P5 6 units 5,000; P6 6 units 3,001 = 18,000 -> cash 9,982,000.
//   L4: P4 x6 @2,000 = 12,000, cogs 9,999 (whole pool), cashier cost 1,700 -> 10,200 -> extra 201.
//   L5: P5 x6 @1,000 = 6,000, cogs 5,000, extra 0.      L6: P6 x6 @700 = 4,200, cogs 3,001, cost 501 -> 3,006 -> extra 5.
//   sale 22,200 -> cash 10,004,200; revenue 22,200 auto 18,000 extra 206 -> profit 3,994.
//   R1 (07-03): L4 x2 res + L5 x2 res.  L4: rev 4,000; cogs round(9,999 x 2/6)=3,333; extra round(201 x 2/6)=67.
//                                          L5: rev 2,000; cogs round(5,000 x 2/6)=round(1,666.67)=1,667. refund 6,000. P4 2/3,333, P5 2/1,667.
//   R2 (07-04): L5 x2 DAMAGED + L6 x3 res. L5: rev 2,000; cogs 1,667 (4 of 6, not final). L6: rev 2,100; cogs round(3,001 x 3/6)=round(1,500.5)=1,501; extra round(5 x 3/6)=round(2.5)=3.
//                refund 4,100. P6 3/1,501; P5 unchanged 2/1,667; loss row 1,667.
//   R3 (07-05): L4 x1 res. rev 2,000; cogs round(9,999/6)=round(1,666.5)=1,667; extra round(201/6)=round(33.5)=34. refund 2,000. P4 3/5,000.
//   cash after the 3 returns 10,004,200-12,100 = 9,992,100. revenue 10,100; auto 18,000-(3,333+1,667+1,667+1,501+1,667 = 9,835)=8,165; extra 206-104=102; gross 1,833; loss 1,667; net 166.
//   identity: stock P4 5,000 + P5 1,667 + P6 1,501 = 8,168; cash+stock = 10,000,268 -> +268 -102 = 166. ok
//   R1 is blocked by R3 (shares L4) AND by R2 (shares L5): the NEWEST blocking one is named (R3). R2 shares nothing newer -> voidable now; R3 voidable.
//   void R2 -> cash 9,996,200, P6 0/0, loss void. void R1 -> refused (R3). void R3 -> cash 9,998,200, P4 2/3,333. void R1 -> cash 10,004,200, P4 0/0, P5 0/0.
// =====================================================================================================================================
describe('S2: returns that share only some sale lines', () => {
  it('voidable ones go, blocked ones name the newest blocker and write nothing; exact figures throughout', async () => {
    const s = await setup();
    const [P4, P5, P6] = [await mk(s), await mk(s), await mk(s)];
    await openNew(s, 'shop', { businessDate: '2025-07-01', amountCents: 10000000 });
    await buy(s, [{ productId: P4.id, packs: 1, packSize: 6, lineTotalCents: 9999 }, { productId: P5.id, packs: 1, packSize: 6, lineTotalCents: 5000 },
      { productId: P6.id, packs: 1, packSize: 6, lineTotalCents: 3001 }], { businessDate: '2025-07-01' });
    const sale = (await sellOk(s, [clc(P4.id, 6, 2000, 1700), cl(P5.id, 6, 1000), clc(P6.id, 6, 700, 501)], { businessDate: '2025-07-02' })).sales[0];
    const [l4, l5, l6] = [line(sale, 0), line(sale, 1), line(sale, 2)];
    expect([l4, l5, l6].map((x) => [x.revenueCents, x.cogsCents, x.extraCostCents])).toEqual([[12000, 9999, 201], [6000, 5000, 0], [4200, 3001, 5]]);
    expect(cashOf(s, 'shop')).toBe(10004200);
    expect((await shop(s, '2025-07-01', '2025-07-31')).netProfitCents).toBe(3994);

    const r1 = (await returnOk(s, sale.id, [rl(l4.id, 2, true), rl(l5.id, 2, true)], { businessDate: '2025-07-03' })).item;
    const r2 = (await returnOk(s, sale.id, [rl(l5.id, 2, false), rl(l6.id, 3, true)], { businessDate: '2025-07-04' })).item;
    const r3 = (await returnOk(s, sale.id, [rl(l4.id, 1, true)], { businessDate: '2025-07-05' })).item;
    expect([r1, r2, r3].map((r) => [r.refundCents, r.cogsReversedCents, r.extraCostReversedCents])).toEqual([[6000, 5000, 67], [4100, 3168, 3], [2000, 1667, 34]]);
    expect(poolOf(s, P4.id)).toEqual({ qty: 3, value: 5000 });
    expect(poolOf(s, P5.id)).toEqual({ qty: 2, value: 1667 });
    expect(poolOf(s, P6.id)).toEqual({ qty: 3, value: 1501 });
    expect(cashOf(s, 'shop')).toBe(9992100);
    let t = await shop(s, '2025-07-01', '2025-07-31');
    expect(t.goods).toMatchObject({ revenueCents: 10100, costAutomaticCents: 8165, costExtraCents: 102, grossProfitCents: 1833 });
    expect(t.adjustments.netCents).toBe(1667);
    expect(t.netProfitCents).toBe(166);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 166, ledgerProfit: 166 });
    await check(s);

    const bad1 = await noWrite(s, () => voidReturnNew(s, sale.id, r1.id));
    expect(err(bad1)).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r3.id });

    await voidReturnOk(s, sale.id, r2.id);
    expect(cashOf(s, 'shop')).toBe(9996200);
    expect(poolOf(s, P6.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, P5.id)).toEqual({ qty: 2, value: 1667 });
    t = await shop(s, '2025-07-01', '2025-07-31');
    expect(t.adjustments.netCents).toBe(0);
    // revenue 22,200-8,000 = 14,200; auto 18,000-(5,000+1,667) = 11,333 ; extra 206-(67+34) = 105 ; net 14,200-11,333-105 = 2,762
    expect(t.netProfitCents).toBe(2762);
    await check(s);

    const bad1b = await noWrite(s, () => voidReturnNew(s, sale.id, r1.id));
    expect(err(bad1b)).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: r3.id });

    await voidReturnOk(s, sale.id, r3.id);
    expect(cashOf(s, 'shop')).toBe(9998200);
    expect(poolOf(s, P4.id)).toEqual({ qty: 2, value: 3333 });
    await check(s);
    await voidReturnOk(s, sale.id, r1.id);
    expect(cashOf(s, 'shop')).toBe(10004200);
    expect(poolOf(s, P4.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, P5.id)).toEqual({ qty: 0, value: 0 });
    expect((await shop(s, '2025-07-01', '2025-07-31')).netProfitCents).toBe(3994);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 3994, ledgerProfit: 3994 });
    await check(s);
  });
});

// =====================================================================================================================================
// S3 - EVERY possible order of voiding four returns (4! = 24 fresh worlds). Item 2 (awkward rounding) + item 7 (shared lines) + item 12 (refusals write nothing).
//   Opening 1,000,000 (08-01). Purchases: X 7 units 5,003; Y 5 units 3,333 -> cash 991,664.
//   Sale (08-02): X x7 @1,337 = 9,359 (cost 720 -> 5,040 -> extra 37; cogs 5,003 whole pool); Y x5 @999 = 4,995 (cogs 3,333). total 14,354 -> cash 1,006,018.
//   Ra (08-03): X2 + Y1 resalable. X rev round(9,359x2/7)=2,674 (18,718/7 exactly); cogs round(5,003x2/7)=round(1,429.43)=1,429; extra round(37x2/7)=round(10.57)=11.
//                                  Y rev 999; cogs round(3,333/5)=round(666.6)=667.        refund 3,673; cogs 2,096; extra 11.
//   Rb (08-04): X3 res.  X rev round(9,359x3/7)=4,011 (28,077/7 exactly); cogs round(5,003x3/7)=round(2,144.14)=2,144; extra round(37x3/7)=round(15.86)=16. refund 4,011.
//   Rc (08-05): Y2 res.  Y rev 1,998; cogs round(3,333x2/5)=round(1,333.2)=1,333; extra 0. refund 1,998.
//   Rd (08-06): X2 + Y2 res = completes BOTH lines: X rev 9,359-2,674-4,011=2,674; cogs 5,003-1,429-2,144=1,430; extra 37-11-16=10.
//                                                   Y rev 4,995-999-1,998=1,998; cogs 3,333-667-1,333=1,333.  refund 4,672; cogs 2,763; extra 10.
//   check: refunds 3,673+4,011+1,998+4,672 = 14,354 = sale; cogs 2,096+2,144+1,333+2,763 = 8,336 = 5,003+3,333; extra 11+16+0+10 = 37.
//   Shares: Ra{X,Y} Rb{X} Rc{Y} Rd{X,Y}. A return is voidable iff no POSTED later return shares a line: Rd first; then Rb and Rc in any order; Ra last (2 valid orders of 24).
//   Model after any subset S of posted returns: pool X = sum of restored X of S, pool Y likewise; cash = 1,006,018 - sum refunds(S);
//   net profit = (14,354 - refunds) - (8,336 - cogs) - (37 - extra).
// =====================================================================================================================================
describe('S3: all 24 orders of voiding four partly overlapping returns', () => {
  const RET: Record<string, { x: [number, number]; y: [number, number]; refund: number; cogs: number; extra: number; lines: ('X' | 'Y')[] }> = {
    a: { x: [2, 1429], y: [1, 667], refund: 3673, cogs: 2096, extra: 11, lines: ['X', 'Y'] },
    b: { x: [3, 2144], y: [0, 0], refund: 4011, cogs: 2144, extra: 16, lines: ['X'] },
    c: { x: [0, 0], y: [2, 1333], refund: 1998, cogs: 1333, extra: 0, lines: ['Y'] },
    d: { x: [2, 1430], y: [2, 1333], refund: 4672, cogs: 2763, extra: 10, lines: ['X', 'Y'] },
  };
  const KEYS = ['a', 'b', 'c', 'd'];
  const ORDER = KEYS; // posting order = id order

  it('every permutation: the model decides 200 or RETURN_NOT_NEWEST; refusals write nothing; all figures hand-modelled', async () => {
    let valid = 0;
    const perms = permutations(KEYS);
    expect(perms.length).toBe(24);
    for (const perm of perms) {
      await env.cleanup();
      const s = await setup();
      const X = await mk(s); const Y = await mk(s);
      await openNew(s, 'shop', { businessDate: '2025-08-01', amountCents: 1000000 });
      await buy(s, [{ productId: X.id, packs: 1, packSize: 7, lineTotalCents: 5003 }, { productId: Y.id, packs: 1, packSize: 5, lineTotalCents: 3333 }], { businessDate: '2025-08-01' });
      const sale = (await sellOk(s, [clc(X.id, 7, 1337, 720), cl(Y.id, 5, 999)], { businessDate: '2025-08-02' })).sales[0];
      const [lx, ly] = [line(sale, 0), line(sale, 1)];
      expect([lx, ly].map((x) => [x.revenueCents, x.cogsCents, x.extraCostCents])).toEqual([[9359, 5003, 37], [4995, 3333, 0]]);
      expect(cashOf(s, 'shop')).toBe(1006018);
      const ids: Record<string, number> = {};
      const mkRet = async (k: string, date: string, items: any[]) => {
        const r = (await returnOk(s, sale.id, items, { businessDate: date })).item;
        expect([r.refundCents, r.cogsReversedCents, r.extraCostReversedCents], `return ${k}`).toEqual([RET[k]!.refund, RET[k]!.cogs, RET[k]!.extra]);
        ids[k] = r.id;
      };
      await mkRet('a', '2025-08-03', [rl(lx.id, 2, true), rl(ly.id, 1, true)]);
      await mkRet('b', '2025-08-04', [rl(lx.id, 3, true)]);
      await mkRet('c', '2025-08-05', [rl(ly.id, 2, true)]);
      await mkRet('d', '2025-08-06', [rl(lx.id, 2, true), rl(ly.id, 2, true)]);

      const posted = new Set(KEYS);
      const verify = async (): Promise<void> => {
        let px = [0, 0]; let py = [0, 0]; let refunds = 0; let cogs = 0; let extra = 0;
        for (const k of posted) {
          px = [px[0]! + RET[k]!.x[0], px[1]! + RET[k]!.x[1]]; py = [py[0]! + RET[k]!.y[0], py[1]! + RET[k]!.y[1]];
          refunds += RET[k]!.refund; cogs += RET[k]!.cogs; extra += RET[k]!.extra;
        }
        expect(poolOf(s, X.id), 'pool X').toEqual({ qty: px[0], value: px[1] });
        expect(poolOf(s, Y.id), 'pool Y').toEqual({ qty: py[0], value: py[1] });
        expect(cashOf(s, 'shop'), 'cash').toBe(1006018 - refunds);
        const t = await shop(s, '2025-08-01', '2025-08-31');
        expect(t.netProfitCents, 'profit').toBe((14354 - refunds) - (8336 - cogs) - (37 - extra));
        expect(t.adjustments).toMatchObject({ netCents: 0, salesReturnVoidGainCents: 0, residualSweepsCents: 0 });
        const idn = await shopIdentity(s);
        expect(idn.reportProfit).toBe(idn.ledgerProfit);
        await check(s);
      };
      await verify();

      // attempt in the permutation's order; a refused attempt is retried in later passes until everything is void
      let queue = [...perm];
      let sawRefusal = false;
      while (queue.length > 0) {
        const next: string[] = [];
        for (const k of queue) {
          const newer = ORDER.filter((o) => o > k && posted.has(o) && RET[o]!.lines.some((l) => RET[k]!.lines.includes(l)));
          if (newer.length === 0) {
            const r = await voidReturnNew(s, sale.id, ids[k]!);
            expect(r.status, `void ${k}`).toBe(200);
            posted.delete(k);
            await verify();
          } else {
            sawRefusal = true;
            const r = await noWrite(s, () => voidReturnNew(s, sale.id, ids[k]!));
            expect(r.status).toBe(409);
            expect(err(r), `void ${k} refused`).toMatchObject({ code: 'RETURN_NOT_NEWEST', newerReturnId: ids[newer[newer.length - 1]!] });
            next.push(k);
          }
        }
        queue = next;
      }
      if (!sawRefusal) valid += 1;
      expect(posted.size).toBe(0);
      expect(cashOf(s, 'shop')).toBe(1006018);
      expect((await shop(s, '2025-08-01', '2025-08-31')).netProfitCents).toBe(14354 - 8336 - 37 - 0 + 0 - (0)); // 5,981
    }
    expect(valid).toBe(2); // d, b, c, a and d, c, b, a only
  }, 300000);
});

// =====================================================================================================================================
// S4 - awkward rounding chains (item 2).
//   (i) Q: 9 units for 100 (one purchase), sold all 9 @17 = 153 (cogs 100). Nine returns of ONE unit each: cogs round(100/9)=round(11.11)=11 for returns 1..8 (88), the
//       ninth completes the line and takes 100-88 = 12. Refund 17 each. After k returns the pool is k units worth 11k (k<=8), 9 / 100 after the ninth.
//       Void newest-first: the ninth removes 12 -> 8/88, then 77 ... 0/0. Round two: return 4 units at once = round(100x4/9)=round(44.44)=44 (refund 68);
//       return the remaining 5 = remainder 100-44 = 56 (refund 85). Void both newest-first.
//   (ii) Hf: 2 units worth 1 cent; sold both @5 = 10 (cogs 1). Return 1: cogs round(0.5) = 1 (half away from zero) -> pool 1/1. Return the 2nd: remainder 0 -> pool 2/1.
//       Void the 2nd: removes 1 unit at min(0, 1) = 0 -> 1/1. Void the 1st: 1 unit at min(1,1) = 1 -> 0/0.
// =====================================================================================================================================
describe('S4: rounding chains', () => {
  it('nine one-unit returns of a 100-cent cost over 9 units, voided newest-first, then re-returned in two parts', async () => {
    const s = await setup();
    const Q = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-09-01', amountCents: 100000 });
    await buy(s, [{ productId: Q.id, packs: 1, packSize: 9, lineTotalCents: 100 }], { businessDate: '2025-09-01' });
    const sale = (await sellOk(s, [cl(Q.id, 9, 17)], { businessDate: '2025-09-02' })).sales[0];
    const it0 = line(sale, 0);
    expect(it0).toMatchObject({ revenueCents: 153, cogsCents: 100 });
    const ids: number[] = [];
    const cogs = [11, 11, 11, 11, 11, 11, 11, 11, 12];
    for (let k = 0; k < 9; k++) {
      const r = (await returnOk(s, sale.id, [rl(it0.id, 1, true)], { businessDate: '2025-09-03' })).item;
      expect([r.refundCents, r.cogsReversedCents], `return ${k + 1}`).toEqual([17, cogs[k]]);
      ids.push(r.id);
      expect(poolOf(s, Q.id)).toEqual({ qty: k + 1, value: cogs.slice(0, k + 1).reduce((a, b) => a + b, 0) });
      await check(s);
    }
    expect(poolOf(s, Q.id)).toEqual({ qty: 9, value: 100 });
    expect(cashOf(s, 'shop')).toBe(100000 - 100 + 153 - 153);
    for (let k = 8; k >= 0; k--) {
      await voidReturnOk(s, sale.id, ids[k]!);
      expect(poolOf(s, Q.id)).toEqual({ qty: k, value: cogs.slice(0, k).reduce((a, b) => a + b, 0) });
      await check(s);
    }
    expect(poolOf(s, Q.id)).toEqual({ qty: 0, value: 0 });
    // round two
    const p1 = (await returnOk(s, sale.id, [rl(it0.id, 4, true)], { businessDate: '2025-09-04' })).item;
    expect([p1.refundCents, p1.cogsReversedCents]).toEqual([68, 44]);
    const p2 = (await returnOk(s, sale.id, [rl(it0.id, 5, true)], { businessDate: '2025-09-05' })).item;
    expect([p2.refundCents, p2.cogsReversedCents]).toEqual([85, 56]);
    expect(poolOf(s, Q.id)).toEqual({ qty: 9, value: 100 });
    await voidReturnOk(s, sale.id, p2.id);
    expect(poolOf(s, Q.id)).toEqual({ qty: 4, value: 44 });
    await voidReturnOk(s, sale.id, p1.id);
    expect(poolOf(s, Q.id)).toEqual({ qty: 0, value: 0 });
    expect((await shop(s, '2025-09-01', '2025-09-30')).netProfitCents).toBe(153 - 100);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 53, ledgerProfit: 53 });
    await check(s);
  });

  it('half-cent: a 1-cent cost over two units rounds up on the first return (away from zero), the second takes 0; voids restore exactly', async () => {
    const s = await setup();
    const H = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-09-01', amountCents: 5000 });
    await buy(s, [{ productId: H.id, packs: 1, packSize: 2, lineTotalCents: 1 }], { businessDate: '2025-09-01' });
    const sale = (await sellOk(s, [cl(H.id, 2, 5)], { businessDate: '2025-09-02' })).sales[0];
    expect(line(sale, 0)).toMatchObject({ revenueCents: 10, cogsCents: 1 });
    const r1 = (await returnOk(s, sale.id, [rl(line(sale, 0).id, 1, true)], { businessDate: '2025-09-03' })).item;
    expect([r1.refundCents, r1.cogsReversedCents]).toEqual([5, 1]);
    expect(poolOf(s, H.id)).toEqual({ qty: 1, value: 1 });
    expect((await shop(s, '2025-09-01', '2025-09-30')).netProfitCents).toBe(5); // revenue 5, cost 0
    const r2 = (await returnOk(s, sale.id, [rl(line(sale, 0).id, 1, true)], { businessDate: '2025-09-04' })).item;
    expect([r2.refundCents, r2.cogsReversedCents]).toEqual([5, 0]);
    expect(poolOf(s, H.id)).toEqual({ qty: 2, value: 1 });
    expect((await shop(s, '2025-09-01', '2025-09-30')).netProfitCents).toBe(0);
    await check(s);
    await voidReturnOk(s, sale.id, r2.id);
    expect(poolOf(s, H.id)).toEqual({ qty: 1, value: 1 });
    expect(mvsByRef(s, 'sales_returns', r2.id).map((m) => [m.qty, m.value, m.unit])).toEqual([[1, 0, 0], [-1, 0, 0]]);
    await check(s);
    await voidReturnOk(s, sale.id, r1.id);
    expect(poolOf(s, H.id)).toEqual({ qty: 0, value: 0 });
    expect(cashOf(s, 'shop')).toBe(5000 - 1 + 10);
    expect((await shop(s, '2025-09-01', '2025-09-30')).netProfitCents).toBe(9);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 9, ledgerProfit: 9 });
    await check(s);
  });
});

// =====================================================================================================================================
// S9 - units RESOLD after the return (item 6). Everything dated 09-xx (opening 1,000,000 on 09-01).
//   Z: buy 8 units 1,603.  Sale1 (09-02) Z x5 @500 = 2,500: cogs round(1,603x5/8)=round(1,001.875)=1,002 -> pool 3/601.
//   R (09-03): Z x3 res: cogs round(1,002x3/5)=round(601.2)=601 -> pool 6/1,202; refund 1,500.
//   Sale2 (09-04) Z x5 @500: cogs round(1,202x5/6)=round(1,001.67)=1,002 -> pool 1/200.   => void R refused: onHand 1, needed 3 (nothing written).
//   W: buy 4 units 801 (09-05).  Sale3 (09-05): Z x1 @500 (cogs 200 = whole pool -> Z 0/0) + W x4 @300 = 1,200 (cogs 801 whole pool). total 1,700.
//   Rb (09-06): Z x1 + W x4 res -> Z 1/200, W 4/801; refund 500+1,200 = 1,700.
//   Sale4 (09-06): W x3 @300 = 900, cogs round(801x3/4)=round(600.75)=601 -> W 1/200.   => void Rb refused: W onHand 1 needed 4 (Z alone would be fine) - nothing written.
//   buy W 3 units 300 -> W 4/500.  void Rb: Z 1 unit at min(200,200) -> 0/0;  W 4 units at min(801, 500) = 500 -> 0/0 : void gain 801-500 = 301 (R-VR 3).
//   void R: Z onHand 0 needed 3 -> refused;  buy Z 2/400 -> onHand 2 -> refused;  buy Z 1/200 -> Z 3/600 -> void works: min(601, 600) = 600 -> 0/0; gain 1.
//   Profit: revenue 2,500+2,500+1,700+900 = 7,600; cost 1,002+1,002+(200+801)+601 = 3,606; gross 3,994; void gains 301+1 -> 4,296.
//   cash: 1,000,000 - (1,603+801+300+400+200 = 3,304) + 7,600 = 1,004,296 (returns: refunds and reversals cancel). stock 0 -> equity +4,296. ok
// =====================================================================================================================================
describe('S9: returned units that have been resold', () => {
  it('refused with exact onHand/needed while short (nothing written), allowed once restocked, gain figures exact', async () => {
    const s = await setup();
    const Z = await mk(s); const W = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-09-01', amountCents: 1000000 });
    await buy(s, [{ productId: Z.id, packs: 1, packSize: 8, lineTotalCents: 1603 }], { businessDate: '2025-09-01' });
    const sale1 = (await sellOk(s, [cl(Z.id, 5, 500)], { businessDate: '2025-09-02' })).sales[0];
    expect(line(sale1, 0).cogsCents).toBe(1002);
    expect(poolOf(s, Z.id)).toEqual({ qty: 3, value: 601 });
    const R = (await returnOk(s, sale1.id, [rl(line(sale1, 0).id, 3, true)], { businessDate: '2025-09-03' })).item;
    expect([R.refundCents, R.cogsReversedCents]).toEqual([1500, 601]);
    expect(poolOf(s, Z.id)).toEqual({ qty: 6, value: 1202 });
    const sale2 = (await sellOk(s, [cl(Z.id, 5, 500)], { businessDate: '2025-09-04' })).sales[0];
    expect(line(sale2, 0).cogsCents).toBe(1002);
    expect(poolOf(s, Z.id)).toEqual({ qty: 1, value: 200 });
    await check(s);

    const e1 = await noWrite(s, () => voidReturnNew(s, sale1.id, R.id));
    expect(e1.status).toBe(409);
    expect(err(e1)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: Z.id, onHand: 1, needed: 3 });
    expect(err(e1).message).toBe('This return cannot be voided: 3 unit(s) came back into stock but only 1 are on hand now.');

    await buy(s, [{ productId: W.id, packs: 1, packSize: 4, lineTotalCents: 801 }], { businessDate: '2025-09-05' });
    const sale3 = (await sellOk(s, [cl(Z.id, 1, 500), cl(W.id, 4, 300)], { businessDate: '2025-09-05' })).sales[0];
    expect([line(sale3, 0).cogsCents, line(sale3, 1).cogsCents]).toEqual([200, 801]);
    expect(poolOf(s, Z.id)).toEqual({ qty: 0, value: 0 });
    const Rb = (await returnOk(s, sale3.id, [rl(line(sale3, 0).id, 1, true), rl(line(sale3, 1).id, 4, true)], { businessDate: '2025-09-06' })).item;
    expect(Rb.refundCents).toBe(1700);
    const sale4 = (await sellOk(s, [cl(W.id, 3, 300)], { businessDate: '2025-09-06' })).sales[0];
    expect(line(sale4, 0).cogsCents).toBe(601);
    expect(poolOf(s, W.id)).toEqual({ qty: 1, value: 200 });
    expect(poolOf(s, Z.id)).toEqual({ qty: 1, value: 200 });
    await check(s);

    // partial availability: Z alone would be fine, W is short -> the whole void is refused and Z is untouched
    const e2 = await noWrite(s, () => voidReturnNew(s, sale3.id, Rb.id));
    expect(err(e2)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: W.id, onHand: 1, needed: 4 });
    expect(poolOf(s, Z.id)).toEqual({ qty: 1, value: 200 });

    await buy(s, [{ productId: W.id, packs: 1, packSize: 3, lineTotalCents: 300 }], { businessDate: '2025-09-06' });
    expect(poolOf(s, W.id)).toEqual({ qty: 4, value: 500 });
    await voidReturnOk(s, sale3.id, Rb.id);
    expect(poolOf(s, Z.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, W.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', Rb.id).filter((m) => m.productId === W.id).map((m) => [m.type, m.qty, m.value])).toEqual([['sale_return', 4, 801], ['sale_return', -4, -500]]);
    let t = await shop(s, '2025-09-01', '2025-09-30');
    expect(t.adjustments).toMatchObject({ salesReturnVoidGainCents: 301, residualSweepsCents: 0, netCents: -301 });
    await check(s);

    // R is still short: Z is at 0 now
    const e3 = await noWrite(s, () => voidReturnNew(s, sale1.id, R.id));
    expect(err(e3)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: Z.id, onHand: 0, needed: 3 });
    await buy(s, [{ productId: Z.id, packs: 1, packSize: 2, lineTotalCents: 400 }], { businessDate: '2025-09-07' });
    const e4 = await noWrite(s, () => voidReturnNew(s, sale1.id, R.id));
    expect(err(e4)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: Z.id, onHand: 2, needed: 3 });
    await buy(s, [{ productId: Z.id, packs: 1, packSize: 1, lineTotalCents: 200 }], { businessDate: '2025-09-07' });
    expect(poolOf(s, Z.id)).toEqual({ qty: 3, value: 600 });
    await voidReturnOk(s, sale1.id, R.id);
    expect(poolOf(s, Z.id)).toEqual({ qty: 0, value: 0 });
    t = await shop(s, '2025-09-01', '2025-09-30');
    expect(t.adjustments).toMatchObject({ salesReturnVoidGainCents: 302, residualSweepsCents: 0, netCents: -302 });
    expect(t.goods).toMatchObject({ revenueCents: 7600, costAutomaticCents: 3606, grossProfitCents: 3994 });
    expect(t.netProfitCents).toBe(4296);
    expect(cashOf(s, 'shop')).toBe(1004296);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 4296, ledgerProfit: 4296 });
    await check(s);
  });
});

// =====================================================================================================================================
// S10 - cash reversal on the Telecom book (item 8): exact amount, book, original date, link, balance before/after, warnings.
//   No opening balance. T (card, Scratch Cards): buy 4 for 2,000 (09-01) -> cash -2,000. Sale (09-02) 3 @800 = 2,400 (cogs round(2,000x3/4)=1,500) -> +400.
//   Telecom expense 3,000 (09-02) -> -2,600.  Return R (09-03, 2 cards res): refund 1,600 (cogs round(1,500x2/3)=1,000) -> -4,200  [warning balance -4,200].
//   VOID (posted later, dated 09-03): +1,600 -> -2,600 [warning: still below zero, balance -2,600].
//   ledger running balances (date, id order): -2,000 / +400 / -2,600 / -4,200 / -2,600.
//   Then void the expense -> +400; return 1 card (09-04): refund 800 -> -400 [warning]; void it -> +400 [no warning].
//   Telecom profit: revenue 2,400 - cost 1,500 - expense 3,000 = -2,100 (return voided).
// =====================================================================================================================================
describe('S10: cash reversal row and negative-cash warnings (Telecom card sales)', () => {
  it('exact row, original business date, link, balances and warnings', async () => {
    const s = await setup();
    const T = await mkT(s);
    await buy(s, [{ productId: T.id, packs: 1, packSize: 4, lineTotalCents: 2000 }], { businessDate: '2025-09-01' });
    const sale = (await sellOk(s, [cl(T.id, 3, 800)], { businessDate: '2025-09-02' })).sales[0];
    expect(sale.book).toBe('telecom');
    expect(line(sale, 0).cogsCents).toBe(1500);
    const exp = await expNew(s, { book: 'telecom', businessDate: '2025-09-02', amountCents: 3000, category: 'other', description: 'x' });
    expect(exp.status).toBe(201);
    expect(cashOf(s, 'telecom')).toBe(-2600);

    const rr = await returnNew(s, sale.id, [rl(line(sale, 0).id, 2, true)], { businessDate: '2025-09-03' });
    expect(rr.status).toBe(201);
    const R = rr.body.item;
    expect(R).toMatchObject({ refundCents: 1600, cogsReversedCents: 1000 });
    expect(rr.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', balanceCents: -4200 })]);
    expect(cashOf(s, 'telecom')).toBe(-4200);

    const before = cashOf(s, 'telecom');
    const v = await voidReturnOk(s, sale.id, R.id, 'oops');
    expect(v.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', balanceCents: -2600 })]);
    expect(cashOf(s, 'telecom')).toBe(before + 1600);
    const rows = cashOfRef(s, 'sales_returns', R.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ book: 'telecom', type: 'card_refund', amount_cents: -1600, business_date: '2025-09-03', reverses_entry_id: null });
    expect(rows[1]).toMatchObject({ book: 'telecom', type: 'card_refund', amount_cents: 1600, business_date: '2025-09-03', reverses_entry_id: rows[0]!.id });
    // posted_at of the reversal is the time of the void (not the 2025 date)
    expect(String(rows[1]!.posted_at) >= String(rows[0]!.posted_at)).toBe(true);
    expect(String(rows[1]!.posted_at).slice(0, 4)).not.toBe('2025');
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE book = 'shop'")).toBe(0);
    const led = (await get(s.app, '/cashbooks/telecom')).body;
    const items: any[] = led.items ?? led.entries ?? led.rows;
    expect(items.map((x) => [x.type, x.amountCents, x.runningBalanceCents]).slice(-5)).toEqual([
      ['purchase_payment', -2000, -2000], ['card_sale', 2400, 400], ['expense', -3000, -2600], ['card_refund', -1600, -4200], ['card_refund', 1600, -2600],
    ]);
    const clos = await check(s);
    void clos;

    // positive case: the book is back above zero after the void
    expect((await expVoid(s, exp.body.item.id)).status).toBe(200);
    expect(cashOf(s, 'telecom')).toBe(400);
    const R2 = await returnNew(s, sale.id, [rl(line(sale, 0).id, 1, true)], { businessDate: '2025-09-04' });
    expect(R2.body.item.refundCents).toBe(800);
    expect(R2.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', balanceCents: -400 })]);
    const v2 = await voidReturnOk(s, sale.id, R2.body.item.id);
    expect(v2.warnings).toEqual([]);
    expect(cashOf(s, 'telecom')).toBe(400);
    await check(s);
    const tel = (await pnl(s, 'telecom', '2025-09-01', '2025-09-30')).totals;
    expect(tel.cards).toMatchObject({ revenueCents: 2400, costAutomaticCents: 1500, grossProfitCents: 900 });
    expect(tel.netProfitCents).toBe(900); // the expense is void as well
  });
});

// =====================================================================================================================================
// S11 - purchase return interleaved with a sales-return void (item 12).
//   Opening 100,000 (10-01).  Buy 10 units for 1,000 (purchase A).  Sale (10-02) 6 @400 = 2,400, cogs round(1,000x6/10)=600 -> pool 4/400.
//   Return R (10-03) 4 res: cogs round(600x4/6)=400, refund 1,600 -> pool 8/800.  Purchase return of A: 5 units, value round(1,000x5/10)=500, removed min(500,800)=500 -> pool 3/300.
//   void R: needs 4, onHand 3 -> refused, nothing written.  Buy 1 unit for 150 -> 4/450.  void R: removes min(400,450)=400; qty reaches 0 with 50 left -> SWEEP 50 first, then 400 -> 0/0.
//   profit: revenue 2,400 - cost 600 - sweep 50 = 1,750 (purchase refund 500 = value removed 500: no gain).
//   cash: 100,000 - 1,000 + 2,400 - 1,600 + 500 - 150 + 1,600 = 101,750.  stock 0 -> +1,750. ok
//   Then: return the line again (4 units), void again (sweep case again? pool 0/0 + 4 restocked, then purchase 2 units ... keep simple): a new return R' of 2 units: cogs round(600x2/6)=200,
//   refund 800 -> pool 2/200; void R' -> 0/0 (no sweep). Final profit unchanged 1,750.
// =====================================================================================================================================
describe('S11: purchase return / purchase / sales-return void interleaved', () => {
  it('hand figures, sweep movement order, refusal in between, void then re-return then void again', async () => {
    const s = await setup();
    const G = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-10-01', amountCents: 100000 });
    const A = await buy(s, [{ productId: G.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-10-01' });
    const sale = (await sellOk(s, [cl(G.id, 6, 400)], { businessDate: '2025-10-02' })).sales[0];
    const R = (await returnOk(s, sale.id, [rl(line(sale, 0).id, 4, true)], { businessDate: '2025-10-03' })).item;
    expect([R.refundCents, R.cogsReversedCents]).toEqual([1600, 400]);
    expect(poolOf(s, G.id)).toEqual({ qty: 8, value: 800 });
    const pr = await post(s.app, `/purchases/${A.id}/returns`, { businessDate: '2025-10-04', clientRef: ref(), items: [{ purchaseItemId: A.items[0].id, units: 5 }] });
    expect(pr.status).toBe(201);
    expect(pr.body.item.refundCents).toBe(500);
    expect(poolOf(s, G.id)).toEqual({ qty: 3, value: 300 });
    await check(s);
    const e = await noWrite(s, () => voidReturnNew(s, sale.id, R.id));
    expect(err(e)).toMatchObject({ code: 'RETURN_STOCK_NOT_AVAILABLE', productId: G.id, onHand: 3, needed: 4 });
    await buy(s, [{ productId: G.id, packs: 1, packSize: 1, lineTotalCents: 150 }], { businessDate: '2025-10-05' });
    expect(poolOf(s, G.id)).toEqual({ qty: 4, value: 450 });
    await voidReturnOk(s, sale.id, R.id);
    expect(poolOf(s, G.id)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'sales_returns', R.id).map((m) => [m.type, m.qty, m.value, m.date])).toEqual([
      ['sale_return', 4, 400, '2025-10-03'], ['adjustment', 0, -50, '2025-10-03'], ['sale_return', -4, -400, '2025-10-03']]);
    let t = await shop(s, '2025-10-01', '2025-10-31');
    expect(t.adjustments).toMatchObject({ residualSweepsCents: 50, salesReturnVoidGainCents: 0, purchaseRefundGainCents: 0, netCents: 50 });
    expect(t.netProfitCents).toBe(1750);
    expect(cashOf(s, 'shop')).toBe(101750);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 1750, ledgerProfit: 1750 });
    await check(s);

    // the day rows: the sweep lands on the RETURN's date (10-03), the purchase refund gain nets to zero
    const d = await pnl(s, 'shop', '2025-10-01', '2025-10-31', 'day');
    expect(dayRow(d, '2025-10-02').netProfitCents).toBe(1800);
    expect(dayRow(d, '2025-10-03').netProfitCents).toBe(-50);
    expect(dayRow(d, '2025-10-03').adjustments.residualSweepsCents).toBe(50);

    // void -> re-return -> void again
    // line has 6 sold, 0 returned now. NOTE the pool is 0/0, so a return of 2 restocks 2/200 (round(600x2/6)=200)
    const R2 = (await returnOk(s, sale.id, [rl(line(sale, 0).id, 2, true)], { businessDate: '2025-10-06' })).item;
    expect([R2.refundCents, R2.cogsReversedCents]).toEqual([800, 200]);
    expect(poolOf(s, G.id)).toEqual({ qty: 2, value: 200 });
    await voidReturnOk(s, sale.id, R2.id);
    expect(poolOf(s, G.id)).toEqual({ qty: 0, value: 0 });
    t = await shop(s, '2025-10-01', '2025-10-31');
    expect(t.netProfitCents).toBe(1750);
    expect(cashOf(s, 'shop')).toBe(101750);
    // a repeated void of either is ALREADY_VOID and writes nothing
    for (const r of [R, R2]) {
      const x = await noWrite(s, () => voidReturnNew(s, sale.id, r.id));
      expect(err(x)).toMatchObject({ code: 'ALREADY_VOID' });
    }
    await check(s);
  });
});

// =====================================================================================================================================
// S12 - closed-day sequences (item 12, 8). Shop. Opening 100,000 (10-01); buy 5 for 2,500 (10-01) -> 97,500; sale (10-01) 3 @1,000 = 3,000 -> 100,500 (cogs round(2,500x3/5)=1,500, pool 2/1,000).
//   R1 (10-02) 2 res: refund 2,000, cogs round(1,500x2/3)=1,000, pool 4/2,000 -> cash 98,500.
//   close 10-02 (no count): expected = all entries dated <= 10-02 = 98,500.  void R1 -> 409 DAY_CLOSED (book shop, businessDate 10-02), nothing written.
//   reopen the closing; void R1 works (reversal dated 10-02): cash 100,500, pool 2/1,000.  re-close 10-02: expected = 100,500 (the closing row is closed again).
//   R2 (10-05) 1 res: refund 1,000, cogs 500; cash 99,500, pool 3/1,500. close 10-06 -> expected 99,500. void R2 -> 409 BACKDATE_BEFORE_CLOSED_DAY (closed 10-06 is later than the return's 10-05).
//   reopen 10-06 -> void R2 works: cash 100,500; re-close 10-06: expected 100,500.
//   The closing snapshot of 10-02 (taken before) is untouched (expected 100,500 for the second closing; the first closing row stays, marked reopened).
// =====================================================================================================================================
describe('S12: closed days and void of a return', () => {
  it('DAY_CLOSED and BACKDATE_BEFORE_CLOSED_DAY refuse without writing; reopen -> works; closing snapshots hand-checked', async () => {
    const s = await setup();
    const B = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-10-01', amountCents: 100000 });
    await buy(s, [{ productId: B.id, packs: 1, packSize: 5, lineTotalCents: 2500 }], { businessDate: '2025-10-01' });
    const sale = (await sellOk(s, [cl(B.id, 3, 1000)], { businessDate: '2025-10-01' })).sales[0];
    expect(cashOf(s, 'shop')).toBe(100500);
    const R1 = (await returnOk(s, sale.id, [rl(line(sale, 0).id, 2, true)], { businessDate: '2025-10-02' })).item;
    expect([R1.refundCents, R1.cogsReversedCents]).toEqual([2000, 1000]);
    expect(cashOf(s, 'shop')).toBe(98500);
    const c1 = await closeOk(s, 'shop', '2025-10-02');
    expect(c1.expectedCents).toBe(98500);
    const e = await noWrite(s, () => voidReturnNew(s, sale.id, R1.id));
    expect(e.status).toBe(409);
    expect(err(e)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: '2025-10-02' });
    expect((await reopenNew(s, c1.id, 'need to void a return')).status).toBe(200);
    await voidReturnOk(s, sale.id, R1.id);
    expect(cashOf(s, 'shop')).toBe(100500);
    expect(poolOf(s, B.id)).toEqual({ qty: 2, value: 1000 });
    const rows = cashOfRef(s, 'sales_returns', R1.id);
    expect(rows.map((r) => [r.amount_cents, r.business_date])).toEqual([[-2000, '2025-10-02'], [2000, '2025-10-02']]);
    const c2 = await closeOk(s, 'shop', '2025-10-02');
    expect(c2.expectedCents).toBe(100500);
    expect(c2.isClosed).toBe(true); // the same closing row is closed again
    await check(s);

    const R2 = (await returnOk(s, sale.id, [rl(line(sale, 0).id, 1, true)], { businessDate: '2025-10-05' })).item;
    expect([R2.refundCents, R2.cogsReversedCents]).toEqual([1000, 500]);
    expect(cashOf(s, 'shop')).toBe(99500);
    const c3 = await closeOk(s, 'shop', '2025-10-06');
    expect(c3.expectedCents).toBe(99500);
    const e2 = await noWrite(s, () => voidReturnNew(s, sale.id, R2.id));
    expect(err(e2)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book: 'shop', closedDate: '2025-10-06', businessDate: '2025-10-05' });
    expect((await reopenNew(s, c3.id, 'void the return')).status).toBe(200);
    await voidReturnOk(s, sale.id, R2.id);
    expect(cashOf(s, 'shop')).toBe(100500);
    const c4 = await closeOk(s, 'shop', '2025-10-06');
    expect(c4.expectedCents).toBe(100500);
    expect(poolOf(s, B.id)).toEqual({ qty: 2, value: 1000 });
    // a return dated on / before a closed day is refused as well (a new return cannot slip in)
    const e3 = await noWrite(s, () => returnNew(s, sale.id, [rl(line(sale, 0).id, 1, true)], { businessDate: '2025-10-04' }));
    expect(err(e3)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY' });
    await check(s);
  });
});
