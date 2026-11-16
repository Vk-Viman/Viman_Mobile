// PHASE 24 - "correct this entry" for print / service sales (API_CONTRACTS "Correction contract, Phase 2").
// The eleven required groups of the Phase 1 contract plus the print-specific rules (switched-off service type, price/cost drift,
// custom price, free sale, price below cost).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { closeOk, expNew, openNew } from './helpers/phase8.ts';
import { sql } from './helpers/phase4.ts';
import { psNew, typeIdOf, typePut } from './helpers/phase7.ts';
import { allProblems, count, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const OPEN = daysAgo(40);
const body = (reason: string, replacement: Record<string, unknown>) => ({ reason, replacement });

async function setup() {
  const s = await apiBase(await env.build());
  await openNew(s, 'shop', { businessDate: OPEN, amountCents: 1_000_000 });
  const bw = await typeIdOf(s, 'BW_1S');
  const clr = await typeIdOf(s, 'CLR_1S');
  return { s, bw, clr };
}
const make = async (s: ApiBase, date: string, over: Record<string, unknown> = {}) => (await psNew(s, { businessDate: date, ...over })).body.item;
const repl = (bw: number, o: Record<string, unknown> = {}) => ({ serviceTypeId: bw, qty: 5, notes: 'corrected', clientRef: ref(), ...o });
const correct = (s: ApiBase, id: number, b: unknown) => post(s.app, `/print-sales/${id}/correct`, b);
const prev = (s: ApiBase, id: number, b: unknown) => post(s.app, `/print-sales/${id}/correct-preview`, b);
const chk = (s: ApiBase, id: number) => get(s.app, `/print-sales/${id}/correct-check`);
const status = (s: ApiBase, id: number) => sql(s, 'SELECT status, void_reason FROM print_sales WHERE id = ?', id)[0]!;
const posted = (s: ApiBase) => sql(s, "SELECT COUNT(*) AS n FROM print_sales WHERE status = 'posted'")[0]!.n as number;
const ledgerSig = (s: ApiBase) => ({
  cash: sql(s, 'SELECT book, business_date, type, amount_cents FROM cash_entries ORDER BY id'),
  sales: sql(s, 'SELECT business_date, service_type_id, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents, status FROM print_sales ORDER BY id'),
});

describe('correct print sale', () => {
  it('1. success: original void with the reason, replacement posted, link row, same ledgers as manual void + create, all reconciles', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const rep = repl(bw);
    const r = await correct(s, orig.id, body('typed the wrong count', rep));
    expect(r.status).toBe(201);
    expect(r.body.original).toMatchObject({ id: orig.id, status: 'void', voidReason: 'typed the wrong count' });
    expect(r.body.replacement).toMatchObject({ status: 'posted', businessDate: orig.businessDate, qty: 5, notes: 'corrected', revenueCents: 7500, cogsCents: 3250 });
    expect(r.body.replacement.id).toBeGreaterThan(orig.id);
    expect(r.body.correction).toMatchObject({ entity: 'print_sales', originalId: orig.id, replacementId: r.body.replacement.id, reason: 'typed the wrong count' });
    expect(Array.isArray(r.body.warnings)).toBe(true);
    expect(r.body.comparison).toMatchObject({
      originalQty: 3, replacementQty: 5, originalRevenueCents: 4500, replacementRevenueCents: 7500, revenueDifferenceCents: 3000,
      originalCogsCents: 1950, replacementCogsCents: 3250, cogsDifferenceCents: 1300,
      originalGrossProfitCents: 2550, replacementGrossProfitCents: 4250, grossProfitDifferenceCents: 1700,
    });
    expect(status(s, orig.id)).toMatchObject({ status: 'void', void_reason: 'typed the wrong count' });
    const list = (await get(s.app, '/print-sales')).body.items.map((x: any) => x.id);
    expect(list).toEqual(expect.arrayContaining([orig.id, r.body.replacement.id]));
    expect((await get(s.app, `/corrections?entity=print_sales&ids=${orig.id}`)).body.items).toHaveLength(1);
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'correction' AND action = 'correct'")[0]!.n).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);

    const t = await setup();
    const to = await make(t.s, daysAgo(10));
    expect((await post(t.s.app, `/print-sales/${to.id}/void`, { reason: 'typed the wrong count' })).status).toBe(200);
    expect((await post(t.s.app, '/print-sales', { ...repl(t.bw), businessDate: to.businessDate })).status).toBe(201);
    expect(ledgerSig(s)).toEqual(ledgerSig(t.s));
  });

  it('1b. an explicit replacement businessDate overrides the default', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const r = await correct(s, orig.id, body('date was wrong', repl(bw, { businessDate: daysAgo(9) })));
    expect(r.status).toBe(201);
    expect(r.body.replacement.businessDate).toBe(daysAgo(9));
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('request validation: reason, clientRef and unknown fields are checked and nothing changes', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const { clientRef: _c, ...noRef } = repl(bw) as any;
    expect((await correct(s, orig.id, body('x', noRef))).status).toBe(400);
    expect((await correct(s, orig.id, { replacement: repl(bw) })).status).toBe(400);
    expect((await correct(s, orig.id, { ...body('x', repl(bw)), extra: 1 })).status).toBe(400);
    const blank = await correct(s, orig.id, body('   ', repl(bw)));
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_ERROR');
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('2. atomic failure: a replacement the create refuses (unknown service type) leaves the original posted and the database unchanged', async () => {
    const { s } = await setup();
    const orig = await make(s, daysAgo(10));
    const fp = fingerprint(s.ctx);
    const r = await correct(s, orig.id, body('try', repl(99999)));
    expect([r.status, r.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(status(s, orig.id).status).toBe('posted');
    expect(fingerprint(s.ctx)).toBe(fp);
    const p = await prev(s, orig.id, body('try', repl(99999)));
    expect(p.body.error.code).toBe('VALIDATION_ERROR');
    const future = await correct(s, orig.id, body('try', repl(1, { businessDate: daysAgo(-3) })));
    expect(future.body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('3. void-side refusal (closed day of the original) is the void\'s own DAY_CLOSED and changes nothing', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    await closeOk(s, 'shop', daysAgo(10));
    const fp = fingerprint(s.ctx);
    const r = await correct(s, orig.id, body('late', repl(bw)));
    expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('4. closed day (R9) and backdating before a closed day are refused for the replacement and for the original', async () => {
    const { s, bw } = await setup();
    const early = await make(s, daysAgo(30));
    const a = await make(s, daysAgo(10));
    const b = await make(s, daysAgo(10));
    await closeOk(s, 'shop', daysAgo(20));
    const fp = fingerprint(s.ctx);
    const closed = await correct(s, a.id, body('x', repl(bw, { businessDate: daysAgo(20) })));
    expect([closed.status, closed.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    const before = await correct(s, b.id, body('x', repl(bw, { businessDate: daysAgo(25) })));
    expect([before.status, before.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    const old = await correct(s, early.id, body('x', repl(bw)));
    expect([old.status, old.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    expect(fingerprint(s.ctx)).toBe(fp);
    expect((await chk(s, early.id)).body).toMatchObject({ eligible: false, code: 'BACKDATE_BEFORE_CLOSED_DAY' });
  });

  it('5. a void that leaves the shop cash negative is a warning, not a block (de-duplicated)', async () => {
    const s = await apiBase(await env.build()); // no opening balance: the sale is the only cash
    const bw = await typeIdOf(s, 'BW_1S');
    const orig = await make(s, daysAgo(10));
    expect((await expNew(s, { businessDate: daysAgo(9), amountCents: 4000 })).status).toBe(201);
    const r = await correct(s, orig.id, body('big', repl(bw)));
    expect(r.status).toBe(201);
    const codes = r.body.warnings.map((x: any) => x.code);
    expect(codes).toContain('NEGATIVE_CASH_BALANCE');
    expect(new Set(r.body.warnings.map((w: any) => JSON.stringify(w))).size).toBe(r.body.warnings.length);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('5b. a price below the standard cost is the create\'s PRICE_BELOW_COST warning, never a block', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const r = await correct(s, orig.id, body('cheap', repl(bw, { unitPriceCents: 100 })));
    expect(r.status).toBe(201);
    expect(r.body.warnings).toContain('PRICE_BELOW_COST');
    expect(r.body.comparison).toMatchObject({ replacementUnitPriceCents: 100, replacementRevenueCents: 500, grossProfitDifferenceCents: 500 - 3250 - 2550 });
  });

  it('6. the same replacement clientRef twice is a 200 replay with exactly one replacement; another original is refused', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const other = await make(s, daysAgo(10));
    const rep = repl(bw);
    const first = await correct(s, orig.id, body('once', rep));
    expect(first.status).toBe(201);
    const n = count(s.ctx, 'print_sales');
    const fp = fingerprint(s.ctx);
    const again = await correct(s, orig.id, body('once', rep));
    expect(again.status).toBe(200);
    expect(again.body.replacement).toEqual(first.body.replacement);
    expect(again.body.original).toEqual(first.body.original);
    expect(again.body.correction).toEqual(first.body.correction);
    expect(again.body.comparison).toEqual(first.body.comparison);
    expect(count(s.ctx, 'print_sales')).toBe(n);
    expect(fingerprint(s.ctx)).toBe(fp);
    const stolen = await correct(s, other.id, body('other', rep));
    expect(stolen.status).toBe(409);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('7. two concurrent corrections of the same original: exactly one succeeds', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const rs = await Promise.all([correct(s, orig.id, body('a', repl(bw))), correct(s, orig.id, body('b', repl(bw)))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('ALREADY_VOID');
    expect(posted(s)).toBe(1);
    expect(count(s.ctx, 'corrections')).toBe(1);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('8. check and preview save nothing and agree with the real call', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    const rep = repl(bw);
    const fp = fingerprint(s.ctx);
    expect((await chk(s, orig.id)).body).toEqual({ eligible: true });
    const p = await prev(s, orig.id, body('why', rep));
    expect(p.status).toBe(200);
    expect(p.body.original).toMatchObject({ id: orig.id, status: 'void' });
    expect(p.body.correction).toBeUndefined();
    expect(fingerprint(s.ctx)).toBe(fp);
    const r = await correct(s, orig.id, body('why', rep));
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ qty: 5, businessDate: p.body.replacement.businessDate, revenueCents: p.body.replacement.revenueCents });
    expect(r.body.warnings).toEqual(p.body.warnings);
    expect(r.body.comparison).toEqual(p.body.comparison);
    const x = await make(s, daysAgo(12));
    await closeOk(s, 'shop', daysAgo(12));
    const fp2 = fingerprint(s.ctx);
    const c = (await chk(s, x.id)).body;
    expect(c.eligible).toBe(false);
    const pv = await prev(s, x.id, body('why', repl(bw)));
    const rl = await correct(s, x.id, body('why', repl(bw)));
    expect([pv.status, pv.body.error.code]).toEqual([rl.status, rl.body.error.code]);
    expect(c.code).toBe(rl.body.error.code);
    expect(fingerprint(s.ctx)).toBe(fp2);
  });

  it('9. an already void original is 409 ALREADY_VOID everywhere; a missing id is 404', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10));
    expect((await post(s.app, `/print-sales/${orig.id}/void`, { reason: 'gone' })).status).toBe(200);
    const fp = fingerprint(s.ctx);
    expect((await chk(s, orig.id)).body).toMatchObject({ eligible: false, code: 'ALREADY_VOID' });
    for (const call of [prev, correct]) {
      const r = await call(s, orig.id, body('x', repl(bw)));
      expect([r.status, r.body.error.code]).toEqual([409, 'ALREADY_VOID']);
    }
    expect((await chk(s, 99999)).status).toBe(404);
    expect((await prev(s, 99999, body('x', repl(bw)))).status).toBe(404);
    expect((await correct(s, 99999, body('x', repl(bw)))).status).toBe(404);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('10a. a switched-off service type refuses the replacement exactly as a new print sale would', async () => {
    const { s, bw, clr } = await setup();
    const orig = await make(s, daysAgo(10));
    const t = (await get(s.app, '/print-service-types')).body.items.find((x: any) => x.id === clr);
    expect((await typePut(s, clr, { name: t.name, priceCents: t.priceCents, costCents: t.costCents, active: false })).status).toBe(200);
    const fp = fingerprint(s.ctx);
    const manual = await post(s.app, '/print-sales', { businessDate: daysAgo(10), serviceTypeId: clr, qty: 2, clientRef: ref() });
    expect(manual.body.error.code).toBe('SERVICE_TYPE_INACTIVE');
    for (const call of [prev, correct]) {
      const r = await call(s, orig.id, body('switch', repl(clr)));
      expect([r.status, r.body.error.code]).toEqual([manual.status, 'SERVICE_TYPE_INACTIVE']);
      expect(r.body.error.message).toBe(manual.body.error.message);
    }
    expect(status(s, orig.id).status).toBe('posted');
    expect(fingerprint(s.ctx)).toBe(fp);
    // the original's own type being switched off blocks the replacement of the same type, but not the void side
    const t2 = (await get(s.app, '/print-service-types')).body.items.find((x: any) => x.id === bw);
    expect((await typePut(s, bw, { name: t2.name, priceCents: t2.priceCents, costCents: t2.costCents, active: false })).status).toBe(200);
    expect((await chk(s, orig.id)).body).toEqual({ eligible: true });
    const fp2 = fingerprint(s.ctx);
    expect((await correct(s, orig.id, body('same type', repl(bw)))).body.error.code).toBe('SERVICE_TYPE_INACTIVE');
    expect(fingerprint(s.ctx)).toBe(fp2);
  });

  it('10b. a service type whose price and cost changed since the original shows the difference in comparison (replacement uses today\'s values)', async () => {
    const { s, bw } = await setup();
    const orig = await make(s, daysAgo(10)); // 3 x 1500 price, 650 cost
    const t = (await get(s.app, '/print-service-types')).body.items.find((x: any) => x.id === bw);
    expect((await typePut(s, bw, { name: t.name, priceCents: 1800, costCents: 700, active: true })).status).toBe(200);
    const p = await prev(s, orig.id, body('same qty', { serviceTypeId: bw, qty: 3, clientRef: ref() }));
    expect(p.body.comparison).toMatchObject({
      originalUnitPriceCents: 1500, replacementUnitPriceCents: 1800, originalUnitCostCents: 650, replacementUnitCostCents: 700,
      originalRevenueCents: 4500, replacementRevenueCents: 5400, revenueDifferenceCents: 900,
      originalCogsCents: 1950, replacementCogsCents: 2100, cogsDifferenceCents: 150, grossProfitDifferenceCents: 750,
    });
    const r = await correct(s, orig.id, body('same qty', { serviceTypeId: bw, qty: 3, clientRef: ref() }));
    expect(r.body.comparison).toEqual(p.body.comparison);
    expect(r.body.replacement).toMatchObject({ unitPriceCents: 1800, unitCostCents: 700, revenueCents: 5400 });
    // an explicit price keeps that price, only the cost snapshot follows the type
    const orig2 = await make(s, daysAgo(10), { unitPriceCents: 1500 });
    const r2 = await correct(s, orig2.id, body('keep price', { serviceTypeId: bw, qty: 3, unitPriceCents: 1500, clientRef: ref() }));
    expect(r2.body.comparison).toMatchObject({ revenueDifferenceCents: 0, cogsDifferenceCents: 3 * (700 - 700) + 0 });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('10c. a free sale (no cash entry) corrects to a paid one and back; the service type can change', async () => {
    const { s, bw, clr } = await setup();
    const free = await make(s, daysAgo(10), { unitPriceCents: 0 });
    expect(sql(s, "SELECT COUNT(*) AS n FROM cash_entries WHERE ref_table = 'print_sales' AND ref_id = ?", free.id)[0]!.n).toBe(0);
    const r = await correct(s, free.id, body('was paid', repl(clr, { qty: 2 })));
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ serviceTypeId: clr, revenueCents: 4000 });
    expect(r.body.comparison).toMatchObject({ originalRevenueCents: 0, replacementRevenueCents: 4000, originalServiceTypeId: bw, replacementServiceTypeId: clr });
    const back = await correct(s, r.body.replacement.id, body('was free', repl(bw, { unitPriceCents: 0 })));
    expect(back.status).toBe(201);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('11. a corrected record can itself be corrected (chain)', async () => {
    const { s, bw } = await setup();
    const a = await make(s, daysAgo(10));
    const r1 = await correct(s, a.id, body('first', repl(bw)));
    const r2 = await correct(s, r1.body.replacement.id, body('second', repl(bw)));
    expect(r2.status).toBe(201);
    expect(status(s, a.id).status).toBe('void');
    expect(status(s, r1.body.replacement.id).status).toBe('void');
    expect(status(s, r2.body.replacement.id).status).toBe('posted');
    const ids = [a.id, r1.body.replacement.id, r2.body.replacement.id].join(',');
    expect((await get(s.app, `/corrections?entity=print_sales&ids=${ids}`)).body.items).toHaveLength(2);
    expect(allProblems(s.ctx)).toEqual([]);
  });
});
