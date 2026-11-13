// Phase 19: DATE-POLICY-AWARE variant of the phase 8 randomized model test (copy of phase8-model.test.ts with an unchanged independent model).
// After the closed-day ordering rule (BUSINESS_RULES section 8, migration 016) the original generator's uniformly random dates are mostly refused,
// which forced its scenario thresholds down. Here ~78% of the writes get a date the model knows is permitted (strictly after the latest closed day of
// the touched book, or any date when none is closed) and the rest get any date, so refusals (DAY_CLOSED, BACKDATE_BEFORE_CLOSED_DAY, ...) stay covered.
// The ORIGINAL pre-rule thresholds are asserted, plus per-category coverage: every operation category accepted at least N times and every documented
// refusal code seen at least once.

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
import { Cov, biased, statsLine } from './helpers/phase19m.ts';
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
  /** The latest currently-closed date of a book, or null (closed-day ordering protection, section 8). */
  latest(book: Book): string | null {
    let best: string | null = null;
    for (const k of this.closed) { const [b, d] = k.split('|'); if (b === book && (best === null || (d as string) > best)) best = d as string; }
    return best;
  }
  /**
   * Why a write dated `date` in `book` is refused, or null. `money` = the write posts a cash entry (a count that matches, or the void of one, posts
   * none and only needs an open day): DAY_CLOSED on a closed day, BACKDATE_BEFORE_CLOSED_DAY when a later day is closed.
   */
  refusal(book: Book, date: string, money = true): 'DAY_CLOSED' | 'BACKDATE_BEFORE_CLOSED_DAY' | null {
    if (this.isClosed(book, date)) return 'DAY_CLOSED';
    const l = this.latest(book);
    return money && l !== null && l > date ? 'BACKDATE_BEFORE_CLOSED_DAY' : null;
  }
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
export interface Stats { accepted: number; closedRejections: number; reopens: number; closings: number; nonZeroCounts: number; voids: number; openingExists: number; duplicates: number }

async function run(seed: number, steps: number): Promise<{ stats: Stats; cov: Cov }> {
  const s = await apiBase(await env.build());
  const rnd = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const DATES = [0, 1, 2, 3, 4, 5].map((n) => (n === 0 ? today() : daysAgo(n)));
  const stats: Stats = { accepted: 0, closedRejections: 0, reopens: 0, closings: 0, nonZeroCounts: 0, voids: 0, openingExists: 0, duplicates: 0 };
  const m = new Model();
  const cov = new Cov();
  const prov = await providerIds(s);
  const product = await mkProduct(s, { minPriceCents: 0 });
  let lastExpense: { body: Record<string, unknown>; id: number } | null = null;
  const at = (i: number, what: string) => `seed ${seed} step ${i}: ${what}`;
  /** A date for a write touching `book`: usually one the model knows is permitted, sometimes any (possibly blocked) date. */
  const dateFor = (book: Book): string => biased(rnd, DATES, (d) => m.refusal(book, d) === null);
  /** A record to void: usually one whose void is permitted, sometimes any. */
  const pickRec = <T extends { book: Book; date: string }>(xs: T[]): T => {
    const ok = xs.filter((r) => m.refusal(r.book, r.date) === null);
    return ok.length > 0 && rnd() < 0.78 ? pick(ok) : pick(xs);
  };

  /** Expects the answer the model predicts for a refused write dated `date` in `book` (409 DAY_CLOSED, or BACKDATE_BEFORE_CLOSED_DAY before a closed day). */
  const expectClosed = (i: number, r: { status: number; body: any }, book: Book, date: string, what: string, money = true): void => {
    expect(r.status, at(i, `${what} ${JSON.stringify(r.body)}`)).toBe(409);
    if (m.refusal(book, date, money) === 'DAY_CLOSED') expect(err(r), at(i, what)).toMatchObject({ code: 'DAY_CLOSED', book, businessDate: date });
    else expect(err(r), at(i, what)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book, businessDate: date, closedDate: m.latest(book) });
    stats.closedRejections++;
    cov.hit(`${m.refusal(book, date, money)}:${what}`);
  };

  async function oneStep(i: number): Promise<void> {
    const op = int(0, 99);

    if (op < 12) { // expense create (shop/telecom)
      const book = pick(['shop', 'telecom'] as const);
      const date = dateFor(book);
      const amount = int(100, 9999);
      const body = { businessDate: date, book, category: 'other', amountCents: amount, description: 'E', clientRef: ref() };
      const r = await expNew(s, body);
      if (m.refusal(book, date)) return expectClosed(i, r, book, date, 'expense');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push(book, date, -amount);
      cov.hit('ok:expense');
      m.records.push({ id: r.body.item.id, book, date, amount, voided: false, kind: 'expense' });
      lastExpense = { body, id: r.body.item.id };
    } else if (op < 19) { // void any expense / supply / reload / top-up / print sale / purchase
      const kinds = ['expense', 'supply', 'reload', 'topup', 'print', 'purchase'];
      const live = m.records.filter((r) => !r.voided && kinds.includes(r.kind));
      if (live.length === 0) return;
      // choose the KIND first (uniform over the kinds that have a live record) so the rarer kinds are voided as often as the common ones
      const liveKinds = kinds.filter((k) => live.some((x) => x.kind === k));
      const kind = pick(liveKinds);
      const r = pickRec(live.filter((x) => x.kind === kind));
      const call = {
        expense: () => expVoid(s, r.id), supply: () => supVoid(s, r.id), print: () => psVoid(s, r.id),
        reload: () => post(s.app, `/reload-sales/${r.id}/void`, { reason: 'x' }), topup: () => post(s.app, `/telecom/topups/${r.id}/void`, { reason: 'x' }),
        purchase: () => post(s.app, `/purchases/${r.id}/void`, { reason: 'x' }),
      }[r.kind as 'expense']();
      const res = await call;
      if (m.refusal(r.book, r.date)) return expectClosed(i, res, r.book, r.date, `void ${r.kind}`);
      expect(res.status, at(i, `void ${r.kind} ${JSON.stringify(res.body)}`)).toBe(200);
      stats.voids++;
      cov.hit(`ok:void ${r.kind}`);
      // the reversal is the exact negation of the original: cash-in kinds (reload, print sale) went in, the others went out
      m.push(r.book, r.date, r.kind === 'reload' || r.kind === 'print' ? -r.amount : r.amount);
      r.voided = true;
    } else if (op < 26) { // printing supply (shop cash out)
      const date = dateFor('shop');
      const amount = int(100, 9999);
      const r = await supNew(s, { businessDate: date, amountCents: amount });
      if (m.refusal('shop', date)) return expectClosed(i, r, 'shop', date, 'supply');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('shop', date, -amount);
      cov.hit('ok:supply');
      m.records.push({ id: r.body.item.id, book: 'shop', date, amount, voided: false, kind: 'supply' });
    } else if (op < 31) { // print sale (shop cash in): qty x 1,500
      const date = dateFor('shop');
      const qty = int(1, 20);
      const r = await psNew(s, { businessDate: date, qty });
      if (m.refusal('shop', date)) return expectClosed(i, r, 'shop', date, 'print');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('shop', date, qty * 1500);
      cov.hit('ok:print');
      m.records.push({ id: r.body.item.id, book: 'shop', date, amount: qty * 1500, voided: false, kind: 'print' });
    } else if (op < 36) { // reload (telecom cash in the FULL collection)
      const date = dateFor('telecom');
      const amount = int(1000, 50000);
      const r = await post(s.app, '/reload-sales', { businessDate: date, providerId: prov.Dialog, salesCents: amount, clientRef: ref() });
      if (m.refusal('telecom', date)) return expectClosed(i, r, 'telecom', date, 'reload');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('telecom', date, amount);
      cov.hit('ok:reload');
      m.records.push({ id: r.body.item.id, book: 'telecom', date, amount, voided: false, kind: 'reload' });
    } else if (op < 40) { // wallet top-up (telecom cash out)
      const date = dateFor('telecom');
      const amount = int(500, 20000);
      const r = await post(s.app, '/telecom/topups', { businessDate: date, kind: 'wallet_topup', amountCents: amount, clientRef: ref() });
      if (m.refusal('telecom', date)) return expectClosed(i, r, 'telecom', date, 'topup');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('telecom', date, -amount);
      cov.hit('ok:topup');
      m.records.push({ id: r.body.item.id, book: 'telecom', date, amount, voided: false, kind: 'topup' });
    } else if (op < 43) { // shop purchase (cash out)
      const date = dateFor('shop');
      const total = int(1000, 90000);
      const r = await post(s.app, '/purchases', { businessDate: date, items: [{ productId: product.id, packs: 1, packSize: 3, lineTotalCents: total }], clientRef: ref() });
      if (m.refusal('shop', date)) return expectClosed(i, r, 'shop', date, 'purchase');
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push('shop', date, -total);
      cov.hit('ok:purchase');
      m.records.push({ id: r.body.item.id, book: 'shop', date, amount: total, voided: false, kind: 'purchase' });
    } else if (op < 53) { // opening balance
      const book = pick(BOOKS);
      const date = dateFor(book);
      const fund = book === 'icecream' ? pick(FUNDS) : null;
      const amount = int(1000, 99999);
      const r = await openNew(s, book, { businessDate: date, amountCents: amount, ...(fund ? { fund } : {}) });
      if (m.refusal(book, date)) return expectClosed(i, r, book, date, 'opening');
      if (m.hasOpening(book, fund)) {
        expect(r.status, at(i, 'opening exists')).toBe(409);
        expect(err(r).code, at(i, 'opening exists')).toBe('OPENING_BALANCE_EXISTS');
        stats.openingExists++;
        cov.hit('OPENING_BALANCE_EXISTS:opening');
        return;
      }
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      m.push(book, date, amount, fund);
      cov.hit('ok:opening');
      m.records.push({ id: r.body.item.id, book, date, amount, fund, voided: false, kind: 'opening' });
    } else if (op < 57) { // void an opening balance
      const live = m.records.filter((r) => r.kind === 'opening' && !r.voided);
      if (live.length === 0) return;
      const r = pickRec(live);
      const res = await capVoid(s, r.id);
      if (m.refusal(r.book, r.date)) return expectClosed(i, res, r.book, r.date, 'void opening');
      expect(res.status, at(i, JSON.stringify(res.body))).toBe(200);
      m.push(r.book, r.date, -r.amount, r.fund ?? null);
      cov.hit('ok:void opening');
      r.voided = true;
    } else if (op < 72) { // cash count with over/short
      const book = pick(BOOKS);
      const date = dateFor(book);
      const expected = m.expected(book, date);
      const delta = pick([0, 0, 1, -1, int(-5000, 5000), int(-300, 300)]);
      const counted = Math.max(0, expected + delta);
      const diff = counted - expected;
      const fund = book === 'icecream' ? pick(FUNDS) : undefined;
      const r = await countNew(s, book, counted, { businessDate: date, note: 'n', ...(fund ? { fund } : {}) });
      if (m.refusal(book, date, diff !== 0)) return expectClosed(i, r, book, date, 'count', diff !== 0);
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      expect(r.body.item, at(i, 'count figures')).toMatchObject({ expectedCents: expected, countedCents: counted, differenceCents: diff });
      if (diff !== 0) { m.push(book, date, diff, book === 'icecream' ? (fund as Fund) : null); stats.nonZeroCounts++; }
      cov.hit(diff !== 0 ? 'ok:count' : 'ok:count (matching)');
      m.records.push({ id: r.body.item.id, book, date, amount: diff, fund: book === 'icecream' && diff !== 0 ? (fund as Fund) : null, voided: false, kind: 'count' });
    } else if (op < 77) { // void a count
      const live = m.records.filter((r) => r.kind === 'count' && !r.voided);
      if (live.length === 0) return;
      const r = pickRec(live);
      const res = await countVoid(s, r.id);
      if (m.refusal(r.book, r.date, r.amount !== 0)) return expectClosed(i, res, r.book, r.date, 'void count', r.amount !== 0);
      expect(res.status, at(i, JSON.stringify(res.body))).toBe(200);
      if (r.amount !== 0) m.push(r.book, r.date, -r.amount, r.fund ?? null);
      cov.hit('ok:void count');
      r.voided = true;
    } else if (op < 90) { // close a day (optionally with a count)
      const book = pick(BOOKS);
      // closings lean to the older days so they leave the newer days open for permitted writes (still any day 20% of the time)
      const date = rnd() < 0.8 ? pick(DATES.slice(3)) : pick(DATES);
      const withCount = rnd() < 0.45;
      const expected = m.expected(book, date);
      const counted = Math.max(0, expected + pick([0, 3, -3, int(-2000, 2000)]));
      const diff = counted - expected;
      const fund = book === 'icecream' ? pick(FUNDS) : undefined;
      const r = await closeNew(s, book, date, { ...(withCount ? { countedCents: counted, note: 'n' } : {}), ...(fund && withCount ? { fund } : {}) });
      if (m.isClosed(book, date)) {
        expect(r.status, at(i, 'already closed')).toBe(409);
        expect(err(r).code, at(i, 'already closed')).toBe('DAY_ALREADY_CLOSED');
        cov.hit('DAY_ALREADY_CLOSED:closing');
        return;
      }
      // a count whose adjustment would post a cash entry dated before a later closed day is refused (section 8); no count or a matching one is allowed
      if (withCount && m.refusal(book, date, diff !== 0)) return expectClosed(i, r, book, date, 'closing', diff !== 0);
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(201);
      expect(r.body.item.expectedCents, at(i, 'closing expected')).toBe(expected);
      if (withCount && diff !== 0) m.push(book, date, diff, book === 'icecream' ? (fund as Fund) : null);
      if (withCount) m.records.push({ id: r.body.count.id, book, date, amount: diff, fund: book === 'icecream' && diff !== 0 ? (fund as Fund) : null, voided: false, kind: 'count' });
      stats.closings++;
      cov.hit('ok:closing');
      m.closed.add(`${book}|${date}`);
      m.closingId.set(`${book}|${date}`, r.body.item.id);
    } else if (op < 96) { // reopen a closed day
      const keys = [...m.closed];
      if (keys.length === 0) return;
      const key = pick(keys);
      const res = await reopenNew(s, m.closingId.get(key) as number, 'fixing a mistake');
      expect(res.status, at(i, JSON.stringify(res.body))).toBe(200);
      stats.reopens++;
      cov.hit('ok:reopen');
      m.closed.delete(key);
    } else { // duplicate submission of the last expense: the first record again, nothing new (even if its day is closed now)
      if (!lastExpense) return;
      const r = await post(s.app, '/expenses', lastExpense.body);
      expect(r.status, at(i, JSON.stringify(r.body))).toBe(200);
      expect(r.body.item.id, at(i, 'duplicate returns the first expense')).toBe(lastExpense.id);
      stats.duplicates++;
      cov.hit('ok:duplicate expense');
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
  console.log(statsLine(`ledger seed ${seed}/${steps}`, { ...stats }));
  console.log(cov.line(`[phase19m] ledger seed ${seed} coverage`));
  return { stats, cov };
}

const WRITE_CATEGORIES = ['expense', 'supply', 'print', 'reload', 'topup', 'purchase', 'opening', 'count', 'count (matching)', 'closing', 'reopen', 'duplicate expense'];
const VOID_CATEGORIES = ['void expense', 'void supply', 'void print', 'void reload', 'void topup', 'void purchase', 'void opening', 'void count'];

/** Per-scenario coverage: every category accepted at least `minOk` times (voids `minVoid`) and every documented refusal code seen at least `minCode` times. */
function assertCoverage(cov: Cov, minOk: number, minVoid: number, minCode: number): void {
  for (const c of WRITE_CATEGORIES) expect(cov.get(`ok:${c}`), `accepted ${c}`).toBeGreaterThanOrEqual(minOk);
  for (const c of VOID_CATEGORIES) expect(cov.get(`ok:${c}`), `accepted ${c}`).toBeGreaterThanOrEqual(minVoid);
  expect(cov.sum('DAY_CLOSED:'), 'DAY_CLOSED refusals').toBeGreaterThanOrEqual(minCode);
  expect(cov.sum('BACKDATE_BEFORE_CLOSED_DAY:'), 'BACKDATE_BEFORE_CLOSED_DAY refusals').toBeGreaterThanOrEqual(minCode);
  expect(cov.get('DAY_ALREADY_CLOSED:closing'), 'DAY_ALREADY_CLOSED').toBeGreaterThanOrEqual(minCode);
  expect(cov.get('OPENING_BALANCE_EXISTS:opening'), 'OPENING_BALANCE_EXISTS').toBeGreaterThanOrEqual(minCode);
  // both closed-day refusals hit plain money writes, not only closings, and a void is refused on a closed day too
  for (const code of ['DAY_CLOSED', 'BACKDATE_BEFORE_CLOSED_DAY']) {
    expect(['expense', 'supply', 'print', 'reload', 'topup', 'purchase', 'opening'].reduce((a, c) => a + cov.get(`${code}:${c}`), 0), `${code} on a money write`).toBeGreaterThan(0);
  }
  expect(cov.sum('DAY_CLOSED:void') + cov.sum('BACKDATE_BEFORE_CLOSED_DAY:void'), 'a void refused by a closed day').toBeGreaterThan(0);
}

describe('Phase 19 date-policy-aware ledger model (phase 8 scenarios, original thresholds restored)', () => {
  it('seed 20261111: 420 mixed operations', async () => {
    const { stats: st, cov } = await run(20261111, 420);
    // the ORIGINAL pre-rule thresholds of phase8-model.test.ts (commit 81d0f8d)
    expect(st.accepted).toBeGreaterThan(150);
    expect(st.closedRejections).toBeGreaterThan(10);
    expect(st.closings).toBeGreaterThan(15);
    expect(st.reopens).toBeGreaterThan(3);
    expect(st.nonZeroCounts).toBeGreaterThan(10);
    expect(st.voids).toBeGreaterThan(10);
    expect(st.openingExists).toBeGreaterThan(3);
    expect(st.duplicates).toBeGreaterThan(2);
    assertCoverage(cov, 5, 2, 3);
  }, 240000);

  it('seed 7: 300 more operations on a fresh database', async () => {
    const { stats: st, cov } = await run(7, 300);
    expect(st.accepted).toBeGreaterThan(100);
    expect(st.closedRejections).toBeGreaterThan(5);
    assertCoverage(cov, 3, 1, 1);
  }, 240000);
});
