// PHASE 24 - "correct this entry" for supplier PURCHASES (API_CONTRACTS.md "Correction contract, Phase 2"). The eleven groups of the Phase 1
// contract: success (= manual void + manual create, to the cent, cash AND stock), atomic failure, void-side refusal, closed day /
// backdating, negative cash stays a warning, replay by clientRef, concurrent corrections, check/preview write nothing and agree with
// the real call, already-void original, type-specific refusals (see phase24-correct-purchases-stock.test.ts), chains.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post, put } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, mkSupplier, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { closeOk } from './helpers/phase8.ts';
import { seedBooks, state } from './helpers/phase9.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const D = (n: number) => daysAgo(n);
interface W extends ApiBase { p: any; q: any }

/** A world with seeded books, two shop products and an old purchase of product p (10 units for Rs 100.00 => average Rs 10.00). */
async function world(): Promise<W> {
  const s = await apiBase(await env.build());
  await seedBooks(s, { shop: 1_000_000, telecom: 1_000_000, cost: 1_000_000 }, D(20));
  const p = await mkProduct(s);
  const q = await mkProduct(s);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: D(8) });
  return Object.assign(s, { p, q });
}

/** The purchase body used by every test: 10 units of p for Rs 200.00 (two packs of five). */
const body = (w: W, o: Record<string, unknown> = {}) => ({
  businessDate: D(2), items: [{ productId: w.p.id, packs: 2, packSize: 5, lineTotalCents: 20000 }], clientRef: ref(), ...o,
});
/** The replacement: 10 units of p for Rs 300.00 (one pack of ten). */
const replacement = (w: W, o: Record<string, unknown> = {}) => ({
  items: [{ productId: w.p.id, packs: 1, packSize: 10, lineTotalCents: 30000 }], clientRef: ref(), ...o,
});
const made = async (w: W, o: Record<string, unknown> = {}) => {
  const r = await post(w.app, '/purchases', body(w, o));
  if (r.status !== 201) throw new Error(`make failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
};
const correct = (s: ApiBase, id: number, rep: Record<string, unknown>, reason = 'typed the wrong cost') =>
  post(s.app, `/purchases/${id}/correct`, { reason, replacement: rep });
const preview = (s: ApiBase, id: number, rep: Record<string, unknown>, reason = 'typed the wrong cost') =>
  post(s.app, `/purchases/${id}/correct-preview`, { reason, replacement: rep });
const check = (s: ApiBase, id: number) => get(s.app, `/purchases/${id}/correct-check`);
const row = (s: ApiBase, id: number) => sql(s, 'SELECT * FROM purchases WHERE id = ?', id)[0]!;
const pool = (s: ApiBase, id: number) => {
  const r = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', id)[0]!;
  return { qty: Number(r.q), value: Number(r.v) };
};
/** Cash, stock and fund ledgers without ids and timestamps: two worlds that did the same business must produce the same lists. */
const ledger = (s: ApiBase) => ({
  cash: sql(s, 'SELECT book, fund, type, amount_cents, business_date, reverses_entry_id IS NOT NULL AS rev FROM cash_entries ORDER BY id'),
  stock: sql(s, 'SELECT product_id, type, qty_delta, value_delta_cents, unit_cost_cents, business_date, reverses_movement_id IS NOT NULL AS rev FROM stock_movements ORDER BY id'),
  products: sql(s, 'SELECT id, qty_on_hand, stock_value_cents FROM products ORDER BY id'),
  state: state(s),
});

describe('correct purchases', () => {
  it('1. success: original void with the reason, replacement posted, link row, both listed; equals manual void + manual create (cash and stock)', async () => {
    const a = await world();
    const sup = await mkSupplier(a);
    const o = await made(a, { supplierId: sup.id, billNo: 'B-1', notes: 'first' });
    expect(pool(a, a.p.id)).toEqual({ qty: 20, value: 30000 }); // 10 @ 100.00 + 10 @ 200.00 => average 15.00
    const r = await correct(a, o.id, replacement(a, { supplierId: sup.id, billNo: 'B-1', notes: 'fixed' }));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['comparison', 'correction', 'original', 'replacement', 'warnings']);
    expect(r.body.original).toMatchObject({ id: o.id, status: 'void', voidReason: 'typed the wrong cost' });
    expect(r.body.replacement).toMatchObject({ status: 'posted', businessDate: D(2), totalCents: 30000, billNo: 'B-1', notes: 'fixed', supplierId: sup.id });
    expect(r.body.replacement.id).toBeGreaterThan(o.id);
    expect(r.body.correction).toMatchObject({ entity: 'purchases', originalId: o.id, replacementId: r.body.replacement.id, reason: 'typed the wrong cost' });
    expect(sql(a, 'SELECT * FROM corrections')).toHaveLength(1);
    expect((await get(a.app, `/corrections?entity=purchases&ids=${o.id}`)).body.items).toHaveLength(1);
    const list = (await get(a.app, '/purchases?limit=200')).body.items.filter((i: any) => i.id >= o.id);
    expect(list.map((i: any) => [i.id, i.status]).sort()).toEqual([[o.id, 'void'], [r.body.replacement.id, 'posted']].sort());
    // weighted average, to the cent: the void removes 10 units at min(Rs 200.00, pool value Rs 300.00) = Rs 200.00 -> 10 units / Rs 100.00;
    // the replacement adds 10 units for Rs 300.00 -> 20 units / Rs 400.00 => average Rs 20.00 (it was Rs 15.00)
    expect(pool(a, a.p.id)).toEqual({ qty: 20, value: 40000 });
    expect(allProblems(a.ctx)).toEqual([]);

    // an identical world that does a manual void followed by a manual create
    const b = await world();
    const sup2 = await mkSupplier(b);
    const o2 = await made(b, { supplierId: sup2.id, billNo: 'B-1', notes: 'first' });
    expect((await post(b.app, `/purchases/${o2.id}/void`, { reason: 'typed the wrong cost' })).status).toBe(200);
    expect((await post(b.app, '/purchases', { ...replacement(b, { supplierId: sup2.id, billNo: 'B-1', notes: 'fixed' }), businessDate: D(2) })).status).toBe(201);
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

  it('1c. comparison: totals and per-product units / line totals (several lines of one product are summed, new products listed)', async () => {
    const w = await world();
    const o = await made(w, { items: [
      { productId: w.p.id, packs: 1, packSize: 4, lineTotalCents: 8000 },
      { productId: w.p.id, packs: 1, packSize: 6, lineTotalCents: 12000 },
      { productId: w.q.id, packs: 1, packSize: 3, lineTotalCents: 900 },
    ] });
    const rep = replacement(w, { items: [
      { productId: w.p.id, packs: 2, packSize: 5, lineTotalCents: 30000 },
      { productId: w.q.id, packs: 1, packSize: 2, lineTotalCents: 5000 },
    ] });
    const p = await preview(w, o.id, rep);
    const r = await correct(w, o.id, rep);
    expect(r.status).toBe(201);
    const expected = {
      originalTotalCents: 20900, replacementTotalCents: 35000, differenceTotalCents: 14100,
      lines: [
        { productId: w.p.id, originalQty: 10, replacementQty: 10, originalLineTotalCents: 20000, replacementLineTotalCents: 30000 },
        { productId: w.q.id, originalQty: 3, replacementQty: 2, originalLineTotalCents: 900, replacementLineTotalCents: 5000 },
      ],
    };
    expect(p.body.comparison).toEqual(expected);
    expect(r.body.comparison).toEqual(expected);
    // a replacement with a different product: the old product shows replacementQty 0, the new one originalQty 0
    const o2 = await made(w);
    const r2 = await correct(w, o2.id, replacement(w, { items: [{ productId: w.q.id, packs: 1, packSize: 7, lineTotalCents: 700 }] }));
    expect(r2.body.comparison.lines).toEqual([
      { productId: w.p.id, originalQty: 10, replacementQty: 0, originalLineTotalCents: 20000, replacementLineTotalCents: 0 },
      { productId: w.q.id, originalQty: 0, replacementQty: 7, originalLineTotalCents: 0, replacementLineTotalCents: 700 },
    ]);
    expect(r2.body.comparison.differenceTotalCents).toBe(700 - 20000);
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('2. atomic failure: a replacement the CREATE refuses leaves the original posted and the database unchanged', async () => {
    const w = await world();
    const o = await made(w);
    const tele = await mkTelecom(w);
    const inactive = await mkSupplier(w);
    expect((await put(w.app, `/suppliers/${inactive.id}`, { active: false })).status).toBe(200);
    const before = fingerprint(w.ctx); // after the set-up records
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ items: [{ productId: w.p.id, packs: 1, packSize: 1, lineTotalCents: 1 }, { productId: tele.id, packs: 1, packSize: 1, lineTotalCents: 1 }] }, 400, 'MIXED_BOOKS'],
      [{ items: [{ productId: 99999, packs: 1, packSize: 1, lineTotalCents: 1 }] }, 400, 'VALIDATION_ERROR'],
      [{ supplierId: 99999 }, 400, 'VALIDATION_ERROR'],
      [{ supplierId: inactive.id }, 400, 'VALIDATION_ERROR'],
      [{ businessDate: '2999-01-01' }, 400, 'FUTURE_DATE_NOT_ALLOWED'],
    ];
    for (const [over, status, code] of cases) {
      const r = await correct(w, o.id, replacement(w, over));
      expect([r.status, r.body.error.code]).toEqual([status, code]);
      expect(fingerprint(w.ctx)).toBe(before);
    }
    expect(row(w, o.id).status).toBe('posted');
    expect(count(w.ctx, 'corrections')).toBe(0);
    expect(pool(w, w.p.id)).toEqual({ qty: 20, value: 30000 });
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
    expect((await post(w.app, `/purchases/${o.id}/correct`, { replacement: replacement(w) })).status).toBe(400);
    expect((await correct(w, o.id, replacement(w), '   ')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await correct(w, o.id, replacement(w, { bogus: 1 }))).status).toBe(400);
    expect((await correct(w, o.id, replacement(w, { items: [] }))).status).toBe(400);
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
    expect((await post(w.app, `/purchases/${o.id}/void`, { reason: 'x' })).body.error.code).toBe('DAY_CLOSED'); // the manual void agrees
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

  it('5. negative cash stays a WARNING, never a block (also in the preview)', async () => {
    const s = await apiBase(await env.build()); // no opening balance: every cash-out goes below zero
    const p = await mkProduct(s);
    const w = Object.assign(s, { p, q: p });
    const o = await made(w);
    const rep = replacement(w, { items: [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 90_000_000 }] });
    const pv = await preview(w, o.id, rep);
    expect(pv.status).toBe(200);
    const r = await correct(w, o.id, rep);
    expect(r.status).toBe(201);
    for (const b of [pv.body, r.body]) {
      expect(b.warnings.length).toBeGreaterThan(0);
      expect(b.warnings.every((x: any) => x.code.startsWith('NEGATIVE_'))).toBe(true);
      const keys = b.warnings.map((x: any) => JSON.stringify(x));
      expect(new Set(keys).size).toBe(keys.length); // de-duplicated
    }
    expect(allProblems(w.ctx)).toEqual([]);
  });

  it('6. double submit with the same replacement clientRef: 200 replay, exactly one replacement, no second void', async () => {
    const w = await world();
    const o = await made(w);
    const rep = replacement(w);
    const first = await correct(w, o.id, rep);
    expect(first.status).toBe(201);
    const total = count(w.ctx, 'purchases');
    const fp = fingerprint(w.ctx);
    const again = await correct(w, o.id, rep);
    expect(again.status).toBe(200);
    expect(Object.keys(again.body).sort()).toEqual(['comparison', 'correction', 'original', 'replacement', 'warnings']);
    expect(again.body.replacement.id).toBe(first.body.replacement.id);
    expect(again.body.correction.id).toBe(first.body.correction.id);
    expect(again.body.comparison).toEqual(first.body.comparison);
    expect(again.body.original).toMatchObject({ id: o.id, status: 'void' });
    expect(count(w.ctx, 'purchases')).toBe(total);
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
    expect(sql(w, "SELECT * FROM purchases WHERE status = 'posted' AND id > ?", o.id)).toHaveLength(1);
    expect(pool(w, w.p.id)).toEqual({ qty: 20, value: 40000 });
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
    const strip = (x: any) => { const { id, postedAt, voidedAt, items, ...rest } = x; return { ...rest, items: items.map(({ id: _i, ...i }: any) => i) }; };
    expect(strip(r.body.replacement)).toEqual(strip(p.body.replacement));
    expect(strip(r.body.original)).toEqual(strip(p.body.original));
    expect(r.body.warnings).toEqual(p.body.warnings);
    expect(r.body.comparison).toEqual(p.body.comparison);
    // refusal: all three agree
    const o2 = await made(w, { businessDate: D(6) });
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
    // a preview of a replacement the create refuses shows the same refusal and saves nothing
    const o3 = await made(w);
    const fp3 = fingerprint(w.ctx);
    const pb = await preview(w, o3.id, replacement(w, { supplierId: 99999 }));
    expect([pb.status, pb.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(fingerprint(w.ctx)).toBe(fp3);
  });

  it('9. an already-void original is 409 ALREADY_VOID (check says not eligible)', async () => {
    const w = await world();
    const o = await made(w);
    expect((await post(w.app, `/purchases/${o.id}/void`, { reason: 'oops' })).status).toBe(200);
    const fp = fingerprint(w.ctx);
    expect((await check(w, o.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
    for (const r of [await preview(w, o.id, replacement(w)), await correct(w, o.id, replacement(w))]) {
      expect([r.status, r.body.error.code]).toEqual([409, 'ALREADY_VOID']);
    }
    expect(fingerprint(w.ctx)).toBe(fp);
  });

  it('11. a corrected purchase can itself be corrected (chain); each step changes the average; the books reconcile', async () => {
    const w = await world();
    const a = await made(w, { businessDate: D(2) });
    const r1 = await correct(w, a.id, replacement(w));
    expect(r1.status).toBe(201);
    expect(pool(w, w.p.id)).toEqual({ qty: 20, value: 40000 }); // average 20.00
    const r2 = await correct(w, r1.body.replacement.id, replacement(w, { items: [{ productId: w.p.id, packs: 1, packSize: 10, lineTotalCents: 5000 }] }));
    expect(r2.status).toBe(201);
    expect(r2.body.replacement.totalCents).toBe(5000);
    expect(r2.body.replacement.businessDate).toBe(D(2));
    expect(r2.body.comparison).toMatchObject({ originalTotalCents: 30000, replacementTotalCents: 5000, differenceTotalCents: -25000 });
    expect(pool(w, w.p.id)).toEqual({ qty: 20, value: 15000 }); // 10 @ 100.00 + 10 @ 50.00 => average 7.50
    expect((await get(w.app, `/corrections?entity=purchases&ids=${r1.body.replacement.id}`)).body.items).toHaveLength(2);
    expect(row(w, a.id).status).toBe('void');
    expect(row(w, r1.body.replacement.id).status).toBe('void');
    expect((await correct(w, a.id, replacement(w))).body.error.code).toBe('ALREADY_VOID');
    expect(state(w).shop).toBe(1_000_000 - 10000 - 5000);
    expect(allProblems(w.ctx)).toEqual([]);
    void today;
  });
});
