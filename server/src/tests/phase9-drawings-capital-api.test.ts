// Phase 9 cash drawings and capital API (BUSINESS_RULES sections 8, 9, 10.2, 10.4, 10.7, 12; R1, R9, R13, R-FD). Protects:
//   - a CASH drawing is money out of the chosen book (type drawing_cash, negative), never an expense and never part of P&L;
//     Ice Cream names the fund the money leaves and writes the matching fund row; the other books refuse a fund;
//   - amount >= 1 (schema and database), R-FD, DAY_CLOSED for create and void, warnings for a negative book / fund (never a block),
//     void = reversal (balances return exactly, twice is 409), duplicate clientRef writes once, audit with business date + backdated;
//   - GET /drawings lists both kinds with totals split into goods (stock cost) and cash; goods drawings are untouched by Phase 9;
//   - capital is cash IN (type capital) in the chosen book/fund, NEVER revenue or profit; list filters kind = capital | opening_balance | all;
//     it is voided through the Phase 8 endpoint POST /capital-entries/:id/void;
//   - Cost + Electricity + Profit = the Ice Cream book after every Ice Cream write (10.1) and Σ fund rows = Σ Ice Cream cash rows (10.7).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, daysAhead, mkProduct, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, drawNew, err, num, sql } from './helpers/phase4.ts';
import { bookBal, capVoid, closeNew, closeOk, openNew, reopenNew, snap8 } from './helpers/phase8.ts';
import { CAPITAL_KEYS, capNew, drawCash, iceInvariant, legsOf, pnlSnapshot, seedBooks, state } from './helpers/phase9.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const DRAWING_KEYS = ['amountCents', 'backdated', 'book', 'businessDate', 'clientRef', 'fund', 'id', 'kind', 'note', 'postedAt', 'productId',
  'productName', 'qty', 'status', 'voidReason', 'voidedAt'];

describe('POST /drawings kind cash', () => {
  it('201 exact shape; money out of the Shop book as drawing_cash; no expense row, no stock movement; audit with business date', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 100000 }); // Rs 1,000.00
    const r = await drawCash(s, { amountCents: 30000, note: '  groceries ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['item', 'warnings']);
    expect(r.body.warnings).toEqual([]);
    const it = r.body.item;
    expect(Object.keys(it).sort()).toEqual(DRAWING_KEYS);
    expect(it).toMatchObject({ kind: 'cash', book: 'shop', fund: null, amountCents: 30000, note: 'groceries', productId: null, productName: null, qty: null,
      status: 'posted', backdated: false, businessDate: today() });
    const cash = sql(s, "SELECT * FROM cash_entries WHERE ref_table = 'owner_drawings' AND ref_id = ?", it.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'drawing_cash', amount_cents: -30000, fund: null, transfer_id: null, reverses_entry_id: null });
    expect(bookBal(s, 'shop')).toBe(70000); // 100,000 - 30,000
    expect(num(s, 'SELECT COUNT(*) FROM expenses')).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(0);
    expect(auditRows(s.ctx, 'drawing')[0]).toMatchObject({ action: 'create', before: null });
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'drawing'")[0]).toMatchObject({ business_date: today(), backdated: 0 });
    expect((await get(s.app, `/drawings/${it.id}`)).body.item).toEqual(it);
  });

  it('Telecom drawing leaves only the Telecom book; backdated drawing is dated and flagged', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 50000, telecom: 80000 }, daysAgo(6));
    const d = daysAgo(2);
    const r = await drawCash(s, { book: 'telecom', amountCents: 12500, businessDate: d });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ book: 'telecom', backdated: true, businessDate: d });
    expect(state(s)).toMatchObject({ shop: 50000, telecom: 67500 });
    expect(sql(s, "SELECT business_date FROM cash_entries WHERE type = 'drawing_cash'")).toEqual([{ business_date: d }]);
  });

  // Ice Cream start: cost 30,000; electricity 20,000; profit 10,000 (book 60,000). Drawing 4,000 from profit -> profit 6,000, book 56,000.
  it('Ice Cream: the fund row is written (kind drawing); only that fund drops; Cost + Electricity + Profit = the book', async () => {
    const s = await setup();
    await seedBooks(s, { cost: 30000, electricity: 20000, profit: 10000 });
    const r = await drawCash(s, { book: 'icecream', fund: 'profit', amountCents: 4000 });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ book: 'icecream', fund: 'profit', amountCents: 4000 });
    expect(state(s)).toMatchObject({ icecream: 56000, cost: 30000, electricity: 20000, profit: 6000 });
    expect(sql(s, "SELECT fund, amount_cents, kind FROM icecream_fund_entries WHERE ref_table = 'owner_drawings'")).toEqual([{ fund: 'profit', amount_cents: -4000, kind: 'drawing' }]);
    expect(sql(s, "SELECT fund FROM cash_entries WHERE type = 'drawing_cash'")).toEqual([{ fund: 'profit' }]);
    const i = iceInvariant(s);
    expect([i.funds, i.book, i.fundRows, i.cashRows]).toEqual([56000, 56000, 56000, 56000]);
  });

  it('FUND_REQUIRED for Ice Cream, FUND_NOT_ALLOWED for the other books (field fund); nothing written', async () => {
    const s = await setup();
    const before = snap8(s);
    const a = await drawCash(s, { book: 'icecream' });
    expect(a.status).toBe(400);
    expect(err(a)).toMatchObject({ code: 'FUND_REQUIRED', fields: { fund: expect.any(String) } });
    for (const book of ['shop', 'telecom']) {
      const b = await drawCash(s, { book, fund: 'cost' });
      expect(err(b)).toMatchObject({ code: 'FUND_NOT_ALLOWED', fields: { fund: expect.any(String) } });
    }
    expect(snap8(s)).toEqual(before);
  });

  it('schema: amount >= 1 integer (0 and negatives refused), book enum, missing book/amount named, unknown fields, R-FD, note length', async () => {
    const s = await setup();
    const before = snap8(s);
    for (const a of [0, -1, 1.5, '100', null, 1000000000001]) {
      const r = await drawCash(s, { amountCents: a });
      expect(r.status, JSON.stringify(a)).toBe(400);
      expect(err(r).fields.amountCents, JSON.stringify(a)).toBeTruthy();
    }
    expect(err(await drawCash(s, { book: 'warehouse' })).fields.book).toBeTruthy();
    const noBook = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), amountCents: 5, clientRef: ref() });
    expect(Object.keys(err(noBook).fields)).toEqual(['book']);
    const noAmount = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), book: 'shop', clientRef: ref() });
    expect(Object.keys(err(noAmount).fields)).toEqual(['amountCents']);
    expect(err(await drawCash(s, { postedAt: 'x' })).fields.postedAt).toBeTruthy();
    expect((await drawCash(s, { note: 'n'.repeat(501) })).status).toBe(400);
    const fut = await drawCash(s, { businessDate: daysAhead(1) });
    expect(err(fut)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect(snap8(s)).toEqual(before);
    expect((await drawCash(s, { amountCents: 1 })).status).toBe(201); // the smallest drawing is 1 cent
    expect((await drawCash(s, { amountCents: 1000000000000 })).status).toBe(201);
  });

  it('R13 warnings, never blocks: empty Shop -> NEGATIVE_CASH_BALANCE; Ice Cream fund below zero while the book is positive -> NEGATIVE_FUND_BALANCE only', async () => {
    const s = await setup();
    const a = await drawCash(s, { amountCents: 2500 });
    expect(a.status).toBe(201);
    expect(a.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -2500 })]);
    await seedBooks(s, { cost: 3000, profit: 9000 }); // book 12,000
    const b = await drawCash(s, { book: 'icecream', fund: 'cost', amountCents: 5000 }); // cost -2,000; book 7,000
    expect(b.status).toBe(201);
    expect(b.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_FUND_BALANCE', fund: 'cost', balanceCents: -2000 })]);
    expect(state(s)).toMatchObject({ shop: -2500, icecream: 7000, cost: -2000, profit: 9000 });
  });

  it('duplicate clientRef -> 200 with the saved drawing, ONE cash row; a ref already used by another kind/book is 409 CLIENT_REF_CONFLICT', async () => {
    const s = await setup();
    const clientRef = ref();
    const a = await drawCash(s, { clientRef, amountCents: 700 });
    const b = await drawCash(s, { clientRef, amountCents: 700 });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item).toEqual(a.body.item);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'drawing_cash'")).toBe(1);
    const rs = await Promise.all([1, 2, 3].map(() => drawCash(s, { clientRef: ref().replace(/^ref/, 'par'), amountCents: 1 })));
    expect(rs.every((x) => x.status === 201)).toBe(true);
    const conflict = await drawCash(s, { clientRef, book: 'telecom' });
    expect(conflict.status).toBe(409);
    expect(err(conflict).code).toBe('CLIENT_REF_CONFLICT');
  });

  it('DAY_CLOSED: create refused when that book/date is closed (only that book); void refused too; works after a reopen', async () => {
    const s = await setup();
    const d = daysAgo(1);
    const t = (await drawCash(s, { businessDate: d, amountCents: 900 })).body.item;
    const c = await closeOk(s, 'shop', d);
    const before = snap8(s);
    const refused = await drawCash(s, { businessDate: d });
    expect(refused.status).toBe(409);
    expect(err(refused)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: d });
    const v = await post(s.app, `/drawings/${t.id}/void`, { reason: 'x' });
    expect(err(v)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: d });
    expect(snap8(s)).toEqual(before);
    expect((await drawCash(s, { businessDate: d, book: 'telecom' })).status).toBe(201); // another book is open
    expect((await reopenNew(s, c.id)).status).toBe(200);
    expect((await post(s.app, `/drawings/${t.id}/void`, { reason: 'x' })).status).toBe(200);
    expect((await drawCash(s, { businessDate: d })).status).toBe(201);
  });

  it('void = reversal: balance and fund return exactly, reversal row copies book/fund/date and points at the original; void twice 409', async () => {
    const s = await setup();
    const d = daysAgo(3);
    await seedBooks(s, { cost: 40000, electricity: 10000, profit: 5000 }, daysAgo(6));
    const pre = state(s);
    const t = (await drawCash(s, { book: 'icecream', fund: 'electricity', amountCents: 7500, businessDate: d })).body.item;
    expect(state(s)).toMatchObject({ icecream: 55000 - 7500, electricity: 2500 });
    const v = await post(s.app, `/drawings/${t.id}/void`, { reason: ' wrong amount ' });
    expect(v.status).toBe(200);
    expect(v.body.item).toMatchObject({ status: 'void', voidReason: 'wrong amount', amountCents: 7500, businessDate: d });
    expect(state(s)).toEqual(pre);
    const rows = sql(s, "SELECT * FROM cash_entries WHERE ref_table = 'owner_drawings' ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'drawing_cash', amount_cents: 7500, book: 'icecream', fund: 'electricity', business_date: d, reverses_entry_id: rows[0]!.id });
    const f = sql(s, "SELECT amount_cents, kind FROM icecream_fund_entries WHERE ref_table = 'owner_drawings' ORDER BY id");
    expect(f).toEqual([{ amount_cents: -7500, kind: 'drawing' }, { amount_cents: 7500, kind: 'reversal' }]);
    const i = iceInvariant(s);
    expect(i.funds).toBe(i.book);
    expect(i.fundRows).toBe(i.cashRows);
    const again = await post(s.app, `/drawings/${t.id}/void`, { reason: 'x' });
    expect([again.status, err(again).code]).toEqual([409, 'ALREADY_VOID']);
    expect(auditRows(s.ctx, 'drawing').map((a) => a.action)).toEqual(['create', 'void']);
  });

  it('a cash drawing changes no profit-relevant table: not an expense, not stock, not revenue', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 100000, cost: 1000 });
    const before = pnlSnapshot(s);
    const a = await drawCash(s, { amountCents: 500 });
    await drawCash(s, { book: 'icecream', fund: 'cost', amountCents: 500 });
    await post(s.app, `/drawings/${a.body.item.id}/void`, { reason: 'undo' });
    expect(pnlSnapshot(s)).toEqual(before);
  });

  it('one transaction: a failing audit row / second ledger row leaves no drawing and no cash row', async () => {
    quiet();
    const s = await setup();
    const before = snap8(s);
    breakAudit(s.ctx, 'drawing');
    expect((await drawCash(s, { book: 'icecream', fund: 'cost' })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_fund BEFORE INSERT ON icecream_fund_entries WHEN NEW.kind = 'drawing' BEGIN SELECT RAISE(ABORT, 'fund boom'); END`);
    expect((await drawCash(s, { book: 'icecream', fund: 'cost' })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
  });
});

describe('GET /drawings with both kinds', () => {
  it('lists goods and cash together; totals split: goods = stock cost removed, cash = money out; voided rows are listed but not summed', async () => {
    const s = await setup();
    const p = await mkProduct(s, { sellPriceCents: 50000, minPriceCents: 1000 });
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 100000 }]); // 10 units at 10,000 each
    await seedBooks(s, { shop: 500000, cost: 90000 });
    const g = await drawNew(s, p.id, 2); // 2 x 10,000 = 20,000
    expect(g.status).toBe(201);
    expect(g.body.item).toMatchObject({ kind: 'goods', amountCents: 20000, fund: null });
    const c1 = (await drawCash(s, { amountCents: 30000 })).body.item;
    const c2 = (await drawCash(s, { book: 'icecream', fund: 'cost', amountCents: 5000 })).body.item;
    const c3 = (await drawCash(s, { amountCents: 777 })).body.item;
    await post(s.app, `/drawings/${c3.id}/void`, { reason: 'oops' });
    const all = (await get(s.app, '/drawings')).body;
    expect(all.total).toBe(4);
    expect(all.totals).toEqual({ amountCents: 55000, goodsCents: 20000, cashCents: 35000 }); // 20,000 + 30,000 + 5,000; the voided 777 is excluded
    expect(all.totalAmountCents).toBe(55000);
    const cash = (await get(s.app, '/drawings?kind=cash')).body;
    expect(cash.items.map((i: any) => i.id)).toEqual([c3.id, c2.id, c1.id]);
    expect(cash.totals).toEqual({ amountCents: 35000, goodsCents: 0, cashCents: 35000 });
    expect((await get(s.app, '/drawings?kind=goods')).body.totals).toEqual({ amountCents: 20000, goodsCents: 20000, cashCents: 0 });
    const ice = (await get(s.app, '/drawings?book=icecream')).body;
    expect(ice.items.map((i: any) => [i.id, i.fund])).toEqual([[c2.id, 'cost']]);
    expect((await get(s.app, '/drawings?book=shop&kind=cash&status=posted')).body.totals.cashCents).toBe(30000);
    // the goods drawing is unchanged by Phase 9: stock out at cost, no cash row
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE ref_table = 'owner_drawings' AND ref_id = ?", g.body.item.id)).toBe(0);
  });
});

// ======================================================================================================
describe('POST /capital', () => {
  it('201 exact shape; cash IN of type capital in the chosen book; never revenue; audit with business date', async () => {
    const s = await setup();
    const before = pnlSnapshot(s);
    const r = await capNew(s, { amountCents: 250000, note: ' own savings ' }); // Rs 2,500.00
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['item', 'warnings']);
    expect(r.body.warnings).toEqual([]);
    expect(Object.keys(r.body.item).sort()).toEqual(CAPITAL_KEYS);
    expect(r.body.item).toMatchObject({ kind: 'capital', book: 'shop', fund: null, amountCents: 250000, note: 'own savings', status: 'posted', backdated: false });
    const cash = sql(s, "SELECT * FROM cash_entries WHERE ref_table = 'capital_entries'");
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'capital', amount_cents: 250000, fund: null });
    expect(bookBal(s, 'shop')).toBe(250000);
    expect(pnlSnapshot(s)).toEqual(before);
    expect(auditRows(s.ctx, 'capital_entry')[0]).toMatchObject({ action: 'create', before: null });
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'capital_entry'")[0]).toMatchObject({ business_date: today(), backdated: 0 });
    expect((await get(s.app, `/capital/${r.body.item.id}`)).body.item).toEqual(r.body.item);
  });

  // Ice Cream cost 10,000; electricity 0; profit 0. Capital 6,000 into Electricity and 2,500 into Profit.
  it('Ice Cream capital names its fund and writes the fund row (kind capital); the three funds always add up to the book', async () => {
    const s = await setup();
    await seedBooks(s, { cost: 10000 });
    expect((await capNew(s, { book: 'icecream', fund: 'electricity', amountCents: 6000 })).status).toBe(201);
    expect((await capNew(s, { book: 'icecream', fund: 'profit', amountCents: 2500 })).status).toBe(201);
    expect(state(s)).toMatchObject({ icecream: 18500, cost: 10000, electricity: 6000, profit: 2500 });
    expect(sql(s, "SELECT fund, amount_cents FROM icecream_fund_entries WHERE kind = 'capital' ORDER BY id")).toEqual([
      { fund: 'electricity', amount_cents: 6000 }, { fund: 'profit', amount_cents: 2500 },
    ]);
    const i = iceInvariant(s);
    expect([i.funds, i.book, i.fundRows, i.cashRows]).toEqual([18500, 18500, 18500, 18500]);
  });

  it('FUND_REQUIRED / FUND_NOT_ALLOWED, schema bounds, R-FD, unknown fields; nothing written', async () => {
    const s = await setup();
    const before = snap8(s);
    expect(err(await capNew(s, { book: 'icecream', fund: undefined, businessDate: today() })).code).toBe('FUND_REQUIRED');
    const b = await post(s.app, '/capital', { businessDate: today(), book: 'icecream', amountCents: 1, clientRef: ref() });
    expect(err(b)).toMatchObject({ code: 'FUND_REQUIRED', fields: { fund: expect.any(String) } });
    expect(err(await capNew(s, { book: 'shop', fund: 'cost' }))).toMatchObject({ code: 'FUND_NOT_ALLOWED', fields: { fund: expect.any(String) } });
    for (const a of [0, -3, 2.5, '5', null, 1000000000001]) expect((await capNew(s, { amountCents: a })).status, JSON.stringify(a)).toBe(400);
    expect(err(await capNew(s, { businessDate: daysAhead(1) }))).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect((await capNew(s, { kind: 'opening_balance' })).status).toBe(400); // the kind is not chosen by the caller
    expect((await capNew(s, { book: 'bank' })).status).toBe(400);
    expect((await capNew(s, { note: 'n'.repeat(501) })).status).toBe(400);
    expect(snap8(s)).toEqual(before);
  });

  it('a backdated capital entry is accepted and flagged; duplicate clientRef writes once; a ref used for an opening balance is 409 CLIENT_REF_CONFLICT', async () => {
    const s = await setup();
    const d = daysAgo(4);
    const clientRef = ref();
    const a = await capNew(s, { businessDate: d, clientRef });
    const b = await capNew(s, { businessDate: d, clientRef });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(a.body.item.backdated).toBe(true);
    expect(b.body.item).toEqual(a.body.item);
    expect(num(s, "SELECT COUNT(*) FROM capital_entries WHERE kind = 'capital'")).toBe(1);
    const o = (await openNew(s, 'telecom')).body.item;
    const c = await capNew(s, { clientRef: o.clientRef });
    expect([c.status, err(c).code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
    expect(num(s, "SELECT COUNT(*) FROM capital_entries")).toBe(2);
  });

  it('DAY_CLOSED: create refused on a closed day of that book (other books fine); works after a reopen', async () => {
    const s = await setup();
    const d = daysAgo(1);
    const c = await closeOk(s, 'icecream', d);
    const before = snap8(s);
    const r = await capNew(s, { book: 'icecream', fund: 'cost', businessDate: d });
    expect(err(r)).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream', businessDate: d });
    expect(snap8(s)).toEqual(before);
    expect((await capNew(s, { businessDate: d })).status).toBe(201);
    await reopenNew(s, c.id);
    expect((await capNew(s, { book: 'icecream', fund: 'cost', businessDate: d })).status).toBe(201);
  });

  it('void through POST /capital-entries/:id/void: balance and fund return exactly; day closed refuses; twice is 409; may warn if the money was spent', async () => {
    const s = await setup();
    const d = daysAgo(1);
    await seedBooks(s, { cost: 1000 }, daysAgo(5));
    const t = (await capNew(s, { book: 'icecream', fund: 'cost', amountCents: 4000, businessDate: d })).body.item;
    expect(state(s)).toMatchObject({ icecream: 5000, cost: 5000 });
    const c = await closeOk(s, 'icecream', d);
    expect(err(await capVoid(s, t.id)).code).toBe('DAY_CLOSED');
    await reopenNew(s, c.id);
    // the owner spends the money first: voiding the capital then leaves the fund negative -> a warning, not a block
    await drawCash(s, { book: 'icecream', fund: 'cost', amountCents: 3000 }); // cost 2,000
    const v = await capVoid(s, t.id);
    expect(v.status).toBe(200);
    expect(v.body.warnings.map((w: any) => w.code).sort()).toEqual(['NEGATIVE_CASH_BALANCE', 'NEGATIVE_FUND_BALANCE']);
    expect(state(s)).toMatchObject({ icecream: -2000, cost: -2000 }); // 1,000 + 4,000 - 3,000 - 4,000
    const i = iceInvariant(s);
    expect([i.funds, i.book, i.fundRows, i.cashRows]).toEqual([-2000, -2000, -2000, -2000]);
    expect((await capVoid(s, t.id)).status).toBe(409);
  });
});

describe('GET /capital', () => {
  it('kind filter capital | opening_balance | all (default all), book, dates, status, paging; totals count posted rows only', async () => {
    const s = await setup();
    const o1 = (await openNew(s, 'shop', { businessDate: daysAgo(9), amountCents: 100000 })).body.item;
    const o2 = (await openNew(s, 'icecream', { businessDate: daysAgo(9), fund: 'cost', amountCents: 40000 })).body.item;
    const c1 = (await capNew(s, { businessDate: daysAgo(5), amountCents: 20000 })).body.item;
    const c2 = (await capNew(s, { book: 'icecream', fund: 'profit', businessDate: daysAgo(2), amountCents: 3000 })).body.item;
    const c3 = (await capNew(s, { businessDate: daysAgo(1), amountCents: 999 })).body.item;
    await capVoid(s, c3.id);
    const q = async (qs: string) => (await get(s.app, `/capital?${qs}`)).body;
    let r = await q('');
    expect(r.items.map((i: any) => i.id)).toEqual([c3.id, c2.id, c1.id, o2.id, o1.id]); // newest date first; same date: newest id first
    expect(r.total).toBe(5);
    expect(r.totals.amountCents).toBe(100000 + 40000 + 20000 + 3000); // the voided 999 is excluded
    r = await q('kind=capital');
    expect(r.items.map((i: any) => i.id)).toEqual([c3.id, c2.id, c1.id]);
    expect(r.totals.amountCents).toBe(23000);
    r = await q('kind=opening_balance');
    expect(r.items.map((i: any) => i.id).sort()).toEqual([o1.id, o2.id].sort());
    expect(r.totals.amountCents).toBe(140000);
    expect((await q('kind=all')).total).toBe(5);
    r = await q('book=icecream');
    expect(r.items.map((i: any) => i.id)).toEqual([c2.id, o2.id]);
    r = await q(`from=${daysAgo(5)}&to=${daysAgo(2)}`);
    expect(r.items.map((i: any) => i.id)).toEqual([c2.id, c1.id]);
    r = await q('status=void');
    expect(r.items.map((i: any) => i.id)).toEqual([c3.id]);
    expect(r.totals.amountCents).toBe(0);
    r = await q('limit=2&offset=1');
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(5);
    for (const bad of ['kind=gift', 'book=bank', 'status=draft', 'limit=0', 'limit=201', 'from=2026-13-01', 'bogus=1']) {
      expect((await get(s.app, `/capital?${bad}`)).status, bad).toBe(400);
    }
    expect((await get(s.app, '/capital/99999')).status).toBe(404);
    expect((await get(s.app, '/capital/abc')).status).toBe(400);
  });

  it('capital is an entry in the cash book (type capital) and is not an opening balance: a posted opening balance may coexist (R: one per book/fund only)', async () => {
    const s = await setup();
    expect((await openNew(s, 'shop')).status).toBe(201);
    expect((await capNew(s)).status).toBe(201);
    expect((await capNew(s)).status).toBe(201); // capital can be added any number of times
    expect((await openNew(s, 'shop')).status).toBe(409); // the opening balance stays unique
    const items = (await get(s.app, '/cashbooks/shop')).body.items.map((i: any) => i.type);
    expect(items).toEqual(['opening_balance', 'capital', 'capital']);
  });
});

describe('transfers, drawings and capital together keep the books consistent', () => {
  it('legs of a transfer are not touched by drawings/capital; the grand total moves only by capital and drawings', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 100000, telecom: 50000, cost: 20000, electricity: 10000, profit: 5000 });
    expect((await capNew(s, { amountCents: 7000 })).status).toBe(201); // +7,000
    expect((await drawCash(s, { book: 'telecom', amountCents: 3000 })).status).toBe(201); // -3,000
    const t = await post(s.app, '/cash-transfers', { businessDate: today(), fromBook: 'shop', toBook: 'icecream', toFund: 'profit', amountCents: 9000, clientRef: ref() });
    expect(legsOf(s, t.body.item.id)).toHaveLength(2);
    const st = state(s);
    expect(st).toMatchObject({ shop: 100000 + 7000 - 9000, telecom: 47000, icecream: 35000 + 9000, profit: 5000 + 9000 });
    expect(st.shop + st.telecom + st.icecream).toBe(100000 + 50000 + 35000 + 7000 - 3000);
    await closeNew(s, 'shop', daysAgo(1));
  });
});
