// PHASE 26 package F - stock, purchases and opening stock per Telecom segment (BUSINESS_RULES 13D).
// A purchase / loss / stocktake / goods use of Telecom cards belongs to the product's provider Cards segment; a closed day of one
// segment refuses only that segment. Every figure is hand-calculated.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, cardProduct, mkProduct, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { seg } from './helpers/seg.ts';
import { openingPost, unitLine } from './helpers/phase13.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const err = (r: { body: any }) => r.body.error;
const line = (productId: number, packs: number, packSize: number, lineTotalCents: number) => ({ productId, packs, packSize, lineTotalCents });
const rawPost = (s: ApiBase, items: any[], over: Record<string, unknown> = {}) =>
  post(s.app, '/purchases', { businessDate: today(), items, clientRef: ref(), ...over });
const count = (s: ApiBase, table: string) => Number(sql(s, `SELECT COUNT(*) AS n FROM ${table}`)[0]!.n);

/** Makes a card product legacy (provider-less category), as products were before the migration. Scratch database only. */
function makeLegacy(s: ApiBase, productId: number): void {
  const conn = s.ctx.database.conn;
  for (const t of sql(s, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='categories'")) {
    if (/provider/.test(String(t.name))) conn.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  }
  conn.exec(`UPDATE categories SET provider_id = NULL WHERE id = (SELECT category_id FROM products WHERE id = ${productId})`);
}

describe('purchases: the segment of a bill', () => {
  it('Dialog cards: 2 packs x 5 for Rs 200.00 -> segment dialog_cards, payment -20000 in Dialog Cards only', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const p = await buy(s, [line(d.id, 2, 5, 20000)]);
    expect(p).toMatchObject({ book: 'telecom', segment: 'dialog_cards', totalCents: 20000 });
    expect(sql(s, 'SELECT segment FROM purchases WHERE id = ?', p.id)[0]!.segment).toBe('dialog_cards');
    const cash = sql(s, "SELECT type, amount_cents, segment, book FROM cash_entries WHERE ref_table = 'purchases'");
    expect(cash).toEqual([{ type: 'purchase_payment', amount_cents: -20000, segment: 'dialog_cards', book: 'telecom' }]);
    expect(seg.balance(s, 'dialog_cards')).toBe(-20000);
    expect(seg.balance(s, 'mobitel_cards')).toBe(0);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
    expect((await get(s.app, '/purchases?segment=dialog_cards')).body.items.map((i: any) => i.id)).toEqual([p.id]);
    expect((await get(s.app, '/purchases?segment=mobitel_cards')).body.items).toEqual([]);
  });

  it('Shop purchase has segment null', async () => {
    const s = await setup();
    const sh = await mkProduct(s);
    expect(await buy(s, [line(sh.id, 1, 10, 5000)])).toMatchObject({ book: 'shop', segment: null });
  });

  it('cards of two providers on one bill -> 400 MIXED_SEGMENTS, nothing written', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const m = await cardProduct(s, { provider: 'Mobitel' });
    const r = await rawPost(s, [line(d.id, 1, 10, 1000), line(m.id, 1, 10, 2000)]);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('MIXED_SEGMENTS');
    expect([count(s, 'purchases'), count(s, 'cash_entries'), count(s, 'stock_movements')]).toEqual([0, 0, 0]);
  });

  it('Shop + Telecom stays MIXED_BOOKS', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const sh = await mkProduct(s);
    const r = await rawPost(s, [line(d.id, 1, 1, 100), line(sh.id, 1, 1, 100)]);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('MIXED_BOOKS');
  });

  it('a legacy (provider-less) product cannot be purchased', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Hutch' });
    makeLegacy(s, d.id);
    const r = await rawPost(s, [line(d.id, 1, 1, 100)]);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('SEGMENT_LEGACY_REFUSED');
    expect(err(r).fields['items.0.productId']).toBeTruthy();
    expect(count(s, 'purchases')).toBe(0);
  });
});

describe('purchases: returns and voids keep the segment', () => {
  it('return of 3 of 10 units (Rs 200.00): refund 6000 in Dialog Cards; a void reverses in the same segment', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const p = await buy(s, [line(d.id, 1, 10, 20000)]);
    const ret = await post(s.app, `/purchases/${p.id}/returns`, { businessDate: today(), items: [{ purchaseItemId: p.items[0].id, units: 3 }], clientRef: ref() });
    expect(ret.status).toBe(201);
    expect(ret.body.item.refundCents).toBe(6000);
    expect(sql(s, "SELECT amount_cents, segment, type FROM cash_entries WHERE type = 'purchase_refund'"))
      .toEqual([{ amount_cents: 6000, segment: 'dialog_cards', type: 'purchase_refund' }]);
    expect(seg.balance(s, 'dialog_cards')).toBe(-20000 + 6000);

    const p2 = await buy(s, [line(d.id, 1, 4, 4000)]);
    const v = await post(s.app, `/purchases/${p2.id}/void`, { reason: 'wrong bill' });
    expect(v.status).toBe(200);
    expect(sql(s, "SELECT amount_cents, segment, reverses_entry_id IS NOT NULL AS rev FROM cash_entries WHERE ref_id = ? AND ref_table = 'purchases' ORDER BY id", p2.id))
      .toEqual([{ amount_cents: -4000, segment: 'dialog_cards', rev: 0 }, { amount_cents: 4000, segment: 'dialog_cards', rev: 1 }]);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
  });

  it('R4 is unchanged: returning the first of two bills removes only its own cost from the pool', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Airtel' });
    const a = await buy(s, [line(d.id, 1, 10, 10000)]);
    await buy(s, [line(d.id, 1, 10, 20000)]); // pool 20 units / 30000
    const ret = await post(s.app, `/purchases/${a.id}/returns`, { businessDate: today(), items: [{ purchaseItemId: a.items[0].id, units: 10 }], clientRef: ref() });
    expect(ret.status).toBe(201);
    expect(ret.body.item.refundCents).toBe(10000);
    const pool = sql(s, 'SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?', d.id)[0]!;
    expect({ q: Number(pool.q), v: Number(pool.v) }).toEqual({ q: 10, v: 20000 });
    expect(seg.balance(s, 'airtel_cards')).toBe(-30000 + 10000);
  });
});

describe('closed day of one segment', () => {
  it('Mobitel Cards closed today: a Mobitel purchase is refused (409 DAY_CLOSED naming the segment); Dialog and Shop still work', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const m = await cardProduct(s, { provider: 'Mobitel' });
    const sh = await mkProduct(s);
    await seg.closeOk(s, 'mobitel_cards', today());
    const r = await rawPost(s, [line(m.id, 1, 1, 100)]);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('DAY_CLOSED');
    expect(err(r).message).toContain('Mobitel Cards');
    expect((await rawPost(s, [line(d.id, 1, 1, 100)])).status).toBe(201);
    expect((await rawPost(s, [line(sh.id, 1, 1, 100)])).status).toBe(201);
  });
});

describe('opening stock across providers', () => {
  it('one batch with Dialog and Mobitel cards is accepted; a closed Mobitel Cards day refuses a batch that includes Mobitel only', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const m = await cardProduct(s, { provider: 'Mobitel' });
    const ok = await openingPost(s, [unitLine(d.id, 10, 500), unitLine(m.id, 4, 250)]);
    expect(ok.status).toBe(201);
    expect(ok.body.item.totalValueCents).toBe(5000 + 1000);
    await seg.closeOk(s, 'mobitel_cards', today());
    const d2 = await cardProduct(s, { provider: 'Dialog' });
    const m2 = await cardProduct(s, { provider: 'Mobitel' });
    const bad = await openingPost(s, [unitLine(d2.id, 1, 100), unitLine(m2.id, 1, 100)]);
    expect(bad.status).toBe(409);
    expect(err(bad).code).toBe('DAY_CLOSED');
    expect((await openingPost(s, [unitLine(d2.id, 1, 100)])).status).toBe(201);
  });
});

describe('stock losses and goods use', () => {
  it('a loss of Mobitel cards is stored in mobitel_cards; its day check is per segment', async () => {
    const s = await setup();
    const m = await cardProduct(s, { provider: 'Mobitel' });
    const d = await cardProduct(s, { provider: 'Dialog' });
    await buy(s, [line(m.id, 1, 10, 10000)]);
    await buy(s, [line(d.id, 1, 10, 10000)]);
    await seg.closeOk(s, 'dialog_cards', today());
    const r = await post(s.app, '/stock-losses', { businessDate: today(), productId: m.id, qty: 2, reason: 'lost', clientRef: ref() });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ book: 'telecom', segment: 'mobitel_cards', costCents: 2000 });
    expect(sql(s, 'SELECT segment FROM stock_losses WHERE id = ?', r.body.item.id)[0]!.segment).toBe('mobitel_cards');
    const blocked = await post(s.app, '/stock-losses', { businessDate: today(), productId: d.id, qty: 1, reason: 'lost', clientRef: ref() });
    expect(blocked.status).toBe(409);
    expect(err(blocked).code).toBe('DAY_CLOSED');
    expect((await get(s.app, '/stock-losses?segment=mobitel_cards')).body.items.map((i: any) => i.id)).toEqual([r.body.item.id]);
  });

  it('goods personal use takes the product segment (Hutch Cards); a Shop product has none', async () => {
    const s = await setup();
    const h = await cardProduct(s, { provider: 'Hutch' });
    const sh = await mkProduct(s);
    await buy(s, [line(h.id, 1, 10, 10000)]);
    await buy(s, [line(sh.id, 1, 10, 10000)]);
    const r = await post(s.app, '/drawings', { kind: 'goods', businessDate: today(), productId: h.id, qty: 5, clientRef: ref() });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ book: 'telecom', segment: 'hutch_cards', amountCents: 5000 });
    const r2 = await post(s.app, '/drawings', { kind: 'goods', businessDate: today(), productId: sh.id, qty: 5, clientRef: ref() });
    expect(r2.body.item).toMatchObject({ book: 'shop', segment: null });
    expect((await post(s.app, `/drawings/${r.body.item.id}/void`, { reason: 'oops' })).status).toBe(200);
  });
});

describe('stocktakes: one provider per Telecom count', () => {
  it('segment named: stored; items of another provider -> 400 SEGMENT_MISMATCH', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const m = await cardProduct(s, { provider: 'Mobitel' });
    const ok = await post(s.app, '/stocktakes', { businessDate: today(), book: 'telecom', segment: 'mobitel_cards', items: [{ productId: m.id, countedQty: 3 }], clientRef: ref() });
    expect(ok.status).toBe(201);
    expect(ok.body.item.segment).toBe('mobitel_cards');
    const bad = await post(s.app, '/stocktakes', { businessDate: today(), book: 'telecom', segment: 'mobitel_cards', items: [{ productId: d.id, countedQty: 3 }], clientRef: ref() });
    expect(bad.status).toBe(400);
    expect(err(bad).code).toBe('SEGMENT_MISMATCH');
    expect(Object.keys(err(bad).fields)).toEqual(['items.0.productId']);
    const put = await s.app.inject({ method: 'PUT', url: `/api/v1/stocktakes/${ok.body.item.id}`, payload: { items: [{ productId: d.id, countedQty: 1 }] } });
    expect(put.statusCode).toBe(400);
    expect(JSON.parse(put.body).error.code).toBe('SEGMENT_MISMATCH');
  });

  it('inferred from the items; mixed providers -> MIXED_SEGMENTS; nothing to infer -> SEGMENT_REQUIRED; Reloads -> SEGMENT_MISMATCH; Shop with a segment -> SEGMENT_NOT_ALLOWED', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const m = await cardProduct(s, { provider: 'Mobitel' });
    const sh = await mkProduct(s);
    const body = (over: Record<string, unknown>) => ({ businessDate: today(), book: 'telecom', clientRef: ref(), ...over });
    const inferred = await post(s.app, '/stocktakes', body({ items: [{ productId: d.id, countedQty: 1 }] }));
    expect(inferred.body.item.segment).toBe('dialog_cards');
    expect(err(await post(s.app, '/stocktakes', body({ items: [{ productId: d.id, countedQty: 1 }, { productId: m.id, countedQty: 1 }] }))).code).toBe('MIXED_SEGMENTS');
    expect(err(await post(s.app, '/stocktakes', body({}))).code).toBe('SEGMENT_REQUIRED');
    expect(err(await post(s.app, '/stocktakes', body({ segment: 'dialog_reloads' }))).code).toBe('SEGMENT_MISMATCH');
    expect(err(await post(s.app, '/stocktakes', { businessDate: today(), book: 'shop', segment: 'dialog_cards', clientRef: ref() })).code).toBe('SEGMENT_NOT_ALLOWED');
    const shop = await post(s.app, '/stocktakes', { businessDate: today(), book: 'shop', items: [{ productId: sh.id, countedQty: 1 }], clientRef: ref() });
    expect(shop.status).toBe(201);
    expect(shop.body.item.segment).toBeNull();
  });

  it('completing is judged on the stocktake segment: a closed segment refuses it', async () => {
    const s = await setup();
    const m = await cardProduct(s, { provider: 'Mobitel' });
    await buy(s, [line(m.id, 1, 10, 10000)]);
    const st = await post(s.app, '/stocktakes', { businessDate: today(), book: 'telecom', segment: 'mobitel_cards', items: [{ productId: m.id, countedQty: 7 }], clientRef: ref() });
    await seg.closeOk(s, 'mobitel_cards', today());
    const blocked = await post(s.app, `/stocktakes/${st.body.item.id}/complete`, {});
    expect(blocked.status).toBe(409);
    expect(err(blocked).code).toBe('DAY_CLOSED');
  });
});

describe('valuation by Telecom segment', () => {
  it('byTelecomSegment lists the four Cards segments and sums to the Telecom total; legacy appears only with stock', async () => {
    const s = await setup();
    const d = await cardProduct(s, { provider: 'Dialog' });
    const m = await cardProduct(s, { provider: 'Mobitel' });
    await buy(s, [line(d.id, 1, 10, 50000)]);
    await buy(s, [line(m.id, 1, 4, 12000)]);
    const v = (await get(s.app, '/inventory/valuation')).body;
    expect(v.totals.byTelecomSegment).toEqual([
      { segment: 'dialog_cards', label: 'Dialog Cards', qty: 10, valueCents: 50000 },
      { segment: 'mobitel_cards', label: 'Mobitel Cards', qty: 4, valueCents: 12000 },
      { segment: 'airtel_cards', label: 'Airtel Cards', qty: 0, valueCents: 0 },
      { segment: 'hutch_cards', label: 'Hutch Cards', qty: 0, valueCents: 0 },
    ]);
    expect(v.totals.byBook.telecom).toEqual({ qty: 14, valueCents: 62000 });
    expect(v.items.find((i: any) => i.productId === m.id).segment).toBe('mobitel_cards');
    expect((await get(s.app, '/inventory/valuation?segment=mobitel_cards')).body.items.map((i: any) => i.productId)).toEqual([m.id]);

    const h = await cardProduct(s, { provider: 'Hutch' });
    await buy(s, [line(h.id, 1, 2, 700)]);
    makeLegacy(s, h.id);
    const v2 = (await get(s.app, '/inventory/valuation')).body;
    const segs = v2.totals.byTelecomSegment;
    expect(segs[segs.length - 1]).toEqual({ segment: 'legacy', label: 'Telecom before segments', qty: 2, valueCents: 700 });
    expect(segs.reduce((a: number, x: any) => a + x.valueCents, 0)).toBe(v2.totals.byBook.telecom.valueCents);
  });
});
