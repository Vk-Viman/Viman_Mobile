// COGS snapshot and the C5 remainder split - engine + service level (real sales/returns API on a temp database), every number derived BY HAND.
// Protects: BUSINESS_RULES section 3 (a sale removes stock at the weighted average of the pool at that moment; the value
// removed is the sale line's COGS), C5 / R5 (the COGS is a snapshot: a LATER purchase that changes the average never changes an
// OLD sale; a partly returned line is split proportionally and the return that completes the line takes the exact remainder, so the
// returns of one line add up to the line EXACTLY), and the rounding helper (half away from zero).
// Organised as: (1) the snapshot story with hand-derived figures, (2) hand-derived C5 splits through the API,
// (3) the pure split function against an independent BigInt model on a pseudo-random table.
// NOTE on revenue: revenue = qty x unit price exactly, so a proportional revenue portion (price x q) is always whole cents and the
// revenue split never needs the remainder rule through the API; the remainder rule bites on COGS. The pure-function section (3)
// still proves the remainder rule for ANY total (e.g. 100000 over 3 units = 33333 + 33333 + 33334).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from '../helpers/tmp.ts';
import { get } from '../helpers/catalog.ts';
import { apiBase, buy, mkProduct, productOf } from '../helpers/inventory.ts';
import type { ApiBase } from '../helpers/inventory.ts';
import { poolOf, reconOk } from '../helpers/phase4.ts';
import { cashBal, cl, mdr, returnOk, rl, sellOk, splitModel, stocked, stocked20 } from '../helpers/phase5.ts';
import { returnPortion } from '../../services/return-rules.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const saleOf = async (s: ApiBase, id: number) => (await get(s.app, `/sales/${id}`)).body.item;

// =============================================================================================
// The COGS snapshot story: sales at the average, a later purchase, more sales, selling everything.
describe('COGS snapshot (section 3, C5)', () => {
  // Hand calculation (all in cents):
  //  Purchases: 10 for 300,000 and 10 for 400,000 -> pool 20 units / 700,000 (average 35,000 = Rs 350).
  //  Sale 1: 2 units at Rs 1,000 (100,000): revenue 2 x 100,000 = 200,000.
  //          COGS = 700,000 x 2 / 20 = 70,000; unit cost snapshot 70,000 / 2 = 35,000; pool 18 / 630,000.
  //          Gross profit = 200,000 - 70,000 = 130,000. Shop cash +200,000.
  //  Purchase 3: 5 units for 210,000 (Rs 420 each) -> pool 23 / 840,000, average 840,000 / 23 = 36,521.74 (Rs 365.2174).
  //          Sale 1 must NOT change (cogs 70,000, unit cost 35,000, profit 130,000).
  //  Sale 2: 3 units at Rs 500 (50,000): revenue 150,000; COGS = 840,000 x 3 / 23 = 109,565.217 -> 109,565;
  //          unit cost snapshot 109,565 / 3 = 36,521.67 -> 36,522; pool 20 / 730,435; profit 150,000 - 109,565 = 40,435.
  //  Sale 3: all 20 remaining at Rs 1,000: revenue 2,000,000; COGS = the WHOLE value 730,435 (no rounding residue); pool 0 / 0;
  //          unit cost 730,435 / 20 = 36,521.75 -> 36,522; profit 1,269,565.
  it('sale at the average, later purchase changes the average, earlier sale unchanged; selling everything takes the whole value', async () => {
    const s = await setup();
    const P = await stocked20(s, mkProduct, { name: 'Snapshot' });
    expect(poolOf(s, P.id)).toEqual({ qty: 20, value: 700000 });

    const sale1 = (await sellOk(s, [cl(P.id, 2, 100000)])).sales[0];
    expect(sale1).toMatchObject({ totalCents: 200000, cogsCents: 70000, grossProfitCents: 130000, book: 'shop', status: 'posted' });
    expect(sale1.items[0]).toMatchObject({ qty: 2, unitPriceCents: 100000, revenueCents: 200000, cogsCents: 70000, unitCostCents: 35000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 18, value: 630000 });
    await reconOk(s);

    await buy(s, [{ productId: P.id, packs: 1, packSize: 5, lineTotalCents: 210000 }]);
    expect(poolOf(s, P.id)).toEqual({ qty: 23, value: 840000 });
    expect((await productOf(s, P.id)).avgUnitCostCents).toBe(36522);        // 36,521.74 rounded
    const again = await saleOf(s, sale1.id);
    expect(again.cogsCents).toBe(70000);
    expect(again.grossProfitCents).toBe(130000);
    expect(again.items[0]).toMatchObject({ cogsCents: 70000, unitCostCents: 35000, revenueCents: 200000 });

    const sale2 = (await sellOk(s, [cl(P.id, 3, 50000)])).sales[0];
    expect(sale2).toMatchObject({ totalCents: 150000, cogsCents: 109565, grossProfitCents: 40435 });
    expect(sale2.items[0]).toMatchObject({ unitCostCents: 36522, cogsCents: 109565 });
    expect(Number(mdr(840000n, 3n, 23n))).toBe(109565);                      // independent BigInt check of the hand figure
    expect(poolOf(s, P.id)).toEqual({ qty: 20, value: 730435 });
    expect((await saleOf(s, sale1.id)).cogsCents).toBe(70000);               // still unchanged

    const sale3 = (await sellOk(s, [cl(P.id, 20, 100000)])).sales[0];
    expect(sale3).toMatchObject({ totalCents: 2000000, cogsCents: 730435, grossProfitCents: 1269565 });
    expect(sale3.items[0].unitCostCents).toBe(36522);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    // total value that left stock over the three sales = everything bought: 700,000 + 210,000
    expect(sale1.cogsCents + sale2.cogsCents + sale3.cogsCents).toBe(910000);
    // the three sales are stored with their own frozen figures
    expect((await saleOf(s, sale1.id)).cogsCents).toBe(70000);
    expect((await saleOf(s, sale2.id)).cogsCents).toBe(109565);
    await reconOk(s);
  });

  // Hand calculation: 4 units x 30,000 = 120,000 cash in. Only the CHANGE of the shop balance is asserted (purchases also
  // move cash), and it must not depend on the cost (pool 10 / 100,000).
  it('the sale cash entry is the revenue (cash in), independent of cost', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 10, 100000);
    const before = cashBal(s, 'shop');
    await sellOk(s, [cl(P.id, 4, 30000)]);
    expect(cashBal(s, 'shop') - before).toBe(120000);                         // 4 x 30,000
  });

  // A product with value 0 (e.g. a free gift) sells with COGS 0; the line still stores its snapshot of 0.
  // Hand calculation: pool 5 units / 0 -> any sale removes 0.
  it('zero-value pool: COGS 0, unit cost 0, profit = revenue', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 5, 0);
    const sale = (await sellOk(s, [cl(P.id, 2, 10000)])).sales[0];
    expect(sale).toMatchObject({ totalCents: 20000, cogsCents: 0, grossProfitCents: 20000 });
    expect(sale.items[0]).toMatchObject({ cogsCents: 0, unitCostCents: 0 });
  });

  // Rounding half away from zero: pool 4 / 10 cents, sell 1: 10 x 1 / 4 = 2.5 -> 3 (not 2). Then pool 3 / 7: 7 / 3 = 2.33 -> 2;
  // pool 2 / 5: 5 x 1 / 2 = 2.5 -> 3; pool 1 / 2: whole value 2.
  it('rounding: 2.5 rounds UP to 3; the last unit takes whatever is left (no residue)', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 4, 10);
    const cogs: number[] = [];
    for (let i = 0; i < 4; i++) cogs.push((await sellOk(s, [cl(P.id, 1, 100)])).sales[0].cogsCents);
    expect(cogs).toEqual([3, 2, 3, 2]);
    expect(cogs.reduce((a, b) => a + b, 0)).toBe(10);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
  });
});

// =============================================================================================
// C5 through the API: successive returns of ONE line. Each case: pool of `qty` units worth `cogs` is sold whole (COGS = cogs),
// then returned in the given pieces (all resalable). Expected parts are derived by hand in the table comments.
describe('C5 remainder split through the API', () => {
  // Hand calculation, revenue 100,002 over 3 units (price 33,334) and COGS 70,000 (pool 3 / 70,000, whole value):
  //   revenue: 33,334 + 33,334 + 33,334 = 100,002 (price x 1 each time).
  //   COGS: 70,000 x 1 / 3 = 23,333.33 -> 23,333; second 23,333; the LAST return takes the rest 70,000 - 46,666 = 23,334.
  it('qty 3, revenue 100002, COGS 70000, returned 1,1,1 -> revenue 33334 x3, COGS 23333 / 23333 / 23334', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 3, 70000);
    const sale = (await sellOk(s, [cl(P.id, 3, 33334)])).sales[0];
    expect(sale.items[0]).toMatchObject({ revenueCents: 100002, cogsCents: 70000 });
    const item = sale.items[0].id;
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push((await returnOk(s, sale.id, [rl(item, 1, true)])).item.items[0]);
    expect(parts.map((p) => p.revenueCents)).toEqual([33334, 33334, 33334]);
    expect(parts.map((p) => p.cogsCents)).toEqual([23333, 23333, 23334]);
    const final = await saleOf(s, sale.id);
    expect(final.items[0].returnedQty).toBe(3);
    expect(final.returns.reduce((a: number, r: any) => a + r.refundCents, 0)).toBe(100002);
    expect(final.returns.reduce((a: number, r: any) => a + r.cogsReversedCents, 0)).toBe(70000);
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 70000 });               // all the cost came back
    await reconOk(s);
  });

  // Hand calculation: pool 3 / 100 (cost Rs 1.00 over 3 units): 100 x 1 / 3 = 33.33 -> 33; 33; last = 100 - 66 = 34.
  // Revenue price 33,333 x 3 = 99,999 (each return 33,333).
  it('qty 3, COGS 100, returned 1,1,1 -> 33 / 33 / 34 (revenue 99999 = 33333 x3 stays exact)', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 3, 100);
    const sale = (await sellOk(s, [cl(P.id, 3, 33333)])).sales[0];
    const item = sale.items[0].id;
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push((await returnOk(s, sale.id, [rl(item, 1, true)])).item.items[0]);
    expect(parts.map((p) => p.cogsCents)).toEqual([33, 33, 34]);
    expect(parts.map((p) => p.revenueCents)).toEqual([33333, 33333, 33333]);
  });

  // table: [qty, cogs, return pieces, expected COGS parts] - every row derived by hand:
  //  A  5 / 1001, [2,3]:   1001 x 2 / 5 = 400.4 -> 400;  final takes 1001 - 400 = 601.
  //  B  5 / 1001, [3,2]:   1001 x 3 / 5 = 600.6 -> 601;  final takes 1001 - 601 = 400.
  //  C  5 / 1001, 1 x 5:   1001 / 5 = 200.2 -> 200 four times (800); final takes 201.
  //  D  5 / 1001, [5]:     the whole line at once takes everything: 1001.
  //  E  7 / 100, 1 x 7:    100 / 7 = 14.29 -> 14 six times (84); final takes 16.
  //  F  3 / 2, 1,1,1:      2 / 3 = 0.67 -> 1 (left 1); second 1 (left 0); the final return takes what is left: 0 -> [1,1,0].
  //  G  3 / 1, 1,1,1:      1 / 3 = 0.33 -> 0; 0; final takes 1 -> [0,0,1].
  //  H  2 / 1, 1,1:        1 x 1 / 2 = 0.5 -> 1 (half rounds away from zero); final takes 0 -> [1,0].
  //  I  4 / 10, 1,1,1,1:   10 / 4 = 2.5 -> 3; 3; 3 (left 1); final takes 1 -> [3,3,3,1].
  //  J  4 / 10, [2,2]:     10 x 2 / 4 = 5; final takes 5 -> [5,5].
  const CASES: Array<[string, number, number, number[], number[]]> = [
    ['A', 5, 1001, [2, 3], [400, 601]],
    ['B', 5, 1001, [3, 2], [601, 400]],
    ['C', 5, 1001, [1, 1, 1, 1, 1], [200, 200, 200, 200, 201]],
    ['D', 5, 1001, [5], [1001]],
    ['E', 7, 100, [1, 1, 1, 1, 1, 1, 1], [14, 14, 14, 14, 14, 14, 16]],
    ['F', 3, 2, [1, 1, 1], [1, 1, 0]],
    ['G', 3, 1, [1, 1, 1], [0, 0, 1]],
    ['H', 2, 1, [1, 1], [1, 0]],
    ['I', 4, 10, [1, 1, 1, 1], [3, 3, 3, 1]],
    ['J', 4, 10, [2, 2], [5, 5]],
  ];
  it.each(CASES)('case %s: qty %i, COGS %i, returns %j -> hand-derived COGS parts %j; sum equals the line', async (_n, qty, cogs, seq, expected) => {
    const s = await setup();
    const P = await stocked(s, mkProduct, qty, cogs);
    const sale = (await sellOk(s, [cl(P.id, qty, 1000)])).sales[0];
    expect(sale.items[0].cogsCents).toBe(cogs);
    const item = sale.items[0].id;
    const got: number[] = [];
    let cumulative = 0;
    for (const q of seq) {
      const r = (await returnOk(s, sale.id, [rl(item, q, true)])).item;
      got.push(r.items[0].cogsCents);
      cumulative += r.items[0].cogsCents;
      expect(r.cogsReversedCents).toBe(r.items[0].cogsCents);
      expect(r.items[0].revenueCents).toBe(q * 1000);                          // exact: price x q
    }
    expect(got).toEqual(expected);
    expect(got).toEqual(splitModel(cogs, qty, seq));                            // independent BigInt model agrees
    expect(cumulative).toBe(cogs);                                              // the pieces add up to the line EXACTLY
    expect(poolOf(s, P.id)).toEqual({ qty, value: cogs });                      // everything came back to the pool
    await reconOk(s);
  });

  // Same split, but the pieces go to the damaged-return write-off (cost = COGS portion) instead of the shelf.
  // Hand calculation (case A): 400 + 601 = 1,001 = the whole cost written off; pool stays empty (0 / 0).
  it('damaged pieces: the loss rows carry the same C5 portions and add up to the line cost', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 5, 1001);
    const sale = (await sellOk(s, [cl(P.id, 5, 1000)])).sales[0];
    const item = sale.items[0].id;
    await returnOk(s, sale.id, [rl(item, 2, false)]);
    await returnOk(s, sale.id, [rl(item, 3, false)]);
    const losses = (await get(s.app, '/stock-losses')).body.items.filter((l: any) => l.source === 'damaged_return');
    expect(losses.map((l: any) => l.costCents).sort((a: number, b: number) => a - b)).toEqual([400, 601]);
    expect(losses.reduce((a: number, l: any) => a + l.costCents, 0)).toBe(1001);
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
  });

  // Mixed: first piece resalable, last piece damaged. 1001 x 2 / 5 -> 400 back on the shelf (pool 2 / 400); the final 3 units take
  // the remainder 601 and are written off.
  it('resalable then damaged in successive returns: shelf gets 400, write-off takes the remainder 601', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 5, 1001);
    const sale = (await sellOk(s, [cl(P.id, 5, 1000)])).sales[0];
    const item = sale.items[0].id;
    await returnOk(s, sale.id, [rl(item, 2, true)]);
    expect(poolOf(s, P.id)).toEqual({ qty: 2, value: 400 });
    const r2 = (await returnOk(s, sale.id, [rl(item, 3, false)])).item;
    expect(r2.items[0]).toMatchObject({ cogsCents: 601, revenueCents: 3000, resalable: false });
    expect(poolOf(s, P.id)).toEqual({ qty: 2, value: 400 });
    await reconOk(s);
  });

  // The two lines of one return are split independently, each against its own line.
  it('a return with two lines splits each line on its own', async () => {
    const s = await setup();
    const A = await stocked(s, mkProduct, 3, 100);
    const B = await stocked(s, mkProduct, 4, 10);
    const sale = (await sellOk(s, [cl(A.id, 3, 500), cl(B.id, 4, 700)])).sales[0];
    const [la, lb] = sale.items;
    await returnOk(s, sale.id, [rl(la.id, 1, true), rl(lb.id, 1, true)]);
    const r = (await returnOk(s, sale.id, [rl(la.id, 2, true), rl(lb.id, 3, true)])).item;
    // A: first 100 x 1 / 3 = 33, last takes 67.   B: first 10 x 1 / 4 = 2.5 -> 3, last takes 7.
    expect(r.items.map((i: any) => i.cogsCents)).toEqual([67, 7]);
    expect(r.cogsReversedCents).toBe(74);
    expect(r.refundCents).toBe(2 * 500 + 3 * 700);
  });
});

// =============================================================================================
// The pure split function (services/return-rules.ts) against an independent BigInt model.
describe('returnPortion vs independent BigInt model', () => {
  // Hand: 100,000 over 3 units -> 33,333 + 33,333 + 33,334 (the remainder rule on ANY total).
  it('100000 over 3 units returned 1,1,1 = 33333 + 33333 + 33334', () => {
    const parts: number[] = [];
    let units = 0; let given = 0;
    for (let i = 0; i < 3; i++) {
      const p = returnPortion(100000, 1, 3, units, given);
      parts.push(p); units += 1; given += p;
    }
    expect(parts).toEqual([33333, 33333, 33334]);
    expect(splitModel(100000, 3, [1, 1, 1])).toEqual([33333, 33333, 33334]);
  });

  // Seeded pseudo-random table: 400 (qty, total, split) cases. Whatever the numbers, the pieces add up to the line EXACTLY,
  // never go negative, and equal the independent BigInt model.
  it('400 pseudo-random lines: pieces equal the model, are never negative and sum to the total', () => {
    let seed = 20260101;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let n = 0; n < 400; n++) {
      const qty = 1 + Math.floor(rnd() * 12);
      const total = Math.floor(rnd() * 3000000);
      const seq: number[] = [];
      let left = qty;
      while (left > 0) { const q = 1 + Math.floor(rnd() * left); seq.push(q); left -= q; }
      const model = splitModel(total, qty, seq);
      const got: number[] = [];
      let units = 0; let given = 0;
      for (const q of seq) {
        const p = returnPortion(total, q, qty, units, given);
        got.push(p); units += q; given += p;
      }
      expect(got, `qty ${qty} total ${total} seq ${seq}`).toEqual(model);
      expect(got.every((x) => x >= 0)).toBe(true);
      expect(got.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('the model itself: independent hand checks', () => {
    expect(splitModel(70000, 3, [1, 1, 1])).toEqual([23333, 23333, 23334]);
    expect(splitModel(1001, 5, [2, 3])).toEqual([400, 601]);
    expect(splitModel(10, 4, [1, 1, 1, 1])).toEqual([3, 3, 3, 1]);
    expect(splitModel(1, 2, [1, 1])).toEqual([1, 0]);
  });
});
