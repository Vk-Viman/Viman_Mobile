// Phase 8 cash books API: ledger with running balance, opening balances, cash counts (expected / difference / over-short), daily
// closings and the shared negative-cash warning (BUSINESS_RULES sections 8, 9, 10.1, 10.2, 12; C4, R1, R6, R9, R13, R-FD). Protects:
//   - closing = opening + in - out; the running balance of every row carries across pages; period opening = ledger before `from`;
//   - one posted opening balance per book (per fund for Ice Cream), FUND_REQUIRED / FUND_NOT_ALLOWED, void + re-enter;
//   - a count: expected = balance as of the END of its business date, difference = counted - expected, a non-zero difference needs a
//     note and posts ONE cash_adjustment dated the count's date (Ice Cream: names a fund and writes the matching fund row);
//   - closing posts its own adjustment first, then marks the day closed; reopen needs a reason; a closed day answers DAY_ALREADY_CLOSED;
//   - Cost + Electricity + Profit = the Ice Cream cash book after every operation (10.1).
// All expected numbers below are calculated by hand in the comments (cents).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, mkProduct, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, err, num, sql } from './helpers/phase4.ts';
import { returnOk, sellOne, stocked } from './helpers/phase5.ts';
import { psNew, supNew } from './helpers/phase7.ts';
import {
  CLOSING_KEYS, COUNT_KEYS, bookBal, capVoid, cashOfRef, closeNew, closeOk, countNew, countVoid, expNew, fundBal, fundOfRef, ledgerGet,
  openNew, reopenNew, snap8,
} from './helpers/phase8.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/**
 * The shop fixture used by the ledger and count tests (hand-calculated):
 *   d5 opening +1,000,000 | d4 rent -250,000 | d3 supplies -75,500 then print sale 10 x 1,500 = +15,000 | d2 water -10,000
 *   balance = 1,000,000 - 250,000 - 75,500 + 15,000 - 10,000 = 679,500
 */
async function shopFixture(s: ApiBase): Promise<void> {
  expect((await openNew(s, 'shop', { businessDate: daysAgo(5), amountCents: 1000000 })).status).toBe(201);
  expect((await expNew(s, { businessDate: daysAgo(4), category: 'rent', amountCents: 250000 })).status).toBe(201);
  expect((await supNew(s, { businessDate: daysAgo(3), amountCents: 75500 })).status).toBe(201);
  expect((await psNew(s, { businessDate: daysAgo(3), qty: 10 })).status).toBe(201);
  expect((await expNew(s, { businessDate: daysAgo(2), category: 'water', amountCents: 10000 })).status).toBe(201);
}

// =============================================================================================
describe('GET /cashbooks/:book - ledger, running balance, opening / in / out / closing', () => {
  it('no period: opening 0, closing = opening + in - out = the all-time balance; rows in business-date then id order with running balances', async () => {
    const s = await setup();
    await shopFixture(s);
    const r = await ledgerGet(s, 'shop');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ book: 'shop', from: null, to: null, openingCents: 0, inCents: 1015000, outCents: 335500, closingCents: 679500, total: 5 });
    expect(r.body.items.map((i: any) => [i.businessDate, i.type, i.amountCents, i.runningBalanceCents])).toEqual([
      [daysAgo(5), 'opening_balance', 1000000, 1000000],
      [daysAgo(4), 'expense', -250000, 750000],
      [daysAgo(3), 'printing_supplies', -75500, 674500],
      [daysAgo(3), 'sale_service', 15000, 689500],
      [daysAgo(2), 'expense', -10000, 679500],
    ]);
    expect(r.body.closedDates).toEqual([]);
    expect(r.body.funds).toBeUndefined();
    expect(Object.keys(r.body.items[0]).sort()).toEqual(['amountCents', 'businessDate', 'fund', 'id', 'note', 'postedAt', 'refId', 'refTable',
      'reversesEntryId', 'runningBalanceCents', 'type']);
    expect(r.body.closingCents).toBe(bookBal(s, 'shop'));
  });

  it('period from d4 to d3: opening = everything before d4; closing = opening + in - out; running balance starts from the opening', async () => {
    const s = await setup();
    await shopFixture(s);
    const r = await ledgerGet(s, 'shop', `?from=${daysAgo(4)}&to=${daysAgo(3)}`);
    // opening = 1,000,000 (the d5 opening balance); in = 15,000; out = 250,000 + 75,500 = 325,500; closing = 1,000,000 + 15,000 - 325,500 = 689,500
    expect(r.body).toMatchObject({ openingCents: 1000000, inCents: 15000, outCents: 325500, closingCents: 689500, total: 3, from: daysAgo(4), to: daysAgo(3) });
    expect(r.body.items.map((i: any) => i.runningBalanceCents)).toEqual([750000, 674500, 689500]);
    const later = await ledgerGet(s, 'shop', `?from=${daysAgo(2)}`);
    // opening = 689,500; one row -10,000 -> closing 679,500
    expect(later.body).toMatchObject({ openingCents: 689500, inCents: 0, outCents: 10000, closingCents: 679500, total: 1 });
    const empty = await ledgerGet(s, 'shop', `?from=${daysAgo(1)}`);
    expect(empty.body).toMatchObject({ openingCents: 679500, inCents: 0, outCents: 0, closingCents: 679500, total: 0, items: [] });
  });

  it('the running balance is carried correctly across pages (limit 2 over the 5 rows)', async () => {
    const s = await setup();
    await shopFixture(s);
    const p0 = (await ledgerGet(s, 'shop', '?limit=2&offset=0')).body;
    const p1 = (await ledgerGet(s, 'shop', '?limit=2&offset=2')).body;
    const p2 = (await ledgerGet(s, 'shop', '?limit=2&offset=4')).body;
    expect(p0.items.map((i: any) => i.runningBalanceCents)).toEqual([1000000, 750000]);
    expect(p1.items.map((i: any) => i.runningBalanceCents)).toEqual([674500, 689500]);
    expect(p2.items.map((i: any) => i.runningBalanceCents)).toEqual([679500]);
    for (const p of [p0, p1, p2]) expect(p).toMatchObject({ total: 5, openingCents: 0, closingCents: 679500 });
    // the same with a period: the page after the first row still starts from the period's opening balance
    const q = (await ledgerGet(s, 'shop', `?from=${daysAgo(4)}&limit=1&offset=1`)).body;
    expect(q.openingCents).toBe(1000000);
    expect(q.items.map((i: any) => i.runningBalanceCents)).toEqual([674500]); // 1,000,000 - 250,000 - 75,500
  });

  it('a void adds a reversal row dated like the original; both stay in the ledger and the running balance nets to zero', async () => {
    const s = await setup();
    const e = (await expNew(s, { businessDate: daysAgo(2), amountCents: 40000 })).body.item;
    await post(s.app, `/expenses/${e.id}/void`, { reason: 'x' });
    const r = (await ledgerGet(s, 'shop')).body;
    expect(r.items.map((i: any) => [i.businessDate, i.amountCents, i.runningBalanceCents, i.reversesEntryId !== null])).toEqual([
      [daysAgo(2), -40000, -40000, false], [daysAgo(2), 40000, 0, true],
    ]);
    expect(r).toMatchObject({ inCents: 40000, outCents: 40000, closingCents: 0 });
  });

  it('books are separate; validation: unknown book 400, from after to 400, impossible date 400, paging limits', async () => {
    const s = await setup();
    await shopFixture(s);
    expect((await ledgerGet(s, 'telecom')).body).toMatchObject({ total: 0, closingCents: 0, items: [] });
    expect((await ledgerGet(s, 'warehouse' as any)).status).toBe(400);
    expect((await ledgerGet(s, 'shop', `?from=${today()}&to=${daysAgo(1)}`)).status).toBe(400);
    expect((await ledgerGet(s, 'shop', '?from=2026-13-01')).status).toBe(400);
    expect((await ledgerGet(s, 'shop', '?limit=0')).status).toBe(400);
    expect((await ledgerGet(s, 'shop', '?limit=201')).status).toBe(400);
    expect((await ledgerGet(s, 'shop', '?foo=1')).status).toBe(400);
    // a date after today is a REPORT date: never rejected, simply shows the same figures
    const f = await ledgerGet(s, 'shop', `?to=${daysAhead(30)}`);
    expect(f.status).toBe(200);
    expect(f.body.closingCents).toBe(679500);
  });

  it('closedDates lists the days closed inside the period (reopened days drop out)', async () => {
    const s = await setup();
    await shopFixture(s);
    const c4 = await closeOk(s, 'shop', daysAgo(4));
    await closeOk(s, 'shop', daysAgo(3));
    await closeOk(s, 'telecom', daysAgo(3));
    expect((await ledgerGet(s, 'shop')).body.closedDates).toEqual([daysAgo(4), daysAgo(3)]);
    expect((await ledgerGet(s, 'shop', `?from=${daysAgo(3)}`)).body.closedDates).toEqual([daysAgo(3)]);
    expect((await ledgerGet(s, 'telecom')).body.closedDates).toEqual([daysAgo(3)]);
    await reopenNew(s, c4.id);
    expect((await ledgerGet(s, 'shop')).body.closedDates).toEqual([daysAgo(3)]);
  });
});

// =============================================================================================
describe('GET /cashbooks - balances and warnings', () => {
  it('lists the three books with all-time balances; only Ice Cream carries funds; lastClosedDate is the newest closed day', async () => {
    const s = await setup();
    await shopFixture(s);
    await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000 });
    await openNew(s, 'icecream', { fund: 'profit', amountCents: 200000 });
    await closeOk(s, 'shop', daysAgo(4));
    const r = await get(s.app, '/cashbooks');
    expect(r.status).toBe(200);
    expect(r.body.books.map((b: any) => b.book)).toEqual(['shop', 'telecom', 'icecream']);
    expect(r.body.books[0]).toEqual({ book: 'shop', balanceCents: 679500, lastClosedDate: daysAgo(4) });
    expect(r.body.books[1]).toEqual({ book: 'telecom', balanceCents: 0, lastClosedDate: null });
    expect(r.body.books[2]).toEqual({ book: 'icecream', balanceCents: 700000, funds: { cost: 500000, electricity: 0, profit: 200000 }, lastClosedDate: null });
    expect(r.body.warnings).toEqual([]);
  });

  it('warns (never blocks) about a negative book', async () => {
    const s = await setup();
    await expNew(s, { amountCents: 12345 });
    const r = await get(s.app, '/cashbooks');
    expect(r.body.books[0].balanceCents).toBe(-12345);
    expect(r.body.warnings).toEqual([{
      code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -12345,
      message: 'The Shop cash book is now below zero (-Rs. 123.45). Check that the opening balance and sales are recorded.',
    }]);
  });

  it('warns if the Ice Cream funds ever disagree with the Ice Cream book (a cash row without its fund row)', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000 });
    // simulate a bug: an Ice Cream cash entry written WITHOUT its fund row (the service never does this)
    s.ctx.database.conn.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, fund) VALUES ('icecream', ?, 'icecream_other_cost', -700, 'cost')").run(today());
    const r = await get(s.app, '/cashbooks');
    expect(r.body.warnings).toEqual([{
      code: 'ICECREAM_FUNDS_MISMATCH', book: 'icecream', balanceCents: -700,
      message: 'The Ice Cream funds (Rs. 5,000.00) do not add up to the Ice Cream cash book (Rs. 4,993.00). Please contact support.',
    }]);
  });
});

// =============================================================================================
describe('opening balances', () => {
  it('shop: cash IN opening_balance (no fund), audited; second posted opening for the book is 409 OPENING_BALANCE_EXISTS', async () => {
    const s = await setup();
    const r = await openNew(s, 'shop', { amountCents: 1234500, note: 'drawer at go-live' });
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([]);
    expect(r.body.item).toMatchObject({ book: 'shop', fund: null, kind: 'opening_balance', amountCents: 1234500, status: 'posted', note: 'drawer at go-live', backdated: false });
    expect(cashOfRef(s, 'capital_entries', r.body.item.id)).toHaveLength(1);
    expect(cashOfRef(s, 'capital_entries', r.body.item.id)[0]).toMatchObject({ book: 'shop', type: 'opening_balance', amount_cents: 1234500, fund: null });
    expect(bookBal(s, 'shop')).toBe(1234500);
    expect(auditRows(s.ctx, 'capital_entry').map((a) => a.action)).toEqual(['create']);
    const dup = await openNew(s, 'shop');
    expect(dup.status).toBe(409);
    expect(err(dup).code).toBe('OPENING_BALANCE_EXISTS');
    expect(num(s, 'SELECT COUNT(*) FROM capital_entries')).toBe(1);
    expect(bookBal(s, 'shop')).toBe(1234500);
    // other books are independent
    expect((await openNew(s, 'telecom')).status).toBe(201);
  });

  it('fund rule: Ice Cream requires a fund (FUND_REQUIRED), the other books forbid one (FUND_NOT_ALLOWED); nothing written', async () => {
    const s = await setup();
    const before = snap8(s);
    const a = await post(s.app, '/cashbooks/icecream/opening', { businessDate: today(), amountCents: 100, clientRef: ref() });
    expect(a.status).toBe(400);
    expect(err(a)).toMatchObject({ code: 'FUND_REQUIRED', fields: { fund: expect.any(String) } });
    const b = await openNew(s, 'shop', { fund: 'cost' });
    expect(b.status).toBe(400);
    expect(err(b)).toMatchObject({ code: 'FUND_NOT_ALLOWED', fields: { fund: expect.any(String) } });
    expect((await openNew(s, 'icecream', { fund: 'loans' })).status).toBe(400);
    expect(snap8(s)).toEqual(before);
  });

  it('Ice Cream: one opening per FUND; cash entry AND fund row of the same amount are written together (never profit-eligible, never revenue)', async () => {
    const s = await setup();
    const cost = (await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000 })).body.item;
    expect(cashOfRef(s, 'capital_entries', cost.id)[0]).toMatchObject({ book: 'icecream', type: 'opening_balance', amount_cents: 500000, fund: 'cost' });
    expect(fundOfRef(s, 'capital_entries', cost.id)[0]).toMatchObject({ fund: 'cost', amount_cents: 500000, kind: 'opening_balance' });
    expect((await openNew(s, 'icecream', { fund: 'profit', amountCents: 200000 })).status).toBe(201);
    expect((await openNew(s, 'icecream', { fund: 'electricity', amountCents: 100000 })).status).toBe(201);
    const dup = await openNew(s, 'icecream', { fund: 'cost', amountCents: 1 });
    expect(dup.status).toBe(409);
    expect(err(dup).code).toBe('OPENING_BALANCE_EXISTS');
    expect(fundBal(s)).toEqual({ cost: 500000, electricity: 100000, profit: 200000 });
    expect(bookBal(s, 'icecream')).toBe(800000); // 500,000 + 100,000 + 200,000
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'capital_entry'")[0]!.n).toBe(3);
  });

  it('may be backdated (go-live date, flagged); a future date is 400 FUTURE_DATE_NOT_ALLOWED', async () => {
    const s = await setup();
    const f = await openNew(s, 'shop', { businessDate: daysAhead(1) });
    expect(f.status).toBe(400);
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    const r = await openNew(s, 'shop', { businessDate: daysAgo(30) });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ backdated: true, businessDate: daysAgo(30) });
    expect(sql(s, "SELECT backdated FROM audit_logs WHERE entity = 'capital_entry'")[0]!.backdated).toBe(1);
    expect((await openNew(s, 'telecom', { amountCents: 0 })).status).toBe(400);
    expect((await openNew(s, 'telecom', { amountCents: 1.5 })).status).toBe(400);
  });

  it('duplicate submission: same clientRef returns the first entry (200); the same clientRef for another book is 409 CLIENT_REF_CONFLICT', async () => {
    const s = await setup();
    const clientRef = ref();
    const a = await openNew(s, 'shop', { clientRef });
    const b = await openNew(s, 'shop', { clientRef });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item).toEqual(a.body.item);
    expect(num(s, 'SELECT COUNT(*) FROM capital_entries')).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'opening_balance'")).toBe(1);
    const c = await openNew(s, 'telecom', { clientRef });
    expect(c.status).toBe(409);
    expect(err(c).code).toBe('CLIENT_REF_CONFLICT');
  });

  it('void = reversal rows (cash and, for Ice Cream, fund), status void; the slot is free again and the opening can be re-entered', async () => {
    const s = await setup();
    const o = (await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000 })).body.item;
    const v = await capVoid(s, o.id, 'typed the wrong amount');
    expect(v.status).toBe(200);
    expect(v.body.item).toMatchObject({ status: 'void', voidReason: 'typed the wrong amount' });
    expect(v.body.warnings).toEqual([]);
    expect(cashOfRef(s, 'capital_entries', o.id).map((c) => c.amount_cents)).toEqual([500000, -500000]);
    expect(cashOfRef(s, 'capital_entries', o.id)[1]).toMatchObject({ fund: 'cost', type: 'opening_balance' });
    expect(fundOfRef(s, 'capital_entries', o.id).map((f) => [f.amount_cents, f.kind])).toEqual([[500000, 'opening_balance'], [-500000, 'reversal']]);
    expect(fundOfRef(s, 'capital_entries', o.id)[1]!.reverses_entry_id).toBe(fundOfRef(s, 'capital_entries', o.id)[0]!.id);
    expect(bookBal(s, 'icecream')).toBe(0);
    expect(fundBal(s)).toEqual({ cost: 0, electricity: 0, profit: 0 });
    expect((await capVoid(s, o.id)).status).toBe(409); // ALREADY_VOID
    const again = await openNew(s, 'icecream', { fund: 'cost', amountCents: 450000 });
    expect(again.status).toBe(201);
    expect(bookBal(s, 'icecream')).toBe(450000);
    expect(auditRows(s.ctx, 'capital_entry').map((a) => a.action)).toEqual(['create', 'void', 'create']);
    const list = (await get(s.app, '/cashbooks/icecream/opening')).body.items;
    expect(list.map((i: any) => i.status)).toEqual(['void', 'posted']);
  });

  it('voiding an opening balance that other spending depends on returns the negative-cash warning (saved anyway)', async () => {
    const s = await setup();
    const o = (await openNew(s, 'shop', { amountCents: 100000 })).body.item;
    await expNew(s, { amountCents: 60000 });
    const v = await capVoid(s, o.id);
    expect(v.status).toBe(200);
    expect(v.body.warnings).toEqual([{
      code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -60000,
      message: 'The Shop cash book is now below zero (-Rs. 600.00). Check that the opening balance and sales are recorded.',
    }]);
  });
});

// =============================================================================================
describe('cash counts - expected, difference, over/short (C4, R6)', () => {
  it('expected is the balance as of the END of the count date; a matching count posts no cash entry and needs no note', async () => {
    const s = await setup();
    await shopFixture(s);
    // balance as of d5 = 1,000,000; d4 = 750,000; d3 = 750,000 - 75,500 + 15,000 = 689,500; today = 679,500
    const exp = async (d: string) => (await get(s.app, `/cash-counts/expected?book=shop&businessDate=${d}`)).body.expectedCents;
    expect([await exp(daysAgo(5)), await exp(daysAgo(4)), await exp(daysAgo(3)), await exp(daysAgo(2)), await exp(today())])
      .toEqual([1000000, 750000, 689500, 679500, 679500]);
    const r = await countNew(s, 'shop', 689500, { businessDate: daysAgo(3) });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.item).sort()).toEqual(COUNT_KEYS);
    expect(r.body.item).toMatchObject({ expectedCents: 689500, countedCents: 689500, differenceCents: 0, cashEntryId: null, fund: null, status: 'posted', backdated: true, note: '' });
    expect(r.body.warnings).toEqual([]);
    expect(cashOfRef(s, 'cash_counts', r.body.item.id)).toHaveLength(0);
    expect(bookBal(s, 'shop')).toBe(679500);
    expect(auditRows(s.ctx, 'cash_count').map((a) => a.action)).toEqual(['create']);
  });

  it('SHORT: counted 689,000 vs expected 689,500 -> difference -500, a note is required, ONE cash_adjustment -500 dated the count date', async () => {
    const s = await setup();
    await shopFixture(s);
    const before = snap8(s);
    const noNote = await countNew(s, 'shop', 689000, { businessDate: daysAgo(3) });
    expect(noNote.status).toBe(400);
    expect(err(noNote)).toMatchObject({ code: 'NOTE_REQUIRED', fields: { note: expect.any(String) } });
    expect((await countNew(s, 'shop', 689000, { businessDate: daysAgo(3), note: '   ' })).status).toBe(400);
    expect(snap8(s)).toEqual(before); // nothing saved by the refused attempts
    const r = await countNew(s, 'shop', 689000, { businessDate: daysAgo(3), note: 'coins missing' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ expectedCents: 689500, countedCents: 689000, differenceCents: -500, note: 'coins missing' });
    const cash = cashOfRef(s, 'cash_counts', r.body.item.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'cash_adjustment', amount_cents: -500, business_date: daysAgo(3), fund: null, id: r.body.item.cashEntryId });
    expect(bookBal(s, 'shop')).toBe(679000); // 679,500 - 500
    expect(r.body.warnings).toEqual([]);
  });

  it('OVER: counted 760,000 vs expected 750,000 at d4 -> +10,000 adjustment dated d4; later expected amounts include it', async () => {
    const s = await setup();
    await shopFixture(s);
    const r = await countNew(s, 'shop', 760000, { businessDate: daysAgo(4), note: 'found cash in the till' });
    expect(r.body.item).toMatchObject({ expectedCents: 750000, differenceCents: 10000 });
    expect(cashOfRef(s, 'cash_counts', r.body.item.id)[0]).toMatchObject({ amount_cents: 10000, business_date: daysAgo(4), type: 'cash_adjustment' });
    // expected as of d3 = 1,000,000 - 250,000 + 10,000 - 75,500 + 15,000 = 699,500
    expect((await get(s.app, `/cash-counts/expected?book=shop&businessDate=${daysAgo(3)}`)).body.expectedCents).toBe(699500);
    expect(bookBal(s, 'shop')).toBe(689500); // 679,500 + 10,000
  });

  it('a SHORT that leaves the book negative returns the shared warning; counted may be 0; negative / fractional counted is 400', async () => {
    const s = await setup();
    await openNew(s, 'telecom', { amountCents: 1000 });
    const r = await countNew(s, 'telecom', 0, { note: 'all gone' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ expectedCents: 1000, countedCents: 0, differenceCents: -1000 });
    expect(bookBal(s, 'telecom')).toBe(0);
    const r2 = await expNew(s, { book: 'telecom', amountCents: 500 });
    expect(r2.body.warnings[0]).toMatchObject({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', balanceCents: -500 });
    // a count when the book is already negative: expected is negative, counted 0 -> over (+500)
    const r3 = await countNew(s, 'telecom', 0, { note: 'nothing in the drawer' });
    expect(r3.body.item).toMatchObject({ expectedCents: -500, differenceCents: 500 });
    expect(bookBal(s, 'telecom')).toBe(0);
    expect((await countNew(s, 'telecom', -1)).status).toBe(400);
    expect((await countNew(s, 'telecom', 10.5)).status).toBe(400);
    expect((await countNew(s, 'telecom', 1_000_000_000_001)).status).toBe(400);
  });

  it('FUND_NOT_ALLOWED outside Ice Cream; dates: future 400, backdated flagged; unknown book 400; duplicate clientRef returns the first count', async () => {
    const s = await setup();
    await shopFixture(s);
    const bad = await countNew(s, 'shop', 100, { fund: 'profit', note: 'x' });
    expect(bad.status).toBe(400);
    expect(err(bad).code).toBe('FUND_NOT_ALLOWED');
    const f = await countNew(s, 'shop', 100, { businessDate: daysAhead(1), note: 'x' });
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect((await countNew(s, 'warehouse' as any, 100)).status).toBe(400);
    const clientRef = ref();
    const a = await countNew(s, 'shop', 679000, { note: 'n', clientRef });
    const b = await countNew(s, 'shop', 679000, { note: 'n', clientRef });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item).toEqual(a.body.item);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'cash_adjustment'")).toBe(1);
    const other = await countNew(s, 'telecom', 0, { clientRef });
    expect(other.status).toBe(409);
    expect(err(other).code).toBe('CLIENT_REF_CONFLICT');
  });

  it('void: the adjustment is reversed (same date, points back), the count is marked void; a second void is 409; zero-difference counts can be voided too', async () => {
    const s = await setup();
    await shopFixture(s);
    const c = (await countNew(s, 'shop', 689000, { businessDate: daysAgo(3), note: 'coins missing' })).body.item;
    const v = await countVoid(s, c.id, 'counted wrong');
    expect(v.status).toBe(200);
    expect(v.body.item).toMatchObject({ status: 'void', voidReason: 'counted wrong' });
    const cash = cashOfRef(s, 'cash_counts', c.id);
    expect(cash.map((x) => x.amount_cents)).toEqual([-500, 500]);
    expect(cash[1]).toMatchObject({ type: 'cash_adjustment', business_date: daysAgo(3), reverses_entry_id: cash[0]!.id });
    expect(bookBal(s, 'shop')).toBe(679500);
    expect((await countVoid(s, c.id)).status).toBe(409);
    const z = (await countNew(s, 'shop', 679500)).body.item;
    expect((await countVoid(s, z.id)).status).toBe(200);
    expect(auditRows(s.ctx, 'cash_count').map((a) => a.action)).toEqual(['create', 'void', 'create', 'void']);
  });

  it('GET /cash-counts: filters, paging and totals; GET /cash-counts/:id; /expected validates its parameters', async () => {
    const s = await setup();
    await shopFixture(s);
    const a = (await countNew(s, 'shop', 689500, { businessDate: daysAgo(3) })).body.item;
    const b = (await countNew(s, 'shop', 679000, { note: 'n' })).body.item;
    const t = (await countNew(s, 'telecom', 0)).body.item;
    expect((await get(s.app, '/cash-counts')).body.items.map((i: any) => i.id)).toEqual([t.id, b.id, a.id]); // newest business date first, then id desc: t and b are today, a is older
    const list = (await get(s.app, '/cash-counts?book=shop')).body;
    expect(list.total).toBe(2);
    expect(list.items.map((i: any) => i.id)).toEqual([b.id, a.id]);
    expect((await get(s.app, `/cash-counts?from=${today()}`)).body.total).toBe(2);
    await countVoid(s, b.id);
    expect((await get(s.app, '/cash-counts?status=void')).body.items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await get(s.app, `/cash-counts/${a.id}`)).body.item).toEqual(a);
    expect((await get(s.app, '/cash-counts/9999')).status).toBe(404);
    expect((await get(s.app, '/cash-counts/expected?book=shop')).status).toBe(400);
    expect((await get(s.app, '/cash-counts/expected?book=shop&businessDate=2026-13-01')).status).toBe(400);
    // a report date after today is accepted and equals today's balance
    expect((await get(s.app, `/cash-counts/expected?book=shop&businessDate=${daysAhead(5)}`)).body.expectedCents).toBe(bookBal(s, 'shop'));
  });
});

// =============================================================================================
describe('Ice Cream cash counts - fund over/short (10.2, C4) and the funds = book invariant (10.1)', () => {
  async function iceFixture(s: ApiBase): Promise<void> {
    await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000 });
    await openNew(s, 'icecream', { fund: 'electricity', amountCents: 100000 });
    await openNew(s, 'icecream', { fund: 'profit', amountCents: 200000 });
  }
  const invariant = (s: ApiBase) => {
    const f = fundBal(s);
    expect(f.cost + f.electricity + f.profit).toBe(bookBal(s, 'icecream'));
  };

  it('a non-zero difference needs a fund (FUND_REQUIRED) and a note; the cash entry and the cash_over_short fund row carry the same amount', async () => {
    const s = await setup();
    await iceFixture(s); // book 800,000; funds 500,000 / 100,000 / 200,000
    const before = snap8(s);
    expect(err(await countNew(s, 'icecream', 790000, { note: 'short' })).code).toBe('FUND_REQUIRED');
    expect(err(await countNew(s, 'icecream', 790000, { fund: 'profit' })).code).toBe('NOTE_REQUIRED');
    expect(snap8(s)).toEqual(before);
    const r = await countNew(s, 'icecream', 790000, { fund: 'profit', note: 'short by 100' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ expectedCents: 800000, countedCents: 790000, differenceCents: -10000, fund: 'profit' });
    expect(cashOfRef(s, 'cash_counts', r.body.item.id)[0]).toMatchObject({ book: 'icecream', type: 'cash_adjustment', amount_cents: -10000, fund: 'profit' });
    expect(fundOfRef(s, 'cash_counts', r.body.item.id)[0]).toMatchObject({ fund: 'profit', amount_cents: -10000, kind: 'cash_over_short' });
    expect(fundBal(s)).toEqual({ cost: 500000, electricity: 100000, profit: 190000 });
    expect(bookBal(s, 'icecream')).toBe(790000);
    invariant(s);
  });

  it('a zero difference needs no fund and writes no cash/fund row (a fund given anyway is ignored)', async () => {
    const s = await setup();
    await iceFixture(s);
    const r = await countNew(s, 'icecream', 800000, { fund: 'cost' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ differenceCents: 0, fund: null, cashEntryId: null });
    expect(fundOfRef(s, 'cash_counts', r.body.item.id)).toHaveLength(0);
    invariant(s);
  });

  it('over to the Electricity fund, void of the first count reverses its cash and fund rows; funds still add up to the book', async () => {
    const s = await setup();
    await iceFixture(s);
    const first = (await countNew(s, 'icecream', 790000, { fund: 'profit', note: 'short' })).body.item; // -10,000 profit
    const second = await countNew(s, 'icecream', 793000, { fund: 'electricity', note: 'over' }); // expected 790,000 -> +3,000
    expect(second.body.item).toMatchObject({ expectedCents: 790000, differenceCents: 3000 });
    expect(fundBal(s)).toEqual({ cost: 500000, electricity: 103000, profit: 190000 });
    invariant(s);
    expect((await countVoid(s, first.id)).status).toBe(200);
    // reversal rows: cash +10,000 (profit) and a `reversal` fund row +10,000
    expect(cashOfRef(s, 'cash_counts', first.id).map((c) => [c.amount_cents, c.fund])).toEqual([[-10000, 'profit'], [10000, 'profit']]);
    expect(fundOfRef(s, 'cash_counts', first.id).map((f) => [f.amount_cents, f.kind])).toEqual([[-10000, 'cash_over_short'], [10000, 'reversal']]);
    expect(fundBal(s)).toEqual({ cost: 500000, electricity: 103000, profit: 200000 });
    expect(bookBal(s, 'icecream')).toBe(803000);
    invariant(s);
  });

  it('a short that drives a FUND below zero warns with NEGATIVE_FUND_BALANCE (the book itself stays >= 0); never blocked', async () => {
    const s = await setup();
    await iceFixture(s);
    const r = await countNew(s, 'icecream', 0, { fund: 'cost', note: 'drawer empty' }); // diff -800,000 from the Cost fund
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([{
      code: 'NEGATIVE_FUND_BALANCE', book: 'icecream', fund: 'cost', balanceCents: -300000,
      message: 'The Ice Cream Cost fund is now below zero (-Rs. 3,000.00).',
    }]);
    expect(fundBal(s)).toEqual({ cost: -300000, electricity: 100000, profit: 200000 });
    invariant(s);
    const sum = await get(s.app, '/cashbooks');
    expect(sum.body.warnings.map((w: any) => w.code)).toEqual(['NEGATIVE_FUND_BALANCE']);
  });

  it('the Ice Cream ledger reports per-fund opening / in / out / closing for the period (fund moves are not cash rows)', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000, businessDate: daysAgo(5) });
    await openNew(s, 'icecream', { fund: 'profit', amountCents: 200000, businessDate: daysAgo(5) });
    await countNew(s, 'icecream', 690000, { fund: 'profit', note: 'short', businessDate: daysAgo(1) }); // -10,000 profit
    const r = (await ledgerGet(s, 'icecream', `?from=${daysAgo(2)}`)).body;
    expect(r).toMatchObject({ openingCents: 700000, inCents: 0, outCents: 10000, closingCents: 690000 });
    expect(r.funds).toEqual({
      cost: { openingCents: 500000, inCents: 0, outCents: 0, closingCents: 500000 },
      electricity: { openingCents: 0, inCents: 0, outCents: 0, closingCents: 0 },
      profit: { openingCents: 200000, inCents: 0, outCents: 10000, closingCents: 190000 },
    });
    expect(r.items[0]).toMatchObject({ fund: 'profit', type: 'cash_adjustment', amountCents: -10000, runningBalanceCents: 690000 });
  });
});

// =============================================================================================
describe('daily closings', () => {
  it('closing without a count: expected = balance as of that date, countedCents null, over/short 0, the day reads as closed', async () => {
    const s = await setup();
    await shopFixture(s);
    const r = await closeNew(s, 'shop', daysAgo(3));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.item).sort()).toEqual(CLOSING_KEYS);
    expect(r.body.item).toMatchObject({ book: 'shop', businessDate: daysAgo(3), expectedCents: 689500, countedCents: null, overShortCents: 0, cashCountId: null, isClosed: true, reopenedAt: null, reopenReason: null });
    expect(r.body.count).toBeNull();
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${daysAgo(3)}`)).body).toEqual({ isClosed: true });
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${daysAgo(2)}`)).body).toEqual({ isClosed: false });
    expect((await get(s.app, `/daily-closings/status?book=telecom&businessDate=${daysAgo(3)}`)).body).toEqual({ isClosed: false });
    expect(auditRows(s.ctx, 'daily_closing').map((a) => a.action)).toEqual(['close']);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'daily_closing'")[0]).toMatchObject({ business_date: daysAgo(3), backdated: 1 });
  });

  it('closing twice is 409 DAY_ALREADY_CLOSED; a future day cannot be closed (R-FD); an impossible date / unknown book is 400', async () => {
    const s = await setup();
    await closeOk(s, 'shop', daysAgo(1));
    const before = snap8(s);
    const again = await closeNew(s, 'shop', daysAgo(1));
    expect(again.status).toBe(409);
    expect(err(again)).toMatchObject({ code: 'DAY_ALREADY_CLOSED', book: 'shop', businessDate: daysAgo(1) });
    const f = await closeNew(s, 'shop', daysAhead(1));
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect((await closeNew(s, 'shop', '2026-13-01')).status).toBe(400);
    expect((await closeNew(s, 'warehouse' as any)).status).toBe(400);
    expect(snap8(s)).toEqual(before);
    // today itself may be closed
    expect((await closeNew(s, 'telecom', today())).status).toBe(201);
  });

  it('closing WITH a count posts the count and its over/short adjustment FIRST, then closes (the trigger does not block its own adjustment)', async () => {
    const s = await setup();
    await shopFixture(s);
    const r = await closeNew(s, 'shop', daysAgo(3), { countedCents: 689000, note: 'coins missing' });
    expect(r.status).toBe(201);
    // expected as of d3 = 689,500; counted 689,000 -> over/short -500
    expect(r.body.item).toMatchObject({ expectedCents: 689500, countedCents: 689000, overShortCents: -500, isClosed: true });
    expect(r.body.count).toMatchObject({ expectedCents: 689500, countedCents: 689000, differenceCents: -500, businessDate: daysAgo(3) });
    expect(r.body.item.cashCountId).toBe(r.body.count.id);
    const adj = cashOfRef(s, 'cash_counts', r.body.count.id);
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ type: 'cash_adjustment', amount_cents: -500, business_date: daysAgo(3) });
    expect(bookBal(s, 'shop')).toBe(679000);
    expect((await ledgerGet(s, 'shop')).body.closedDates).toEqual([daysAgo(3)]);
  });

  it('closing with a count that matches records the count (no adjustment) and links it; a differing count without a note rolls everything back (day stays open)', async () => {
    const s = await setup();
    await shopFixture(s);
    const ok = await closeNew(s, 'shop', daysAgo(4), { countedCents: 750000 });
    expect(ok.status).toBe(201);
    expect(ok.body.item).toMatchObject({ expectedCents: 750000, countedCents: 750000, overShortCents: 0 });
    expect(ok.body.count).toMatchObject({ differenceCents: 0, cashEntryId: null });
    const before = snap8(s);
    const bad = await closeNew(s, 'shop', daysAgo(3), { countedCents: 1 });
    expect(err(bad).code).toBe('NOTE_REQUIRED');
    expect(snap8(s)).toEqual(before);
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${daysAgo(3)}`)).body.isClosed).toBe(false);
  });

  it('Ice Cream closing with a short: fund required; the count adjustment names the fund and the closing is recorded', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: 500000, businessDate: daysAgo(2) });
    expect(err(await closeNew(s, 'icecream', daysAgo(2), { countedCents: 499000, note: 'short' })).code).toBe('FUND_REQUIRED');
    const r = await closeNew(s, 'icecream', daysAgo(2), { countedCents: 499000, note: 'short', fund: 'cost' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ expectedCents: 500000, countedCents: 499000, overShortCents: -1000 });
    expect(fundBal(s)).toEqual({ cost: 499000, electricity: 0, profit: 0 });
    expect(bookBal(s, 'icecream')).toBe(499000);
  });

  it('a retry of a close that already saved its count returns the closing (200, created false); the same clientRef for another day is 409', async () => {
    const s = await setup();
    await shopFixture(s);
    const clientRef = ref();
    const a = await closeNew(s, 'shop', daysAgo(3), { countedCents: 689000, note: 'coins', clientRef });
    const b = await closeNew(s, 'shop', daysAgo(3), { countedCents: 689000, note: 'coins', clientRef });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item).toEqual(a.body.item);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'cash_adjustment'")).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM cash_counts')).toBe(1);
    const c = await closeNew(s, 'shop', daysAgo(2), { countedCents: 689000, note: 'coins', clientRef });
    expect(c.status).toBe(409);
    expect(err(c).code).toBe('CLIENT_REF_CONFLICT');
  });

  it('reopen: needs a reason of at least 3 characters; day opens; a second reopen is 409 DAY_NOT_CLOSED; audited; re-close updates the SAME row with new figures', async () => {
    const s = await setup();
    await shopFixture(s);
    const c = await closeOk(s, 'shop', daysAgo(3)); // expected 689,500
    const before = snap8(s);
    expect((await post(s.app, `/daily-closings/${c.id}/reopen`, {})).status).toBe(400);
    expect(err(await reopenNew(s, c.id, 'ab')).code).toBe('VALIDATION_ERROR');
    expect((await reopenNew(s, c.id, '   a   ')).status).toBe(400);
    expect(snap8(s)).toEqual(before);
    const r = await reopenNew(s, c.id, 'forgot a sale');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id: c.id, isClosed: false, reopenReason: 'forgot a sale' });
    expect(r.body.item.reopenedAt).toEqual(expect.any(String));
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${daysAgo(3)}`)).body.isClosed).toBe(false);
    const again = await reopenNew(s, c.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('DAY_NOT_CLOSED');
    expect((await reopenNew(s, 9999)).status).toBe(404);
    // edit the day (a sale dated d3), then close again: same row, new expected = 689,500 + 15,000 = 704,500
    expect((await psNew(s, { businessDate: daysAgo(3), qty: 10 })).status).toBe(201);
    const re = await closeNew(s, 'shop', daysAgo(3));
    expect(re.status).toBe(201);
    expect(re.body.item).toMatchObject({ id: c.id, expectedCents: 704500, isClosed: true, reopenReason: 'forgot a sale' });
    expect(re.body.item.closedAt > re.body.item.reopenedAt).toBe(true);
    expect(num(s, 'SELECT COUNT(*) FROM daily_closings')).toBe(1);
    expect(auditRows(s.ctx, 'daily_closing').map((a) => a.action)).toEqual(['close', 'reopen', 'close']);
    expect(sql(s, "SELECT note, business_date FROM audit_logs WHERE entity = 'daily_closing' AND action = 'reopen'")[0]).toMatchObject({ note: 'forgot a sale', business_date: daysAgo(3) });
  });

  it('GET /daily-closings: filters by book and dates, every item carries isClosed', async () => {
    const s = await setup();
    const a = await closeOk(s, 'shop', daysAgo(3));
    const b = await closeOk(s, 'shop', daysAgo(2));
    await closeOk(s, 'telecom', daysAgo(2));
    await reopenNew(s, a.id);
    const all = (await get(s.app, '/daily-closings')).body.items;
    expect(all).toHaveLength(3);
    const shop = (await get(s.app, '/daily-closings?book=shop')).body.items;
    expect(shop.map((i: any) => [i.id, i.isClosed])).toEqual([[b.id, true], [a.id, false]]);
    expect((await get(s.app, `/daily-closings?book=shop&from=${daysAgo(2)}`)).body.items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await get(s.app, '/daily-closings?book=warehouse')).status).toBe(400);
  });
});

// =============================================================================================
describe('R13 - one shared negative-cash warning for every cash-out write', () => {
  const NEG = (book: string, cents: number, label: string, money: string) => ({
    code: 'NEGATIVE_CASH_BALANCE', book, balanceCents: cents,
    message: `The ${label} cash book is now below zero (${money}). Check that the opening balance and sales are recorded.`,
  });

  it('purchase (shop and telecom), supplies, top-up, sale refund and a short all return the same object shape; none blocks', async () => {
    const s = await setup();
    // purchase: cost Rs 1,000.00 = 100,000 -> shop balance -100,000
    const p = await mkProduct(s);
    const pr = await post(s.app, '/purchases', { businessDate: today(), items: [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 100000 }], clientRef: ref() });
    expect(pr.status).toBe(201);
    expect(pr.body.warnings).toEqual([NEG('shop', -100000, 'Shop', '-Rs. 1,000.00')]);
    // supplies 5,000 -> -105,000
    const sup = await supNew(s, { amountCents: 5000 });
    expect(sup.body.warnings).toEqual([NEG('shop', -105000, 'Shop', '-Rs. 1,050.00')]);
    // sale of 2 @ 30,000 = +60,000 -> -45,000; the refund of both (-60,000) -> -105,000 and warns
    const sale = await sellOne(s, p.id, 2, 30000);
    const ret = await post(s.app, `/sales/${sale.id}/returns`, { businessDate: today(), items: [{ saleItemId: sale.items[0].id, qty: 2, resalable: true }], clientRef: ref() });
    expect(ret.status).toBe(201);
    expect(ret.body.warnings).toEqual([NEG('shop', -105000, 'Shop', '-Rs. 1,050.00')]);
    // telecom top-up
    const prov = (await get(s.app, '/reload-providers')).body.items[0];
    const top = await post(s.app, '/telecom/topups', { businessDate: today(), kind: 'provider_topup', providerId: prov.id, amountCents: 2500, clientRef: ref() });
    expect(top.status).toBe(201);
    expect(top.body.warnings).toEqual([NEG('telecom', -2500, 'Telecom', '-Rs. 25.00')]);
    expect(bookBal(s, 'telecom')).toBe(-2500);
  });

  it('no warning when the cash-out is covered; none for cash-in writes; none on a repeated (idempotent) request', async () => {
    const s = await setup();
    await openNew(s, 'shop', { amountCents: 1000000 });
    const stockedP = await stocked(s, mkProduct, 10, 100000); // buy 10 for 100,000: balance 900,000
    expect(bookBal(s, 'shop')).toBe(900000);
    const sale = await sellOne(s, stockedP.id, 1, 30000);
    const ret = await returnOk(s, sale.id, [{ saleItemId: sale.items[0].id, qty: 1, resalable: true }]);
    expect(ret.item.refundCents).toBe(30000);
    const clientRef = ref();
    const a = await supNew(s, { amountCents: 1000, clientRef });
    const b = await supNew(s, { amountCents: 1000, clientRef });
    expect(a.body.warnings).toEqual([]);
    expect(b.status).toBe(200);
    expect(b.body.warnings).toEqual([]);
  });
});

// =============================================================================================
describe('rollback: one transaction per cash book write', () => {
  it('opening balance: a failing audit leaves no capital entry, no cash entry and no fund row', async () => {
    quiet();
    const s = await setup();
    const before = snap8(s);
    breakAudit(s.ctx, 'capital_entry');
    expect((await openNew(s, 'icecream', { fund: 'cost' })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
  });

  it('opening balance: a failing FUND insert leaves no capital entry and no cash entry; fixed, the same clientRef works', async () => {
    quiet();
    const s = await setup();
    const before = snap8(s);
    s.ctx.database.conn.exec('CREATE TRIGGER test_break_fund BEFORE INSERT ON icecream_fund_entries BEGIN SELECT RAISE(ABORT, \'fund boom\'); END');
    const clientRef = ref();
    expect((await openNew(s, 'icecream', { fund: 'cost', clientRef })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_fund');
    expect((await openNew(s, 'icecream', { fund: 'cost', clientRef })).status).toBe(201);
  });

  it('cash count: a failing audit after the adjustment leaves no count, no adjustment, no fund row', async () => {
    quiet();
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: 5000 });
    const before = snap8(s);
    breakAudit(s.ctx, 'cash_count');
    expect((await countNew(s, 'icecream', 1000, { fund: 'cost', note: 'x' })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
    expect(bookBal(s, 'icecream')).toBe(5000);
  });

  it('daily closing with a count: a failing closing audit rolls back the count too and the day stays open', async () => {
    quiet();
    const s = await setup();
    await openNew(s, 'shop', { amountCents: 5000 });
    const before = snap8(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.entity = 'daily_closing' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await closeNew(s, 'shop', today(), { countedCents: 4000, note: 'x' })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${today()}`)).body.isClosed).toBe(false);
  });

  it('reopen: a failing audit leaves the day closed', async () => {
    quiet();
    const s = await setup();
    const c = await closeOk(s, 'shop', today());
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'reopen' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await reopenNew(s, c.id)).status).toBe(500);
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${today()}`)).body.isClosed).toBe(true);
  });
});
