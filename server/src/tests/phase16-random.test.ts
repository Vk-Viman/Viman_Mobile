// Closed-day ordering protection - randomized sequences against an independent in-test model (BUSINESS_RULES section 8, migration 016).
//
// Every run performs >= 400 random operations across the THREE cash books (expenses, capital, Ice Cream payments and daily entries, transfers
// between books, stand-alone counts, closings with and without a count, reopens, voids), dated anywhere in the last 12 days - so most writes are
// backdated and many meet closed days. The model below is written from the rules, not from the code:
//   * 13D: the unit of every rule is the SCOPE: Shop, Ice Cream, or ONE Telecom segment (the run draws from three of the eight: Dialog Cards,
//     Dialog Reloads, Mobitel Reloads). A day closed in one scope never touches another; the ledger, the closings, counts and the "expected" figure of a
//     closing are all per scope; a transfer touches the scope of each leg (a Telecom-to-Telecom transfer touches two);
//   * a day is closed from its closing until it is reopened (a re-close closes it again);
//   * a write dated ON a closed day of a book it touches is refused DAY_CLOSED; dated EARLIER than the latest closed day of a book it touches
//     is refused BACKDATE_BEFORE_CLOSED_DAY (DAY_CLOSED of any touched scope wins; scopes are examined in shop, telecom (segment display order), icecream order);
//   * a void is judged on the record's own date (its reversal copies it); a count (or its void) that posts no cash entry only needs an open day;
//   * closing a day with a count posts the adjustment dated like the day (same rule); closing without a count posts nothing and is always allowed.
// After EVERY operation the test proves the headline guarantee: for every day that is closed right now, the scope balance as of that day
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
/** The Telecom segments the run draws from (display order = the order the server examines them in). */
const TSEGS = ['dialog_cards', 'dialog_reloads', 'mobitel_reloads'] as const;
/** A cash scope: a book, or one Telecom segment. */
interface Scope { book: Book; seg?: string }
const SCOPES: Scope[] = [{ book: 'shop' }, ...TSEGS.map((seg) => ({ book: 'telecom' as Book, seg })), { book: 'icecream' }];
const key = (sc: Scope): string => (sc.seg ? `${sc.book}:${sc.seg}` : sc.book);
const ORDER = (sc: Scope): number => SCOPES.findIndex((x) => key(x) === key(sc));
const same = (a: Scope, b: Scope): boolean => key(a) === key(b);
const segOf = (sc: Scope): Record<string, unknown> => (sc.seg ? { segment: sc.seg } : {});
const FUNDS: Fund[] = ['cost', 'electricity', 'profit'];
const DATES = Array.from({ length: 12 }, (_, n) => daysAgo(n)); // today ... 11 days ago

interface Leg { scope: Scope; amount: number }
interface Rec {
  kind: 'expense' | 'capital' | 'payment' | 'transfer' | 'day' | 'count'; id: number; date: string; scopes: Scope[]; legs: Leg[]; voided: boolean;
  /** Ice Cream daily entries are voided by date. */
  dayDate?: string;
}

class Model {
  entries: Array<{ scope: Scope; date: string; amount: number }> = [];
  closed = new Map<string, number>(); // `${scope}|${date}` -> balance of the scope as of that day when it was closed (after any adjustment)
  closingId = new Map<string, number>();
  recs: Rec[] = [];
  postedDays = new Set<string>();
  push(legs: Leg[], date: string): void { for (const l of legs) if (l.amount !== 0) this.entries.push({ scope: l.scope, date, amount: l.amount }); }
  asOf(scope: Scope, date: string): number { return this.entries.filter((e) => same(e.scope, scope) && e.date <= date).reduce((a, e) => a + e.amount, 0); }
  total(scope: Scope): number { return this.entries.filter((e) => same(e.scope, scope)).reduce((a, e) => a + e.amount, 0); }
  bookTotal(book: Book): number { return this.entries.filter((e) => e.scope.book === book).reduce((a, e) => a + e.amount, 0); }
  isClosed(scope: Scope, date: string): boolean { return this.closed.has(`${key(scope)}|${date}`); }
  latest(scope: Scope): string | null {
    let best: string | null = null;
    for (const k of this.closed.keys()) { const [sc, d] = k.split('|') as [string, string]; if (sc === key(scope) && (best === null || d > best)) best = d; }
    return best;
  }
  /** The independent statement of the rule. `scopes` empty = nothing touched. */
  refusal(scopes: Scope[], date: string, money = true): { code: string; scope: Scope; closedDate?: string } | null {
    const touched = [...scopes].sort((x, y) => ORDER(x) - ORDER(y));
    const exact = touched.find((sc) => this.isClosed(sc, date));
    if (exact) return { code: 'DAY_CLOSED', scope: exact };
    if (!money) return null;
    for (const sc of touched) {
      const l = this.latest(sc);
      if (l !== null && l > date) return { code: 'BACKDATE_BEFORE_CLOSED_DAY', scope: sc, closedDate: l };
    }
    return null;
  }
}

interface Stats { accepted: number; acceptedBackdated: number; dayClosed: number; backdate: number; closeVarianceRefused: number; closeOk: number; closeNoCountAfterLater: number;
  reopens: number; crossSegmentAccepted: number; voids: number; voidRefused: number; transfers: number; counts: number; iceDays: number; dayExists: number }

async function run(seed: number, steps: number): Promise<Stats> {
  const s: ApiBase = await apiBase(await env.build());
  const rnd = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const m = new Model();
  const st: Stats = { accepted: 0, acceptedBackdated: 0, dayClosed: 0, backdate: 0, closeVarianceRefused: 0, closeOk: 0, closeNoCountAfterLater: 0, reopens: 0, crossSegmentAccepted: 0, voids: 0,
    voidRefused: 0, transfers: 0, counts: 0, iceDays: 0, dayExists: 0 };
  const at = (i: number, what: string) => `seed ${seed} step ${i}: ${what}`;
  const sqlAsOf = (sc: Scope, date: string): number =>
    num(s, `SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND business_date <= ?${sc.seg ? ' AND segment = ?' : ''}`, ...(sc.seg ? [sc.book, date, sc.seg] : [sc.book, date]));
  const pickScope = (books: readonly Book[] = BOOKS): Scope => pick(SCOPES.filter((x) => books.includes(x.book)));

  /** The refused answer the model demands; counts the kind of refusal. */
  const expectRefused = (i: number, r: { status: number; body: any }, ref: { code: string; scope: Scope; closedDate?: string }, date: string, what: string): void => {
    expect(r.status, at(i, `${what} should be refused (${ref.code}): ${JSON.stringify(r.body)}`)).toBe(409);
    // the body names the scope: the book and, for Telecom, the segment (and no segment for Shop / Ice Cream)
    expect(err(r), at(i, what)).toMatchObject({ code: ref.code, book: ref.scope.book, businessDate: date, ...(ref.closedDate ? { closedDate: ref.closedDate } : {}) });
    expect(err(r).segment, at(i, `${what}: the refusal names the segment`)).toBe(ref.scope.seg);
    if (ref.code === 'DAY_CLOSED') st.dayClosed++; else st.backdate++;
  };

  /** The guarantee, checked after every operation. */
  const noDrift = (i: number, what: string): void => {
    for (const [k, snapshot] of m.closed) {
      const [scopeKey, date] = k.split('|') as [string, string];
      const sc = SCOPES.find((x) => key(x) === scopeKey)!;
      expect(sqlAsOf(sc, date), at(i, `${what}: the balance of ${scopeKey} as of closed day ${date} drifted`)).toBe(snapshot);
    }
  };

  /** An accepted Telecom write dated on / before a day that is closed in ANOTHER Telecom segment: the isolation the model asserts (13D). */
  const noteCross = (sc: Scope, date: string): void => {
    if (sc.book === 'telecom' && SCOPES.some((o) => o.book === 'telecom' && !same(o, sc) && (m.isClosed(o, date) || (m.latest(o) ?? '') > date))) st.crossSegmentAccepted++;
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
      const sc = pickScope(['shop', 'telecom']);
      const amount = int(100, 9999);
      const r = await expNew(s, { businessDate: date, book: sc.book, category: 'other', amountCents: amount, description: 'E', ...segOf(sc) });
      const ref = m.refusal([sc], date);
      if (ref) return expectRefused(i, r, ref, date, 'expense');
      created(i, r, date, 'expense');
      noteCross(sc, date);
      const legs = [{ scope: sc, amount: -amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.item.id, date, scopes: [sc], legs, voided: false });
    } else if (kind === 'capital') {
      const sc = pickScope();
      const amount = int(100, 9999);
      const fund = sc.book === 'icecream' ? pick(FUNDS) : undefined;
      const r = await capNew(s, { businessDate: date, book: sc.book, amountCents: amount, ...(fund ? { fund } : {}), ...segOf(sc) });
      const ref = m.refusal([sc], date);
      if (ref) return expectRefused(i, r, ref, date, 'capital');
      created(i, r, date, 'capital');
      noteCross(sc, date);
      const legs = [{ scope: sc, amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.item.id, date, scopes: [sc], legs, voided: false });
    } else if (kind === 'payment') {
      const amount = int(50, 3000);
      const r = await payNew(s, 'materials', amount, { businessDate: date });
      const ICE: Scope = { book: 'icecream' };
      const ref = m.refusal([ICE], date);
      if (ref) return expectRefused(i, r, ref, date, 'payment');
      created(i, r, date, 'payment');
      const legs = [{ scope: ICE, amount: -amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.payment.id, date, scopes: [ICE], legs, voided: false });
    } else if (kind === 'transfer') {
      const from = pickScope();
      const to = pick(SCOPES.filter((x) => !same(x, from))); // a Telecom-to-Telecom transfer (two segments) is allowed
      const amount = int(100, 5000);
      const r = await tr(s, from.book, to.book, amount, {
        businessDate: date, ...(from.book === 'icecream' ? { fromFund: pick(FUNDS) } : {}), ...(to.book === 'icecream' ? { toFund: pick(FUNDS) } : {}),
        ...(from.seg ? { fromSegment: from.seg } : {}), ...(to.seg ? { toSegment: to.seg } : {}),
      });
      const ref = m.refusal([from, to], date);
      if (ref) return expectRefused(i, r, ref, date, 'transfer');
      created(i, r, date, 'transfer');
      st.transfers++;
      const legs = [{ scope: from, amount: -amount }, { scope: to, amount }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.item.id, date, scopes: [from, to], legs, voided: false });
    } else if (kind === 'day') {
      const sales = int(0, 5000);
      const cost = Math.floor(sales / 2);
      const elec = Math.floor(sales / 5);
      const r = await dayNew(s, { businessDate: date, salesCents: sales, costAllocCents: cost, electricityAllocCents: elec });
      const ICE: Scope = { book: 'icecream' };
      const ref = m.refusal([ICE], date); // a record trigger guards even a zero-sales day (no cash entry)
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
      const legs = [{ scope: ICE, amount: sales }];
      m.push(legs, date);
      m.recs.push({ kind, id: r.body.day.id, date, scopes: [ICE], legs, voided: false, dayDate: date });
    } else { // stand-alone count
      const sc = pickScope();
      const expected = m.asOf(sc, date);
      const counted = Math.max(0, expected + pick([0, 0, 7, -7, int(-3000, 3000)]));
      const diff = counted - expected;
      const fund = sc.book === 'icecream' && diff !== 0 ? pick(FUNDS) : undefined;
      const r = await countNew(s, sc.book, counted, { businessDate: date, note: 'n', ...(fund ? { fund } : {}), ...segOf(sc) });
      const ref = m.refusal([sc], date, diff !== 0);
      if (ref) return expectRefused(i, r, ref, date, 'count');
      created(i, r, date, 'count');
      st.counts++;
      expect(r.body.item, at(i, 'count figures')).toMatchObject({ expectedCents: expected, countedCents: counted, differenceCents: diff });
      const legs = diff !== 0 ? [{ scope: sc, amount: diff }] : [];
      m.push(legs, date);
      m.recs.push({ kind: 'count', id: r.body.item.id, date, scopes: [sc], legs, voided: false });
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
    const ref = m.refusal(rec.scopes, rec.date, rec.legs.length > 0);
    if (ref) { st.voidRefused++; return expectRefused(i, r, ref, rec.date, `void ${rec.kind}`); }
    expect(r.status, at(i, `void ${rec.kind} #${rec.id}: ${JSON.stringify(r.body)}`)).toBe(200);
    st.voids++;
    rec.voided = true;
    if (rec.kind === 'day') m.postedDays.delete(rec.date);
    m.push(rec.legs.map((l) => ({ ...l, amount: -l.amount })), rec.date);
  }

  async function closeStep(i: number): Promise<void> {
    const sc = pickScope();
    const date = pick(DATES);
    const withCount = rnd() < 0.5;
    const expected = m.asOf(sc, date);
    const counted = Math.max(0, expected + pick([0, 5, -5, int(-2000, 2000)]));
    const diff = withCount ? counted - expected : 0;
    const fund = sc.book === 'icecream' && withCount && diff !== 0 ? pick(FUNDS) : undefined;
    const r = await closeNew(s, sc.book, date, { ...(withCount ? { countedCents: counted, note: 'n' } : {}), ...(fund ? { fund } : {}), ...segOf(sc) });
    if (m.isClosed(sc, date)) {
      expect(r.status, at(i, 'already closed')).toBe(409);
      expect(err(r).code, at(i, 'already closed')).toBe('DAY_ALREADY_CLOSED');
      return;
    }
    const ref = diff !== 0 ? m.refusal([sc], date) : null;
    if (ref) { st.closeVarianceRefused++; return expectRefused(i, r, ref, date, 'closing with a variance'); }
    expect(r.status, at(i, `close ${key(sc)} ${date}: ${JSON.stringify(r.body)}`)).toBe(201);
    st.closeOk++;
    const later = m.latest(sc);
    if (later !== null && later > date && diff === 0) st.closeNoCountAfterLater++; // out of order but posts nothing: allowed
    expect(r.body.item.expectedCents, at(i, 'closing expected')).toBe(expected);
    expect(r.body.item.overShortCents, at(i, 'closing over/short')).toBe(diff);
    expect(r.body.item.segment ?? undefined, at(i, 'closing segment')).toBe(sc.seg);
    if (withCount) {
      expect(r.body.item.countedCents, at(i, 'closing counted')).toBe(counted);
      m.recs.push({ kind: 'count', id: r.body.count.id, date, scopes: [sc], legs: diff !== 0 ? [{ scope: sc, amount: diff }] : [], voided: false });
    }
    m.push(diff !== 0 ? [{ scope: sc, amount: diff }] : [], date);
    m.closed.set(`${key(sc)}|${date}`, m.asOf(sc, date));
    m.closingId.set(`${key(sc)}|${date}`, r.body.item.id);
    expect(sqlAsOf(sc, date), at(i, 'the balance right after the closing')).toBe(withCount ? counted : expected);
  }

  async function reopenStep(i: number): Promise<void> {
    const keys = [...m.closed.keys()];
    if (keys.length === 0) return;
    const k = pick(keys);
    const r = await reopenNew(s, m.closingId.get(k) as number, 'model reopen');
    expect(r.status, at(i, `reopen ${k}: ${JSON.stringify(r.body)}`)).toBe(200);
    st.reopens++;
    m.closed.delete(k);
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

  // ---- final: ledgers equal the model (per scope AND per book), and the stored closing figures agree with the ledger for every closed day ----
  for (const sc of SCOPES) expect(sqlAsOf(sc, '9999-12-31'), `seed ${seed}: ${key(sc)} ledger vs model`).toBe(m.total(sc));
  for (const b of BOOKS) expect(num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', b), `seed ${seed}: ${b} ledger vs model`).toBe(m.bookTotal(b));
  // the segments the run never writes stay empty: the Telecom total is the sum of the drawn segments
  expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE book = 'telecom' AND segment NOT IN ('dialog_cards','dialog_reloads','mobitel_reloads')"), `seed ${seed}: untouched segments`).toBe(0);
  const closings = (await get(s.app, '/daily-closings')).body.items as Array<{ book: Book; segment: string | null; businessDate: string; isClosed: boolean; expectedCents: number; overShortCents: number }>;
  const ck = (c: { book: Book; segment: string | null; businessDate: string }) => `${c.segment ? `${c.book}:${c.segment}` : c.book}|${c.businessDate}`;
  expect(closings.filter((c) => c.isClosed).map(ck).sort(), `seed ${seed}: closed set`).toEqual([...m.closed.keys()].sort());
  for (const c of closings.filter((x) => x.isClosed)) {
    expect(sqlAsOf({ book: c.book, seg: c.segment ?? undefined }, c.businessDate), `seed ${seed}: closed ${ck(c)}: ledger balance as of the day = stored expected + over/short`)
      .toBe(c.expectedCents + c.overShortCents);
  }
  return st;
}

describe('closed-day ordering - randomized sequences vs an independent model', () => {
  it.each([16001, 7, 2718281])('seed %i: 560 operations; every request answered as the model says and no closed day ever drifts', async (seed) => {
    const st = await run(seed, 560);
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
    expect(st.crossSegmentAccepted).toBeGreaterThan(3); // a closed day in one Telecom segment never blocked another segment
  }, 240000);

  it('a longer run (seed 99): 600 operations, with more closings in the mix of dates', async () => {
    const st = await run(99, 600);
    expect(st.backdate + st.dayClosed).toBeGreaterThan(30);
    expect(st.closeNoCountAfterLater + st.closeVarianceRefused).toBeGreaterThan(5);
  }, 240000);
});
