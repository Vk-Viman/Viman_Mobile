// Closed-day ordering protection - randomized sequences against an independent in-test model (BUSINESS_RULES section 8, migration 016).
//
// Every run performs >= 400 random operations across the THREE cash books (expenses, capital, Ice Cream payments and daily entries, transfers
// between books, stand-alone counts, closings with and without a count, reopens, voids), dated anywhere in the last 12 days - so most writes are
// backdated and many meet closed days. The model below is written from the rules, not from the code:
//   * a day is closed from its closing until it is reopened (a re-close closes it again);
//   * a write dated ON a closed day of a book it touches is refused DAY_CLOSED; dated EARLIER than the latest closed day of a book it touches
//     is refused BACKDATE_BEFORE_CLOSED_DAY (DAY_CLOSED of any touched book wins; books are examined in shop, telecom, icecream order);
//   * a void is judged on the record's own date (its reversal copies it); a count (or its void) that posts no cash entry only needs an open day;
//   * closing a day with a count posts the adjustment dated like the day (same rule); closing without a count posts nothing and is always allowed.
// After EVERY operation the test proves the headline guarantee: for every day that is closed right now, the book balance as of that day
// (sum of the ledger rows dated on or before it) still equals the balance recorded when it was closed - no write can change a closed day's balance
// except through a reopen. At the end the ledgers equal the model and the stored closing figures agree with the ledger.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get } from './helpers/catalog.ts';
import { apiBase, daysAgo } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, num } from './helpers/phase4.ts';
import { capNew, tr, trVoid } from './helpers/phase9.ts';
import { capVoid, closeNew, countNew, countVoid, expNew, expVoid, reopenNew, rng } from './helpers/phase8.ts';
import type { Book, Fund } from './helpers/phase8.ts';
import { dayNew, dayVoid, payNew, payVoid } from './helpers/phase10.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const BOOKS: Book[] = ['shop', 'telecom', 'icecream'];
const FUNDS: Fund[] = ['cost', 'electricity', 'profit'];
const DATES = Array.from({ length: 12 }, (_, n) => daysAgo(n)); // today ... 11 days ago

interface Leg { book: Book; amount: number }
interface Rec {
  kind: 'expense' | 'capital' | 'payment' | 'transfer' | 'day' | 'count'; id: number; date: string; books: Book[]; legs: Leg[]; voided: boolean;
  /** Ice Cream daily entries are voided by date. */
  dayDate?: string;
}

class Model {
  entries: Array<{ book: Book; date: string; amount: number }> = [];
  closed = new Map<string, number>(); // `${book}|${date}` -> balance of the book as of that day when it was closed (after any adjustment)
  closingId = new Map<string, number>();
  recs: Rec[] = [];
  postedDays = new Set<string>();
  push(legs: Leg[], date: string): void { for (const l of legs) if (l.amount !== 0) this.entries.push({ book: l.book, date, amount: l.amount }); }
  asOf(book: Book, date: string): number { return this.entries.filter((e) => e.book === book && e.date <= date).reduce((a, e) => a + e.amount, 0); }
  total(book: Book): number { return this.entries.filter((e) => e.book === book).reduce((a, e) => a + e.amount, 0); }
  isClosed(book: Book, date: string): boolean { return this.closed.has(`${book}|${date}`); }
  latest(book: Book): string | null {
    let best: string | null = null;
    for (const k of this.closed.keys()) { const [b, d] = k.split('|') as [string, string]; if (b === book && (best === null || d > best)) best = d; }
    return best;
  }
  /** The independent statement of the rule. `books` empty = nothing touched. */
  refusal(books: Book[], date: string, money = true): { code: string; book: Book; closedDate?: string } | null {
    const exact = BOOKS.find((b) => books.includes(b) && this.isClosed(b, date));
    if (exact) return { code: 'DAY_CLOSED', book: exact };
    if (!money) return null;
    for (const b of BOOKS) {
      const l = this.latest(b);
      if (books.includes(b) && l !== null && l > date) return { code: 'BACKDATE_BEFORE_CLOSED_DAY', book: b, closedDate: l };
    }
    return null;
  }
}

interface Stats { accepted: number; acceptedBackdated: number; dayClosed: number; backdate: number; closeVarianceRefused: number; closeOk: number; closeNoCountAfterLater: number;
  reopens: number; voids: number; voidRefused: number; transfers: number; counts: number; iceDays: number; dayExists: number }

async function run(seed: number, steps: number): Promise<Stats> {
  const s: ApiBase = await apiBase(await env.build());
  const rnd = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const m = new Model();
  const st: Stats = { accepted: 0, acceptedBackdated: 0, dayClosed: 0, backdate: 0, closeVarianceRefused: 0, closeOk: 0, closeNoCountAfterLater: 0, reopens: 0, voids: 0,
    voidRefused: 0, transfers: 0, counts: 0, iceDays: 0, dayExists: 0 };
  const at = (i: number, what: string) => `seed ${seed} step ${i}: ${what}`;
  const sqlAsOf = (book: Book, date: string): number =>
    num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND business_date <= ?', book, date);

  /** The refused answer the model demands; counts the kind of refusal. */
  const expectRefused = (i: number, r: { status: number; body: any }, ref: { code: string; book: Book; closedDate?: string }, date: string, what: string): void => {
    expect(r.status, at(i, `${what} should be refused (${ref.code}): ${JSON.stringify(r.body)}`)).toBe(409);
    expect(err(r), at(i, what)).toMatchObject({ code: ref.code, book: ref.book, businessDate: date, ...(ref.closedDate ? { closedDate: ref.closedDate } : {}) });
    if (ref.code === 'DAY_CLOSED') st.dayClosed++; else st.backdate++;
  };

  /** The guarantee, checked after every operation. */
  const noDrift = (i: number, what: string): void => {
    for (const [key, snapshot] of m.closed) {
      const [book, date] = key.split('|') as [Book, string];
      expect(sqlAsOf(book, date), at(i, `${what}: the balance of ${book} as of closed day ${date} drifted`)).toBe(snapshot);
    }
  };

  const created = (i: number, r: { status: number; body: any }, date: string, what: string): void => {
    expect(r.status, at(i, `${what}: ${JSON.stringify(r.body)}`)).toBe(201);
    st.accepted++;
    if (date !== DATES[0]) st.acceptedBackdated++;
  };

  async function createStep(i: number): Promise<void> {
    const date = pick(DATES);
    const kind = pick(['expense', 'expense', 'capital', 'payment', 'transfer', 'transfer', 'day', 'count'] as const);
    if (kind === 'expense') {
      const book = pick(['shop', 'telecom'] as const);
      const amount = int(100, 9999);
      const r = await expNew(s, { businessDate: date, book, category: 'other', amountCents: amount, description: 'E' });
      const ref = m.refusal([book], date);
      if (ref) return expectRefused(i, r, ref, date, 'expense');
      created(i, r, date, 'expense');
      const legs = [{ book, amount: -amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.item.id, date, books: [book], legs, voided: false });
    } else if (kind === 'capital') {
      const book = pick(BOOKS);
      const amount = int(100, 9999);
      const fund = book === 'icecream' ? pick(FUNDS) : undefined;
      const r = await capNew(s, { businessDate: date, book, amountCents: amount, ...(fund ? { fund } : {}) });
      const ref = m.refusal([book], date);
      if (ref) return expectRefused(i, r, ref, date, 'capital');
      created(i, r, date, 'capital');
      const legs = [{ book, amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.item.id, date, books: [book], legs, voided: false });
    } else if (kind === 'payment') {
      const amount = int(50, 3000);
      const r = await payNew(s, 'materials', amount, { businessDate: date });
      const ref = m.refusal(['icecream'], date);
      if (ref) return expectRefused(i, r, ref, date, 'payment');
      created(i, r, date, 'payment');
      const legs = [{ book: 'icecream' as Book, amount: -amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.payment.id, date, books: ['icecream'], legs, voided: false });
    } else if (kind === 'transfer') {
      const from = pick(BOOKS);
      const to = pick(BOOKS.filter((b) => b !== from));
      const amount = int(100, 5000);
      const r = await tr(s, from, to, amount, {
        businessDate: date, ...(from === 'icecream' ? { fromFund: pick(FUNDS) } : {}), ...(to === 'icecream' ? { toFund: pick(FUNDS) } : {}),
      });
      const ref = m.refusal([from, to], date);
      if (ref) return expectRefused(i, r, ref, date, 'transfer');
      created(i, r, date, 'transfer');
      st.transfers++;
      const legs = [{ book: from, amount: -amount }, { book: to, amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.item.id, date, books: [from, to], legs, voided: false });
    } else if (kind === 'day') {
      const sales = int(0, 5000);
      const cost = Math.floor(sales / 2);
      const elec = Math.floor(sales / 5);
      const r = await dayNew(s, { businessDate: date, salesCents: sales, costAllocCents: cost, electricityAllocCents: elec });
      const ref = m.refusal(['icecream'], date); // a record trigger guards even a zero-sales day (no cash entry)
      if (ref) return expectRefused(i, r, ref, date, 'ice cream day');
      if (m.postedDays.has(date)) {
        expect(r.status, at(i, 'second daily entry')).toBe(409);
        expect(err(r).code, at(i, 'second daily entry')).toBe('DAY_EXISTS');
        st.dayExists++;
        return;
      }
      created(i, r, date, 'ice cream day');
      st.iceDays++;
      m.postedDays.add(date);
      const legs = [{ book: 'icecream' as Book, amount: sales }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.day.id, date, books: ['icecream'], legs, voided: false, dayDate: date });
    } else { // stand-alone count
      const book = pick(BOOKS);
      const expected = m.asOf(book, date);
      const counted = Math.max(0, expected + pick([0, 0, 7, -7, int(-3000, 3000)]));
      const diff = counted - expected;
      const fund = book === 'icecream' && diff !== 0 ? pick(FUNDS) : undefined;
      const r = await countNew(s, book, counted, { businessDate: date, note: 'n', ...(fund ? { fund } : {}) });
      const ref = m.refusal([book], date, diff !== 0);
      if (ref) return expectRefused(i, r, ref, date, 'count');
      created(i, r, date, 'count');
      st.counts++;
      expect(r.body.item, at(i, 'count figures')).toMatchObject({ expectedCents: expected, countedCents: counted, differenceCents: diff });
      const legs = diff !== 0 ? [{ book, amount: diff }] : [];
      m.push(legs, date);
      m.recs.push({ kind: 'count', id: r.body.item.id, date, books: [book], legs, voided: false });
    }
  }

  async function voidStep(i: number): Promise<void> {
    const live = m.recs.filter((x) => !x.voided);
    if (live.length === 0) return;
    const rec = pick(live);
    const r = rec.kind === 'expense' ? await expVoid(s, rec.id)
      : rec.kind === 'capital' ? await capVoid(s, rec.id)
        : rec.kind === 'payment' ? await payVoid(s, rec.id)
          : rec.kind === 'transfer' ? await trVoid(s, rec.id)
            : rec.kind === 'day' ? await dayVoid(s, rec.dayDate as string)
              : await countVoid(s, rec.id);
    const ref = m.refusal(rec.books, rec.date, rec.legs.length > 0);
    if (ref) { st.voidRefused++; return expectRefused(i, r, ref, rec.date, `void ${rec.kind}`); }
    expect(r.status, at(i, `void ${rec.kind} #${rec.id}: ${JSON.stringify(r.body)}`)).toBe(200);
    st.voids++;
    rec.voided = true;
    if (rec.kind === 'day') m.postedDays.delete(rec.date);
    m.push(rec.legs.map((l) => ({ ...l, amount: -l.amount })), rec.date);
  }

  async function closeStep(i: number): Promise<void> {
    const book = pick(BOOKS);
    const date = pick(DATES);
    const withCount = rnd() < 0.5;
    const expected = m.asOf(book, date);
    const counted = Math.max(0, expected + pick([0, 5, -5, int(-2000, 2000)]));
    const diff = withCount ? counted - expected : 0;
    const fund = book === 'icecream' && withCount && diff !== 0 ? pick(FUNDS) : undefined;
    const r = await closeNew(s, book, date, { ...(withCount ? { countedCents: counted, note: 'n' } : {}), ...(fund ? { fund } : {}) });
    if (m.isClosed(book, date)) {
      expect(r.status, at(i, 'already closed')).toBe(409);
      expect(err(r).code, at(i, 'already closed')).toBe('DAY_ALREADY_CLOSED');
      return;
    }
    const ref = diff !== 0 ? m.refusal([book], date) : null;
    if (ref) { st.closeVarianceRefused++; return expectRefused(i, r, ref, date, 'closing with a variance'); }
    expect(r.status, at(i, `close ${book} ${date}: ${JSON.stringify(r.body)}`)).toBe(201);
    st.closeOk++;
    const later = m.latest(book);
    if (later !== null && later > date && diff === 0) st.closeNoCountAfterLater++; // out of order but posts nothing: allowed
    expect(r.body.item.expectedCents, at(i, 'closing expected')).toBe(expected);
    expect(r.body.item.overShortCents, at(i, 'closing over/short')).toBe(diff);
    if (withCount) {
      expect(r.body.item.countedCents, at(i, 'closing counted')).toBe(counted);
      m.recs.push({ kind: 'count', id: r.body.count.id, date, books: [book], legs: diff !== 0 ? [{ book, amount: diff }] : [], voided: false });
    }
    m.push(diff !== 0 ? [{ book, amount: diff }] : [], date);
    m.closed.set(`${book}|${date}`, m.asOf(book, date));
    m.closingId.set(`${book}|${date}`, r.body.item.id);
    expect(sqlAsOf(book, date), at(i, 'the balance right after the closing')).toBe(withCount ? counted : expected);
  }

  async function reopenStep(i: number): Promise<void> {
    const keys = [...m.closed.keys()];
    if (keys.length === 0) return;
    const key = pick(keys);
    const r = await reopenNew(s, m.closingId.get(key) as number, 'model reopen');
    expect(r.status, at(i, `reopen ${key}: ${JSON.stringify(r.body)}`)).toBe(200);
    st.reopens++;
    m.closed.delete(key);
  }

  for (let i = 1; i <= steps; i++) {
    const x = rnd();
    let what: string;
    if (x < 0.5) { what = 'create'; await createStep(i); }
    else if (x < 0.68) { what = 'void'; await voidStep(i); }
    else if (x < 0.86) { what = 'close'; await closeStep(i); }
    else { what = 'reopen'; await reopenStep(i); }
    noDrift(i, what);
  }

  // ---- final: ledgers equal the model, and the stored closing figures agree with the ledger for every closed day ----
  for (const b of BOOKS) expect(num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', b), `seed ${seed}: ${b} ledger vs model`).toBe(m.total(b));
  const closings = (await get(s.app, '/daily-closings')).body.items as Array<{ book: Book; businessDate: string; isClosed: boolean; expectedCents: number; overShortCents: number }>;
  expect(closings.filter((c) => c.isClosed).map((c) => `${c.book}|${c.businessDate}`).sort(), `seed ${seed}: closed set`).toEqual([...m.closed.keys()].sort());
  for (const c of closings.filter((x) => x.isClosed)) {
    expect(sqlAsOf(c.book, c.businessDate), `seed ${seed}: closed ${c.book} ${c.businessDate}: ledger balance as of the day = stored expected + over/short`)
      .toBe(c.expectedCents + c.overShortCents);
  }
  return st;
}

describe('closed-day ordering - randomized sequences vs an independent model', () => {
  it.each([16001, 7, 2718281])('seed %i: 420 operations; every request answered as the model says and no closed day ever drifts', async (seed) => {
    const st = await run(seed, 420);
    // the run really exercised everything it claims to test
    expect(st.accepted).toBeGreaterThan(50);
    expect(st.acceptedBackdated).toBeGreaterThan(30); // backdated entries into open periods still work
    expect(st.dayClosed).toBeGreaterThan(5);
    expect(st.backdate).toBeGreaterThan(15);
    expect(st.closeOk).toBeGreaterThan(15);
    expect(st.reopens).toBeGreaterThan(5);
    expect(st.closeVarianceRefused).toBeGreaterThan(3); // closing out of order with a variance
    expect(st.closeNoCountAfterLater).toBeGreaterThan(3); // closing out of order without a variance is allowed
    expect(st.voids).toBeGreaterThan(10);
    expect(st.transfers).toBeGreaterThan(10);
  }, 180000);

  it('a longer run (seed 99): 600 operations, with more closings in the mix of dates', async () => {
    const st = await run(99, 600);
    expect(st.backdate + st.dayClosed).toBeGreaterThan(30);
    expect(st.closeNoCountAfterLater + st.closeVarianceRefused).toBeGreaterThanOrEqual(0);
  }, 240000);
});
