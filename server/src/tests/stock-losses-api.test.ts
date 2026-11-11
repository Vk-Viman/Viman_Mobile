import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, mkTelecom, productOf, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import {
  engineSell, err, FUTURE_MSG, lossNew, lossVoid, mvs, mvsByRef, num, poolOf, productsSnap, reconOk, snap, sql,
} from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const bl = (productId: number, units: number, lineTotalCents: number) => ({ productId, packs: 1, packSize: units, lineTotalCents });
async function p20(s: ApiBase, mk = mkProduct): Promise<number> {  // 20 / 700000, average 35000
  const p = await mk(s);
  await buy(s, [bl(p.id, 10, 300000)]);
  await buy(s, [bl(p.id, 10, 400000)]);
  return p.id;
}
async function pUnits(s: ApiBase, units: number, value: number, mk = mkProduct): Promise<number> {
  const p = await mk(s);
  await buy(s, [bl(p.id, units, value)]);
  return p.id;
}

const KEYS = ['backdated', 'book', 'businessDate', 'clientRef', 'costCents', 'id', 'note', 'postedAt', 'productId', 'productName', 'qty',
  'reason', 'source', 'status', 'unitCostCents', 'voidReason', 'voidedAt'];

describe('POST /stock-losses - create', () => {
  it('201 exact shape; 3 of 20/700000 at the average = 105000; pool 17/595000; one movement; no cash entry', async () => {
    const s = await setup();
    const P = await mkProduct(s, { name: 'Speaker' });
    await buy(s, [bl(P.id, 10, 300000)]);
    await buy(s, [bl(P.id, 10, 400000)]);
    const cash = num(s, 'SELECT COUNT(*) FROM cash_entries');
    const r = await lossNew(s, P.id, 3, { clientRef: 'loss-create-001', note: '  fell off the shelf  ', reason: 'damaged' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(KEYS);
    expect(r.body.item).toMatchObject({
      businessDate: today(), backdated: false, productId: P.id, productName: 'Speaker', book: 'shop', qty: 3,
      costCents: 105000, unitCostCents: 35000, reason: 'damaged', note: 'fell off the shelf', source: 'manual',
      status: 'posted', voidedAt: null, voidReason: null, clientRef: 'loss-create-001',
    });
    expect(r.body.item.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(poolOf(s, P.id)).toEqual({ qty: 17, value: 595000 });
    expect(await productOf(s, P.id)).toMatchObject({ qtyOnHand: 17, stockValueCents: 595000 });
    const m = mvsByRef(s, 'stock_losses', r.body.item.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ productId: P.id, type: 'loss', qty: -3, value: -105000, unit: 35000, date: today() });
    expect(m[0]!.value).toBe(-r.body.item.costCents);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cash);
    expect((await get(s.app, `/stock-losses/${r.body.item.id}`)).body.item).toEqual(r.body.item);
    await reconOk(s);
  });

  it('each reason works; note defaults to empty; all at the same average', async () => {
    const s = await setup();
    const P = await p20(s);
    let expectedQty = 20;
    for (const reason of ['damaged', 'lost', 'expired', 'other']) {
      const r = await lossNew(s, P, 1, { reason });
      expect(r.status, reason).toBe(201);
      expect(r.body.item).toMatchObject({ reason, costCents: 35000, unitCostCents: 35000, note: '' });
      expectedQty -= 1;
      expect(poolOf(s, P)).toEqual({ qty: expectedQty, value: expectedQty * 35000 });
    }
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements WHERE type = ?', 'loss')).toBe(4);
    await reconOk(s);
  });

  it('rounding: 2 of 3/1000 costs 667 (666.67), unit 334 (333.5); then the last unit takes the remaining 333', async () => {
    const s = await setup();
    const P = await pUnits(s, 3, 1000);
    const a = await lossNew(s, P, 2);
    expect(a.body.item).toMatchObject({ costCents: 667, unitCostCents: 334 });
    expect(poolOf(s, P)).toEqual({ qty: 1, value: 333 });
    const b = await lossNew(s, P, 1);
    expect(b.body.item).toMatchObject({ costCents: 333, unitCostCents: 333 });
    expect(poolOf(s, P)).toEqual({ qty: 0, value: 0 });
    // whole pool: entire value, no residue even for an awkward value
    const Q = await pUnits(s, 3, 1001);
    const c = await lossNew(s, Q, 3);
    expect(c.body.item.costCents).toBe(1001);
    expect(poolOf(s, Q)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  it('a zero-valued pool: loss costs 0 and is still recorded (one movement)', async () => {
    const s = await setup();
    const P = await pUnits(s, 5, 0);
    const r = await lossNew(s, P, 2);
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ costCents: 0, unitCostCents: 0 });
    expect(mvsByRef(s, 'stock_losses', r.body.item.id)).toEqual([expect.objectContaining({ qty: -2, value: 0 })]);
    await reconOk(s);
  });

  it('idempotent clientRef: a repeat returns the original with 200 and writes no second loss or movement', async () => {
    const s = await setup();
    const P = await p20(s);
    const body = { businessDate: today(), productId: P, qty: 2, reason: 'lost', clientRef: 'loss-idem-0001' };
    const a = await post(s.app, '/stock-losses', body);
    expect(a.status).toBe(201);
    const before = snap(s);
    const pool = poolOf(s, P);
    for (let i = 0; i < 3; i++) {
      const b = await post(s.app, '/stock-losses', { ...body, qty: 5, reason: 'other' });
      expect(b.status).toBe(200);
      expect(b.body.item).toEqual(a.body.item);
    }
    expect(snap(s)).toEqual(before);
    expect(poolOf(s, P)).toEqual(pool);
    expect(num(s, "SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'stock_losses'")).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(1);
    expect(pool).toEqual({ qty: 18, value: 630000 });
  });

  it('product checks: unknown -> 400 VALIDATION_ERROR, service -> 400 PRODUCT_NOT_STOCKABLE; inactive stock products ARE allowed', async () => {
    const s = await setup();
    const svc = await mkProduct(s, { kind: 'service' });
    const P = await p20(s);
    const before = snap(s);
    const unk = await lossNew(s, 99999, 1);
    expect(unk.status).toBe(400);
    expect(err(unk)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { productId: 'Product not found.' } });
    const sv = await lossNew(s, svc.id, 1);
    expect(sv.status).toBe(400);
    expect(err(sv).code).toBe('PRODUCT_NOT_STOCKABLE');
    expect(err(sv).fields.productId).toBeTruthy();
    expect(snap(s)).toEqual(before);
    s.ctx.database.conn.prepare('UPDATE products SET active = 0 WHERE id = ?').run(P);
    const ok = await lossNew(s, P, 1);
    expect(ok.status).toBe(201);
    expect(poolOf(s, P)).toEqual({ qty: 19, value: 665000 });
  });

  it('INSUFFICIENT_STOCK: more than on hand (or any on an empty product) -> 422, nothing written', async () => {
    const s = await setup();
    const P = await pUnits(s, 3, 1000);
    const E = await mkProduct(s);
    const before = snap(s);
    const pools = productsSnap(s);
    const r = await lossNew(s, P, 4);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', message: 'Not enough stock: 3 on hand, 4 needed.', onHand: 3, productId: P });
    const e = await lossNew(s, E.id, 1);
    expect(e.status).toBe(422);
    expect(err(e).code).toBe('INSUFFICIENT_STOCK');
    expect(snap(s)).toEqual(before);
    expect(productsSnap(s)).toBe(pools);
    expect((await lossNew(s, P, 3)).status).toBe(201); // exactly the quantity on hand is fine
    await reconOk(s);
  });

  it('schema: qty integer >= 1 (no coercion), reason enum, required fields, unknown fields (book, postedAt), clientRef, note length', async () => {
    const s = await setup();
    const P = await p20(s);
    for (const q of [0, -1, 1.5, '2', null, 1000000001, true]) {
      const r = await lossNew(s, P, q as number);
      expect(r.status, JSON.stringify(q)).toBe(400);
      expect(err(r).fields.qty, JSON.stringify(q)).toBeTruthy();
    }
    for (const bad of ['stolen', 'DAMAGED', '', null, 5]) {
      expect(err(await lossNew(s, P, 1, { reason: bad })).fields.reason, String(bad)).toBeTruthy();
    }
    for (const k of ['businessDate', 'productId', 'qty', 'reason', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), productId: P, qty: 1, reason: 'lost', clientRef: ref() };
      delete body[k];
      const r = await post(s.app, '/stock-losses', body);
      expect(r.status, k).toBe(400);
      expect(err(r).fields[k], k).toBeTruthy();
    }
    expect(err(await lossNew(s, P, 1, { book: 'telecom' })).fields.book).toBe('Unknown field.');
    expect(err(await lossNew(s, P, 1, { postedAt: '2020-01-01T00:00:00.000Z' })).fields.postedAt).toBeTruthy();
    expect(err(await lossNew(s, P, 1, { source: 'damaged_return' })).fields.source).toBeTruthy();
    expect(err(await lossNew(s, P, 1, { costCents: 5 })).fields.costCents).toBeTruthy();
    expect(err(await lossNew(s, '1' as unknown as number, 1)).fields.productId).toBeTruthy();
    expect((await lossNew(s, 0, 1)).status).toBe(400);
    for (const c of ['short', 'with space 1234', 'y'.repeat(65)]) expect((await lossNew(s, P, 1, { clientRef: c })).status, c).toBe(400);
    expect((await lossNew(s, P, 1, { note: 'n'.repeat(501) })).status).toBe(400);
    expect((await lossNew(s, P, 1, { note: 'n'.repeat(500) })).status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(1);
  });

  it('the book comes from the product (a Telecom product stays in the telecom book); Shop and Telecom are independent', async () => {
    const s = await setup();
    const shop = await p20(s);
    const tel = await pUnits(s, 10, 50000, mkTelecom);       // 5000 each
    const a = await lossNew(s, tel, 2, { reason: 'expired' });
    expect(a.body.item).toMatchObject({ book: 'telecom', costCents: 10000, unitCostCents: 5000 });
    expect(poolOf(s, tel)).toEqual({ qty: 8, value: 40000 });
    expect(poolOf(s, shop)).toEqual({ qty: 20, value: 700000 });
    const b = await lossNew(s, shop, 2);
    expect(b.body.item).toMatchObject({ book: 'shop', costCents: 70000 });
    expect(poolOf(s, tel)).toEqual({ qty: 8, value: 40000 });
    expect(sql(s, 'SELECT book FROM stock_losses ORDER BY id').map((r) => r.book)).toEqual(['telecom', 'shop']);
    await reconOk(s);
  });

  it('dates: future -> exact FUTURE_DATE_NOT_ALLOWED; impossible -> 400; backdated flagged and its movement carries the business date', async () => {
    const s = await setup();
    const P = await p20(s);
    const before = snap(s);
    for (const d of [daysAhead(1), '2999-01-01']) {
      const r = await lossNew(s, P, 1, { businessDate: d });
      expect(r.status).toBe(400);
      expect(err(r)).toEqual({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    }
    for (const d of ['2026-02-31', 'abc', '2026-5-1']) {
      const r = await lossNew(s, P, 1, { businessDate: d });
      expect(r.status, d).toBe(400);
      expect(err(r).fields.businessDate, d).toBeTruthy();
    }
    expect(snap(s)).toEqual(before);
    const r = await lossNew(s, P, 2, { businessDate: daysAgo(9) });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ businessDate: daysAgo(9), backdated: true });
    expect(mvsByRef(s, 'stock_losses', r.body.item.id)[0]).toMatchObject({ date: daysAgo(9), qty: -2, value: -70000 });
    // posting order drives costing: the backdated loss is costed at today's pool
    expect(poolOf(s, P)).toEqual({ qty: 18, value: 630000 });
    await reconOk(s);
  });
});

// =============================================================================================
describe('GET /stock-losses', () => {
  async function scenario(s: ApiBase) {
    const P = await p20(s);
    const T = await pUnits(s, 10, 50000, mkTelecom);
    const L1 = (await lossNew(s, P, 1, { reason: 'damaged', businessDate: daysAgo(6) })).body.item;  // 35000
    const L2 = (await lossNew(s, P, 2, { reason: 'lost', businessDate: daysAgo(3) })).body.item;     // 70000 (19/665000 * 2/19)
    const L3 = (await lossNew(s, T, 2, { reason: 'expired', businessDate: daysAgo(3) })).body.item;  // 10000
    const L4 = (await lossNew(s, P, 1, { reason: 'other' })).body.item;                              // 35000 (17/595000)
    expect([L1.costCents, L2.costCents, L3.costCents, L4.costCents]).toEqual([35000, 70000, 10000, 35000]);
    expect((await lossVoid(s, L2.id)).status).toBe(200);
    return { P, T, L1, L2, L3, L4 };
  }

  it('lists newest business date first (id DESC within a date); total counts every row, totalCostCents only posted', async () => {
    const s = await setup();
    const { L1, L2, L3, L4 } = await scenario(s);
    const all = (await get(s.app, '/stock-losses')).body;
    expect(all.items.map((i: any) => i.id)).toEqual([L4.id, L3.id, L2.id, L1.id]);
    expect(all.total).toBe(4);
    expect(all.totalCostCents).toBe(35000 + 10000 + 35000); // L2 is void
    expect(all.items[2]).toMatchObject({ status: 'void', voidReason: 'test void' });
  });

  it('filters: status, book, reason, productId, from, to (each with its own total and totalCostCents)', async () => {
    const s = await setup();
    const { P, T, L1, L2, L3, L4 } = await scenario(s);
    const q = async (qs: string) => (await get(s.app, `/stock-losses?${qs}`)).body;
    let r = await q('status=void');
    expect([r.items.map((i: any) => i.id), r.total, r.totalCostCents]).toEqual([[L2.id], 1, 0]);
    r = await q('status=posted');
    expect([r.items.map((i: any) => i.id), r.total, r.totalCostCents]).toEqual([[L4.id, L3.id, L1.id], 3, 80000]);
    r = await q('book=telecom');
    expect([r.items.map((i: any) => i.id), r.total, r.totalCostCents]).toEqual([[L3.id], 1, 10000]);
    r = await q('book=shop');
    expect([r.total, r.totalCostCents]).toEqual([3, 70000]);
    r = await q('reason=damaged');
    expect([r.items.map((i: any) => i.id), r.totalCostCents]).toEqual([[L1.id], 35000]);
    r = await q('reason=lost');
    expect([r.total, r.totalCostCents]).toEqual([1, 0]); // the only 'lost' row is void
    r = await q(`productId=${P}`);
    expect([r.items.map((i: any) => i.id), r.total, r.totalCostCents]).toEqual([[L4.id, L2.id, L1.id], 3, 70000]);
    r = await q(`productId=${T}`);
    expect(r.items.map((i: any) => i.id)).toEqual([L3.id]);
    r = await q(`from=${daysAgo(3)}`);
    expect([r.items.map((i: any) => i.id), r.total, r.totalCostCents]).toEqual([[L4.id, L3.id, L2.id], 3, 45000]);
    r = await q(`to=${daysAgo(3)}`);
    expect([r.items.map((i: any) => i.id), r.total, r.totalCostCents]).toEqual([[L3.id, L2.id, L1.id], 3, 45000]);
    r = await q(`from=${daysAgo(3)}&to=${daysAgo(3)}&status=posted&book=telecom`);
    expect([r.items.map((i: any) => i.id), r.totalCostCents]).toEqual([[L3.id], 10000]);
    r = await q(`from=${daysAhead(2)}`);
    expect(r).toEqual({ items: [], total: 0, totalCostCents: 0 });
  });

  it('paging keeps total/totalCostCents of the whole filter; limits 1..200; bad query values 400', async () => {
    const s = await setup();
    const { L1, L3 } = await scenario(s);
    const r = (await get(s.app, '/stock-losses?limit=2&offset=1')).body;
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(4);
    expect(r.totalCostCents).toBe(80000);
    expect((await get(s.app, '/stock-losses?limit=1&offset=3')).body.items[0].id).toBe(L1.id);
    expect((await get(s.app, '/stock-losses?limit=200')).status).toBe(200);
    for (const q of ['limit=0', 'limit=201', 'limit=x', 'offset=-1', 'reason=stolen', 'status=draft', 'book=icecream', 'from=2026-02-31', 'to=abc', 'productId=abc', 'foo=1']) {
      expect((await get(s.app, `/stock-losses?${q}`)).status, q).toBe(400);
    }
    expect((await get(s.app, '/stock-losses/99999')).status).toBe(404);
    expect((await get(s.app, '/stock-losses/abc')).status).toBe(400);
    expect(L3.id).toBeGreaterThan(0);
  });
});

// =============================================================================================
describe('POST /stock-losses/:id/void', () => {
  it('restores stock and value exactly with a reversal movement (type loss, +qty, +cost) on the original business date', async () => {
    const s = await setup();
    const P = await p20(s);
    const l = (await lossNew(s, P, 3, { businessDate: daysAgo(4) })).body.item;
    expect(poolOf(s, P)).toEqual({ qty: 17, value: 595000 });
    const r = await lossVoid(s, l.id, '  entered twice ');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id: l.id, status: 'void', voidReason: 'entered twice', qty: 3, costCents: 105000, backdated: true });
    expect(r.body.item.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
    const m = mvsByRef(s, 'stock_losses', l.id);
    expect(m.map((x) => [x.type, x.qty, x.value, x.date])).toEqual([['loss', -3, -105000, daysAgo(4)], ['loss', 3, 105000, daysAgo(4)]]);
    expect(m[1]!.reason).toBe(`Void of stock loss #${l.id}`);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'purchase_payment'"));
    await reconOk(s);
  });

  it('restores the exact original value even after later sales changed the pool', async () => {
    const s = await setup();
    const P = await pUnits(s, 3, 1000);
    const l = (await lossNew(s, P, 2)).body.item;   // cost 667, pool 1/333
    engineSell(s, P, 1);                            // pool 0/0
    expect((await lossVoid(s, l.id)).status).toBe(200);
    expect(poolOf(s, P)).toEqual({ qty: 2, value: 667 });
    await reconOk(s);
  });

  it('ALREADY_VOID, unknown id, reason validation; nothing written on failure', async () => {
    const s = await setup();
    const P = await p20(s);
    const l = (await lossNew(s, P, 1)).body.item;
    for (const bad of ['', '   ', 'x'.repeat(201)]) {
      const r = await post(s.app, `/stock-losses/${l.id}/void`, { reason: bad });
      expect(r.status).toBe(400);
      expect(err(r).fields.reason).toBeTruthy();
    }
    expect((await post(s.app, `/stock-losses/${l.id}/void`, {})).status).toBe(400);
    expect((await post(s.app, `/stock-losses/${l.id}/void`, { reason: 'x', extra: 1 })).status).toBe(400);
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements WHERE type = ?', 'loss')).toBe(1);
    expect((await lossVoid(s, l.id)).status).toBe(200);
    const before = snap(s);
    const again = await lossVoid(s, l.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(snap(s)).toEqual(before);
    expect((await lossVoid(s, 99999)).status).toBe(404);
    expect((await post(s.app, '/stock-losses/abc/void', { reason: 'x' })).status).toBe(400);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
  });

  it('a voided loss no longer counts in totalCostCents but stays listed; a repeat of its clientRef still returns it', async () => {
    const s = await setup();
    const P = await p20(s);
    const l = (await lossNew(s, P, 1, { clientRef: 'loss-void-idem1' })).body.item;
    await lossVoid(s, l.id);
    const list = (await get(s.app, '/stock-losses')).body;
    expect(list).toMatchObject({ total: 1, totalCostCents: 0 });
    expect(list.items[0].status).toBe('void');
    const again = await post(s.app, '/stock-losses', { businessDate: today(), productId: P, qty: 1, reason: 'damaged', clientRef: 'loss-void-idem1' });
    expect(again.status).toBe(200);
    expect(again.body.item.status).toBe('void');
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(1);
  });
});

// =============================================================================================
describe('audit and atomicity', () => {
  it('audit: entity "stock_loss" create and void with businessDate and backdated', async () => {
    const s = await setup();
    const P = await p20(s);
    const l = (await lossNew(s, P, 1, { businessDate: daysAgo(2) })).body.item;
    await lossVoid(s, l.id, 'oops');
    const rows = sql(s, "SELECT action, entity_id, business_date, backdated, note FROM audit_logs WHERE entity = 'stock_loss' ORDER BY id");
    expect(rows.map((r) => r.action)).toEqual(['create', 'void']);
    expect(rows.every((r) => r.entity_id === String(l.id) && r.business_date === daysAgo(2) && Number(r.backdated) === 1)).toBe(true);
    expect(rows[1]!.note).toBe('oops');
    const a = auditRows(s.ctx, 'stock_loss');
    expect(a[0]!.before).toBeNull();
    expect(a[0]!.after).toMatchObject({ qty: 1, costCents: 35000, status: 'posted' });
    expect(a[1]!.before.status).toBe('posted');
    expect(a[1]!.after.status).toBe('void');
    // idempotent repeats and rejected requests add nothing
    await post(s.app, '/stock-losses', { businessDate: daysAgo(2), productId: P, qty: 1, reason: 'damaged', clientRef: l.clientRef });
    await lossNew(s, P, 999);
    expect(auditRows(s.ctx, 'stock_loss')).toHaveLength(2);
  });

  it('create: failing audit rolls back the loss row AND the movement; stock unchanged; retry works', async () => {
    const s = await setup();
    quiet();
    const P = await p20(s);
    breakAudit(s.ctx, 'stock_loss');
    const before = snap(s);
    const pools = productsSnap(s);
    const body = { businessDate: today(), productId: P, qty: 4, reason: 'lost', clientRef: 'loss-atomic-001' };
    const r = await post(s.app, '/stock-losses', body);
    expect(r.status).toBe(500);
    expect(err(r).code).toBe('INTERNAL_ERROR');
    expect(snap(s)).toEqual(before);
    expect(productsSnap(s)).toBe(pools);
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await post(s.app, '/stock-losses', body)).status).toBe(201);
    expect(poolOf(s, P)).toEqual({ qty: 16, value: 560000 });
    await reconOk(s);
  });

  it('create: a failing movement insert rolls back the loss row (no loss without its movement)', async () => {
    const s = await setup();
    quiet();
    const P = await p20(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_fail_move BEFORE INSERT ON stock_movements
      WHEN NEW.type = 'loss' BEGIN SELECT RAISE(ABORT, 'movement boom'); END`);
    const before = snap(s);
    const r = await lossNew(s, P, 1);
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
  });

  it('void: failing audit leaves the loss posted with no reversal movement', async () => {
    const s = await setup();
    quiet();
    const P = await p20(s);
    const l = (await lossNew(s, P, 2)).body.item;
    breakAudit(s.ctx, 'stock_loss');
    const before = snap(s);
    const r = await lossVoid(s, l.id);
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(sql(s, 'SELECT status, voided_at, void_reason FROM stock_losses')[0]).toEqual({ status: 'posted', voided_at: null, void_reason: null });
    expect(poolOf(s, P)).toEqual({ qty: 18, value: 630000 });
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await lossVoid(s, l.id)).status).toBe(200);
    expect(poolOf(s, P)).toEqual({ qty: 20, value: 700000 });
  });

  it('every record has exactly one movement on its own (refTable, refId); reconciliation ok after each step of a mixed run', async () => {
    const s = await setup();
    const P = await p20(s);
    const T = await pUnits(s, 10, 50000, mkTelecom);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await lossNew(s, i % 2 === 0 ? P : T, 1 + (i % 2));
      expect(r.status).toBe(201);
      ids.push(r.body.item.id);
      await reconOk(s);
    }
    for (const id of ids) expect(mvsByRef(s, 'stock_losses', id)).toHaveLength(1);
    for (const id of ids.slice(0, 3)) { expect((await lossVoid(s, id)).status).toBe(200); await reconOk(s); }
    for (const id of ids.slice(0, 3)) expect(mvsByRef(s, 'stock_losses', id)).toHaveLength(2);
    for (const id of ids.slice(3)) expect(mvsByRef(s, 'stock_losses', id)).toHaveLength(1);
    expect(mvs(s, "type = 'loss'").filter((m) => m.qty > 0)).toHaveLength(3);
  });
});
