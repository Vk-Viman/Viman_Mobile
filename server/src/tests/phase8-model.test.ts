// Phase 8 randomized model check (BUSINESS_RULES sections 2, 7, 8, 9, 10.1, 10.2; R1, R9, C4). A seeded sequence of 400+ operations - expenses,
// printing supplies and sales, reloads, wallet top-ups, purchases, opening balances for all three books (and the three Ice Cream funds),
// cash counts with over/short, daily closings, reopens, voids of everything, duplicate submissions - is sent through the real API and
// compared, step by step, with an INDEPENDENT in-test model that knows only the written rules (it shares no code with the server):
//   - every request is answered exactly as the model predicts (201/200, DAY_CLOSED, DAY_ALREADY_CLOSED, OPENING_BALANCE_EXISTS ...);
//   - after the run each cash book balance = the sum of its ledger rows = the model; the ledger endpoint, paged, returns the model's rows
//     in (business date, posting) order with the model's running balances; period opening / in / out / closing agree with the model;
//   - Ice Cream: Cost + Electricity + Profit = the Ice Cream book at every check, and `reconcileIceCream` agrees;
//   - the closed days reported by the API (status endpoint and ledger) are exactly the model's closed set.
// The seed makes a failure reproducible: the failing step number and seed are in the assertion message.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, num } from './helpers/phase4.ts';
import { providerIds } from './helpers/phase6.ts';
import { psNew, psVoid, supNew, supVoid } from './helpers/phase7.ts';
import { bookBal, closeNew, countNew, countVoid, expNew, expVoid, fundBal, openNew, capVoid, reopenNew, rng } from './helpers/phase8.ts';
import type { Book, Fund } from './helpers/phase8.ts';
import { reconcileIceCream } from '../services/cashbooks.service.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const BOOKS: Book[] = ['shop', 'telecom', 'icecream'];
const FUNDS: Fund[] = ['cost', 'electricity', 'profit'];

/** One ledger row of the model: the date, the signed amount, the fund (Ice Cream) and the posting order. */
interface MEntry { date: string; amount: number; fund: Fund | null; seq: number }
interface MRecord { id: number; book: Book; date: string; amount: number; fund?: Fund | null; voided: boolean; kind: string }

class Model {
  seq = 0;
  entries: Record<Book, MEntry[]> = { shop: [], telecom: [], icecream: [] };
  closed = new Set<string>();
  closingId = new Map<string, number>();
  records: MRecord[] = [];
  push(book: Book, date: string, amount: number, fund: Fund | null = null): void {
    this.entries[book].push({ date, amount, fund, seq: this.seq++ });
  }
  isClosed(book: Book, date: string): boolean { return this.closed.has(`${book}|${date}`); }
  /** Balance of the book at the END of `date` (every entry dated on or before it). */
  expected(book: Book, date: string): number {
    return this.entries[book].filter((e) => e.date <= date).reduce((a, e) => a + e.amount, 0);
  }
  balance(book: Book): number { return this.entries[book].reduce((a, e) => a + e.amount, 0); }
  funds(): Record<Fund, number> {
    const f: Record<Fund, number> = { cost: 0, electricity: 0, profit: 0 };
    for (const e of this.entries.icecream) f[e.fund as Fund] += e.amount;
    return f;
  }
  sorted(book: Book): MEntry[] {
    return [...this.entries[book]].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  }
  hasOpening(book: Book, fund: Fund | null): boolean {
    return this.records.some((r) => r.kind === 'opening' && !r.voided && r.book === book && (r.fund ?? null) === fund);
  }
}

/** How often each interesting thing happened, so the test can prove the random run really exercised it. */
interface Stats { accepted: number; closedRejections: number; reopens: number; closings: number; nonZeroCounts: number; voids: number; openingExists: number; duplicates: number }

async function run(seed: number, steps: number): Promise<Stats> {
  const s = await apiBase(await env.build());
  const rnd = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const DATES = [0, 1, 2, 3, 4, 5].map((n) => (n === 0 ? today() : daysAgo(n)));
  const stats: Stats = { accepted: 0, closedRejections: 0, reopens: 0, closings: 0, nonZeroCounts: 0, voids: 0, openingExists: 0, duplicates: 0 };
  const m = new Model();
  const prov = await providerIds(s);
  const product = await mkProduct(s, { minPriceCents: 0 });
  let lastExpense: { body: Record<string, unknown>; id: number } | null = null;
  const at = (i: number, what: string) => `seed ${seed} step ${i}: ${what}`;

  /** Expects the answer the model predicts for a write dated on `date` in `book` (closed -> 409 DAY_CLOSED). */
  const expectClosed = (i: number, r: { status: number; body: any }, book: Book, date: string, what: string): void => {
    expect(r.status, at(i, `${what} ${JSON.stringify(r.body)}`)).toBe(409);
    expect(err(r), at(i, what)).toMatchObject({ code: 'DAY_CLOSED', book, businessDate: date });
    stats.closedRejections++;
  };

  async function oneStep(i: number): Promise<void> {
    const op = int(0, 99);
    const date = pick(DATES);

    if (op < 12) { // expense create (shop/telecom)
      const book = pick(['shop', 'telecom'] as const);
      const amount = int(100, 9999);
      const body = { businessDate: date, book, category: 'other', amountCents: amount, description: 'E', clientRef: ref() };
      const r = await expNew(s, body);
      if (m.isClosed(book, date)) return expectClosed(i, r, book, date, 'expense create');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push(book, date, -amount);
      m.records.push({ id: r.body.item.id, book, date, amount, voided: false, kind: 'expense' });
      lastExpense = { body, id: r.body.item.id };
    } else if (op < 19) { // void any expense / supply / reload / top-up / print sale / purchase
      const kinds = ['expense', 'supply', 'reload', 'topup', 'print', 'purchase'];
      const live = m.records.filter((r) => !r.voided && kinds.includes(r.kind));
      if (live.length === 0) return;
      const r = pick(live);
      const call = {
        expense: () => expVoid(s, r.id), supply: () => supVoid(s, r.id), print: () => psVoid(s, r.id),
        reload: () => post(s.app, `/reload-sales/${r.id}/void`, { reason: 'x' }), topup: () => post(s.app, `/telecom/topups/${r.id}/void`, { reason: 'x' }),
        purchase: () => post(s.app, `/purchases/${r.id}/void`, { reason: 'x' }),
      }[r.kind as 'expense']();
      const res = await call;
      if (m.isClosed(r.book, r.date)) return expectClosed(i, res, r.book, r.date, `void ${r.kind}`);
      expect(res.status, at(i, `void ${r.kind} ${JSON.stringify(res.body)}`)).toBe(200);
      stats.voids++;
      // the reversal is the exact negation of the original: cash-in kinds (reload, print sale) went in, the others went out
      m.push(r.book, r.date, r.kind === 'reload' || r.kind === 'print' ? -r.amount : r.amount);
      r.voided = true;
    } else if (op < 26) { // printing supply (shop cash out)
      const amount = int(100, 9999);
      const r = await supNew(s, { businessDate: date, amountCents: amount });
      if (m.isClosed('shop', date)) return expectClosed(i, r, 'shop', date, 'supply');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('shop', date, -amount);
      m.records.push({ id: r.body.item.id, book: 'shop', date, amount, voided: false, kind: 'supply' });
    } else if (op < 31) { // print sale (shop cash in): qty x 1,500
      const qty = int(1, 20);
      const r = await psNew(s, { businessDate: date, qty });
      if (m.isClosed('shop', date)) return expectClosed(i, r, 'shop', date, 'print sale');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('shop', date, qty * 1500);
      m.records.push({ id: r.body.item.id, book: 'shop', date, amount: qty * 1500, voided: false, kind: 'print' });
    } else if (op < 36) { // reload (telecom cash in the FULL collection)
      const amount = int(1000, 50000);
      const r = await post(s.app, '/reload-sales', { businessDate: date, providerId: prov.Dialog, salesCents: amount, clientRef: ref() });
      if (m.isClosed('telecom', date)) return expectClosed(i, r, 'telecom', date, 'reload');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('telecom', date, amount);
      m.records.push({ id: r.body.item.id, book: 'telecom', date, amount, voided: false, kind: 'reload' });
    } else if (op < 40) { // wallet top-up (telecom cash out)
      const amount = int(500, 20000);
      const r = await post(s.app, '/telecom/topups', { businessDate: date, kind: 'wallet_topup', amountCents: amount, clientRef: ref() });
      if (m.isClosed('telecom', date)) return expectClosed(i, r, 'telecom', date, 'topup');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('telecom', date, -amount);
      m.records.push({ id: r.body.item.id, book: 'telecom', date, amount, voided: false, kind: 'topup' });
    } else if (op < 43) { // shop purchase (cash out)
      const total = int(1000, 90000);
      const r = await post(s.app, '/purchases', { businessDate: date, items: [{ productId: product.id, packs: 1, packSize: 3, lineTotalCents: total }], clientRef: ref() });
      if (m.isClosed('shop', date)) return expectClosed(i, r, 'shop', date, 'purchase');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('shop', date, -total);
      m.records.push({ id: r.body.item.id, book: 'shop', date, amount: total, voided: false, kind: 'purchase' });
    } else if (op < 53) { // opening balance
      const book = pick(BOOKS);
      const fund = book === 'icecream' ? pick(FUNDS) : null;
      const amount = int(1000, 99999);
      const r = await openNew(s, book, { businessDate: date, amountCents: amount, ...(fund ? { fund } : {}) });
      if (m.isClosed(book, date)) return expectClosed(i, r, book, date, 'opening');
      if (m.hasOpening(book, fund)) {
        expect(r.status, at(i, 'opening exists')).toBe(409);
        expect(err(r).code, at(i, 'opening exists')).toBe('OPENING_BALANCE_EXISTS');
        stats.openingExists++;
        return;
      }
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push(book, date, amount, fund);
      m.records.push({ id: r.body.item.id, book, date, amount, fund, voided: false, kind: 'opening' });
    } else if (op < 57) { // void an opening balance
      const live = m.records.filter((r) => r.kind === 'opening' && !r.voided);
      if (live.length === 0) return;
      const r = pick(live);
      const res = await capVoid(s, r.id);
      if (m.isClosed(r.book, r.date)) return expectClosed(i, res, r.book, r.date, 'void opening');
      expect(res.status, at(i, JSON.stringify(res.body))).toBe(200);
      m.push(r.book, r.date, -r.amount, r.fund ?? null);
      r.voided = true;
    } else if (op < 72) { // cash count with over/short
      const book = pick(BOOKS);
      const expected = m.expected(book, date);
      const delta = pick([0, 0, 1, -1, int(-5000, 5000), int(-300, 300)]);
      const counted = Math.max(0, expected + delta);
      const diff = counted - expected;
      const fund = book === 'icecream' ? pick(FUNDS) : undefined;
      const r = await countNew(s, book, counted, { businessDate: date, note: 'n', ...(fund ? { fund } : {}) });
      if (m.isClosed(book, date)) return expectClosed(i, r, book, date, 'count');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      expect(r.body.item, at(i, 'count figures')).toMatchObject({ expectedCents: expected, countedCents: counted, differenceCents: diff });
      if (diff !== 0) { m.push(book, date, diff, book === 'icecream' ? (fund as Fund) : null); stats.nonZeroCounts++; }
      m.records.push({ id: r.body.item.id, book, date, amount: diff, fund: book === 'icecream' && diff !== 0 ? (fund as Fund) : null, voided: false, kind: 'count' });
    } else if (op < 77) { // void a count
      const live = m.records.filter((r) => r.kind === 'count' && !r.voided);
      if (live.length === 0) return;
      const r = pick(live);
      const res = await countVoid(s, r.id);
      if (m.isClosed(r.book, r.date)) return expectClosed(i, res, r.book, r.date, 'void count');
      expect(res.status, at(i, JSON.stringify(res.body))).toBe(200);
      if (r.amount !== 0) m.push(r.book, r.date, -r.amount, r.fund ?? null);
      r.voided = true;
    } else if (op < 90) { // close a day (optionally with a count)
      const book = pick(BOOKS);
      const withCount = rnd() < 0.45;
      const expected = m.expected(book, date);
      const counted = Math.max(0, expected + pick([0, 3, -3, int(-2000, 2000)]));
      const diff = counted - expected;
      const fund = book === 'icecream' ? pick(FUNDS) : undefined;
      const r = await closeNew(s, book, date, { ...(withCount ? { countedCents: counted, note: 'n' } : {}), ...(fund && withCount ? { fund } : {}) });
      if (m.isClosed(book, date)) {
        expect(r.status, at(i, 'already closed')).toBe(409);
        expect(err(r).code, at(i, 'already closed')).toBe('DAY_ALREADY_CLOSED');
        return;
      }
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      expect(r.body.item.expectedCents, at(i, 'closing expected')).toBe(expected);
      if (withCount && diff !== 0) m.push(book, date, diff, book === 'icecream' ? (fund as Fund) : null);
      if (withCount) m.records.push({ id: r.body.count.id, book, date, amount: diff, fund: book === 'icecream' && diff !== 0 ? (fund as Fund) : null, voided: false, kind: 'count' });
      stats.closings++;
      m.closed.add(`${book}|${date}`);
      m.closingId.set(`${book}|${date}`, r.body.item.id);
    } else if (op < 96) { // reopen a closed day
      const keys = [...m.closed];
      if (keys.length === 0) return;
      const key = pick(keys);
      const res = await reopenNew(s, m.closingId.get(key) as number, 'fixing a mistake');
      expect(res.status, at(i, JSON.stringify(res.body))).toBe(200);
      stats.reopens++;
      m.closed.delete(key);
    } else { // duplicate submission of the last expense: the first record again, nothing new (even if its day is closed now)
      if (!lastExpense) return;
      const r = await post(s.app, '/expenses', lastExpense.body);
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(200);
      expect(r.body.item.id, at(i, 'duplicate returns the first expense')).toBe(lastExpense.id);
      stats.duplicates++;
    }
  }

  async function verify(i: number): Promise<void> {
    const sum = (await get(s.app, '/cashbooks')).body;
    for (const book of BOOKS) {
      const modelBal = m.balance(book);
      expect(bookBal(s, book), at(i, `${book} ledger sum`)).toBe(modelBal);
      expect(sum.books.find((b: any) => b.book === book).balanceCents, at(i, `${book} summary`)).toBe(modelBal);
      // the paged ledger = the model rows in (date, posting) order, with running balances
      const rows = m.sorted(book);
      const got: any[] = [];
      for (let off = 0; ; off += 13) {
        const p = (await get(s.app, `/cashbooks/${book}?limit=13&offset=${off}`)).body;
        expect(p.total, at(i, `${book} total`)).toBe(rows.length);
        got.push(...p.items);
        if (got.length >= p.total) break;
      }
      let run = 0;
      expect(got.map((r) => [r.businessDate, r.amountCents, r.runningBalanceCents, r.fund]), at(i, `${book} ledger rows`)).toEqual(
        rows.map((r) => { run += r.amount; return [r.date, r.amount, run, book === 'icecream' ? r.fund : null]; }));
      // a random period
      const a = pick(DATES);
      const b = pick(DATES);
      const [from, to] = a <= b ? [a, b] : [b, a];
      const per = (await get(s.app, `/cashbooks/${book}?from=${from}&to=${to}&limit=200`)).body;
      const inP = rows.filter((r) => r.date >= from && r.date <= to);
      const opening = rows.filter((r) => r.date < from).reduce((x, r) => x + r.amount, 0);
      const inC = inP.filter((r) => r.amount > 0).reduce((x, r) => x + r.amount, 0);
      const outC = inP.filter((r) => r.amount < 0).reduce((x, r) => x - r.amount, 0);
      expect({ o: per.openingCents, i: per.inCents, u: per.outCents, c: per.closingCents }, at(i, `${book} period ${from}..${to}`)).toEqual({ o: opening, i: inC, u: outC, c: opening + inC - outC });
      expect(per.closedDates, at(i, `${book} closed dates`)).toEqual(DATES.filter((d) => d >= from && d <= to && m.isClosed(book, d)).sort());
    }
    // Ice Cream funds
    const mf = m.funds();
    expect(fundBal(s), at(i, 'fund balances')).toEqual(mf);
    expect(mf.cost + mf.electricity + mf.profit, at(i, 'model funds = book')).toBe(m.balance('icecream'));
    expect(reconcileIceCream(s.ctx.database.conn), at(i, 'reconcile')).toMatchObject({ ok: true, differenceCents: 0, byFund: mf });
    expect(sum.books.find((b: any) => b.book === 'icecream').funds, at(i, 'summary funds')).toEqual(mf);
    // closed set
    for (const book of BOOKS) {
      for (const d of DATES) {
        const st = (await get(s.app, `/daily-closings/status?book=${book}&businessDate=${d}`)).body.isClosed;
        expect(st, at(i, `status ${book} ${d}`)).toBe(m.isClosed(book, d));
      }
    }
  }

  for (let i = 1; i <= steps; i++) {
    const before = m.seq;
    await oneStep(i);
    if (m.seq > before) stats.accepted++;
    if (i % 60 === 0) await verify(i);
  }
  await verify(steps);
  // every ledger row has its source record: no orphan cash entries, and each Ice Cream cash entry has exactly one same-amount fund row
  expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE book = 'icecream'"), `seed ${seed} icecream cash rows`).toBe(m.entries.icecream.length);
  expect(num(s, 'SELECT COUNT(*) FROM icecream_fund_entries'), `seed ${seed} fund rows`).toBe(m.entries.icecream.length);
  expect(num(s, 'SELECT COUNT(*) FROM cash_entries'), `seed ${seed} all cash rows`).toBe(BOOKS.reduce((a, b) => a + m.entries[b].length, 0));
  return stats;
}

describe('Phase 8 seeded random sequence vs an independent model', () => {
  it('seed 20261111: 420 mixed operations (expenses, supplies, sales, reloads, top-ups, purchases, openings, counts, closings, reopens, voids, duplicates)', async () => {
    const st = await run(20261111, 420);
    // the run really exercised the closed-day rule, closings, reopens, over/short counts, voids, duplicates and the opening-balance guard
    expect(st.accepted).toBeGreaterThan(150);
    expect(st.closedRejections).toBeGreaterThan(10);
    expect(st.closings).toBeGreaterThan(15);
    expect(st.reopens).toBeGreaterThan(3);
    expect(st.nonZeroCounts).toBeGreaterThan(10);
    expect(st.voids).toBeGreaterThan(10);
    expect(st.openingExists).toBeGreaterThan(3);
    expect(st.duplicates).toBeGreaterThan(2);
  }, 180000);

  it('seed 7: 300 more operations on a fresh database (a different interleaving of closes and reopens)', async () => {
    const st = await run(7, 300);
    expect(st.accepted).toBeGreaterThan(100);
    expect(st.closedRejections).toBeGreaterThan(5);
  }, 180000);
});

// The API date rules for this phase (R-FD) and the follow-up (INVALID_BUSINESS_DATE) as seen by a client.
describe('dates at the API: an impossible date such as 2020-13-01 is a 400 everywhere a business date is accepted', () => {
  it('expenses, opening balances, counts, closings, purchases, sales, supplies, reloads: 400 VALIDATION_ERROR, nothing written', async () => {
    const s: ApiBase = await apiBase(await env.build());
    const bad = '2020-13-01';
    const p = await mkProduct(s);
    const prov = await providerIds(s);
    const before = num(s, 'SELECT (SELECT COUNT(*) FROM cash_entries) + (SELECT COUNT(*) FROM audit_logs)');
    const attempts = [
      expNew(s, { businessDate: bad }), openNew(s, 'shop', { businessDate: bad }), countNew(s, 'shop', 0, { businessDate: bad }),
      closeNew(s, 'shop', bad), supNew(s, { businessDate: bad }), psNew(s, { businessDate: bad }),
      post(s.app, '/purchases', { businessDate: bad, items: [{ productId: p.id, packs: 1, packSize: 1, lineTotalCents: 100 }], clientRef: ref() }),
      post(s.app, '/reload-sales', { businessDate: bad, providerId: prov.Dialog, salesCents: 100, clientRef: ref() }),
      post(s.app, '/sales', { businessDate: bad, items: [{ productId: p.id, qty: 1, unitPriceCents: 100 }], clientRef: ref() }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields)).toContain('businessDate');
    }
    expect(num(s, 'SELECT (SELECT COUNT(*) FROM cash_entries) + (SELECT COUNT(*) FROM audit_logs)')).toBe(before);
  });
});
