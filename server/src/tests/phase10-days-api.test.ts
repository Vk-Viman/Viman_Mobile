// Phase 10 daily entries API (BUSINESS_RULES 10.2, 10.3, D2, C9, R1, R9, R-FD, section 12). Protects:
//   10.2  a day writes ONE icecream_sale cash entry per NON-ZERO fund share (Cost C, Electricity E, Profit S-C-E), each naming its fund,
//         each with a daily_allocation fund row; the three shares always sum to S; zero shares write nothing;
//   10.3  negative profit share needs confirmNegativeProfit (422 NEGATIVE_PROFIT_UNCONFIRMED), the server computes the share;
//   items  optional lines must sum to sales (422 ITEMS_TOTAL_MISMATCH); validation (no coercion, unknown fields, postedAt refused);
//   one posted day per date (409 DAY_EXISTS); clientRef repeat returns the first entry; R-FD and backdating (audited);
//   R9    DAY_CLOSED for create, replace and void, reopen lifts it;
//   C9/D2 PUT = void-and-replace in ONE transaction, judged on the FINAL state (422 VOID_BREAKS_RELEASE); void guard; 404s;
//   R1    voids are reversal rows with the original business date; rollback leaves nothing behind (record, items, cash, fund rows, audit).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, err, num, sql } from './helpers/phase4.ts';
import { cashOfRef, closeOk, fundOfRef, reopenNew } from './helpers/phase8.ts';
import { DAY_KEYS, dayNew, dayOk, dayReplace, dayVoid, expectBooksAgree, fundsGet, moveOk, rs, snap10 } from './helpers/phase10.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('POST /icecream/days - create', () => {
  it('201 { day, funds, warnings }: exact shape, profit share computed by the server, audit with business date + backdated', async () => {
    const s = await setup();
    const r = await dayNew(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100), notes: '  busy day ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['day', 'funds', 'warnings']);
    const d = r.body.day;
    expect(Object.keys(d).sort()).toEqual(DAY_KEYS);
    expect(d).toMatchObject({ businessDate: today(), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100), profitShareCents: rs(300),
      negativeConfirmed: false, notes: 'busy day', status: 'posted', backdated: false, voidedAt: null, voidReason: null, items: [] });
    expect(r.body.funds.funds).toEqual({ cost: { balanceCents: rs(600) }, electricity: { balanceCents: rs(100) }, profit: { balanceCents: rs(300) } });
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(300));
    expect(r.body.warnings).toEqual([]);
    const a = auditRows(s.ctx, 'icecream_day');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', before: null, entityId: String(d.id) });
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'icecream_day'")[0]).toMatchObject({ business_date: today(), backdated: 0 });
    expect((await get(s.app, `/icecream/days/${today()}`)).body.day).toEqual(d);
  });

  it('10.2: one icecream_sale cash entry per non-zero share, each naming its fund, each with a daily_allocation fund row; shares sum to S', async () => {
    const s = await setup();
    const d = await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const cash = cashOfRef(s, 'icecream_days', d.id);
    expect(cash.map((c) => [c.fund, c.amount_cents, c.type, c.book, c.business_date])).toEqual([
      ['cost', rs(600), 'icecream_sale', 'icecream', today()], ['electricity', rs(100), 'icecream_sale', 'icecream', today()], ['profit', rs(300), 'icecream_sale', 'icecream', today()],
    ]);
    expect(cash.reduce((t, c) => t + c.amount_cents, 0)).toBe(rs(1000));
    const funds = fundOfRef(s, 'icecream_days', d.id);
    expect(funds.map((f) => [f.fund, f.amount_cents, f.kind])).toEqual([['cost', rs(600), 'daily_allocation'], ['electricity', rs(100), 'daily_allocation'], ['profit', rs(300), 'daily_allocation']]);
    await expectBooksAgree(s);
  });

  it('a zero share writes nothing: no electricity allocation -> two entries; sales 0 -> a day record with no cash entry at all', async () => {
    const s = await setup();
    const a = await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(500), costAllocCents: rs(500), electricityAllocCents: 0 });
    expect(cashOfRef(s, 'icecream_days', a.id).map((c) => c.fund)).toEqual(['cost']); // profit share 0 as well
    const b = await dayOk(s, { businessDate: daysAgo(1), salesCents: 0, costAllocCents: 0, electricityAllocCents: 0 });
    expect(b.profitShareCents).toBe(0);
    expect(cashOfRef(s, 'icecream_days', b.id)).toHaveLength(0);
    expect(fundOfRef(s, 'icecream_days', b.id)).toHaveLength(0);
    await expectBooksAgree(s);
  });

  it('10.3: allocations above sales give a negative profit share -> 422 NEGATIVE_PROFIT_UNCONFIRMED, nothing written; confirmed -> saved with a negative profit entry', async () => {
    const s = await setup();
    const before = snap10(s);
    const r = await dayNew(s, { salesCents: rs(1000), costAllocCents: rs(900), electricityAllocCents: rs(200) });
    expect(r.status).toBe(422);
    expect(err(r)).toMatchObject({ code: 'NEGATIVE_PROFIT_UNCONFIRMED', profitShareCents: rs(-100) });
    expect(err(r).fields.confirmNegativeProfit).toBeTruthy();
    expect(snap10(s)).toEqual(before);
    const bad = await dayNew(s, { salesCents: rs(1000), costAllocCents: rs(900), electricityAllocCents: rs(200), confirmNegativeProfit: false });
    expect(err(bad).code).toBe('NEGATIVE_PROFIT_UNCONFIRMED');
    const ok = await dayNew(s, { salesCents: rs(1000), costAllocCents: rs(900), electricityAllocCents: rs(200), confirmNegativeProfit: true });
    expect(ok.status).toBe(201);
    expect(ok.body.day).toMatchObject({ profitShareCents: rs(-100), negativeConfirmed: true });
    expect(cashOfRef(s, 'icecream_days', ok.body.day.id).map((c) => [c.fund, c.amount_cents])).toEqual([['cost', rs(900)], ['electricity', rs(200)], ['profit', rs(-100)]]);
    expect(ok.body.funds.recognizedProfitToDateCents).toBe(rs(-100));
    expect(ok.body.funds.funds.profit.balanceCents).toBe(rs(-100));
    expect(ok.body.warnings.map((w: any) => w.code)).toContain('NEGATIVE_FUND_BALANCE');
    await expectBooksAgree(s);
  });

  it('confirmNegativeProfit on a positive share is accepted but not stored as a confirmed negative', async () => {
    const s = await setup();
    const d = await dayOk(s, { confirmNegativeProfit: true });
    expect(d.negativeConfirmed).toBe(false);
  });

  it('items: lines are stored and must sum exactly to sales (422 ITEMS_TOTAL_MISMATCH writes nothing)', async () => {
    const s = await setup();
    const items = [{ itemName: ' Cone ', qty: 10, unitPriceCents: rs(60) }, { itemName: 'Cup', qty: 8, unitPriceCents: rs(50) }];
    const before = snap10(s);
    const bad = await dayNew(s, { salesCents: rs(1001), costAllocCents: rs(600), electricityAllocCents: rs(100), items });
    expect(bad.status).toBe(422);
    expect(err(bad)).toMatchObject({ code: 'ITEMS_TOTAL_MISMATCH', itemsTotalCents: rs(1000), salesCents: rs(1001) });
    expect(snap10(s)).toEqual(before);
    const ok = await dayNew(s, { salesCents: rs(1000), items });
    expect(ok.status).toBe(201);
    expect(ok.body.day.items).toEqual([
      { id: expect.any(Number), itemName: 'Cone', qty: 10, unitPriceCents: rs(60), lineTotalCents: rs(600) },
      { id: expect.any(Number), itemName: 'Cup', qty: 8, unitPriceCents: rs(50), lineTotalCents: rs(400) },
    ]);
    expect(num(s, 'SELECT COUNT(*) FROM icecream_sales')).toBe(2);
    // an empty items array is the same as no items
    expect((await dayNew(s, { businessDate: daysAgo(1), items: [] })).status).toBe(201);
  });

  it('validation: types without coercion, bounds, unknown fields, postedAt, dates, clientRef - all 400 and nothing written', async () => {
    const s = await setup();
    const before = snap10(s);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ salesCents: -1 }, 'salesCents'], [{ salesCents: 10.5 }, 'salesCents'], [{ salesCents: '1000' }, 'salesCents'], [{ salesCents: null }, 'salesCents'],
      [{ salesCents: 1e12 + 1 }, 'salesCents'], [{ costAllocCents: -5 }, 'costAllocCents'], [{ electricityAllocCents: 1.5 }, 'electricityAllocCents'],
      [{ businessDate: '11/11/2026' }, 'businessDate'], [{ businessDate: '2026-02-30' }, 'businessDate'], [{ businessDate: '2026-13-01' }, 'businessDate'],
      [{ clientRef: 'short' }, 'clientRef'], [{ postedAt: '2020-01-01T00:00:00Z' }, 'postedAt'], [{ profitShareCents: 5 }, 'profitShareCents'],
      [{ confirmNegativeProfit: 'yes' }, 'confirmNegativeProfit'], [{ notes: 'x'.repeat(501) }, 'notes'],
      [{ items: [{ itemName: '  ', qty: 1, unitPriceCents: rs(1000) }] }, 'items.0.itemName'], [{ items: [{ itemName: 'a', qty: 0, unitPriceCents: 1 }] }, 'items.0.qty'],
      [{ items: [{ itemName: 'a', qty: 1, unitPriceCents: -1 }] }, 'items.0.unitPriceCents'], [{ items: [{ itemName: 'a', qty: 1, unitPriceCents: 1, extra: 1 }] }, 'items.0.extra'],
      [{ items: 'none' }, 'items'], [{ items: [{ itemName: 'x'.repeat(101), qty: 1, unitPriceCents: rs(1000) }] }, 'items.0.itemName'],
    ];
    for (const [over, field] of cases) {
      const r = await dayNew(s, over);
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields), JSON.stringify(over)).toContain(field);
    }
    for (const missing of ['businessDate', 'salesCents', 'costAllocCents', 'electricityAllocCents', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), salesCents: 100, costAllocCents: 10, electricityAllocCents: 10, clientRef: ref() };
      delete body[missing];
      const r = await post(s.app, '/icecream/days', body);
      expect(r.status, missing).toBe(400);
      expect(Object.keys(err(r).fields)).toContain(missing);
    }
    expect(snap10(s)).toEqual(before);
  });

  it('R-FD: a future date is 400 FUTURE_DATE_NOT_ALLOWED with the owner wording; backdating is accepted and flagged in the audit', async () => {
    const s = await setup();
    const f = await dayNew(s, { businessDate: daysAhead(1) });
    expect(f.status).toBe(400);
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    expect(num(s, 'SELECT COUNT(*) FROM icecream_days')).toBe(0);
    const b = await dayNew(s, { businessDate: daysAgo(5) });
    expect(b.status).toBe(201);
    expect(b.body.day.backdated).toBe(true);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'icecream_day'")[0]).toMatchObject({ business_date: daysAgo(5), backdated: 1 });
    expect(cashOfRef(s, 'icecream_days', b.body.day.id).every((c) => c.business_date === daysAgo(5))).toBe(true);
  });

  it('one posted entry per date: 409 DAY_EXISTS points to PUT; after a void a new entry for the date is accepted', async () => {
    const s = await setup();
    const d = await dayOk(s);
    const before = snap10(s);
    const r = await dayNew(s, {});
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: 'DAY_EXISTS', businessDate: today(), existingId: d.id, replaceWith: `PUT /icecream/days/${today()}` });
    expect(snap10(s)).toEqual(before);
    expect((await dayVoid(s, today())).status).toBe(200);
    expect((await dayNew(s, {})).status).toBe(201);
    expect(num(s, "SELECT COUNT(*) FROM icecream_days WHERE business_date = ? AND status = 'posted'", today())).toBe(1);
  });

  it('duplicate submission: the same clientRef returns the first entry (200), no second entry, cash entry, fund row or audit row', async () => {
    const s = await setup();
    const clientRef = ref();
    const a = await dayNew(s, { clientRef });
    const before = snap10(s);
    const b = await dayNew(s, { clientRef });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.day).toEqual(a.body.day);
    expect(snap10(s)).toEqual(before);
    // a repeat with a different body still returns the first entry (the reference identifies the submission)
    const c = await dayNew(s, { clientRef, salesCents: rs(5) });
    expect(c.status).toBe(200);
    expect(c.body.day.salesCents).toBe(rs(1000));
  });
});

describe('GET /icecream/days', () => {
  it('newest business date first, posted and void rows listed, totals count POSTED rows only, filters and paging', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(3), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(2000), costAllocCents: rs(1000), electricityAllocCents: rs(200) });
    await dayOk(s, { businessDate: daysAgo(1), salesCents: rs(500), costAllocCents: rs(200), electricityAllocCents: rs(50) });
    await dayVoid(s, daysAgo(1));
    const all = (await get(s.app, '/icecream/days')).body;
    expect(all.items.map((d: any) => [d.businessDate, d.status])).toEqual([[daysAgo(1), 'void'], [daysAgo(2), 'posted'], [daysAgo(3), 'posted']]);
    expect(all.total).toBe(3);
    expect(all.totals).toEqual({ salesCents: rs(3000), costAllocCents: rs(1600), electricityAllocCents: rs(300), profitShareCents: rs(1100) });
    expect((await get(s.app, `/icecream/days?from=${daysAgo(2)}&to=${daysAgo(2)}`)).body.items).toHaveLength(1);
    expect((await get(s.app, '/icecream/days?status=void')).body.items).toHaveLength(1);
    expect((await get(s.app, '/icecream/days?limit=1&offset=1')).body.items.map((d: any) => d.businessDate)).toEqual([daysAgo(2)]);
    expect((await get(s.app, '/icecream/days?limit=0')).status).toBe(400);
    expect((await get(s.app, '/icecream/days?from=2026-13-01')).status).toBe(400);
    expect((await get(s.app, '/icecream/days?status=bogus')).status).toBe(400);
    expect((await get(s.app, `/icecream/days/${daysAgo(1)}`)).status).toBe(404); // only the voided row exists for that date
    expect(err(await get(s.app, '/icecream/days/2020-01-01')).code).toBe('NOT_FOUND');
  });
});

describe('POST /icecream/days/:date/void', () => {
  it('R1: reversal rows with the original business date, day void, funds back to zero; audit with the reason', async () => {
    const s = await setup();
    const date = daysAgo(2);
    const d = await dayOk(s, { businessDate: date });
    const r = await dayVoid(s, date, 'entered twice');
    expect(r.status).toBe(200);
    expect(r.body.day).toMatchObject({ status: 'void', voidReason: 'entered twice', id: d.id });
    expect(r.body.day.voidedAt).toBeTruthy();
    expect(r.body.funds.totalCents).toBe(0);
    const cash = cashOfRef(s, 'icecream_days', d.id);
    expect(cash).toHaveLength(6);
    for (const c of cash.slice(3)) {
      expect(c.reverses_entry_id).not.toBeNull();
      expect(c.business_date).toBe(date); // the correction lands in the SAME period
      expect(c.type).toBe('icecream_sale');
    }
    expect(fundOfRef(s, 'icecream_days', d.id).filter((f) => f.kind === 'reversal')).toHaveLength(3);
    await expectBooksAgree(s);
    expect(auditRows(s.ctx, 'icecream_day').map((a) => a.action)).toEqual(['create', 'void']);
    expect(sql(s, "SELECT business_date, backdated, note FROM audit_logs WHERE action = 'void'")[0]).toMatchObject({ business_date: date, backdated: 1, note: 'entered twice' });
  });

  it('404 when no posted entry exists (never created, already void); reason is required; bad date is 400', async () => {
    const s = await setup();
    expect((await dayVoid(s, today())).status).toBe(404);
    await dayOk(s);
    expect((await post(s.app, `/icecream/days/${today()}/void`, { reason: '   ' })).status).toBe(400);
    expect((await post(s.app, `/icecream/days/${today()}/void`, {})).status).toBe(400);
    expect((await post(s.app, '/icecream/days/2026-02-30/void', { reason: 'x' })).status).toBe(400);
    expect((await dayVoid(s, today())).status).toBe(200);
    expect(err(await dayVoid(s, today())).code).toBe('NOT_FOUND');
  });

  it('D2: blocked with 422 VOID_BREAKS_RELEASE while released profit depends on it; allowed after the release is voided', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const rel = await moveOk(s, 'cost', 'profit', rs(600));
    expect(rel.profitEffectCents).toBe(rs(600));
    const before = snap10(s);
    const r = await dayVoid(s, today());
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('VOID_BREAKS_RELEASE');
    expect(err(r).message).toContain('reverse the release first');
    expect(snap10(s)).toEqual(before);
    expect((await post(s.app, `/icecream/fund-moves/${rel.id}/void`, { reason: 'undo release' })).status).toBe(200);
    expect((await dayVoid(s, today())).status).toBe(200);
    await expectBooksAgree(s);
  });

  it('a void that only creates an excess cost (no release) is allowed and the excess warning appears', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await post(s.app, '/icecream/payments', { businessDate: today(), kind: 'materials', fund: 'cost', amountCents: rs(600), description: 'Milk', clientRef: ref() });
    const r = await dayVoid(s, today());
    expect(r.status).toBe(200);
    expect(r.body.funds.outstandingExcessCostCents).toBe(rs(600));
    expect(r.body.warnings.map((w: any) => w.code)).toContain('EXCESS_COST_OUTSTANDING');
    expect(r.body.funds.recognizedProfitToDateCents).toBe(0); // official profit is not reduced automatically
  });
});

describe('PUT /icecream/days/:date - void-and-replace (C9)', () => {
  it('replaces in one transaction: old entry void with reversals, new entry posted for the SAME date, funds follow, audit void + replace', async () => {
    const s = await setup();
    const date = daysAgo(1);
    const old = await dayOk(s, { businessDate: date, salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const r = await dayReplace(s, date, { salesCents: rs(1200), costAllocCents: rs(700), electricityAllocCents: rs(120), reason: 'miscounted', notes: 'fixed' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['day', 'funds', 'warnings']);
    const fresh = r.body.day;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh).toMatchObject({ businessDate: date, salesCents: rs(1200), profitShareCents: rs(380), status: 'posted', notes: 'fixed' });
    expect((await get(s.app, `/icecream/days?from=${date}&to=${date}`)).body.items.map((d: any) => [d.id, d.status])).toEqual([[fresh.id, 'posted'], [old.id, 'void']]); // newest posting first
    expect(sql(s, 'SELECT status, void_reason FROM icecream_days WHERE id = ?', old.id)[0]).toMatchObject({ status: 'void', void_reason: 'miscounted' });
    expect(r.body.funds.funds).toEqual({ cost: { balanceCents: rs(700) }, electricity: { balanceCents: rs(120) }, profit: { balanceCents: rs(380) } });
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(380));
    expect(cashOfRef(s, 'icecream_days', old.id)).toHaveLength(6);
    expect(cashOfRef(s, 'icecream_days', fresh.id)).toHaveLength(3);
    expect(auditRows(s.ctx, 'icecream_day').map((a) => a.action)).toEqual(['create', 'void', 'replace']);
    await expectBooksAgree(s);
    // the replacement carries the replaced date and is itself subject to the one-posted-per-date rule
    expect((await dayNew(s, { businessDate: date })).status).toBe(409);
  });

  it('404 when there is nothing to replace; R-FD on the path date; validation like create; default reason', async () => {
    const s = await setup();
    expect((await dayReplace(s, today())).status).toBe(404);
    const f = await dayReplace(s, daysAhead(1));
    expect(f.status).toBe(400);
    expect(err(f).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect((await dayReplace(s, '2026-02-30')).status).toBe(400);
    await dayOk(s);
    expect((await dayReplace(s, today(), { salesCents: -1 })).status).toBe(400);
    expect((await dayReplace(s, today(), { businessDate: today() })).status).toBe(400); // the date is the path, not the body
    expect((await dayReplace(s, today(), { salesCents: rs(100), costAllocCents: rs(10), electricityAllocCents: rs(10), items: [{ itemName: 'a', qty: 1, unitPriceCents: 5 }] })).status).toBe(422);
    const ok = await dayReplace(s, today(), { salesCents: rs(100), costAllocCents: rs(100), electricityAllocCents: 0 });
    expect(ok.status).toBe(200);
    expect(sql(s, "SELECT void_reason FROM icecream_days WHERE status = 'void'")[0]!.void_reason).toBe('Replaced by a corrected entry');
  });

  it('negative profit in the replacement needs confirmation; nothing changes without it', async () => {
    const s = await setup();
    const old = await dayOk(s);
    const before = snap10(s);
    const r = await dayReplace(s, today(), { salesCents: rs(100), costAllocCents: rs(100), electricityAllocCents: rs(10) });
    expect(err(r).code).toBe('NEGATIVE_PROFIT_UNCONFIRMED');
    expect(snap10(s)).toEqual(before);
    expect(sql(s, 'SELECT status FROM icecream_days WHERE id = ?', old.id)[0]!.status).toBe('posted');
  });

  it('D2 on the FINAL state: lowering the allocation a release depends on is 422 VOID_BREAKS_RELEASE; raising or keeping it is fine', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await moveOk(s, 'cost', 'profit', rs(600));
    const before = snap10(s);
    const low = await dayReplace(s, today(), { salesCents: rs(1000), costAllocCents: rs(500), electricityAllocCents: rs(200) });
    expect(low.status).toBe(422);
    expect(err(low).code).toBe('VOID_BREAKS_RELEASE');
    expect(snap10(s)).toEqual(before);
    expect((await dayReplace(s, today(), { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) })).status).toBe(200); // identical
    expect((await dayReplace(s, today(), { salesCents: rs(1500), costAllocCents: rs(900), electricityAllocCents: rs(100) })).status).toBe(200); // raised
    expect((await dayReplace(s, today(), { salesCents: rs(1000), costAllocCents: rs(700), electricityAllocCents: rs(0) })).status).toBe(200); // electricity lowered, cost raised
    await expectBooksAgree(s);
  });

  it('duplicate submission: the same clientRef returns the replacement (200) and replaces only once', async () => {
    const s = await setup();
    await dayOk(s);
    const clientRef = ref();
    const a = await dayReplace(s, today(), { clientRef, salesCents: rs(1100), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const before = snap10(s);
    const b = await dayReplace(s, today(), { clientRef, salesCents: rs(1100), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.day).toEqual(a.body.day);
    expect(snap10(s)).toEqual(before);
  });
});

describe('R9 - closed days', () => {
  it('create, replace and void on a closed Ice Cream day are 409 DAY_CLOSED (book + date), nothing written; other days and a reopen work', async () => {
    const s = await setup();
    const date = daysAgo(3);
    const d = await dayOk(s, { businessDate: date });
    const closing = await closeOk(s, 'icecream', date);
    const before = snap10(s);
    const msg = 'That day is closed for the Ice Cream cash book. Reopen it first (it will be recorded in the audit log).';
    for (const r of [await dayNew(s, { businessDate: date, clientRef: ref() }), await dayReplace(s, date), await dayVoid(s, date)]) {
      expect(r.status).toBe(409);
      expect(err(r)).toMatchObject({ code: 'DAY_CLOSED', message: msg, book: 'icecream', businessDate: date });
    }
    expect(snap10(s)).toEqual(before);
    expect((await dayNew(s, { businessDate: daysAgo(2) })).status).toBe(201); // another day is unaffected
    expect((await reopenNew(s, closing.id)).status).toBe(200);
    expect((await dayReplace(s, date, { salesCents: rs(10), costAllocCents: rs(1), electricityAllocCents: rs(1) })).status).toBe(200);
    expect(sql(s, 'SELECT status FROM icecream_days WHERE id = ?', d.id)[0]!.status).toBe('void');
  });

  it('a closed SHOP day does not block Ice Cream (segments are disjoint)', async () => {
    const s = await setup();
    await closeOk(s, 'shop', today());
    expect((await dayNew(s, {})).status).toBe(201);
  });

  it('even a zero-sales entry (no cash entry) is refused on a closed day', async () => {
    const s = await setup();
    await closeOk(s, 'icecream', today());
    const r = await dayNew(s, { salesCents: 0, costAllocCents: 0, electricityAllocCents: 0 });
    expect(err(r).code).toBe('DAY_CLOSED');
  });
});

describe('rollback: one transaction per daily-entry write', () => {
  it('a failing audit insert leaves no day, items, cash entry, fund row or audit row', async () => {
    quiet();
    const s = await setup();
    const before = snap10(s);
    breakAudit(s.ctx, 'icecream_day');
    expect((await dayNew(s, { items: [{ itemName: 'Cone', qty: 1, unitPriceCents: rs(1000) }] })).status).toBe(500);
    expect(snap10(s)).toEqual(before);
  });

  it('a failing LAST cash insert (the profit share) rolls back the whole entry; the same clientRef works once the fault is gone', async () => {
    quiet();
    const s = await setup();
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries WHEN NEW.type = 'icecream_sale' AND NEW.fund = 'profit' BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    const clientRef = ref();
    expect((await dayNew(s, { clientRef })).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_cash');
    expect((await dayNew(s, { clientRef })).status).toBe(201);
  });

  it('a failing replacement leaves the OLD entry posted and every ledger untouched (void-and-replace is atomic)', async () => {
    quiet();
    const s = await setup();
    const old = await dayOk(s);
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'replace' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await dayReplace(s, today(), { salesCents: rs(2000), costAllocCents: rs(1000), electricityAllocCents: rs(100) })).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    expect(sql(s, 'SELECT status FROM icecream_days WHERE id = ?', old.id)[0]!.status).toBe('posted');
    await expectBooksAgree(s);
  });

  it('a failing audit on VOID leaves the day posted and no reversal rows', async () => {
    quiet();
    const s = await setup();
    await dayOk(s);
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await dayVoid(s, today())).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    expect((await get(s.app, `/icecream/days/${today()}`)).body.day.status).toBe('posted');
  });
});

describe('funds block after writes', () => {
  it('every write returns the Funds summary of the whole book (funds sum to the cash book)', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(1) });
    const r = await dayNew(s, {});
    expect(r.body.funds.totalCents).toBe(rs(2000));
    expect(r.body.funds.reconciled).toBe(true);
    expect((await fundsGet(s)).body.totalCents).toBe(rs(2000));
  });
});
