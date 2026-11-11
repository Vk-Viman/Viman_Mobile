// Purchases API (POST/GET /purchases, void, returns) - API level (Fastify inject, real temp database).
// This is the first module that moves both STOCK and CASH, so it protects the most rules at once:
// - Section 3: units = packs x pack size, the line total is exact (no per-unit rounding loss), the stock pool follows the
//   weighted average, every change writes one stock_movements row and one cash entry in the same transaction.
// - R1 / C6: a void writes reversal rows (never edits), keeps the ORIGINAL business date, and is blocked when returns exist.
// - R4 / C7: a purchase return or void removes min(purchase cost, pool value) from stock, sweeps any leftover value when the
//   quantity reaches 0, while the CASH refund is always the full purchase value; a partial return refunds
//   mulDivRound(lineTotal, q, lineUnits) and the final return takes the exact remainder.
// - R-FD: no future business dates; R-RD: a return may not be dated before its purchase (checked in that order).
// - Section 12: duplicate submissions are prevented by clientRef (a repeat gives the original, a reused ref for another
//   purchase conflicts), every real change writes exactly one audit row, and every failure rolls EVERYTHING back.
// Organised as: create (incl. date and validation rules), list/get, void, returns, atomic rollback.
// Money in the comments is in cents unless written as Rs.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, count, get, post, put } from './helpers/catalog.ts';
import {
  apiBase, buy, cashRows, daysAgo, daysAhead, mkProduct, mkSupplier, mkTelecom, productOf, ref, today,
} from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { issueStock, reconcileStock } from '../services/inventory.service.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const setup = async (): Promise<ApiBase> => apiBase(await env.build());

// The exact owner-facing message required by R-FD.
const FUTURE_MSG = 'Future-dated transactions are not allowed. Please select today or an earlier date.';
// One purchase line: packs x packSize units for lineTotalCents (the exact cost of the whole line).
const line = (productId: number, packs: number, packSize: number, lineTotalCents: number) => ({ productId, packs, packSize, lineTotalCents });
const err = (r: { body: any }) => r.body.error;

// Row counts of these tables before and after a failing request must be equal: proof that nothing was half-saved.
const TABLES = ['purchases', 'purchase_items', 'purchase_returns', 'purchase_return_items', 'stock_movements', 'cash_entries', 'audit_logs'];
function snap(s: ApiBase): Record<string, number> {
  return Object.fromEntries(TABLES.map((t) => [t, count(s.ctx, t)]));
}
const sql = (s: ApiBase, q: string, ...p: any[]) => s.ctx.database.conn.prepare(q).all(...p) as unknown as Array<Record<string, any>>;
// Stock ledger of one product in a compact form (type, qty change, value change, date, source document).
const moves = (s: ApiBase, productId: number) =>
  sql(s, 'SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id', productId).map((m) => ({
    id: Number(m.id), type: m.type as string, qty: Number(m.qty_delta), value: Number(m.value_delta_cents),
    date: m.business_date as string, refTable: m.ref_table as string | null, refId: m.ref_id === null ? null : Number(m.ref_id),
  }));
// Sum of a cash book's entries, i.e. what the drawer should hold for that book.
const cashBal = (s: ApiBase, book: string) => Number(sql(s, 'SELECT COALESCE(SUM(amount_cents),0) AS t FROM cash_entries WHERE book = ?', book)[0]!.t);
/** Removes stock through the engine (as a later sale would). */
const engineSell = (s: ApiBase, productId: number, qty: number) =>
  s.ctx.database.tx((c) => issueStock(c, { productId, businessDate: today(), type: 'sale', qty, refTable: null, refId: null, reason: 'test sale' }));
/** Value-only movement straight into the ledger (cache trigger keeps products in step). */
const valueMove = (s: ApiBase, productId: number, valueDelta: number) =>
  s.ctx.database.conn.prepare(
    "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'adjustment', 0, ?, 'test')",
  ).run(productId, today(), valueDelta);
const reconOk = (s: ApiBase) => expect(reconcileStock(s.ctx.database.conn)).toMatchObject({ ok: true, mismatches: [] });

// Exact field lists of a purchase and a purchase line (contract check: nothing may appear or vanish silently).
const PURCHASE_KEYS = [
  'backdated', 'billNo', 'book', 'businessDate', 'clientRef', 'id', 'items', 'notes', 'postedAt', 'returns', 'status',
  'supplierId', 'supplierName', 'totalCents', 'voidedAt', 'voidReason',
].sort();
const ITEM_KEYS = ['id', 'lineTotalCents', 'packSize', 'packs', 'productId', 'productName', 'returnedUnits', 'unitCostCents', 'units'];

// =============================================================================================
// Creating a purchase: stock in, cash out, audit, dates, validation, duplicates.
describe('POST /purchases - create', () => {
  // 1 box of 10 for Rs 1,320 = 132,000 cents / 10 units = 13,200 (Rs 132) per unit. Stock +10 / 132,000 and the shop cash book -132,000.
  it('201 with exact shape; 1 box x 10 for Rs 1,320 -> 10 units, 13200 per unit; stock and cash updated', async () => {
    const s = await setup();
    const p = await mkProduct(s, { name: 'Charger' });
    const r = await post(s.app, '/purchases', {
      businessDate: today(), items: [line(p.id, 1, 10, 132000)], clientRef: 'create-ref-0001',
    });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item', 'warnings']); // Phase 8: shared negative-cash warnings
    const it = r.body.item;
    expect(Object.keys(it).sort()).toEqual(PURCHASE_KEYS);
    expect(it).toMatchObject({
      businessDate: today(), backdated: false, supplierId: null, supplierName: null, billNo: '', book: 'shop',
      totalCents: 132000, status: 'posted', notes: '', voidedAt: null, voidReason: null, clientRef: 'create-ref-0001', returns: [],
    });
    expect(it.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(it.items).toHaveLength(1);
    expect(Object.keys(it.items[0]).sort()).toEqual(ITEM_KEYS);
    expect(it.items[0]).toMatchObject({
      productId: p.id, productName: 'Charger', packs: 1, packSize: 10, units: 10, lineTotalCents: 132000,
      unitCostCents: 13200, returnedUnits: 0,
    });
    expect((await get(s.app, `/purchases/${it.id}`)).body.item).toEqual(it);

    const prod = await productOf(s, p.id);
    expect(prod).toMatchObject({ qtyOnHand: 10, stockValueCents: 132000, avgUnitCostCents: 13200 });
    const mv = moves(s, p.id);
    expect(mv).toEqual([{ id: expect.any(Number), type: 'purchase', qty: 10, value: 132000, date: today(), refTable: 'purchases', refId: it.id }]);
    const cash = cashRows(s.ctx);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({
      book: 'shop', type: 'purchase_payment', amount_cents: -132000, ref_table: 'purchases', ref_id: it.id,
      business_date: today(), reverses_entry_id: null, fund: null,
    });
    expect(cashBal(s, 'shop')).toBe(-132000);
    reconOk(s);
  });

  // 2 packs x 5 = 10 units for 4,000 -> 400 each. Unit cost is for display: 1,000/3 = 333.33 -> 333; 5/2 = 2.5 -> 3.
  // The stored value is always the exact line total.
  it('pack conversion 2 x 5 = 10 units; supplier, trimmed billNo/notes; unit cost rounds half up', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const sup = await mkSupplier(s, 'Acme');
    const it = await buy(s, [line(p.id, 2, 5, 4000)], { supplierId: sup.id, billNo: '  B-77  ', notes: '  note  ' });
    expect(it).toMatchObject({ supplierId: sup.id, supplierName: 'Acme', billNo: 'B-77', notes: 'note' });
    expect(it.items[0]).toMatchObject({ packs: 2, packSize: 5, units: 10, unitCostCents: 400 });
    const q = await buy(s, [line(p.id, 1, 3, 1000)]);
    expect(q.items[0]).toMatchObject({ units: 3, unitCostCents: 333 }); // 333.33
    const h = await buy(s, [line(p.id, 1, 2, 5)]);
    expect(h.items[0]).toMatchObject({ units: 2, unitCostCents: 3 });   // 2.5 -> 3
  });

  // Biggest allowed values stay exact: 1 pack of 1,000,000 units for Rs 999,999,999.99; a free pack of 10^12 units adds quantity but no value.
  it('large pack sizes: 1 pack of 1,000,000 units for the maximum line total', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const it = await buy(s, [line(p.id, 1, 1000000, 99999999999)]);
    expect(it.items[0]).toMatchObject({ units: 1000000, unitCostCents: 100000 }); // 99999.999999 -> 100000
    expect(it.totalCents).toBe(99999999999);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 1000000, stockValueCents: 99999999999 });
    const big = await buy(s, [line(p.id, 1000000, 1000000, 0)]);
    expect(big.items[0].units).toBe(1000000000000);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 1000001000000, stockValueCents: 99999999999 });
    reconOk(s);
  });

  // Lines 1,200 + 999 = 2,199 = one cash entry. Product b: 6 units / 999 -> average 166.5 -> 167.
  it('multiple lines: total is the sum, one movement per line, one cash entry for the total', async () => {
    const s = await setup();
    const a = await mkProduct(s); const b = await mkProduct(s);
    const it = await buy(s, [line(a.id, 1, 4, 1200), line(b.id, 3, 2, 999)]);
    expect(it.totalCents).toBe(2199);
    expect(it.items.map((i: any) => [i.productId, i.units])).toEqual([[a.id, 4], [b.id, 6]]);
    expect(moves(s, a.id)).toHaveLength(1);
    expect(moves(s, b.id)).toHaveLength(1);
    expect(cashRows(s.ctx)).toHaveLength(1);
    expect(Number(cashRows(s.ctx)[0]!.amount_cents)).toBe(-2199);
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 6, stockValueCents: 999, avgUnitCostCents: 167 }); // 166.5 -> 167
  });

  // 5 @ 1,000 + 5 @ 3,000 = 10 units / 4,000 -> average 400; both lines are applied to the same pool in order.
  it('same product on two lines: both applied in order to the pool', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const it = await buy(s, [line(p.id, 1, 5, 1000), line(p.id, 1, 5, 3000)]);
    expect(it.items).toHaveLength(2);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 4000, avgUnitCostCents: 400 });
    expect(moves(s, p.id).map((m) => [m.qty, m.value])).toEqual([[5, 1000], [5, 3000]]);
  });

  // 10 @ Rs 3,000 + 10 @ Rs 4,000 = 20 units / Rs 7,000 (700,000 cents) -> average Rs 350 (35,000 cents).
  it('successive purchases accumulate the weighted average (10@3000, 10@4000 -> 20/7000)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await buy(s, [line(p.id, 1, 10, 300000)]);
    await buy(s, [line(p.id, 2, 5, 400000)]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 20, stockValueCents: 700000, avgUnitCostCents: 35000 });
  });

  // Free goods (e.g. supplier bonus stock): quantity is added with value 0 and no cash entry is made (cash entries are never zero).
  it('zero-total purchase: stock added with zero value, NO cash entry', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const it = await buy(s, [line(p.id, 1, 5, 0)]);
    expect(it.totalCents).toBe(0);
    expect(it.items[0].unitCostCents).toBe(0);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 0 });
    expect(cashRows(s.ctx)).toHaveLength(0);
    expect(moves(s, p.id)).toHaveLength(1);
  });

  // A purchase of scratch cards belongs to the telecom book, so the payment leaves the TELECOM cash book (section 2).
  it('telecom stock product: book telecom, cash entry in the telecom book', async () => {
    const s = await setup();
    const t = await mkTelecom(s, { kind: 'stock' });
    expect(t.book).toBe('telecom');
    const it = await buy(s, [line(t.id, 1, 10, 5000)]);
    expect(it.book).toBe('telecom');
    expect(cashRows(s.ctx)[0]).toMatchObject({ book: 'telecom', type: 'purchase_payment', amount_cents: -5000 });
    expect(cashBal(s, 'telecom')).toBe(-5000);
    expect(cashBal(s, 'shop')).toBe(0);
  });

  it('audit row: entity purchase / create, after = the purchase, business date and backdated flag', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const it = await buy(s, [line(p.id, 1, 2, 100)], { businessDate: daysAgo(3) });
    const rows = auditRows(s.ctx, 'purchase');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: String(it.id), action: 'create', before: null });
    expect(rows[0]!.after).toEqual(it);
    const raw = sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'purchase'")[0]!;
    expect([raw.business_date, Number(raw.backdated)]).toEqual([daysAgo(3), 1]);
    const api = (await get(s.app, '/audit-logs?entity=purchase')).body.items[0];
    expect(api).toMatchObject({ businessDate: daysAgo(3), backdated: true, action: 'create' });
    expect(api.postedAt).toBe(api.at);
  });

  // R-FD (no future dates) and backdating (allowed, flagged and audited).
  describe('business date rules', () => {
    // An earlier business date is allowed but flagged backdated, and every record created carries that date (reports follow business date, R7).
    it('today: backdated false; earlier date: backdated true and every record carries that date', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      expect((await buy(s, [line(p.id, 1, 1, 100)])).backdated).toBe(false);
      const old = await buy(s, [line(p.id, 1, 1, 100)], { businessDate: daysAgo(30) });
      expect(old).toMatchObject({ businessDate: daysAgo(30), backdated: true });
      expect(moves(s, p.id)[1]).toMatchObject({ date: daysAgo(30), type: 'purchase' });
      expect(cashRows(s.ctx, `ref_id = ${old.id}`)[0]).toMatchObject({ business_date: daysAgo(30) });
      // posting time is "now", not the business date
      expect(old.postedAt.slice(0, 10)).not.toBe(daysAgo(30));
      expect((await buy(s, [line(p.id, 1, 1, 100)], { businessDate: '2000-01-01' })).backdated).toBe(true);
    });

    // R-FD: the server blocks tomorrow's date even if the screen's date picker is bypassed; nothing is saved.
    it('future date -> 400 FUTURE_DATE_NOT_ALLOWED with the exact message and fields.businessDate; nothing written', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const before = snap(s);
      for (const d of [daysAhead(1), daysAhead(400), '2999-12-31']) {
        const r = await post(s.app, '/purchases', { businessDate: d, items: [line(p.id, 1, 1, 100)], clientRef: ref() });
        expect(r.status).toBe(400);
        expect(err(r)).toEqual({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
      }
      expect(snap(s)).toEqual(before);
    });

    it('malformed / impossible / missing dates -> 400 VALIDATION_ERROR on businessDate', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      for (const d of ['2026-02-31', '2026-13-01', '2026-1-1', '20261110', 'today', '', '2025-02-29']) {
        const r = await post(s.app, '/purchases', { businessDate: d, items: [line(p.id, 1, 1, 100)], clientRef: ref() });
        expect(r.status, d).toBe(400);
        expect(err(r).code, d).toBe('VALIDATION_ERROR');
        expect(err(r).fields.businessDate, d).toBeDefined();
      }
      const r = await post(s.app, '/purchases', { items: [line(p.id, 1, 1, 100)], clientRef: ref() });
      expect(r.status).toBe(400);
      expect(err(r).fields.businessDate).toBeDefined();
      expect((await post(s.app, '/purchases', { businessDate: 20261110, items: [line(p.id, 1, 1, 100)], clientRef: ref() })).status).toBe(400);
    });

    // The posting timestamp is set by the server only (section 12), so a client cannot send it.
    it('postedAt (and any unknown field) in the body -> 400 VALIDATION_ERROR', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const base = { businessDate: today(), items: [line(p.id, 1, 1, 100)], clientRef: ref() };
      let r = await post(s.app, '/purchases', { ...base, postedAt: '2020-01-01T00:00:00.000Z' });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(err(r).fields.postedAt).toBeDefined();
      r = await post(s.app, '/purchases', { ...base, bogus: 1 });
      expect(r.status).toBe(400);
      expect(err(r).fields.bogus).toBeDefined();
      r = await post(s.app, '/purchases', { ...base, status: 'void' });
      expect(r.status).toBe(400);
      r = await post(s.app, '/purchases', { ...base, totalCents: 5 });
      expect(r.status).toBe(400);
      r = await post(s.app, '/purchases', { ...base, items: [{ ...line(p.id, 1, 1, 100), unitCostCents: 1 }] });
      expect(r.status).toBe(400);
      expect(count(s.ctx, 'purchases')).toBe(0);
    });
  });

  describe('validation', () => {
    it.each([
      ['packs 0', { packs: 0 }], ['packs -1', { packs: -1 }], ['packs 1.5', { packs: 1.5 }], ['packs "2"', { packs: '2' }],
      ['packs null', { packs: null }], ['packs 1000001', { packs: 1000001 }],
      ['packSize 0', { packSize: 0 }], ['packSize -5', { packSize: -5 }], ['packSize 2.5', { packSize: 2.5 }],
      ['packSize "5"', { packSize: '5' }], ['packSize null', { packSize: null }], ['packSize 1000001', { packSize: 1000001 }],
      ['total -1', { lineTotalCents: -1 }], ['total 1.5', { lineTotalCents: 1.5 }], ['total "100"', { lineTotalCents: '100' }],
      ['total null', { lineTotalCents: null }], ['total too large', { lineTotalCents: 100000000000 }],
      ['productId 0', { productId: 0 }], ['productId "1"', { productId: '1' }], ['productId 1.5', { productId: 1.5 }],
    ])('line with %s -> 400 VALIDATION_ERROR, no coercion, nothing written', async (_l, over) => {
      const s = await setup();
      const p = await mkProduct(s);
      const before = snap(s);
      const r = await post(s.app, '/purchases', {
        businessDate: today(), clientRef: ref(), items: [{ ...line(p.id, 1, 1, 100), ...over, ...('productId' in over ? {} : { productId: p.id }) }],
      });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields).join(',')).toMatch(/items/);
      expect(snap(s)).toEqual(before);
    });

    it('missing line fields, empty / oversized items array, missing items / clientRef', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const base = { businessDate: today(), clientRef: ref() };
      for (const items of [[], undefined, [{ productId: p.id, packs: 1, packSize: 1 }], [{ productId: p.id, packs: 1, lineTotalCents: 1 }],
        [{ productId: p.id, packSize: 1, lineTotalCents: 1 }], [{ packs: 1, packSize: 1, lineTotalCents: 1 }], 'x', null]) {
        const r = await post(s.app, '/purchases', { ...base, ...(items === undefined ? {} : { items }) });
        expect(r.status).toBe(400);
        expect(err(r).code).toBe('VALIDATION_ERROR');
      }
      const r2 = await post(s.app, '/purchases', { businessDate: today(), items: [line(p.id, 1, 1, 1)] });
      expect(r2.status).toBe(400);
      expect(err(r2).fields.clientRef).toBeDefined();
      const max = Array.from({ length: 100 }, () => line(p.id, 1, 1, 1));
      expect((await post(s.app, '/purchases', { ...base, items: max })).status).toBe(201);
      const over = Array.from({ length: 101 }, () => line(p.id, 1, 1, 1));
      expect((await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: over })).status).toBe(400);
      expect(count(s.ctx, 'purchases')).toBe(1);
    });

    it('lineTotalCents 0 and 99,999,999,999 accepted; minimum 1x1', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      expect((await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(p.id, 1, 1, 0)] })).status).toBe(201);
      expect((await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(p.id, 1, 1, 99999999999)] })).status).toBe(201);
    });

    it('billNo <= 40 and notes <= 500 characters (after trim)', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const mk = (over: Record<string, unknown>) =>
        post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(p.id, 1, 1, 1)], ...over });
      expect((await mk({ billNo: 'b'.repeat(40), notes: 'n'.repeat(500) })).status).toBe(201);
      expect((await mk({ billNo: ` ${'b'.repeat(40)} ` })).status).toBe(201);
      let r = await mk({ billNo: 'b'.repeat(41) });
      expect(r.status).toBe(400);
      expect(err(r).fields.billNo).toBe('Bill number must be at most 40 characters.');
      r = await mk({ notes: 'n'.repeat(501) });
      expect(r.status).toBe(400);
      expect(err(r).fields.notes).toBeDefined();
      expect((await mk({ billNo: 7 })).status).toBe(400);
      expect((await mk({ notes: null })).status).toBe(400);
      expect(count(s.ctx, 'purchases')).toBe(2);
    });

    it('clientRef pattern: 8-64 of [A-Za-z0-9_-]', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const mk = (clientRef: unknown) => post(s.app, '/purchases', { businessDate: today(), clientRef, items: [line(p.id, 1, 1, 1)] });
      for (const bad of ['short', 'a'.repeat(65), 'has space123', 'bad/chars!!', 'ünicode-ref1', '', 12345678, null]) {
        const r = await mk(bad);
        expect(r.status, String(bad)).toBe(400);
        expect(err(r).fields.clientRef, String(bad)).toBeDefined();
      }
      expect((await mk('a'.repeat(8))).status).toBe(201);
      expect((await mk('A_b-9'.padEnd(64, 'x'))).status).toBe(201);
    });

    it('malformed JSON body -> 400', async () => {
      const s = await setup();
      const res = await s.app.inject({ method: 'POST', url: '/api/v1/purchases', payload: '{bad', headers: { 'content-type': 'application/json' } });
      expect(res.statusCode).toBe(400);
    });
  });

  // The purchase must reference sensible products and suppliers.
  describe('lookups and business rules', () => {
    it('unknown product -> 400 VALIDATION_ERROR fields["items.N.productId"]', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const before = snap(s);
      const r = await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(p.id, 1, 1, 1), line(99999, 1, 1, 1)] });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields)).toEqual(['items.1.productId']);
      expect(snap(s)).toEqual(before);
    });

    // Services have no stock to buy and inactive products cannot be restocked.
    it('service product and inactive product -> 400 PRODUCT_NOT_STOCKABLE naming the line', async () => {
      const s = await setup();
      const stock = await mkProduct(s);
      const svc = await mkProduct(s, { kind: 'service' });
      const inactive = await mkProduct(s);
      expect((await put(s.app, `/products/${inactive.id}`, { active: false })).status).toBe(200);
      const before = snap(s);
      let r = await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(stock.id, 1, 1, 1), line(svc.id, 1, 1, 1)] });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('PRODUCT_NOT_STOCKABLE');
      expect(Object.keys(err(r).fields)).toEqual(['items.1.productId']);
      r = await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(inactive.id, 1, 1, 1)] });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('PRODUCT_NOT_STOCKABLE');
      expect(Object.keys(err(r).fields)).toEqual(['items.0.productId']);
      expect(snap(s)).toEqual(before);
    });

    // Segments are disjoint (section 0): one bill pays from ONE cash book, so shop and telecom goods cannot be mixed.
    it('shop + telecom on one bill -> 400 MIXED_BOOKS with the contract message; nothing written', async () => {
      const s = await setup();
      const a = await mkProduct(s);
      const t = await mkTelecom(s, { kind: 'stock' });
      const before = snap(s);
      const r = await post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), items: [line(a.id, 1, 1, 1), line(t.id, 1, 1, 1)] });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('MIXED_BOOKS');
      expect(err(r).message).toBe('Shop and Telecom items cannot be on one bill — please split into two bills.');
      expect(snap(s)).toEqual(before);
    });

    it('unknown and inactive supplier -> 400 fields.supplierId', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const sup = await mkSupplier(s);
      await put(s.app, `/suppliers/${sup.id}`, { active: false });
      const mk = (supplierId: unknown) =>
        post(s.app, '/purchases', { businessDate: today(), clientRef: ref(), supplierId, items: [line(p.id, 1, 1, 1)] });
      let r = await mk(9999);
      expect(r.status).toBe(400);
      expect(err(r)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { supplierId: 'Supplier not found.' } });
      r = await mk(sup.id);
      expect(r.status).toBe(400);
      expect(err(r).fields.supplierId).toMatch(/inactive/i);
      expect((await mk(0)).status).toBe(400);
      expect((await mk('1')).status).toBe(400);
      expect((await mk(null)).status).toBe(400);
      expect(count(s.ctx, 'purchases')).toBe(0);
    });
  });

  // Double-click protection: the same clientRef means "the same purchase".
  describe('idempotent clientRef', () => {
    // Sending the same clientRef again returns the original and writes nothing new (no second stock movement, cash entry, audit row).
    it('repeat returns 200 with the original purchase; no second movement, cash entry, audit row or stock', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const body = { businessDate: today(), clientRef: 'idem-purchase-1', items: [line(p.id, 1, 10, 5000)] };
      const first = await post(s.app, '/purchases', body);
      expect(first.status).toBe(201);
      const before = snap(s);
      const again = await post(s.app, '/purchases', body);
      expect(again.status).toBe(200);
      expect(again.body.item).toEqual(first.body.item);
      expect(snap(s)).toEqual(before);
      expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 5000 });
      // a repeat with different content still returns the original, untouched
      const diff = await post(s.app, '/purchases', { ...body, items: [line(p.id, 5, 5, 99999)] });
      expect(diff.status).toBe(200);
      expect(diff.body.item.id).toBe(first.body.item.id);
      expect(diff.body.item.totalCents).toBe(5000);
      expect(snap(s)).toEqual(before);
    });

    // If the first try failed validation, the owner can fix the form and resubmit with the same reference.
    it('a failed attempt does not burn the clientRef', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const clientRef = 'retry-after-fail1';
      expect((await post(s.app, '/purchases', { businessDate: daysAhead(2), clientRef, items: [line(p.id, 1, 1, 1)] })).status).toBe(400);
      expect((await post(s.app, '/purchases', { businessDate: today(), clientRef, items: [line(p.id, 1, 1, 1)] })).status).toBe(201);
    });
  });
});

// =============================================================================================
// Listing and filtering purchases (by business date, book, supplier, status, text).
describe('GET /purchases and /purchases/:id', () => {
  async function fixture() {
    const s = await setup();
    const p = await mkProduct(s); const t = await mkTelecom(s, { kind: 'stock' });
    const s1 = await mkSupplier(s, 'S1'); const s2 = await mkSupplier(s, 'S2');
    const A = await buy(s, [line(p.id, 1, 10, 1000)], { businessDate: daysAgo(10), supplierId: s1.id, billNo: 'INV-001' });
    const B = await buy(s, [line(p.id, 1, 10, 2000)], { businessDate: daysAgo(5), supplierId: s2.id, billNo: 'inv-002' });
    const C = await buy(s, [line(t.id, 1, 10, 3000)], { businessDate: daysAgo(5), billNo: 'T-9' });
    const D = await buy(s, [line(p.id, 1, 10, 4000)], { businessDate: today(), supplierId: s1.id, billNo: '100%_x' });
    return { s, p, t, s1, s2, A, B, C, D };
  }
  const ids = (r: { body: any }) => r.body.items.map((i: any) => i.id);

  it('default order businessDate DESC, id DESC; items include lines and returns; total', async () => {
    const { s, A, B, C, D } = await fixture();
    const r = await get(s.app, '/purchases');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'total']);
    expect(ids(r)).toEqual([D.id, C.id, B.id, A.id]);
    expect(r.body.total).toBe(4);
    expect(r.body.items[3]).toEqual(A);
    expect(r.body.items[3].items).toHaveLength(1);
    expect(r.body.items[3].returns).toEqual([]);
  });

  it('empty list', async () => {
    const s = await setup();
    expect((await get(s.app, '/purchases')).body).toEqual({ items: [], total: 0 });
  });

  it('from / to are inclusive business dates', async () => {
    const { s, A, B, C, D } = await fixture();
    expect(ids(await get(s.app, `/purchases?from=${daysAgo(5)}`))).toEqual([D.id, C.id, B.id]);
    expect(ids(await get(s.app, `/purchases?to=${daysAgo(5)}`))).toEqual([C.id, B.id, A.id]);
    expect(ids(await get(s.app, `/purchases?from=${daysAgo(5)}&to=${daysAgo(5)}`))).toEqual([C.id, B.id]);
    expect(ids(await get(s.app, `/purchases?from=${daysAgo(9)}&to=${daysAgo(6)}`))).toEqual([]);
    expect(ids(await get(s.app, `/purchases?from=${daysAhead(5)}`))).toEqual([]); // report dates are never rejected
    expect(ids(await get(s.app, `/purchases?from=${today()}&to=${daysAgo(10)}`))).toEqual([]);
  });

  it('book, supplierId, status and q filters; q is a case-insensitive substring with LIKE wildcards escaped', async () => {
    const { s, A, B, C, D, s1 } = await fixture();
    expect(ids(await get(s.app, '/purchases?book=telecom'))).toEqual([C.id]);
    expect(ids(await get(s.app, '/purchases?book=shop'))).toEqual([D.id, B.id, A.id]);
    expect(ids(await get(s.app, `/purchases?supplierId=${s1.id}`))).toEqual([D.id, A.id]);
    expect(ids(await get(s.app, '/purchases?supplierId=9999'))).toEqual([]);
    expect(ids(await get(s.app, '/purchases?q=inv'))).toEqual([B.id, A.id]);
    expect(ids(await get(s.app, '/purchases?q=INV-00'))).toEqual([B.id, A.id]);
    expect(ids(await get(s.app, '/purchases?q=-002'))).toEqual([B.id]);
    expect(ids(await get(s.app, '/purchases?q=%25'))).toEqual([D.id]);      // literal %
    expect(ids(await get(s.app, '/purchases?q=_x'))).toEqual([D.id]);       // literal _
    expect(ids(await get(s.app, '/purchases?q=zzz'))).toEqual([]);
    expect(ids(await get(s.app, '/purchases?q='))).toEqual([D.id, C.id, B.id, A.id]);
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'wrong' })).status).toBe(200);
    expect(ids(await get(s.app, '/purchases?status=void'))).toEqual([A.id]);
    expect(ids(await get(s.app, '/purchases?status=posted'))).toEqual([D.id, C.id, B.id]);
    expect(ids(await get(s.app, `/purchases?book=shop&status=posted&from=${daysAgo(7)}`))).toEqual([D.id, B.id]);
  });

  it('paging: limit/offset with a stable total', async () => {
    const { s, A, B, C, D } = await fixture();
    let r = await get(s.app, '/purchases?limit=2');
    expect(ids(r)).toEqual([D.id, C.id]);
    expect(r.body.total).toBe(4);
    r = await get(s.app, '/purchases?limit=2&offset=2');
    expect(ids(r)).toEqual([B.id, A.id]);
    expect(r.body.total).toBe(4);
    r = await get(s.app, '/purchases?limit=2&offset=1');
    expect(ids(r)).toEqual([C.id, B.id]);
    r = await get(s.app, '/purchases?offset=10');
    expect(r.body).toEqual({ items: [], total: 4 });
    expect((await get(s.app, '/purchases?limit=200')).status).toBe(200);
    expect((await get(s.app, '/purchases?limit=1')).status).toBe(200);
  });

  it.each([
    ['limit=0', 'limit=0'], ['limit=201', 'limit=201'], ['limit=abc', 'limit=abc'], ['limit=-1', 'limit=-1'], ['limit=1.5', 'limit=1.5'],
    ['offset=-1', 'offset=-1'], ['offset=x', 'offset=x'], ['from=abc', 'from=abc'], ['to=2026-13-40', 'to=2026-13-40'],
    ['from=2026-02-31', 'from=2026-02-31'], ['from=2026-1-1', 'from=2026-1-1'], ['book=icecream', 'book=icecream'],
    ['status=bogus', 'status=bogus'], ['supplierId=abc', 'supplierId=abc'], ['bogus=1', 'bogus=1'],
  ])('bad query %s -> 400 VALIDATION_ERROR', async (_l, q) => {
    const s = await setup();
    const r = await get(s.app, `/purchases?${q}`);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('VALIDATION_ERROR');
  });

  it('GET one: 200 with item; 404 for unknown; 400 for a non-numeric id', async () => {
    const { s, A } = await fixture();
    const r = await get(s.app, `/purchases/${A.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ item: A });
    const nf = await get(s.app, '/purchases/99999');
    expect(nf.status).toBe(404);
    expect(err(nf).code).toBe('NOT_FOUND');
    expect((await get(s.app, '/purchases/abc')).status).toBe(400);
    expect((await get(s.app, '/purchases/-1')).status).toBe(400);
  });
});

// =============================================================================================
// R1 void: the purchase becomes 'void' and reversal rows are added; stock leaves at min(cost, pool) and cash returns in full.
describe('POST /purchases/:id/void', () => {
  // A void is dated like the original so the correction lands in the same report period (section 12 "Reversals").
  it('reverses movements, stock and cash; keeps the ORIGINAL business date; audit row; response shape', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const it = await buy(s, [line(p.id, 1, 10, 132000)], { businessDate: daysAgo(4) });
    const r = await post(s.app, `/purchases/${it.id}/void`, { reason: '  Entered twice  ' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item']);
    const v = r.body.item;
    expect(v).toMatchObject({ id: it.id, status: 'void', voidReason: 'Entered twice', businessDate: daysAgo(4), totalCents: 132000 });
    expect(v.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await get(s.app, `/purchases/${it.id}`)).body.item).toEqual(v);

    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0, avgUnitCostCents: null });
    const mv = moves(s, p.id);
    expect(mv).toHaveLength(2);
    expect(mv[1]).toMatchObject({ type: 'purchase_void', qty: -10, value: -132000, refTable: 'purchases', refId: it.id });
    const cash = cashRows(s.ctx);
    expect(cash).toHaveLength(2);
    expect(cash[1]).toMatchObject({
      book: 'shop', type: 'purchase_payment', amount_cents: 132000, reverses_entry_id: cash[0]!.id,
      ref_table: 'purchases', ref_id: it.id, business_date: daysAgo(4),
    });
    expect(String(cash[1]!.posted_at) >= String(cash[0]!.posted_at)).toBe(true);
    expect(String(cash[1]!.posted_at).slice(0, 10)).toBe(new Date().toISOString().slice(0, 10)); // posting time = now
    expect(cashBal(s, 'shop')).toBe(0);
    reconOk(s);

    const rows = auditRows(s.ctx, 'purchase');
    expect(rows.map((a) => a.action)).toEqual(['create', 'void']);
    expect(rows[1]!.before.status).toBe('posted');
    expect(rows[1]!.after.status).toBe('void');
    const raw = sql(s, "SELECT business_date, backdated, note FROM audit_logs WHERE action = 'void'")[0]!;
    expect([raw.business_date, Number(raw.backdated), raw.note]).toEqual([daysAgo(4), 1, 'Entered twice']);
  });

  // A 10 @ 1,000 (units cost 100) and B 10 @ 3,000 -> pool 20 / 4,000. Voiding A removes only A's cost 1,000 -> 10 / 3,000
  // (B's value is untouched; it is not re-averaged).
  it('void removes only the purchase cost from a richer pool (A 10@1000 + B 10@3000 -> void A -> 10/3000)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    await buy(s, [line(p.id, 1, 10, 3000)]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 20, stockValueCents: 4000 });
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' })).status).toBe(200);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 3000 });
    reconOk(s);
  });

  // Purchase 10 / 10,000, then pool value written down by 4,000 -> 10 / 6,000. Void can only remove 6,000 of stock value,
  // yet the cash refund is the full 10,000 so the shop cash book returns to 0.
  it('pool value below the purchase value: removes the pool value only (R4 cap)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 10000)]);
    valueMove(s, p.id, -4000); // pool 10 / 6000
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' })).status).toBe(200);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(moves(s, p.id).at(-1)).toMatchObject({ type: 'purchase_void', qty: -10, value: -6000 });
    expect(cashBal(s, 'shop')).toBe(0); // cash is refunded in full regardless
    reconOk(s);
  });

  // Pool 10 / 12,500 (2,500 extra value from an adjustment). Voiding the 10,000 purchase empties the quantity, so the
  // leftover 2,500 is swept FIRST (adjustment -2,500) then -10,000 is removed -> 0 / 0.
  it('residual sweep: pool holds extra value -> adjustment(-2500) written BEFORE the void movement(-10000)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 10000)]);
    valueMove(s, p.id, 2500); // pool 10 / 12500
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' })).status).toBe(200);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    const mv = moves(s, p.id);
    expect(mv.slice(-2).map((m) => [m.type, m.qty, m.value])).toEqual([['adjustment', 0, -2500], ['purchase_void', -10, -10000]]);
    reconOk(s);
  });

  it('zero-total purchase: void writes no cash entry', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 3, 0)]);
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' })).status).toBe(200);
    expect(cashRows(s.ctx)).toHaveLength(0);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
  });

  it('multi-line purchase voids every line; telecom reversal in the telecom book', async () => {
    const s = await setup();
    const a = await mkTelecom(s, { kind: 'stock' }); const b = await mkTelecom(s, { kind: 'stock' });
    const A = await buy(s, [line(a.id, 1, 5, 500), line(b.id, 1, 2, 700)]);
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' })).status).toBe(200);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 0 });
    expect(cashRows(s.ctx).map((c) => [c.book, Number(c.amount_cents)])).toEqual([['telecom', -1200], ['telecom', 1200]]);
  });

  // Voiding twice must not reverse twice.
  it('409 ALREADY_VOID on a second void; nothing more written', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 3, 300)]);
    await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    const before = snap(s);
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'again' });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('ALREADY_VOID');
    expect(snap(s)).toEqual(before);
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.voidReason).toBe('x');
  });

  // R1: a void is blocked once part of the purchase has been returned (the return already reversed some of it).
  it('409 HAS_RETURNS once any unit was returned', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    await post(s.app, `/purchases/${A.id}/returns`, { businessDate: today(), clientRef: ref(), items: [{ purchaseItemId: A.items[0].id, units: 1 }] });
    const before = snap(s);
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: 'HAS_RETURNS', message: 'This purchase has returns, so it cannot be voided.' });
    expect(snap(s)).toEqual(before);
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.status).toBe('posted');
  });

  // If some of the purchased goods were already sold, they cannot be removed again; the whole void is refused and nothing changes.
  it('422 INSUFFICIENT_STOCK when part was sold; message, fields["items.N"], onHand; NOTHING written', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    engineSell(s, p.id, 4);
    const before = snap(s);
    const poolBefore = await productOf(s, p.id);
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('INSUFFICIENT_STOCK');
    expect(err(r).message).toBe('Some of this purchase has already been sold or removed.');
    expect(Object.keys(err(r).fields)).toEqual(['items.0']);
    expect(err(r).onHand).toBe(6);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toEqual(poolBefore);
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.status).toBe('posted');
    reconOk(s);
  });

  it('same product on two lines: the second line is the short one', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 5, 500), line(p.id, 1, 5, 500)]);
    engineSell(s, p.id, 3); // 7 on hand, 10 needed
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    expect(r.status).toBe(422);
    expect(Object.keys(err(r).fields)).toEqual(['items.1']);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 7 });
  });

  it('reason validation: required, trimmed 1-200, strings only, no unknown fields', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 3, 300)]);
    const url = `/purchases/${A.id}/void`;
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'r'.repeat(201) }, { reason: 5 }, { reason: null },
      { reason: 'ok', extra: 1 }, { reason: 'ok', status: 'posted' }]) {
      const r = await post(s.app, url, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
    }
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.status).toBe('posted');
    const ok = await post(s.app, url, { reason: ` ${'r'.repeat(200)} ` });
    expect(ok.status).toBe(200);
    expect(ok.body.item.voidReason).toBe('r'.repeat(200));
  });

  it('404 for an unknown purchase; 400 for a bad id', async () => {
    const s = await setup();
    expect((await post(s.app, '/purchases/9999/void', { reason: 'x' })).status).toBe(404);
    expect((await post(s.app, '/purchases/abc/void', { reason: 'x' })).status).toBe(400);
  });

  // R-FD only limits business dates entered by the owner; a void takes the original date, which is never in the future.
  it('void is not subject to R-FD (works for old purchases) and works with no body date', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 3, 300)], { businessDate: '2020-01-01' });
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'old' });
    expect(r.status).toBe(200);
    expect(cashRows(s.ctx)[1]).toMatchObject({ business_date: '2020-01-01' });
  });
});

// =============================================================================================
// Returning goods to a supplier: partial/full returns (C7), R4 caps and sweeps, R-FD then R-RD, idempotency.
describe('POST /purchases/:id/returns', () => {
  const ret = (s: ApiBase, purchaseId: number, items: Array<{ purchaseItemId: number; units: number }>, over: Record<string, unknown> = {}) =>
    post(s.app, `/purchases/${purchaseId}/returns`, { businessDate: today(), clientRef: ref(), items, ...over });

  // C7 hand calculation: line 132,000 for 10 units. Return 3: 132,000 x 3 / 10 = 39,600 (refund) -> pool 7 / 92,400.
  // The final 7 units take the exact remainder 132,000 - 39,600 = 92,400. Shop cash: paid 132,000, refunded 39,600 + 92,400 = 0 net.
  it('partial return 3 of 10 for Rs 1,320: refund 39600; then the remaining 7 take the remainder 92400', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 132000)]);
    const itemId = A.items[0].id;

    const r1 = await ret(s, A.id, [{ purchaseItemId: itemId, units: 3 }], { note: '  damaged  ' });
    expect(r1.status).toBe(201);
    expect(Object.keys(r1.body).sort()).toEqual(['item', 'purchase', 'warnings']);
    expect(Object.keys(r1.body.item).sort()).toEqual(['backdated', 'businessDate', 'clientRef', 'id', 'items', 'note', 'postedAt', 'purchaseId', 'refundCents']);
    expect(r1.body.item).toMatchObject({ purchaseId: A.id, businessDate: today(), backdated: false, refundCents: 39600, note: 'damaged' });
    expect(Object.keys(r1.body.item.items[0]).sort()).toEqual(['id', 'productId', 'productName', 'purchaseItemId', 'units', 'valueCents']);
    expect(r1.body.item.items).toEqual([expect.objectContaining({ purchaseItemId: itemId, productId: p.id, units: 3, valueCents: 39600 })]);
    expect(r1.body.purchase.items[0].returnedUnits).toBe(3);
    expect(r1.body.purchase.returns).toHaveLength(1);
    expect(r1.body.purchase.status).toBe('posted');
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 7, stockValueCents: 92400 });
    expect(moves(s, p.id)[1]).toMatchObject({ type: 'purchase_return', qty: -3, value: -39600, refTable: 'purchase_returns', refId: r1.body.item.id });
    expect(cashRows(s.ctx)[1]).toMatchObject({
      book: 'shop', type: 'purchase_refund', amount_cents: 39600, ref_table: 'purchase_returns', ref_id: r1.body.item.id,
      business_date: today(), reverses_entry_id: null,
    });

    const r2 = await ret(s, A.id, [{ purchaseItemId: itemId, units: 7 }]);
    expect(r2.status).toBe(201);
    expect(r2.body.item.refundCents).toBe(92400); // 132000 - 39600 (C7 remainder)
    expect(r2.body.purchase.items[0].returnedUnits).toBe(10);
    expect(r2.body.purchase.returns.map((x: any) => x.refundCents)).toEqual([39600, 92400]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(cashBal(s, 'shop')).toBe(0); // paid 132000, refunded 39600 + 92400
    reconOk(s);

    // nothing left to return
    const r3 = await ret(s, A.id, [{ purchaseItemId: itemId, units: 1 }]);
    expect(r3.status).toBe(422);
    expect(err(r3).code).toBe('RETURN_EXCEEDS_PURCHASED');
  });

  // 100,000 / 3 = 33,333.33 -> 33,333; again 33,333; the last unit takes the remainder 33,334. Total 100,000 exactly.
  it('3 units for Rs 1,000: returning one at a time refunds 33333, 33333, 33334', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 3, 100000)]);
    const id = A.items[0].id;
    const refunds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }]);
      expect(r.status).toBe(201);
      refunds.push(r.body.item.refundCents);
    }
    expect(refunds).toEqual([33333, 33333, 33334]);
    expect(refunds.reduce((a, b) => a + b, 0)).toBe(100000);
    expect(moves(s, p.id).slice(1).map((m) => m.value)).toEqual([-33333, -33333, -33334]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(cashBal(s, 'shop')).toBe(0);
    reconOk(s);
  });

  // 100,001 x 3 / 10 = 30,000.3 -> 30,000 (twice); the completing 4 take 100,001 - 60,000 = 40,001.
  it('10 units for 100001: 3, 3 then the completing 4 takes the exact remainder (30000, 30000, 40001)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 2, 5, 100001)]);
    const id = A.items[0].id;
    const out: number[] = [];
    for (const u of [3, 3, 4]) out.push((await ret(s, A.id, [{ purchaseItemId: id, units: u }])).body.item.refundCents);
    expect(out).toEqual([30000, 30000, 40001]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
  });

  it('multi-line return: refunds per line summed into one refund and one cash entry; other lines untouched', async () => {
    const s = await setup();
    const a = await mkProduct(s); const b = await mkProduct(s);
    const A = await buy(s, [line(a.id, 1, 4, 1000), line(b.id, 1, 5, 999)]);
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }, { purchaseItemId: A.items[1].id, units: 2 }]);
    expect(r.status).toBe(201);
    // 1000/4 = 250 ; 999*2/5 = 399.6 -> 400
    expect(r.body.item.items.map((i: any) => i.valueCents)).toEqual([250, 400]);
    expect(r.body.item.refundCents).toBe(650);
    expect(cashRows(s.ctx)).toHaveLength(2);
    expect(Number(cashRows(s.ctx)[1]!.amount_cents)).toBe(650);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 3, stockValueCents: 750 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 3, stockValueCents: 599 });
    expect(r.body.purchase.items.map((i: any) => i.returnedUnits)).toEqual([1, 2]);
  });

  it('audit row: entity purchase_return / create with the return date and backdated flag', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 4, 1000)], { businessDate: daysAgo(6) });
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }], { businessDate: daysAgo(2) });
    expect(r.status).toBe(201);
    expect(r.body.item.backdated).toBe(true);
    const rows = auditRows(s.ctx, 'purchase_return');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: String(r.body.item.id), action: 'create', before: null });
    expect(rows[0]!.after).toEqual(r.body.item);
    const raw = sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'purchase_return'")[0]!;
    expect([raw.business_date, Number(raw.backdated)]).toEqual([daysAgo(2), 1]);
  });

  // Cannot return more than was bought minus what was already returned.
  it('RETURN_EXCEEDS_PURCHASED -> 422 with fields["items.N.units"]; nothing written', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    const id = A.items[0].id;
    const before = snap(s);
    let r = await ret(s, A.id, [{ purchaseItemId: id, units: 11 }]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('RETURN_EXCEEDS_PURCHASED');
    expect(Object.keys(err(r).fields)).toEqual(['items.0.units']);
    expect(snap(s)).toEqual(before);
    await ret(s, A.id, [{ purchaseItemId: id, units: 4 }]);
    r = await ret(s, A.id, [{ purchaseItemId: id, units: 7 }]); // only 6 remain
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('RETURN_EXCEEDS_PURCHASED');
    expect((await ret(s, A.id, [{ purchaseItemId: id, units: 6 }])).status).toBe(201);
  });

  it('schema: units must be an integer >= 1; items 1-100; unknown fields rejected; postedAt rejected', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    const id = A.items[0].id;
    const before = snap(s);
    for (const units of [0, -1, 1.5, '2', null, 1e13]) {
      const r = await ret(s, A.id, [{ purchaseItemId: id, units: units as number }]);
      expect(r.status, String(units)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
    }
    for (const items of [[], undefined, [{ units: 1 }], [{ purchaseItemId: id }], [{ purchaseItemId: 0, units: 1 }], [{ purchaseItemId: '1', units: 1 }]]) {
      const r = await post(s.app, `/purchases/${A.id}/returns`, { businessDate: today(), clientRef: ref(), ...(items === undefined ? {} : { items }) });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
    }
    let r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { postedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.status).toBe(400);
    expect(err(r).fields.postedAt).toBeDefined();
    r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { bogus: 1 });
    expect(r.status).toBe(400);
    r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { refundCents: 5 });
    expect(r.status).toBe(400);
    r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { clientRef: 'short' });
    expect(r.status).toBe(400);
    r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { note: 'n'.repeat(501) });
    expect(r.status).toBe(400);
    expect(err(r).fields.note).toBeDefined();
    r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { businessDate: '2026-02-31' });
    expect(r.status).toBe(400);
    expect(snap(s)).toEqual(before);
  });

  it('item of another purchase / unknown item -> 400 VALIDATION_ERROR; duplicate item in one request -> 400', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    const B = await buy(s, [line(p.id, 1, 10, 1000)]);
    const before = snap(s);
    let r = await ret(s, A.id, [{ purchaseItemId: B.items[0].id, units: 1 }]);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('VALIDATION_ERROR');
    expect(Object.keys(err(r).fields)).toEqual(['items.0.purchaseItemId']);
    r = await ret(s, A.id, [{ purchaseItemId: 99999, units: 1 }]);
    expect(r.status).toBe(400);
    r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }, { purchaseItemId: A.items[0].id, units: 2 }]);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('VALIDATION_ERROR');
    expect(Object.keys(err(r).fields)).toEqual(['items.1.purchaseItemId']);
    expect(snap(s)).toEqual(before);
  });

  // Goods that were already sold cannot be sent back; the request fails and stock never goes negative.
  it('INSUFFICIENT_STOCK when the units were sold: 422, fields["items.N.units"], nothing written, no negative stock', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    engineSell(s, p.id, 8); // 2 left
    const before = snap(s);
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 3 }]);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('INSUFFICIENT_STOCK');
    expect(Object.keys(err(r).fields)).toEqual(['items.0.units']);
    expect(err(r).onHand).toBe(2);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 2 });
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.items[0].returnedUnits).toBe(0);
    // returning exactly what is on hand works
    expect((await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 2 }])).status).toBe(201);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    reconOk(s);
  });

  // All-or-nothing: the earlier line's stock and refund are rolled back when a later line fails.
  it('multi-line return where a LATER line lacks stock rolls back the earlier line too', async () => {
    const s = await setup();
    const a = await mkProduct(s); const b = await mkProduct(s);
    const A = await buy(s, [line(a.id, 1, 5, 500), line(b.id, 1, 5, 500)]);
    engineSell(s, b.id, 5);
    const before = snap(s);
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 2 }, { purchaseItemId: A.items[1].id, units: 2 }]);
    expect(r.status).toBe(422);
    expect(Object.keys(err(r).fields)).toEqual(['items.1.units']);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 500 });
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.items.map((i: any) => i.returnedUnits)).toEqual([0, 0]);
    reconOk(s);
  });

  // Check order: future date first (R-FD), then purchase lookup, then return-before-purchase (R-RD), then the other rules.
  describe('dates (R-FD then R-RD)', () => {
    // R-RD: you cannot return goods before you bought them; the error includes the original date to help the owner fix it.
    it('return before the purchase date -> 400 RETURN_BEFORE_ORIGINAL_DATE with message, fields, originalDate', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const orig = daysAgo(5);
      const A = await buy(s, [line(p.id, 1, 10, 1000)], { businessDate: orig });
      const before = snap(s);
      const msg = `The return date cannot be earlier than the original purchase date (${orig}). Please select ${orig} or a later date (not after today).`;
      for (const d of [daysAgo(6), daysAgo(100), '2000-01-01']) {
        const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }], { businessDate: d });
        expect(r.status).toBe(400);
        expect(err(r)).toEqual({ code: 'RETURN_BEFORE_ORIGINAL_DATE', message: msg, fields: { businessDate: msg }, originalDate: orig });
      }
      expect(snap(s)).toEqual(before);
    });

    // The valid window is original date <= return date <= today.
    it('return on the purchase date and after it (backdated) are accepted', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const orig = daysAgo(5);
      const A = await buy(s, [line(p.id, 1, 10, 1000)], { businessDate: orig });
      const id = A.items[0].id;
      let r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { businessDate: orig });
      expect(r.status).toBe(201);
      expect(r.body.item).toMatchObject({ businessDate: orig, backdated: true });
      r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { businessDate: daysAgo(2) });
      expect(r.status).toBe(201);
      expect(r.body.item.backdated).toBe(true);
      r = await ret(s, A.id, [{ purchaseItemId: id, units: 1 }], { businessDate: today() });
      expect(r.status).toBe(201);
      expect(r.body.item.backdated).toBe(false);
      expect(cashRows(s.ctx, "type = 'purchase_refund'").map((c) => c.business_date)).toEqual([orig, daysAgo(2), today()]);
      expect(moves(s, p.id).slice(1).map((m) => m.date)).toEqual([orig, daysAgo(2), today()]);
    });

    it('future-dated return -> 400 FUTURE_DATE_NOT_ALLOWED, checked BEFORE the purchase lookup', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const A = await buy(s, [line(p.id, 1, 10, 1000)]);
      const before = snap(s);
      const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }], { businessDate: daysAhead(1) });
      expect(r.status).toBe(400);
      expect(err(r)).toEqual({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
      const nf = await ret(s, 99999, [{ purchaseItemId: 1, units: 1 }], { businessDate: daysAhead(1) });
      expect(nf.status).toBe(400);
      expect(err(nf).code).toBe('FUTURE_DATE_NOT_ALLOWED');
      expect(snap(s)).toEqual(before);
    });

    it('unknown purchase with a valid date -> 404 NOT_FOUND', async () => {
      const s = await setup();
      const r = await ret(s, 99999, [{ purchaseItemId: 1, units: 1 }]);
      expect(r.status).toBe(404);
      expect(err(r).code).toBe('NOT_FOUND');
    });

    it('R-RD is checked before PURCHASE_VOID, item mapping and quantity rules', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const A = await buy(s, [line(p.id, 1, 10, 1000)], { businessDate: daysAgo(5) });
      const bad = [{ purchaseItemId: 99999, units: 500 }];
      let r = await ret(s, A.id, bad, { businessDate: daysAgo(9) });
      expect(err(r).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
      await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
      r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }], { businessDate: daysAgo(9) });
      expect(err(r).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    });
  });

  // A voided purchase has already been fully reversed.
  it('return on a void purchase -> 409 PURCHASE_VOID; nothing written', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    const before = snap(s);
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 1 }]);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('PURCHASE_VOID');
    expect(snap(s)).toEqual(before);
  });

  // Pool 3 / 7,500 (purchase 5,000 + 2,500 extra). Returning all 3: refund 5,000; stock sweeps -2,500 first, then -5,000 -> 0 / 0.
  it('residual sweep on return: pool 3/7500, returning all 3 (refund 5000) -> adjustment -2500 then -5000, 0/0', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 3, 5000)]);
    valueMove(s, p.id, 2500); // pool 3 / 7500
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 3 }]);
    expect(r.status).toBe(201);
    expect(r.body.item.refundCents).toBe(5000);
    const mv = moves(s, p.id);
    expect(mv.slice(-2).map((m) => [m.type, m.qty, m.value])).toEqual([['adjustment', 0, -2500], ['purchase_return', -3, -5000]]);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    reconOk(s);
  });

  // Purchase 10 / 10,000, pool written down to 10 / 1,000. Return 4: refund = 10,000 x 4 / 10 = 4,000 (cash),
  // but stock removal is capped at min(4,000, 1,000) = 1,000 -> 6 units / 0 value.
  it('pool value below the purchase value: refund is the purchase value, stock removal is capped at the pool value', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 10000)]);
    valueMove(s, p.id, -9000); // pool 10 / 1000
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 4 }]);
    expect(r.status).toBe(201);
    expect(r.body.item.refundCents).toBe(4000);                   // mulDivRound(10000, 4, 10)
    expect(moves(s, p.id).at(-1)).toMatchObject({ type: 'purchase_return', qty: -4, value: -1000 }); // min(4000, 1000)
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 6, stockValueCents: 0 });
    expect(Number(cashRows(s.ctx).at(-1)!.amount_cents)).toBe(4000);
    reconOk(s);
  });

  // Returning free goods removes units, refunds nothing, and writes no cash entry.
  it('zero-value purchase return: refund 0, no cash entry, stock removed', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 5, 0)]);
    const r = await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 2 }]);
    expect(r.status).toBe(201);
    expect(r.body.item.refundCents).toBe(0);
    expect(cashRows(s.ctx)).toHaveLength(0);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 3, stockValueCents: 0 });
  });

  it('telecom purchase: refund lands in the telecom book', async () => {
    const s = await setup();
    const t = await mkTelecom(s, { kind: 'stock' });
    const A = await buy(s, [line(t.id, 1, 10, 5000)]);
    await ret(s, A.id, [{ purchaseItemId: A.items[0].id, units: 10 }]);
    expect(cashRows(s.ctx).map((c) => [c.book, c.type, Number(c.amount_cents)])).toEqual([
      ['telecom', 'purchase_payment', -5000], ['telecom', 'purchase_refund', 5000],
    ]);
  });

  // Repeating a return request must not return the goods twice.
  describe('idempotency', () => {
    it('same clientRef repeats with 200 and the original; no second movement, refund, audit row or returnedUnits', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const A = await buy(s, [line(p.id, 1, 10, 1000)]);
      const body = { businessDate: today(), clientRef: 'return-idem-0001', items: [{ purchaseItemId: A.items[0].id, units: 4 }] };
      const first = await post(s.app, `/purchases/${A.id}/returns`, body);
      expect(first.status).toBe(201);
      const before = snap(s);
      const again = await post(s.app, `/purchases/${A.id}/returns`, body);
      expect(again.status).toBe(200);
      expect(again.body.item).toEqual(first.body.item);
      expect(again.body.purchase.items[0].returnedUnits).toBe(4);
      expect(snap(s)).toEqual(before);
      expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 6, stockValueCents: 600 });
    });

    // One reference cannot mean two different business actions.
    it('same clientRef used for a DIFFERENT purchase -> 409 CLIENT_REF_CONFLICT', async () => {
      const s = await setup();
      const p = await mkProduct(s);
      const A = await buy(s, [line(p.id, 1, 10, 1000)]);
      const B = await buy(s, [line(p.id, 1, 10, 1000)]);
      const clientRef = 'return-conflict-1';
      expect((await post(s.app, `/purchases/${A.id}/returns`, { businessDate: today(), clientRef, items: [{ purchaseItemId: A.items[0].id, units: 1 }] })).status).toBe(201);
      const before = snap(s);
      const r = await post(s.app, `/purchases/${B.id}/returns`, { businessDate: today(), clientRef, items: [{ purchaseItemId: B.items[0].id, units: 1 }] });
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('CLIENT_REF_CONFLICT');
      expect(snap(s)).toEqual(before);
    });
  });
});

// =============================================================================================
// Each step (purchase rows, stock movements, cash, audit) is forced to fail in turn; the database must end up exactly as before.
// breakAudit installs a trigger that makes audit inserts fail; other failures are injected by blocking the cash insert.
describe('atomic rollback (nothing persists when any step fails)', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('create: audit insert fails after movements and cash were written -> everything rolled back; retry works', async () => {
    const s = await setup();
    quiet();
    const a = await mkProduct(s); const b = await mkProduct(s);
    breakAudit(s.ctx, 'purchase');
    const before = snap(s);
    const body = { businessDate: today(), clientRef: 'atomic-create-01', items: [line(a.id, 1, 5, 500), line(b.id, 2, 3, 900)] };
    const r = await post(s.app, '/purchases', body);
    expect(r.status).toBe(500);
    expect(err(r).code).toBe('INTERNAL_ERROR');
    expect(snap(s)).toEqual(before);
    expect(snap(s)).toMatchObject({ purchases: 0, purchase_items: 0, stock_movements: 0, cash_entries: 0 });
    expect(auditRows(s.ctx, 'purchase')).toHaveLength(0);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    const ok = await post(s.app, '/purchases', body); // same clientRef: nothing was persisted, so it is created now
    expect(ok.status).toBe(201);
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 6, stockValueCents: 900 });
    reconOk(s);
  });

  it('create: a failing cash_entries insert (last step) rolls back purchase, items, movements and stock', async () => {
    const s = await setup();
    quiet();
    const a = await mkProduct(s);
    s.ctx.database.conn.exec("CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries BEGIN SELECT RAISE(ABORT, 'cash boom'); END");
    const before = snap(s);
    const r = await post(s.app, '/purchases', { businessDate: today(), clientRef: 'atomic-create-02', items: [line(a.id, 1, 5, 500)] });
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    // a zero-total purchase writes no cash entry, so the same broken trigger does not stop it
    expect((await post(s.app, '/purchases', { businessDate: today(), clientRef: 'atomic-create-03', items: [line(a.id, 1, 5, 0)] })).status).toBe(201);
  });

  it('void: failing audit rolls back movements, reversal cash entry and the status change', async () => {
    const s = await setup();
    quiet();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    const before = snap(s);
    breakAudit(s.ctx, 'purchase');
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 1000 });
    const row = sql(s, 'SELECT status, voided_at, void_reason FROM purchases WHERE id = ?', A.id)[0]!;
    expect([row.status, row.voided_at, row.void_reason]).toEqual(['posted', null, null]);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' })).status).toBe(200);
  });

  it('void: failing reversal cash insert rolls back the stock movements already written', async () => {
    const s = await setup();
    quiet();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    const before = snap(s);
    s.ctx.database.conn.exec("CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries BEGIN SELECT RAISE(ABORT, 'cash boom'); END");
    const r = await post(s.app, `/purchases/${A.id}/void`, { reason: 'x' });
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 1000 });
  });

  it('return: failing audit rolls back return rows, returned units, movements and the refund', async () => {
    const s = await setup();
    quiet();
    const a = await mkProduct(s); const b = await mkProduct(s);
    const A = await buy(s, [line(a.id, 1, 10, 1000), line(b.id, 1, 10, 2000)]);
    const before = snap(s);
    breakAudit(s.ctx, 'purchase_return');
    const r = await post(s.app, `/purchases/${A.id}/returns`, {
      businessDate: today(), clientRef: 'atomic-return-01',
      items: [{ purchaseItemId: A.items[0].id, units: 3 }, { purchaseItemId: A.items[1].id, units: 4 }],
    });
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 1000 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 2000 });
    expect((await get(s.app, `/purchases/${A.id}`)).body.item.items.map((i: any) => i.returnedUnits)).toEqual([0, 0]);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    expect((await post(s.app, `/purchases/${A.id}/returns`, {
      businessDate: today(), clientRef: 'atomic-return-01', items: [{ purchaseItemId: A.items[0].id, units: 3 }],
    })).status).toBe(201);
  });

  it('return: failing refund cash insert rolls back everything', async () => {
    const s = await setup();
    quiet();
    const p = await mkProduct(s);
    const A = await buy(s, [line(p.id, 1, 10, 1000)]);
    const before = snap(s);
    s.ctx.database.conn.exec("CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries BEGIN SELECT RAISE(ABORT, 'cash boom'); END");
    const r = await post(s.app, `/purchases/${A.id}/returns`, {
      businessDate: today(), clientRef: 'atomic-return-02', items: [{ purchaseItemId: A.items[0].id, units: 3 }],
    });
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, p.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 1000 });
  });
});
