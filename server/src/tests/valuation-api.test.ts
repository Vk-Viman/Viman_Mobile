// Stock valuation report (GET /inventory/valuation) - API level (Fastify inject, real temp database).
// Protects the owner's "how much is my stock worth?" figure: value = the weighted-average pool value (BUSINESS_RULES
// section 3, a cost figure - never the selling price, C12), grouped by book (shop / telecom, section 0), with the
// average per unit computed by mulDivRound (R0). Also protects the "as of a past date" view, which follows BUSINESS dates
// (R7: reports follow business date) while the cost of each movement was fixed at posting time.
// Organised as: live valuation (shape, filters, validation), as-of valuation with a hand-derived timeline, and a final
// check that the report equals the product cache and the movement ledger after a busy mixed sequence.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, mkTelecom, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { drawNew, err, lossNew, num, poolOf, reconOk, sql, stComplete, stDraft } from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const bl = (productId: number, units: number, lineTotalCents: number) => ({ productId, packs: 1, packSize: units, lineTotalCents });
// Calls the valuation report; row() finds one product's line by name.
const val = async (s: ApiBase, qs = '') => (await get(s.app, `/inventory/valuation${qs ? `?${qs}` : ''}`)).body;
const row = (v: any, name: string) => v.items.find((i: any) => i.name === name);

// Exact field list of one report line (contract check).
const ITEM_KEYS = ['active', 'avgUnitCostCents', 'book', 'categoryId', 'categoryName', 'code', 'name', 'productId', 'qty', 'valueCents'];

// (Hand totals of this fixture: shop 20 + 3 + 7 + 2 = 32 units; value 700,000 + 1,000 + 10,000 + 5 = 711,005;
// telecom 10 / 50,000; all together 42 units / 761,005. Cherry has no stock and the service has no stock pool.)
/** shop: apple 20/700000, Banana 3/1000, Date 7/10000 (inactive), Half 2/5, cherry 0/0; telecom: Zed 10/50000; plus a service product. */
async function catalog(s: ApiBase) {
  const apple = await mkProduct(s, { name: 'apple', code: 'A-1' });
  await buy(s, [bl(apple.id, 10, 300000)]);
  await buy(s, [bl(apple.id, 10, 400000)]);
  const banana = await mkProduct(s, { name: 'Banana', categoryId: s.ids['Snacks and Drinks'] });
  await buy(s, [bl(banana.id, 3, 1000)]);
  const date = await mkProduct(s, { name: 'Date' });
  await buy(s, [bl(date.id, 7, 10000)]);
  s.ctx.database.conn.prepare('UPDATE products SET active = 0 WHERE id = ?').run(date.id);
  const half = await mkProduct(s, { name: 'Half' });
  await buy(s, [bl(half.id, 2, 5)]);
  const cherry = await mkProduct(s, { name: 'cherry' });
  const zed = await mkTelecom(s, { name: 'Zed Card' });
  await buy(s, [bl(zed.id, 10, 50000)]);
  await mkProduct(s, { name: 'Repair service', kind: 'service' });
  return { apple, banana, date, half, cherry, zed };
}

// The report for today's stock: which products appear, how they are ordered and totalled.
describe('GET /inventory/valuation - live', () => {
  // Both books always appear in the totals, even when empty, so the screen never has to guess.
  it('empty database: no items, zero totals, byBook always has shop and telecom, asOf null', async () => {
    const s = await setup();
    const r = await get(s.app, '/inventory/valuation');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      asOf: null, items: [],
      totals: { qty: 0, valueCents: 0, byBook: { shop: { qty: 0, valueCents: 0 }, telecom: { qty: 0, valueCents: 0 } } },
    });
  });

  // Averages use half-away-from-zero rounding: Banana 1,000/3 = 333.33 -> 333; Date 10,000/7 = 1,428.57 -> 1,429;
  // Half 5/2 = 2.5 -> 3. Totals must equal the sum of the lines. Services and zero-stock products are hidden by default.
  it('shape, case-insensitive name order, services and zero-stock products hidden, averages via mulDivRound, totals = sum of items', async () => {
    const s = await setup();
    const c = await catalog(s);
    const v = await val(s);
    expect(v.asOf).toBeNull();
    expect(v.items.map((i: any) => i.name)).toEqual(['apple', 'Banana', 'Date', 'Half', 'Zed Card']); // not binary order (Banana, Date, Half, Zed Card, apple)
    expect(Object.keys(v.items[0]).sort()).toEqual(ITEM_KEYS);
    expect(row(v, 'apple')).toMatchObject({
      productId: c.apple.id, code: 'A-1', categoryName: 'Electronics', book: 'shop', active: true, qty: 20, valueCents: 700000, avgUnitCostCents: 35000,
    });
    expect(row(v, 'Banana')).toMatchObject({ categoryName: 'Snacks and Drinks', qty: 3, valueCents: 1000, avgUnitCostCents: 333 });   // 333.33
    expect(row(v, 'Date')).toMatchObject({ active: false, qty: 7, valueCents: 10000, avgUnitCostCents: 1429 });                          // 1428.57
    expect(row(v, 'Half')).toMatchObject({ qty: 2, valueCents: 5, avgUnitCostCents: 3 });                                                // 2.5 -> 3
    expect(row(v, 'Zed Card')).toMatchObject({ book: 'telecom', categoryName: 'Scratch Cards', qty: 10, valueCents: 50000, avgUnitCostCents: 5000, code: null });
    expect(v.totals).toEqual({
      qty: 42, valueCents: 761005,
      byBook: { shop: { qty: 32, valueCents: 711005 }, telecom: { qty: 10, valueCents: 50000 } },
    });
    expect(v.items.reduce((a: number, i: any) => a + i.qty, 0)).toBe(v.totals.qty);
    expect(v.items.reduce((a: number, i: any) => a + i.valueCents, 0)).toBe(v.totals.valueCents);
  });

  // Optional views: show products with no stock (no average exists -> null), or hide inactive ones.
  // Inactive Date (7 / 10,000) removed: 42 - 7 = 35 units, 761,005 - 10,000 = 751,005.
  it('includeZero shows empty products with avgUnitCostCents null; includeInactive=false hides inactive ones', async () => {
    const s = await setup();
    await catalog(s);
    const z = await val(s, 'includeZero=true');
    expect(z.items.map((i: any) => i.name)).toEqual(['apple', 'Banana', 'cherry', 'Date', 'Half', 'Zed Card']);
    expect(row(z, 'cherry')).toMatchObject({ qty: 0, valueCents: 0, avgUnitCostCents: null });
    expect(z.totals).toEqual((await val(s)).totals);
    expect((await val(s, 'includeZero=false')).items).toHaveLength(5);
    const ni = await val(s, 'includeInactive=false');
    expect(ni.items.map((i: any) => i.name)).toEqual(['apple', 'Banana', 'Half', 'Zed Card']);
    expect(ni.totals).toEqual({ qty: 35, valueCents: 751005, byBook: { shop: { qty: 25, valueCents: 701005 }, telecom: { qty: 10, valueCents: 50000 } } });
    expect((await val(s, 'includeInactive=true')).items).toHaveLength(5);
    const both = await val(s, 'includeInactive=false&includeZero=true');
    expect(both.items.map((i: any) => i.name)).toEqual(['apple', 'Banana', 'cherry', 'Half', 'Zed Card']);
  });

  // Filtering by book keeps both books in byBook (the other at zero). Shop only: 32 units / 711,005; telecom only: 10 / 50,000.
  it('filters by book and categoryId; byBook keeps both books (the other one zero)', async () => {
    const s = await setup();
    await catalog(s);
    const t = await val(s, 'book=telecom');
    expect(t.items.map((i: any) => i.name)).toEqual(['Zed Card']);
    expect(t.totals).toEqual({ qty: 10, valueCents: 50000, byBook: { shop: { qty: 0, valueCents: 0 }, telecom: { qty: 10, valueCents: 50000 } } });
    const sh = await val(s, 'book=shop');
    expect(sh.items).toHaveLength(4);
    expect(sh.totals).toEqual({ qty: 32, valueCents: 711005, byBook: { shop: { qty: 32, valueCents: 711005 }, telecom: { qty: 0, valueCents: 0 } } });
    const cat = await val(s, `categoryId=${s.ids['Snacks and Drinks']}`);
    expect(cat.items.map((i: any) => i.name)).toEqual(['Banana']);
    expect(cat.totals.qty).toBe(3);
    expect((await val(s, `categoryId=${s.ids['Scratch Cards']}&book=telecom`)).items.map((i: any) => i.name)).toEqual(['Zed Card']);
    expect((await val(s, `categoryId=${s.ids['Scratch Cards']}&book=shop`)).items).toEqual([]);
    expect((await val(s, 'categoryId=99999')).items).toEqual([]);
  });

  // Impossible or malformed dates and non-boolean flags are refused, naming the field.
  it('bad query values -> 400 (including impossible and malformed asOf with fields.asOf)', async () => {
    const s = await setup();
    for (const q of ['asOf=2026-02-31', 'asOf=abc', 'asOf=2026-1-1', 'asOf=20260101', 'asOf=2026-13-01']) {
      const r = await get(s.app, `/inventory/valuation?${q}`);
      expect(r.status, q).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(err(r).fields.asOf, q).toBeTruthy();
    }
    for (const q of ['includeZero=yes', 'includeInactive=1', 'categoryId=abc', 'book=icecream', 'foo=bar']) {
      expect((await get(s.app, `/inventory/valuation?${q}`)).status, q).toBe(400);
    }
  });
});

// =============================================================================================
// "What was my stock worth on date D?" - rebuilt from movements by BUSINESS date (R7), using the cost each movement was
// posted with. Later or backdated entries therefore change history only from their own business date onward.
describe('GET /inventory/valuation?asOf= (business-date basis)', () => {
  /**
   * X: purchase 10 for 100000 dated D-10, purchase 10 for 300000 dated D-5, then (posted later) a loss of 5 dated D-7:
   *    at posting the pool is 20/400000 (avg 20000), so the loss removes 100000 -> 15/300000; then a purchase 5 for 50000 today.
   * Y: purchase 4 for 8000 dated D-3.
   */
  async function timeline(s: ApiBase) {
    const x = await mkProduct(s, { name: 'X item' });
    const y = await mkProduct(s, { name: 'Y item' });
    await buy(s, [bl(x.id, 10, 100000)], { businessDate: daysAgo(10) });
    await buy(s, [bl(x.id, 10, 300000)], { businessDate: daysAgo(5) });
    const loss = await lossNew(s, x.id, 5, { businessDate: daysAgo(7) });
    expect(loss.body.item.costCents).toBe(100000);
    await buy(s, [bl(x.id, 5, 50000)]);
    await buy(s, [bl(y.id, 4, 8000)], { businessDate: daysAgo(3) });
    expect(poolOf(s, x.id)).toEqual({ qty: 20, value: 350000 });
    return { x, y };
  }
  const at = (v: any, name: string) => row(v, name);

  // Walk through the timeline day by day (see the fixture comment): D-10: 10 / 100,000; D-7 backdated loss of 5 is valued at
  // what the pool average was WHEN IT WAS POSTED (20 units / 400,000 -> 5 x 20,000 = 100,000), so on D-7 the report shows 5 units / 0;
  // D-5: +10 / 300,000 -> 15 / 300,000; D-3: product Y 4 / 8,000 -> totals 19 / 308,000; today: X 20 / 350,000 + Y 4 / 8,000 = 24 / 358,000.
  // A future date shows the same as today.
  it('before / at / after each movement matches the hand-derived sums', async () => {
    const s = await setup();
    await timeline(s);
    // before everything
    let v = await val(s, `asOf=${daysAgo(11)}`);
    expect(v.items).toEqual([]);
    expect(v.totals).toEqual({ qty: 0, valueCents: 0, byBook: { shop: { qty: 0, valueCents: 0 }, telecom: { qty: 0, valueCents: 0 } } });
    expect(v.asOf).toBe(daysAgo(11));
    expect((await val(s, `asOf=${daysAgo(11)}&includeZero=true`)).items.map((i: any) => [i.name, i.qty, i.valueCents, i.avgUnitCostCents])).toEqual([
      ['X item', 0, 0, null], ['Y item', 0, 0, null],
    ]);
    // on / after the first purchase (D-10)
    for (const d of [10, 9, 8]) {
      v = await val(s, `asOf=${daysAgo(d)}`);
      expect(at(v, 'X item'), `D-${d}`).toMatchObject({ qty: 10, valueCents: 100000, avgUnitCostCents: 10000 });
      expect(at(v, 'Y item')).toBeUndefined();
    }
    // on the backdated loss (D-7): 10 - 5 = 5 units, value 100000 - 100000 = 0 (loss was costed at posting-time average)
    for (const d of [7, 6]) {
      v = await val(s, `asOf=${daysAgo(d)}`);
      expect(at(v, 'X item'), `D-${d}`).toMatchObject({ qty: 5, valueCents: 0, avgUnitCostCents: 0 });
      expect(v.totals).toMatchObject({ qty: 5, valueCents: 0 });
    }
    // on the second purchase (D-5): 5 + 10 = 15, 0 + 300000
    for (const d of [5, 4]) {
      v = await val(s, `asOf=${daysAgo(d)}`);
      expect(at(v, 'X item'), `D-${d}`).toMatchObject({ qty: 15, valueCents: 300000, avgUnitCostCents: 20000 });
      expect(v.totals.qty).toBe(15);
    }
    // Y arrives D-3
    for (const d of [3, 2, 1]) {
      v = await val(s, `asOf=${daysAgo(d)}`);
      expect(at(v, 'X item')).toMatchObject({ qty: 15, valueCents: 300000 });
      expect(at(v, 'Y item')).toMatchObject({ qty: 4, valueCents: 8000, avgUnitCostCents: 2000 });
      expect(v.totals).toMatchObject({ qty: 19, valueCents: 308000 });
      expect(v.totals.byBook.shop).toEqual({ qty: 19, valueCents: 308000 });
    }
    // today and the future: the live pool (X 20/350000 after today's purchase)
    for (const d of [today(), daysAhead(1), '2999-12-31']) {
      v = await val(s, `asOf=${d}`);
      expect(v.asOf).toBe(d);
      expect(at(v, 'X item'), d).toMatchObject({ qty: 20, valueCents: 350000, avgUnitCostCents: 17500 });
      expect(v.totals).toMatchObject({ qty: 24, valueCents: 358000 });
    }
    expect((await val(s)).totals).toEqual((await val(s, `asOf=${daysAhead(30)}`)).totals);
  });

  // Filters still apply to the historical view: telecom card bought on D-6 (10 / 50,000) plus X (5 units / 0) = 15 / 50,000.
  it('asOf honours book / category / includeInactive filters', async () => {
    const s = await setup();
    const { x } = await timeline(s);
    const t = await mkTelecom(s, { name: 'Tel card' });
    await buy(s, [bl(t.id, 10, 50000)], { businessDate: daysAgo(6) });
    const v = await val(s, `asOf=${daysAgo(6)}&book=telecom`);
    expect(v.items.map((i: any) => i.name)).toEqual(['Tel card']);
    expect(v.totals.byBook).toEqual({ shop: { qty: 0, valueCents: 0 }, telecom: { qty: 10, valueCents: 50000 } });
    const all = await val(s, `asOf=${daysAgo(6)}`);
    expect(all.totals).toMatchObject({ qty: 15, valueCents: 50000 });  // X 5/0 + Tel 10/50000
    s.ctx.database.conn.prepare('UPDATE products SET active = 0 WHERE id = ?').run(x.id);
    expect((await val(s, `asOf=${daysAgo(6)}&includeInactive=false`)).items.map((i: any) => i.name)).toEqual(['Tel card']);
  });

  // Hand calculation: buy 10 for 300,000 (D-9); stocktake D-4 counts 8: loss 2 x 30,000 = 60,000 -> 8 / 240,000;
  // goods drawing D-2 of 3 units = 3 x 30,000 = 90,000 -> 5 / 150,000. Each shows only from its own business date.
  it('a stocktake and a goods drawing, both backdated, are visible from their business date', async () => {
    const s = await setup();
    const p = await mkProduct(s, { name: 'Counted' });
    await buy(s, [bl(p.id, 10, 300000)], { businessDate: daysAgo(9) });            // 10 / 300000
    const st = await stDraft(s, [{ productId: p.id, countedQty: 8 }], { businessDate: daysAgo(4) });
    expect((await stComplete(s, st.id)).status).toBe(200);                         // loss 2 = 60000 -> 8 / 240000 dated D-4
    expect((await drawNew(s, p.id, 3, { businessDate: daysAgo(2) })).status).toBe(201); // 3 x 30000 = 90000 -> 5 / 150000 dated D-2
    const q = async (d: number) => at(await val(s, `asOf=${daysAgo(d)}`), 'Counted');
    expect(await q(9)).toMatchObject({ qty: 10, valueCents: 300000 });
    expect(await q(5)).toMatchObject({ qty: 10, valueCents: 300000 });
    expect(await q(4)).toMatchObject({ qty: 8, valueCents: 240000, avgUnitCostCents: 30000 });
    expect(await q(3)).toMatchObject({ qty: 8, valueCents: 240000 });
    expect(await q(2)).toMatchObject({ qty: 5, valueCents: 150000, avgUnitCostCents: 30000 });
    expect(at(await val(s), 'Counted')).toMatchObject({ qty: 5, valueCents: 150000 });
    await reconOk(s);
  });
});

// =============================================================================================
// Three independent views of stock must agree: the report, the product cache and the sum of movements.
describe('valuation equals the live pool', () => {
  // Alpha: 10 / 300,000 + 10 / 400,000 = 20 / 700,000 (loss of 3 = 105,000 later voided, so back to 20 / 700,000).
  // beta: 6 / 9,000; drawing 2 = 3,000 (voided); loss of 1 = 1,500 -> 5 / 7,500.  Card: 20 / 100,000; stocktake loss 2 = 10,000 -> 18 / 90,000.
  // Shop 25 units / 707,500 + telecom 18 / 90,000 = 43 units / 797,500.
  it('after a mixed sequence of purchases, stocktakes, losses, drawings and voids: items = products cache = movement sums', async () => {
    const s = await setup();
    const a = await mkProduct(s, { name: 'Alpha' });
    const b = await mkProduct(s, { name: 'beta' });
    const t = await mkTelecom(s, { name: 'Card' });
    await buy(s, [bl(a.id, 10, 300000), bl(b.id, 6, 9000)]);
    await buy(s, [bl(t.id, 20, 100000)]);
    await buy(s, [bl(a.id, 10, 400000)], { businessDate: daysAgo(2) });
    const l = await lossNew(s, a.id, 3);                                  // 105000
    const d = await drawNew(s, b.id, 2);                                  // 3000
    const st = await stDraft(s, [{ productId: t.id, countedQty: 18 }], { book: 'telecom' }); // loss 2 = 10000
    await stComplete(s, st.id);
    await post(s.app, `/stock-losses/${l.body.item.id}/void`, { reason: 'x' });
    await post(s.app, `/drawings/${d.body.item.id}/void`, { reason: 'x' });
    await lossNew(s, b.id, 1, { businessDate: daysAgo(1) });              // 1500
    const v = await val(s, 'includeZero=true');
    const products = (await get(s.app, '/products?limit=200')).body.items;
    for (const p of products) {
      expect(row(v, p.name), p.name).toMatchObject({ qty: p.qtyOnHand, valueCents: p.stockValueCents });
    }
    expect(row(v, 'Alpha')).toMatchObject({ qty: 20, valueCents: 700000 });
    expect(row(v, 'beta')).toMatchObject({ qty: 5, valueCents: 7500 });
    expect(row(v, 'Card')).toMatchObject({ qty: 18, valueCents: 90000 });
    const ledger = sql(s, 'SELECT product_id, SUM(qty_delta) AS q, SUM(value_delta_cents) AS v FROM stock_movements GROUP BY product_id');
    for (const r of ledger) {
      const p = products.find((x: any) => x.id === Number(r.product_id));
      expect(row(v, p.name)).toMatchObject({ qty: Number(r.q), valueCents: Number(r.v) });
    }
    expect(v.totals).toEqual({
      qty: 43, valueCents: 797500,
      byBook: { shop: { qty: 25, valueCents: 707500 }, telecom: { qty: 18, valueCents: 90000 } },
    });
    expect(num(s, 'SELECT SUM(stock_value_cents) FROM products')).toBe(797500);
    // the "as of today" view is the same figures
    expect((await val(s, `asOf=${today()}&includeZero=true`)).items).toEqual(v.items);
    await reconOk(s);
  });
});
