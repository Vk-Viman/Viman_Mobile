// Phase 19: DATE-POLICY-AWARE variant of the phase 9 randomized model test (copy of phase9-model.test.ts with an unchanged independent model).
// After the closed-day ordering rule (BUSINESS_RULES section 8, migration 016) the original generator's uniformly random dates are often refused,
// which forced its thresholds down. Here ~78% of the writes get a date the model knows is permitted for every book the write touches (strictly after
// the latest closed day of each, or any date when none is closed) and the rest get any date, so DAY_CLOSED / BACKDATE_BEFORE_CLOSED_DAY refusals stay
// covered. The ORIGINAL pre-rule thresholds are asserted, plus per-category coverage (accepted at least N times, every error code seen).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, num } from './helpers/phase4.ts';
import { bookBal, closeNew, fundBal, reopenNew, rng } from './helpers/phase8.ts';
import type { Book, Fund } from './helpers/phase8.ts';
import { Cov, biased, statsLine } from './helpers/phase19m.ts';
import { capNew, drawCash, iceInvariant, trNew, trVoid } from './helpers/phase9.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const BOOKS: Book[] = ['shop', 'telecom', 'icecream'];
const FUNDS: Fund[] = ['cost', 'electricity', 'profit'];

interface MEntry { book: Book; fund: Fund | null; amount: number }
/** One business record of the model. `legs` are its ledger rows (signed); a void adds the negated rows. */
interface MRecord {
  kind: 'capital' | 'drawing' | 'transfer'; id: number; date: string; legs: MEntry[]; voided: boolean; amount: number; body: Record<string, unknown>;
  books: Book[]; to?: Book;
}

class Model {
  entries: MEntry[] = [];
  closed = new Set<string>();
  closingId = new Map<string, number>();
  records: MRecord[] = [];
  push(legs: MEntry[]): void { this.entries.push(...legs); }
  balance(book: Book): number { return this.entries.filter((e) => e.book === book).reduce((a, e) => a + e.amount, 0); }
  fund(f: Fund): number { return this.entries.filter((e) => e.book === 'icecream' && e.fund === f).reduce((a, e) => a + e.amount, 0); }
  isClosed(book: Book, date: string): boolean { return this.closed.has(`${book}|${date}`); }
  /** The latest currently-closed date of a book, or null. */
  latest(book: Book): string | null {
    let best: string | null = null;
    for (const k of this.closed) { const [b, d] = k.split('|'); if (b === book && (best === null || (d as string) > best)) best = d as string; }
    return best;
  }
  /**
   * Closed-day rules for a write dated `date` touching `books` (section 8): DAY_CLOSED when the day is closed for any of them (it wins, first book in
   * shop, telecom, icecream order), else BACKDATE_BEFORE_CLOSED_DAY naming the first book whose latest closed day is after `date`; undefined when open.
   */
  refusal(books: Book[], date: string): { code: 'DAY_CLOSED' | 'BACKDATE_BEFORE_CLOSED_DAY'; book: Book; closedDate?: string } | undefined {
    const exact = BOOKS.find((b) => books.includes(b) && this.isClosed(b, date));
    if (exact) return { code: 'DAY_CLOSED', book: exact };
    for (const b of BOOKS) {
      const l = this.latest(b);
      if (books.includes(b) && l !== null && l > date) return { code: 'BACKDATE_BEFORE_CLOSED_DAY', book: b, closedDate: l };
    }
    return undefined;
  }
  /** The warnings the rules require after a write that moved cash OUT of `books`: negative books and, for Ice Cream, negative funds. */
  warnings(books: Book[]): string[] {
    const out: string[] = [];
    for (const b of BOOKS) {
      if (!books.includes(b)) continue;
      const bal = this.balance(b);
      if (bal < 0) out.push(`NEGATIVE_CASH_BALANCE|${b}||${bal}`);
      if (b === 'icecream') for (const f of FUNDS) if (this.fund(f) < 0) out.push(`NEGATIVE_FUND_BALANCE|icecream|${f}|${this.fund(f)}`);
    }
    return out.sort();
  }
}

const key = (w: any): string => `${w.code}|${w.book}|${w.fund ?? ''}|${w.balanceCents}`;

export interface Stats { created: number; closedRefused: number; voids: number; alreadyVoid: number; duplicates: number; closings: number; reopens: number; transfers: number; icecreamLegs: number; negativeWarnings: number }

async function run(seed: number, steps: number): Promise<{ stats: Stats; cov: Cov }> {
  const s = await apiBase(await env.build());
  const rnd = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const DATES = [0, 1, 2, 3, 4].map((n) => (n === 0 ? today() : daysAgo(n)));
  const stats: Stats = { created: 0, closedRefused: 0, voids: 0, alreadyVoid: 0, duplicates: 0, closings: 0, reopens: 0, transfers: 0, icecreamLegs: 0, negativeWarnings: 0 };
  const m = new Model();
  const cov = new Cov();
  let last: MRecord | null = null;
  const at = (i: number, what: string) => `seed ${seed} step ${i}: ${what}`;

  const check = (i: number, what: string): void => {
    for (const b of BOOKS) expect(bookBal(s, b), at(i, `${what}: ${b} balance`)).toBe(m.balance(b));
    const f = fundBal(s);
    for (const x of FUNDS) expect(f[x], at(i, `${what}: ${x} fund`)).toBe(m.fund(x));
    const inv = iceInvariant(s);
    expect(inv.funds, at(i, `${what}: funds = book`)).toBe(inv.book);
    expect(inv.fundRows, at(i, `${what}: fund rows = ice cream cash rows`)).toBe(inv.cashRows);
    expect(inv.book, at(i, `${what}: ice cream book`)).toBe(m.balance('icecream'));
  };

  /** A random fund for Ice Cream sides, undefined otherwise. */
  const fundFor = (book: Book): { fund?: Fund } => (book === 'icecream' ? { fund: pick(FUNDS) } : {});

  /** A date for a write touching `books`: usually one the model knows is permitted, sometimes any (possibly blocked) date. */
  const dateFor = (books: Book[]): string => biased(rnd, DATES, (d) => m.refusal(books, d) === undefined);

  const create = async (i: number): Promise<void> => {
    const amount = int(1, 40) * 50; // 50 .. 2,000 cents
    const kind = pick(['capital', 'drawing', 'transfer', 'transfer'] as const);
    let rec: MRecord;
    let r: { status: number; body: any };
    if (kind === 'transfer') {
      const from = pick(BOOKS);
      const to = pick(BOOKS.filter((b) => b !== from));
      const date = dateFor([from, to]);
      const ff = fundFor(from);
      const tf = fundFor(to);
      const body = { businessDate: date, fromBook: from, toBook: to, ...(ff.fund ? { fromFund: ff.fund } : {}), ...(tf.fund ? { toFund: tf.fund } : {}), amountCents: amount, clientRef: ref() };
      rec = {
        kind, id: 0, date, voided: false, amount, body, books: [from, to], to,
        legs: [{ book: from, fund: ff.fund ?? null, amount: -amount }, { book: to, fund: tf.fund ?? null, amount }],
      };
      r = await trNew(s, body);
    } else {
      const book = pick(BOOKS);
      const date = dateFor([book]);
      const f = fundFor(book);
      if (kind === 'capital') {
        const body = { businessDate: date, book, ...(f.fund ? { fund: f.fund } : {}), amountCents: amount, clientRef: ref() };
        rec = { kind, id: 0, date, voided: false, amount, body, books: [book], legs: [{ book, fund: f.fund ?? null, amount }] };
        r = await capNew(s, body);
      } else {
        const body = { businessDate: date, book, ...(f.fund ? { fund: f.fund } : {}), amountCents: amount, clientRef: ref() };
        rec = { kind, id: 0, date, voided: false, amount, body, books: [book], legs: [{ book, fund: f.fund ?? null, amount: -amount }] };
        r = await drawCash(s, body);
      }
    }
    const date = rec.date;
    const refused = m.refusal(rec.books, date);
    if (refused) {
      cov.hit(`${refused.code}:${kind}`);
      expect(r.status, at(i, `${kind} refused (${refused.code} ${refused.book}): ${JSON.stringify(r.body)}`)).toBe(409);
      expect(err(r), at(i, 'closed error')).toMatchObject({ businessDate: date, ...refused });
      stats.closedRefused++;
      return;
    }
    expect(r.status, at(i, `${kind} create ${JSON.stringify(r.body)}`)).toBe(201);
    rec.id = r.body.item.id;
    m.push(rec.legs);
    m.records.push(rec);
    last = rec;
    stats.created++;
    cov.hit(`ok:${kind}`);
    if (kind === 'transfer') stats.transfers++;
    stats.icecreamLegs += rec.legs.filter((l) => l.book === 'icecream').length;
    // warnings = negative balances of the books the money LEFT (transfer: source book only; capital: none)
    const outBooks: Book[] = kind === 'capital' ? [] : [rec.legs[0]!.book];
    const expected = m.warnings(outBooks);
    expect(r.body.warnings.map(key).sort(), at(i, `${kind} warnings`)).toEqual(expected);
    stats.negativeWarnings += expected.length;
    check(i, `after ${kind} #${rec.id} on ${date}`);
  };

  const voidOne = async (i: number): Promise<void> => {
    if (m.records.length === 0) return;
    // pick the KIND first so every kind is voided about equally often; usually a record whose void the model knows is permitted
    const kind = pick(['capital', 'drawing', 'transfer'] as const);
    const ofKind = m.records.filter((x) => x.kind === kind);
    if (ofKind.length === 0) return;
    const okRecs = ofKind.filter((x) => m.refusal(x.books, x.date) === undefined);
    const rec = okRecs.length > 0 && rnd() < 0.78 ? pick(okRecs) : pick(ofKind);
    const url = rec.kind === 'transfer' ? `/cash-transfers/${rec.id}/void` : rec.kind === 'drawing' ? `/drawings/${rec.id}/void` : `/capital-entries/${rec.id}/void`;
    const r = rec.kind === 'transfer' ? await trVoid(s, rec.id) : await post(s.app, url, { reason: 'model void' });
    const refused = m.refusal(rec.books, rec.date);
    if (refused) {
      cov.hit(`${refused.code}:void ${rec.kind}`);
      expect(r.status, at(i, `void ${rec.kind} refused (${refused.code} ${refused.book})`)).toBe(409);
      expect(err(r), at(i, 'void closed error')).toMatchObject({ businessDate: rec.date, ...refused });
      stats.closedRefused++;
      return;
    }
    if (rec.voided) {
      expect(r.status, at(i, `void ${rec.kind} twice`)).toBe(409);
      expect(err(r).code).toBe('ALREADY_VOID');
      stats.alreadyVoid++;
      cov.hit(`ALREADY_VOID:void ${rec.kind}`);
      return;
    }
    expect(r.status, at(i, `void ${rec.kind} ${JSON.stringify(r.body)}`)).toBe(200);
    rec.voided = true;
    m.push(rec.legs.map((l) => ({ ...l, amount: -l.amount })));
    stats.voids++;
    cov.hit(`ok:void ${rec.kind}`);
    // a void takes cash out of: the destination of a transfer, the book of a capital entry; a drawing void only returns money
    const outBooks: Book[] = rec.kind === 'transfer' ? [rec.to as Book] : rec.kind === 'capital' ? rec.books : [];
    if (rec.kind !== 'drawing') {
      expect(r.body.warnings.map(key).sort(), at(i, `void ${rec.kind} warnings`)).toEqual(m.warnings(outBooks));
    }
    check(i, `after void ${rec.kind} #${rec.id}`);
  };

  const duplicate = async (i: number): Promise<void> => {
    if (!last) return;
    const rec = last as MRecord;
    const before = [m.balance('shop'), m.balance('telecom'), m.balance('icecream')];
    const r = rec.kind === 'transfer' ? await trNew(s, rec.body) : rec.kind === 'capital' ? await capNew(s, rec.body) : await drawCash(s, rec.body);
    expect(r.status, at(i, `duplicate ${rec.kind}`)).toBe(200);
    expect(r.body.item.id).toBe(rec.id);
    expect(r.body.warnings).toEqual([]);
    expect([m.balance('shop'), m.balance('telecom'), m.balance('icecream')]).toEqual(before);
    stats.duplicates++;
    cov.hit(`ok:duplicate ${rec.kind}`);
    check(i, 'after duplicate');
  };

  const close = async (i: number): Promise<void> => {
    const book = pick(BOOKS);
    // closings lean to the older days so they leave the newer days open for permitted writes (still any day 20% of the time)
    const date = rnd() < 0.8 ? pick(DATES.slice(2)) : pick(DATES);
    if (m.isClosed(book, date)) return;
    const r = await closeNew(s, book, date);
    expect(r.status, at(i, `close ${book} ${date} ${JSON.stringify(r.body)}`)).toBe(201);
    m.closed.add(`${book}|${date}`);
    m.closingId.set(`${book}|${date}`, r.body.item.id);
    stats.closings++;
    cov.hit('ok:closing');
  };

  const reopen = async (i: number): Promise<void> => {
    const keys = [...m.closed];
    if (keys.length === 0) return;
    const k = pick(keys);
    const r = await reopenNew(s, m.closingId.get(k) as number);
    expect(r.status, at(i, `reopen ${k} ${JSON.stringify(r.body)}`)).toBe(200);
    m.closed.delete(k);
    stats.reopens++;
    cov.hit('ok:reopen');
  };

  for (let i = 1; i <= steps; i++) {
    const x = rnd();
    if (x < 0.5) await create(i);
    else if (x < 0.72) await voidOne(i);
    else if (x < 0.8) await duplicate(i);
    else if (x < 0.9) await close(i);
    else await reopen(i);
  }

  // ---- final checks against the model ----
  check(steps, 'final');
  for (const b of BOOKS) {
    const led = (await get(s.app, `/cashbooks/${b}`)).body;
    expect(led.closingCents, `seed ${seed}: ledger closing ${b}`).toBe(m.balance(b));
  }
  const posted = m.records.filter((r) => r.kind === 'transfer' && !r.voided);
  const list = (await get(s.app, '/cash-transfers?limit=200')).body;
  expect(list.total, `seed ${seed}: transfer count`).toBe(m.records.filter((r) => r.kind === 'transfer').length);
  expect(list.totals.amountCents, `seed ${seed}: posted transfer total`).toBe(posted.reduce((a, r) => a + r.amount, 0));
  // every transfer: exactly the legs the model expects, and the legs of a posted transfer net to zero across the two books
  expect(num(s, 'SELECT COUNT(*) FROM cash_entries WHERE transfer_id IS NOT NULL'), `seed ${seed}: leg rows`)
    .toBe(m.records.filter((r) => r.kind === 'transfer').length * 2 + m.records.filter((r) => r.kind === 'transfer' && r.voided).length * 2);
  expect(num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE transfer_id IS NOT NULL'), `seed ${seed}: transfers create no money`).toBe(0);
  console.log(statsLine(`transfers seed ${seed}/${steps}`, { ...stats }));
  console.log(cov.line(`[phase19m] transfers seed ${seed} coverage`));
  return { stats, cov };
}

describe('Phase 19 date-policy-aware transfers model (phase 9 scenarios, original thresholds restored)', () => {
  it.each([20261109, 7, 424242])('seed %i: 300 operations match the independent model at every step', async (seed) => {
    const { stats: st, cov } = await run(seed, 300);
    // the ORIGINAL pre-rule thresholds of phase9-model.test.ts (commit 81d0f8d)
    expect(st.created).toBeGreaterThan(70);
    expect(st.transfers).toBeGreaterThan(30);
    expect(st.voids).toBeGreaterThan(15);
    expect(st.closedRefused).toBeGreaterThan(0);
    expect(st.closings).toBeGreaterThan(5);
    expect(st.reopens).toBeGreaterThan(0);
    expect(st.duplicates).toBeGreaterThan(5);
    expect(st.icecreamLegs).toBeGreaterThan(30);
    expect(st.negativeWarnings).toBeGreaterThan(0);
    // per-category coverage: each kind created, voided and duplicated; each documented refusal code seen
    for (const k of ['capital', 'drawing', 'transfer']) {
      expect(cov.get(`ok:${k}`), `created ${k}`).toBeGreaterThanOrEqual(5);
      expect(cov.get(`ok:void ${k}`), `voided ${k}`).toBeGreaterThanOrEqual(2);
    }
    expect(['capital', 'drawing', 'transfer'].reduce((a, k) => a + cov.get(`ok:duplicate ${k}`), 0), 'duplicates').toBeGreaterThanOrEqual(5);
    expect(cov.sum('DAY_CLOSED:'), 'DAY_CLOSED refusals').toBeGreaterThanOrEqual(1);
    expect(cov.sum('BACKDATE_BEFORE_CLOSED_DAY:'), 'BACKDATE_BEFORE_CLOSED_DAY refusals').toBeGreaterThanOrEqual(1);
    expect(cov.sum('ALREADY_VOID:'), 'ALREADY_VOID refusals').toBeGreaterThanOrEqual(1);
    expect(cov.sum('DAY_CLOSED:void') + cov.sum('BACKDATE_BEFORE_CLOSED_DAY:void'), 'a void refused by a closed day').toBeGreaterThanOrEqual(1);
    expect(cov.get('ok:closing'), 'closings').toBeGreaterThan(5);
    expect(cov.get('ok:reopen'), 'reopens').toBeGreaterThan(0);
  }, 240000);
});
