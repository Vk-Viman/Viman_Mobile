// Editable sale cost / extra cost (BUSINESS_RULES C13) - API level (Fastify inject, real temp database).
// Protects: C13 (the cashier may raise a line's cost per unit above the automatic weighted-average cost, never lower it; the part above is the
// line's extra cost; stock, movements and cash are exactly as without it), section 4 (gross profit = revenue - charged cost), C5 (returns
// reverse the extra in proportion; resalable returns restock at the automatic cost, damaged returns lose the automatic cost only; the refund
// is the revenue only), C6 (a void removes the sale including its extra), R13 (PRICE_BELOW_COST still compares with the AUTOMATIC cost),
// R-RD / R-FD (return date rules unchanged), section 12 (idempotent clientRef; the audit rows carry the extra fields) and atomicity (a refused
// cost saves NOTHING, even for the other lines / the other book of the same cart).
// Organised as: validation (below-automatic 422, type checks 400), carts (mixed, repeated product, telecom card), idempotency and response shape,
// GET /sales totals, R13 warnings, returns, voids, audit, reconciliation after every step.
// All money is in cents; every expected figure has its hand calculation in the comment above the test.
// Common fixture: product with 100 units / 374,000 (automatic cost 3,740 = Rs 37.40 per unit).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, get } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct, mkTelecom, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, mvsByRef, num, poolOf, productsSnap, reconOk } from './helpers/phase4.ts';
import {
  cashBal, cashOfRef, cl, clc, lossRows, returnNew, returnOk, rl, sellNew, sellOk, SALE_ITEM_KEYS, SALE_KEYS, SALE_TOTALS_KEYS, snap5, stocked,
  voidSaleNew,
} from './helpers/phase5.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });
/** Shop product holding 100 units worth 374,000 (automatic cost 3,740 per unit). */
const p100 = async (s: ApiBase) => stocked(s, shop0, 100, 374000);
const MSG_3740 = 'The cost cannot be lower than the automatic cost (Rs 37.40 per unit). You can only increase it.';

// =============================================================================================
// Validation: below the automatic cost is refused (422) and saves nothing; wrong types are 400 (no coercion).
describe('POST /sales - cost validation (C13)', () => {
  // Hand calculation: 5 units at the average: COGS = 374,000 x 5 / 100 = 18,700 -> minimum unit cost ceil(18,700 / 5) = 3,740.
  //  Entered 3,739: 5 x 3,739 = 18,695 < 18,700 -> refused. Nothing may be saved: no sale, line, movement, cash entry or audit row.
  it('below the automatic cost: 422 COST_BELOW_AUTOMATIC with the exact message, field, minUnitCostCents; nothing saved', async () => {
    const s = await setup();
    const P = await p100(s);
    const before = snap5(s);
    const stockBefore = productsSnap(s);
    const r = await sellNew(s, [clc(P.id, 5, 10000, 3739)]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('COST_BELOW_AUTOMATIC');
    expect(err(r).message).toBe(MSG_3740);
    expect(err(r).fields).toEqual({ 'items.0.unitCostCents': MSG_3740 });
    expect(err(r).minUnitCostCents).toBe(3740);
    expect(snap5(s)).toEqual(before);                                  // sales, lines, movements, cash, audit: all unchanged
    expect(productsSnap(s)).toBe(stockBefore);
    expect(poolOf(s, P.id)).toEqual({ qty: 100, value: 374000 });
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(0);
    await reconOk(s);
  });

  // Hand calculation: cost 0 on a product that costs 3,740 is also "lower"; a product with automatic cost 0 accepts 0.
  it('unitCostCents 0 is refused when the automatic cost is above 0 (min 3,740)', async () => {
    const s = await setup();
    const P = await p100(s);
    const r = await sellNew(s, [clc(P.id, 5, 10000, 0)]);
    expect(r.status).toBe(422);
    expect(err(r)).toMatchObject({ code: 'COST_BELOW_AUTOMATIC', minUnitCostCents: 3740 });
  });

  // Hand calculation: 7 units: COGS 374,000 x 7 / 100 = 26,180 -> 26,180 / 7 = 3,740 exactly -> min 3,740, message Rs 37.40.
  //  Cart line index is reported in the field name: the bad line is index 1 here.
  it('the field name carries the cart position of the bad line (items.1.unitCostCents)', async () => {
    const s = await setup();
    const P = await p100(s);
    const Q = await stocked(s, shop0, 10, 50000);              // automatic 5,000
    const r = await sellNew(s, [clc(P.id, 7, 10000, 3740), clc(Q.id, 2, 10000, 4999)]);
    expect(r.status).toBe(422);
    expect(Object.keys(err(r).fields)).toEqual(['items.1.unitCostCents']);
    expect(err(r).message).toBe('The cost cannot be lower than the automatic cost (Rs 50.00 per unit). You can only increase it.');
    expect(err(r).minUnitCostCents).toBe(5000);
  });

  // The JSON schema never coerces: a float, null, negative, text, boolean, array and an over-limit number are all 400 VALIDATION_ERROR on the line field,
  // and nothing is saved. 999,999,999 is the largest allowed value (the same ceiling as the unit price).
  it('3800.5 / null / -1 / "3800" / true / [] / 1000000000 -> 400 VALIDATION_ERROR, nothing saved', async () => {
    const s = await setup();
    const P = await p100(s);
    const before = snap5(s);
    for (const bad of [3800.5, null, -1, '3800', true, [], {}, 1000000000]) {
      const r = await sellNew(s, [clc(P.id, 5, 10000, bad)]);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(err(r).code, JSON.stringify(bad)).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields).join(), JSON.stringify(bad)).toMatch(/items\.0\.unitCostCents/);
    }
    expect(snap5(s)).toEqual(before);
    await reconOk(s);
  });

  // Hand calculation: 1 unit at the average 3,740; entered 999,999,999 (the maximum) -> extra = 999,999,999 - 3,740 = 999,996,259.
  it('the maximum allowed unit cost 999,999,999 is accepted: extra 999,996,259', async () => {
    const s = await setup();
    const P = await p100(s);
    const sale = (await sellOk(s, [clc(P.id, 1, 1000, 999999999)])).sales[0];
    expect(sale).toMatchObject({ cogsCents: 3740, extraCostCents: 999996259, chargedCostCents: 999999999, grossProfitCents: 1000 - 999999999 });
    expect(poolOf(s, P.id)).toEqual({ qty: 99, value: 370260 });
    await reconOk(s);
  });
});

// =============================================================================================
// Carts: a refusal rolls back the whole cart; the same product on several lines; a telecom card.
describe('POST /sales - carts with an extra cost (C13)', () => {
  // Hand calculation: shop product A 100 / 374,000 and telecom card T 10 / 5,000 (automatic 500).
  //  Cart: A 5 @ 10,000 entered 3,800 (valid, extra 300) + T 2 @ 700 entered 499 (2 x 499 = 998 < COGS 1,000 -> refused, min 500).
  //  The shop sale is written first, so the rollback must undo the shop sale, its movement, its cash and the telecom lines: all pools unchanged.
  //  Then the corrected cart (T entered 600: charged 1,200, extra 200) saves both books.
  it('mixed cart: one valid override, the other line below -> whole cart rolled back (both books); corrected cart saves both', async () => {
    const s = await setup();
    const A = await p100(s);
    const T = await stocked(s, tel0, 10, 5000);
    const before = snap5(s);
    const cash0 = { shop: cashBal(s, 'shop'), telecom: cashBal(s, 'telecom') };
    const bad = await sellNew(s, [clc(A.id, 5, 10000, 3800), clc(T.id, 2, 700, 499)]);
    expect(bad.status).toBe(422);
    expect(Object.keys(err(bad).fields)).toEqual(['items.1.unitCostCents']);
    expect(err(bad).minUnitCostCents).toBe(500);
    expect(snap5(s)).toEqual(before);
    expect(poolOf(s, A.id)).toEqual({ qty: 100, value: 374000 });
    expect(poolOf(s, T.id)).toEqual({ qty: 10, value: 5000 });
    expect({ shop: cashBal(s, 'shop'), telecom: cashBal(s, 'telecom') }).toEqual(cash0);
    await reconOk(s);

    const ok = await sellOk(s, [clc(A.id, 5, 10000, 3800), clc(T.id, 2, 700, 600)]);
    expect(ok.sales.map((x: any) => [x.book, x.extraCostCents, x.chargedCostCents])).toEqual([['shop', 300, 19000], ['telecom', 200, 1200]]);
    expect(poolOf(s, A.id)).toEqual({ qty: 95, value: 355300 });
    expect(poolOf(s, T.id)).toEqual({ qty: 8, value: 4000 });
    await reconOk(s);
  });

  // Hand calculation: pool 100 / 374,000. Line 0: 5 @ entered 3,800 -> COGS 18,700, extra 300; pool 95 / 355,300.
  //  Line 1 (same product): average now 355,300 / 95 = 3,740 -> COGS 18,700; entered 3,741: 5 x 3,741 = 18,705 -> extra 5; pool 90 / 336,600.
  //  Line 2 (same product): COGS 336,600 x 5 / 90 = 18,700, no override -> extra 0; pool 85 / 317,900.   Sale extra 300 + 5 + 0 = 305; charged 56,100 + 305 = 56,405.
  it('the same product on three lines with different cost entries: each line is judged against the live pool; extras 300 / 5 / 0', async () => {
    const s = await setup();
    const P = await p100(s);
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800), clc(P.id, 5, 10000, 3741), cl(P.id, 5, 10000)])).sales[0];
    expect(sale.items.map((i: any) => [i.cogsCents, i.extraCostCents, i.chargedCostCents])).toEqual([[18700, 300, 19000], [18700, 5, 18705], [18700, 0, 18700]]);
    expect(sale).toMatchObject({ totalCents: 150000, cogsCents: 56100, extraCostCents: 305, chargedCostCents: 56405, grossProfitCents: 150000 - 56405 });
    expect(poolOf(s, P.id)).toEqual({ qty: 85, value: 317900 });
    await reconOk(s);
  });

  // Same product, line 1 entered 3,739 (5 x 3,739 = 18,695 < 18,700 because the SECOND line's own automatic cost is 18,700):
  // refused although line 0 was valid; nothing saved.
  it('same product: a below-cost second line refuses the whole cart (field items.1.unitCostCents), pool unchanged', async () => {
    const s = await setup();
    const P = await p100(s);
    const before = snap5(s);
    const r = await sellNew(s, [clc(P.id, 5, 10000, 3800), clc(P.id, 5, 10000, 3739)]);
    expect(r.status).toBe(422);
    expect(Object.keys(err(r).fields)).toEqual(['items.1.unitCostCents']);
    expect(err(r).minUnitCostCents).toBe(3740);
    expect(snap5(s)).toEqual(before);
    expect(poolOf(s, P.id)).toEqual({ qty: 100, value: 374000 });
  });

  // Hand calculation (telecom scratch card): pool 10 / 5,000 (average 500). Sell 4 @ 700 entered 520:
  //  revenue 2,800; COGS 5,000 x 4 / 10 = 2,000; charged 4 x 520 = 2,080; extra 80; profit 2,800 - 2,080 = 720; pool 6 / 3,000.
  //  Cash: one card_sale +2,800 in the telecom book (the extra moves no cash).
  it('override on a Telecom card: extra 80, profit 720, pool 6 / 3,000, cash card_sale +2,800', async () => {
    const s = await setup();
    const T = await stocked(s, tel0, 10, 5000);
    const cash0 = cashBal(s, 'telecom');
    const sale = (await sellOk(s, [clc(T.id, 4, 700, 520)])).sales[0];
    expect(sale).toMatchObject({ book: 'telecom', totalCents: 2800, cogsCents: 2000, extraCostCents: 80, chargedCostCents: 2080, grossProfitCents: 720 });
    expect(sale.items[0]).toMatchObject({ lineType: 'card', unitCostCents: 500, extraCostCents: 80, chargedCostCents: 2080 });
    expect(poolOf(s, T.id)).toEqual({ qty: 6, value: 3000 });
    expect(cashBal(s, 'telecom') - cash0).toBe(2800);
    expect(cashOfRef(s, 'sales', sale.id).map((c) => [c.type, c.amount_cents])).toEqual([['card_sale', 2800]]);
    await reconOk(s);
  });

  // Hand calculation: the pool and ledger after a sale with extra cost equal those of a sale without (see finance/extra-cost.test.ts); here
  // reconciliation is checked after each step of a longer story: sale with extra, return, void of another sale with extra.
  it('stock reconciliation stays ok after every step of a story with extras', async () => {
    const s = await setup();
    const P = await p100(s);
    const a = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    await reconOk(s);
    const b = (await sellOk(s, [clc(P.id, 5, 10000, 4000)])).sales[0];
    await reconOk(s);
    await returnOk(s, a.id, [rl(a.items[0].id, 2, true)]);
    await reconOk(s);
    await returnOk(s, a.id, [rl(a.items[0].id, 3, false)]);
    await reconOk(s);
    expect((await voidSaleNew(s, b.id)).status).toBe(200);
    await reconOk(s);
    // pool: 100/374,000 - 18,700 (a) - 18,700 (b) + 7,480 (resalable 2 of a) + 18,700 (b void) = 97 units / 362,780
    expect(poolOf(s, P.id)).toEqual({ qty: 97, value: 362780 });
  });
});

// =============================================================================================
// Idempotency and the shape of the response.
describe('POST /sales - idempotency and response shape (C13)', () => {
  // The repeat of a saved cart returns the SAME sales (extra included) with 200 and writes nothing; even a repeat whose cost would now be
  // refused returns the saved sale (idempotency is checked first).
  it('same clientRef: 200 and an identical sale with the same extra; nothing written; a now-invalid cost in the repeat does not matter', async () => {
    const s = await setup();
    const P = await p100(s);
    const first = await sellNew(s, [clc(P.id, 5, 10000, 3800)], { clientRef: 'extra-cost-ref-1' });
    expect(first.status).toBe(201);
    const after1 = snap5(s);
    const again = await sellNew(s, [clc(P.id, 5, 10000, 3800)], { clientRef: 'extra-cost-ref-1' });
    expect(again.status).toBe(200);
    expect(again.body.sales).toEqual(first.body.sales);
    expect(again.body.sales[0].extraCostCents).toBe(300);
    const different = await sellNew(s, [clc(P.id, 5, 10000, 1)], { clientRef: 'extra-cost-ref-1' });
    expect(different.status).toBe(200);
    expect(different.body.sales[0].extraCostCents).toBe(300);
    expect(snap5(s)).toEqual(after1);
    expect(poolOf(s, P.id)).toEqual({ qty: 95, value: 355300 });
  });

  // Hand calculation: 5 @ 10,000 = 50,000; COGS 18,700; extra 300 -> charged 19,000; profit 50,000 - 19,000 = 31,000 (and the same on GET).
  it('response and GET /sales/:id: exact keys incl. extraCostCents / chargedCostCents; grossProfit = total - charged; unitCostCents stays automatic', async () => {
    const s = await setup();
    const P = await p100(s);
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    expect(Object.keys(sale).sort()).toEqual(SALE_KEYS);
    expect(Object.keys(sale.items[0]).sort()).toEqual(SALE_ITEM_KEYS);
    expect(sale).toMatchObject({ extraCostCents: 300, chargedCostCents: 19000, cogsCents: 18700, grossProfitCents: 31000 });
    expect(sale.grossProfitCents).toBe(sale.totalCents - sale.chargedCostCents);
    expect(sale.items[0].unitCostCents).toBe(3740);                    // the display snapshot is the AUTOMATIC unit cost, not 3,800
    const got = (await get(s.app, `/sales/${sale.id}`)).body.item;
    expect(got).toEqual(sale);
  });

  // A sale without an override still carries the new fields, with extra 0 (default behaviour unchanged).
  it('no override: extraCostCents 0 and chargedCostCents = cogsCents on the sale and on every line', async () => {
    const s = await setup();
    const P = await p100(s);
    const sale = (await sellOk(s, [cl(P.id, 5, 10000)])).sales[0];
    expect(sale).toMatchObject({ extraCostCents: 0, chargedCostCents: 18700, grossProfitCents: 31300 });
    expect(sale.items[0]).toMatchObject({ extraCostCents: 0, chargedCostCents: 18700 });
  });
});

// =============================================================================================
// GET /sales totals: extraCostCents and costCents (= automatic + extra) over POSTED sales only.
describe('GET /sales totals (C13)', () => {
  // Hand calculation (posted sales only):
  //  s1 shop 5 @ 10,000, entered 3,800: revenue 50,000, COGS 18,700, extra 300.
  //  s2 telecom card 4 @ 700, entered 520 (pool 10 / 5,000): revenue 2,800, COGS 2,000, extra 80.
  //  s3 shop 5 @ 10,000, no override (pool 95 / 355,300 -> COGS 18,700): revenue 50,000, COGS 18,700, extra 0.
  //  s4 shop 5 @ 10,000, entered 3,741 (extra 5), then VOIDED -> listed but never summed.
  //  Totals: revenue 102,800; COGS 18,700 + 2,000 + 18,700 = 39,400; extra 300 + 80 = 380; cost 39,400 + 380 = 39,780; refunds 0.
  //  Telecom only: 2,800 / 2,000 / 80 / 2,080.  Shop only: 100,000 / 37,400 / 300 / 37,700.
  //  After returning 2 units of s1 (resalable) the refund is 20,000, the sold amounts (revenue, cost, extra) are unchanged.
  it('totals carry extraCostCents and costCents; voided sales are excluded; filters and paging do not change the sums', async () => {
    const s = await setup();
    const P = await p100(s);
    const T = await stocked(s, tel0, 10, 5000);
    const s1 = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    await sellOk(s, [clc(T.id, 4, 700, 520)]);
    await sellOk(s, [cl(P.id, 5, 10000)]);
    const s4 = (await sellOk(s, [clc(P.id, 5, 10000, 3741)])).sales[0];
    expect(s4.extraCostCents).toBe(5);
    expect((await voidSaleNew(s, s4.id)).status).toBe(200);

    const all = (await get(s.app, '/sales')).body;
    expect(Object.keys(all.totals).sort()).toEqual(SALE_TOTALS_KEYS);
    expect(all.total).toBe(4);                                          // the void sale is still listed
    expect(all.totals).toEqual({ revenueCents: 102800, cogsCents: 39400, extraCostCents: 380, costCents: 39780, refundsCents: 0 });
    expect((await get(s.app, '/sales?book=telecom')).body.totals).toEqual({ revenueCents: 2800, cogsCents: 2000, extraCostCents: 80, costCents: 2080, refundsCents: 0 });
    expect((await get(s.app, '/sales?book=shop')).body.totals).toEqual({ revenueCents: 100000, cogsCents: 37400, extraCostCents: 300, costCents: 37700, refundsCents: 0 });
    expect((await get(s.app, '/sales?status=void')).body.totals).toEqual({ revenueCents: 0, cogsCents: 0, extraCostCents: 0, costCents: 0, refundsCents: 0 });
    expect((await get(s.app, '/sales?limit=1')).body.totals).toEqual(all.totals);
    // a return changes the refunds only (returns are reported on their own)
    await returnOk(s, s1.id, [rl(s1.items[0].id, 2, true)]);
    expect((await get(s.app, '/sales')).body.totals).toEqual({ ...all.totals, refundsCents: 20000 });
    // the listed sales carry their own extra
    const rows = (await get(s.app, '/sales')).body.items;
    expect(rows.map((r: any) => r.extraCostCents).sort((a: number, b: number) => a - b)).toEqual([0, 5, 80, 300]);
  });
});

// =============================================================================================
// R13: PRICE_BELOW_COST compares the price with the AUTOMATIC unit cost, never with the entered cost.
describe('R13 warnings and the entered cost (C13)', () => {
  // Hand calculation: automatic unit cost 3,740.
  //  a) price 3,800, entered 5,000: price >= automatic 3,740 -> no PRICE_BELOW_COST (even though it is below the charged cost; the sale shows a loss).
  //  b) price 3,700, entered 3,740 (= automatic): 3,700 < 3,740 -> PRICE_BELOW_COST.
  //  c) price 3,700 with an extra (entered 4,000): still PRICE_BELOW_COST, exactly one warning on line 0.
  it('the warning follows the automatic cost: no warning at price 3,800 / cost 5,000; warning at price 3,700 with or without an extra', async () => {
    const s = await setup();
    const P = await p100(s);
    const a = await sellOk(s, [clc(P.id, 1, 3800, 5000)]);
    expect(a.warnings).toEqual([]);
    expect(a.sales[0]).toMatchObject({ extraCostCents: 5000 - 3740, grossProfitCents: 3800 - 5000 });
    const b = await sellOk(s, [clc(P.id, 1, 3700, 3740)]);
    expect(b.warnings.map((w: any) => [w.lineIndex, w.code])).toEqual([[0, 'PRICE_BELOW_COST']]);
    const c = await sellOk(s, [clc(P.id, 1, 3700, 4000)]);
    expect(c.warnings.map((w: any) => [w.lineIndex, w.code])).toEqual([[0, 'PRICE_BELOW_COST']]);
  });
});

// =============================================================================================
// Returns reverse the extra proportionally; stock and cash follow the automatic cost and the revenue only.
describe('sales returns with an extra cost (C5, C13)', () => {
  // Hand calculation: pool 20 / 700,000 (average 35,000). Sell 4 @ 100,000 entered 36,000:
  //  revenue 400,000; COGS 700,000 x 4 / 20 = 140,000; charged 4 x 36,000 = 144,000; extra 4,000; pool 16 / 560,000; cash +400,000.
  //  Return 1: 3 units DAMAGED: refund 100,000 x 3 = 300,000; COGS 140,000 x 3 / 4 = 105,000; extra 4,000 x 3 / 4 = 3,000.
  //            Nothing restocked (pool stays 16 / 560,000); ONE loss row of 105,000 (the automatic cost only, not 105,000 + 3,000).
  //  Return 2: the last unit, RESALABLE, completes the line: refund 400,000 - 300,000 = 100,000; COGS 140,000 - 105,000 = 35,000;
  //            extra 4,000 - 3,000 = 1,000. Restock at the automatic cost 35,000 -> pool 17 / 595,000 (NOT 596,000).
  //  Cash: +400,000 - 300,000 - 100,000 = 0. Extra reversed in total 3,000 + 1,000 = 4,000 = the line's extra.
  it('damaged then final resalable return: extraCostReversedCents 3,000 + 1,000; restock 35,000; one loss row 105,000; refund = revenue only', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 20, 700000);
    const cash0 = cashBal(s, 'shop');
    const sale = (await sellOk(s, [clc(P.id, 4, 100000, 36000)])).sales[0];
    expect(sale).toMatchObject({ cogsCents: 140000, extraCostCents: 4000, chargedCostCents: 144000 });
    const item = sale.items[0];

    const r1 = (await returnOk(s, sale.id, [rl(item.id, 3, false)])).item;
    expect(r1).toMatchObject({ refundCents: 300000, cogsReversedCents: 105000, extraCostReversedCents: 3000 });
    expect(r1.items[0]).toMatchObject({ qty: 3, resalable: false, revenueCents: 300000, cogsCents: 105000, extraCostCents: 3000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 16, value: 560000 });
    expect(mvsByRef(s, 'sales_returns', r1.id)).toHaveLength(0);
    const losses = lossRows(s);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ source: 'damaged_return', sales_return_id: r1.id, qty: 3, cost_cents: 105000 });
    await reconOk(s);

    const r2 = (await returnOk(s, sale.id, [rl(item.id, 1, true)])).item;
    expect(r2).toMatchObject({ refundCents: 100000, cogsReversedCents: 35000, extraCostReversedCents: 1000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 17, value: 595000 });
    expect(mvsByRef(s, 'sales_returns', r2.id)[0]).toMatchObject({ type: 'sale_return', qty: 1, value: 35000 });
    expect(cashOfRef(s, 'sales_returns', r1.id).map((c) => c.amount_cents)).toEqual([-300000]);
    expect(cashOfRef(s, 'sales_returns', r2.id).map((c) => c.amount_cents)).toEqual([-100000]);
    expect(cashBal(s, 'shop') - cash0).toBe(0);
    expect(r1.extraCostReversedCents + r2.extraCostReversedCents).toBe(sale.extraCostCents);
    expect(lossRows(s)).toHaveLength(1);
    await reconOk(s);
  });

  // Hand calculation: shop A 20 / 700,000 sells 4 @ 100,000 entered 36,000 (extra 4,000, COGS 140,000);
  //  B 10 / 2,000 (average 200) sells 5 @ 500 with no override (COGS 1,000, extra 0). Both lines fully returned in ONE return:
  //  extra reversed = 4,000 + 0 = 4,000; COGS reversed 140,000 + 1,000 = 141,000; refund 400,000 + 2,500 = 402,500.
  it('one return of two lines: extraCostReversedCents is the sum of the lines (4,000 + 0)', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 20, 700000);
    const B = await stocked(s, shop0, 10, 2000);
    const sale = (await sellOk(s, [clc(A.id, 4, 100000, 36000), cl(B.id, 5, 500)])).sales[0];
    expect(sale.items.map((i: any) => i.extraCostCents)).toEqual([4000, 0]);
    const ret = (await returnOk(s, sale.id, [rl(sale.items[0].id, 4, true), rl(sale.items[1].id, 5, true)])).item;
    expect(ret).toMatchObject({ refundCents: 402500, cogsReversedCents: 141000, extraCostReversedCents: 4000 });
    expect(ret.items.map((i: any) => i.extraCostCents)).toEqual([4000, 0]);
    expect(poolOf(s, A.id)).toEqual({ qty: 20, value: 700000 });      // stock back at exactly the automatic cost that left
    expect(poolOf(s, B.id)).toEqual({ qty: 10, value: 2000 });
    await reconOk(s);
  });

  // Over-return is still refused: 4 sold, 3 returned, 2 more -> 422 RETURN_EXCEEDS_SOLD; nothing written; the extra reversed so far is unchanged.
  it('over-return still 422 RETURN_EXCEEDS_SOLD and writes nothing', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 20, 700000);
    const sale = (await sellOk(s, [clc(P.id, 4, 100000, 36000)])).sales[0];
    await returnOk(s, sale.id, [rl(sale.items[0].id, 3, true)]);
    const before = snap5(s);
    const r = await returnNew(s, sale.id, [rl(sale.items[0].id, 2, true)]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('RETURN_EXCEEDS_SOLD');
    expect(snap5(s)).toEqual(before);
    expect(num(s, 'SELECT SUM(extra_cost_cents) FROM sales_return_items')).toBe(3000);
  });

  // R-RD unchanged: a sale dated 5 days ago with an extra cannot be returned on day -6 (400 RETURN_BEFORE_ORIGINAL_DATE, originalDate); day -3 is fine
  // and the extra is reversed all the same. R-FD unchanged: tomorrow is refused.
  it('return-date rules are unchanged: before the sale date 400, backdated after it fine, future 400', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 20, 700000);
    const sale = (await sellOk(s, [clc(P.id, 4, 100000, 36000)], { businessDate: daysAgo(5) })).sales[0];
    const early = await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(6) });
    expect(early.status).toBe(400);
    expect(err(early)).toMatchObject({ code: 'RETURN_BEFORE_ORIGINAL_DATE', originalDate: daysAgo(5) });
    const future = await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(-1) });
    expect(future.status).toBe(400);
    expect(err(future).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    // Hand: extra 4,000 x 1 / 4 = 1,000 reversed by the 1-unit return.
    const ok = (await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(3) })).item;
    expect(ok).toMatchObject({ backdated: true, extraCostReversedCents: 1000 });
  });
});

// =============================================================================================
// Voids: the whole sale including its extra disappears from totals; stock and cash reversal are unchanged.
describe('voiding a sale with an extra cost (C6, C13)', () => {
  // Hand calculation: pool 100 / 374,000; sale 5 @ 10,000 entered 3,800: pool 95 / 355,300, cash +50,000.
  //  Void: the movement is negated exactly (+5 / +18,700, NOT 19,000) -> pool 100 / 374,000; the cash entry is cancelled by -50,000 (net 0).
  //  The voided sale keeps its frozen extra 300 on the record, but GET /sales totals exclude it (extra 0, cost 0).
  it('stock returns at 18,700, cash nets to 0, the sale keeps its frozen figures, totals exclude it', async () => {
    const s = await setup();
    const P = await p100(s);
    const cash0 = cashBal(s, 'shop');
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    const v = await voidSaleNew(s, sale.id);
    expect(v.status).toBe(200);
    expect(v.body.item).toMatchObject({ status: 'void', extraCostCents: 300, chargedCostCents: 19000, cogsCents: 18700 });
    expect(poolOf(s, P.id)).toEqual({ qty: 100, value: 374000 });
    const moves = mvsByRef(s, 'sales', sale.id);
    expect(moves.map((m) => [m.type, m.qty, m.value])).toEqual([['sale', -5, -18700], ['sale', 5, 18700]]);   // the void is the exact negation (same type, C6)
    expect(cashOfRef(s, 'sales', sale.id).map((c) => c.amount_cents)).toEqual([50000, -50000]);
    expect(cashBal(s, 'shop') - cash0).toBe(0);
    expect((await get(s.app, '/sales')).body.totals).toEqual({ revenueCents: 0, cogsCents: 0, extraCostCents: 0, costCents: 0, refundsCents: 0 });
    await reconOk(s);
  });

  // A sale that has a return still cannot be voided (R1 / HAS_RETURNS), extra or not.
  it('a sale with a return (extra reversed) cannot be voided: 409 HAS_RETURNS, nothing written', async () => {
    const s = await setup();
    const P = await p100(s);
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)]);
    const before = snap5(s);
    const v = await voidSaleNew(s, sale.id);
    expect(v.status).toBe(409);
    expect(err(v).code).toBe('HAS_RETURNS');
    expect(snap5(s)).toEqual(before);
  });
});

// =============================================================================================
// Audit rows carry the extra-cost fields (section 12).
describe('audit of extra-cost sales, returns and voids (C13)', () => {
  // The audit "after" snapshots are the API shapes, so they include extraCostCents / chargedCostCents / extraCostReversedCents.
  it('sale create, return create and sale void audit rows contain the extra fields', async () => {
    const s = await setup();
    const P = await p100(s);
    const sale = (await sellOk(s, [clc(P.id, 5, 10000, 3800)])).sales[0];
    const created = auditRows(s.ctx, 'sale').find((a) => a.action === 'create' && a.entityId === String(sale.id))!;
    expect(created.before).toBeNull();
    expect(created.after).toMatchObject({ extraCostCents: 300, chargedCostCents: 19000, grossProfitCents: 31000 });
    expect(created.after.items[0]).toMatchObject({ extraCostCents: 300, chargedCostCents: 19000, cogsCents: 18700 });

    const ret = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)])).item;
    const retAudit = auditRows(s.ctx, 'sale_return').find((a) => a.entityId === String(ret.id))!;
    expect(retAudit.after).toMatchObject({ extraCostReversedCents: 120, cogsReversedCents: 7480 });
    expect(retAudit.after.items[0]).toMatchObject({ extraCostCents: 120, cogsCents: 7480 });

    const sale2 = (await sellOk(s, [clc(P.id, 5, 10000, 3741)])).sales[0];
    expect((await voidSaleNew(s, sale2.id)).status).toBe(200);
    const voidAudit = auditRows(s.ctx, 'sale').find((a) => a.action === 'void' && a.entityId === String(sale2.id))!;
    expect(voidAudit.before).toMatchObject({ status: 'posted', extraCostCents: 5 });
    expect(voidAudit.after).toMatchObject({ status: 'void', extraCostCents: 5 });
    expect(today()).toBe(created.after.businessDate);
  });
});
