// PHASE 23 - "correct this entry" for top-ups, printing supplies, Ice Cream payments, Ice Cream fund moves and stock losses.
// The eleven required groups of API_CONTRACTS "Correction contract, Phase 1", run for each of the five types (table-driven).
// Type-specific rules (D2, D4, E4, damaged-return loss, restock cost) are in phase23-correct-other-rules.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { closeOk, openNew } from './helpers/phase8.ts';
import { lossNew, reconOk, sql } from './helpers/phase4.ts';
import { providerIds, topProvider } from './helpers/phase6.ts';
import { supNew } from './helpers/phase7.ts';
import { expectBooksAgree, moveOk, payOk } from './helpers/phase10.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

type W = Record<string, any>;
interface Kit {
  key: string; resource: string; entity: string; rec: string; book: 'shop' | 'telecom' | 'icecream'; ice: boolean;
  negCode: string | null;
  world: (s: ApiBase) => Promise<W>;
  make: (s: ApiBase, w: W, date: string) => Promise<any>;
  repl: (w: W, o?: { date?: string }) => Record<string, unknown>;
  bad: (w: W) => { body: Record<string, unknown>; code: string };
  neg: (w: W) => Record<string, unknown>;
  /** The fields of the replacement that must show the corrected values. */
  expectNew: Record<string, unknown>;
}

const OPEN = daysAgo(40);

const KITS: Kit[] = [
  {
    key: 'top-up', resource: '/telecom/topups', entity: 'telecom_topups', rec: 'item', book: 'telecom', ice: false, negCode: 'NEGATIVE_CASH_BALANCE',
    world: async (s) => {
      await openNew(s, 'telecom', { businessDate: OPEN, amountCents: 1_000_000 });
      return { pid: (await providerIds(s)).Dialog };
    },
    make: async (s, w, date) => (await topProvider(s, w.pid, 5000, { businessDate: date })).body.item,
    repl: (w, o = {}) => ({ kind: 'provider_topup', providerId: w.pid, amountCents: 7000, clientRef: ref(), ...o }),
    bad: () => ({ body: { kind: 'provider_topup', amountCents: 100, clientRef: ref() }, code: 'VALIDATION_ERROR' }),
    neg: (w) => ({ kind: 'provider_topup', providerId: w.pid, amountCents: 50_000_000, clientRef: ref() }),
    expectNew: { amountCents: 7000 },
  },
  {
    key: 'printing supply', resource: '/printing-supplies', entity: 'printing_supplies', rec: 'item', book: 'shop', ice: false, negCode: 'NEGATIVE_CASH_BALANCE',
    world: async (s) => { await openNew(s, 'shop', { businessDate: OPEN, amountCents: 1_000_000 }); return {}; },
    make: async (s, _w, date) => (await supNew(s, { businessDate: date, amountCents: 5000 })).body.item,
    repl: (_w, o = {}) => ({ amountCents: 7000, description: 'A4 paper corrected', clientRef: ref(), ...o }),
    bad: () => ({ body: { amountCents: 100, description: '   ', clientRef: ref() }, code: 'VALIDATION_ERROR' }),
    neg: () => ({ amountCents: 50_000_000, description: 'Too much', clientRef: ref() }),
    expectNew: { amountCents: 7000, description: 'A4 paper corrected' },
  },
  {
    key: 'Ice Cream payment', resource: '/icecream/payments', entity: 'icecream_payments', rec: 'payment', book: 'icecream', ice: true, negCode: 'NEGATIVE_FUND_BALANCE',
    world: async (s) => { await openNew(s, 'icecream', { businessDate: OPEN, fund: 'cost', amountCents: 500_000 }); return {}; },
    make: (s, _w, date) => payOk(s, 'materials', 1000, { businessDate: date }),
    repl: (_w, o = {}) => ({ kind: 'materials', fund: 'cost', amountCents: 1500, description: 'Corrected materials', clientRef: ref(), ...o }),
    bad: () => ({ body: { kind: 'other_cost', fund: 'cost', amountCents: 100, category: 'Electricity', description: 'x', clientRef: ref() }, code: 'ELECTRICITY_NOT_ALLOWED' }),
    neg: () => ({ kind: 'other_cost', fund: 'electricity', amountCents: 1000, description: 'From an empty fund', clientRef: ref() }),
    expectNew: { amountCents: 1500, description: 'Corrected materials' },
  },
  {
    key: 'Ice Cream fund move', resource: '/icecream/fund-moves', entity: 'icecream_fund_moves', rec: 'move', book: 'icecream', ice: true, negCode: 'NEGATIVE_FUND_BALANCE',
    world: async (s) => { await openNew(s, 'icecream', { businessDate: OPEN, fund: 'cost', amountCents: 500_000 }); return {}; },
    make: (s, _w, date) => moveOk(s, 'cost', 'electricity', 1000, { businessDate: date }),
    repl: (_w, o = {}) => ({ fromFund: 'cost', toFund: 'electricity', amountCents: 1500, clientRef: ref(), ...o }),
    bad: () => ({ body: { fromFund: 'cost', toFund: 'cost', amountCents: 100, clientRef: ref() }, code: 'SAME_FUND' }),
    neg: () => ({ fromFund: 'electricity', toFund: 'cost', amountCents: 5000, clientRef: ref() }),
    expectNew: { amountCents: 1500 },
  },
  {
    key: 'stock loss', resource: '/stock-losses', entity: 'stock_losses', rec: 'item', book: 'shop', ice: false, negCode: null,
    world: async (s) => {
      await openNew(s, 'shop', { businessDate: OPEN, amountCents: 5_000_000 });
      const p = await mkProduct(s);
      await buy(s, [{ productId: p.id, packs: 10, packSize: 10, lineTotalCents: 100_000 }], { businessDate: daysAgo(35) });
      return { pid: p.id };
    },
    make: async (s, w, date) => (await lossNew(s, w.pid, 3, { businessDate: date })).body.item,
    repl: (w, o = {}) => ({ productId: w.pid, qty: 5, reason: 'lost', clientRef: ref(), ...o }),
    bad: (w) => ({ body: { productId: w.pid, qty: 999_999, reason: 'lost', clientRef: ref() }, code: 'INSUFFICIENT_STOCK' }),
    neg: (w) => ({ productId: w.pid, qty: 2, reason: 'expired', clientRef: ref() }),
    expectNew: { qty: 5, reason: 'lost' },
  },
];

const body = (reason: string, replacement: Record<string, unknown>) => ({ reason, replacement });
const status = (s: ApiBase, table: string, id: number) => sql(s, `SELECT status, void_reason FROM ${table} WHERE id = ?`, id)[0]!;
const posted = (s: ApiBase, table: string) => sql(s, `SELECT COUNT(*) AS n FROM ${table} WHERE status = 'posted'`)[0]!.n as number;

/** A twin database where the same change is made as a manual void followed by a manual create: ledgers must match to the cent. */
function ledgerSig(s: ApiBase): unknown {
  return {
    cash: sql(s, 'SELECT book, fund, business_date, type, amount_cents FROM cash_entries ORDER BY id'),
    funds: sql(s, 'SELECT business_date, fund, amount_cents, kind FROM icecream_fund_entries ORDER BY id'),
    stock: sql(s, 'SELECT product_id, business_date, type, qty_delta, value_delta_cents FROM stock_movements ORDER BY id'),
  };
}

describe.each(KITS)('correct $key', (k) => {
  const setup = async () => {
    const s = await apiBase(await env.build());
    const w = await k.world(s);
    return { s, w };
  };
  const correct = (s: ApiBase, id: number, b: unknown) => post(s.app, `${k.resource}/${id}/correct`, b);
  const prev = (s: ApiBase, id: number, b: unknown) => post(s.app, `${k.resource}/${id}/correct-preview`, b);
  const chk = (s: ApiBase, id: number) => get(s.app, `${k.resource}/${id}/correct-check`);

  it('1. success: original void with the reason, replacement posted, link row, same ledgers as manual void + create, all reconciles', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const rep = k.repl(w);
    const r = await correct(s, orig.id, body('typed the wrong figure', rep));
    expect(r.status).toBe(201);
    expect(r.body.original).toMatchObject({ id: orig.id, status: 'void', voidReason: 'typed the wrong figure' });
    expect(r.body.replacement).toMatchObject({ status: 'posted', businessDate: orig.businessDate, ...k.expectNew });
    expect(r.body.replacement.id).toBeGreaterThan(orig.id);
    expect(r.body.correction).toMatchObject({ entity: k.entity, originalId: orig.id, replacementId: r.body.replacement.id, reason: 'typed the wrong figure' });
    expect(Array.isArray(r.body.warnings)).toBe(true);
    if (k.ice) expect(r.body.funds.reconciled).toBe(true); else expect(r.body.funds).toBeUndefined();
    expect(status(s, k.entity, orig.id)).toMatchObject({ status: 'void', void_reason: 'typed the wrong figure' });
    const list = (await get(s.app, `${k.resource}`)).body.items.map((x: any) => x.id);
    expect(list).toEqual(expect.arrayContaining([orig.id, r.body.replacement.id]));
    const links = (await get(s.app, `/corrections?entity=${k.entity}&ids=${orig.id}`)).body.items;
    expect(links).toHaveLength(1);
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'correction' AND action = 'correct'")[0]!.n).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);
    if (k.ice) await expectBooksAgree(s); else if (k.key === 'stock loss') await reconOk(s);

    // twin: manual void then manual create
    const t = await apiBase(await env.build());
    const tw = await k.world(t);
    const to = await k.make(t, tw, daysAgo(10));
    expect((await post(t.app, `${k.resource}/${to.id}/void`, { reason: 'typed the wrong figure' })).status).toBe(200);
    expect((await post(t.app, k.resource, { ...k.repl(tw), businessDate: to.businessDate })).status).toBe(201);
    expect(ledgerSig(s)).toEqual(ledgerSig(t));
  });

  it('1b. an explicit replacement businessDate overrides the default', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const r = await correct(s, orig.id, body('date was wrong', k.repl(w, { date: daysAgo(9) })));
    expect(r.status).toBe(201);
    expect(r.body.replacement.businessDate).toBe(daysAgo(9));
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('request validation: reason, clientRef and unknown fields are checked and nothing changes', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const { clientRef: _c, ...noRef } = k.repl(w) as any;
    expect((await correct(s, orig.id, body('x', noRef))).status).toBe(400);
    expect((await correct(s, orig.id, { replacement: k.repl(w) })).status).toBe(400);
    expect((await correct(s, orig.id, { ...body('x', k.repl(w)), extra: 1 })).status).toBe(400);
    const blank = await correct(s, orig.id, body('   ', k.repl(w)));
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_ERROR');
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('2. atomic failure: a replacement the create refuses leaves the original posted and the database unchanged', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const bad = k.bad(w);
    const r = await correct(s, orig.id, body('try', bad.body));
    expect(r.body.error.code).toBe(bad.code);
    expect(status(s, k.entity, orig.id).status).toBe('posted');
    expect(fingerprint(s.ctx)).toBe(fp);
    const p = await prev(s, orig.id, body('try', bad.body));
    expect(p.body.error.code).toBe(bad.code);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('3. void-side refusal (closed day of the original) is the void\'s own DAY_CLOSED and changes nothing', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    await closeOk(s, k.book, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const r = await correct(s, orig.id, body('late', k.repl(w)));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DAY_CLOSED');
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('4. closed day (R9) and backdating before a closed day (section 8) are refused for the replacement and for the original', async () => {
    const { s, w } = await setup();
    const early = await k.make(s, w, daysAgo(30));
    const a = await k.make(s, w, daysAgo(10));
    const b = await k.make(s, w, daysAgo(10));
    await closeOk(s, k.book, daysAgo(20));
    const fp = fingerprint(s.ctx);
    const closed = await correct(s, a.id, body('x', k.repl(w, { date: daysAgo(20) })));
    expect([closed.status, closed.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    const before = await correct(s, b.id, body('x', k.repl(w, { date: daysAgo(25) })));
    expect([before.status, before.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    const old = await correct(s, early.id, body('x', k.repl(w)));
    expect([old.status, old.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await chk(s, early.id)).body).toMatchObject({ eligible: false, code: 'BACKDATE_BEFORE_CLOSED_DAY' });
  });

  it('5. a replacement that drives cash (or a fund) negative is a warning, not a block', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const r = await correct(s, orig.id, body('big', k.neg(w)));
    expect(r.status).toBe(201);
    if (k.negCode) expect(r.body.warnings.map((x: any) => x.code)).toContain(k.negCode);
    else expect(r.body.warnings).toEqual([]);
    const codes = r.body.warnings.map((x: any) => x.code);
    expect(new Set(codes.map((c: string, i: number) => `${c}${JSON.stringify(r.body.warnings[i])}`)).size).toBe(codes.length); // de-duplicated
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('6. the same replacement clientRef twice is a 200 replay with exactly one replacement; another original is refused', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const other = await k.make(s, w, daysAgo(10));
    const rep = k.repl(w);
    const first = await correct(s, orig.id, body('once', rep));
    expect(first.status).toBe(201);
    const n = count(s.ctx, k.entity);
    const fp = fingerprint(s.ctx);
    const again = await correct(s, orig.id, body('once', rep));
    expect(again.status).toBe(200);
    expect(again.body.replacement).toEqual(first.body.replacement);
    expect(again.body.original).toEqual(first.body.original);
    expect(again.body.correction).toEqual(first.body.correction);
    if (k.ice) expect(again.body.funds).toEqual(first.body.funds);
    expect(count(s.ctx, k.entity)).toBe(n);
    expect(fingerprint(s.ctx)).toBe(fp);
    const stolen = await correct(s, other.id, body('other', rep));
    expect(stolen.status).toBe(409);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('7. two concurrent corrections of the same original: exactly one succeeds', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const rs = await Promise.all([correct(s, orig.id, body('a', k.repl(w))), correct(s, orig.id, body('b', k.repl(w)))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('ALREADY_VOID');
    expect(posted(s, k.entity)).toBe(1);
    expect(count(s.ctx, 'corrections')).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('8. check and preview save nothing and agree with the real call', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const rep = k.repl(w);
    const fp = fingerprint(s.ctx);
    expect((await chk(s, orig.id)).body).toEqual({ eligible: true });
    const p = await prev(s, orig.id, body('why', rep));
    expect(p.status).toBe(200);
    expect(p.body.original).toMatchObject({ id: orig.id, status: 'void' });
    expect(p.body.correction).toBeUndefined();
    expect(fingerprint(s.ctx)).toBe(fp);
    const r = await correct(s, orig.id, body('why', rep));
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ ...k.expectNew, businessDate: p.body.replacement.businessDate });
    expect(r.body.warnings).toEqual(p.body.warnings);
    if (k.ice) expect(r.body.funds).toEqual(p.body.funds);
    // a refusal is the same in check, preview and the real call
    const x = await k.make(s, w, daysAgo(12));
    await closeOk(s, k.book, daysAgo(12));
    const fp2 = fingerprint(s.ctx);
    const c = (await chk(s, x.id)).body;
    expect(c.eligible).toBe(false);
    const pv = await prev(s, x.id, body('why', k.repl(w)));
    const rl = await correct(s, x.id, body('why', k.repl(w)));
    expect([pv.status, pv.body.error.code]).toEqual([rl.status, rl.body.error.code]);
    expect(c.code).toBe(rl.body.error.code);
    expect(fingerprint(s.ctx)).toBe(fp2);
  });

  it('9. an already void original is 409 ALREADY_VOID everywhere; a missing id is 404', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    expect((await post(s.app, `${k.resource}/${orig.id}/void`, { reason: 'gone' })).status).toBe(200);
    const fp = fingerprint(s.ctx);
    expect((await chk(s, orig.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
    for (const call of [prev, correct]) {
      const r = await call(s, orig.id, body('x', k.repl(w)));
      expect([r.status, r.body.error.code]).toEqual([409, 'ALREADY_VOID']);
    }
    expect((await chk(s, 99999)).status).toBe(404);
    expect((await prev(s, 99999, body('x', k.repl(w)))).status).toBe(404);
    expect((await correct(s, 99999, body('x', k.repl(w)))).status).toBe(404);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('11. a corrected record can itself be corrected (chain)', async () => {
    const { s, w } = await setup();
    const a = await k.make(s, w, daysAgo(10));
    const r1 = await correct(s, a.id, body('first', k.repl(w)));
    const r2 = await correct(s, r1.body.replacement.id, body('second', k.repl(w)));
    expect(r2.status).toBe(201);
    expect(status(s, k.entity, a.id).status).toBe('void');
    expect(status(s, k.entity, r1.body.replacement.id).status).toBe('void');
    expect(status(s, k.entity, r2.body.replacement.id).status).toBe('posted');
    const ids = [a.id, r1.body.replacement.id, r2.body.replacement.id].join(',');
    expect((await get(s.app, `/corrections?entity=${k.entity}&ids=${ids}`)).body.items).toHaveLength(2);
    expect(allProblems(s.ctx)).toEqual([]);
    if (k.ice) await expectBooksAgree(s); else if (k.key === 'stock loss') await reconOk(s);
  });
});
