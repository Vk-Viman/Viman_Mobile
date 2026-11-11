import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post, put } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import {
  engineSell, err, FUTURE_MSG, mvs, mvsByRef, num, poolOf, productsSnap, reconOk, snap, sql, stComplete, stDraft, stNew,
  stPut, stVoid,
} from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const bl = (productId: number, units: number, lineTotalCents: number) => ({ productId, packs: 1, packSize: units, lineTotalCents });
/** 10 units for Rs 3,000: 10 / 300000 (average 30000). */
async function p10(s: ApiBase, mk = mkProduct): Promise<number> {
  const p = await mk(s);
  await buy(s, [bl(p.id, 10, 300000)]);
  return p.id;
}
/** 10 @ 3,000 + 10 @ 4,000: 20 / 700000 (average 35000). */
async function p20(s: ApiBase): Promise<number> {
  const id = await p10(s);
  await buy(s, [bl(id, 10, 400000)]);
  return id;
}

const ST_KEYS = ['backdated', 'book', 'businessDate', 'clientRef', 'completedAt', 'id', 'items', 'notes', 'postedAt', 'status', 'voidReason', 'voidedAt'];
const ITEM_KEYS = ['countedQty', 'differenceQty', 'expectedQty', 'gainUnitCostCents', 'id', 'productCode', 'productId', 'productName', 'valueDeltaCents'];

// =============================================================================================
describe('POST /stocktakes - create', () => {
  it('201 draft with exact shape; no items needed; no stock effect', async () => {
    const s = await setup();
    const before = snap(s);
    const r = await stNew(s, { clientRef: 'st-create-0001', notes: '  monthly count  ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(ST_KEYS);
    expect(r.body.item).toMatchObject({
      businessDate: today(), backdated: false, book: 'shop', status: 'draft', notes: 'monthly count', completedAt: null,
      voidedAt: null, voidReason: null, clientRef: 'st-create-0001', items: [],
    });
    expect(r.body.item.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(snap(s)).toEqual({ ...before, stocktakes: 1, audit_logs: before.audit_logs! + 1 });
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(0);
    expect((await get(s.app, `/stocktakes/${r.body.item.id}`)).body.item).toEqual(r.body.item);
    await reconOk(s);
  });

  it('with items: live expectedQty / difference, valueDeltaCents null, product name and code', async () => {
    const s = await setup();
    const p = await mkProduct(s, { code: 'SKU-1', name: 'Cable' });
    await buy(s, [bl(p.id, 10, 300000)]);
    const r = await stNew(s, { items: [{ productId: p.id, countedQty: 7 }] });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.item.items[0]).sort()).toEqual(ITEM_KEYS);
    expect(r.body.item.items[0]).toMatchObject({
      productId: p.id, productName: 'Cable', productCode: 'SKU-1', countedQty: 7, expectedQty: 10, differenceQty: -3,
      valueDeltaCents: null, gainUnitCostCents: null,
    });
    expect(poolOf(s, p.id)).toEqual({ qty: 10, value: 300000 });
  });

  it('the same clientRef returns the original with 200 and creates nothing new', async () => {
    const s = await setup();
    const p = await p10(s);
    const body = { businessDate: today(), book: 'shop', clientRef: 'st-idem-00001', items: [{ productId: p, countedQty: 3 }] };
    const a = await post(s.app, '/stocktakes', body);
    expect(a.status).toBe(201);
    const before = snap(s);
    const b = await post(s.app, '/stocktakes', { ...body, items: [{ productId: p, countedQty: 99 }], notes: 'ignored' });
    expect(b.status).toBe(200);
    expect(b.body.item.id).toBe(a.body.item.id);
    expect(b.body.item.items[0].countedQty).toBe(3);
    expect(snap(s)).toEqual(before);
  });

  it('telecom book stocktake takes telecom products', async () => {
    const s = await setup();
    const t = await p10(s, mkTelecom);
    const r = await stNew(s, { book: 'telecom', items: [{ productId: t, countedQty: 4 }] });
    expect(r.status).toBe(201);
    expect(r.body.item.book).toBe('telecom');
  });

  it('item validation: service / other-book -> 400 PRODUCT_NOT_IN_BOOK with the item path', async () => {
    const s = await setup();
    const shop = await mkProduct(s);
    const tel = await mkTelecom(s);
    const svc = await mkProduct(s, { kind: 'service' });
    const r1 = await stNew(s, { items: [{ productId: shop.id, countedQty: 1 }, { productId: svc.id, countedQty: 1 }] });
    expect(r1.status).toBe(400);
    expect(err(r1).code).toBe('PRODUCT_NOT_IN_BOOK');
    expect(Object.keys(err(r1).fields)).toEqual(['items.1.productId']);
    const r2 = await stNew(s, { items: [{ productId: tel.id, countedQty: 1 }] });
    expect(r2.status).toBe(400);
    expect(err(r2).code).toBe('PRODUCT_NOT_IN_BOOK');
    expect(Object.keys(err(r2).fields)).toEqual(['items.0.productId']);
    const r3 = await stNew(s, { book: 'telecom', items: [{ productId: shop.id, countedQty: 1 }] });
    expect(err(r3).code).toBe('PRODUCT_NOT_IN_BOOK');
    expect(num(s, 'SELECT COUNT(*) FROM stocktakes')).toBe(0);
  });

  it('item validation: duplicate and unknown products -> 400 VALIDATION_ERROR', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const dup = await stNew(s, { items: [{ productId: p.id, countedQty: 1 }, { productId: p.id, countedQty: 2 }] });
    expect(dup.status).toBe(400);
    expect(err(dup).code).toBe('VALIDATION_ERROR');
    expect(Object.keys(err(dup).fields)).toEqual(['items.1.productId']);
    const unk = await stNew(s, { items: [{ productId: 99999, countedQty: 1 }] });
    expect(unk.status).toBe(400);
    expect(err(unk).code).toBe('VALIDATION_ERROR');
    expect(Object.keys(err(unk).fields)).toEqual(['items.0.productId']);
    expect(num(s, 'SELECT COUNT(*) FROM stocktakes')).toBe(0);
  });

  it('schema: counted quantities are integers 0..1e9, no coercion; unknown fields and postedAt rejected', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const bad: unknown[] = [-1, 1.5, '3', null, 1000000001, true];
    for (const v of bad) {
      const r = await stNew(s, { items: [{ productId: p.id, countedQty: v }] });
      expect(r.status, JSON.stringify(v)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(err(r).fields['items.0.countedQty'], JSON.stringify(v)).toBeTruthy();
    }
    expect((await stNew(s, { items: [{ productId: p.id, countedQty: 0 }] })).status).toBe(201);
    expect((await stNew(s, { items: [{ productId: p.id, countedQty: 1000000000 }] })).status).toBe(201);
    for (const g of [-1, 1.5, '5', null, 100000000000]) {
      const r = await stNew(s, { items: [{ productId: p.id, countedQty: 1, gainUnitCostCents: g }] });
      expect(r.status, JSON.stringify(g)).toBe(400);
      expect(err(r).fields['items.0.gainUnitCostCents']).toBeTruthy();
    }
    expect((await stNew(s, { items: [{ productId: p.id, countedQty: 1, gainUnitCostCents: 99999999999 }] })).status).toBe(201);
    const extra = await stNew(s, { items: [{ productId: p.id, countedQty: 1, bogus: 1 }] });
    expect(err(extra).fields['items.0.bogus']).toBe('Unknown field.');
    expect(err(await stNew(s, { bogus: 1 })).fields.bogus).toBe('Unknown field.');
    const posted = await stNew(s, { postedAt: '2020-01-01T00:00:00.000Z' });
    expect(posted.status).toBe(400);
    expect(err(posted).fields.postedAt).toBeTruthy();
    expect(err(await stNew(s, { items: [{ productId: p.id }] })).fields['items.0.countedQty']).toBeTruthy();
    expect(err(await stNew(s, { items: [{ countedQty: 1 }] })).fields['items.0.productId']).toBeTruthy();
    expect(err(await stNew(s, { items: [{ productId: '1', countedQty: 1 }] })).fields['items.0.productId']).toBeTruthy();
  });

  it('schema: required fields, clientRef pattern, book enum, notes length, items maximum 500', async () => {
    const s = await setup();
    const full = { businessDate: today(), book: 'shop', clientRef: ref() };
    for (const k of ['businessDate', 'book', 'clientRef']) {
      const body: Record<string, unknown> = { ...full };
      delete body[k];
      const r = await post(s.app, '/stocktakes', body);
      expect(r.status, k).toBe(400);
      expect(err(r).fields[k]).toBeTruthy();
    }
    for (const c of ['short', 'has space 123456', 'x'.repeat(65), 12345678]) {
      expect((await stNew(s, { clientRef: c })).status, String(c)).toBe(400);
    }
    expect((await stNew(s, { book: 'icecream' })).status).toBe(400);
    expect((await stNew(s, { notes: 'x'.repeat(501) })).status).toBe(400);
    expect((await stNew(s, { notes: 'x'.repeat(500) })).status).toBe(201);
    const many = Array.from({ length: 501 }, (_, i) => ({ productId: i + 1, countedQty: 1 }));
    expect((await stNew(s, { items: many })).status).toBe(400);
  });

  it('dates: impossible date -> 400 VALIDATION_ERROR; future -> FUTURE_DATE_NOT_ALLOWED with the exact message; past accepted as backdated', async () => {
    const s = await setup();
    const impossible = await stNew(s, { businessDate: '2026-02-31' });
    expect(impossible.status).toBe(400);
    expect(err(impossible).code).toBe('VALIDATION_ERROR');
    expect(err(impossible).fields.businessDate).toBeTruthy();
    expect((await stNew(s, { businessDate: 'abc' })).status).toBe(400);
    expect((await stNew(s, { businessDate: '2026-1-5' })).status).toBe(400);
    const before = snap(s);
    for (const d of [daysAhead(1), '2999-12-31']) {
      const r = await stNew(s, { businessDate: d });
      expect(r.status).toBe(400);
      expect(err(r)).toEqual({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    }
    expect(snap(s)).toEqual(before);
    const past = await stNew(s, { businessDate: daysAgo(4) });
    expect(past.status).toBe(201);
    expect(past.body.item).toMatchObject({ businessDate: daysAgo(4), backdated: true });
  });
});

// =============================================================================================
describe('PUT /stocktakes/:id - draft edits', () => {
  it('replaces the whole item list, updates notes, keeps the product pool untouched', async () => {
    const s = await setup();
    const a = await p10(s); const b = await p10(s); const c = await p10(s);
    const d = await stDraft(s, [{ productId: a, countedQty: 1 }, { productId: b, countedQty: 2 }]);
    const r = await stPut(s, d.id, { items: [{ productId: c, countedQty: 5 }, { productId: a, countedQty: 9 }] });
    expect(r.status).toBe(200);
    expect(r.body.item.items.map((i: any) => [i.productId, i.countedQty])).toEqual([[c, 5], [a, 9]]);
    expect(r.body.item.items[0]).toMatchObject({ expectedQty: 10, differenceQty: -5 });
    const n = await stPut(s, d.id, { notes: '  hello ' });
    expect(n.body.item.notes).toBe('hello');
    expect(n.body.item.items).toHaveLength(2); // notes-only keeps items
    const e = await stPut(s, d.id, { items: [] });
    expect(e.body.item.items).toEqual([]);
    expect(poolOf(s, a)).toEqual({ qty: 10, value: 300000 });
    expect(num(s, 'SELECT COUNT(*) FROM stocktake_items')).toBe(0);
    await reconOk(s);
  });

  it('validation: empty body, unknown field, bad item, wrong book; 404 and bad id', async () => {
    const s = await setup();
    const p = await p10(s);
    const tel = await mkTelecom(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 1 }]);
    expect((await stPut(s, d.id, {})).status).toBe(400);
    expect(err(await stPut(s, d.id, { bogus: 1 })).fields.bogus).toBe('Unknown field.');
    expect(err(await stPut(s, d.id, { items: [{ productId: p, countedQty: -2 }] })).fields['items.0.countedQty']).toBeTruthy();
    const wb = await stPut(s, d.id, { items: [{ productId: tel.id, countedQty: 1 }] });
    expect(wb.status).toBe(400);
    expect(err(wb).code).toBe('PRODUCT_NOT_IN_BOOK');
    const dup = await stPut(s, d.id, { items: [{ productId: p, countedQty: 1 }, { productId: p, countedQty: 1 }] });
    expect(err(dup).code).toBe('VALIDATION_ERROR');
    expect((await stPut(s, d.id, { postedAt: 'x' })).status).toBe(400);
    expect((await stPut(s, d.id, { businessDate: today() })).status).toBe(400);
    expect((await stPut(s, 99999, { notes: 'x' })).status).toBe(404);
    expect((await put(s.app, '/stocktakes/abc', { notes: 'x' })).status).toBe(400);
    // rejected edits left the draft as it was
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.items.map((i: any) => i.productId)).toEqual([p]);
  });

  it('after complete or void: 409 NOT_DRAFT and nothing changes', async () => {
    const s = await setup();
    const p = await p10(s);
    const d1 = await stDraft(s, [{ productId: p, countedQty: 8 }]);
    expect((await stComplete(s, d1.id)).status).toBe(200);
    const d2 = await stDraft(s, [{ productId: p, countedQty: 1 }]);
    expect((await stVoid(s, d2.id)).status).toBe(200);
    const before = snap(s);
    const r1 = await stPut(s, d1.id, { notes: 'late' });
    expect(r1.status).toBe(409);
    expect(err(r1).code).toBe('NOT_DRAFT');
    expect((await stPut(s, d1.id, { items: [{ productId: p, countedQty: 1 }] })).status).toBe(409);
    expect(err(await stPut(s, d2.id, { notes: 'x' })).code).toBe('NOT_DRAFT');
    expect(snap(s)).toEqual(before);
    expect((await get(s.app, `/stocktakes/${d1.id}`)).body.item.items[0]).toMatchObject({ countedQty: 8, expectedQty: 10, differenceQty: -2 });
  });

  it('a draft shows the LIVE expected quantity: a purchase while it is open changes it; nothing is stored', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 12 }]);
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.items[0]).toMatchObject({ expectedQty: 10, differenceQty: 2, valueDeltaCents: null });
    await buy(s, [bl(p, 5, 100000)]); // 15 / 400000
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.items[0]).toMatchObject({ expectedQty: 15, differenceQty: -3, valueDeltaCents: null });
    engineSell(s, p, 15);
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.items[0]).toMatchObject({ expectedQty: 0, differenceQty: 12 });
    expect(sql(s, 'SELECT expected_qty, difference_qty FROM stocktake_items')[0]).toEqual({ expected_qty: null, difference_qty: null });
    const list = (await get(s.app, '/stocktakes')).body.items[0];
    expect(list.items[0]).toMatchObject({ expectedQty: 0, differenceQty: 12 });
  });
});

// =============================================================================================
describe('POST /stocktakes/:id/complete', () => {
  it('multi-item in item order: gain, loss, equal, untouched product; stores per-item figures; one movement per difference', async () => {
    const s = await setup();
    const A = await p20(s);                 // 20 / 700000
    const B = await p10(s);                 // 10 / 300000
    const C = await p10(s);                 // 10 / 300000 (counted equal)
    const D = await p10(s);                 // not counted
    const d = await stDraft(s, [
      { productId: B, countedQty: 12 },     // gain 2 = 300000*2/10 = 60000
      { productId: A, countedQty: 17 },     // loss 3 = 700000*3/20 = 105000
      { productId: C, countedQty: 10 },     // no movement
    ]);
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(200);
    const it = r.body.item;
    expect(it.status).toBe('completed');
    expect(it.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(it.items.map((i: any) => [i.productId, i.expectedQty, i.countedQty, i.differenceQty, i.valueDeltaCents])).toEqual([
      [B, 10, 12, 2, 60000], [A, 20, 17, -3, -105000], [C, 10, 10, 0, 0],
    ]);
    expect(poolOf(s, B)).toEqual({ qty: 12, value: 360000 });
    expect(poolOf(s, A)).toEqual({ qty: 17, value: 595000 });
    expect(poolOf(s, C)).toEqual({ qty: 10, value: 300000 });
    expect(poolOf(s, D)).toEqual({ qty: 10, value: 300000 });
    const m = mvsByRef(s, 'stocktakes', d.id);
    expect(m.map((x) => [x.productId, x.type, x.qty, x.value, x.date])).toEqual([
      [B, 'stocktake_gain', 2, 60000, today()], [A, 'stocktake_loss', -3, -105000, today()],
    ]);
    expect(m[0]!.id).toBeLessThan(m[1]!.id);
    expect(m.every((x) => x.reason === `Stocktake #${d.id}`)).toBe(true);
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item).toEqual(it);
    await reconOk(s);
  });

  it('book isolation: a telecom stocktake changes only the telecom product', async () => {
    const s = await setup();
    const shop = await p10(s);
    const tel = await p10(s, mkTelecom);
    const d = await stDraft(s, [{ productId: tel, countedQty: 9 }], { book: 'telecom' });
    expect((await stComplete(s, d.id)).status).toBe(200);
    expect(poolOf(s, tel)).toEqual({ qty: 9, value: 270000 });
    expect(poolOf(s, shop)).toEqual({ qty: 10, value: 300000 });
  });

  it('counted 0 on an EMPTY product is a no-op; on a stocked product it removes everything', async () => {
    const s = await setup();
    const empty = await mkProduct(s);
    const full = await p10(s);
    const d = await stDraft(s, [{ productId: empty.id, countedQty: 0 }, { productId: full, countedQty: 0 }]);
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(200);
    expect(r.body.item.items[0]).toMatchObject({ differenceQty: 0, valueDeltaCents: 0 });
    expect(r.body.item.items[1]).toMatchObject({ differenceQty: -10, valueDeltaCents: -300000 });
    expect(poolOf(s, empty.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, full)).toEqual({ qty: 0, value: 0 });
    expect(mvsByRef(s, 'stocktakes', d.id)).toHaveLength(1);
    await reconOk(s);
  });

  it('is judged against the LIVE pool at completion time (a sale after the count was entered)', async () => {
    const s = await setup();
    const A = await p20(s);
    const d = await stDraft(s, [{ productId: A, countedQty: 17 }]);
    engineSell(s, A, 5);                        // 15 / 525000
    const r = await stComplete(s, d.id);
    expect(r.body.item.items[0]).toMatchObject({ expectedQty: 15, differenceQty: 2, valueDeltaCents: 70000 }); // 525000*2/15
    expect(poolOf(s, A)).toEqual({ qty: 17, value: 595000 });
    await reconOk(s);
  });

  it('after completion the stored figures are static (later purchases do not change them)', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 8 }]);
    await stComplete(s, d.id);
    await buy(s, [bl(p, 50, 1)]);
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.items[0]).toMatchObject({ expectedQty: 10, differenceQty: -2, valueDeltaCents: -60000 });
  });

  it('errors: empty draft 400, double complete 409, unknown 404, non-empty body 400; void stocktake 409', async () => {
    const s = await setup();
    const p = await p10(s);
    const empty = await stDraft(s, []);
    const e = await stComplete(s, empty.id);
    expect(e.status).toBe(400);
    expect(err(e).code).toBe('VALIDATION_ERROR');
    expect(err(e).fields.items).toBeTruthy();
    expect(sql(s, 'SELECT status FROM stocktakes WHERE id = ?', empty.id)[0]!.status).toBe('draft');
    const d = await stDraft(s, [{ productId: p, countedQty: 9 }]);
    const bodyBad = await post(s.app, `/stocktakes/${d.id}/complete`, { force: true });
    expect(bodyBad.status).toBe(400);
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements WHERE type = ?', 'stocktake_loss')).toBe(0);
    expect((await stComplete(s, d.id)).status).toBe(200);
    const before = snap(s);
    const again = await stComplete(s, d.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('NOT_DRAFT');
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, p)).toEqual({ qty: 9, value: 270000 });
    expect((await stComplete(s, 99999)).status).toBe(404);
    const v = await stDraft(s, [{ productId: p, countedQty: 1 }]);
    await stVoid(s, v.id);
    expect((await stComplete(s, v.id)).status).toBe(409);
    // complete accepts an absent body too
    const d3 = await stDraft(s, [{ productId: p, countedQty: 9 }]);
    const noBody = await s.app.inject({ method: 'POST', url: `/api/v1/stocktakes/${d3.id}/complete` });
    expect(noBody.statusCode).toBe(200);
  });

  it('a gain without cost on a zero-stock product: 422 UNIT_COST_REQUIRED, exact field path, still a draft; fixing the cost completes it', async () => {
    const s = await setup();
    const A = await p10(s);
    const Z = await mkProduct(s);
    const d = await stDraft(s, [{ productId: A, countedQty: 8 }, { productId: Z.id, countedQty: 4 }]);
    const before = snap(s);
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('UNIT_COST_REQUIRED');
    expect(Object.keys(err(r).fields)).toEqual(['items.1.gainUnitCostCents']);
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, A)).toEqual({ qty: 10, value: 300000 });
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.status).toBe('draft');
    const fix = await stPut(s, d.id, { items: [{ productId: A, countedQty: 8 }, { productId: Z.id, countedQty: 4, gainUnitCostCents: 2500 }] });
    expect(fix.status).toBe(200);
    const ok = await stComplete(s, d.id);
    expect(ok.status).toBe(200);
    expect(ok.body.item.items[1]).toMatchObject({ differenceQty: 4, valueDeltaCents: 10000, gainUnitCostCents: 2500 });
    expect(poolOf(s, Z.id)).toEqual({ qty: 4, value: 10000 });
    expect(poolOf(s, A)).toEqual({ qty: 8, value: 240000 });
    await reconOk(s);
  });

  it('backdated stocktake: movements carry the business date, are posted now, and the record says backdated', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 6 }], { businessDate: daysAgo(5) });
    expect(d.backdated).toBe(true);
    const r = await stComplete(s, d.id);
    expect(r.body.item).toMatchObject({ businessDate: daysAgo(5), backdated: true, status: 'completed' });
    const m = mvsByRef(s, 'stocktakes', d.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ date: daysAgo(5), qty: -4, value: -120000 });
    expect(m[0]!.postedAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10)); // posting order is "now"
    // it comes after the purchase movement in posting order although it is dated earlier
    const all = mvs(s, 'product_id = ?', p);
    expect(all.map((x) => x.type)).toEqual(['purchase', 'stocktake_loss']);
    await reconOk(s);
  });
});

// =============================================================================================
describe('POST /stocktakes/:id/void', () => {
  it('draft: cancelled, no movements, expected/difference null, reason stored', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 3 }]);
    const r = await stVoid(s, d.id, '  wrong shelf  ');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'void', voidReason: 'wrong shelf', completedAt: null });
    expect(r.body.item.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.body.item.items[0]).toMatchObject({ countedQty: 3, expectedQty: null, differenceQty: null, valueDeltaCents: null });
    expect(num(s, "SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'stocktakes'")).toBe(0);
    expect(poolOf(s, p)).toEqual({ qty: 10, value: 300000 });
    await reconOk(s);
  });

  it('completed loss: reversal movement has the same type, negated qty/value, original business date; pool back exactly', async () => {
    const s = await setup();
    const A = await p20(s);
    const d = await stDraft(s, [{ productId: A, countedQty: 17 }], { businessDate: daysAgo(2) });
    await stComplete(s, d.id);
    expect(poolOf(s, A)).toEqual({ qty: 17, value: 595000 });
    const r = await stVoid(s, d.id, 'recount');
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe('void');
    expect(r.body.item.items[0]).toMatchObject({ expectedQty: 20, differenceQty: -3, valueDeltaCents: -105000 }); // stored figures kept
    expect(poolOf(s, A)).toEqual({ qty: 20, value: 700000 });
    const m = mvsByRef(s, 'stocktakes', d.id);
    expect(m.map((x) => [x.type, x.qty, x.value, x.date])).toEqual([
      ['stocktake_loss', -3, -105000, daysAgo(2)], ['stocktake_loss', 3, 105000, daysAgo(2)],
    ]);
    expect(m[1]!.reason).toBe(`Void of stocktake #${d.id}`);
    expect(m[0]!.qty + m[1]!.qty).toBe(0);
    await reconOk(s);
  });

  it('completed gain with a unit cost and a mixed multi-item stocktake reverse exactly', async () => {
    const s = await setup();
    const B = await p10(s);
    const Z = await mkProduct(s);
    const A = await p20(s);
    const d = await stDraft(s, [{ productId: B, countedQty: 13 }, { productId: Z.id, countedQty: 3, gainUnitCostCents: 777 }, { productId: A, countedQty: 1 }]);
    expect((await stComplete(s, d.id)).status).toBe(200);
    // B gain 3 = 90000 ; Z gain 3 x 777 = 2331 ; A loss 19 = 700000*19/20 = 665000
    expect(poolOf(s, B)).toEqual({ qty: 13, value: 390000 });
    expect(poolOf(s, Z.id)).toEqual({ qty: 3, value: 2331 });
    expect(poolOf(s, A)).toEqual({ qty: 1, value: 35000 });
    expect((await stVoid(s, d.id)).status).toBe(200);
    expect(poolOf(s, B)).toEqual({ qty: 10, value: 300000 });
    expect(poolOf(s, Z.id)).toEqual({ qty: 0, value: 0 });
    expect(poolOf(s, A)).toEqual({ qty: 20, value: 700000 });
    expect(mvsByRef(s, 'stocktakes', d.id)).toHaveLength(6);
    await reconOk(s);
  });

  it('completed gain whose units were already sold: 422 INSUFFICIENT_STOCK, nothing changes, still completed', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 12 }]);
    await stComplete(s, d.id);                 // 12 / 360000
    engineSell(s, p, 11);                      // 1 / 30000
    const before = snap(s);
    const prods = productsSnap(s);
    const r = await stVoid(s, d.id);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('INSUFFICIENT_STOCK');
    expect(err(r).message).toBe('Some of the stock added by this stocktake has already been used.');
    expect(snap(s)).toEqual(before);
    expect(productsSnap(s)).toBe(prods);
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.status).toBe('completed');
    await reconOk(s);
  });

  it('a later partial use that still leaves enough stock does not block the void', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 12 }]);
    await stComplete(s, d.id);                 // 12 / 360000
    engineSell(s, p, 4);                       // 8 / 240000
    const r = await stVoid(s, d.id);           // -2 / -60000 -> 6 / 180000
    expect(r.status).toBe(200);
    expect(poolOf(s, p)).toEqual({ qty: 6, value: 180000 });
    await reconOk(s);
  });

  it('ALREADY_VOID (draft-void and completed-void), unknown 404, reason validation', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 5 }]);
    expect((await stVoid(s, d.id)).status).toBe(200);
    const again = await stVoid(s, d.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    const d2 = await stDraft(s, [{ productId: p, countedQty: 5 }]);
    await stComplete(s, d2.id);
    await stVoid(s, d2.id);
    const n = num(s, 'SELECT COUNT(*) FROM stock_movements');
    expect(err(await stVoid(s, d2.id)).code).toBe('ALREADY_VOID');
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(n);
    expect((await stVoid(s, 99999)).status).toBe(404);
    const d3 = await stDraft(s, []);
    for (const bad of ['', '   ', 'x'.repeat(201)]) {
      const r = await post(s.app, `/stocktakes/${d3.id}/void`, { reason: bad });
      expect(r.status, bad.length.toString()).toBe(400);
      expect(err(r).fields.reason).toBeTruthy();
    }
    expect((await post(s.app, `/stocktakes/${d3.id}/void`, {})).status).toBe(400);
    expect((await post(s.app, `/stocktakes/${d3.id}/void`, { reason: 'x', extra: 1 })).status).toBe(400);
    expect((await post(s.app, `/stocktakes/${d3.id}/void`, { reason: 'x'.repeat(200) })).status).toBe(200);
  });
});

// =============================================================================================
describe('GET /stocktakes', () => {
  async function many(s: ApiBase) {
    const p = await p10(s);
    const t = await p10(s, mkTelecom);
    const a = await stDraft(s, [{ productId: p, countedQty: 9 }], { businessDate: daysAgo(10) });
    const b = await stDraft(s, [{ productId: t, countedQty: 9 }], { businessDate: daysAgo(5), book: 'telecom' });
    const c = await stDraft(s, [{ productId: p, countedQty: 9 }], { businessDate: daysAgo(5) });
    const d = await stDraft(s, [], { businessDate: today() });
    await stComplete(s, a.id);
    await stVoid(s, d.id);
    return { a, b, c, d };
  }

  it('orders by businessDate DESC, id DESC; includes items; filters by book, status, from, to', async () => {
    const s = await setup();
    const { a, b, c, d } = await many(s);
    const all = (await get(s.app, '/stocktakes')).body;
    expect(all.total).toBe(4);
    expect(all.items.map((i: any) => i.id)).toEqual([d.id, c.id, b.id, a.id]);
    expect(all.items[1].items).toHaveLength(1);
    expect((await get(s.app, '/stocktakes?book=telecom')).body.items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await get(s.app, '/stocktakes?status=draft')).body.items.map((i: any) => i.id)).toEqual([c.id, b.id]);
    expect((await get(s.app, '/stocktakes?status=completed')).body.items.map((i: any) => i.id)).toEqual([a.id]);
    expect((await get(s.app, '/stocktakes?status=void')).body.items.map((i: any) => i.id)).toEqual([d.id]);
    expect((await get(s.app, `/stocktakes?from=${daysAgo(5)}`)).body.items.map((i: any) => i.id)).toEqual([d.id, c.id, b.id]);
    expect((await get(s.app, `/stocktakes?to=${daysAgo(5)}`)).body.items.map((i: any) => i.id)).toEqual([c.id, b.id, a.id]);
    expect((await get(s.app, `/stocktakes?from=${daysAgo(5)}&to=${daysAgo(5)}&book=shop`)).body.items.map((i: any) => i.id)).toEqual([c.id]);
    expect((await get(s.app, `/stocktakes?from=${daysAhead(1)}`)).body).toEqual({ items: [], total: 0 }); // report dates never rejected
  });

  it('paging and limits', async () => {
    const s = await setup();
    const { a, b, c, d } = await many(s);
    const p1 = (await get(s.app, '/stocktakes?limit=2')).body;
    expect(p1.total).toBe(4);
    expect(p1.items.map((i: any) => i.id)).toEqual([d.id, c.id]);
    expect((await get(s.app, '/stocktakes?limit=2&offset=2')).body.items.map((i: any) => i.id)).toEqual([b.id, a.id]);
    expect((await get(s.app, '/stocktakes?limit=2&offset=9')).body).toEqual({ items: [], total: 4 });
    expect((await get(s.app, '/stocktakes?limit=100')).status).toBe(200);
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'offset=-1', 'from=2026-02-31', 'to=abc', 'status=done', 'book=icecream', 'zzz=1']) {
      expect((await get(s.app, `/stocktakes?${q}`)).status, q).toBe(400);
    }
  });

  it('get one: 200 / 404 / 400', async () => {
    const s = await setup();
    const d = await stDraft(s, []);
    expect((await get(s.app, `/stocktakes/${d.id}`)).body.item.id).toBe(d.id);
    const nf = await get(s.app, '/stocktakes/99999');
    expect(nf.status).toBe(404);
    expect(err(nf).code).toBe('NOT_FOUND');
    expect((await get(s.app, '/stocktakes/abc')).status).toBe(400);
  });
});

// =============================================================================================
describe('audit', () => {
  it('create / update / complete / void write entity "stocktake" rows with businessDate and backdated', async () => {
    const s = await setup();
    const p = await p10(s);
    const d = await stDraft(s, [{ productId: p, countedQty: 9 }], { businessDate: daysAgo(3) });
    await stPut(s, d.id, { notes: 'n' });
    await stComplete(s, d.id);
    await stVoid(s, d.id, 'because');
    const rows = sql(s, "SELECT action, entity_id, business_date, backdated, note FROM audit_logs WHERE entity = 'stocktake' ORDER BY id");
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'complete', 'void']);
    expect(rows.every((r) => r.entity_id === String(d.id) && r.business_date === daysAgo(3) && Number(r.backdated) === 1)).toBe(true);
    expect(rows[3]!.note).toBe('because');
    const a = auditRows(s.ctx, 'stocktake');
    expect(a[0]!.before).toBeNull();
    expect(a[0]!.after).toMatchObject({ status: 'draft', clientRef: d.clientRef });
    expect(a[2]!.before.status).toBe('draft');
    expect(a[2]!.after).toMatchObject({ status: 'completed' });
    expect(a[3]!.before.status).toBe('completed');
    expect(a[3]!.after.status).toBe('void');
    const api = (await get(s.app, '/audit-logs?entity=stocktake')).body.items;
    expect(api).toHaveLength(4);
    expect(api[0]).toMatchObject({ entity: 'stocktake', businessDate: daysAgo(3), backdated: true });
  });

  it('an idempotent repeat or a failed request writes no audit row', async () => {
    const s = await setup();
    const p = await p10(s);
    const body = { businessDate: today(), book: 'shop', clientRef: 'st-audit-0001', items: [{ productId: p, countedQty: 9 }] };
    await post(s.app, '/stocktakes', body);
    await post(s.app, '/stocktakes', body);
    await stNew(s, { items: [{ productId: 99999, countedQty: 1 }] });
    expect(auditRows(s.ctx, 'stocktake')).toHaveLength(1);
  });
});

// =============================================================================================
describe('atomic rollback', () => {
  it('complete: failing audit rolls back every movement and the status change; retry works after the trigger is removed', async () => {
    const s = await setup();
    quiet();
    const A = await p20(s); const B = await p10(s);
    const d = await stDraft(s, [{ productId: A, countedQty: 17 }, { productId: B, countedQty: 12 }]);
    breakAudit(s.ctx, 'stocktake');
    const before = snap(s);
    const prods = productsSnap(s);
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(500);
    expect(err(r).code).toBe('INTERNAL_ERROR');
    expect(snap(s)).toEqual(before);
    expect(productsSnap(s)).toBe(prods);
    expect(sql(s, 'SELECT status, completed_at FROM stocktakes WHERE id = ?', d.id)[0]).toEqual({ status: 'draft', completed_at: null });
    expect(sql(s, 'SELECT expected_qty FROM stocktake_items').every((x) => x.expected_qty === null)).toBe(true);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await stComplete(s, d.id)).status).toBe(200);
    expect(poolOf(s, A)).toEqual({ qty: 17, value: 595000 });
    expect(poolOf(s, B)).toEqual({ qty: 12, value: 360000 });
    await reconOk(s);
  });

  it('complete: a failure on the 2nd movement removes the 1st one as well', async () => {
    const s = await setup();
    quiet();
    const A = await p20(s); const B = await p20(s);
    const d = await stDraft(s, [{ productId: A, countedQty: 10 }, { productId: B, countedQty: 10 }]);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_fail_second BEFORE INSERT ON stock_movements
      WHEN NEW.product_id = ${B} AND NEW.type = 'stocktake_loss' BEGIN SELECT RAISE(ABORT, 'second movement boom'); END`);
    const before = snap(s);
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, A)).toEqual({ qty: 20, value: 700000 });
    expect(poolOf(s, B)).toEqual({ qty: 20, value: 700000 });
    expect(sql(s, 'SELECT status FROM stocktakes')[0]!.status).toBe('draft');
    await reconOk(s);
  });

  it('void of a completed stocktake: failing audit leaves the stocktake completed and no reversal rows', async () => {
    const s = await setup();
    quiet();
    const A = await p20(s);
    const d = await stDraft(s, [{ productId: A, countedQty: 17 }]);
    await stComplete(s, d.id);
    breakAudit(s.ctx, 'stocktake');
    const before = snap(s);
    const r = await stVoid(s, d.id);
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, A)).toEqual({ qty: 17, value: 595000 });
    expect(sql(s, 'SELECT status, voided_at FROM stocktakes')[0]).toEqual({ status: 'completed', voided_at: null });
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await stVoid(s, d.id)).status).toBe(200);
    expect(poolOf(s, A)).toEqual({ qty: 20, value: 700000 });
  });

  it('create with items: failing audit leaves no header, no items', async () => {
    const s = await setup();
    quiet();
    const p = await p10(s);
    breakAudit(s.ctx, 'stocktake');
    const before = snap(s);
    const r = await stNew(s, { items: [{ productId: p, countedQty: 1 }] });
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(snap(s)).toMatchObject({ stocktakes: 0, stocktake_items: 0 });
  });
});

describe('reconciliation across a long sequence', () => {
  it('stays ok after every step of a mixed stocktake sequence', async () => {
    const s = await setup();
    const A = await p20(s); const B = await p10(s); const Z = await mkProduct(s);
    await reconOk(s);
    const d1 = await stDraft(s, [{ productId: A, countedQty: 17 }, { productId: B, countedQty: 12 }, { productId: Z.id, countedQty: 2, gainUnitCostCents: 100 }]);
    await reconOk(s);
    await stComplete(s, d1.id); await reconOk(s);
    const d2 = await stDraft(s, [{ productId: A, countedQty: 25 }, { productId: B, countedQty: 0 }]);
    await stComplete(s, d2.id); await reconOk(s);
    // d2 emptied B, so d1's +2 gain on B cannot be taken back yet
    const blocked = await stVoid(s, d1.id);
    expect(blocked.status).toBe(422);
    expect(err(blocked).code).toBe('INSUFFICIENT_STOCK');
    await reconOk(s);
    expect((await stVoid(s, d2.id)).status).toBe(200); await reconOk(s);
    expect((await stVoid(s, d1.id)).status).toBe(200); await reconOk(s);
    expect(poolOf(s, A)).toEqual({ qty: 20, value: 700000 });
    const d3 = await stDraft(s, [{ productId: A, countedQty: 3 }]);
    await stComplete(s, d3.id); await reconOk(s);
    expect(poolOf(s, A).qty).toBe(3);
    expect(poolOf(s, B)).toEqual({ qty: 10, value: 300000 });
  });
});
