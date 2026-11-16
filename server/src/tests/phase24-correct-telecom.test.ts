// PHASE 24 - "correct this entry" for reload sales and EZCash sales.
// The eleven required groups of API_CONTRACTS "Correction contract, Phase 1/2", run for both types (table-driven).
// Commission-rate rules (original rate kept, recalculation, provider change, rounding extra) are in phase24-correct-telecom-rules.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { closeOk, openNew } from './helpers/phase8.ts';
import { sql } from './helpers/phase4.ts';
import { ez, providerIds, putProvider, rel, topProvider } from './helpers/phase6.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

type W = Record<string, any>;
interface Kit {
  key: string; resource: string; entity: string; table: string;
  world: (s: ApiBase) => Promise<W>;
  make: (s: ApiBase, w: W, date: string) => Promise<any>;
  repl: (w: W, o?: Record<string, unknown>) => Record<string, unknown>;
  bad: (w: W) => { body: Record<string, unknown>; code: string };
  expectNew: Record<string, unknown>;
  /** The columns that make up the business row (compared with the manual twin). */
  cols: string;
}

const OPEN = daysAgo(40);

async function baseWorld(s: ApiBase): Promise<W> {
  await openNew(s, 'telecom', { businessDate: OPEN, amountCents: 1_000_000 });
  return providerIds(s);
}

const KITS: Kit[] = [
  {
    key: 'reload', resource: '/reload-sales', entity: 'reload_sales', table: 'reload_sales',
    cols: 'business_date, provider_id, sales_cents, commission_bp, extra_cents, commission_cents, status',
    world: async (s) => {
      const ids = await baseWorld(s);
      await putProvider(s, ids.Mobitel!, { commissionBp: 450, active: false }); // switched off: a replacement to it is refused
      return ids;
    },
    make: async (s, w, date) => (await rel(s, w.Dialog, 100_000, { businessDate: date })).body.item,
    repl: (w, o = {}) => ({ providerId: w.Dialog, salesCents: 200_000, extraCents: 50, notes: 'corrected', clientRef: ref(), ...o }),
    bad: (w) => ({ body: { providerId: w.Mobitel, salesCents: 5000, clientRef: ref() }, code: 'PROVIDER_INACTIVE' }),
    expectNew: { salesCents: 200_000, extraCents: 50, notes: 'corrected', status: 'posted' },
  },
  {
    key: 'EZCash', resource: '/ezcash-sales', entity: 'ezcash_sales', table: 'ezcash_sales',
    cols: 'business_date, provider_id, bill_total_cents, commission_bp, commission_cents, status',
    world: baseWorld,
    make: async (s, _w, date) => (await ez(s, 100_000, { businessDate: date })).body.item,
    repl: (_w, o = {}) => ({ billTotalCents: 300_000, notes: 'corrected', clientRef: ref(), ...o }),
    bad: () => ({ body: { billTotalCents: 5000, notes: 'x'.repeat(5000), clientRef: ref() }, code: 'VALIDATION_ERROR' }),
    expectNew: { billTotalCents: 300_000, notes: 'corrected', status: 'posted', providerName: 'Dialog' },
  },
];

const body = (reason: string, replacement: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ reason, replacement, ...extra });
const status = (s: ApiBase, table: string, id: number) => sql(s, `SELECT status, void_reason FROM ${table} WHERE id = ?`, id)[0]!;
const posted = (s: ApiBase, table: string) => sql(s, `SELECT COUNT(*) AS n FROM ${table} WHERE status = 'posted'`)[0]!.n as number;

function ledgerSig(s: ApiBase, k: Kit): unknown {
  return {
    cash: sql(s, 'SELECT book, fund, business_date, type, amount_cents FROM cash_entries ORDER BY id'),
    rows: sql(s, `SELECT ${k.cols} FROM ${k.table} ORDER BY id`),
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
    const r = await correct(s, orig.id, body('typed the wrong figure', k.repl(w)));
    expect(r.status).toBe(201);
    expect(r.body.original).toMatchObject({ id: orig.id, status: 'void', voidReason: 'typed the wrong figure' });
    expect(r.body.replacement).toMatchObject({ businessDate: orig.businessDate, ...k.expectNew });
    expect(r.body.replacement.id).toBeGreaterThan(orig.id);
    expect(r.body.correction).toMatchObject({ entity: k.entity, originalId: orig.id, replacementId: r.body.replacement.id, reason: 'typed the wrong figure' });
    expect(Array.isArray(r.body.warnings)).toBe(true);
    expect(r.body.comparison).toEqual({
      originalCommissionBp: orig.commissionBp, replacementCommissionBp: orig.commissionBp,
      originalCommissionCents: orig.commissionCents, replacementCommissionCents: r.body.replacement.commissionCents, rateRecalculated: false,
    });
    expect(status(s, k.entity, orig.id)).toMatchObject({ status: 'void', void_reason: 'typed the wrong figure' });
    const list = (await get(s.app, `${k.resource}`)).body.items.map((x: any) => x.id);
    expect(list).toEqual(expect.arrayContaining([orig.id, r.body.replacement.id]));
    const links = (await get(s.app, `/corrections?entity=${k.entity}&ids=${orig.id}`)).body.items;
    expect(links).toHaveLength(1);
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'correction' AND action = 'correct'")[0]!.n).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);

    // twin: manual void then manual create
    const t = await apiBase(await env.build());
    const tw = await k.world(t);
    const to = await k.make(t, tw, daysAgo(10));
    expect((await post(t.app, `${k.resource}/${to.id}/void`, { reason: 'typed the wrong figure' })).status).toBe(200);
    expect((await post(t.app, k.resource, { ...k.repl(tw), businessDate: to.businessDate })).status).toBe(201);
    expect(ledgerSig(s, k)).toEqual(ledgerSig(t, k));
    expect(allProblems(t.ctx)).toEqual([]);
  });

  it('1b. an explicit replacement businessDate overrides the default', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const r = await correct(s, orig.id, body('date was wrong', k.repl(w, { businessDate: daysAgo(9) })));
    expect(r.status).toBe(201);
    expect(r.body.replacement.businessDate).toBe(daysAgo(9));
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('request validation: reason, clientRef, unknown fields and a non-boolean recalculateCommission are refused and nothing changes', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const { clientRef: _c, ...noRef } = k.repl(w) as any;
    expect((await correct(s, orig.id, body('x', noRef))).status).toBe(400);
    expect((await correct(s, orig.id, { replacement: k.repl(w) })).status).toBe(400);
    expect((await correct(s, orig.id, { ...body('x', k.repl(w)), extra: 1 })).status).toBe(400);
    expect((await correct(s, orig.id, body('x', k.repl(w), { recalculateCommission: 'yes' }))).status).toBe(400);
    expect((await prev(s, orig.id, body('x', k.repl(w), { recalculateCommission: 1 }))).status).toBe(400);
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
    await closeOk(s, 'telecom', daysAgo(10));
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
    await closeOk(s, 'telecom', daysAgo(20));
    const fp = fingerprint(s.ctx);
    const closed = await correct(s, a.id, body('x', k.repl(w, { businessDate: daysAgo(20) })));
    expect([closed.status, closed.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    const before = await correct(s, b.id, body('x', k.repl(w, { businessDate: daysAgo(25) })));
    expect([before.status, before.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    const old = await correct(s, early.id, body('x', k.repl(w)));
    expect([old.status, old.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await chk(s, early.id)).body).toMatchObject({ eligible: false, code: 'BACKDATE_BEFORE_CLOSED_DAY' });
  });

  it('4b. a future replacement date is refused (R-FD) and nothing changes', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const r = await correct(s, orig.id, body('x', k.repl(w, { businessDate: '2999-01-01' })));
    expect([r.status, r.body.error.code]).toEqual([400, 'FUTURE_DATE_NOT_ALLOWED']);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('5. voiding the original so that the Telecom cash goes negative is a warning, not a block', async () => {
    const { s, w } = await setup();
    const orig = await k.make(s, w, daysAgo(10));
    // spend almost all the cash with a top-up, so that removing the original collection leaves the book below zero
    expect((await topProvider(s, w.Dialog, 1_050_000, { businessDate: daysAgo(9) })).status).toBe(201);
    const r = await correct(s, orig.id, body('big', k.repl(w, { ...(k.key === 'reload' ? { salesCents: 10_000 } : { billTotalCents: 10_000 }) })));
    expect(r.status).toBe(201);
    const codes = r.body.warnings.map((x: any) => x.code);
    expect(codes).toContain('NEGATIVE_CASH_BALANCE');
    expect(new Set(r.body.warnings.map((x: any) => JSON.stringify(x))).size).toBe(r.body.warnings.length); // de-duplicated
    expect(status(s, k.entity, orig.id).status).toBe('void');
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
    expect(again.body.comparison).toEqual(first.body.comparison);
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
    expect(r.body.comparison).toEqual(p.body.comparison);
    // a refusal is the same in check, preview and the real call
    const x = await k.make(s, w, daysAgo(12));
    await closeOk(s, 'telecom', daysAgo(12));
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

  it('11. a corrected record can itself be corrected (chain), and the original rate is carried along the chain', async () => {
    const { s, w } = await setup();
    const a = await k.make(s, w, daysAgo(10));
    const r1 = await correct(s, a.id, body('first', k.repl(w)));
    const r2 = await correct(s, r1.body.replacement.id, body('second', k.repl(w)));
    expect(r2.status).toBe(201);
    expect(status(s, k.entity, a.id).status).toBe('void');
    expect(status(s, k.entity, r1.body.replacement.id).status).toBe('void');
    expect(status(s, k.entity, r2.body.replacement.id).status).toBe('posted');
    expect(r2.body.replacement.commissionBp).toBe(a.commissionBp);
    const ids = [a.id, r1.body.replacement.id, r2.body.replacement.id].join(',');
    expect((await get(s.app, `/corrections?entity=${k.entity}&ids=${ids}`)).body.items).toHaveLength(2);
    expect(allProblems(s.ctx)).toEqual([]);
  });
});
