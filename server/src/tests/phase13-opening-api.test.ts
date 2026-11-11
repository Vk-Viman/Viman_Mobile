// Phase 13 - manual opening stock API (POST/GET /opening-stock, void) - API level (Fastify inject, real temp database).
// Protects BUSINESS_RULES section 3 (opening stock is an inflow through the engine: exact value, weighted average with later
// purchases, NO cash entry / purchase / P&L), R1 + C6 (void = exact reversal through the engine, original date, blocked with
// OPENING_BATCH_IN_USE when the stock was used), R-FD (no future date, exact message), section 12 (clientRef idempotency, audit
// row with business date + backdated flag) and atomicity (a failing request writes nothing).
// Hand-calculated figures are in cents: Rs 50.00 = 5000, Rs 70.00 = 7000.
// Organised as: create, weighted-average with purchases, validation, idempotency/audit, atomic rollback, list/get, void,
// reconciliation and valuation.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, count, get, post } from './helpers/catalog.ts';
import { apiBase, buy, cashRows, daysAgo, daysAhead, mkProduct, mkTelecom, productOf, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { WRITE_TABLES, mkSku, openingOk, openingPost, rowsOf, totalLine, unitLine } from './helpers/phase13.ts';
import { issueStock, reconcileStock } from '../services/inventory.service.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const FUTURE_MSG = 'Future-dated transactions are not allowed. Please select today or an earlier date.';
const err = (r: { body: any }) => r.body.error;
const snap = (s: ApiBase) => Object.fromEntries(WRITE_TABLES.map((t) => [t, count(s.ctx, t)]));
const sell = (s: ApiBase, productId: number, qty: number) =>
  s.ctx.database.tx((c) => issueStock(c, { productId, businessDate: today(), type: 'sale', qty, refTable: null, refId: null, reason: 'test sale' }));
const voidB = (s: ApiBase, id: number, reason = 'entered by mistake') => post(s.app, `/opening-stock/${id}/void`, { reason });
const recon = (s: ApiBase) => expect(reconcileStock(s.ctx.database.conn)).toMatchObject({ ok: true, mismatches: [] });
const movesOf = (s: ApiBase, productId: number) =>
  rowsOf(s.ctx.database.conn, 'SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id', productId)
    .map((m) => ({ type: m.type, qty: Number(m.qty_delta), value: Number(m.value_delta_cents), date: m.business_date, refTable: m.ref_table, refId: m.ref_id === null ? null : Number(m.ref_id) }));

const BATCH_KEYS = [
  'backdated', 'businessDate', 'clientRef', 'fileName', 'id', 'items', 'notes', 'postedAt', 'rowCount', 'source', 'status',
  'totalValueCents', 'voidReason', 'voidedAt',
].sort();
const LINE_KEYS = ['productCode', 'productId', 'productName', 'qty', 'unitCostCents', 'valueCents'].sort();

describe('POST /opening-stock - create', () => {
  it('creates one batch and one opening movement per line; qty and value land in the pool (unit cost line)', async () => {
    const s = await setup();
    const a = await mkProduct(s);
    const b = await mkProduct(s);
    const r = await openingPost(s, [unitLine(a.id, 10, 5000), unitLine(b.id, 3, 1234)], { notes: ' go-live ' });
    expect(r.status).toBe(201);
    const item = r.body.item;
    expect(Object.keys(item).sort()).toEqual(BATCH_KEYS);
    expect(Object.keys(item.items[0]).sort()).toEqual(LINE_KEYS);
    expect(item).toMatchObject({ source: 'manual', fileName: null, rowCount: 2, totalValueCents: 50000 + 3702, status: 'posted', notes: 'go-live', backdated: false });
    expect(item.items).toEqual([
      { productId: a.id, productCode: null, productName: a.name, qty: 10, valueCents: 50000, unitCostCents: 5000 },
      { productId: b.id, productCode: null, productName: b.name, qty: 3, valueCents: 3702, unitCostCents: 1234 },
    ]);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 50000, avgUnitCostCents: 5000 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 3, stockValueCents: 3702 });
    expect(movesOf(s, a.id)).toEqual([{ type: 'opening', qty: 10, value: 50000, date: today(), refTable: 'opening_stock_batches', refId: item.id }]);
    recon(s);
  });
  it('uses the EXACT entered total (no per-unit rounding): 3 units for Rs 100.00 is value 10000, shown as 3333 each', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [totalLine(p.id, 3, 10000)]);
    expect(item.items[0]).toMatchObject({ qty: 3, valueCents: 10000, unitCostCents: 3333 });
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 3, stockValueCents: 10000 });
  });
  it('qty x unit cost is exact integer arithmetic (7 x 3333 = 23331)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 7, 3333)]);
    expect(item.totalValueCents).toBe(23331);
  });
  it('accepts a zero-value line (free stock) and a telecom (scratch card) product', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const t = await mkTelecom(s);
    const item = await openingOk(s, [totalLine(p.id, 5, 0), unitLine(t.id, 2, 9000)]);
    expect(item.totalValueCents).toBe(18000);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 0 });
  });
  it('creates NO cash entry, NO purchase and NO stock loss (no cash / P&L side)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await openingOk(s, [unitLine(p.id, 10, 5000)]);
    expect(cashRows(s.ctx)).toEqual([]);
    expect(count(s.ctx, 'purchases')).toBe(0);
    expect(count(s.ctx, 'purchase_items')).toBe(0);
    expect(count(s.ctx, 'stock_losses')).toBe(0);
  });
  it('a backdated batch is allowed, keeps its date on the movements and is flagged backdated', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const d = daysAgo(30);
    const item = await openingOk(s, [unitLine(p.id, 4, 100)], { businessDate: d });
    expect(item).toMatchObject({ businessDate: d, backdated: true });
    expect(movesOf(s, p.id)[0]!.date).toBe(d);
  });
  it('a product that already has stock gets the opening units added (average moves)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 70000 }]);
    await openingOk(s, [unitLine(p.id, 10, 5000)]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 20, stockValueCents: 120000, avgUnitCostCents: 6000 });
  });
});

describe('weighted average with later purchases (hand-calculated)', () => {
  it('opening 10 @ Rs 50.00 then purchase 10 @ Rs 70.00 -> 20 units, value Rs 1,200.00, average Rs 60.00', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await openingOk(s, [unitLine(p.id, 10, 5000)]);
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 70000 }]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 20, stockValueCents: 120000, avgUnitCostCents: 6000 });
    // Selling 5 removes 5 x 60.00 = Rs 300.00 at the average, leaving 15 units worth Rs 900.00.
    const out = sell(s, p.id, 5);
    expect(out.valueRemovedCents).toBe(30000);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 15, stockValueCents: 90000 });
    // Cash: only the purchase paid anything (Rs 700.00); the opening stock moved no cash.
    expect(cashRows(s.ctx).map((c) => Number(c.amount_cents))).toEqual([-70000]);
    recon(s);
  });
  it('opening 4 for Rs 100.00 (exact total) then sell 1 removes round(10000 x 1 / 4) = 2500; sell the last 3 removes the whole remaining 7500', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await openingOk(s, [totalLine(p.id, 4, 10000)]);
    expect(sell(s, p.id, 1).valueRemovedCents).toBe(2500);
    expect(sell(s, p.id, 3).valueRemovedCents).toBe(7500);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
  });
  it('two openings for the same product (two batches) add up: 10 @ 50.00 + 5 @ 80.00 = 15 units, Rs 900.00', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await openingOk(s, [unitLine(p.id, 10, 5000)]);
    await openingOk(s, [unitLine(p.id, 5, 8000)]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 15, stockValueCents: 90000, avgUnitCostCents: 6000 });
  });
});

describe('POST /opening-stock - validation', () => {
  it('requires businessDate, items and clientRef; rejects unknown properties and bad shapes', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const ok = { businessDate: today(), items: [unitLine(p.id, 1, 100)], clientRef: ref() };
    for (const body of [
      { ...ok, businessDate: undefined }, { ...ok, items: undefined }, { ...ok, clientRef: undefined }, { ...ok, items: [] },
      { ...ok, extra: 1 }, { ...ok, clientRef: 'short' }, { ...ok, businessDate: '2026-02-30' }, { ...ok, businessDate: 'today' },
      { ...ok, items: [{ productId: p.id, qty: 1, unitCostCents: 100, bogus: 1 }] },
      { ...ok, items: [{ qty: 1, unitCostCents: 100 }] },
      { ...ok, items: [{ productId: p.id, unitCostCents: 100 }] },
      { ...ok, items: [{ productId: p.id, qty: 0, unitCostCents: 100 }] },
      { ...ok, items: [{ productId: p.id, qty: -1, unitCostCents: 100 }] },
      { ...ok, items: [{ productId: p.id, qty: 1.5, unitCostCents: 100 }] },
      { ...ok, items: [{ productId: p.id, qty: '1', unitCostCents: 100 }] },
      { ...ok, items: [{ productId: p.id, qty: 1, unitCostCents: -1 }] },
      { ...ok, items: [{ productId: p.id, qty: 1, unitCostCents: 1.5 }] },
      { ...ok, items: [{ productId: p.id, qty: 1, totalValueCents: -5 }] },
      { ...ok, items: [{ productId: p.id, qty: 1, unitCostCents: null }] },
      { ...ok, items: [{ productId: p.id, qty: 1_000_000_001, unitCostCents: 1 }] },
      { ...ok, items: [{ productId: p.id, qty: 1, unitCostCents: 100_000_000_000 }] },
    ]) {
      const before = snap(s);
      const r = await post(s.app, '/opening-stock', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(snap(s)).toEqual(before);
    }
  });
  it('exactly one of unitCostCents / totalValueCents per line (both or neither -> 400 with the field)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    for (const line of [{ productId: p.id, qty: 2, unitCostCents: 100, totalValueCents: 200 }, { productId: p.id, qty: 2 }]) {
      const r = await openingPost(s, [line]);
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(err(r).fields).toHaveProperty(['items.0.unitCostCents']);
    }
    expect(count(s.ctx, 'opening_stock_batches')).toBe(0);
  });
  it('qty x unit cost too large -> 400', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const r = await openingPost(s, [unitLine(p.id, 1_000_000_000, 99_999_999_999)]);
    expect(r.status).toBe(400);
  });
  it('notes longer than 500 characters -> 400', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const r = await openingPost(s, [unitLine(p.id, 1, 1)], { notes: 'x'.repeat(501) });
    expect(r.status).toBe(400);
    expect(err(r).fields).toHaveProperty('notes');
  });
  it('R-FD: tomorrow is refused with the exact message and nothing is written; today and the past are allowed', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const before = snap(s);
    const r = await openingPost(s, [unitLine(p.id, 1, 100)], { businessDate: daysAhead(1) });
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    expect(snap(s)).toEqual(before);
    expect((await openingPost(s, [unitLine(p.id, 1, 100)], { businessDate: today() })).status).toBe(201);
    expect((await openingPost(s, [unitLine(p.id, 1, 100)], { businessDate: daysAgo(100) })).status).toBe(201);
  });
  it('unknown product, inactive product and a service product -> 422 INVALID_PRODUCT with items.N.productId', async () => {
    const s = await setup();
    const good = await mkProduct(s);
    const off = await mkProduct(s);
    await s.app.inject({ method: 'PUT', url: `/api/v1/products/${off.id}`, payload: { active: false } });
    const svc = await mkProduct(s, { kind: 'service' });
    const before = snap(s);
    const r = await openingPost(s, [unitLine(good.id, 1, 100), unitLine(999999, 1, 100), unitLine(off.id, 1, 100), unitLine(svc.id, 1, 100)]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('INVALID_PRODUCT');
    expect(Object.keys(err(r).fields).sort()).toEqual(['items.1.productId', 'items.2.productId', 'items.3.productId']);
    expect(err(r).fields['items.1.productId']).toMatch(/not found/i);
    expect(err(r).fields['items.2.productId']).toMatch(/inactive/i);
    expect(err(r).fields['items.3.productId']).toMatch(/stock/i);
    expect(snap(s)).toEqual(before); // the good first line was NOT saved
  });
  it('the same product on two lines -> 422 DUPLICATE_PRODUCT naming the later line', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const q = await mkProduct(s);
    const r = await openingPost(s, [unitLine(p.id, 1, 100), unitLine(q.id, 1, 100), totalLine(p.id, 2, 500)]);
    expect(r.status).toBe(422);
    expect(err(r)).toMatchObject({ code: 'DUPLICATE_PRODUCT', fields: { 'items.2.productId': expect.any(String) } });
    expect(count(s.ctx, 'opening_stock_batches')).toBe(0);
  });
});

describe('idempotency and audit', () => {
  it('the same clientRef returns the original (200), writes nothing new, even if the product changed since', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const clientRef = ref();
    const first = await openingPost(s, [unitLine(p.id, 10, 5000)], { clientRef });
    expect(first.status).toBe(201);
    await s.app.inject({ method: 'PUT', url: `/api/v1/products/${p.id}`, payload: { active: false } });
    const before = snap(s);
    const again = await openingPost(s, [unitLine(p.id, 99, 1)], { clientRef });
    expect(again.status).toBe(200);
    expect(again.body.item).toEqual(first.body.item);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 50000 });
  });
  it('writes one audit row with the business date and the backdated flag, in the same transaction', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 1, 100)], { businessDate: daysAgo(3) });
    const rows = rowsOf(s.ctx.database.conn, "SELECT * FROM audit_logs WHERE entity = 'opening_stock_batch'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: String(item.id), action: 'create', business_date: daysAgo(3), backdated: 1 });
    expect(auditRows(s.ctx, 'opening_stock_batch')[0]!.after).toMatchObject({ id: item.id, totalValueCents: 100 });
  });
  it('a failing audit write rolls EVERYTHING back (batch, movements, cache)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    breakAudit(s.ctx, 'opening_stock_batch');
    const before = snap(s);
    const r = await openingPost(s, [unitLine(p.id, 10, 5000)]);
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
  });
});

describe('atomic rollback', () => {
  it('a pool overflow on a later line rolls back the earlier lines (400, nothing saved)', async () => {
    const s = await setup();
    const a = await mkProduct(s);
    const b = await mkProduct(s);
    // Put b close to the safe-integer limit through the ledger, so adding more overflows.
    s.ctx.database.conn.prepare(
      "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'opening', 1, ?, 'test')",
    ).run(b.id, today(), Number.MAX_SAFE_INTEGER - 5);
    const before = snap(s);
    const r = await openingPost(s, [unitLine(a.id, 10, 5000), totalLine(b.id, 1, 99_999_999_999)]);
    expect(r.status).toBe(400);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
  });
});

describe('GET /opening-stock and /opening-stock/:id', () => {
  it('lists newest business date first with total and posted-only totals; filters by date and status; pages', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const q = await mkProduct(s);
    const b1 = await openingOk(s, [unitLine(p.id, 1, 1000)], { businessDate: daysAgo(10) });
    const b2 = await openingOk(s, [unitLine(q.id, 2, 500), unitLine(p.id, 1, 100)] as any, { businessDate: daysAgo(5) });
    const b3 = await openingOk(s, [totalLine(q.id, 3, 777)], { businessDate: daysAgo(1) });
    await voidB(s, b3.id);
    const all = (await get(s.app, '/opening-stock')).body;
    expect(all.items.map((i: any) => i.id)).toEqual([b3.id, b2.id, b1.id]);
    expect(all.total).toBe(3);
    expect(all.totals).toEqual({ valueCents: 1000 + 1100, lines: 1 + 2 }); // the voided batch (777, 1 line) is not summed
    expect(all.items[0]).not.toHaveProperty('items');
    expect(Object.keys(all.items[0]).sort()).toEqual(BATCH_KEYS.filter((k) => k !== 'items'));
    expect((await get(s.app, '/opening-stock?status=void')).body.items.map((i: any) => i.id)).toEqual([b3.id]);
    expect((await get(s.app, '/opening-stock?status=posted')).body.total).toBe(2);
    expect((await get(s.app, `/opening-stock?from=${daysAgo(6)}&to=${daysAgo(2)}`)).body.items.map((i: any) => i.id)).toEqual([b2.id]);
    const page = (await get(s.app, '/opening-stock?limit=1&offset=1')).body;
    expect(page.items.map((i: any) => i.id)).toEqual([b2.id]);
    expect(page.total).toBe(3);
  });
  it('rejects bad query parameters with 400', async () => {
    const s = await setup();
    for (const q of ['status=draft', 'from=2026-02-30', 'limit=0', 'limit=201', 'bogus=1', 'offset=-1']) {
      expect((await get(s.app, `/opening-stock?${q}`)).status, q).toBe(400);
    }
  });
  it('GET /:id returns the batch with its lines; unknown or bad id -> 404 / 400', async () => {
    const s = await setup();
    const p = await mkSku(s, 'ABC-1');
    const item = await openingOk(s, [unitLine(p.id, 2, 250)]);
    const r = await get(s.app, `/opening-stock/${item.id}`);
    expect(r.status).toBe(200);
    expect(r.body.item.items).toEqual([{ productId: p.id, productCode: 'ABC-1', productName: p.name, qty: 2, valueCents: 500, unitCostCents: 250 }]);
    expect((await get(s.app, '/opening-stock/99999')).status).toBe(404);
    expect((await get(s.app, '/opening-stock/abc')).status).toBe(400);
  });
});

describe('POST /opening-stock/:id/void (R1, C6)', () => {
  it('reverses the stock through the engine with the ORIGINAL date, marks the batch void, creates no cash, audits it', async () => {
    const s = await setup();
    const a = await mkProduct(s);
    const b = await mkProduct(s);
    const d = daysAgo(7);
    const item = await openingOk(s, [unitLine(a.id, 10, 5000), totalLine(b.id, 3, 10000)], { businessDate: d });
    const r = await voidB(s, item.id, '  wrong file  ');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'void', voidReason: 'wrong file' });
    expect(r.body.item.voidedAt).toEqual(expect.any(String));
    expect(r.body.item.items.map((l: any) => l.qty)).toEqual([10, 3]); // the lines are still shown
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(movesOf(s, a.id)).toEqual([
      { type: 'opening', qty: 10, value: 50000, date: d, refTable: 'opening_stock_batches', refId: item.id },
      { type: 'opening', qty: -10, value: -50000, date: d, refTable: 'opening_stock_batches', refId: item.id },
    ]);
    expect(cashRows(s.ctx)).toEqual([]);
    const audit = rowsOf(s.ctx.database.conn, "SELECT * FROM audit_logs WHERE entity = 'opening_stock_batch' AND action = 'void'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ note: 'wrong file', business_date: d, backdated: 1 });
    recon(s);
  });
  it('a second void -> 409 ALREADY_VOID and nothing changes; reason is required; unknown id -> 404', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 1, 100)]);
    expect((await post(s.app, `/opening-stock/${item.id}/void`, {})).status).toBe(400);
    expect((await post(s.app, `/opening-stock/${item.id}/void`, { reason: '   ' })).status).toBe(400);
    expect((await post(s.app, `/opening-stock/${item.id}/void`, { reason: 'x', extra: 1 })).status).toBe(400);
    expect((await voidB(s, item.id)).status).toBe(200);
    const before = snap(s);
    const again = await voidB(s, item.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(snap(s)).toEqual(before);
    expect((await voidB(s, 99999)).status).toBe(404);
  });
  it('OPENING_BATCH_IN_USE: stock already sold -> 409, names the short product, and NOTHING is changed (also the other lines)', async () => {
    const s = await setup();
    const a = await mkProduct(s);
    const b = await mkProduct(s);
    const item = await openingOk(s, [unitLine(a.id, 10, 5000), unitLine(b.id, 4, 2500)]);
    sell(s, b.id, 1);
    const before = snap(s);
    const r = await voidB(s, item.id);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('OPENING_BATCH_IN_USE');
    expect(err(r).lines).toEqual([{ productId: b.id, onHand: 3, qty: 4 }]);
    expect(err(r).fields['items.1']).toContain('only 3 of 4');
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 50000 });
    expect((await get(s.app, `/opening-stock/${item.id}`)).body.item.status).toBe('posted');
    recon(s);
  });
  it('allowed when more stock arrived later: opening 10 @ 50.00 + purchase 10 @ 70.00, void the opening -> 10 units, Rs 700.00', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 10, 5000)]);
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 70000 }]);
    expect((await voidB(s, item.id)).status).toBe(200);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 70000 });
    recon(s);
  });
  it('OPENING_BATCH_IN_USE also when the quantity is back but the value cannot be taken out (sold all, re-bought at a higher cost)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 10, 5000)]);
    sell(s, p.id, 10);
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 70000 }]);
    const before = snap(s);
    const r = await voidB(s, item.id);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('OPENING_BATCH_IN_USE');
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 70000 });
  });
  it('a voided batch frees the product for a corrected batch', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const wrong = await openingOk(s, [unitLine(p.id, 10, 9999)]);
    await voidB(s, wrong.id);
    await openingOk(s, [unitLine(p.id, 10, 5000)]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 50000 });
    recon(s);
  });
  it('a failing audit write during a void rolls the reversal back', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 10, 5000)]);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_void BEFORE INSERT ON audit_logs WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const before = snap(s);
    expect((await voidB(s, item.id)).status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 50000 });
  });
});

describe('reconciliation and valuation', () => {
  it('SUM(movements) = cache for every product, and the valuation total equals the batch totals', async () => {
    const s = await setup();
    const a = await mkProduct(s);
    const b = await mkProduct(s);
    const t = await mkTelecom(s);
    const x = await openingOk(s, [unitLine(a.id, 10, 5000), totalLine(b.id, 3, 10000)]);
    const y = await openingOk(s, [unitLine(t.id, 20, 900)]);
    recon(s);
    const val = (await get(s.app, '/inventory/valuation')).body;
    expect(val.totals.valueCents).toBe(x.totalValueCents + y.totalValueCents);
    expect(val.totals.qty).toBe(10 + 3 + 20);
    expect(val.totals.byBook.telecom).toEqual({ qty: 20, valueCents: 18000 });
    expect(val.totals.byBook.shop.valueCents).toBe(60000);
    await voidB(s, x.id);
    expect((await get(s.app, '/inventory/valuation')).body.totals.valueCents).toBe(y.totalValueCents);
    expect((await get(s.app, '/inventory/reconciliation')).body.ok).toBe(true);
  });
  it('the movement history of the product shows the opening and its reversal', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const item = await openingOk(s, [unitLine(p.id, 3, 100)]);
    await voidB(s, item.id);
    const h = (await get(s.app, `/products/${p.id}/movements`)).body;
    expect(h.total).toBe(2);
    expect(h.items.map((m: any) => m.qtyDelta).sort()).toEqual([-3, 3]);
  });
});
