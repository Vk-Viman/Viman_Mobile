// Phase 9 cash transfers API (BUSINESS_RULES sections 8, 9, 10.2, 10.7, 12; R1, R9, R13, R-FD). Protects:
//   - a transfer is ONE record and TWO ledger rows (transfer_out in the source book, transfer_in in the destination) sharing its id;
//     the money leaves one book and arrives in the other, in ALL six ordered pairs of the three books, with hand-calculated balances;
//   - Ice Cream sides name their fund and write the matching fund row, so Cost + Electricity + Profit = the Ice Cream book at all times
//     and the sum of fund rows = the sum of Ice Cream cash rows (10.1, 10.7); transfers are never profit-eligible (no P&L table moves);
//   - validation: SAME_BOOK, FUND_REQUIRED / FUND_NOT_ALLOWED on the right field, schema bounds, R-FD, clientRef idempotency;
//   - R13: a negative source book or fund is a WARNING, never a block;
//   - R9: BOTH books must have the day open, for create and for void, and everything works again after a reopen;
//   - R1: a void reverses both legs exactly (balances return to the pre-state), twice is 409, rows are never edited or deleted;
//   - one transaction: a failure on the second leg (or on the fund row, or on the audit row) leaves nothing behind.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, err, num, sql } from './helpers/phase4.ts';
import { closeNew, closeOk, openNew, reopenNew, snap8 } from './helpers/phase8.ts';
import type { Book } from './helpers/phase8.ts';
import { TRANSFER_KEYS, iceInvariant, legsOf, pnlSnapshot, seedBooks, state, tr, trNew, trVoid } from './helpers/phase9.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/** Row counts of every table a transfer touches plus the new one. */
const snap9 = (s: ApiBase): Record<string, number> => ({ ...snap8(s), cash_transfers: num(s, 'SELECT COUNT(*) FROM cash_transfers') });

describe('POST /cash-transfers - create', () => {
  it('201 with the exact shape; two linked ledger rows (out of Shop, into Telecom); audit with business date and backdated=false', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 1000000, telecom: 500000 }); // Rs 10,000.00 and Rs 5,000.00
    const r = await tr(s, 'shop', 'telecom', 250000, { note: '  top up the wallet  ' }); // Rs 2,500.00
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['item', 'warnings']);
    expect(r.body.warnings).toEqual([]);
    const it = r.body.item;
    expect(Object.keys(it).sort()).toEqual(TRANSFER_KEYS);
    expect(it).toMatchObject({ fromBook: 'shop', toBook: 'telecom', fromFund: null, toFund: null, amountCents: 250000, note: 'top up the wallet',
      status: 'posted', backdated: false, businessDate: today(), voidedAt: null, voidReason: null });
    const legs = legsOf(s, it.id);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ book: 'shop', type: 'transfer_out', amount_cents: -250000, fund: null, ref_table: 'cash_transfers', ref_id: it.id, reverses_entry_id: null });
    expect(legs[1]).toMatchObject({ book: 'telecom', type: 'transfer_in', amount_cents: 250000, fund: null, ref_table: 'cash_transfers', ref_id: it.id, reverses_entry_id: null });
    expect(state(s)).toMatchObject({ shop: 750000, telecom: 750000, icecream: 0 }); // 1,000,000 - 250,000 / 500,000 + 250,000
    const a = auditRows(s.ctx, 'cash_transfer');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', before: null, entityId: String(it.id) });
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'cash_transfer'")[0]).toMatchObject({ business_date: today(), backdated: 0 });
    expect((await get(s.app, `/cash-transfers/${it.id}`)).body.item).toEqual(it);
  });

  it('a backdated transfer is accepted, dated and flagged; both ledger rows carry the chosen business date', async () => {
    const s = await setup();
    const d = daysAgo(3);
    const r = await tr(s, 'telecom', 'shop', 1000, { businessDate: d });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ businessDate: d, backdated: true });
    expect(legsOf(s, r.body.item.id).map((l) => l.business_date)).toEqual([d, d]);
    expect(sql(s, "SELECT backdated FROM audit_logs WHERE entity = 'cash_transfer'")[0]).toMatchObject({ backdated: 1 });
  });

  // Hand-calculated walk through ALL six ordered pairs. Start (cents): shop 1,000,000; telecom 500,000; Ice Cream cost 300,000,
  // electricity 200,000, profit 100,000 (book 600,000). Total 2,100,000. Every step moves money without creating or destroying any.
  it('all six ordered book pairs: balances of both books AND the funds after every step', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 1000000, telecom: 500000, cost: 300000, electricity: 200000, profit: 100000 });
    expect(state(s)).toEqual({ shop: 1000000, telecom: 500000, icecream: 600000, cost: 300000, electricity: 200000, profit: 100000 });
    const steps: Array<{ name: string; from: Book; to: Book; amount: number; over: Record<string, unknown>; after: ReturnType<typeof state> }> = [
      { name: 'shop -> telecom 250,000', from: 'shop', to: 'telecom', amount: 250000, over: {},
        after: { shop: 750000, telecom: 750000, icecream: 600000, cost: 300000, electricity: 200000, profit: 100000 } },
      { name: 'telecom -> shop 100,000', from: 'telecom', to: 'shop', amount: 100000, over: {},
        after: { shop: 850000, telecom: 650000, icecream: 600000, cost: 300000, electricity: 200000, profit: 100000 } },
      { name: 'shop -> icecream(profit) 50,000', from: 'shop', to: 'icecream', amount: 50000, over: { toFund: 'profit' },
        after: { shop: 800000, telecom: 650000, icecream: 650000, cost: 300000, electricity: 200000, profit: 150000 } },
      { name: 'icecream(cost) -> shop 120,000', from: 'icecream', to: 'shop', amount: 120000, over: { fromFund: 'cost' },
        after: { shop: 920000, telecom: 650000, icecream: 530000, cost: 180000, electricity: 200000, profit: 150000 } },
      { name: 'telecom -> icecream(electricity) 70,000', from: 'telecom', to: 'icecream', amount: 70000, over: { toFund: 'electricity' },
        after: { shop: 920000, telecom: 580000, icecream: 600000, cost: 180000, electricity: 270000, profit: 150000 } },
      { name: 'icecream(profit) -> telecom 30,000', from: 'icecream', to: 'telecom', amount: 30000, over: { fromFund: 'profit' },
        after: { shop: 920000, telecom: 610000, icecream: 570000, cost: 180000, electricity: 270000, profit: 120000 } },
    ];
    for (const st of steps) {
      const r = await tr(s, st.from, st.to, st.amount, st.over);
      expect(r.status, st.name).toBe(201);
      expect(r.body.warnings, st.name).toEqual([]);
      expect(state(s), st.name).toEqual(st.after);
      const i = iceInvariant(s);
      expect(i.funds, st.name).toBe(i.book);
      expect(i.fundRows, st.name).toBe(i.cashRows);
    }
    // total of the three books never changes by a transfer: 920,000 + 610,000 + 570,000 = 2,100,000
    expect(920000 + 610000 + 570000).toBe(2100000);
    const all = await get(s.app, '/cash-transfers');
    expect(all.body.total).toBe(6);
    expect(all.body.totals.amountCents).toBe(250000 + 100000 + 50000 + 120000 + 70000 + 30000); // 620,000
  });

  it('Ice Cream legs write their fund row (kinds transfer_out / transfer_in) in the same transaction', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 100000, cost: 100000 });
    const a = await tr(s, 'icecream', 'shop', 40000, { fromFund: 'cost' });
    const funds = sql(s, "SELECT fund, amount_cents, kind, ref_table, ref_id FROM icecream_fund_entries WHERE kind IN ('transfer_out','transfer_in')");
    expect(funds).toEqual([{ fund: 'cost', amount_cents: -40000, kind: 'transfer_out', ref_table: 'cash_transfers', ref_id: a.body.item.id }]);
    const b = await tr(s, 'shop', 'icecream', 25000, { toFund: 'electricity' });
    const funds2 = sql(s, "SELECT fund, amount_cents, kind FROM icecream_fund_entries WHERE ref_id = ? AND ref_table = 'cash_transfers'", b.body.item.id);
    expect(funds2).toEqual([{ fund: 'electricity', amount_cents: 25000, kind: 'transfer_in' }]);
    // Shop side of an Ice Cream transfer writes NO fund row and carries no fund
    expect(legsOf(s, b.body.item.id).find((l) => l.book === 'shop')).toMatchObject({ fund: null, amount_cents: -25000 });
    expect(state(s)).toMatchObject({ shop: 100000 + 40000 - 25000, icecream: 100000 - 40000 + 25000, cost: 60000, electricity: 25000, profit: 0 });
  });

  it('a transfer never touches a profit-relevant table (sales, purchases, stock, expenses, telecom, printing ...) - transfers are not revenue, cost or profit', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 500000, telecom: 500000, cost: 100000 });
    const before = pnlSnapshot(s);
    expect((await tr(s, 'shop', 'telecom', 10000)).status).toBe(201);
    expect((await tr(s, 'icecream', 'shop', 5000, { fromFund: 'cost' })).status).toBe(201);
    const v = await tr(s, 'telecom', 'icecream', 7000, { toFund: 'profit' });
    expect((await trVoid(s, v.body.item.id)).status).toBe(200);
    expect(pnlSnapshot(s)).toEqual(before);
  });
});

describe('POST /cash-transfers - validation', () => {
  it('SAME_BOOK: the same book on both sides is refused (also Ice Cream to Ice Cream), nothing written', async () => {
    const s = await setup();
    const before = snap9(s);
    for (const book of ['shop', 'telecom'] as const) {
      const r = await tr(s, book, book, 100);
      expect(r.status).toBe(400);
      expect(err(r)).toMatchObject({ code: 'SAME_BOOK', fields: { toBook: expect.any(String) } });
    }
    const ice = await tr(s, 'icecream', 'icecream', 100, { fromFund: 'cost', toFund: 'profit' });
    expect(err(ice).code).toBe('SAME_BOOK'); // moving money between funds is a fund move (Phase 10), not a transfer
    expect(snap9(s)).toEqual(before);
  });

  it('FUND_REQUIRED on the Ice Cream side (field fromFund / toFund), FUND_NOT_ALLOWED on a side that is not Ice Cream', async () => {
    const s = await setup();
    const before = snap9(s);
    let r = await tr(s, 'icecream', 'shop', 100);
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'FUND_REQUIRED', fields: { fromFund: expect.any(String) } });
    r = await tr(s, 'telecom', 'icecream', 100);
    expect(err(r)).toMatchObject({ code: 'FUND_REQUIRED', fields: { toFund: expect.any(String) } });
    r = await tr(s, 'shop', 'telecom', 100, { fromFund: 'cost' });
    expect(err(r)).toMatchObject({ code: 'FUND_NOT_ALLOWED', fields: { fromFund: expect.any(String) } });
    r = await tr(s, 'shop', 'telecom', 100, { toFund: 'profit' });
    expect(err(r)).toMatchObject({ code: 'FUND_NOT_ALLOWED', fields: { toFund: expect.any(String) } });
    r = await tr(s, 'icecream', 'shop', 100, { fromFund: 'cost', toFund: 'cost' }); // the Shop side may not name a fund either
    expect(err(r)).toMatchObject({ code: 'FUND_NOT_ALLOWED', fields: { toFund: expect.any(String) } });
    expect(snap9(s)).toEqual(before);
  });

  it('schema: amount 1..10^12 integer, enums, required fields, unknown fields, clientRef pattern, note length, real date', async () => {
    const s = await setup();
    const before = snap9(s);
    for (const a of [0, -5, 1.5, '100', null, 1000000000001]) {
      const r = await trNew(s, { amountCents: a });
      expect(r.status, JSON.stringify(a)).toBe(400);
      expect(err(r).fields.amountCents, JSON.stringify(a)).toBeTruthy();
    }
    for (const b of ['warehouse', '', null, 'SHOP']) {
      expect(err(await trNew(s, { fromBook: b })).fields.fromBook, String(b)).toBeTruthy();
      expect(err(await trNew(s, { toBook: b })).fields.toBook, String(b)).toBeTruthy();
    }
    expect(err(await trNew(s, { fromBook: 'icecream', fromFund: 'rent' })).fields.fromFund).toBeTruthy();
    for (const k of ['businessDate', 'fromBook', 'toBook', 'amountCents', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), fromBook: 'shop', toBook: 'telecom', amountCents: 100, clientRef: ref() };
      delete body[k];
      const r = await post(s.app, '/cash-transfers', body);
      expect(r.status, k).toBe(400);
      expect(err(r).fields[k], k).toBeTruthy();
    }
    expect(err(await trNew(s, { status: 'void' })).fields.status).toBeTruthy();
    expect(err(await trNew(s, { postedAt: '2020-01-01T00:00:00.000Z' })).fields.postedAt).toBeTruthy();
    for (const c of ['short', 'with space 1234', 'z'.repeat(65)]) expect((await trNew(s, { clientRef: c })).status, c).toBe(400);
    expect((await trNew(s, { note: 'n'.repeat(501) })).status).toBe(400);
    expect((await trNew(s, { businessDate: '2026-02-30' })).status).toBe(400);
    expect(snap9(s)).toEqual(before);
    expect((await trNew(s, { note: 'n'.repeat(500), amountCents: 1000000000000 })).status).toBe(201); // both upper bounds are allowed
  });

  it('R-FD: a future date is refused with the owner wording and nothing is written; today and the past are fine', async () => {
    const s = await setup();
    const before = snap9(s);
    const r = await trNew(s, { businessDate: daysAhead(1) });
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect(snap9(s)).toEqual(before);
    expect((await trNew(s, { businessDate: today() })).status).toBe(201);
  });
});

describe('POST /cash-transfers - duplicates (clientRef)', () => {
  it('the same clientRef twice returns the first transfer (200, no warnings) and writes ONE record and TWO legs', async () => {
    const s = await setup();
    const clientRef = ref();
    const a = await tr(s, 'shop', 'telecom', 5000, { clientRef });
    const b = await tr(s, 'shop', 'telecom', 5000, { clientRef });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.item).toEqual(a.body.item);
    expect(b.body.warnings).toEqual([]);
    expect(num(s, 'SELECT COUNT(*) FROM cash_transfers')).toBe(1);
    expect(legsOf(s, a.body.item.id)).toHaveLength(2);
    expect(state(s)).toMatchObject({ shop: -5000, telecom: 5000 });
  });

  it('five simultaneous submissions of one clientRef still create exactly one transfer', async () => {
    const s = await setup();
    const clientRef = ref();
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => tr(s, 'telecom', 'icecream', 700, { toFund: 'cost', clientRef })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(4);
    expect(num(s, 'SELECT COUNT(*) FROM cash_transfers')).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type IN ('transfer_in','transfer_out')")).toBe(2);
    expect(num(s, "SELECT COUNT(*) FROM icecream_fund_entries WHERE kind = 'transfer_in'")).toBe(1);
    expect(auditRows(s.ctx, 'cash_transfer')).toHaveLength(1);
  });
});

describe('R13 - negative balances are warnings, never blocks', () => {
  it('an empty source book goes negative: saved, with NEGATIVE_CASH_BALANCE for the source only', async () => {
    const s = await setup();
    const r = await tr(s, 'shop', 'telecom', 10000);
    expect(r.status).toBe(201);
    expect(r.body.warnings).toHaveLength(1);
    expect(r.body.warnings[0]).toMatchObject({ code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -10000 });
    expect(state(s)).toMatchObject({ shop: -10000, telecom: 10000 });
  });

  it('Ice Cream fund below zero while the book is still positive: only NEGATIVE_FUND_BALANCE', async () => {
    const s = await setup();
    await seedBooks(s, { cost: 5000, profit: 10000 }); // book 15,000
    const r = await tr(s, 'icecream', 'shop', 8000, { fromFund: 'cost' }); // cost 5,000 - 8,000 = -3,000; book 7,000
    expect(r.status).toBe(201);
    expect(r.body.warnings).toHaveLength(1);
    expect(r.body.warnings[0]).toMatchObject({ code: 'NEGATIVE_FUND_BALANCE', book: 'icecream', fund: 'cost', balanceCents: -3000 });
    expect(state(s)).toMatchObject({ icecream: 7000, cost: -3000, profit: 10000, shop: 8000 });
  });

  it('both the Ice Cream book and a fund below zero: both warnings', async () => {
    const s = await setup();
    await seedBooks(s, { cost: 5000 });
    const r = await tr(s, 'icecream', 'telecom', 8000, { fromFund: 'cost' }); // book and cost fund both -3,000
    expect(r.body.warnings.map((w: any) => [w.code, w.fund ?? null, w.balanceCents]).sort()).toEqual([
      ['NEGATIVE_CASH_BALANCE', null, -3000], ['NEGATIVE_FUND_BALANCE', 'cost', -3000],
    ]);
  });

  it('a destination book that was already negative gets no warning: receiving cash is not a cash-out', async () => {
    const s = await setup();
    await tr(s, 'telecom', 'shop', 1000); // telecom -1,000
    const r = await tr(s, 'shop', 'telecom', 200); // shop 1,000 -> 800 (positive); telecom -800 (still negative, but only received)
    expect(r.body.warnings).toEqual([]);
  });
});

describe('R9 - DAY_CLOSED on either side', () => {
  const pairs: Array<{ name: string; from: Book; to: Book; fromFund?: string; toFund?: string }> = [
    { name: 'shop -> telecom', from: 'shop', to: 'telecom' },
    { name: 'telecom -> icecream', from: 'telecom', to: 'icecream', toFund: 'cost' },
    { name: 'icecream -> shop', from: 'icecream', to: 'shop', fromFund: 'profit' },
  ];
  describe.each(pairs)('$name', (p) => {
    const body = (extra: Record<string, unknown> = {}) => ({
      fromBook: p.from, toBook: p.to, ...(p.fromFund ? { fromFund: p.fromFund } : {}), ...(p.toFund ? { toFund: p.toFund } : {}), amountCents: 1500, ...extra,
    });

    it.each([['source', 'from'], ['destination', 'to']] as const)('create is refused when the %s book is closed (409 DAY_CLOSED naming that book); other books stay open', async (_n, side) => {
      const s = await setup();
      const d = daysAgo(1);
      const closedBook = side === 'from' ? p.from : p.to;
      await closeOk(s, closedBook, d);
      const before = snap9(s);
      const r = await trNew(s, body({ businessDate: d }));
      expect(r.status).toBe(409);
      expect(err(r)).toMatchObject({ code: 'DAY_CLOSED', book: closedBook, businessDate: d });
      expect(snap9(s)).toEqual(before);
      expect((await trNew(s, body({ businessDate: today() }))).status).toBe(201); // another day is unaffected
    });

    it('void is refused when either book is closed on the transfer date; works again after the reopen; both legs reverse', async () => {
      const s = await setup();
      const d = daysAgo(1);
      const t = (await trNew(s, body({ businessDate: d }))).body.item;
      for (const book of [p.from, p.to]) {
        const c = await closeOk(s, book, d);
        const before = snap9(s);
        const v = await trVoid(s, t.id);
        expect(v.status, `${book} closed`).toBe(409);
        expect(err(v)).toMatchObject({ code: 'DAY_CLOSED', book, businessDate: d });
        expect(snap9(s)).toEqual(before);
        expect((await reopenNew(s, c.id)).status).toBe(200);
      }
      expect((await trVoid(s, t.id)).status).toBe(200);
      expect(state(s)).toMatchObject({ shop: 0, telecom: 0, icecream: 0 });
    });

    it('after a reopen a refused create succeeds', async () => {
      const s = await setup();
      const d = daysAgo(2);
      const c = await closeOk(s, p.to, d);
      expect((await trNew(s, body({ businessDate: d }))).status).toBe(409);
      expect((await reopenNew(s, c.id)).status).toBe(200);
      expect((await trNew(s, body({ businessDate: d }))).status).toBe(201);
    });
  });

  it('both books closed: the first one in book order (shop, telecom, icecream) is named', async () => {
    const s = await setup();
    const d = daysAgo(1);
    expect((await closeNew(s, 'telecom', d)).status).toBe(201);
    expect((await closeNew(s, 'shop', d)).status).toBe(201);
    expect(err(await trNew(s, { fromBook: 'telecom', toBook: 'shop', businessDate: d })).book).toBe('shop');
  });

  it('a closing of the same date in a THIRD book does not matter', async () => {
    const s = await setup();
    const d = daysAgo(1);
    await closeOk(s, 'icecream', d);
    expect((await trNew(s, { businessDate: d })).status).toBe(201); // shop -> telecom
  });

  it('a duplicate clientRef is answered before the day check (it returns the saved transfer, as for every other write)', async () => {
    const s = await setup();
    const d = daysAgo(1);
    const clientRef = ref();
    const a = await trNew(s, { businessDate: d, clientRef });
    await closeOk(s, 'shop', d);
    const b = await trNew(s, { businessDate: d, clientRef });
    expect(b.status).toBe(200);
    expect(b.body.item.id).toBe(a.body.item.id);
  });
});

describe('POST /cash-transfers/:id/void - R1 reversal', () => {
  it('both legs are reversed exactly: balances return to the pre-state; reversal rows copy book, fund and date and point at the originals', async () => {
    const s = await setup();
    const d = daysAgo(2);
    await seedBooks(s, { shop: 400000, telecom: 100000, cost: 50000, electricity: 20000, profit: 30000 }, daysAgo(5));
    const pre = state(s);
    const t = (await tr(s, 'icecream', 'shop', 12345, { fromFund: 'electricity', businessDate: d })).body.item;
    expect(state(s)).toMatchObject({ shop: 400000 + 12345, icecream: 100000 - 12345, electricity: 20000 - 12345 });
    const v = await trVoid(s, t.id, '  entered by mistake ');
    expect(v.status).toBe(200);
    expect(Object.keys(v.body).sort()).toEqual(['item', 'warnings']);
    expect(v.body.item).toMatchObject({ status: 'void', voidReason: 'entered by mistake', businessDate: d });
    expect(v.body.item.voidedAt).toBeTruthy();
    expect(state(s)).toEqual(pre);
    const legs = legsOf(s, t.id);
    expect(legs).toHaveLength(4);
    const [out, inn, rOut, rIn] = legs;
    expect(rOut).toMatchObject({ book: 'icecream', fund: 'electricity', type: 'transfer_out', amount_cents: 12345, business_date: d, reverses_entry_id: out!.id });
    expect(rIn).toMatchObject({ book: 'shop', fund: null, type: 'transfer_in', amount_cents: -12345, business_date: d, reverses_entry_id: inn!.id });
    const fundRows = sql(s, "SELECT fund, amount_cents, kind, reverses_entry_id FROM icecream_fund_entries WHERE ref_table = 'cash_transfers' ORDER BY id");
    expect(fundRows).toHaveLength(2);
    expect(fundRows[0]).toMatchObject({ fund: 'electricity', amount_cents: -12345, kind: 'transfer_out' });
    expect(fundRows[1]).toMatchObject({ fund: 'electricity', amount_cents: 12345, kind: 'reversal' });
    expect(fundRows[1]!.reverses_entry_id).toBeTruthy();
    const i = iceInvariant(s);
    expect(i.funds).toBe(i.book);
    expect(i.fundRows).toBe(i.cashRows);
    const a = auditRows(s.ctx, 'cash_transfer');
    expect(a.map((x) => x.action)).toEqual(['create', 'void']);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'cash_transfer' AND action = 'void'")[0]).toMatchObject({ business_date: d, backdated: 1 });
  });

  it('void twice -> 409 ALREADY_VOID and nothing more is written; an unknown id is 404; a missing reason is 400', async () => {
    const s = await setup();
    const t = (await tr(s, 'shop', 'telecom', 900)).body.item;
    expect((await trVoid(s, t.id)).status).toBe(200);
    const before = snap9(s);
    const again = await trVoid(s, t.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(snap9(s)).toEqual(before);
    expect((await trVoid(s, 99999)).status).toBe(404);
    expect((await post(s.app, `/cash-transfers/${t.id}/void`, {})).status).toBe(400);
    expect((await post(s.app, `/cash-transfers/${t.id}/void`, { reason: '   ' })).status).toBe(400);
    expect((await post(s.app, '/cash-transfers/abc/void', { reason: 'x' })).status).toBe(400);
  });

  it('voiding can push the destination below zero: saved with a warning for the destination (R13)', async () => {
    const s = await setup();
    await seedBooks(s, { shop: 10000 });
    const t = (await tr(s, 'shop', 'telecom', 10000)).body.item; // telecom +10,000, shop 0
    await tr(s, 'telecom', 'icecream', 10000, { toFund: 'cost' }); // telecom 0, ice cream cost 10,000
    const v = await trVoid(s, t.id); // telecom 0 - 10,000 = -10,000
    expect(v.status).toBe(200);
    expect(v.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', balanceCents: -10000 })]);
    expect(state(s)).toMatchObject({ shop: 10000, telecom: -10000, icecream: 10000 });
  });

  it('voided transfers stay listed but leave the totals; the ledger keeps all four rows', async () => {
    const s = await setup();
    const a = (await tr(s, 'shop', 'telecom', 1000)).body.item;
    await tr(s, 'shop', 'telecom', 2000);
    await trVoid(s, a.id);
    const all = (await get(s.app, '/cash-transfers')).body;
    expect([all.total, all.totals.amountCents]).toEqual([2, 2000]);
    const voided = (await get(s.app, '/cash-transfers?status=void')).body;
    expect([voided.total, voided.totals.amountCents, voided.items[0].id]).toEqual([1, 0, a.id]);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type IN ('transfer_in','transfer_out')")).toBe(6);
  });
});

describe('GET /cash-transfers - list', () => {
  it('filters (book matches EITHER side, dates inclusive, status), newest first, totals of posted rows, paging and bad queries', async () => {
    const s = await setup();
    const t1 = (await tr(s, 'shop', 'telecom', 1000, { businessDate: daysAgo(5) })).body.item;
    const t2 = (await tr(s, 'telecom', 'icecream', 2000, { businessDate: daysAgo(3), toFund: 'cost' })).body.item;
    const t3 = (await tr(s, 'icecream', 'shop', 4000, { businessDate: daysAgo(1), fromFund: 'cost' })).body.item;
    const q = async (qs: string) => (await get(s.app, `/cash-transfers?${qs}`)).body;
    let r = await q('');
    expect(r.items.map((i: any) => i.id)).toEqual([t3.id, t2.id, t1.id]);
    expect([r.total, r.totals.amountCents]).toEqual([3, 7000]);
    r = await q('book=shop');
    expect(r.items.map((i: any) => i.id)).toEqual([t3.id, t1.id]);
    expect(r.totals.amountCents).toBe(5000);
    r = await q('book=icecream');
    expect(r.items.map((i: any) => i.id)).toEqual([t3.id, t2.id]);
    r = await q('book=telecom');
    expect(r.items.map((i: any) => i.id)).toEqual([t2.id, t1.id]);
    r = await q(`from=${daysAgo(3)}&to=${daysAgo(1)}`);
    expect(r.items.map((i: any) => i.id)).toEqual([t3.id, t2.id]);
    r = await q(`from=${daysAgo(3)}&to=${daysAgo(3)}`);
    expect(r.items.map((i: any) => i.id)).toEqual([t2.id]);
    r = await q(`from=${daysAhead(2)}`);
    expect(r).toEqual({ items: [], total: 0, totals: { amountCents: 0 } });
    r = await q('limit=1&offset=1');
    expect(r.items.map((i: any) => i.id)).toEqual([t2.id]);
    expect([r.total, r.totals.amountCents]).toEqual([3, 7000]); // totals ignore paging
    for (const bad of ['limit=0', 'limit=201', 'offset=-1', 'book=warehouse', 'status=draft', 'from=2026-02-30', 'to=abc', 'bogus=1']) {
      expect((await get(s.app, `/cash-transfers?${bad}`)).status, bad).toBe(400);
    }
    expect((await get(s.app, '/cash-transfers/99999')).status).toBe(404);
    expect((await get(s.app, '/cash-transfers/abc')).status).toBe(400);
  });

  it('transfers show in BOTH cash books with their funds (GET /cashbooks/:book)', async () => {
    const s = await setup();
    const t = (await tr(s, 'shop', 'icecream', 3000, { toFund: 'profit' })).body.item;
    const ice = (await get(s.app, '/cashbooks/icecream')).body;
    expect(ice.items.map((e: any) => [e.type, e.amountCents, e.fund, e.refTable, e.refId, e.runningBalanceCents])).toEqual([['transfer_in', 3000, 'profit', 'cash_transfers', t.id, 3000]]);
    const shop = (await get(s.app, '/cashbooks/shop')).body;
    expect(shop.items.map((e: any) => [e.type, e.amountCents, e.refTable, e.refId, e.runningBalanceCents])).toEqual([['transfer_out', -3000, 'cash_transfers', t.id, -3000]]);
  });
});

describe('one transaction - a failure leaves nothing behind', () => {
  it('a failure on the SECOND leg (the cash row of the destination) rolls back the transfer and the first leg; the same clientRef works after the fault', async () => {
    quiet();
    const s = await setup();
    await seedBooks(s, { shop: 50000 });
    const before = snap9(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_leg2 BEFORE INSERT ON cash_entries WHEN NEW.type = 'transfer_in' BEGIN SELECT RAISE(ABORT, 'leg boom'); END`);
    const clientRef = ref();
    expect((await tr(s, 'shop', 'telecom', 1000, { clientRef })).status).toBe(500);
    expect(snap9(s)).toEqual(before);
    expect(state(s)).toMatchObject({ shop: 50000, telecom: 0 });
    s.ctx.database.conn.exec('DROP TRIGGER test_break_leg2');
    expect((await tr(s, 'shop', 'telecom', 1000, { clientRef })).status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM cash_transfers')).toBe(1);
  });

  it('a failure on the Ice Cream fund row of the second leg rolls everything back', async () => {
    quiet();
    const s = await setup();
    const before = snap9(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_fund BEFORE INSERT ON icecream_fund_entries WHEN NEW.kind = 'transfer_in' BEGIN SELECT RAISE(ABORT, 'fund boom'); END`);
    expect((await tr(s, 'shop', 'icecream', 1000, { toFund: 'cost' })).status).toBe(500);
    expect(snap9(s)).toEqual(before);
    expect(iceInvariant(s)).toEqual({ funds: 0, book: 0, fundRows: 0, cashRows: 0 });
  });

  it('a failing audit row rolls back the transfer, both legs and the fund row', async () => {
    quiet();
    const s = await setup();
    const before = snap9(s);
    breakAudit(s.ctx, 'cash_transfer');
    expect((await tr(s, 'icecream', 'shop', 1000, { fromFund: 'cost' })).status).toBe(500);
    expect(snap9(s)).toEqual(before);
  });

  it('a failure on the SECOND reversing leg during a void leaves the transfer posted and every balance unchanged', async () => {
    quiet();
    const s = await setup();
    const t = (await tr(s, 'shop', 'telecom', 4000)).body.item;
    const after = snap9(s);
    const pre = state(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_rev BEFORE INSERT ON cash_entries WHEN NEW.type = 'transfer_in' AND NEW.reverses_entry_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'rev boom'); END`);
    expect((await trVoid(s, t.id)).status).toBe(500);
    expect(snap9(s)).toEqual(after);
    expect(state(s)).toEqual(pre);
    expect((await get(s.app, `/cash-transfers/${t.id}`)).body.item.status).toBe('posted');
    s.ctx.database.conn.exec('DROP TRIGGER test_break_rev');
    expect((await trVoid(s, t.id)).status).toBe(200);
  });
});

describe('opening balances are unaffected by transfers (never revenue, never profit)', () => {
  it('capital/opening entries and transfers together: the sum of all three books only changes by opening balances', async () => {
    const s = await setup();
    await openNew(s, 'shop', { amountCents: 100000 });
    await tr(s, 'shop', 'telecom', 40000);
    await tr(s, 'telecom', 'icecream', 15000, { toFund: 'profit' });
    const st = state(s);
    expect(st.shop + st.telecom + st.icecream).toBe(100000);
    expect(st.profit).toBe(15000);
  });
});
