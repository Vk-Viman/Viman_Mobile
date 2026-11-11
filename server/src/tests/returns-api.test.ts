// Sales returns API (POST /sales/:id/returns) - API level (Fastify inject, real temp database).
// Protects BUSINESS_RULES: R5 / C5 (revenue and COGS of a returned line are split proportionally and the return that completes the
// line takes the exact remainder), resalable goods go back on the shelf at the ORIGINAL snapshot cost (never at today's average),
// DAMAGED goods write no stock movement but exactly ONE stock_losses row per damaged line (the loss is counted once, section 4 / R2;
// its void is refused), section 2 (refund = negative sale_refund / card_refund cash entry dated the return's date), R-FD then R-RD
// (a return cannot predate its sale; exact owner-approved message), SALE_VOID, RETURN_EXCEEDS_SOLD, clientRef idempotency and
// conflict, audit (entity sale_return) and all-or-nothing rollback. Reconciliation (cache = ledger) is checked after every step.
// Organised as: resalable returns, damaged returns, quantity and request validation, dates (R-FD / R-RD), telecom, void sale,
// idempotency, atomic rollback, audit. Money in cents; the hand calculation sits above each test.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, FUTURE_MSG, lossVoid, mvs, mvsByRef, num, poolOf, productsSnap, reconOk, sql } from './helpers/phase4.ts';
import {
  breakCash, breakLoss, cashBal, cashOfRef, cl, LOSS_KEYS, lossRows, RETURN_ITEM_KEYS, RETURN_KEYS, returnNew, returnOk, rl,
  sellOk, snap5, stocked, stocked20, voidSaleNew,
} from './helpers/phase5.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });
/** Number of rows of a table (shorthand). */
const rows = (s: ApiBase, t: string) => num(s, `SELECT COUNT(*) FROM ${t}`);
const returnedQty = (s: ApiBase, itemId: number) => num(s, 'SELECT returned_qty FROM sale_items WHERE id = ?', itemId);
const returnMsg = (d: string) => `The return date cannot be earlier than the original sale date (${d}). Please select ${d} or a later date (not after today).`;

/**
 * Fixture: product with the pool 20 / 700000 (average 35000) and a sale of `qty` units at `price`.
 * Returns the app base, product, sale and its first line.
 */
async function saleFx(qty: number, price: number, over: Record<string, unknown> = {}) {
  const s = await setup();
  const P = await stocked20(s, shop0);
  const sale = (await sellOk(s, [cl(P.id, qty, price)], over)).sales[0];
  return { s, P, sale, item: sale.items[0] };
}

// =============================================================================================
// Resalable returns: stock comes back at the ORIGINAL cost.
describe('POST /sales/:id/returns - resalable', () => {
  // Hand calculation: pool 20 / 700,000 (avg 35,000). Sale of 4 @ 100,000: revenue 400,000, COGS 140,000, pool 16 / 560,000.
  // Return 1 (partial): revenue 400,000 x 1 / 4 = 100,000, COGS 140,000 x 1 / 4 = 35,000 -> pool 17 / 595,000;
  //   one sale_return movement +1 / +35,000; cash refund -100,000 (sale_refund, shop).
  // Return 3 (completes the line): takes the remainder: revenue 300,000, COGS 105,000 -> pool 20 / 700,000.
  it('partial then final return: exact portions, stock back at the snapshot cost, refund entries, returnedQty', async () => {
    const { s, P, sale, item } = await saleFx(4, 100000);
    expect(poolOf(s, P.id)).toEqual({ qty: 16, value: 560000 });
    const r1 = await returnNew(s, sale.id, [rl(item.id, 1, true)], { clientRef: 'return-0001' });
    expect(r1.status).toBe(201);
    expect(Object.keys(r1.body).sort()).toEqual(['item', 'sale', 'warnings']);
    expect(Object.keys(r1.body.item).sort()).toEqual(RETURN_KEYS);
    expect(Object.keys(r1.body.item.items[0]).sort()).toEqual(RETURN_ITEM_KEYS);
    expect(r1.body.item).toMatchObject({
      saleId: sale.id, businessDate: today(), backdated: false, refundCents: 100000, cogsReversedCents: 35000, extraCostReversedCents: 0, note: '', clientRef: 'return-0001',
    });
    expect(r1.body.item.items[0]).toMatchObject({ saleItemId: item.id, productId: P.id, qty: 1, resalable: true, revenueCents: 100000, cogsCents: 35000, extraCostCents: 0 });
    expect(poolOf(s, P.id)).toEqual({ qty: 17, value: 595000 });
    const m = mvsByRef(s, 'sales_returns', r1.body.item.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ productId: P.id, type: 'sale_return', qty: 1, value: 35000, unit: 35000, date: today() });
    const c1 = cashOfRef(s, 'sales_returns', r1.body.item.id);
    expect(c1).toHaveLength(1);
    expect(c1[0]).toMatchObject({ book: 'shop', type: 'sale_refund', amount_cents: -100000, business_date: today(), reverses_entry_id: null });
    // the sale in the response: line counter moved, sale totals unchanged (returns are shown on their own)
    expect(r1.body.sale.items[0].returnedQty).toBe(1);
    expect(r1.body.sale).toMatchObject({ totalCents: 400000, cogsCents: 140000, grossProfitCents: 260000 });
    expect(r1.body.sale.returns).toHaveLength(1);
    await reconOk(s);

    const r2 = await returnOk(s, sale.id, [rl(item.id, 3, true)]);
    expect(r2.item.items[0]).toMatchObject({ qty: 3, revenueCents: 300000, cogsCents: 105000 });
    expect(r2.item).toMatchObject({ refundCents: 300000, cogsReversedCents: 105000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 20, value: 700000 });
    expect(returnedQty(s, item.id)).toBe(4);
    expect((await get(s.app, `/sales/${sale.id}`)).body.item.returns.map((r: any) => r.refundCents)).toEqual([100000, 300000]);
    // net cash of the sale after taking everything back is zero: +400,000 - 100,000 - 300,000
    const net = [...cashOfRef(s, 'sales', sale.id), ...cashOfRef(s, 'sales_returns', r1.body.item.id), ...cashOfRef(s, 'sales_returns', r2.item.id)]
      .reduce((a, c) => a + Number(c.amount_cents), 0);
    expect(net).toBe(0);
    await reconOk(s);
  });

  // Hand calculation: sale of 2 @ 100,000 at pool 20 / 700,000: COGS 70,000 (35,000 each), pool 18 / 630,000.
  // A later purchase of 5 for 210,000 -> pool 23 / 840,000 (average 36,521.74). Returning both units resalable puts back EXACTLY the
  // snapshot 70,000 (not 2 x 36,521.74 = 73,043): pool 25 / 910,000, i.e. value rose by exactly the COGS portion.
  it('resalable return after a later purchase changed the average: pool value rises by exactly the original COGS portion', async () => {
    const { s, P, sale, item } = await saleFx(2, 100000);
    await buy(s, [{ productId: P.id, packs: 1, packSize: 5, lineTotalCents: 210000 }]);
    expect(poolOf(s, P.id)).toEqual({ qty: 23, value: 840000 });
    const r = await returnOk(s, sale.id, [rl(item.id, 1, true)]);                // 70,000 x 1 / 2 = 35,000
    expect(poolOf(s, P.id)).toEqual({ qty: 24, value: 875000 });
    expect(r.item.items[0].cogsCents).toBe(35000);
    const r2 = await returnOk(s, sale.id, [rl(item.id, 1, true)]);               // final: remainder 35,000
    expect(r2.item.items[0].cogsCents).toBe(35000);
    expect(poolOf(s, P.id)).toEqual({ qty: 25, value: 910000 });
    expect(mvsByRef(s, 'sales_returns', r2.item.id)[0]).toMatchObject({ qty: 1, value: 35000, unit: 35000 });
    await reconOk(s);
  });

  // The returned goods may have been sold again in between; the return still restocks (it is an inflow).
  it('return of goods whose stock was sold out meanwhile still works (inflow into an empty pool)', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 3, 3000);
    const sale = (await sellOk(s, [cl(P.id, 3, 2000)])).sales[0];
    expect(poolOf(s, P.id)).toEqual({ qty: 0, value: 0 });
    await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)]);                 // 3,000 x 2 / 3 = 2,000
    expect(poolOf(s, P.id)).toEqual({ qty: 2, value: 2000 });
    await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)]);                 // remainder 1,000
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
    await reconOk(s);
  });

  // Hand calculation: price 0 -> revenue 0, so the refund is 0 and NO cash entry is written; COGS 1,000 x 1 / 2 = 500 still returns to stock.
  it('free item return: refund 0 writes no cash entry; stock still restored', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 4, 4000);
    const sale = (await sellOk(s, [cl(P.id, 2, 0)])).sales[0];
    const cashBefore = rows(s, 'cash_entries');
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)]);
    expect(r.item).toMatchObject({ refundCents: 0, cogsReversedCents: 1000 });
    expect(rows(s, 'cash_entries')).toBe(cashBefore);
    expect(poolOf(s, P.id)).toEqual({ qty: 3, value: 3000 });
  });

  it('a return line of a MIXED cart only touches its own sale (the other book stays intact)', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 5, 5000);
    const T = await stocked(s, tel0, 10, 5000);
    const [shop, tel] = (await sellOk(s, [cl(A.id, 2, 1500), cl(T.id, 4, 700)])).sales;
    const r = await returnOk(s, tel.id, [rl(tel.items[0].id, 1, true)]);
    expect(r.sale.id).toBe(tel.id);
    expect((await get(s.app, `/sales/${shop.id}`)).body.item.returns).toEqual([]);
    expect(poolOf(s, A.id)).toEqual({ qty: 3, value: 3000 });
    // telecom: 4 x 700 = 2,800 revenue; return of 1 refunds 700; COGS 5,000 x 4 / 10 = 2,000, portion 500
    expect(r.item).toMatchObject({ refundCents: 700, cogsReversedCents: 500 });
    await reconOk(s);
  });
});

// =============================================================================================
// Damaged returns: no stock movement, exactly one loss row per damaged line.
describe('POST /sales/:id/returns - damaged', () => {
  // Hand calculation: sale of 2 @ 100,000 (COGS 70,000), pool 18 / 630,000. Damaged return of 1: revenue 100,000 and COGS 35,000 are
  // reversed, refund -100,000 (sale_refund), pool UNCHANGED 18 / 630,000, NO movement; one loss: damaged_return / damaged, qty 1,
  // cost 35,000, shop book, the return's date, salesReturnId set.
  it('damaged return: refund + revenue/COGS reversed, no stock movement, exactly one damaged_return loss', async () => {
    const { s, P, sale, item } = await saleFx(2, 100000);
    const movesBefore = rows(s, 'stock_movements');
    const r = await returnOk(s, sale.id, [rl(item.id, 1, false)]);
    expect(r.item).toMatchObject({ refundCents: 100000, cogsReversedCents: 35000 });
    expect(r.item.items[0]).toMatchObject({ qty: 1, resalable: false, revenueCents: 100000, cogsCents: 35000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 18, value: 630000 });
    expect(rows(s, 'stock_movements')).toBe(movesBefore);
    expect(mvsByRef(s, 'sales_returns', r.item.id)).toEqual([]);
    expect(mvs(s, "type = 'sale_return'")).toEqual([]);
    const cash = cashOfRef(s, 'sales_returns', r.item.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'sale_refund', amount_cents: -100000, business_date: today() });
    const losses = lossRows(s);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({
      source: 'damaged_return', reason: 'damaged', qty: 1, cost_cents: 35000, book: 'shop', business_date: today(),
      sales_return_id: r.item.id, product_id: P.id, status: 'posted',
    });
    expect(returnedQty(s, item.id)).toBe(1);
    // the loss is visible through GET /stock-losses with the Phase 5 fields
    const api = (await get(s.app, '/stock-losses')).body.items.filter((l: any) => l.source === 'damaged_return');
    expect(api).toHaveLength(1);
    expect(Object.keys(api[0]).sort()).toEqual(LOSS_KEYS);
    expect(api[0]).toMatchObject({ salesReturnId: r.item.id, reason: 'damaged', costCents: 35000, qty: 1, book: 'shop', businessDate: today(), productId: P.id });
    await reconOk(s);
  });

  // R1: the loss belongs to its return and cannot be voided on its own.
  it('voiding a damaged-return loss is refused (409 DAMAGED_RETURN_LOSS) and nothing changes', async () => {
    const { s, sale, item } = await saleFx(2, 100000);
    await returnOk(s, sale.id, [rl(item.id, 1, false)]);
    const loss = (await get(s.app, '/stock-losses')).body.items[0];
    const before = snap5(s);
    const r = await lossVoid(s, loss.id);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('DAMAGED_RETURN_LOSS');
    expect(snap5(s)).toEqual(before);
    expect((await get(s.app, `/stock-losses/${loss.id}`)).body.item.status).toBe('posted');
  });

  // Hand calculation: A pool 10 / 10,000, B pool 5 / 2,500. Sale [A 4 @ 1,500, B 2 @ 800]: A COGS 4,000, B COGS 1,000.
  // Return: A 2 resalable (revenue 3,000, COGS 4,000 x 2 / 4 = 2,000), B 1 damaged (revenue 800, COGS 1,000 x 1 / 2 = 500).
  // Refund 3,800 as ONE cash entry; COGS reversed 2,500; A pool 6/6,000 -> 8/8,000; B pool unchanged 3 / 1,500;
  // exactly ONE sale_return movement (A) and ONE loss (B, cost 500).
  it('resalable and damaged lines in one return: one restock movement, one loss, one refund entry', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 4, 1500), cl(B.id, 2, 800)])).sales[0];
    const [la, lb] = sale.items;
    const r = await returnOk(s, sale.id, [rl(la.id, 2, true), rl(lb.id, 1, false)]);
    expect(r.item).toMatchObject({ refundCents: 3800, cogsReversedCents: 2500 });
    expect(r.item.items.map((i: any) => [i.revenueCents, i.cogsCents, i.resalable])).toEqual([[3000, 2000, true], [800, 500, false]]);
    expect(poolOf(s, A.id)).toEqual({ qty: 8, value: 8000 });
    expect(poolOf(s, B.id)).toEqual({ qty: 3, value: 1500 });
    expect(mvsByRef(s, 'sales_returns', r.item.id).map((m) => [m.productId, m.type, m.qty, m.value])).toEqual([[A.id, 'sale_return', 2, 2000]]);
    expect(lossRows(s).map((l) => [l.product_id, l.cost_cents, l.qty])).toEqual([[B.id, 500, 1]]);
    expect(cashOfRef(s, 'sales_returns', r.item.id).map((c) => c.amount_cents)).toEqual([-3800]);
    await reconOk(s);
  });

  // Two damaged lines -> two loss rows (one per line), each with its own COGS portion and a distinct clientRef.
  it('two damaged lines in one return -> exactly two loss rows with distinct clientRefs', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 4, 1500), cl(B.id, 2, 800)])).sales[0];
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 1, false), rl(sale.items[1].id, 2, false)]);
    const losses = lossRows(s);
    expect(losses.map((l) => [l.product_id, l.cost_cents, l.qty, l.sales_return_id])).toEqual([[A.id, 1000, 1, r.item.id], [B.id, 1000, 2, r.item.id]]);
    expect(new Set(losses.map((l) => l.client_ref)).size).toBe(2);
    expect(r.item.cogsReversedCents).toBe(2000);
    expect(poolOf(s, A.id)).toEqual({ qty: 6, value: 6000 });                    // nothing restocked
    expect(poolOf(s, B.id)).toEqual({ qty: 3, value: 1500 });
    await reconOk(s);
  });

  // Hand calculation (as in the snapshot test): 5 units, COGS 1,001. Return 2 resalable -> 400 back (pool 2 / 400);
  // then the remaining 3 damaged take the remainder 601 -> one loss of 601; pool still 2 / 400.
  it('successive returns of one line: resalable first, damaged last (remainder 601 written off)', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 1001);
    const sale = (await sellOk(s, [cl(P.id, 5, 1000)])).sales[0];
    const id = sale.items[0].id;
    await returnOk(s, sale.id, [rl(id, 2, true)]);
    expect(poolOf(s, P.id)).toEqual({ qty: 2, value: 400 });
    const r = await returnOk(s, sale.id, [rl(id, 3, false)]);
    expect(r.item.items[0].cogsCents).toBe(601);
    expect(poolOf(s, P.id)).toEqual({ qty: 2, value: 400 });
    expect(lossRows(s).map((l) => [l.qty, l.cost_cents])).toEqual([[3, 601]]);
    expect(returnedQty(s, id)).toBe(5);
    await reconOk(s);
  });

  it('damaged return on a backdated sale: the loss carries the RETURN date; reason is damaged', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)], { businessDate: daysAgo(6) })).sales[0];
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 1, false)], { businessDate: daysAgo(2) });
    expect(lossRows(s)[0]).toMatchObject({ business_date: daysAgo(2), reason: 'damaged', cost_cents: 1000, sales_return_id: r.item.id });
  });
});

// =============================================================================================
// Quantity rules and request validation.
describe('POST /sales/:id/returns - validation', () => {
  // Hand calculation: sold 4. Return 3 is fine (1 left). Asking 2 more is over the remaining 1 -> 422 at items.0.qty; the whole
  // request is refused (second line too) and nothing is written.
  it('RETURN_EXCEEDS_SOLD: above sold, and cumulative across returns; nothing saved', async () => {
    const { s, sale, item } = await saleFx(4, 100000);
    const before = snap5(s);
    const a = await returnNew(s, sale.id, [rl(item.id, 5, true)]);
    expect(a.status).toBe(422);
    expect(err(a).code).toBe('RETURN_EXCEEDS_SOLD');
    expect(err(a).fields['items.0.qty']).toBeTruthy();
    expect(snap5(s)).toEqual(before);
    await returnOk(s, sale.id, [rl(item.id, 3, true)]);
    const mid = snap5(s);
    const b = await returnNew(s, sale.id, [rl(item.id, 2, true)]);
    expect(b.status).toBe(422);
    expect(err(b).code).toBe('RETURN_EXCEEDS_SOLD');
    expect(err(b).fields['items.0.qty']).toContain('1');
    expect(snap5(s)).toEqual(mid);
    expect(returnedQty(s, item.id)).toBe(3);
    expect((await returnNew(s, sale.id, [rl(item.id, 1, true)])).status).toBe(201);
    expect((await returnNew(s, sale.id, [rl(item.id, 1, true)])).status).toBe(422);   // nothing left
    await reconOk(s);
  });

  it('one over-limit line among valid lines refuses the whole return', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 4, 1500), cl(B.id, 2, 800)])).sales[0];
    const before = snap5(s);
    const r = await returnNew(s, sale.id, [rl(sale.items[0].id, 2, true), rl(sale.items[1].id, 3, true)]);
    expect(r.status).toBe(422);
    expect(Object.keys(err(r).fields)).toEqual(['items.1.qty']);
    expect(snap5(s)).toEqual(before);
    expect(returnedQty(s, sale.items[0].id)).toBe(0);
  });

  it('items of ANOTHER sale, unknown items and duplicate lines -> 400 VALIDATION_ERROR items.N.saleItemId', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const a = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    const b = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    const before = snap5(s);
    const foreign = await returnNew(s, a.id, [rl(b.items[0].id, 1, true)]);
    expect(foreign.status).toBe(400);
    expect(err(foreign).code).toBe('VALIDATION_ERROR');
    expect(err(foreign).fields['items.0.saleItemId']).toBeTruthy();
    const unknown = await returnNew(s, a.id, [rl(999999, 1, true)]);
    expect(unknown.status).toBe(400);
    const dup = await returnNew(s, a.id, [rl(a.items[0].id, 1, true), rl(a.items[0].id, 1, true)]);
    expect(dup.status).toBe(400);
    expect(err(dup).fields['items.1.saleItemId']).toBeTruthy();
    expect(snap5(s)).toEqual(before);
  });

  it('resalable is required and must be a real boolean; qty must be an integer >= 1; no unknown fields', async () => {
    const { s, sale, item } = await saleFx(4, 100000);
    const post1 = (items: unknown[], extra: Record<string, unknown> = {}) =>
      post(s.app, `/sales/${sale.id}/returns`, { businessDate: today(), items, clientRef: ref(), ...extra });
    const cases: Array<[string, unknown[]]> = [
      ['items.0.resalable', [{ saleItemId: item.id, qty: 1 }]],
      ['items.0.resalable', [{ saleItemId: item.id, qty: 1, resalable: 'true' }]],
      ['items.0.resalable', [{ saleItemId: item.id, qty: 1, resalable: 1 }]],
      ['items.0.resalable', [{ saleItemId: item.id, qty: 1, resalable: null }]],
      ['items.0.qty', [{ saleItemId: item.id, qty: 0, resalable: true }]],
      ['items.0.qty', [{ saleItemId: item.id, qty: -1, resalable: true }]],
      ['items.0.qty', [{ saleItemId: item.id, qty: 1.5, resalable: true }]],
      ['items.0.qty', [{ saleItemId: item.id, qty: '1', resalable: true }]],
      ['items.0.qty', [{ saleItemId: item.id, resalable: true }]],
      ['items.0.saleItemId', [{ saleItemId: String(item.id), qty: 1, resalable: true }]],
      ['items.0.saleItemId', [{ qty: 1, resalable: true }]],
      ['items.0.revenueCents', [{ saleItemId: item.id, qty: 1, resalable: true, revenueCents: 5 }]],
      ['items', []],
    ];
    for (const [key, items] of cases) {
      const r = await post1(items);
      expect(r.status, key + JSON.stringify(items)).toBe(400);
      expect(err(r).fields[key], key).toBeTruthy();
    }
    expect(err(await post1([rl(item.id, 1, true)], { postedAt: '2020-01-01T00:00:00.000Z' })).fields.postedAt).toBe('Unknown field.');
    expect(err(await post1([rl(item.id, 1, true)], { refundCents: 5 })).fields.refundCents).toBe('Unknown field.');
    for (const c of ['short', 'has space 12345', 'y'.repeat(65)]) expect((await post1([rl(item.id, 1, true)], { clientRef: c })).status, c).toBe(400);
    expect((await post1([rl(item.id, 1, true)], { note: 'n'.repeat(501) })).status).toBe(400);
    const missing = await post(s.app, `/sales/${sale.id}/returns`, { items: [rl(item.id, 1, true)], clientRef: ref() });
    expect(err(missing).fields.businessDate).toBeTruthy();
    expect(rows(s, 'sales_returns')).toBe(0);
    // a valid note is kept (trimmed)
    const ok = await post1([rl(item.id, 1, true)], { note: '  broken box  ' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.note).toBe('broken box');
  });

  it('unknown sale -> 404 NOT_FOUND; non-numeric id -> 400', async () => {
    const s = await setup();
    const r = await returnNew(s, 99999, [rl(1, 1, true)]);
    expect(r.status).toBe(404);
    expect(err(r).code).toBe('NOT_FOUND');
    expect((await post(s.app, '/sales/abc/returns', { businessDate: today(), items: [rl(1, 1, true)], clientRef: ref() })).status).toBe(400);
  });
});

// =============================================================================================
// Dates: R-FD first, then R-RD; backdated returns are fine.
describe('POST /sales/:id/returns - dates (R-FD, R-RD)', () => {
  // Sale dated 5 days ago. A return dated 6 days ago is before the sale -> RETURN_BEFORE_ORIGINAL_DATE with the exact message
  // naming the original date, fields.businessDate and `originalDate` in the body. Same day, 2 days ago and today are accepted.
  it('return before the sale date -> 400 RETURN_BEFORE_ORIGINAL_DATE (exact message, originalDate); sale date, later dates and today accepted', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const sale = (await sellOk(s, [cl(P.id, 5, 1500)], { businessDate: daysAgo(5) })).sales[0];
    const id = sale.items[0].id;
    const before = snap5(s);
    for (const d of [daysAgo(6), daysAgo(60)]) {
      const r = await returnNew(s, sale.id, [rl(id, 1, true)], { businessDate: d });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
      expect(err(r).message).toBe(returnMsg(daysAgo(5)));
      expect(err(r).fields.businessDate).toBe(returnMsg(daysAgo(5)));
      expect(err(r).originalDate).toBe(daysAgo(5));
    }
    expect(snap5(s)).toEqual(before);
    const same = await returnNew(s, sale.id, [rl(id, 1, true)], { businessDate: daysAgo(5) });
    expect(same.status).toBe(201);
    expect(same.body.item).toMatchObject({ businessDate: daysAgo(5), backdated: true });
    expect((await returnNew(s, sale.id, [rl(id, 1, true)], { businessDate: daysAgo(2) })).status).toBe(201);
    expect((await returnNew(s, sale.id, [rl(id, 1, true)], { businessDate: today() })).status).toBe(201);
    await reconOk(s);
  });

  // A sale dated today allows only today: yesterday is before the sale.
  it('sale dated today -> only today is allowed (yesterday refused with originalDate = today)', async () => {
    const { s, sale, item } = await saleFx(2, 100000);
    const r = await returnNew(s, sale.id, [rl(item.id, 1, true)], { businessDate: daysAgo(1) });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    expect(err(r).originalDate).toBe(today());
    expect((await returnNew(s, sale.id, [rl(item.id, 1, true)], { businessDate: today() })).status).toBe(201);
  });

  it('future date -> 400 FUTURE_DATE_NOT_ALLOWED with the exact message; checked BEFORE the sale lookup and R-RD', async () => {
    const { s, sale, item } = await saleFx(2, 100000);
    const before = snap5(s);
    const r = await returnNew(s, sale.id, [rl(item.id, 1, true)], { businessDate: daysAhead(1) });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(err(r).message).toBe(FUTURE_MSG);
    expect(err(r).fields.businessDate).toBe(FUTURE_MSG);
    const ghost = await returnNew(s, 99999, [rl(1, 1, true)], { businessDate: daysAhead(3) });   // unknown sale: still the date error, not 404
    expect(err(ghost).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(snap5(s)).toEqual(before);
  });

  // Check order: schema -> R-FD -> 404 -> R-RD -> SALE_VOID -> items/quantities.
  it('R-RD is checked before SALE_VOID and before item / quantity rules', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)], { businessDate: daysAgo(5) })).sales[0];
    // quantity and item errors come AFTER the date rule
    const r1 = await returnNew(s, sale.id, [rl(sale.items[0].id, 99, true)], { businessDate: daysAgo(6) });
    expect(err(r1).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    const r2 = await returnNew(s, sale.id, [rl(999999, 1, true)], { businessDate: daysAgo(6) });
    expect(err(r2).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    await voidSaleNew(s, sale.id);
    const r3 = await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(6) });
    expect(err(r3).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    const r4 = await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: today() });
    expect(r4.status).toBe(409);
    expect(err(r4).code).toBe('SALE_VOID');
  });

  // A backdated return carries its own business date into the movement, the refund and the audit flag.
  it('backdated return: movement, cash refund and audit use the return date; backdated flag set', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)], { businessDate: daysAgo(6) })).sales[0];
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(3) });
    expect(r.item).toMatchObject({ businessDate: daysAgo(3), backdated: true });
    expect(mvsByRef(s, 'sales_returns', r.item.id)[0]!.date).toBe(daysAgo(3));
    expect(cashOfRef(s, 'sales_returns', r.item.id)[0]!.business_date).toBe(daysAgo(3));
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'sale_return'")).toEqual([{ business_date: daysAgo(3), backdated: 1 }]);
    // return dated today on a today sale is not backdated
    const t = (await sellOk(s, [cl(P.id, 1, 1500)])).sales[0];
    expect((await returnOk(s, t.id, [rl(t.items[0].id, 1, true)])).item.backdated).toBe(false);
  });
});

// =============================================================================================
// Telecom, void sale.
describe('POST /sales/:id/returns - telecom and void', () => {
  // Hand calculation: scratch cards 100 / 50,000 (avg 500). Sale 10 @ 600: revenue 6,000, COGS 5,000. Return 4 resalable:
  // revenue 6,000 x 4 / 10 = 2,400 (price 600 x 4), COGS 5,000 x 4 / 10 = 2,000 -> pool 94 / 47,000; refund -2,400 as card_refund (telecom book).
  it('telecom return: card_refund negative in the telecom book; stock back at snapshot cost', async () => {
    const s = await setup();
    const T = await stocked(s, tel0, 100, 50000);
    const sale = (await sellOk(s, [cl(T.id, 10, 600)])).sales[0];
    const shopBefore = cashBal(s, 'shop');
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 4, true)]);
    expect(r.item).toMatchObject({ refundCents: 2400, cogsReversedCents: 2000 });
    expect(poolOf(s, T.id)).toEqual({ qty: 94, value: 47000 });
    expect(cashOfRef(s, 'sales_returns', r.item.id).map((c) => [c.book, c.type, c.amount_cents])).toEqual([['telecom', 'card_refund', -2400]]);
    expect(cashBal(s, 'shop')).toBe(shopBefore);
    await reconOk(s);
  });

  it('damaged telecom return: the write-off belongs to the telecom book', async () => {
    const s = await setup();
    const T = await stocked(s, tel0, 100, 50000);
    const sale = (await sellOk(s, [cl(T.id, 10, 600)])).sales[0];
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 2, false)]);
    expect(lossRows(s)[0]).toMatchObject({ book: 'telecom', cost_cents: 1000, qty: 2, sales_return_id: r.item.id });
    expect(cashOfRef(s, 'sales_returns', r.item.id)[0]).toMatchObject({ book: 'telecom', type: 'card_refund', amount_cents: -1200 });
    expect(poolOf(s, T.id)).toEqual({ qty: 90, value: 45000 });
  });

  it('return on a void sale -> 409 SALE_VOID; nothing written', async () => {
    const { s, sale, item } = await saleFx(2, 100000);
    expect((await voidSaleNew(s, sale.id)).status).toBe(200);
    const before = snap5(s);
    const r = await returnNew(s, sale.id, [rl(item.id, 1, true)]);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('SALE_VOID');
    expect(snap5(s)).toEqual(before);
    await reconOk(s);
  });
});

// =============================================================================================
// Idempotency (section 12).
describe('POST /sales/:id/returns - idempotency', () => {
  // Damaged line included so a duplicate loss would show up too.
  it('same clientRef repeats with 200 and the original; no second movement, loss, refund, audit row or returnedQty change', async () => {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 4, 1500), cl(B.id, 2, 800)])).sales[0];
    const body = { businessDate: today(), items: [rl(sale.items[0].id, 1, true), rl(sale.items[1].id, 1, false)], clientRef: 'ret-idem-0001' };
    const first = await post(s.app, `/sales/${sale.id}/returns`, body);
    expect(first.status).toBe(201);
    const counts = snap5(s);
    const stock = productsSnap(s);
    const again = await post(s.app, `/sales/${sale.id}/returns`, body);
    expect(again.status).toBe(200);
    expect(again.body.item).toEqual(first.body.item);
    expect(again.body.sale.items.map((i: any) => i.returnedQty)).toEqual([1, 1]);
    expect(snap5(s)).toEqual(counts);
    expect(productsSnap(s)).toBe(stock);
    expect(rows(s, 'stock_losses')).toBe(1);
    expect(returnedQty(s, sale.items[0].id)).toBe(1);
    await reconOk(s);
  });

  it('the same clientRef used on ANOTHER sale -> 409 CLIENT_REF_CONFLICT, nothing written', async () => {
    const s = await setup();
    const P = await stocked(s, shop0, 10, 10000);
    const a = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    const b = (await sellOk(s, [cl(P.id, 2, 1500)])).sales[0];
    await returnOk(s, a.id, [rl(a.items[0].id, 1, true)], { clientRef: 'ret-conflict-01' });
    const counts = snap5(s);
    const r = await returnNew(s, b.id, [rl(b.items[0].id, 1, true)], { clientRef: 'ret-conflict-01' });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('CLIENT_REF_CONFLICT');
    expect(snap5(s)).toEqual(counts);
    expect(returnedQty(s, b.items[0].id)).toBe(0);
  });

  it('a different clientRef is a new return', async () => {
    const { s, sale, item } = await saleFx(4, 100000);
    await returnOk(s, sale.id, [rl(item.id, 1, true)], { clientRef: 'ret-new-00001' });
    await returnOk(s, sale.id, [rl(item.id, 1, true)], { clientRef: 'ret-new-00002' });
    expect(rows(s, 'sales_returns')).toBe(2);
    expect(returnedQty(s, item.id)).toBe(2);
  });
});

// =============================================================================================
// Atomic rollback: header, lines, returned_qty, stock, loss, cash and audit are one transaction.
describe('atomic rollback (nothing persists when any step fails)', () => {
  /** A sale of two lines (A resalable, B damaged material) ready for a failing return. */
  async function twoLines() {
    const s = await setup();
    const A = await stocked(s, shop0, 10, 10000);
    const B = await stocked(s, shop0, 5, 2500);
    const sale = (await sellOk(s, [cl(A.id, 4, 1500), cl(B.id, 2, 800)])).sales[0];
    return { s, A, B, sale, req: [rl(sale.items[0].id, 2, true), rl(sale.items[1].id, 1, false)] };
  }
  const expectNothing = async (s: ApiBase, before: Record<string, number>, stock: string, sale: any) => {
    expect(snap5(s)).toEqual(before);
    expect(productsSnap(s)).toBe(stock);
    for (const i of sale.items) expect(returnedQty(s, i.id)).toBe(0);
    await reconOk(s);
  };

  it('cash refund insert fails (after movement, loss and counters were written) -> everything rolled back; retry works', async () => {
    quiet();
    const { s, sale, req } = await twoLines();
    const before = snap5(s); const stock = productsSnap(s);
    breakCash(s.ctx, 'sale_refund');
    const r = await returnNew(s, sale.id, req, { clientRef: 'ret-atomic-001' });
    expect(r.status).toBe(500);
    await expectNothing(s, before, stock, sale);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_cash');
    expect((await returnNew(s, sale.id, req, { clientRef: 'ret-atomic-001' })).status).toBe(201);
    await reconOk(s);
  });

  it('the loss insert of a damaged line fails after the restock movement of an earlier line -> the movement is rolled back too', async () => {
    quiet();
    const { s, sale, req } = await twoLines();
    const before = snap5(s); const stock = productsSnap(s);
    breakLoss(s.ctx);
    const r = await returnNew(s, sale.id, req);
    expect(r.status).toBe(500);
    await expectNothing(s, before, stock, sale);
  });

  it('audit insert fails -> no return, lines, counters, movements, loss or refund', async () => {
    quiet();
    const { s, sale, req } = await twoLines();
    const before = snap5(s); const stock = productsSnap(s);
    breakAudit(s.ctx, 'sale_return');
    const r = await returnNew(s, sale.id, req);
    expect(r.status).toBe(500);
    await expectNothing(s, before, stock, sale);
    expect(err(r).code).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================================
// Audit.
describe('return audit', () => {
  it('one audit row per return: entity sale_return, action create, after = the return; business date stored', async () => {
    const { s, sale, item } = await saleFx(2, 100000);
    const r = await returnOk(s, sale.id, [rl(item.id, 1, true)]);
    const rowsA = auditRows(s.ctx, 'sale_return');
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({ entity: 'sale_return', entityId: String(r.item.id), action: 'create', before: null });
    expect(rowsA[0]!.after).toEqual(r.item);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'sale_return'")).toEqual([{ business_date: today(), backdated: 0 }]);
    // the sale's own create row is untouched (no 'update' rows for a return)
    expect(auditRows(s.ctx, 'sale').map((a) => a.action)).toEqual(['create']);
  });
});
