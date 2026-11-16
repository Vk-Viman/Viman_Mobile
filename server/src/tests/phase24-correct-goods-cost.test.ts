// PHASE 24 - goods personal use corrections: cost drift (stock is removed at the weighted-average cost AT THE TIME OF THE CORRECTION),
// the kind can never change, and cash drawings keep answering exactly as in Phase 1 (no comparison). Figures are hand-calculated.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { drawCash, seedBooks, state } from './helpers/phase9.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const D = (n: number) => daysAgo(n);
const pool = (s: ApiBase, id: number) => {
  const r = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
};
const correct = (s: ApiBase, id: number, rep: Record<string, unknown>) => post(s.app, `/drawings/${id}/correct`, { reason: 'counted wrong', replacement: rep });
const preview = (s: ApiBase, id: number, rep: Record<string, unknown>) => post(s.app, `/drawings/${id}/correct-preview`, { reason: 'counted wrong', replacement: rep });
const check = (s: ApiBase, id: number) => get(s.app, `/drawings/${id}/correct-check`);

async function world() {
  const s = await apiBase(await env.build());
  await seedBooks(s, { shop: 1_000_000, telecom: 1_000_000, cost: 1_000_000 }, D(20));
  const p = await mkProduct(s);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: D(8) }); // 10 units / Rs 100.00
  return { s, p };
}
const goods = (p: any, o: Record<string, unknown> = {}) => ({ kind: 'goods', productId: p.id, qty: 4, clientRef: ref(), ...o });

describe('goods correction: cost drift', () => {
  it('the replacement is costed at the average of the moment of the correction, not at the old cost (hand-calculated to the cent)', async () => {
    const { s, p } = await world();
    const o = (await post(s.app, '/drawings', { ...goods(p), businessDate: D(3) })).body.item;
    expect(o.amountCents).toBe(4000); // 4 units at Rs 10.00
    // later the shop buys 10 more units for Rs 300.00: pool 6 / Rs 60.00 + 10 / Rs 300.00 = 16 units / Rs 360.00 (average Rs 22.50)
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 30000 }], { businessDate: D(1) });
    expect(pool(s, p.id)).toEqual({ qty: 16, value: 36000 });
    const pv = await preview(s, o.id, goods(p));
    expect(pv.status).toBe(200);
    // void: the 4 units come back at their ORIGINAL value Rs 40.00 => 20 units / Rs 400.00 (average Rs 20.00);
    // the replacement of the same 4 units takes 4 x Rs 20.00 = Rs 80.00 => 16 units / Rs 320.00
    expect(pv.body.comparison).toEqual({ originalCostCents: 4000, replacementCostCents: 8000, differenceCents: 4000 });
    expect(pv.body.replacement).toMatchObject({ amountCents: 8000, qty: 4, businessDate: D(3), status: 'posted' });
    const r = await correct(s, o.id, goods(p));
    expect(r.status).toBe(201);
    expect(r.body.comparison).toEqual(pv.body.comparison);
    expect(r.body.replacement.amountCents).toBe(8000);
    expect(pool(s, p.id)).toEqual({ qty: 16, value: 32000 });
    // the stock movement of the replacement carries the same value and a unit cost of Rs 20.00
    const mv = sql(s, "SELECT qty_delta, value_delta_cents, unit_cost_cents FROM stock_movements WHERE type = 'personal_use' AND ref_id = ?", r.body.replacement.id)[0]!;
    expect(mv).toMatchObject({ qty_delta: -4, value_delta_cents: -8000, unit_cost_cents: 2000 });
    expect(allProblems(s.ctx)).toEqual([]);
    // identical to a manual void followed by a manual create
    const w2 = await world();
    const o2 = (await post(w2.s.app, '/drawings', { ...goods(w2.p), businessDate: D(3) })).body.item;
    await buy(w2.s, [{ productId: w2.p.id, packs: 1, packSize: 10, lineTotalCents: 30000 }], { businessDate: D(1) });
    await post(w2.s.app, `/drawings/${o2.id}/void`, { reason: 'counted wrong' });
    const m = await post(w2.s.app, '/drawings', { ...goods(w2.p), businessDate: D(3) });
    expect(m.body.item.amountCents).toBe(8000);
    expect(pool(w2.s, w2.p.id)).toEqual({ qty: 16, value: 32000 });
  });

  it('a cheaper purchase in between lowers the cost: Rs 10.00 -> Rs 5.00 per unit, difference negative', async () => {
    const { s, p } = await world();
    const o = (await post(s.app, '/drawings', { ...goods(p), businessDate: D(3) })).body.item; // 4 @ 10.00 = 4000, pool 6 / 6000
    await buy(s, [{ productId: p.id, packs: 1, packSize: 14, lineTotalCents: 1400 }], { businessDate: D(1) }); // 14 units for Rs 14.00 => 20 / Rs 74.00
    // pool 20 / 7400; the void gives 4 back at 4000 => 24 units / 11400 => average 475 a unit; the replacement 4 x 475 = 1900
    const r = await correct(s, o.id, goods(p));
    expect(r.status).toBe(201);
    expect(r.body.comparison).toEqual({ originalCostCents: 4000, replacementCostCents: 1900, differenceCents: -2100 });
    expect(pool(s, p.id)).toEqual({ qty: 20, value: 9500 });
    expect(allProblems(s.ctx)).toEqual([]);
  });
});

describe('goods correction: the kind can never change', () => {
  it('a goods drawing cannot become a cash drawing: 400 VALIDATION_ERROR in preview and correct, nothing changes', async () => {
    const { s, p } = await world();
    const o = (await post(s.app, '/drawings', { ...goods(p), businessDate: D(3) })).body.item;
    const fp = fingerprint(s.ctx);
    const cash = { kind: 'cash', book: 'shop', amountCents: 5000, clientRef: ref() };
    for (const r of [await preview(s, o.id, cash), await correct(s, o.id, cash)]) {
      expect([r.status, r.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect(r.body.error.fields ?? r.body.error.details ?? r.body.error).toBeDefined();
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(sql(s, 'SELECT status FROM owner_drawings WHERE id = ?', o.id)[0]!.status).toBe('posted');
  });

  it('a cash drawing cannot become a goods drawing (also with a valid goods body); the cash drawing stays posted', async () => {
    const { s, p } = await world();
    const o = (await drawCash(s, { amountCents: 10000, businessDate: D(3) })).body.item;
    const fp = fingerprint(s.ctx);
    for (const r of [await preview(s, o.id, goods(p)), await correct(s, o.id, goods(p))]) {
      expect([r.status, r.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(count(s.ctx, 'corrections')).toBe(0);
  });
});

describe('cash drawings keep the Phase 1 behaviour', () => {
  it('check, preview and correct of a cash drawing carry NO comparison and still reconcile', async () => {
    const { s } = await world();
    const o = (await drawCash(s, { amountCents: 10000, businessDate: D(3) })).body.item;
    expect((await check(s, o.id)).body).toEqual({ eligible: true });
    const rep = { kind: 'cash', book: 'shop', amountCents: 25000, clientRef: ref() };
    const pv = await preview(s, o.id, rep);
    expect(Object.keys(pv.body).sort()).toEqual(['original', 'replacement', 'warnings']);
    const r = await correct(s, o.id, rep);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['correction', 'original', 'replacement', 'warnings']);
    const again = await correct(s, o.id, rep);
    expect(again.status).toBe(200);
    expect(Object.keys(again.body).sort()).toEqual(['correction', 'original', 'replacement', 'warnings']);
    expect(state(s).shop).toBe(1_000_000 - 10000 - 25000); // the old stock purchase + the corrected drawing
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a goods drawing is no longer refused with CORRECTION_NOT_SUPPORTED: check says eligible', async () => {
    const { s, p } = await world();
    const o = (await post(s.app, '/drawings', { ...goods(p), businessDate: D(3) })).body.item;
    const fp = fingerprint(s.ctx);
    expect((await check(s, o.id)).body).toEqual({ eligible: true });
    expect(fingerprint(s.ctx)).toBe(fp);
  });
});
