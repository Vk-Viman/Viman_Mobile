// PHASE 24 - "correct this entry" for GOODS PERSONAL USE (owner_drawings, kind goods; API_CONTRACTS.md "Correction contract, Phase 2").
// The same /drawings/:id/correct* endpoints as the cash drawings (Phase 1). The eleven groups: success (= manual void + manual create,
// to the cent, stock ledger and pools), atomic failure, void-side refusal, closed day / backdating, negative stock refused (and no cash
// warnings), replay, concurrency, check/preview, already-void, type-specific refusals and chains. Cost drift and kind rules: see
// phase24-correct-goods-cost.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { closeOk } from './helpers/phase8.ts';
import { seedBooks, state } from './helpers/phase9.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const D = (n: number) => daysAgo(n);
interface W extends ApiBase { p: any }

/** Seeded books and a product with an old purchase of 10 units for Rs 100.00 (average Rs 10.00). */
async function world(): Promise<W> {
  const s = await apiBase(await env.build());
  await seedBooks(s, { shop: 1_000_000, telecom: 1_000_000, cost: 1_000_000 }, D(20));
  const p = await mkProduct(s);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: D(8) });
  return Object.assign(s, { p });
}
/** A goods drawing of 4 units (cost Rs 40.00) and its replacement of 5 units (Rs 50.00 while the average is Rs 10.00). */
const make = (w: W, o: Record<string, unknown> = {}) =>
  post(w.app, '/drawings', { kind: 'goods', businessDate: D(2), productId: w.p.id, qty: 4, note: 'for home', clientRef: ref(), ...o });
const replacement = (w: W, o: Record<string, unknown> = {}) => ({ kind: 'goods', productId: w.p.id, qty: 5, note: 'fixed', clientRef: ref(), ...o });
const made = async (w: W, o: Record<string, unknown> = {}) => {
  const r = await make(w, o);
  if (r.status !== 201) throw new Error(`make failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
};
const correct = (s: ApiBase, id: number, rep: Record<string, unknown>, reason = 'counted wrong') => post(s.app, `/drawings/${id}/correct`, { reason, replacement: rep });
const preview = (s: ApiBase, id: number, rep: Record<string, unknown>, reason = 'counted wrong') => post(s.app, `/drawings/${id}/correct-preview`, { reason, replacement: rep });
const check = (s: ApiBase, id: number) => get(s.app, `/drawings/${id}/correct-check`);
const row = (s: ApiBase, id: number) => sql(s, 'SELECT * FROM owner_drawings WHERE id = ?', id)[0]!;
const pool = (s: ApiBase, id: number) => {
  const r = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
};
const ledger = (s: ApiBase) => ({
  cash: sql(s, 'SELECT book, type, amount_cents, business_date FROM cash_entries ORDER BY id'),
  stock: sql(s, 'SELECT product_id, type, qty_delta, value_delta_cents, unit_cost_cents, business_date, reverses_movement_id IS NOT NULL AS rev FROM stock_movements ORDER BY id'),
  products: sql(s, 'SELECT id, qty_on_hand, stock_value_cents FROM products ORDER BY id'),
  drawings: sql(s, 'SELECT kind, book, amount_cents, product_id, qty, business_date, status FROM owner_drawings ORDER BY id'),
  state: state(s),
});

describe('correct goods personal use', () => {
  it('1. success: original void with the reason, replacement posted, link row, both listed; equals manual void + manual create (stock ledger and pool)', async () => {
    const a = await world();
    const o = await made(a);
    expect(o.amountCents).toBe(4000);
    expect(pool(a, a.p.id)).toEqual({ qty: 6, value: 6000 });
    const r = await correct(a, o.id, replacement(a));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['comparison', 'correction', 'original', 'replacement', 'warnings']);
    expect(r.body.original).toMatchObject({ id: o.id, status: 'void', voidReason: 'counted wrong', kind: 'goods' });
    expect(r.body.replacement).toMatchObject({ status: 'posted', kind: 'goods', businessDate: D(2), qty: 5, amountCents: 5000, note: 'fixed', book: 'shop' });
    expect(r.body.replacement.id).toBeGreaterThan(o.id);
    expect(r.body.correction).toMatchObject({ entity: 'owner_drawings', originalId: o.id, replacementId: r.body.replacement.id, reason: 'counted wrong' });
    expect(r.body.warnings).toEqual([]);
    expect(sql(a, 'SELECT * FROM corrections')).toHaveLength(1);
    expect((await get(a.app, `/corrections?entity=owner_drawings&ids=${o.id}`)).body.items).toHaveLength(1);
    const list = (await get(a.app, '/drawings?limit=200')).body.items;
    expect(list.map((i: any) => [i.id, i.status]).sort()).toEqual([[o.id, 'void'], [r.body.replacement.id, 'posted']].sort());
    // stock: the void gives the 4 units back at Rs 40.00 (pool 10 / Rs 100.00), the replacement takes 5 at the average Rs 10.00 = Rs 50.00
    expect(pool(a, a.p.id)).toEqual({ qty: 5, value: 5000 });
    expect(r.body.comparison).toEqual({ originalCostCents: 4000, replacementCostCents: 5000, differenceCents: 1000 });
    expect(state(a).shop).toBe(1_000_000 - 10000); // personal use moves no cash
    expect(allProblems(a.ctx)).toEqual([]);

    const b = await world();
    const o2 = await made(b);
    expect((await post(b.app, `/drawings/${o2.id}/void`, { reason: 'counted wrong' })).status).toBe(200);
    expect((await post(b.app, '/drawings', { ...replacement(b), businessDate: D(2) })).status).toBe(201);
    expect(ledger(a)).toEqual(ledger(b));
    expect(allProblems(b.ctx)).toEqual([]);
  });

  it('1b. an explicit businessDate on the replacement is honoured; the original keeps its own date', async () => {
    const w = await world();
    const o = await made(w);
    const r = await correct(w, o.id, replacement(w, { businessDate: D(1) }));
    expect(r.status).toBe(201);
    expect(r.body.replacement.businessDate).toBe(D(1));
    expect(r.body.original.businessDate).toBe(D(2));
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('1c. the product can be changed: the stock of the old product returns, the new product is taken', async () => {
    const w = await world();
    const q = await mkProduct(w);
    await buy(w, [{ productId: q.id, packs: 1, packSize: 5, lineTotalCents: 2500 }], { businessDate: D(8) });
    const o = await made(w);
    const r = await correct(w, o.id, replacement(w, { productId: q.id, qty: 2 }));
    expect(r.status).toBe(201);
    expect(pool(w, w.p.id)).toEqual({ qty: 10, value: 10000 });
    expect(pool(w, q.id)).toEqual({ qty: 3, value: 1500 }); // average Rs 5.00, 2 units = Rs 10.00
    expect(r.body.comparison).toEqual({ originalCostCents: 4000, replacementCostCents: 1000, differenceCents: -3000 });
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('2. atomic failure: a replacement the CREATE refuses leaves the original posted and the database unchanged', async () => {
    const w = await world();
    const o = await made(w);
    const svc = await mkProduct(w, { kind: 'service' });
    const before = fingerprint(w.ctx);
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ qty: 1000 }, 422, 'INSUFFICIENT_STOCK'],
      [{ productId: svc.id }, 400, 'PRODUCT_NOT_STOCKABLE'],
      [{ productId: 99999 }, 400, 'VALIDATION_ERROR'],
      [{ book: 'shop' }, 400, 'VALIDATION_ERROR'],
      [{ amountCents: 100 }, 400, 'VALIDATION_ERROR'],
      [{ businessDate: '2999-01-01' }, 400, 'FUTURE_DATE_NOT_ALLOWED'],
    ];
    for (const [over, status, code] of cases) {
      const r = await correct(w, o.id, replacement(w, over));
      expect([r.status, r.body.error.code]).toEqual([status, code]);
      expect(fingerprint(w.ctx)).toBe(before);
    }
    const noProduct: any = replacement(w); delete noProduct.productId;
    expect((await correct(w, o.id, noProduct)).body.error.code).toBe('VALIDATION_ERROR');
    expect(fingerprint(w.ctx)).toBe(before);
    expect(row(w, o.id).status).toBe('posted');
    expect(count(w.ctx, 'corrections')).toBe(0);
    expect(pool(w, w.p.id)).toEqual({ qty: 6, value: 6000 });
  });

  it('2b. a reused clientRef of another record is refused 409 CLIENT_REF_CONFLICT and nothing changes', async () => {
    const w = await world();
    const o = await made(w);
    const other = await made(w);
    const before = fingerprint(w.ctx);
    const r = await correct(w, o.id, replacement(w, { clientRef: other.clientRef }));
    expect([r.status, r.body.error.code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
    const same = await correct(w, o.id, replacement(w, { clientRef: o.clientRef }));
    expect([same.status, same.body.error.code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
    expect(fingerprint(w.ctx)).toBe(before);
  });

  it('2c. body validation: reason and clientRef are required, extra fields refused, unknown id is 404', async () => {
    const w = await world();
    const o = await made(w);
    const before = fingerprint(w.ctx);
    const noRef: any = replacement(w); delete noRef.clientRef;
    expect((await correct(w, o.id, noRef)).status).toBe(400);
    expect((await post(w.app, `/drawings/${o.id}/correct`, { replacement: replacement(w) })).status).toBe(400);
    expect((await correct(w, o.id, replacement(w), '   ')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await correct(w, o.id, replacement(w, { bogus: 1 }))).status).toBe(400);
    for (const r of [await correct(w, 99999, replacement(w)), await preview(w, 99999, replacement(w)), await check(w, 99999)]) {
      expect([r.status, r.body.error.code]).toEqual([404, 'NOT_FOUND']);
    }
    expect(fingerprint(w.ctx)).toBe(before);
  });

  it('3. void-side refusal (original on a closed day): refused with the void\'s own code, database unchanged', async () => {
    const w = await world();
    const o = await made(w, { businessDate: D(4) });
    await closeOk(w, 'shop', D(4));
    const before = fingerprint(w.ctx);
    const r = await correct(w, o.id, replacement(w));
    expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    expect(fingerprint(w.ctx)).toBe(before);
    expect(row(w, o.id).status).toBe('posted');
    expect((await post(w.app, `/drawings/${o.id}/void`, { reason: 'x' })).body.error.code).toBe('DAY_CLOSED');
  });

  it('4. closed day (R9) and BACKDATE_BEFORE_CLOSED_DAY behave as for a manual void + create', async () => {
    const w = await world();
    const early = await made(w, { businessDate: D(5) });
    await closeOk(w, 'shop', D(3));
    let before = fingerprint(w.ctx);
    let r = await correct(w, early.id, replacement(w));
    expect([r.status, r.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    expect(fingerprint(w.ctx)).toBe(before);
    const late = await made(w, { businessDate: D(1) });
    before = fingerprint(w.ctx);
    r = await correct(w, late.id, replacement(w, { businessDate: D(3) }));
    expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    r = await correct(w, late.id, replacement(w, { businessDate: D(4) }));
    expect([r.status, r.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    expect(fingerprint(w.ctx)).toBe(before);
    expect(row(w, late.id).status).toBe('posted');
    r = await correct(w, late.id, replacement(w, { businessDate: D(2) }));
    expect(r.status).toBe(201);
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('5. stock: taking more than is on hand is refused as for a manual create (INSUFFICIENT_STOCK, nothing changes); the units the void returns count as available', async () => {
    const w = await world();
    const o = await made(w); // 6 units left
    const before = fingerprint(w.ctx);
    const tooMany = await correct(w, o.id, replacement(w, { qty: 11 })); // only 10 exist even after the original is cancelled
    expect([tooMany.status, tooMany.body.error.code]).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect((await preview(w, o.id, replacement(w, { qty: 11 }))).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(fingerprint(w.ctx)).toBe(before);
    // 9 units is more than the 6 on hand now, but the 4 returned by the void make 10 available: allowed, exactly as manual void + create
    const r = await correct(w, o.id, replacement(w, { qty: 9 }));
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([]); // no cash moves, so no negative-cash warning exists for goods
    expect(pool(w, w.p.id)).toEqual({ qty: 1, value: 1000 });
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('6. double submit with the same replacement clientRef: 200 replay (with comparison), exactly one replacement, no second void', async () => {
    const w = await world();
    const o = await made(w);
    const rep = replacement(w);
    const first = await correct(w, o.id, rep);
    expect(first.status).toBe(201);
    const total = count(w.ctx, 'owner_drawings');
    const fp = fingerprint(w.ctx);
    const again = await correct(w, o.id, rep);
    expect(again.status).toBe(200);
    expect(Object.keys(again.body).sort()).toEqual(['comparison', 'correction', 'original', 'replacement', 'warnings']);
    expect(again.body.replacement.id).toBe(first.body.replacement.id);
    expect(again.body.correction.id).toBe(first.body.correction.id);
    expect(again.body.comparison).toEqual(first.body.comparison);
    expect(again.body.original).toMatchObject({ id: o.id, status: 'void' });
    expect(count(w.ctx, 'owner_drawings')).toBe(total);
    expect(fingerprint(w.ctx)).toBe(fp);
    const other = await made(w);
    const clash = await correct(w, other.id, rep);
    expect([clash.status, clash.body.error.code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
  });

  it('7. two concurrent corrections of the same original: exactly one succeeds, the other gets 409', async () => {
    const w = await world();
    const o = await made(w);
    const [a, b] = await Promise.all([correct(w, o.id, replacement(w)), correct(w, o.id, replacement(w))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body.error.code).toBe('ALREADY_VOID');
    expect(count(w.ctx, 'corrections')).toBe(1);
    expect(sql(w, "SELECT * FROM owner_drawings WHERE status = 'posted' AND id > ?", o.id)).toHaveLength(1);
    expect(pool(w, w.p.id)).toEqual({ qty: 5, value: 5000 });
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('8. correct-check and correct-preview save nothing and agree with the real call', async () => {
    const w = await world();
    const o = await made(w);
    const before = fingerprint(w.ctx);
    expect((await check(w, o.id)).body).toEqual({ eligible: true });
    const rep = replacement(w);
    const p = await preview(w, o.id, rep);
    expect(p.status).toBe(200);
    expect(Object.keys(p.body).sort()).toEqual(['comparison', 'original', 'replacement', 'warnings']);
    expect(p.body.original.status).toBe('void');
    expect(fingerprint(w.ctx)).toBe(before);
    const r = await correct(w, o.id, rep);
    expect(r.status).toBe(201);
    const strip = (x: any) => { const { id, postedAt, voidedAt, ...rest } = x; return rest; };
    expect(strip(r.body.replacement)).toEqual(strip(p.body.replacement));
    expect(strip(r.body.original)).toEqual(strip(p.body.original));
    expect(r.body.warnings).toEqual(p.body.warnings);
    expect(r.body.comparison).toEqual(p.body.comparison);
    const o2 = await made(w, { businessDate: D(6), qty: 1 });
    await closeOk(w, 'shop', D(6));
    const fp = fingerprint(w.ctx);
    const c = await check(w, o2.id);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ eligible: false, code: 'DAY_CLOSED' });
    expect(typeof c.body.message).toBe('string');
    const pr = await preview(w, o2.id, replacement(w));
    const re = await correct(w, o2.id, replacement(w));
    expect([pr.status, pr.body.error.code, re.status, re.body.error.code]).toEqual([409, 'DAY_CLOSED', 409, 'DAY_CLOSED']);
    expect(fingerprint(w.ctx)).toBe(fp);
    const o3 = await made(w, { qty: 1 });
    const fp3 = fingerprint(w.ctx);
    const pb = await preview(w, o3.id, replacement(w, { qty: 1000 }));
    expect([pb.status, pb.body.error.code]).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect(fingerprint(w.ctx)).toBe(fp3);
  });

  it('9. an already-void original is 409 ALREADY_VOID (check says not eligible)', async () => {
    const w = await world();
    const o = await made(w);
    expect((await post(w.app, `/drawings/${o.id}/void`, { reason: 'oops' })).status).toBe(200);
    const fp = fingerprint(w.ctx);
    expect((await check(w, o.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
    for (const r of [await preview(w, o.id, replacement(w)), await correct(w, o.id, replacement(w))]) {
      expect([r.status, r.body.error.code]).toEqual([409, 'ALREADY_VOID']);
    }
    expect(fingerprint(w.ctx)).toBe(fp);
  });

  it('11. a corrected goods drawing can itself be corrected (chain); the stock reconciles', async () => {
    const w = await world();
    const a = await made(w, { businessDate: D(2) });
    const r1 = await correct(w, a.id, replacement(w));
    expect(r1.status).toBe(201);
    const r2 = await correct(w, r1.body.replacement.id, replacement(w, { qty: 2 }));
    expect(r2.status).toBe(201);
    expect(r2.body.replacement).toMatchObject({ qty: 2, amountCents: 2000, businessDate: D(2) });
    expect(r2.body.comparison).toEqual({ originalCostCents: 5000, replacementCostCents: 2000, differenceCents: -3000 });
    expect((await get(w.app, `/corrections?entity=owner_drawings&ids=${r1.body.replacement.id}`)).body.items).toHaveLength(2);
    expect(row(w, a.id).status).toBe('void');
    expect(row(w, r1.body.replacement.id).status).toBe('void');
    expect(pool(w, w.p.id)).toEqual({ qty: 8, value: 8000 });
    expect((await correct(w, a.id, replacement(w))).body.error.code).toBe('ALREADY_VOID');
    expect(allProblems(w.ctx)).toEqual([]);
  });
});
