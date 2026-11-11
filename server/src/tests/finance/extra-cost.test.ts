// Extra cost on a sale (BUSINESS_RULES C13) - engine + service level through the real sales / returns API on a temp database,
// every number derived BY HAND (never copied from the implementation).
// Protects: C13 (the cashier may raise the cost per unit above the automatic weighted-average cost, never lower it; the part above
// is the line's extra cost; stock still leaves at the automatic cost, so stock, movements and cash are exactly as without an extra),
// section 4 (gross profit = revenue - (automatic + extra cost)), C5/C13 (a return reverses the extra in proportion, the completing
// return takes the exact remainder, so the returns of a line add up to the line's extra with no rounding gap).
// Organised as: (1) the Rs 37.40 / 38.00 story with hand-derived figures, (2) the rounding boundary, (3) the extra split on returns
// with hand-derived cases, (4) the pure helpers against an independent BigInt model on 250+ seeded random cases.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from '../helpers/tmp.ts';
import { apiBase, mkProduct } from '../helpers/inventory.ts';
import type { ApiBase } from '../helpers/inventory.ts';
import { err, mvsByRef, poolOf, reconOk } from '../helpers/phase4.ts';
import { cashBal, cashOfRef, cl, clc, lossRows, returnOk, rl, sellNew, sellOk, stocked } from '../helpers/phase5.ts';
import { returnPortion } from '../../services/return-rules.ts';
import { extraCostFor } from '../../services/sales-common.ts';
import { AppError } from '../../lib/errors.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
/** A shop product holding `units` units worth `value` cents; minimum price 0 so no price warning is in the way. */
const pool = (s: ApiBase, units: number, value: number) => stocked(s, mkProduct, units, value, { minPriceCents: 0 });

// =============================================================================================
// The owner's example: automatic cost Rs 37.40 = 3,740 cents per unit, entered cost Rs 38.00 = 3,800.
describe('extra cost story (C13): pool 100 units / 374,000', () => {
  // Hand calculation (cents). Pool 100 units / 374,000 -> automatic average 374,000 / 100 = 3,740 (Rs 37.40).
  //  Sell 5 at price 10,000, cost left as filled in: revenue 5 x 10,000 = 50,000; COGS 374,000 x 5 / 100 = 18,700; extra 0;
  //          charged 18,700; gross profit 50,000 - 18,700 = 31,300; pool 95 / 374,000 - 18,700 = 355,300.
  it('no override: extra 0, cogs 18,700, pool 95 / 355,300 (behaviour exactly as before C13)', async () => {
    const s = await setup();
    const P = await pool(s, 100, 374000);
    const sale = (await sellOk(s, [cl(P.id, 5, 10000)])).sales[0];
    expect(sale).toMatchObject({ totalCents: 50000, cogsCents: 18700, extraCostCents: 0, chargedCostCents: 18700, grossProfitCents: 31300 });
    expect(sale.items[0]).toMatchObject({ unitCostCents: 3740, cogsCents: 18700, extraCostCents: 0, chargedCostCents: 18700 });
    expect(poolOf(s, P.id)).toEqual({ qty: 95, value: 355300 });
    await reconOk(s);
  });

  // Same sale, cost entered as Rs 38.00 = 3,800 per unit:
  //  charged = 5 x 3,800 = 19,000; automatic COGS still 18,700; extra = 19,000 - 18,700 = 300 (Rs 0.60 x 5 = Rs 3.00).
  //  Gross profit = revenue - charged = 50,000 - 19,000 = 31,000 (300 lower than without the extra).
  //  Stock removed is 18,700 -> pool 95 / 355,300 (identical to the no-override case); the cash entry is the revenue 50,000 only;
  //  one sale movement -5 units / -18,700 at unit 3,740.
  it('Rs 38.00 entered: extra 300, charged 19,000, profit 31,000; stock removed 18,700 (pool 95 / 355,300); cash and movement unchanged', async () => {
    const s = await setup();
    const P = await pool(s, 100, 374000);
    const cash0 = cashBal(s, 'shop');                                  // the purchase's cash-out is already in the book
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    expect(sale).toMatchObject({ totalCents: 50000, cogsCents: 18700, extraCostCents: 300, chargedCostCents: 19000, grossProfitCents: 31000 });
    expect(sale.items[0]).toMatchObject({ unitCostCents: 3740, cogsCents: 18700, extraCostCents: 300, chargedCostCents: 19000, revenueCents: 50000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 95, value: 355300 });
    const m = mvsByRef(s, 'sales', sale.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ type: 'sale', qty: -5, value: -18700, unit: 3740 });
    const cash = cashOfRef(s, 'sales', sale.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'sale_goods', amount_cents: 50000 });
    expect(cashBal(s, 'shop') - cash0).toBe(50000);
    // the pool is exact for the NEXT sale too: 355,300 x 5 / 95 = 18,700 -> pool 90 / 336,600
    const next = (await sellOk(s, [cl(P.id, 5, 10000)])).sales[0];
    expect(next.cogsCents).toBe(18700);
    expect(poolOf(s, P.id)).toEqual({ qty: 90, value: 336600 });
    await reconOk(s);
  });

  // The pool, the movement and the cash after an extra-cost sale are IDENTICAL to a twin sale without the override
  // (in a second, separate shop with the same purchase), so the extra never leaks into stock or cash.
  it('pool, movement and cash equal a twin sale without an override', async () => {
    const a = await setup();
    const b = await setup();
    const A = await pool(a, 100, 374000);
    const B = await pool(b, 100, 374000);
    const sa = (await sellOk(a, [clc(A.id, 5, 10000, 3800)])).sales[0];
    const sb = (await sellOk(b, [cl(B.id, 5, 10000)])).sales[0];
    expect(poolOf(a, A.id)).toEqual(poolOf(b, B.id));
    const ma = mvsByRef(a, 'sales', sa.id)[0]!;
    const mb = mvsByRef(b, 'sales', sb.id)[0]!;
    expect([ma.qty, ma.value, ma.unit]).toEqual([mb.qty, mb.value, mb.unit]);
    expect(cashBal(a, 'shop')).toBe(cashBal(b, 'shop'));
    expect(sa.items[0].cogsCents).toBe(sb.items[0].cogsCents);
    expect(sa.grossProfitCents).toBe(sb.grossProfitCents - 300);       // only the profit differs, by exactly the extra
  });

  // Entering exactly the automatic cost (3,740 x 5 = 18,700 = COGS) is allowed and means "no extra": extra 0.
  it('exactly the automatic cost: extra 0', async () => {
    const s = await setup();
    const P = await pool(s, 100, 374000);
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3740)])).sales[0];
    expect(sale).toMatchObject({ cogsCents: 18700, extraCostCents: 0, chargedCostCents: 18700, grossProfitCents: 31300 });
    expect(sale.items[0].extraCostCents).toBe(0);
  });

  // Hand calculation: 3,739 x 5 = 18,695 < 18,700 -> refused (one cent per unit lower than automatic is already too low);
  //  minimum unit cost = ceil(18,700 / 5) = 3,740. Nothing is saved.
  it('one cent per unit below the automatic cost is refused with minUnitCostCents 3,740', async () => {
    const s = await setup();
    const P = await pool(s, 100, 374000);
    const r = await sellNew(s, [clc(P.id, 5, 10000, 3739)]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('COST_BELOW_AUTOMATIC');
    expect(err(r).minUnitCostCents).toBe(3740);
    expect(poolOf(s, P.id)).toEqual({ qty: 100, value: 374000 });
  });
});

// =============================================================================================
// The rounding boundary: the check compares the WHOLE line (qty x unit cost >= COGS), not a rounded unit cost.
describe('extra cost rounding boundary (C13)', () => {
  // Hand calculation: pool 3 units / 10,000. Selling all 3 removes the whole value: COGS = 10,000 (average 3,333.33 per unit).
  //  Entered 3,333: 3 x 3,333 = 9,999 < 10,000 -> refused; minimum unit cost = ceil(10,000 / 3) = ceil(3,333.33) = 3,334.
  //  Entered 3,334: 3 x 3,334 = 10,002 >= 10,000 -> accepted; extra = 10,002 - 10,000 = 2; charged 10,002.
  it('pool 3 / 10,000, sell 3: 3,333 is refused (9,999 < 10,000), 3,334 gives extra 2', async () => {
    const s = await setup();
    const P = await pool(s, 3, 10000);
    const low = await sellNew(s, [clc(P.id, 3, 20000, 3333)]);
    expect(low.status).toBe(422);
    expect(err(low)).toMatchObject({ code: 'COST_BELOW_AUTOMATIC', minUnitCostCents: 3334 });
    expect(err(low).message).toBe('The cost cannot be lower than the automatic cost (Rs 33.34 per unit). You can only increase it.');
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 10000 });

    const sale = (await sellOk(s, [clc(P.id, 3, 20000, 3334)])).sales[0];
    expect(sale).toMatchObject({ cogsCents: 10000, extraCostCents: 2, chargedCostCents: 10002, totalCents: 60000, grossProfitCents: 49998 });
    expect(sale.items[0]).toMatchObject({ unitCostCents: 3333, cogsCents: 10000, extraCostCents: 2 });   // display snapshot stays the automatic unit
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  // Hand calculation: a purchase of 2 units worth 0 -> automatic cost 0. Entered 0: 0 x 1 = 0 >= 0 accepted, extra 0.
  it('a zero-cost product accepts cost 0 (extra 0) and any higher cost is pure extra', async () => {
    const s = await setup();
    const P = await pool(s, 2, 0);
    const a = (await sellOk(s, [clc(P.id, 1, 5000, 0)])).sales[0];
    expect(a).toMatchObject({ cogsCents: 0, extraCostCents: 0 });
    // Hand: automatic 0, entered 250 x 1 -> extra 250, charged 250, profit 5,000 - 250 = 4,750.
    const b = (await sellOk(s, [clc(P.id, 1, 5000, 250)])).sales[0];
    expect(b).toMatchObject({ cogsCents: 0, extraCostCents: 250, chargedCostCents: 250, grossProfitCents: 4750 });
  });
});

// =============================================================================================
// Returns reverse the extra cost in proportion with the C5 exact-remainder rule; stock comes back at the AUTOMATIC cost only.
describe('extra cost on returns (C5, C13)', () => {
  /** Sells all `qty` units of a fresh pool `qty` / `value` at price 1,000 with entered unit cost `unit`; returns the sale. */
  async function soldAll(qty: number, value: number, unit: number) {
    const s = await setup();
    const P = await pool(s, qty, value);
    const sale = (await sellOk(s, [clc(P.id, qty, 1000, unit)])).sales[0];
    return { s, P, sale, item: sale.items[0] };
  }

  // Hand calculation: pool 3 / 900 sold whole -> COGS 900; entered 400 x 3 = 1,200 -> extra 300. Returns of 1 + 1 + 1:
  //  extra: 300 x 1 / 3 = 100, then 100, the completing return takes 300 - 200 = 100 -> 100 / 100 / 100 (sum 300).
  it('extra 300 over 3 units: 100 / 100 / 100', async () => {
    const { s, sale, item } = await soldAll(3, 900, 400);
    expect(item).toMatchObject({ cogsCents: 900, extraCostCents: 300 });
    const parts: number[] = [];
    for (let i = 0; i < 3; i++) parts.push((await returnOk(s, sale.id, [rl(item.id, 1, true)])).item.items[0].extraCostCents);
    expect(parts).toEqual([100, 100, 100]);
  });

  // Hand calculation: pool 3 / 902 sold whole -> COGS 902; entered 334 x 3 = 1,002 -> extra 100.
  //  extra: 100 x 1 / 3 = 33.33 -> 33; 33; the completing return takes 100 - 66 = 34 -> 33 / 33 / 34 (sum 100).
  //  COGS: 902 / 3 = 300.67 -> 301; 301; completing takes 902 - 602 = 300 -> 301 / 301 / 300 (sum 902).
  it('extra 100 over 3 units: 33 / 33 / 34 (and the cost 301 / 301 / 300)', async () => {
    const { s, sale, item } = await soldAll(3, 902, 334);
    expect(item).toMatchObject({ cogsCents: 902, extraCostCents: 100 });
    const rets = [];
    for (let i = 0; i < 3; i++) rets.push((await returnOk(s, sale.id, [rl(item.id, 1, true)])).item);
    expect(rets.map((r) => r.items[0].extraCostCents)).toEqual([33, 33, 34]);
    expect(rets.map((r) => r.items[0].cogsCents)).toEqual([301, 301, 300]);
    expect(rets.map((r) => r.extraCostReversedCents)).toEqual([33, 33, 34]);
    expect(rets.map((r) => r.cogsReversedCents)).toEqual([301, 301, 300]);
  });

  // Hand calculation: pool 2 / 1,000 sold whole; entered 600 x 2 = 1,200 -> extra 200. 1 + 1: 100 and the remainder 100.
  it('extra 200 over 2 units: 100 / 100', async () => {
    const { s, sale, item } = await soldAll(2, 1000, 600);
    expect(item.extraCostCents).toBe(200);
    const a = (await returnOk(s, sale.id, [rl(item.id, 1, false)])).item;
    const b = (await returnOk(s, sale.id, [rl(item.id, 1, true)])).item;
    expect([a.extraCostReversedCents, b.extraCostReversedCents]).toEqual([100, 100]);
  });

  // Hand calculation (extra 100, COGS 902, 3 units): return of 2 first: extra 100 x 2 / 3 = 66.67 -> 67, COGS 902 x 2 / 3 = 601.33 -> 601;
  //  the final return of 1 takes the remainders: extra 100 - 67 = 33, COGS 902 - 601 = 301. Cumulative extra 67 + 33 = 100.
  it('partial (2 of 3) then final (1): 67 + 33 = 100 extra and 601 + 301 = 902 cost', async () => {
    const { s, sale, item } = await soldAll(3, 902, 334);
    const a = (await returnOk(s, sale.id, [rl(item.id, 2, true)])).item;
    expect(a.items[0]).toMatchObject({ extraCostCents: 67, cogsCents: 601, revenueCents: 2000 });
    const b = (await returnOk(s, sale.id, [rl(item.id, 1, true)])).item;
    expect(b.items[0]).toMatchObject({ extraCostCents: 33, cogsCents: 301, revenueCents: 1000 });
    expect(a.extraCostReversedCents + b.extraCostReversedCents).toBe(item.extraCostCents);
  });

  // Hand calculation: pool 100 / 374,000, sale of 5 at entered 3,800 (COGS 18,700, extra 300, revenue 50,000).
  //  Resalable return of 2: revenue 50,000 x 2 / 5 = 20,000 refund; COGS 18,700 x 2 / 5 = 7,480 restored to stock; extra 300 x 2 / 5 = 120.
  //  Stock comes back at the AUTOMATIC portion only: pool 95 + 2 = 97 / 355,300 + 7,480 = 362,780 (NOT + 7,600).
  //  Damaged return of the other 3: refund 30,000; COGS 11,220 -> ONE loss row of 11,220 (not 11,400); extra 180 only leaves cost of sales.
  it('resalable return restores stock at the automatic cost only; damaged return loses the automatic cost only; refund ignores the extra', async () => {
    const s = await setup();
    const P = await pool(s, 100, 374000);
    const cash0 = cashBal(s, 'shop');
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    const item = sale.items[0];
    const r1 = (await returnOk(s, sale.id, [rl(item.id, 2, true)])).item;
    expect(r1).toMatchObject({ refundCents: 20000, cogsReversedCents: 7480, extraCostReversedCents: 120 });
    expect(poolOf(s, P.id)).toEqual({ qty: 97, value: 362780 });
    expect(mvsByRef(s, 'sales_returns', r1.id)[0]).toMatchObject({ type: 'sale_return', qty: 2, value: 7480 });
    expect(cashOfRef(s, 'sales_returns', r1.id)[0]).toMatchObject({ type: 'sale_refund', amount_cents: -20000 });

    const r2 = (await returnOk(s, sale.id, [rl(item.id, 3, false)])).item;
    expect(r2).toMatchObject({ refundCents: 30000, cogsReversedCents: 11220, extraCostReversedCents: 180 });
    expect(r2.items[0]).toMatchObject({ cogsCents: 11220, extraCostCents: 180 });
    expect(poolOf(s, P.id)).toEqual({ qty: 97, value: 362780 });          // damaged: nothing goes back on the shelf
    expect(mvsByRef(s, 'sales_returns', r2.id)).toHaveLength(0);
    const loss = lossRows(s);
    expect(loss).toHaveLength(1);
    expect(loss[0]).toMatchObject({ source: 'damaged_return', cost_cents: 11220, qty: 3 });
    // 120 + 180 = 300 = the whole extra of the line; 7,480 + 11,220 = 18,700 = the whole automatic cost
    expect(r1.extraCostReversedCents + r2.extraCostReversedCents).toBe(300);
    expect(r1.cogsReversedCents + r2.cogsReversedCents).toBe(18700);
    expect(cashBal(s, 'shop') - cash0).toBe(50000 - 20000 - 30000);        // sale in, both refunds out: the extra changes nothing
    await reconOk(s);
  });
});

// =============================================================================================
// Pure helpers against an independent BigInt model on pseudo-random cases (C5 / C13 properties).
describe('extra cost properties on random cases', () => {
  /** Seeded generator (mulberry32): repeatable "random" numbers in [0, 1). */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Independent round(a x b / c), half up, in BigInt (non-negative operands). */
  const rdiv = (a: bigint, b: bigint, c: bigint): bigint => { const n = a * b; const q = n / c; return (n % c) * 2n >= c ? q + 1n : q; };

  // Independent model of the split, written from C5: each return takes round(total x q / qty) (never more than is left);
  // the return that brings the cumulative quantity to the whole line takes exactly what is left.
  // 300 random cases: qty 1..12, cogs 0..2,000,000, extra 0..200,000, a random split of the quantity into successive returns.
  // Properties checked: parts add up to the total EXACTLY, no part is negative, each part equals the model, for cost AND extra.
  it('300 random (qty, cogs, extra, split) cases: cumulative = line total, parts = independent model', () => {
    const r = rng(20261111);
    const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let n = 0; n < 300; n++) {
      const qty = ri(1, 12);
      const cogs = r() < 0.1 ? 0 : ri(0, 2000000);
      const extra = r() < 0.2 ? 0 : ri(0, 200000);
      const seq: number[] = [];
      let left = qty;
      while (left > 0) { const q = ri(1, left); seq.push(q); left -= q; }
      for (const total of [cogs, extra]) {
        // implementation under test
        let doneQ = 0; let doneC = 0; const got: number[] = [];
        for (const q of seq) {
          const part = returnPortion(total, q, qty, doneQ, doneC);
          got.push(part); doneQ += q; doneC += part;
        }
        // independent model
        const want: bigint[] = []; let given = 0n; let units = 0;
        for (const q of seq) {
          units += q;
          const rest = BigInt(total) - given;
          let part = units === qty ? rest : rdiv(BigInt(total), BigInt(q), BigInt(qty));
          if (part > rest) part = rest;
          given += part; want.push(part);
        }
        const ctx = `case ${n}: qty ${qty} total ${total} seq ${seq.join(',')}`;
        expect(got.map(BigInt), ctx).toEqual(want);
        expect(got.reduce((a, b) => a + b, 0), ctx).toBe(total);
        expect(Math.min(...got), ctx).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // C13 rule in BigInt: charged = qty x entered; refused iff charged < cogs; extra = charged - cogs; minUnitCostCents = ceil(cogs / qty).
  // 300 random cases around the boundary (entered = ceil(cogs/qty) + delta, delta in -2..3, never below 0).
  it('300 random cases: extraCostFor = qty x unit - cogs, refuses exactly when below, minUnitCostCents = ceil(cogs / qty)', () => {
    const r = rng(7);
    const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    let refused = 0; let accepted = 0;
    for (let n = 0; n < 300; n++) {
      const qty = ri(1, 1000);
      const cogs = r() < 0.05 ? 0 : ri(0, 5000000);
      const minUnit = (BigInt(cogs) + BigInt(qty) - 1n) / BigInt(qty);          // ceil(cogs / qty) in BigInt
      const unit = Math.max(0, Number(minUnit) + ri(-2, 3));
      const charged = BigInt(qty) * BigInt(unit);
      const ctx = `case ${n}: qty ${qty} cogs ${cogs} unit ${unit}`;
      if (charged < BigInt(cogs)) {
        refused++;
        let caught: unknown;
        try { extraCostFor(cogs, qty, unit, 'items.0.unitCostCents'); } catch (e) { caught = e; }
        expect(caught, ctx).toBeInstanceOf(AppError);
        expect((caught as AppError).code, ctx).toBe('COST_BELOW_AUTOMATIC');
        expect((caught as AppError).extra?.minUnitCostCents, ctx).toBe(Number(minUnit));
      } else {
        accepted++;
        expect(BigInt(extraCostFor(cogs, qty, unit, 'items.0.unitCostCents')), ctx).toBe(charged - BigInt(cogs));
      }
    }
    expect(refused).toBeGreaterThan(20);        // the boundary was really exercised on both sides
    expect(accepted).toBeGreaterThan(100);
  });
});
