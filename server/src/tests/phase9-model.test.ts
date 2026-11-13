// Phase 9 randomized model check (BUSINESS_RULES sections 8, 9, 10.1, 10.2, 10.7; R1, R9, R13). Seeded sequences of 300 operations -
// capital, cash drawings, transfers between every pair of books (with funds on the Ice Cream side), voids of all three, daily closings,
// reopens and duplicate submissions - are sent through the real API and compared, step by step, with an INDEPENDENT in-test model that
// knows only the written rules (it shares no code with the server):
//   - every request is answered exactly as the model predicts (201 / 200 duplicate / 409 DAY_CLOSED naming the first closed book /
//     409 ALREADY_VOID) and the cash-out warnings (negative book, negative fund) are exactly the model's;
//   - after EVERY step each book balance and each Ice Cream fund balance equals the model;
//   - Cost + Electricity + Profit = the Ice Cream book, and the sum of all fund rows = the sum of all Ice Cream cash rows (10.1, 10.7);
//   - after the run the cash book ledger endpoints return the model's closing balances and the transfer list totals match the model.
// The seed makes a failure reproducible: the failing step number and seed are in every assertion message.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, num } from './helpers/phase4.ts';
import { bookBal, closeNew, fundBal, reopenNew, rng } from './helpers/phase8.ts';
import type { Book, Fund } from './helpers/phase8.ts';
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

interface Stats { created: number; closedRefused: number; voids: number; alreadyVoid: number; duplicates: number; closings: number; reopens: number; transfers: number; icecreamLegs: number; negativeWarnings: number }

async function run(seed: number, steps: number): Promise<Stats> {
  const s = await apiBase(await env.build());
  const rnd = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const DATES = [0, 1, 2, 3, 4].map((n) => (n === 0 ? today() : daysAgo(n)));
  const stats: Stats = { created: 0, closedRefused: 0, voids: 0, alreadyVoid: 0, duplicates: 0, closings: 0, reopens: 0, transfers: 0, icecreamLegs: 0, negativeWarnings: 0 };
  const m = new Model();
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

  const create = async (i: number): Promise<void> => {
    const date = pick(DATES);
    const amount = int(1, 40) * 50; // 50 .. 2,000 cents
    const kind = pick(['capital', 'drawing', 'transfer', 'transfer'] as const);
    let rec: MRecord;
    let r: { status: number; body: any };
    if (kind === 'transfer') {
      const from = pick(BOOKS);
      const to = pick(BOOKS.filter((b) => b !== from));
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
    const refused = m.refusal(rec.books, date);
    if (refused) {
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
    const rec = pick(m.records);
    const url = rec.kind === 'transfer' ? `/cash-transfers/${rec.id}/void` : rec.kind === 'drawing' ? `/drawings/${rec.id}/void` : `/capital-entries/${rec.id}/void`;
    const r = rec.kind === 'transfer' ? await trVoid(s, rec.id) : await post(s.app, url, { reason: 'model void' });
    const refused = m.refusal(rec.books, rec.date);
    if (refused) {
      expect(r.status, at(i, `void ${rec.kind} refused (${refused.code} ${refused.book})`)).toBe(409);
      expect(err(r), at(i, 'void closed error')).toMatchObject({ businessDate: rec.date, ...refused });
      stats.closedRefused++;
      return;
    }
    if (rec.voided) {
      expect(r.status, at(i, `void ${rec.kind} twice`)).toBe(409);
      expect(err(r).code).toBe('ALREADY_VOID');
      stats.alreadyVoid++;
      return;
    }
    expect(r.status, at(i, `void ${rec.kind} ${JSON.stringify(r.body)}`)).toBe(200);
    rec.voided = true;
    m.push(rec.legs.map((l) => ({ ...l, amount: -l.amount })));
    stats.voids++;
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
    check(i, 'after duplicate');
  };

  const close = async (i: number): Promise<void> => {
    const book = pick(BOOKS);
    const date = pick(DATES);
    if (m.isClosed(book, date)) return;
    const r = await closeNew(s, book, date);
    expect(r.status, at(i, `close ${book} ${date} ${JSON.stringify(r.body)}`)).toBe(201);
    m.closed.add(`${book}|${date}`);
    m.closingId.set(`${book}|${date}`, r.body.item.id);
    stats.closings++;
  };

  const reopen = async (i: number): Promise<void> => {
    const keys = [...m.closed];
    if (keys.length === 0) return;
    const k = pick(keys);
    const r = await reopenNew(s, m.closingId.get(k) as number);
    expect(r.status, at(i, `reopen ${k} ${JSON.stringify(r.body)}`)).toBe(200);
    m.closed.delete(k);
    stats.reopens++;
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
  return stats;
}

describe('Phase 9 randomized model check', () => {
  it.each([20261109, 7, 424242])('seed %i: 300 operations match the independent model at every step', async (seed) => {
    const st = await run(seed, 300);
    // the run must really have exercised everything it claims to test
    // thresholds lowered for the closed-day ordering rule (migration 016): backdated writes before a closed day are now refused (the model checks every refusal), so fewer writes are accepted
    expect(st.created).toBeGreaterThan(40);
    expect(st.transfers).toBeGreaterThan(10);
    expect(st.voids).toBeGreaterThan(15);
    expect(st.closedRefused).toBeGreaterThan(0);
    expect(st.closings).toBeGreaterThan(5);
    expect(st.reopens).toBeGreaterThan(0);
    expect(st.duplicates).toBeGreaterThan(5);
    expect(st.icecreamLegs).toBeGreaterThan(30);
    expect(st.negativeWarnings).toBeGreaterThan(0);
  }, 120000);
});
