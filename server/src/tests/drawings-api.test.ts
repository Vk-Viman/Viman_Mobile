// Owner drawings API (POST/GET /drawings, void) - API level (Fastify inject, real temp database).
// Protects BUSINESS_RULES section 9 and section 1 "below the line": when the owner takes goods for personal use, stock leaves
// at the weighted-average COST (never the selling price), one 'personal_use' movement is written, and the drawing is NOT a
// stock loss and NOT a P&L expense (it only reduces stock). Cash drawings are not available yet
// (NOT_AVAILABLE_YET). Also R1 / C6 (void = exact reversal at the original value and date), R-FD, clientRef idempotency,
// audit rows and rollback.
// Organised as: goods drawing create, list, void, "personal use is separate from losses", audit/atomicity.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, mkTelecom, productOf, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import {
  drawNew, drawVoid, engineSell, err, FUTURE_MSG, lossNew, mvs, mvsByRef, num, poolOf, productsSnap, reconOk, snap, sql,
} from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
// Silences the expected server error log lines while tests deliberately force failures.
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const bl = (productId: number, units: number, lineTotalCents: number) => ({ productId, packs: 1, packSize: units, lineTotalCents });
// (Fixture: 10 @ 300,000 + 10 @ 400,000 = 20 units / 700,000.)
/** 20 / 700000 (average Rs 350.00); the product sells for Rs 1,000 (100000). */
async function p20(s: ApiBase, mk = mkProduct): Promise<number> {
  const p = await mk(s, { sellPriceCents: 100000, minPriceCents: 50000 });
  await buy(s, [bl(p.id, 10, 300000)]);
  await buy(s, [bl(p.id, 10, 400000)]);
  return p.id;
}
// Fixture: product with exactly 'units' units worth 'value' cents in total.
async function pUnits(s: ApiBase, units: number, value: number, mk = mkProduct): Promise<number> {
  const p = await mk(s);
  await buy(s, [bl(p.id, units, value)]);
  return p.id;
}

// Exact field list of a drawing in API responses.
const KEYS = ['amountCents', 'backdated', 'book', 'businessDate', 'clientRef', 'id', 'kind', 'note', 'postedAt', 'productId', 'productName',
  'qty', 'status', 'voidReason', 'voidedAt'];

// Taking goods for personal use: valued at cost, book from the product, validation and dates.
describe('POST /drawings - goods drawing', () => {
  // Average Rs 350 (35,000) x 2 = 70,000, NOT the Rs 1,000 selling price: a drawing is valued at what the goods cost the shop (C12: price is
  // never used for costing). No loss row and no cash entry are created.
  it('2 units at cost: amount 70000 (avg Rs 350 x 2), NOT the Rs 1,000 selling price; exact shape; no loss row, no cash entry', async () => {
    const s = await setup();
    const P = await mkProduct(s, { name: 'Perfume', sellPriceCents: 100000, minPriceCents: 50000 });
    await buy(s, [bl(P.id, 10, 300000)]);
    await buy(s, [bl(P.id, 10, 400000)]);
    const cash = num(s, 'SELECT COUNT(*) FROM cash_entries');
    const r = await drawNew(s, P.id, 2, { clientRef: 'draw-create-0001', note: '  for home  ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(KEYS);
    expect(r.body.item).toMatchObject({
      businessDate: today(), backdated: false, book: 'shop', kind: 'goods', amountCents: 70000, productId: P.id,
      productName: 'Perfume', qty: 2, note: 'for home', status: 'posted', voidedAt: null, voidReason: null, clientRef: 'draw-create-0001',
    });
    expect(r.body.item.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r.body.item.amountCents).not.toBe(2 * 100000);
    expect(poolOf(s, P.id)).toEqual({ qty: 18, value: 630000 });
    expect(await productOf(s, P.id)).toMatchObject({ qtyOnHand: 18, stockValueCents: 630000 });
    const m = mvsByRef(s, 'owner_drawings', r.body.item.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ type: 'personal_use', qty: -2, value: -70000, unit: 35000, date: today() });
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cash);
    expect(sql(s, 'SELECT kind, book, fund, product_id, qty, amount_cents FROM owner_drawings')).toEqual([
      { kind: 'goods', book: 'shop', fund: null, product_id: P.id, qty: 2, amount_cents: 70000 },
    ]);
    expect((await get(s.app, `/drawings/${r.body.item.id}`)).body.item).toEqual(r.body.item);
    await reconOk(s);
  });

  // Telecom pool 3 / 1,000: drawing 2 = 1,000 x 2 / 3 = 666.67 -> 667, the last unit takes 333. A shop drawing of 1 at the average = 35,000.
  it('book is the product book; Shop and Telecom pools stay independent; rounding at the average', async () => {
    const s = await setup();
    const shop = await p20(s);
    const tel = await pUnits(s, 3, 1000, mkTelecom);
    const a = await drawNew(s, tel, 2);
    expect(a.body.item).toMatchObject({ book: 'telecom', amountCents: 667, qty: 2 }); // 1000*2/3 = 666.67
    expect(poolOf(s, tel)).toEqual({ qty: 1, value: 333 });
    expect(poolOf(s, shop)).toEqual({ qty: 20, value: 700000 });
    const b = await drawNew(s, tel, 1);
    expect(b.body.item.amountCents).toBe(333);                                          // last unit takes the rest
    expect(poolOf(s, tel)).toEqual({ qty: 0, value: 0 });
    const c = await drawNew(s, shop, 1);
    expect(c.body.item).toMatchObject({ book: 'shop', amountCents: 35000 });
    await reconOk(s);
  });

  // Cash drawings are not built yet, so they are refused cleanly. The future-date check still comes first.
  it('kind "cash" -> 400 NOT_AVAILABLE_YET, nothing written; checked after the date rules', async () => {
    const s = await setup();
    const P = await p20(s);
    const before = snap(s);
    const r = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), clientRef: ref() });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('NOT_AVAILABLE_YET');
    expect(err(r).message).toMatch(/cash/i);
    const r2 = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), productId: P, qty: 1, clientRef: ref() });
    expect(err(r2).code).toBe('NOT_AVAILABLE_YET');
    const fut = await post(s.app, '/drawings', { kind: 'cash', businessDate: daysAhead(1), clientRef: ref() });
    expect(err(fut).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(snap(s)).toEqual(before);
  });

  // A goods drawing must say which product and how many.
  it('goods without product or qty -> 400 VALIDATION_ERROR naming the field', async () => {
    const s = await setup();
    const P = await p20(s);
    const a = await post(s.app, '/drawings', { kind: 'goods', businessDate: today(), clientRef: ref() });
    expect(a.status).toBe(400);
    expect(err(a)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { productId: expect.any(String), qty: expect.any(String) } });
    const b = await post(s.app, '/drawings', { kind: 'goods', businessDate: today(), productId: P, clientRef: ref() });
    expect(Object.keys(err(b).fields)).toEqual(['qty']);
    const c = await post(s.app, '/drawings', { kind: 'goods', businessDate: today(), qty: 1, clientRef: ref() });
    expect(Object.keys(err(c).fields)).toEqual(['productId']);
    expect(num(s, 'SELECT COUNT(*) FROM owner_drawings')).toBe(0);
  });

  it('schema: qty integer 1..1e9 without coercion, kind enum, required fields, unknown fields, clientRef, note', async () => {
    const s = await setup();
    const P = await p20(s);
    for (const q of [0, -1, 1.5, '2', null, 1000000001]) {
      const r = await drawNew(s, P, q as number);
      expect(r.status, JSON.stringify(q)).toBe(400);
      expect(err(r).fields.qty, JSON.stringify(q)).toBeTruthy();
    }
    for (const k of ['stock', '', null, 'GOODS']) expect(err(await drawNew(s, P, 1, { kind: k })).fields.kind, String(k)).toBeTruthy();
    for (const k of ['kind', 'businessDate', 'clientRef']) {
      const body: Record<string, unknown> = { kind: 'goods', businessDate: today(), productId: P, qty: 1, clientRef: ref() };
      delete body[k];
      const r = await post(s.app, '/drawings', body);
      expect(r.status, k).toBe(400);
      expect(err(r).fields[k], k).toBeTruthy();
    }
    expect(err(await drawNew(s, P, 1, { book: 'telecom' })).fields.book).toBe('Unknown field.');
    expect(err(await drawNew(s, P, 1, { amountCents: 5 })).fields.amountCents).toBeTruthy();
    expect(err(await drawNew(s, P, 1, { fund: 'cost' })).fields.fund).toBeTruthy();
    expect(err(await drawNew(s, P, 1, { postedAt: '2020-01-01T00:00:00.000Z' })).fields.postedAt).toBeTruthy();
    expect((await drawNew(s, '1' as unknown as number, 1)).status).toBe(400);
    for (const c of ['short', 'with space 1234', 'z'.repeat(65)]) expect((await drawNew(s, P, 1, { clientRef: c })).status, c).toBe(400);
    expect((await drawNew(s, P, 1, { note: 'n'.repeat(501) })).status).toBe(400);
    expect((await drawNew(s, P, 1, { note: 'n'.repeat(500) })).status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM owner_drawings')).toBe(1);
  });

  it('product checks: unknown 400, service 400 PRODUCT_NOT_STOCKABLE, inactive allowed; INSUFFICIENT_STOCK writes nothing', async () => {
    const s = await setup();
    const svc = await mkProduct(s, { kind: 'service' });
    const P = await pUnits(s, 3, 1000);
    const E = await mkProduct(s);
    const before = snap(s);
    const pools = productsSnap(s);
    const unk = await drawNew(s, 99999, 1);
    expect(unk.status).toBe(400);
    expect(err(unk)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { productId: 'Product not found.' } });
    const sv = await drawNew(s, svc.id, 1);
    expect(sv.status).toBe(400);
    expect(err(sv).code).toBe('PRODUCT_NOT_STOCKABLE');
    const ins = await drawNew(s, P, 4);
    expect(ins.status).toBe(422);
    expect(ins.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', message: 'Not enough stock: 3 on hand, 4 needed.', onHand: 3, productId: P });
    expect(err(await drawNew(s, E.id, 1)).code).toBe('INSUFFICIENT_STOCK');
    expect(snap(s)).toEqual(before);
    expect(productsSnap(s)).toBe(pools);
    s.ctx.database.conn.prepare('UPDATE products SET active = 0 WHERE id = ?').run(P);
    expect((await drawNew(s, P, 3)).status).toBe(201);
    expect(poolOf(s, P)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  // Double-click protection: one drawing, one stock movement.
  it('idempotent clientRef: repeat returns the original (200) and posts no second drawing or movement', async () => {
    const s = await setup();
    const P = await p20(s);
    const body = { kind: 'goods', businessDate: today(), productId: P, qty: 2, clientRef: 'draw-idem-00001' };
    const a = await post(s.app, '/drawings', body);
    expect(a.status).toBe(201);
    const before = snap(s);
    for (let i = 0; i < 3; i++) {
      const b = await post(s.app, '/drawings', { ...body, qty: 7 });
      expect(b.status).toBe(200);
      expect(b.body.item).toEqual(a.body.item);
    }
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, P)).toEqual({ qty: 18, value: 630000 });
    expect(num(s, "SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'owner_drawings'")).toBe(1);
  });

  it('dates: future -> exact FUTURE_DATE_NOT_ALLOWED; impossible -> 400; backdated flagged and movement carries the date', async () => {
    const s = await setup();
    const P = await p20(s);
    const before = snap(s);
    const f = await drawNew(s, P, 1, { businessDate: daysAhead(3) });
    expect(f.status).toBe(400);
    expect(err(f)).toEqual({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    for (const d of ['2026-02-31', 'nope']) expect(err(await drawNew(s, P, 1, { businessDate: d })).fields.businessDate, d).toBeTruthy();
    expect(snap(s)).toEqual(before);
    const r = await drawNew(s, P, 1, { businessDate: daysAgo(7) });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ businessDate: daysAgo(7), backdated: true });
    expect(mvsByRef(s, 'owner_drawings', r.body.item.id)[0]).toMatchObject({ date: daysAgo(7), qty: -1, value: -35000 });
    await reconOk(s);
  });
});

// =============================================================================================
// Listing drawings; totals count posted rows only.
describe('GET /drawings', () => {
  async function scenario(s: ApiBase) {
    const P = await p20(s);
    const T = await pUnits(s, 10, 50000, mkTelecom);
    const D1 = (await drawNew(s, P, 1, { businessDate: daysAgo(6) })).body.item;  // 35000
    const D2 = (await drawNew(s, P, 2, { businessDate: daysAgo(3) })).body.item;  // 70000
    const D3 = (await drawNew(s, T, 2, { businessDate: daysAgo(3) })).body.item;  // 10000
    const D4 = (await drawNew(s, P, 1)).body.item;                                // 35000
    expect([D1.amountCents, D2.amountCents, D3.amountCents, D4.amountCents]).toEqual([35000, 70000, 10000, 35000]);
    expect((await drawVoid(s, D2.id)).status).toBe(200);
    return { P, T, D1, D2, D3, D4 };
  }

  it('orders newest business date first; totals count posted rows only', async () => {
    const s = await setup();
    const { D1, D2, D3, D4 } = await scenario(s);
    const r = (await get(s.app, '/drawings')).body;
    expect(r.items.map((i: any) => i.id)).toEqual([D4.id, D3.id, D2.id, D1.id]);
    expect(r.total).toBe(4);
    expect(r.totalAmountCents).toBe(35000 + 10000 + 35000);
  });

  it('filters: kind, status, book, productId, from, to', async () => {
    const s = await setup();
    const { P, T, D1, D2, D3, D4 } = await scenario(s);
    const q = async (qs: string) => (await get(s.app, `/drawings?${qs}`)).body;
    let r = await q('kind=goods');
    expect(r.total).toBe(4);
    r = await q('kind=cash');
    expect(r).toEqual({ items: [], total: 0, totalAmountCents: 0 });
    r = await q('status=void');
    expect([r.items.map((i: any) => i.id), r.totalAmountCents]).toEqual([[D2.id], 0]);
    r = await q('status=posted');
    expect([r.total, r.totalAmountCents]).toEqual([3, 80000]);
    r = await q('book=telecom');
    expect([r.items.map((i: any) => i.id), r.totalAmountCents]).toEqual([[D3.id], 10000]);
    r = await q('book=shop');
    expect([r.total, r.totalAmountCents]).toEqual([3, 70000]);
    r = await q(`productId=${P}`);
    expect([r.items.map((i: any) => i.id), r.totalAmountCents]).toEqual([[D4.id, D2.id, D1.id], 70000]);
    r = await q(`productId=${T}`);
    expect(r.items.map((i: any) => i.id)).toEqual([D3.id]);
    r = await q(`from=${daysAgo(3)}`);
    expect([r.items.map((i: any) => i.id), r.totalAmountCents]).toEqual([[D4.id, D3.id, D2.id], 45000]);
    r = await q(`to=${daysAgo(3)}`);
    expect([r.items.map((i: any) => i.id), r.totalAmountCents]).toEqual([[D3.id, D2.id, D1.id], 45000]);
    r = await q(`from=${daysAgo(3)}&to=${daysAgo(3)}&status=posted`);
    expect([r.items.map((i: any) => i.id), r.totalAmountCents]).toEqual([[D3.id], 10000]);
    expect((await q(`from=${daysAhead(5)}`))).toEqual({ items: [], total: 0, totalAmountCents: 0 });
  });

  it('paging and bad query values', async () => {
    const s = await setup();
    await scenario(s);
    const r = (await get(s.app, '/drawings?limit=2&offset=1')).body;
    expect(r.items).toHaveLength(2);
    expect([r.total, r.totalAmountCents]).toEqual([4, 80000]);
    expect((await get(s.app, '/drawings?limit=200')).status).toBe(200);
    for (const q of ['limit=0', 'limit=201', 'offset=-1', 'kind=other', 'status=draft', 'book=icecream', 'from=2026-02-30', 'to=abc', 'productId=x', 'bogus=1']) {
      expect((await get(s.app, `/drawings?${q}`)).status, q).toBe(400);
    }
    expect((await get(s.app, '/drawings/99999')).status).toBe(404);
    expect((await get(s.app, '/drawings/abc')).status).toBe(400);
  });
});

// =============================================================================================
// R1 / C6: a void adds an exact reversal ('personal_use', +qty, +amount) dated like the original.
describe('POST /drawings/:id/void', () => {
  it('restores stock/value exactly; reversal movement is personal_use +qty +amount on the original business date; excluded from totals', async () => {
    const s = await setup();
    const P = await p20(s);
    const d = (await drawNew(s, P, 3, { businessDate: daysAgo(5) })).body.item;       // 105000
    expect(poolOf(s, P)).toEqual({ qty: 17, value: 595000 });
    const r = await drawVoid(s, d.id, '  mistake ');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'void', voidReason: 'mistake', amountCents: 105000, qty: 3, backdated: true });
    expect(r.body.item.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
    const m = mvsByRef(s, 'owner_drawings', d.id);
    expect(m.map((x) => [x.type, x.qty, x.value, x.date])).toEqual([['personal_use', -3, -105000, daysAgo(5)], ['personal_use', 3, 105000, daysAgo(5)]]);
    expect(m[1]!.reason).toBe(`Void of personal use #${d.id}`);
    expect((await get(s.app, '/drawings')).body).toMatchObject({ total: 1, totalAmountCents: 0 });
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
    await reconOk(s);
  });

  // Voiding returns the goods at their ORIGINAL drawing value, not at whatever the average is now (C6).
  it('restores the original value even after later sales changed the pool', async () => {
    const s = await setup();
    const P = await pUnits(s, 3, 1000);
    const d = (await drawNew(s, P, 2)).body.item;   // 667, pool 1/333
    engineSell(s, P, 1);                            // 0/0
    expect((await drawVoid(s, d.id)).status).toBe(200);
    expect(poolOf(s, P)).toEqual({ qty: 2, value: 667 });
    await reconOk(s);
  });

  it('ALREADY_VOID, unknown, reason validation; failures write nothing', async () => {
    const s = await setup();
    const P = await p20(s);
    const d = (await drawNew(s, P, 1)).body.item;
    for (const bad of ['', '  ', 'x'.repeat(201)]) expect(err(await post(s.app, `/drawings/${d.id}/void`, { reason: bad })).fields.reason).toBeTruthy();
    expect((await post(s.app, `/drawings/${d.id}/void`, {})).status).toBe(400);
    expect((await post(s.app, `/drawings/${d.id}/void`, { reason: 'x', y: 1 })).status).toBe(400);
    expect((await drawVoid(s, d.id)).status).toBe(200);
    const before = snap(s);
    const again = await drawVoid(s, d.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(snap(s)).toEqual(before);
    expect((await drawVoid(s, 99999)).status).toBe(404);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
    // the original clientRef still resolves to the (void) drawing
    const rep = await post(s.app, '/drawings', { kind: 'goods', businessDate: today(), productId: P, qty: 1, clientRef: d.clientRef });
    expect(rep.status).toBe(200);
    expect(rep.body.item.status).toBe('void');
  });
});

// =============================================================================================
// Goods drawings and stock losses are different business facts with separate totals; only losses count in Stock adjustments.
describe('personal use is separate from stock losses', () => {
  // Pool 20 / 700,000: loss 2 = 70,000 -> 18 / 630,000; loss 1 (expired) = 35,000 -> 17 / 595,000; drawing 2 = 70,000 -> 15 / 525,000.
  // Losses total 105,000 (stock adjustments), drawings total 70,000 (below the line). Voiding the drawing (+70,000) leaves the losses at 105,000;
  // voiding loss 1 (+70,000) leaves 35,000; final pool 19 / 665,000.
  it('2 losses + 1 drawing: independent totals; stock adjustments from movements exclude personal_use', async () => {
    const s = await setup();
    const P = await p20(s);                                   // 20 / 700000
    const l1 = await lossNew(s, P, 2);                        // 70000 -> 18 / 630000
    const l2 = await lossNew(s, P, 1, { reason: 'expired' }); // 35000 -> 17 / 595000
    const d = await drawNew(s, P, 2);                         // 70000 -> 15 / 525000
    expect([l1.body.item.costCents, l2.body.item.costCents, d.body.item.amountCents]).toEqual([70000, 35000, 70000]);
    const losses = (await get(s.app, '/stock-losses')).body;
    const draws = (await get(s.app, '/drawings')).body;
    expect(losses).toMatchObject({ total: 2, totalCostCents: 105000 });
    expect(draws).toMatchObject({ total: 1, totalAmountCents: 70000 });
    expect(losses.items.every((i: any) => i.kind === undefined && ['damaged', 'expired'].includes(i.reason))).toBe(true);
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(2);
    // stock adjustments (net) per movement types = losses only
    const adjust = -num(s, "SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type IN ('loss','stocktake_loss','stocktake_gain')");
    expect(adjust).toBe(losses.totalCostCents);
    expect(-num(s, "SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type = 'personal_use'")).toBe(draws.totalAmountCents);
    expect(mvs(s, "type = 'personal_use'")).toHaveLength(1);
    expect(mvs(s, "type = 'loss'")).toHaveLength(2);
    // voiding the drawing leaves the losses untouched, voiding a loss leaves the drawings untouched
    await drawVoid(s, d.body.item.id);
    expect((await get(s.app, '/stock-losses')).body.totalCostCents).toBe(105000);
    expect((await get(s.app, '/drawings')).body.totalAmountCents).toBe(0);
    await post(s.app, `/stock-losses/${l1.body.item.id}/void`, { reason: 'x' });
    expect((await get(s.app, '/stock-losses')).body.totalCostCents).toBe(35000);
    expect(poolOf(s, P)).toEqual({ qty: 19, value: 665000 });
    await reconOk(s);
  });
});

// =============================================================================================
// Every create/void leaves one audit entry; any failed step leaves the database exactly as before.
describe('audit and atomicity', () => {
  it('audit: entity "drawing" create and void with businessDate / backdated; repeats and rejects add nothing', async () => {
    const s = await setup();
    const P = await p20(s);
    const d = (await drawNew(s, P, 1, { businessDate: daysAgo(2) })).body.item;
    await drawVoid(s, d.id, 'oops');
    await post(s.app, '/drawings', { kind: 'goods', businessDate: daysAgo(2), productId: P, qty: 1, clientRef: d.clientRef });
    await drawNew(s, P, 999);
    const rows = sql(s, "SELECT action, entity_id, business_date, backdated, note FROM audit_logs WHERE entity = 'drawing' ORDER BY id");
    expect(rows.map((r) => r.action)).toEqual(['create', 'void']);
    expect(rows.every((r) => r.entity_id === String(d.id) && r.business_date === daysAgo(2) && Number(r.backdated) === 1)).toBe(true);
    expect(rows[1]!.note).toBe('oops');
    const a = auditRows(s.ctx, 'drawing');
    expect(a[0]!.before).toBeNull();
    expect(a[0]!.after).toMatchObject({ kind: 'goods', amountCents: 35000, status: 'posted' });
    expect(a[1]!.after.status).toBe('void');
  });

  it('create: failing audit rolls back drawing + movement; retry works', async () => {
    const s = await setup();
    quiet();
    const P = await p20(s);
    breakAudit(s.ctx, 'drawing');
    const before = snap(s);
    const pools = productsSnap(s);
    const body = { kind: 'goods', businessDate: today(), productId: P, qty: 4, clientRef: 'draw-atomic-001' };
    const r = await post(s.app, '/drawings', body);
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(productsSnap(s)).toBe(pools);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await post(s.app, '/drawings', body)).status).toBe(201);
    expect(poolOf(s, P)).toEqual({ qty: 16, value: 560000 });
    await reconOk(s);
  });

  it('create: a failing movement insert rolls back the drawing row', async () => {
    const s = await setup();
    quiet();
    const P = await p20(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_fail_move BEFORE INSERT ON stock_movements
      WHEN NEW.type = 'personal_use' BEGIN SELECT RAISE(ABORT, 'movement boom'); END`);
    const before = snap(s);
    expect((await drawNew(s, P, 1)).status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
  });

  it('void: failing audit leaves the drawing posted without a reversal movement', async () => {
    const s = await setup();
    quiet();
    const P = await p20(s);
    const d = (await drawNew(s, P, 2)).body.item;
    breakAudit(s.ctx, 'drawing');
    const before = snap(s);
    expect((await drawVoid(s, d.id)).status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(sql(s, 'SELECT status FROM owner_drawings')[0]!.status).toBe('posted');
    expect(poolOf(s, P)).toEqual({ qty: 18, value: 630000 });
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await drawVoid(s, d.id)).status).toBe(200);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
    await reconOk(s);
  });

  // Stock cache = ledger after every step, and no cash entries exist beyond the purchases (drawings of goods never move cash).
  it('reconciliation ok after each step of a create / void sequence; no cash entries beyond purchases', async () => {
    const s = await setup();
    const P = await p20(s);
    const cash = num(s, 'SELECT COUNT(*) FROM cash_entries');
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await drawNew(s, P, i + 1);
      expect(r.status).toBe(201);
      ids.push(r.body.item.id);
      await reconOk(s);
    }
    expect(poolOf(s, P).qty).toBe(5);
    for (const id of ids) { expect((await drawVoid(s, id)).status).toBe(200); await reconOk(s); }
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cash);
  });
});
