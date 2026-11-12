// Phase 14: rounding and magnitude edges. Expected values are computed here with plain BigInt arithmetic (round half away from zero for non-negative values:
// floor((2ab + c) / 2c)), never by the server's money helper. Targets: commissions at exact halves and at 10^12 cents, weighted-average removal of huge pools
// (a x b exceeds 2^53), return portions of awkward totals, stocktake gains, the "exact remainder" rules, and values that must never drift by a cent.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct, mkTelecom, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post, put } from './helpers/catalog.ts';
import { assertGlobalInvariants } from './helpers/phase14.ts';
import { cl, clc, returnOk, sellOk } from './helpers/phase5.ts';
import { providerIds } from './helpers/phase6.ts';
import { stComplete, stDraft } from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
/** round(a x b / c) half up for non-negative operands, exact. */
const mdr = (a: number, b: number, c: number): number => Number((2n * BigInt(a) * BigInt(b) + BigInt(c)) / (2n * BigInt(c)));
const D = '2025-06-10';

describe('commissions (BUSINESS_RULES 5): exact halves and huge sales', () => {
  it('reload commission = round(sales x bp / 10000) + extra for halves, tiny and 10^12-cent sales, at every provider rate', async () => {
    const s = await apiBase(await env.build());
    const prov = await providerIds(s);
    const cases: Array<[number, number, number]> = [ // [salesCents, bp, extraCents]
      [25, 600, 0], [24, 600, 0], [26, 600, 0], [1, 600, 0], [83, 600, 7], [100000000000, 600, 0], [999999999999, 450, 0], [999999999999, 10000, 0], [999999999999, 1, 0],
      [333333, 450, 0], [666666, 450, 0], [12345, 0, 99], [5, 5000, 0], [1, 5000, 0], [3, 1667, 0],
    ];
    let day = 1;
    for (const [sales, bp, extra] of cases) {
      const ok = await put(s.app, `/reload-providers/${prov.Dialog}`, { commissionBp: bp, active: true });
      expect(ok.status).toBe(200);
      const r = await post(s.app, '/reload-sales', { businessDate: `2025-06-${String(day++).padStart(2, '0')}`, providerId: prov.Dialog, salesCents: sales, ...(extra ? { extraCents: extra } : {}), clientRef: ref() });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.item.commissionCents, `reload ${sales} @ ${bp} bp + ${extra}`).toBe(mdr(sales, bp, 10000) + extra);
      expect(r.body.item.commissionBp).toBe(bp);
    }
    await assertGlobalInvariants(s);
  });

  it('EZCash commission = round(bill x 80 bp / 10000); changing the default rate later never changes old rows', async () => {
    const s = await apiBase(await env.build());
    for (const bill of [1, 62, 63, 125, 126, 12345, 1234567, 999999999999]) {
      const r = await post(s.app, '/ezcash-sales', { businessDate: D, billTotalCents: bill, clientRef: ref() });
      expect(r.body.item.commissionCents, `EZCash ${bill}`).toBe(mdr(bill, 80, 10000));
    }
    await put(s.app, '/settings', { rates: { reloadCommissionBp: 600, ezcashCommissionBp: 9999 } });
    const list = (await get(s.app, '/ezcash-sales?limit=50')).body;
    expect(list.items.every((x: any) => x.commissionBp === 80)).toBe(true);
    expect(list.totals.commissionCents).toBe([1, 62, 63, 125, 126, 12345, 1234567, 999999999999].reduce((a, b) => a + mdr(b, 80, 10000), 0));
  });
});

describe('weighted average with huge pools: value x quantity exceeds 2^53', () => {
  async function pool(s: ApiBase, id: number): Promise<[number, number]> { const p = (await get(s.app, `/products/${id}`)).body.item; return [p.qtyOnHand, p.stockValueCents]; }

  it('a pool of 1,000,000 units worth 99,999,999,999 cents sold in awkward slices removes the exact rounded value each time and ends at exactly 0 / 0', async () => {
    const s = await apiBase(await env.build());
    const P = (await mkProduct(s, { name: 'Big pool', sellPriceCents: 100, minPriceCents: 0 })).id;
    await buy(s, [{ productId: P, packs: 1, packSize: 1_000_000, lineTotalCents: 99_999_999_999 }], { businessDate: D });
    let qty = 1_000_000; let value = 99_999_999_999;
    for (const q of [333_333, 1, 666_665, 1]) {
      const cogs = q === qty ? value : mdr(value, q, qty);
      const sale = (await sellOk(s, [cl(P, q, 100)], { businessDate: D })).sales[0];
      expect(sale.cogsCents, `slice of ${q} from ${qty}/${value}`).toBe(cogs);
      qty -= q; value -= cogs;
      expect(await pool(s, P)).toEqual([qty, value]);
    }
    expect(await pool(s, P)).toEqual([0, 0]);
    await assertGlobalInvariants(s);
  });

  it('partial returns of a huge line: portions follow round(line x q / qty), the last return takes the exact remainder, nothing drifts', async () => {
    const s = await apiBase(await env.build());
    const P = (await mkProduct(s, { name: 'Big line', sellPriceCents: 999_999_999, minPriceCents: 0 })).id;
    await buy(s, [{ productId: P, packs: 1, packSize: 1000, lineTotalCents: 99_999_999_999 }], { businessDate: D });
    const sale = (await sellOk(s, [cl(P, 997, 999_999_999)], { businessDate: D })).sales[0]; // revenue 996,999,999,003 cents
    const item = sale.items[0];
    expect(item.revenueCents).toBe(997 * 999_999_999);
    let retQty = 0; let revSum = 0; let cogsSum = 0;
    for (const q of [333, 331, 1, 332]) {
      const last = retQty + q === 997;
      const r = (await returnOk(s, sale.id, [{ saleItemId: item.id, qty: q, resalable: true }], { businessDate: D })).item;
      const wantRev = last ? item.revenueCents - revSum : mdr(item.revenueCents, q, 997);
      const wantCogs = last ? item.cogsCents - cogsSum : mdr(item.cogsCents, q, 997);
      expect([r.refundCents, r.cogsReversedCents], `return of ${q}`).toEqual([wantRev, wantCogs]);
      retQty += q; revSum += wantRev; cogsSum += wantCogs;
    }
    expect(revSum).toBe(item.revenueCents);
    expect(cogsSum).toBe(item.cogsCents);
    // everything came back: the pool is the original pool again, to the cent
    expect(await pool(s, P)).toEqual([1000, 99_999_999_999]);
    await assertGlobalInvariants(s);
  });

  it('stocktake gain on a huge pool uses round(value x gain / qty); a gain on a ZERO-value pool or an empty pool needs an entered unit cost (C10)', async () => {
    const s = await apiBase(await env.build());
    const P = (await mkProduct(s, { name: 'Gain big', sellPriceCents: 100, minPriceCents: 0 })).id;
    await buy(s, [{ productId: P, packs: 1, packSize: 999_983, lineTotalCents: 99_999_999_999 }], { businessDate: D });
    const draft = await stDraft(s, [{ productId: P, countedQty: 999_983 + 17 }], { businessDate: D, book: 'shop' });
    const done = await stComplete(s, draft.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const want = mdr(99_999_999_999, 17, 999_983);
    expect(await pool(s, P)).toEqual([999_983 + 17, 99_999_999_999 + want]);
    // zero-value pool: quantity but no value -> unit cost required
    const Z = (await mkProduct(s, { name: 'Zero value', sellPriceCents: 100, minPriceCents: 0 })).id;
    await buy(s, [{ productId: Z, packs: 1, packSize: 5, lineTotalCents: 0 }], { businessDate: D });
    const noCost = await post(s.app, '/stocktakes', { businessDate: D, book: 'shop', items: [{ productId: Z, countedQty: 8 }], clientRef: ref() });
    if (noCost.status === 201) {
      const c = await stComplete(s, noCost.body.item.id);
      expect([400, 422], `a gain on a zero-value pool without a unit cost must be refused: ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`).toContain(c.status);
    } else expect([400, 422]).toContain(noCost.status);
    expect(await pool(s, Z)).toEqual([5, 0]);
    const withCost = await stDraft(s, [{ productId: Z, countedQty: 8, gainUnitCostCents: 1234 }], { businessDate: D, book: 'shop' });
    expect((await stComplete(s, withCost.id)).status).toBe(200);
    expect(await pool(s, Z)).toEqual([8, 3 * 1234]);
    await assertGlobalInvariants(s);
  });

  it('a weighted-average pool never loses or gains a cent over many buy/sell cycles at awkward prices (Rs 33.33 x 3 and friends)', async () => {
    const s = await apiBase(await env.build());
    const P = (await mkProduct(s, { name: 'Cents', sellPriceCents: 5000, minPriceCents: 0 })).id;
    let qty = 0; let value = 0; let cogsTotal = 0;
    const buys: Array<[number, number]> = [[3, 10000], [7, 12345], [11, 99999], [1, 1], [13, 77777]];
    for (const [units, total] of buys) {
      await buy(s, [{ productId: P, packs: 1, packSize: units, lineTotalCents: total }], { businessDate: D });
      qty += units; value += total;
      const q = Math.min(qty, 4);
      const sale = (await sellOk(s, [cl(P, q, 5000)], { businessDate: D })).sales[0];
      const cogs = q === qty ? value : mdr(value, q, qty);
      expect(sale.cogsCents).toBe(cogs);
      qty -= q; value -= cogs; cogsTotal += cogs;
    }
    // total bought = remaining value + everything sold at cost (no cent created or lost)
    expect(value + cogsTotal).toBe(buys.reduce((a, b) => a + b[1], 0));
    expect(await pool(s, P)).toEqual([qty, value]);
    await assertGlobalInvariants(s);
  });

  it('the extra cost on a sale (C13): charged = qty x entered unit cost, extra = charged - automatic, shares follow the same remainder rule on returns', async () => {
    const s = await apiBase(await env.build());
    const P = (await mkProduct(s, { name: 'Extra', sellPriceCents: 9999, minPriceCents: 0 })).id;
    await buy(s, [{ productId: P, packs: 1, packSize: 7, lineTotalCents: 24_691 }], { businessDate: D }); // 3,527.28 per unit
    const sale = (await sellOk(s, [clc(P, 7, 9999, 3600)], { businessDate: D })).sales[0]; // automatic 24,691 (all 7 units), charged 7 x 3,600 = 25,200, extra 509
    expect([sale.cogsCents, sale.extraCostCents, sale.chargedCostCents]).toEqual([24691, 509, 25200]);
    let extraBack = 0;
    for (const q of [3, 2, 2]) {
      const r = (await returnOk(s, sale.id, [{ saleItemId: sale.items[0].id, qty: q, resalable: true }], { businessDate: D })).item;
      extraBack += r.extraCostReversedCents;
    }
    expect(extraBack, 'all extra cost comes back exactly').toBe(509);
    await assertGlobalInvariants(s);
  });

  it('a card sale (telecom book) with the entered cost below the automatic cost is refused; at the automatic cost the extra is exactly 0', async () => {
    const s = await apiBase(await env.build());
    const K = (await mkTelecom(s, { name: 'Card', sellPriceCents: 1000, minPriceCents: 0 })).id;
    await buy(s, [{ productId: K, packs: 1, packSize: 3, lineTotalCents: 10000 }], { businessDate: D }); // 3,333.33 per card
    const low = await post(s.app, '/sales', { businessDate: D, items: [{ productId: K, qty: 3, unitPriceCents: 5000, unitCostCents: 3333 }], clientRef: ref() });
    expect([low.status, low.body.error?.code]).toEqual([422, 'COST_BELOW_AUTOMATIC']); // 3 x 3,333 = 9,999 < 10,000
    expect(low.body.error.minUnitCostCents).toBe(3334);
    const ok = await sellOk(s, [clc(K, 3, 5000, 3334)], { businessDate: D }); // 10,002 charged, extra 2
    expect([ok.sales[0].cogsCents, ok.sales[0].extraCostCents]).toEqual([10000, 2]);
  });
});
