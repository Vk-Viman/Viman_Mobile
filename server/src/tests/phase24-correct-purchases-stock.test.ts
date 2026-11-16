// PHASE 24 - purchase corrections: the type-specific rules (group 10). The existing voidPurchase guards decide: a purchase with returns
// is refused (HAS_RETURNS), a purchase whose goods were sold is refused (INSUFFICIENT_STOCK), and the weighted average moves exactly as
// "manual void + manual create" would move it. Every figure below is hand-calculated to the cent.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, mkTelecom, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { seedBooks, state } from './helpers/phase9.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const D = (n: number) => daysAgo(n);
const pool = (s: ApiBase, id: number) => {
  const r = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
};
const ledger = (s: ApiBase) => ({
  cash: sql(s, 'SELECT book, type, amount_cents, business_date, reverses_entry_id IS NOT NULL AS rev FROM cash_entries ORDER BY id'),
  stock: sql(s, 'SELECT product_id, type, qty_delta, value_delta_cents, unit_cost_cents, business_date FROM stock_movements ORDER BY id'),
  products: sql(s, 'SELECT id, qty_on_hand, stock_value_cents FROM products ORDER BY id'),
  sales: sql(s, 'SELECT product_id, qty, unit_cost_cents, cogs_cents FROM sale_items ORDER BY id'),
  state: state(s),
});

/** Product with an old purchase of 10 units for `oldCents`, then the purchase under test: 10 units for Rs 200.00 on D(2). */
async function setup(oldCents: number): Promise<{ s: ApiBase; p: any; purchase: any }> {
  const s = await apiBase(await env.build());
  await seedBooks(s, { shop: 1_000_000, telecom: 1_000_000, cost: 1_000_000 }, D(20));
  const p = await mkProduct(s);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: oldCents }], { businessDate: D(8) });
  const purchase = await buy(s, [{ productId: p.id, packs: 2, packSize: 5, lineTotalCents: 20000 }], { businessDate: D(2) });
  return { s, p, purchase };
}
const rep = (p: any, lineTotalCents = 30000, packs = 1, packSize = 10) =>
  ({ items: [{ productId: p.id, packs, packSize, lineTotalCents }], clientRef: ref() });
const correct = (s: ApiBase, id: number, r: Record<string, unknown>) => post(s.app, `/purchases/${id}/correct`, { reason: 'wrong cost', replacement: r });
const previewOf = (s: ApiBase, id: number, r: Record<string, unknown>) => post(s.app, `/purchases/${id}/correct-preview`, { reason: 'wrong cost', replacement: r });
const checkOf = (s: ApiBase, id: number) => get(s.app, `/purchases/${id}/correct-check`);

describe('10. purchases: a purchase with returns is refused (HAS_RETURNS)', () => {
  it('check, preview and correct all answer 409 HAS_RETURNS; the fingerprint never changes; the manual void agrees', async () => {
    const { s, p, purchase } = await setup(10000);
    const itemId = purchase.items[0].id;
    const ret = await post(s.app, `/purchases/${purchase.id}/returns`, { businessDate: D(1), items: [{ purchaseItemId: itemId, units: 2 }], clientRef: ref() });
    expect(ret.status).toBe(201);
    const fp = fingerprint(s.ctx);
    expect(await checkOf(s, purchase.id).then((r) => r.body)).toMatchObject({ eligible: false, code: 'HAS_RETURNS' });
    for (const r of [await previewOf(s, purchase.id, rep(p)), await correct(s, purchase.id, rep(p))]) {
      expect([r.status, r.body.error.code]).toEqual([409, 'HAS_RETURNS']);
    }
    expect((await post(s.app, `/purchases/${purchase.id}/void`, { reason: 'x' })).body.error.code).toBe('HAS_RETURNS');
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(sql(s, 'SELECT status FROM purchases WHERE id = ?', purchase.id)[0]!.status).toBe('posted');
    expect(count(s.ctx, 'corrections')).toBe(0);
    expect(allProblems(s.ctx)).toEqual([]);
  });
});

describe('10. purchases: goods already sold (INSUFFICIENT_STOCK decides)', () => {
  it('more sold than the rest of the pool can cover: refused 422 INSUFFICIENT_STOCK, fingerprint unchanged, check says not eligible', async () => {
    const { s, p, purchase } = await setup(10000);
    await sellOk(s, [cl(p.id, 15, 100000)], { businessDate: D(1) }); // pool 20 -> 5 units left, fewer than the 10 this purchase brought
    expect(pool(s, p.id).qty).toBe(5);
    const fp = fingerprint(s.ctx);
    const c = await checkOf(s, purchase.id);
    expect(c.body).toMatchObject({ eligible: false, code: 'INSUFFICIENT_STOCK' });
    for (const r of [await previewOf(s, purchase.id, rep(p)), await correct(s, purchase.id, rep(p))]) {
      expect([r.status, r.body.error.code]).toEqual([422, 'INSUFFICIENT_STOCK']);
      expect(r.body.error.extra ?? r.body.error).toBeDefined();
    }
    expect((await post(s.app, `/purchases/${purchase.id}/void`, { reason: 'x' })).body.error.code).toBe('INSUFFICIENT_STOCK'); // the manual void agrees
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(sql(s, 'SELECT status FROM purchases WHERE id = ?', purchase.id)[0]!.status).toBe('posted');
    expect(count(s.ctx, 'corrections')).toBe(0);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('part sold but enough left: corrected; the sale keeps its cost snapshot; equals manual void + create to the cent', async () => {
    const run = async (manual: boolean) => {
      const { s, p, purchase } = await setup(10000);
      // pool 20 units / Rs 300.00 (average Rs 15.00); sell 5 at Rs 15.00 => cost Rs 75.00 => pool 15 units / Rs 225.00
      await sellOk(s, [cl(p.id, 5, 100000)], { businessDate: D(1) });
      expect(pool(s, p.id)).toEqual({ qty: 15, value: 22500 });
      let r: any = null;
      if (manual) {
        expect((await post(s.app, `/purchases/${purchase.id}/void`, { reason: 'wrong cost' })).status).toBe(200);
        expect((await post(s.app, '/purchases', { ...rep(p), businessDate: D(2) })).status).toBe(201);
      } else {
        r = await correct(s, purchase.id, rep(p));
        expect(r.status).toBe(201);
      }
      // the void removes min(Rs 200.00 cost, Rs 225.00 pool) = Rs 200.00 for 10 units -> 5 units / Rs 25.00; the new bill adds 10 units / Rs 300.00
      expect(pool(s, p.id)).toEqual({ qty: 15, value: 32500 });
      expect(sql(s, 'SELECT unit_cost_cents, cogs_cents FROM sale_items')[0]).toMatchObject({ unit_cost_cents: 1500, cogs_cents: 7500 }); // earlier sale snapshot stays
      expect(allProblems(s.ctx)).toEqual([]);
      return { s, r };
    };
    const a = await run(false);
    const b = await run(true);
    expect(ledger(a.s)).toEqual(ledger(b.s));
    expect(a.r.body.comparison).toMatchObject({ originalTotalCents: 20000, replacementTotalCents: 30000, differenceTotalCents: 10000 });
  });

  it('the pool is worth less than the purchase cost: the void removes only the pool value (R4 min), the correction still equals manual', async () => {
    const run = async (manual: boolean) => {
      const { s, p, purchase } = await setup(100); // old stock: 10 units for Rs 1.00 in total => pool 20 units / Rs 201.00
      await sellOk(s, [cl(p.id, 5, 100000)], { businessDate: D(1) }); // average 20100/20 = 1005 per unit; 5 units cost 5025 => pool 15 / 15075
      expect(pool(s, p.id)).toEqual({ qty: 15, value: 15075 });
      if (manual) {
        await post(s.app, `/purchases/${purchase.id}/void`, { reason: 'wrong cost' });
        await post(s.app, '/purchases', { ...rep(p), businessDate: D(2) });
      } else {
        expect((await correct(s, purchase.id, rep(p))).status).toBe(201);
      }
      // the void caps the removal at the pool value Rs 150.75 (cost was Rs 200.00): 5 units / Rs 0.00 are left, then +10 units / Rs 300.00
      expect(pool(s, p.id)).toEqual({ qty: 15, value: 30000 });
      return s;
    };
    const a = await run(false);
    const b = await run(true);
    expect(ledger(a)).toEqual(ledger(b));
    // NOTE (existing behaviour, not caused by the correction): a capped void (R4) removes less value than the purchase added, so the
    // restore validator's void_reversals check lists the voided bill. The manual void + create world shows exactly the same list.
    expect(allProblems(a.ctx)).toEqual(allProblems(b.ctx));
    expect(allProblems(a.ctx).every((x) => x.startsWith('void_reversals'))).toBe(true);
  });
});

describe('10. purchases: changing pack size or price moves the weighted average from that point on', () => {
  it('the replacement has other packs and a cheaper price: average Rs 15.00 -> Rs 10.00 (hand-calculated), both bills listed', async () => {
    const { s, p, purchase } = await setup(10000);
    expect(pool(s, p.id)).toEqual({ qty: 20, value: 30000 }); // 10 @ 10.00 + 10 @ 20.00 => 15.00
    // replacement: 4 packs of 5 = 20 units for Rs 200.00 (Rs 10.00 a unit)
    const r = await correct(s, purchase.id, rep(p, 20000, 4, 5));
    expect(r.status).toBe(201);
    expect(r.body.replacement.items[0]).toMatchObject({ packs: 4, packSize: 5, units: 20, lineTotalCents: 20000, unitCostCents: 1000 });
    // void: 10 units / Rs 200.00 leave -> 10 / Rs 100.00; replacement +20 / Rs 200.00 => 30 units / Rs 300.00 => Rs 10.00 a unit
    expect(pool(s, p.id)).toEqual({ qty: 30, value: 30000 });
    expect(r.body.comparison.lines).toEqual([{ productId: p.id, originalQty: 10, replacementQty: 20, originalLineTotalCents: 20000, replacementLineTotalCents: 20000 }]);
    expect(r.body.comparison.differenceTotalCents).toBe(0);
    // a sale AFTER the correction is costed at the new average; the old sale snapshots are not touched
    const sale = await sellOk(s, [cl(p.id, 3, 100000)], { businessDate: D(1) });
    expect(sql(s, 'SELECT unit_cost_cents FROM sale_items WHERE sale_id = ?', sale.sales[0].id)[0]!.unit_cost_cents).toBe(1000);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('correcting the book: a Shop bill replaced by a Telecom bill moves the cash between the books and the stock between the products', async () => {
    const { s, p, purchase } = await setup(10000);
    const t = await mkTelecom(s);
    const r = await correct(s, purchase.id, { items: [{ productId: t.id, packs: 1, packSize: 10, lineTotalCents: 20000 }], clientRef: ref() });
    expect(r.status).toBe(201);
    expect(r.body.replacement.book).toBe('telecom');
    expect(pool(s, p.id)).toEqual({ qty: 10, value: 10000 });
    expect(pool(s, t.id)).toEqual({ qty: 10, value: 20000 });
    expect(state(s)).toMatchObject({ shop: 1_000_000 - 10000, telecom: 1_000_000 - 20000 });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a zero-value (free goods) replacement writes no cash entry, and the original payment is reversed', async () => {
    const { s, p, purchase } = await setup(10000);
    const r = await correct(s, purchase.id, rep(p, 0));
    expect(r.status).toBe(201);
    expect(pool(s, p.id)).toEqual({ qty: 20, value: 10000 });
    expect(state(s).shop).toBe(1_000_000 - 10000);
    expect(allProblems(s.ctx)).toEqual([]);
  });
});
