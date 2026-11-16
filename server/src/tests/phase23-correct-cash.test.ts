// PHASE 23 - "correct this entry" for expenses, cash transfers, capital entries and cash drawings (API_CONTRACTS.md "Correction contract,
// Phase 1"). Every type runs the same eleven groups: success (= manual void + manual create, to the cent), atomic failure, void-side
// refusal, closed day / backdating, negative cash stays a warning, replay by clientRef, concurrent corrections, check/preview write
// nothing and agree with the real call, already-void original, type-specific refusals, chains.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { closeOk } from './helpers/phase8.ts';
import type { Book } from './helpers/phase8.ts';
import { capNew, drawCash, seedBooks, state, trNew } from './helpers/phase9.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

interface Kind {
  name: string; resource: string; entity: string; table: string; listUrl: string; voidUrl: (id: number) => string;
  closeBook: Book; make: (s: ApiBase, over?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  replacement: (over?: Record<string, unknown>) => Record<string, unknown>;
  /** A schema-valid replacement that only the CREATE part refuses, with the expected error. */
  bad: { over: Record<string, unknown>; status: number; code: string };
}

const KINDS: Kind[] = [
  {
    name: 'expenses', resource: 'expenses', entity: 'expenses', table: 'expenses', listUrl: '/expenses', voidUrl: (id) => `/expenses/${id}/void`,
    closeBook: 'shop',
    make: (s, o = {}) => post(s.app, '/expenses', { businessDate: today(), book: 'shop', category: 'rent', amountCents: 5000, description: 'Rent', clientRef: ref(), ...o }),
    replacement: (o = {}) => ({ book: 'shop', category: 'water', amountCents: 7000, description: 'Water bill', clientRef: ref(), ...o }),
    bad: { over: { category: 'electricity' }, status: 400, code: 'ELECTRICITY_NOT_ALLOWED' },
  },
  {
    name: 'transfers', resource: 'cash-transfers', entity: 'cash_transfers', table: 'cash_transfers', listUrl: '/cash-transfers',
    voidUrl: (id) => `/cash-transfers/${id}/void`, closeBook: 'telecom',
    make: (s, o = {}) => trNew(s, { amountCents: 10000, ...o }),
    replacement: (o = {}) => ({ fromBook: 'shop', toBook: 'telecom', amountCents: 20000, note: 'fixed', clientRef: ref(), ...o }),
    bad: { over: { toBook: 'shop' }, status: 400, code: 'SAME_BOOK' },
  },
  {
    name: 'capital entries', resource: 'capital-entries', entity: 'capital_entries', table: 'capital_entries', listUrl: '/capital',
    voidUrl: (id) => `/capital-entries/${id}/void`, closeBook: 'shop',
    make: (s, o = {}) => capNew(s, { amountCents: 10000, ...o }),
    replacement: (o = {}) => ({ book: 'shop', amountCents: 30000, note: 'fixed', clientRef: ref(), ...o }),
    bad: { over: { book: 'icecream' }, status: 400, code: 'FUND_REQUIRED' },
  },
  {
    name: 'cash drawings', resource: 'drawings', entity: 'owner_drawings', table: 'owner_drawings', listUrl: '/drawings',
    voidUrl: (id) => `/drawings/${id}/void`, closeBook: 'shop',
    make: (s, o = {}) => drawCash(s, { amountCents: 10000, ...o }),
    replacement: (o = {}) => ({ kind: 'cash', book: 'shop', amountCents: 25000, note: 'fixed', clientRef: ref(), ...o }),
    bad: { over: { book: 'icecream' }, status: 400, code: 'FUND_REQUIRED' },
  },
];

const D = (n: number) => daysAgo(n);
const seed = (s: ApiBase) => seedBooks(s, { shop: 1_000_000, telecom: 1_000_000, cost: 1_000_000 }, D(10));
async function world(): Promise<ApiBase> { const s = await apiBase(await env.build()); await seed(s); return s; }
const correct = (s: ApiBase, k: Kind, id: number, replacement: Record<string, unknown>, reason = 'typed the wrong amount') =>
  post(s.app, `/${k.resource}/${id}/correct`, { reason, replacement });
const preview = (s: ApiBase, k: Kind, id: number, replacement: Record<string, unknown>, reason = 'typed the wrong amount') =>
  post(s.app, `/${k.resource}/${id}/correct-preview`, { reason, replacement });
const check = (s: ApiBase, k: Kind, id: number) => get(s.app, `/${k.resource}/${id}/correct-check`);
const made = async (s: ApiBase, k: Kind, o: Record<string, unknown> = {}) => {
  const r = await k.make(s, o);
  if (r.status !== 201) throw new Error(`make failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
};
const row = (s: ApiBase, k: Kind, id: number) => sql(s, `SELECT * FROM ${k.table} WHERE id = ?`, id)[0]!;
/** Ledger rows without ids and timestamps: two worlds that did the same business must produce the same list. */
const ledger = (s: ApiBase) => ({
  cash: sql(s, 'SELECT book, fund, type, amount_cents, business_date, reverses_entry_id IS NOT NULL AS rev FROM cash_entries ORDER BY id'),
  funds: sql(s, 'SELECT fund, kind, amount_cents, business_date FROM icecream_fund_entries ORDER BY id'),
  state: state(s),
});

for (const k of KINDS) {
  describe(`correct ${k.name}`, () => {
    it('1. success: original void with the reason, replacement posted, link row, both listed; equals manual void + manual create', async () => {
      const a = await world();
      const o = await made(a, k, { businessDate: D(2) });
      const r = await correct(a, k, o.id, k.replacement());
      expect(r.status).toBe(201);
      expect(Object.keys(r.body).sort()).toEqual(['correction', 'original', 'replacement', 'warnings']);
      expect(r.body.original).toMatchObject({ id: o.id, status: 'void', voidReason: 'typed the wrong amount' });
      expect(r.body.replacement).toMatchObject({ status: 'posted', businessDate: D(2) }); // G5: defaults to the original's date
      expect(r.body.replacement.id).toBeGreaterThan(o.id);
      expect(r.body.correction).toMatchObject({ entity: k.entity, originalId: o.id, replacementId: r.body.replacement.id, reason: 'typed the wrong amount' });
      expect(sql(a, 'SELECT * FROM corrections')).toHaveLength(1);
      expect((await get(a.app, `/corrections?entity=${k.entity}&ids=${o.id}`)).body.items).toHaveLength(1);
      const list = (await get(a.app, `${k.listUrl}?limit=200`)).body.items.filter((i: any) => i.kind !== 'opening_balance');
      expect(list.map((i: any) => [i.id, i.status]).sort()).toEqual([[o.id, 'void'], [r.body.replacement.id, 'posted']].sort());
      expect(allProblems(a.ctx)).toEqual([]);

      // an identical world that does a manual void followed by a manual create
      const b = await world();
      const o2 = await made(b, k, { businessDate: D(2) });
      expect((await post(b.app, k.voidUrl(o2.id), { reason: 'typed the wrong amount' })).status).toBe(200);
      expect((await k.make(b, { ...k.replacement(), businessDate: D(2) })).status).toBe(201);
      expect(ledger(a)).toEqual(ledger(b));
      expect(allProblems(b.ctx)).toEqual([]);
    });

    it('1b. an explicit businessDate on the replacement is honoured', async () => {
      const s = await world();
      const o = await made(s, k, { businessDate: D(2) });
      const r = await correct(s, k, o.id, k.replacement({ businessDate: D(1) }));
      expect(r.status).toBe(201);
      expect(r.body.replacement.businessDate).toBe(D(1));
      expect(r.body.original.businessDate).toBe(D(2));
    });

    it('2. atomic failure: a replacement the CREATE refuses leaves the original posted and the database unchanged', async () => {
      const s = await world();
      const o = await made(s, k);
      const before = fingerprint(s.ctx);
      const r = await correct(s, k, o.id, k.replacement(k.bad.over));
      expect([r.status, r.body.error.code]).toEqual([k.bad.status, k.bad.code]);
      expect(fingerprint(s.ctx)).toBe(before);
      expect(row(s, k, o.id).status).toBe('posted');
      expect(count(s.ctx, 'corrections')).toBe(0);
      // a future date is refused by the create too
      const f = await correct(s, k, o.id, k.replacement({ businessDate: '2999-01-01' }));
      expect([f.status, f.body.error.code]).toEqual([400, 'FUTURE_DATE_NOT_ALLOWED']);
      expect(fingerprint(s.ctx)).toBe(before);
    });

    it('2b. a reused clientRef of another record is refused 409 CLIENT_REF_CONFLICT and nothing changes', async () => {
      const s = await world();
      const o = await made(s, k);
      const other = await made(s, k);
      const before = fingerprint(s.ctx);
      const r = await correct(s, k, o.id, k.replacement({ clientRef: other.clientRef }));
      expect([r.status, r.body.error.code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
      const same = await correct(s, k, o.id, k.replacement({ clientRef: o.clientRef }));
      expect([same.status, same.body.error.code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
      expect(fingerprint(s.ctx)).toBe(before);
    });

    it('2c. body validation: reason and clientRef are required, extra fields refused, unknown id is 404', async () => {
      const s = await world();
      const o = await made(s, k);
      const before = fingerprint(s.ctx);
      const noRef = k.replacement(); delete (noRef as any).clientRef;
      expect((await correct(s, k, o.id, noRef)).status).toBe(400);
      expect((await post(s.app, `/${k.resource}/${o.id}/correct`, { replacement: k.replacement() })).status).toBe(400);
      expect((await correct(s, k, o.id, k.replacement(), '   ')).body.error.code).toBe('VALIDATION_ERROR');
      expect((await correct(s, k, o.id, k.replacement({ bogus: 1 }))).status).toBe(400);
      for (const r of [await correct(s, k, 99999, k.replacement()), await preview(s, k, 99999, k.replacement()), await check(s, k, 99999)]) {
        expect([r.status, r.body.error.code]).toEqual([404, 'NOT_FOUND']);
      }
      expect(fingerprint(s.ctx)).toBe(before);
    });

    it('3. void-side refusal (original on a closed day): refused with the void\'s own code, database unchanged', async () => {
      const s = await world();
      const o = await made(s, k, { businessDate: D(4) });
      await closeOk(s, k.closeBook, D(4));
      const before = fingerprint(s.ctx);
      const r = await correct(s, k, o.id, k.replacement());
      expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
      expect(fingerprint(s.ctx)).toBe(before);
      expect(row(s, k, o.id).status).toBe('posted');
      // the manual void gives the same answer
      expect((await post(s.app, k.voidUrl(o.id), { reason: 'x' })).body.error.code).toBe('DAY_CLOSED');
    });

    it('4. closed day (R9) and BACKDATE_BEFORE_CLOSED_DAY behave as for a manual void + create', async () => {
      const s = await world();
      // (a) the original lies before a later closed day: the void is refused
      const early = await made(s, k, { businessDate: D(5) });
      await closeOk(s, k.closeBook, D(3));
      let before = fingerprint(s.ctx);
      let r = await correct(s, k, early.id, k.replacement());
      expect([r.status, r.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
      expect(fingerprint(s.ctx)).toBe(before);
      // (b) the original is fine but the REPLACEMENT is dated on / before the closed day: only the create refuses
      const late = await made(s, k, { businessDate: D(1) });
      before = fingerprint(s.ctx);
      r = await correct(s, k, late.id, k.replacement({ businessDate: D(3) }));
      expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
      r = await correct(s, k, late.id, k.replacement({ businessDate: D(4) }));
      expect([r.status, r.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
      expect(fingerprint(s.ctx)).toBe(before);
      expect(row(s, k, late.id).status).toBe('posted');
      // (c) an open date after the closed day works
      r = await correct(s, k, late.id, k.replacement({ businessDate: D(2) }));
      expect(r.status).toBe(201);
      expect(allProblems(s.ctx)).toEqual([]);
    });

    it('5. negative cash stays a WARNING, never a block (also in the preview)', async () => {
      const s = await apiBase(await env.build()); // no opening balance at all: every cash-out goes below zero
      await post(s.app, '/expenses', { businessDate: D(3), book: 'shop', category: 'rent', amountCents: 50_000, description: 'Rent', clientRef: ref() });
      const o = await made(s, k, { businessDate: D(2) });
      const rep = k.replacement({ amountCents: 90_000_000 });
      const p = await preview(s, k, o.id, rep);
      expect(p.status).toBe(200);
      const r = await correct(s, k, o.id, rep);
      expect(r.status).toBe(201);
      for (const body of [p.body, r.body]) {
        expect(body.warnings.length).toBeGreaterThan(0);
        expect(body.warnings.every((w: any) => w.code.startsWith('NEGATIVE_'))).toBe(true);
        const keys = body.warnings.map((w: any) => JSON.stringify(w));
        expect(new Set(keys).size).toBe(keys.length); // de-duplicated
      }
      expect(allProblems(s.ctx)).toEqual([]);
    });

    it('6. double submit with the same replacement clientRef: 200 replay, exactly one replacement, no second void', async () => {
      const s = await world();
      const o = await made(s, k);
      const rep = k.replacement();
      const first = await correct(s, k, o.id, rep);
      expect(first.status).toBe(201);
      const total = count(s.ctx, k.table);
      const fp = fingerprint(s.ctx);
      const again = await correct(s, k, o.id, rep);
      expect(again.status).toBe(200);
      expect(Object.keys(again.body).sort()).toEqual(['correction', 'original', 'replacement', 'warnings']);
      expect(again.body.replacement.id).toBe(first.body.replacement.id);
      expect(again.body.correction.id).toBe(first.body.correction.id);
      expect(again.body.original).toMatchObject({ id: o.id, status: 'void' });
      expect(count(s.ctx, k.table)).toBe(total);
      expect(fingerprint(s.ctx)).toBe(fp);
      // the same clientRef used to correct a DIFFERENT original is a conflict
      const other = await made(s, k);
      const clash = await correct(s, k, other.id, rep);
      expect([clash.status, clash.body.error.code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
    });

    it('7. two concurrent corrections of the same original: exactly one succeeds, the other gets 409', async () => {
      const s = await world();
      const o = await made(s, k);
      const [a, b] = await Promise.all([correct(s, k, o.id, k.replacement()), correct(s, k, o.id, k.replacement())]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.error.code).toBe('ALREADY_VOID');
      expect(count(s.ctx, 'corrections')).toBe(1);
      expect(sql(s, `SELECT * FROM ${k.table} WHERE status = 'posted' AND id > ?`, o.id)).toHaveLength(1);
      expect(allProblems(s.ctx)).toEqual([]);
    });

    it('8. correct-check and correct-preview save nothing and agree with the real call', async () => {
      const s = await world();
      const o = await made(s, k);
      const before = fingerprint(s.ctx);
      expect((await check(s, k, o.id)).body).toEqual({ eligible: true });
      const rep = k.replacement();
      const p = await preview(s, k, o.id, rep);
      expect(p.status).toBe(200);
      expect(Object.keys(p.body).sort()).toEqual(['original', 'replacement', 'warnings']);
      expect(p.body.original.status).toBe('void');
      expect(fingerprint(s.ctx)).toBe(before);
      const r = await correct(s, k, o.id, rep);
      expect(r.status).toBe(201);
      const strip = (x: any) => { const { id, postedAt, voidedAt, ...rest } = x; return rest; };
      expect(strip(r.body.replacement)).toEqual(strip(p.body.replacement));
      expect(strip(r.body.original)).toEqual(strip(p.body.original));
      expect(r.body.warnings).toEqual(p.body.warnings);
      // refusal: all three agree
      const o2 = await made(s, k, { businessDate: D(6) });
      await closeOk(s, k.closeBook, D(6));
      const fp = fingerprint(s.ctx);
      const c = await check(s, k, o2.id);
      expect(c.status).toBe(200);
      expect(c.body).toMatchObject({ eligible: false, code: 'DAY_CLOSED' });
      expect(typeof c.body.message).toBe('string');
      const pr = await preview(s, k, o2.id, k.replacement());
      const re = await correct(s, k, o2.id, k.replacement());
      expect([pr.status, pr.body.error.code, re.status, re.body.error.code]).toEqual([409, 'DAY_CLOSED', 409, 'DAY_CLOSED']);
      expect(fingerprint(s.ctx)).toBe(fp);
      // a preview of a replacement the create refuses shows the same refusal and saves nothing
      const o3 = await made(s, k);
      const fp3 = fingerprint(s.ctx);
      const pb = await preview(s, k, o3.id, k.replacement(k.bad.over));
      expect([pb.status, pb.body.error.code]).toEqual([k.bad.status, k.bad.code]);
      expect(fingerprint(s.ctx)).toBe(fp3);
    });

    it('9. an already-void original is 409 ALREADY_VOID (check says not eligible)', async () => {
      const s = await world();
      const o = await made(s, k);
      expect((await post(s.app, k.voidUrl(o.id), { reason: 'oops' })).status).toBe(200);
      const fp = fingerprint(s.ctx);
      expect((await check(s, k, o.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
      for (const r of [await preview(s, k, o.id, k.replacement()), await correct(s, k, o.id, k.replacement())]) {
        expect([r.status, r.body.error.code]).toEqual([409, 'ALREADY_VOID']);
      }
      expect(fingerprint(s.ctx)).toBe(fp);
    });

    it('11. a corrected record can itself be corrected (chain), and the books reconcile', async () => {
      const s = await world();
      const a = await made(s, k, { businessDate: D(2) });
      const r1 = await correct(s, k, a.id, k.replacement());
      expect(r1.status).toBe(201);
      const r2 = await correct(s, k, r1.body.replacement.id, k.replacement({ amountCents: 4321 }));
      expect(r2.status).toBe(201);
      expect(r2.body.replacement.amountCents).toBe(4321);
      expect(r2.body.replacement.businessDate).toBe(D(2));
      expect((await get(s.app, `/corrections?entity=${k.entity}&ids=${r1.body.replacement.id}`)).body.items).toHaveLength(2);
      expect(row(s, k, a.id).status).toBe('void');
      expect(row(s, k, r1.body.replacement.id).status).toBe('void');
      // the old original cannot be corrected again
      expect((await correct(s, k, a.id, k.replacement())).body.error.code).toBe('ALREADY_VOID');
      expect(allProblems(s.ctx)).toEqual([]);
    });
  });
}

// ---------- 10. type-specific refusals ----------

describe('10. expenses: E2 and Ice Cream refusals still apply to the replacement', () => {
  const k = KINDS[0]!;
  it('electricity (any spelling) and the Ice Cream book are refused; the original stays posted and nothing changes', async () => {
    const s = await world();
    const o = await made(s, k);
    const before = fingerprint(s.ctx);
    for (const cat of ['electricity', ' ELECTRICITY ', 'Electricity']) {
      const r = await correct(s, k, o.id, k.replacement({ category: cat }));
      expect([r.status, r.body.error.code, r.body.error.message]).toEqual([400, 'ELECTRICITY_NOT_ALLOWED', 'Electricity is paid from the Ice Cream book.']);
    }
    const ice = await correct(s, k, o.id, k.replacement({ book: 'icecream' }));
    expect([ice.status, ice.body.error.code]).toEqual([400, 'USE_ICECREAM_PAYMENTS']);
    const bad = await correct(s, k, o.id, k.replacement({ category: 'nonsense' }));
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(fingerprint(s.ctx)).toBe(before);
  });
  it('the book of an expense can be corrected (Shop -> Telecom): the cash moves between the books', async () => {
    const s = await world();
    const o = await made(s, k, { amountCents: 5000 });
    const r = await correct(s, k, o.id, k.replacement({ book: 'telecom', amountCents: 5000 }));
    expect(r.status).toBe(201);
    expect(state(s)).toMatchObject({ shop: 1_000_000, telecom: 995_000 });
  });
});

describe('10. capital entries: only kind capital is correctable', () => {
  const k = KINDS[2]!;
  it('an opening-balance row is refused 409 CORRECTION_NOT_SUPPORTED in check, preview and correct, before any void', async () => {
    const s = await world();
    const ob = sql(s, "SELECT id FROM capital_entries WHERE kind = 'opening_balance' AND book = 'shop'")[0]!.id as number;
    const fp = fingerprint(s.ctx);
    expect((await check(s, k, ob)).body).toMatchObject({ eligible: false, code: 'CORRECTION_NOT_SUPPORTED' });
    for (const r of [await preview(s, k, ob, k.replacement()), await correct(s, k, ob, k.replacement())]) {
      expect([r.status, r.body.error.code]).toEqual([409, 'CORRECTION_NOT_SUPPORTED']);
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(row(s, k, ob).status).toBe('posted');
    // also when the opening balance sits on a closed day: the unsupported answer comes first
    await closeOk(s, 'shop', D(10));
    const fp2 = fingerprint(s.ctx);
    expect((await correct(s, k, ob, k.replacement())).body.error.code).toBe('CORRECTION_NOT_SUPPORTED');
    expect(fingerprint(s.ctx)).toBe(fp2);
  });
  it('an Ice Cream capital entry is corrected fund by fund; fund rows stay in step with the cash rows', async () => {
    const s = await world();
    const o = await made(s, k, { book: 'icecream', fund: 'profit', amountCents: 5000, businessDate: D(2) });
    const r = await correct(s, k, o.id, k.replacement({ book: 'icecream', fund: 'cost', amountCents: 8000 }));
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ book: 'icecream', fund: 'cost', amountCents: 8000 });
    expect(state(s)).toMatchObject({ cost: 1_008_000, profit: 0, icecream: 1_008_000 });
    expect(allProblems(s.ctx)).toEqual([]);
  });
  it('a missing fund on an Ice Cream replacement is refused by the create (FUND_REQUIRED) and a fund on Shop (FUND_NOT_ALLOWED)', async () => {
    const s = await world();
    const o = await made(s, k);
    const fp = fingerprint(s.ctx);
    expect((await correct(s, k, o.id, k.replacement({ book: 'shop', fund: 'cost' }))).body.error.code).toBe('FUND_NOT_ALLOWED');
    expect((await correct(s, k, o.id, k.replacement({ book: 'icecream' }))).body.error.code).toBe('FUND_REQUIRED');
    expect(fingerprint(s.ctx)).toBe(fp);
  });
});

describe('10. cash drawings: only kind cash is correctable', () => {
  const k = KINDS[3]!;
  it('a goods drawing is refused 409 CORRECTION_NOT_SUPPORTED in check, preview and correct (Phase 2), nothing changes', async () => {
    const s = await world();
    const p = await mkProduct(s);
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: D(3) });
    const g = await post(s.app, '/drawings', { kind: 'goods', businessDate: D(2), productId: p.id, qty: 2, clientRef: ref() });
    expect(g.status).toBe(201);
    const fp = fingerprint(s.ctx);
    expect((await check(s, k, g.body.item.id)).body).toMatchObject({ eligible: false, code: 'CORRECTION_NOT_SUPPORTED' });
    for (const r of [await preview(s, k, g.body.item.id, k.replacement()), await correct(s, k, g.body.item.id, k.replacement())]) {
      expect([r.status, r.body.error.code]).toEqual([409, 'CORRECTION_NOT_SUPPORTED']);
    }
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(row(s, k, g.body.item.id).status).toBe('posted');
  });
  it('a replacement of kind goods is refused by the schema (400) and nothing changes', async () => {
    const s = await world();
    const o = await made(s, k);
    const fp = fingerprint(s.ctx);
    const r = await correct(s, k, o.id, k.replacement({ kind: 'goods' }));
    expect([r.status, r.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(fingerprint(s.ctx)).toBe(fp);
  });
  it('an Ice Cream cash drawing moves its fund row with the correction', async () => {
    const s = await world();
    const o = await made(s, k, { book: 'icecream', fund: 'cost', amountCents: 4000, businessDate: D(2) });
    const r = await correct(s, k, o.id, k.replacement({ book: 'icecream', fund: 'profit', amountCents: 6000 }));
    expect(r.status).toBe(201);
    expect(state(s)).toMatchObject({ cost: 1_000_000, profit: -6000, icecream: 994_000 });
    expect(r.body.warnings.some((w: any) => w.code === 'NEGATIVE_FUND_BALANCE')).toBe(true); // profit fund went below zero: warning only
    expect(allProblems(s.ctx)).toEqual([]);
  });
});

