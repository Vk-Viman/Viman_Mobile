// Phase 6 - telecom API (Fastify inject, real temp database): providers, reload sales, EZCash, top-ups, summary.
// Protects BUSINESS_RULES section 5 and section 2: the FULL collection is cash-in to the Telecom book, commission
// (+ extra) is the only revenue and is NOT a cash entry, top-ups are cash-outs, the rate is snapshotted per sale,
// R-FD (no future dates), clientRef idempotency (201 first, 200 repeat) and the error codes of API_CONTRACTS.
// Organised as: providers, reload sales (create / validation / read / void), EZCash, top-ups, summary.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, get, post, put } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, FUTURE_MSG, num } from './helpers/phase4.ts';
import {
  cashOf, ez, ezVoid, lastAudit, providerIds, putProvider, rel, relVoid, snap6, telecomCash, topProvider, topVoid, topWallet,
} from './helpers/phase6.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase & { P: Record<string, number> }> => {
  const s = await apiBase(await env.build());
  return { ...s, P: await providerIds(s) };
};

const RELOAD_KEYS = ['backdated', 'businessDate', 'clientRef', 'commissionBp', 'commissionCents', 'extraCents', 'id', 'notes', 'postedAt',
  'providerId', 'providerName', 'salesCents', 'status', 'voidReason', 'voidedAt'];
const EZ_KEYS = ['backdated', 'billTotalCents', 'businessDate', 'clientRef', 'commissionBp', 'commissionCents', 'id', 'notes', 'postedAt',
  'providerId', 'providerName', 'status', 'voidReason', 'voidedAt'];
const TOPUP_KEYS = ['amountCents', 'backdated', 'businessDate', 'clientRef', 'id', 'kind', 'notes', 'postedAt', 'providerId', 'providerName',
  'status', 'voidReason', 'voidedAt'];

// ---------------------------------------------------------------------------------------------
describe('GET/PUT /reload-providers', () => {
  it('lists the four seeded providers in order with the shop default rate (600 bp) and active', async () => {
    const s = await setup();
    const r = await get(s.app, '/reload-providers');
    expect(r.status).toBe(200);
    expect(r.body.items.map((p: any) => p.name)).toEqual(['Dialog', 'Mobitel', 'Hutch', 'Airtel']);
    for (const p of r.body.items) {
      expect(Object.keys(p).sort()).toEqual(['active', 'commissionBp', 'id', 'name', 'ownCommissionBp']);
      expect(p).toMatchObject({ commissionBp: 600, ownCommissionBp: null, active: true });
    }
  });

  it('an own rate overrides the default; null returns to the default; the default follows Settings', async () => {
    const s = await setup();
    const r = await putProvider(s, s.P.Mobitel!, { commissionBp: 750, active: true });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ name: 'Mobitel', commissionBp: 750, ownCommissionBp: 750, active: true });
    // Shop default changes to 500 bp: Mobitel keeps its own rate, Hutch (no own rate) follows the default.
    await put(s.app, '/settings', { rates: { reloadCommissionBp: 500, ezcashCommissionBp: 80 } });
    const list = (await get(s.app, '/reload-providers')).body.items;
    expect(list.find((p: any) => p.name === 'Mobitel')).toMatchObject({ commissionBp: 750, ownCommissionBp: 750 });
    expect(list.find((p: any) => p.name === 'Hutch')).toMatchObject({ commissionBp: 500, ownCommissionBp: null });
    const back = await putProvider(s, s.P.Mobitel!, { commissionBp: null, active: true });
    expect(back.body.item).toMatchObject({ commissionBp: 500, ownCommissionBp: null });
  });

  it('accepts the boundary rates 0 and 10000 and can switch a provider off and on', async () => {
    const s = await setup();
    expect((await putProvider(s, s.P.Hutch!, { commissionBp: 0, active: false })).body.item).toMatchObject({ commissionBp: 0, ownCommissionBp: 0, active: false });
    expect((await putProvider(s, s.P.Hutch!, { commissionBp: 10000, active: true })).body.item).toMatchObject({ commissionBp: 10000, active: true });
  });

  it('rejects bad bodies with 400 VALIDATION_ERROR and 404 for an unknown provider', async () => {
    const s = await setup();
    const id = s.P.Dialog!;
    for (const body of [
      { commissionBp: 10001, active: true }, { commissionBp: -1, active: true }, { commissionBp: 6.5, active: true },
      { commissionBp: '600', active: true }, { commissionBp: 600 }, { active: true }, { commissionBp: 600, active: 'yes' },
      { commissionBp: 600, active: true, name: 'Renamed' }, {},
    ]) {
      const r = await putProvider(s, id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
    }
    expect((await putProvider(s, 9999, { commissionBp: 600, active: true })).status).toBe(404);
    // Nothing changed and nothing audited.
    expect((await get(s.app, '/reload-providers')).body.items[0]).toMatchObject({ commissionBp: 600, active: true });
    expect(auditRows(s.ctx, 'reload_provider')).toHaveLength(0);
  });

  it('is audited with before and after; names are never changed', async () => {
    const s = await setup();
    await putProvider(s, s.P.Airtel!, { commissionBp: 450, active: false });
    const a = auditRows(s.ctx, 'reload_provider');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'update', entityId: String(s.P.Airtel) });
    expect(a[0]!.before).toMatchObject({ name: 'Airtel', commissionBp: 600, active: true });
    expect(a[0]!.after).toMatchObject({ name: 'Airtel', commissionBp: 450, active: false });
  });

  it('a rate change never alters an existing sale (snapshot) but applies to the next one', async () => {
    const s = await setup();
    const first = await rel(s, s.P.Dialog!, 1_000_000); // 600 bp -> 60,000
    expect(first.body.item).toMatchObject({ commissionBp: 600, commissionCents: 60_000 });
    await putProvider(s, s.P.Dialog!, { commissionBp: 1000, active: true });
    const second = await rel(s, s.P.Dialog!, 1_000_000); // 1000 bp -> 100,000
    expect(second.body.item).toMatchObject({ commissionBp: 1000, commissionCents: 100_000 });
    const again = await get(s.app, `/reload-sales/${first.body.item.id}`);
    expect(again.body.item).toMatchObject({ commissionBp: 600, commissionCents: 60_000 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /reload-sales', () => {
  // Rs 50,000 at the default 600 bp = 300,000 + Rs 50 extra (5,000) = 305,000 commission. The cash book gets the
  // whole 5,000,000 (the commission is not a cash entry, R14).
  it('creates the owner example: 3,050 commission, full 50,000 into the Telecom cash book, exact shape, audited', async () => {
    const s = await setup();
    const r = await rel(s, s.P.Dialog!, 5_000_000, { extraCents: 5_000, notes: '  evening  ', clientRef: 'reload-owner-001' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(RELOAD_KEYS);
    expect(r.body.item).toMatchObject({
      businessDate: today(), backdated: false, providerId: s.P.Dialog, providerName: 'Dialog', salesCents: 5_000_000,
      commissionBp: 600, extraCents: 5_000, commissionCents: 305_000, notes: 'evening', status: 'posted', voidedAt: null,
      voidReason: null, clientRef: 'reload-owner-001',
    });
    expect(r.body.item.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const cash = cashOf(s, 'reload_sales', r.body.item.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'telecom', type: 'reload_collection', amount_cents: 5_000_000, business_date: today(), fund: null, reverses_entry_id: null });
    expect(telecomCash(s)).toBe(5_000_000);
    const a = lastAudit(s, 'reload_sale', 'create')!;
    expect(a).toMatchObject({ entity_id: String(r.body.item.id), business_date: today(), backdated: 0 });
  });

  it('extra defaults to 0, and commission is exactly the rounded rate part (12,345.67 at 600 bp = 74,074)', async () => {
    const s = await setup();
    const r = await rel(s, s.P.Hutch!, 1_234_567);
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ extraCents: 0, commissionCents: 74_074, commissionBp: 600 });
  });

  it('uses the provider own rate when set, else the shop default from Settings', async () => {
    const s = await setup();
    await put(s.app, '/settings', { rates: { reloadCommissionBp: 550, ezcashCommissionBp: 80 } });
    await putProvider(s, s.P.Airtel!, { commissionBp: 700, active: true });
    // 1,000,000 x 550 / 10000 = 55,000 ; 1,000,000 x 700 / 10000 = 70,000.
    expect((await rel(s, s.P.Mobitel!, 1_000_000)).body.item).toMatchObject({ commissionBp: 550, commissionCents: 55_000 });
    expect((await rel(s, s.P.Airtel!, 1_000_000)).body.item).toMatchObject({ commissionBp: 700, commissionCents: 70_000 });
  });

  it('a repeated clientRef returns 200 with the original and writes nothing new', async () => {
    const s = await setup();
    const clientRef = 'reload-dup-0001';
    const a = await rel(s, s.P.Dialog!, 100_000, { clientRef });
    const before = snap6(s);
    const b = await rel(s, s.P.Dialog!, 100_000, { clientRef });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.item).toEqual(a.body.item);
    expect(snap6(s)).toEqual(before);
    // Even a changed payload under the same reference returns the original, not a second record.
    const c = await rel(s, s.P.Mobitel!, 999_999, { clientRef });
    expect(c.status).toBe(200);
    expect(c.body.item.id).toBe(a.body.item.id);
    expect(snap6(s)).toEqual(before);
  });

  it('a repeat still answers 200 after the provider was switched off (the original is returned)', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Hutch!, 50_000, { clientRef: 'reload-dup-0002' });
    await putProvider(s, s.P.Hutch!, { commissionBp: null, active: false });
    const b = await rel(s, s.P.Hutch!, 50_000, { clientRef: 'reload-dup-0002' });
    expect(b.status).toBe(200);
    expect(b.body.item.id).toBe(a.body.item.id);
  });

  it('an inactive provider is refused with 409 PROVIDER_INACTIVE and nothing is saved', async () => {
    const s = await setup();
    await putProvider(s, s.P.Hutch!, { commissionBp: null, active: false });
    const before = snap6(s);
    const r = await rel(s, s.P.Hutch!, 50_000);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('PROVIDER_INACTIVE');
    expect(err(r).fields.providerId).toContain('Hutch');
    expect(snap6(s)).toEqual(before);
    // Other providers still work; switching it back on reopens it.
    expect((await rel(s, s.P.Dialog!, 50_000)).status).toBe(201);
    await putProvider(s, s.P.Hutch!, { commissionBp: null, active: true });
    expect((await rel(s, s.P.Hutch!, 50_000)).status).toBe(201);
  });

  it('an unknown provider is 400 VALIDATION_ERROR on providerId', async () => {
    const s = await setup();
    const r = await rel(s, 99999, 50_000);
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'VALIDATION_ERROR', fields: { providerId: 'Provider not found.' } });
  });

  it('validation: bad amounts, bad types, missing fields and unknown properties are 400 and write nothing', async () => {
    const s = await setup();
    const before = snap6(s);
    const D = s.P.Dialog!;
    const bad: Array<Record<string, unknown>> = [
      { salesCents: 0 }, { salesCents: -5 }, { salesCents: 1.5 }, { salesCents: '1000' }, { salesCents: null }, { salesCents: 1_000_000_000_001 },
      { extraCents: -1 }, { extraCents: 0.5 }, { extraCents: '5' }, { extraCents: 1_000_000_000_001 },
      { providerId: 0 }, { providerId: '1' }, { clientRef: 'short' }, { clientRef: 'has spaces in it!' },
      { businessDate: '2026-02-30' }, { businessDate: '11/11/2026' }, { businessDate: '2026-13-01' }, { notes: 'x'.repeat(501) },
      { surprise: true },
    ];
    for (const over of bad) {
      const r = await rel(s, D, 100_000, over);
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
    }
    for (const omit of ['businessDate', 'providerId', 'salesCents', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), providerId: D, salesCents: 100_000, clientRef: ref() };
      delete body[omit];
      const r = await post(s.app, '/reload-sales', body);
      expect(r.status, omit).toBe(400);
    }
    expect(snap6(s)).toEqual(before);
  });

  it('R-FD: a future date is 400 FUTURE_DATE_NOT_ALLOWED with the exact message; today and earlier are allowed', async () => {
    const s = await setup();
    const before = snap6(s);
    const r = await rel(s, s.P.Dialog!, 100_000, { businessDate: daysAhead(1) });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(err(r).message).toBe(FUTURE_MSG);
    expect(err(r).fields.businessDate).toBe(FUTURE_MSG);
    expect(snap6(s)).toEqual(before);
    expect((await rel(s, s.P.Dialog!, 100_000, { businessDate: today() })).status).toBe(201);
    expect((await rel(s, s.P.Dialog!, 100_000, { businessDate: daysAgo(30) })).status).toBe(201);
  });

  it('a backdated entry is flagged: item.backdated true and the audit row carries business_date and backdated = 1', async () => {
    const s = await setup();
    const r = await rel(s, s.P.Dialog!, 100_000, { businessDate: daysAgo(3) });
    expect(r.body.item).toMatchObject({ businessDate: daysAgo(3), backdated: true });
    expect(lastAudit(s, 'reload_sale', 'create')).toMatchObject({ business_date: daysAgo(3), backdated: 1 });
    // The cash entry carries the business date too (reports follow it).
    expect(cashOf(s, 'reload_sales', r.body.item.id)[0]).toMatchObject({ business_date: daysAgo(3) });
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /reload-sales, GET /reload-sales/:id, void', () => {
  it('lists newest business date first with totals of POSTED rows only, filters and paging', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 1_000_000, { businessDate: daysAgo(2), extraCents: 100 });   // 60,000 + 100
    const b = await rel(s, s.P.Mobitel!, 2_000_000, { businessDate: daysAgo(1) });                    // 120,000
    const c = await rel(s, s.P.Dialog!, 500_000, { businessDate: today() });                          // 30,000
    await relVoid(s, b.body.item.id);
    const all = await get(s.app, '/reload-sales');
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: any) => i.id)).toEqual([c.body.item.id, b.body.item.id, a.body.item.id]);
    expect(all.body.total).toBe(3);
    // Posted only: a + c  => sales 1,500,000; commission 60,100 + 30,000 = 90,100; extra 100.
    expect(all.body.totals).toEqual({ salesCents: 1_500_000, commissionCents: 90_100, extraCents: 100 });
    const dialog = await get(s.app, `/reload-sales?providerId=${s.P.Dialog}`);
    expect(dialog.body.total).toBe(2);
    const voided = await get(s.app, '/reload-sales?status=void');
    expect(voided.body.items.map((i: any) => i.id)).toEqual([b.body.item.id]);
    expect(voided.body.totals).toEqual({ salesCents: 0, commissionCents: 0, extraCents: 0 });
    const range = await get(s.app, `/reload-sales?from=${daysAgo(1)}&to=${daysAgo(1)}`);
    expect(range.body.items.map((i: any) => i.id)).toEqual([b.body.item.id]);
    const page = await get(s.app, '/reload-sales?limit=1&offset=1');
    expect(page.body.items.map((i: any) => i.id)).toEqual([b.body.item.id]);
    expect(page.body.total).toBe(3);
  });

  it('rejects bad queries: unknown parameter, bad date, bad status, limit 0 or above 200, non-numeric provider', async () => {
    const s = await setup();
    for (const q of ['?foo=1', '?from=2026-02-30', '?from=bad', '?status=gone', '?limit=0', '?limit=201', '?providerId=abc', '?offset=-1']) {
      const r = await get(s.app, `/reload-sales${q}`);
      expect(r.status, q).toBe(400);
      expect(err(r).code, q).toBe('VALIDATION_ERROR');
    }
    expect((await get(s.app, '/reload-sales?limit=200')).status).toBe(200);
  });

  it('GET /:id returns one entry; unknown or malformed id is 404 / 400', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 100_000);
    const r = await get(s.app, `/reload-sales/${a.body.item.id}`);
    expect(r.status).toBe(200);
    expect(r.body.item).toEqual(a.body.item);
    expect((await get(s.app, '/reload-sales/9999')).status).toBe(404);
    expect(err(await get(s.app, '/reload-sales/9999')).code).toBe('NOT_FOUND');
    expect((await get(s.app, '/reload-sales/abc')).status).toBe(400);
  });

  it('void: marks the entry void, appends the reversal cash entry, second void is 409 ALREADY_VOID, audited', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 5_000_000, { businessDate: daysAgo(2) });
    const id = a.body.item.id;
    const r = await relVoid(s, id, '  typed twice  ');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'void', voidReason: 'typed twice' });
    expect(r.body.item.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const cash = cashOf(s, 'reload_sales', id);
    expect(cash.map((c) => c.amount_cents)).toEqual([5_000_000, -5_000_000]);
    expect(cash[1]).toMatchObject({ reverses_entry_id: cash[0]!.id, type: 'reload_collection', book: 'telecom', business_date: daysAgo(2) });
    expect(telecomCash(s)).toBe(0);
    const again = await relVoid(s, id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(cashOf(s, 'reload_sales', id)).toHaveLength(2);
    const audit = lastAudit(s, 'reload_sale', 'void')!;
    expect(audit).toMatchObject({ entity_id: String(id), business_date: daysAgo(2), backdated: 1, note: 'typed twice' });
  });

  it('void validation: missing/blank/overlong reason is 400, unknown id is 404, nothing is changed', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 100_000);
    const before = snap6(s);
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(201) }, { reason: 'ok', extra: 1 }]) {
      const r = await post(s.app, `/reload-sales/${a.body.item.id}/void`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(s.app, '/reload-sales/9999/void', { reason: 'x' })).status).toBe(404);
    expect(snap6(s)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /ezcash-sales and friends', () => {
  // Rs 50,000 at the default 80 bp = 40,000 cents (Rs 400); the whole bill total is cash in.
  it('creates the owner example: Rs 50,000 bills, Rs 400 commission, provider Dialog, full amount into the cash book', async () => {
    const s = await setup();
    const r = await ez(s, 5_000_000, { notes: ' bills ', clientRef: 'ezcash-owner-001' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.item).sort()).toEqual(EZ_KEYS);
    expect(r.body.item).toMatchObject({
      providerId: s.P.Dialog, providerName: 'Dialog', billTotalCents: 5_000_000, commissionBp: 80, commissionCents: 40_000,
      notes: 'bills', status: 'posted', backdated: false,
    });
    const cash = cashOf(s, 'ezcash_sales', r.body.item.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'telecom', type: 'ezcash_collection', amount_cents: 5_000_000 });
    expect(telecomCash(s)).toBe(5_000_000);
    expect(lastAudit(s, 'ezcash_sale', 'create')).toMatchObject({ business_date: today(), backdated: 0 });
  });

  it('uses the EZCash rate from Settings, never the Dialog reload rate; changing it affects only later entries', async () => {
    const s = await setup();
    await putProvider(s, s.P.Dialog!, { commissionBp: 900, active: true }); // reload rate only
    const a = await ez(s, 1_000_000); // 80 bp -> 8,000
    expect(a.body.item).toMatchObject({ commissionBp: 80, commissionCents: 8_000 });
    await put(s.app, '/settings', { rates: { reloadCommissionBp: 600, ezcashCommissionBp: 125 } });
    const b = await ez(s, 1_000_000); // 125 bp -> 12,500
    expect(b.body.item).toMatchObject({ commissionBp: 125, commissionCents: 12_500 });
    expect((await get(s.app, `/ezcash-sales/${a.body.item.id}`)).body.item.commissionCents).toBe(8_000);
  });

  it('is not blocked when the Dialog RELOAD provider is switched off (EZCash is a separate wallet service)', async () => {
    const s = await setup();
    await putProvider(s, s.P.Dialog!, { commissionBp: null, active: false });
    expect((await ez(s, 100_000)).status).toBe(201);
  });

  it('idempotent by clientRef (201 then 200 with the original, no new rows)', async () => {
    const s = await setup();
    const clientRef = 'ezcash-dup-0001';
    const a = await ez(s, 100_000, { clientRef });
    const before = snap6(s);
    const b = await ez(s, 100_000, { clientRef });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item).toEqual(a.body.item);
    expect(snap6(s)).toEqual(before);
  });

  it('validation and R-FD', async () => {
    const s = await setup();
    const before = snap6(s);
    for (const over of [
      { billTotalCents: 0 }, { billTotalCents: -1 }, { billTotalCents: 1.5 }, { billTotalCents: '5' }, { billTotalCents: 1_000_000_000_001 },
      { clientRef: 'short' }, { businessDate: '2026-02-30' }, { notes: 'x'.repeat(501) }, { providerId: 1 }, { surprise: 1 },
    ]) {
      const r = await ez(s, 100_000, over);
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    const f = await ez(s, 100_000, { businessDate: daysAhead(1) });
    expect(f.status).toBe(400);
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect(snap6(s)).toEqual(before);
  });

  it('list + totals (posted only), filters, get by id, void with reversal and 409 on a second void', async () => {
    const s = await setup();
    const a = await ez(s, 1_000_000, { businessDate: daysAgo(1) }); // 8,000
    const b = await ez(s, 2_000_000);                                // 16,000
    const c = await ez(s, 3_000_000);                                // 24,000
    await ezVoid(s, b.body.item.id);
    const l = await get(s.app, '/ezcash-sales');
    expect(l.body.items.map((i: any) => i.id)).toEqual([c.body.item.id, b.body.item.id, a.body.item.id]);
    expect(l.body.total).toBe(3);
    expect(l.body.totals).toEqual({ billTotalCents: 4_000_000, commissionCents: 32_000 });
    expect((await get(s.app, '/ezcash-sales?status=void')).body.items).toHaveLength(1);
    expect((await get(s.app, `/ezcash-sales?from=${today()}`)).body.total).toBe(2);
    expect((await get(s.app, `/ezcash-sales/${a.body.item.id}`)).body.item).toEqual(a.body.item);
    expect((await get(s.app, '/ezcash-sales/9999')).status).toBe(404);
    const cash = cashOf(s, 'ezcash_sales', b.body.item.id);
    expect(cash.map((x) => x.amount_cents)).toEqual([2_000_000, -2_000_000]);
    expect(cash[1]).toMatchObject({ reverses_entry_id: cash[0]!.id, type: 'ezcash_collection' });
    expect((await ezVoid(s, b.body.item.id)).status).toBe(409);
    expect(err(await ezVoid(s, b.body.item.id)).code).toBe('ALREADY_VOID');
    expect(telecomCash(s)).toBe(4_000_000);
    expect(lastAudit(s, 'ezcash_sale', 'void')).toMatchObject({ entity_id: String(b.body.item.id) });
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /telecom/topups and friends', () => {
  it('provider top-up: names the provider, cash OUT (negative), type provider_topup, no commission or revenue', async () => {
    const s = await setup();
    const r = await topProvider(s, s.P.Dialog!, 3_000_000, { notes: ' float ', clientRef: 'topup-prov-0001' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.item).sort()).toEqual(TOPUP_KEYS);
    expect(r.body.item).toMatchObject({
      kind: 'provider_topup', providerId: s.P.Dialog, providerName: 'Dialog', amountCents: 3_000_000, notes: 'float', status: 'posted',
    });
    const cash = cashOf(s, 'telecom_topups', r.body.item.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'telecom', type: 'provider_topup', amount_cents: -3_000_000 });
    expect(telecomCash(s)).toBe(-3_000_000);
    expect(lastAudit(s, 'telecom_topup', 'create')).toMatchObject({ business_date: today(), backdated: 0 });
  });

  it('wallet top-up: no provider, cash out with type wallet_topup', async () => {
    const s = await setup();
    const r = await topWallet(s, 1_500_000);
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ kind: 'wallet_topup', providerId: null, providerName: null, amountCents: 1_500_000 });
    expect(cashOf(s, 'telecom_topups', r.body.item.id)[0]).toMatchObject({ type: 'wallet_topup', amount_cents: -1_500_000, book: 'telecom' });
  });

  it('kind rules: provider_topup needs a provider, wallet_topup forbids one, an unknown provider is a field error', async () => {
    const s = await setup();
    const before = snap6(s);
    const noProv = await post(s.app, '/telecom/topups', { businessDate: today(), kind: 'provider_topup', amountCents: 100, clientRef: ref() });
    expect(noProv.status).toBe(400);
    expect(err(noProv)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(err(noProv).fields.providerId).toBeTruthy();
    const walletWithProv = await topWallet(s, 100_000, { providerId: s.P.Dialog });
    expect(walletWithProv.status).toBe(400);
    expect(err(walletWithProv).fields.providerId).toBeTruthy();
    const unknown = await topProvider(s, 99999, 100_000);
    expect(unknown.status).toBe(400);
    expect(err(unknown).fields.providerId).toBe('Provider not found.');
    const badKind = await post(s.app, '/telecom/topups', { businessDate: today(), kind: 'other', amountCents: 100, clientRef: ref() });
    expect(badKind.status).toBe(400);
    expect(snap6(s)).toEqual(before);
  });

  it('an inactive provider is 409 PROVIDER_INACTIVE for a provider top-up, but a wallet top-up is unaffected', async () => {
    const s = await setup();
    await putProvider(s, s.P.Airtel!, { commissionBp: null, active: false });
    const before = snap6(s);
    const r = await topProvider(s, s.P.Airtel!, 100_000);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('PROVIDER_INACTIVE');
    expect(snap6(s)).toEqual(before);
    expect((await topWallet(s, 100_000)).status).toBe(201);
  });

  it('validation, R-FD and idempotency', async () => {
    const s = await setup();
    const before = snap6(s);
    for (const over of [
      { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: '5' }, { amountCents: 1_000_000_000_001 },
      { clientRef: 'short' }, { businessDate: 'nope' }, { notes: 'x'.repeat(501) }, { surprise: 1 },
    ]) {
      const r = await topWallet(s, 100_000, over);
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    const f = await topWallet(s, 100_000, { businessDate: daysAhead(2) });
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect(snap6(s)).toEqual(before);
    const a = await topWallet(s, 100_000, { clientRef: 'topup-dup-00001' });
    const mid = snap6(s);
    const b = await topWallet(s, 100_000, { clientRef: 'topup-dup-00001' });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item).toEqual(a.body.item);
    expect(snap6(s)).toEqual(mid);
  });

  it('list with totals by kind (posted only), filters, get by id and void with reversal', async () => {
    const s = await setup();
    const p1 = await topProvider(s, s.P.Dialog!, 1_000_000, { businessDate: daysAgo(2) });
    const p2 = await topProvider(s, s.P.Mobitel!, 500_000);
    const w1 = await topWallet(s, 200_000);
    const w2 = await topWallet(s, 300_000);
    await topVoid(s, w2.body.item.id);
    const l = await get(s.app, '/telecom/topups');
    expect(l.body.items.map((i: any) => i.id)).toEqual([w2.body.item.id, w1.body.item.id, p2.body.item.id, p1.body.item.id]);
    expect(l.body.total).toBe(4);
    expect(l.body.totals).toEqual({ providerTopupCents: 1_500_000, walletTopupCents: 200_000, totalCents: 1_700_000 });
    expect((await get(s.app, '/telecom/topups?kind=wallet_topup')).body.total).toBe(2);
    expect((await get(s.app, `/telecom/topups?providerId=${s.P.Mobitel}`)).body.items.map((i: any) => i.id)).toEqual([p2.body.item.id]);
    expect((await get(s.app, '/telecom/topups?status=void')).body.items).toHaveLength(1);
    expect((await get(s.app, `/telecom/topups?to=${daysAgo(1)}`)).body.items.map((i: any) => i.id)).toEqual([p1.body.item.id]);
    expect((await get(s.app, '/telecom/topups?kind=nope')).status).toBe(400);
    expect((await get(s.app, `/telecom/topups/${p1.body.item.id}`)).body.item).toEqual(p1.body.item);
    expect((await get(s.app, '/telecom/topups/9999')).status).toBe(404);
    const cash = cashOf(s, 'telecom_topups', w2.body.item.id);
    expect(cash.map((c) => c.amount_cents)).toEqual([-300_000, 300_000]);
    expect(cash[1]).toMatchObject({ reverses_entry_id: cash[0]!.id, type: 'wallet_topup' });
    const again = await topVoid(s, w2.body.item.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(lastAudit(s, 'telecom_topup', 'void')).toMatchObject({ entity_id: String(w2.body.item.id) });
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /telecom/summary', () => {
  it('an empty database returns all four providers with zeros and zero totals', async () => {
    const s = await setup();
    const r = await get(s.app, '/telecom/summary');
    expect(r.status).toBe(200);
    expect(r.body.from).toBeNull();
    expect(r.body.to).toBeNull();
    expect(r.body.providers.map((p: any) => p.name)).toEqual(['Dialog', 'Mobitel', 'Hutch', 'Airtel']);
    for (const p of r.body.providers) {
      expect(Object.keys(p).sort()).toEqual(['commissionRevenueCents', 'ezcashBillCents', 'ezcashCommissionCents', 'name', 'providerId',
        'reloadCommissionCents', 'reloadSalesCents', 'topupsCents']);
    }
    expect(Object.values(r.body.totals).every((v) => v === 0)).toBe(true);
  });

  // Hand calculation (cents):
  //  Dialog reload 1,000,000 @600 = 60,000 + extra 500 = 60,500 ; Mobitel 2,000,000 @600 = 120,000 ;
  //  Dialog reload (void, ignored) ; EZCash 5,000,000 @80 = 40,000 ; EZCash (void, ignored) ;
  //  provider top-up Dialog 700,000 ; Mobitel 100,000 ; wallet 250,000 ; a void wallet top-up 999 (ignored).
  //  Revenue = commission only = 60,500 + 120,000 + 40,000 = 220,500.
  it('adds up posted rows only; revenue is commission only (reload incl. extra + EZCash), not collections or top-ups', async () => {
    const s = await setup();
    await rel(s, s.P.Dialog!, 1_000_000, { extraCents: 500 });
    await rel(s, s.P.Mobitel!, 2_000_000);
    const v = await rel(s, s.P.Dialog!, 9_000_000);
    await relVoid(s, v.body.item.id);
    await ez(s, 5_000_000);
    const ve = await ez(s, 7_000_000);
    await ezVoid(s, ve.body.item.id);
    await topProvider(s, s.P.Dialog!, 700_000);
    await topProvider(s, s.P.Mobitel!, 100_000);
    await topWallet(s, 250_000);
    const vt = await topWallet(s, 999);
    await topVoid(s, vt.body.item.id);

    const r = await get(s.app, '/telecom/summary');
    const byName = Object.fromEntries(r.body.providers.map((p: any) => [p.name, p]));
    expect(byName.Dialog).toMatchObject({
      reloadSalesCents: 1_000_000, reloadCommissionCents: 60_500, ezcashBillCents: 5_000_000, ezcashCommissionCents: 40_000,
      topupsCents: 700_000, commissionRevenueCents: 100_500,
    });
    expect(byName.Mobitel).toMatchObject({
      reloadSalesCents: 2_000_000, reloadCommissionCents: 120_000, ezcashBillCents: 0, ezcashCommissionCents: 0,
      topupsCents: 100_000, commissionRevenueCents: 120_000,
    });
    expect(byName.Hutch.commissionRevenueCents).toBe(0);
    expect(r.body.totals).toEqual({
      reloadSalesCents: 3_000_000, reloadCommissionCents: 180_500, reloadExtraCents: 500, ezcashBillCents: 5_000_000,
      ezcashCommissionCents: 40_000, providerTopupsCents: 800_000, walletTopupsCents: 250_000, topupsCents: 1_050_000,
      commissionRevenueCents: 220_500,
    });
    // Cash book: collections 3,000,000 + 5,000,000 minus top-ups 1,050,000 = 6,950,000 (voids net to zero).
    expect(telecomCash(s)).toBe(6_950_000);
  });

  it('honours the from/to business-date range (inclusive) and validates the dates', async () => {
    const s = await setup();
    await rel(s, s.P.Dialog!, 1_000_000, { businessDate: daysAgo(5) }); // 60,000
    await rel(s, s.P.Dialog!, 2_000_000, { businessDate: daysAgo(2) }); // 120,000
    await rel(s, s.P.Dialog!, 4_000_000, { businessDate: today() });    // 240,000
    const mid = await get(s.app, `/telecom/summary?from=${daysAgo(2)}&to=${daysAgo(2)}`);
    expect(mid.body.totals.reloadCommissionCents).toBe(120_000);
    expect(mid.body).toMatchObject({ from: daysAgo(2), to: daysAgo(2) });
    const tail = await get(s.app, `/telecom/summary?from=${daysAgo(2)}`);
    expect(tail.body.totals.reloadCommissionCents).toBe(360_000);
    const head = await get(s.app, `/telecom/summary?to=${daysAgo(2)}`);
    expect(head.body.totals.reloadCommissionCents).toBe(180_000);
    // A date after today is a valid QUERY (R-FD covers transactions only) and simply shows everything.
    expect((await get(s.app, `/telecom/summary?to=${daysAhead(10)}`)).body.totals.reloadCommissionCents).toBe(420_000);
    for (const q of ['?from=2026-02-30', '?to=abc', '?foo=1']) expect((await get(s.app, `/telecom/summary${q}`)).status, q).toBe(400);
  });
});

describe('no side effects outside the telecom tables', () => {
  it('a telecom write never touches stock, sales or other books', async () => {
    const s = await setup();
    await rel(s, s.P.Dialog!, 100_000);
    await ez(s, 100_000);
    await topWallet(s, 50_000);
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(0);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE book <> 'telecom'")).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(3);
  });
});
