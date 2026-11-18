// Telecom segments, package C (reloads, EZCash, provider and wallet top-ups): BUSINESS_RULES 13D.
// Every flow derives its segment (reload / provider top-up = provider + reloads; EZCash / wallet top-up = dialog_reloads), stores it on the record
// AND its cash entry, judges closed days and the backdating rule per segment, reverses in the same segment, warns per segment and keeps every
// commission figure unchanged. Hand-calculated figures only (no re-implementation of the formulas).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { backdateBody, dayClosedBody } from './helpers/phase19cd.ts';
import { cashOf, ez, ezVoid, providerIds, rel, relVoid, topProvider, topVoid, topWallet } from './helpers/phase6.ts';
import { seg } from './helpers/seg.ts';
import { SEGMENTS } from './helpers/segments.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<{ s: ApiBase; P: Record<string, number> }> => { const s = await apiBase(await env.build()); return { s, P: await providerIds(s) }; };

const D2 = daysAgo(2);
const D3 = daysAgo(3);

describe('every flow derives its segment and stores it on the record and its cash entry', () => {
  it('reload = provider + reloads, EZCash = dialog_reloads, provider top-up = provider + reloads, wallet top-up = dialog_reloads', async () => {
    const { s, P } = await setup();
    const cases: Array<[string, string]> = [['Dialog', 'dialog_reloads'], ['Mobitel', 'mobitel_reloads'], ['Airtel', 'airtel_reloads'], ['Hutch', 'hutch_reloads']];
    for (const [name, segment] of cases) {
      const r = await rel(s, P[name]!, 100_000);
      expect(r.status, name).toBe(201);
      expect(r.body.item.segment).toBe(segment);
      expect(cashOf(s, 'reload_sales', r.body.item.id).map((c) => c.segment)).toEqual([segment]);
      const t = await topProvider(s, P[name]!, 10_000);
      expect(t.body.item.segment).toBe(segment);
      expect(cashOf(s, 'telecom_topups', t.body.item.id).map((c) => c.segment)).toEqual([segment]);
    }
    const e = await ez(s, 200_000);
    expect(e.body.item.segment).toBe('dialog_reloads');
    expect(cashOf(s, 'ezcash_sales', e.body.item.id).map((c) => c.segment)).toEqual(['dialog_reloads']);
    const w = await topWallet(s, 5_000);
    expect(w.body.item).toMatchObject({ kind: 'wallet_topup', segment: 'dialog_reloads' });
    expect(cashOf(s, 'telecom_topups', w.body.item.id).map((c) => c.segment)).toEqual(['dialog_reloads']);
    // balances by hand: dialog_reloads = 100,000 - 10,000 + 200,000 - 5,000; the others = 100,000 - 10,000
    const b = seg.balances(s);
    expect(b.dialog_reloads).toBe(285_000);
    expect(b.mobitel_reloads).toBe(90_000);
    expect(b.airtel_reloads).toBe(90_000);
    expect(b.hutch_reloads).toBe(90_000);
    for (const c of SEGMENTS.filter((x) => !x.endsWith('_reloads'))) expect(b[c], c).toBe(0);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
    expect(seg.total(s)).toBe(555_000);
  });

  it('commissions are unchanged by the segments (hand-calculated)', async () => {
    const { s, P } = await setup();
    // Rs 50,000 at 600 bp + Rs 50 extra = 3,050.00 (305,000 cents)
    const r = await rel(s, P.Mobitel!, 5_000_000, { extraCents: 5_000 });
    expect(r.body.item).toMatchObject({ commissionBp: 600, commissionCents: 305_000, segment: 'mobitel_reloads' });
    // Rs 50,000 EZCash at 80 bp = 400.00
    const e = await ez(s, 5_000_000);
    expect(e.body.item).toMatchObject({ commissionBp: 80, commissionCents: 40_000 });
  });

  it('lists accept ?segment= and the summary carries bySegment whose sums equal the totals', async () => {
    const { s, P } = await setup();
    await rel(s, P.Dialog!, 100_000);
    await rel(s, P.Mobitel!, 200_000);
    await ez(s, 300_000);
    await topWallet(s, 1_000);
    await topProvider(s, P.Mobitel!, 2_000);
    expect((await get(s.app, '/reload-sales?segment=mobitel_reloads')).body.items.map((i: any) => i.segment)).toEqual(['mobitel_reloads']);
    expect((await get(s.app, '/reload-sales?segment=hutch_reloads')).body.total).toBe(0);
    expect((await get(s.app, '/ezcash-sales?segment=dialog_reloads')).body.total).toBe(1);
    expect((await get(s.app, '/telecom/topups?segment=dialog_reloads')).body.items).toHaveLength(1);
    expect((await get(s.app, '/telecom/topups?segment=bogus')).status).toBe(400);
    const sum = (await get(s.app, '/telecom/summary')).body;
    expect(sum.bySegment.map((x: any) => x.segment)).toEqual(['dialog_reloads', 'mobitel_reloads', 'airtel_reloads', 'hutch_reloads']);
    const by = Object.fromEntries(sum.bySegment.map((x: any) => [x.segment, x]));
    expect(by.dialog_reloads).toMatchObject({ reloadSalesCents: 100_000, ezcashBillCents: 300_000, walletTopupsCents: 1_000, label: 'Dialog Reloads' });
    expect(by.mobitel_reloads).toMatchObject({ reloadSalesCents: 200_000, providerTopupsCents: 2_000 });
    const add = (k: string): number => sum.bySegment.reduce((a: number, x: any) => a + x[k], 0);
    expect(add('reloadSalesCents')).toBe(sum.totals.reloadSalesCents);
    expect(add('reloadCommissionCents')).toBe(sum.totals.reloadCommissionCents);
    expect(add('ezcashCommissionCents')).toBe(sum.totals.ezcashCommissionCents);
    expect(add('topupsCents')).toBe(sum.totals.topupsCents);
    expect(add('commissionRevenueCents')).toBe(sum.totals.commissionRevenueCents);
  });
});

describe('closed days and backdating are judged per segment', () => {
  it('a day closed for Mobitel Reloads does not block Dialog Reloads (reload, EZCash, wallet top-up) and vice versa', async () => {
    const { s, P } = await setup();
    await seg.seed(s, { dialog_reloads: 100_000, mobitel_reloads: 100_000 }, D3);
    await seg.closeOk(s, 'mobitel_reloads', D2);
    // Dialog Reloads on the same day is open: reload of Dialog, EZCash, wallet top-up
    expect((await rel(s, P.Dialog!, 1_000, { businessDate: D2 })).status).toBe(201);
    expect((await ez(s, 1_000, { businessDate: D2 })).status).toBe(201);
    expect((await topWallet(s, 1_000, { businessDate: D2 })).status).toBe(201);
    // Mobitel Reloads is closed: reload and provider top-up are refused naming the segment
    for (const r of [await rel(s, P.Mobitel!, 1_000, { businessDate: D2 }), await topProvider(s, P.Mobitel!, 1_000, { businessDate: D2 })]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject(dayClosedBody('telecom', D2, 'mobitel_reloads'));
    }
    // now close Dialog Reloads too: EZCash and wallet top-up (Dialog Reloads) are refused, the Mobitel message names Mobitel
    await seg.closeOk(s, 'dialog_reloads', D2);
    for (const r of [await ez(s, 1_000, { businessDate: D2 }), await topWallet(s, 1_000, { businessDate: D2 }), await rel(s, P.Dialog!, 1_000, { businessDate: D2 })]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject(dayClosedBody('telecom', D2, 'dialog_reloads'));
    }
    // a Hutch reload is untouched by both closings
    expect((await rel(s, P.Hutch!, 1_000, { businessDate: D2 })).status).toBe(201);
  });

  it('backdating before the last closed day is refused only in that segment', async () => {
    const { s, P } = await setup();
    await seg.seed(s, { mobitel_reloads: 100_000, dialog_reloads: 100_000 }, D3);
    await seg.closeOk(s, 'mobitel_reloads', D2);
    const refused = await rel(s, P.Mobitel!, 1_000, { businessDate: D3 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject(backdateBody('telecom', D2, D3, 'mobitel_reloads'));
    expect((await rel(s, P.Dialog!, 1_000, { businessDate: D3 })).status).toBe(201);
    expect((await ez(s, 1_000, { businessDate: D3 })).status).toBe(201);
    // after the closed day it is fine in the closed segment too
    expect((await rel(s, P.Mobitel!, 1_000, { businessDate: today() })).status).toBe(201);
  });

  it('a void is judged on the record segment and date: closed Mobitel day blocks the Mobitel void only', async () => {
    const { s, P } = await setup();
    await seg.seed(s, { mobitel_reloads: 100_000, dialog_reloads: 100_000 }, D3);
    const m = (await rel(s, P.Mobitel!, 1_000, { businessDate: D2 })).body.item;
    const d = (await rel(s, P.Dialog!, 1_000, { businessDate: D2 })).body.item;
    await seg.closeOk(s, 'mobitel_reloads', D2);
    const blocked = await relVoid(s, m.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject(dayClosedBody('telecom', D2, 'mobitel_reloads'));
    expect((await relVoid(s, d.id)).status).toBe(200);
  });
});

describe('voids and corrections stay in the segment', () => {
  it('a void appends the reversal in the same segment; the segment balance returns to its start', async () => {
    const { s, P } = await setup();
    const r = (await rel(s, P.Airtel!, 70_000)).body.item;
    const e = (await ez(s, 30_000)).body.item;
    const t = (await topProvider(s, P.Hutch!, 5_000)).body.item;
    const w = (await topWallet(s, 4_000)).body.item;
    expect((await relVoid(s, r.id)).status).toBe(200);
    expect((await ezVoid(s, e.id)).status).toBe(200);
    expect((await topVoid(s, t.id)).status).toBe(200);
    expect((await topVoid(s, w.id)).status).toBe(200);
    for (const [table, id, segment] of [['reload_sales', r.id, 'airtel_reloads'], ['ezcash_sales', e.id, 'dialog_reloads'],
      ['telecom_topups', t.id, 'hutch_reloads'], ['telecom_topups', w.id, 'dialog_reloads']] as const) {
      const rows = cashOf(s, table, id);
      expect(rows.map((c) => c.segment), `${table} ${id}`).toEqual([segment, segment]);
    }
    const b = seg.balances(s);
    for (const c of Object.keys(b)) expect(b[c as keyof typeof b], c).toBe(0);
  });

  it('a correction with the same provider keeps the segment and the old rate; a provider change moves the segment and re-rates', async () => {
    const { s, P } = await setup();
    const original = (await rel(s, P.Mobitel!, 100_000)).body.item; // 600 bp -> 6,000
    const same = await post(s.app, `/reload-sales/${original.id}/correct`, { reason: 'typo', replacement: { providerId: P.Mobitel, salesCents: 200_000, clientRef: ref() } });
    expect(same.status).toBe(201);
    expect(same.body.replacement).toMatchObject({ segment: 'mobitel_reloads', commissionBp: 600, commissionCents: 12_000 });
    expect(same.body.original.segment).toBe('mobitel_reloads');
    const moved = await post(s.app, `/reload-sales/${same.body.replacement.id}/correct`, { reason: 'wrong provider', replacement: { providerId: P.Hutch, salesCents: 200_000, clientRef: ref() } });
    expect(moved.status).toBe(201);
    expect(moved.body.replacement.segment).toBe('hutch_reloads');
    const b = seg.balances(s);
    expect(b.mobitel_reloads).toBe(0);
    expect(b.hutch_reloads).toBe(200_000);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
  });

  it('a provider change in a correction needs BOTH segments open on their dates', async () => {
    const { s, P } = await setup();
    await seg.seed(s, { mobitel_reloads: 100_000, hutch_reloads: 100_000 }, D3);
    const original = (await rel(s, P.Mobitel!, 100_000, { businessDate: D2 })).body.item;
    await seg.closeOk(s, 'hutch_reloads', D2);
    const refused = await post(s.app, `/reload-sales/${original.id}/correct`, { reason: 'move', replacement: { providerId: P.Hutch, salesCents: 100_000, clientRef: ref() } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject(dayClosedBody('telecom', D2, 'hutch_reloads'));
    // atomic: the original is still posted
    expect((await get(s.app, `/reload-sales/${original.id}`)).body.item.status).toBe('posted');
    await seg.closeOk(s, 'mobitel_reloads', D2);
    const refused2 = await post(s.app, `/reload-sales/${original.id}/correct`, { reason: 'same', replacement: { providerId: P.Mobitel, salesCents: 90_000, clientRef: ref() } });
    expect(refused2.status).toBe(409);
    expect(refused2.body.error).toMatchObject(dayClosedBody('telecom', D2, 'mobitel_reloads'));
  });

  it('EZCash and top-up corrections stay in Dialog Reloads / the provider segment', async () => {
    const { s, P } = await setup();
    const e = (await ez(s, 100_000)).body.item;
    const ec = await post(s.app, `/ezcash-sales/${e.id}/correct`, { reason: 'typo', replacement: { billTotalCents: 150_000, clientRef: ref() } });
    expect(ec.body.replacement.segment).toBe('dialog_reloads');
    const t = (await topProvider(s, P.Airtel!, 10_000)).body.item;
    const tc = await post(s.app, `/telecom/topups/${t.id}/correct`, { reason: 'wrong provider', replacement: { kind: 'provider_topup', providerId: P.Hutch, amountCents: 10_000, clientRef: ref() } });
    expect(tc.status).toBe(201);
    expect(tc.body.replacement.segment).toBe('hutch_reloads');
    const b = seg.balances(s);
    expect(b.airtel_reloads).toBe(0);
    expect(b.hutch_reloads).toBe(-10_000);
    expect(b.dialog_reloads).toBe(150_000);
  });
});

describe('negative cash warnings are per segment', () => {
  it('a top-up warns about its own segment only, even when the Telecom total is positive', async () => {
    const { s, P } = await setup();
    await rel(s, P.Dialog!, 500_000); // Dialog Reloads +500,000; Telecom total positive
    const t = await topProvider(s, P.Mobitel!, 10_000); // Mobitel Reloads -10,000
    expect(t.status).toBe(201);
    expect(t.body.warnings).toHaveLength(1);
    expect(t.body.warnings[0]).toMatchObject({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', segment: 'mobitel_reloads', balanceCents: -10_000 });
    expect(t.body.warnings[0].message).toContain('Telecom - Mobitel Reloads');
    const w = await topWallet(s, 1_000); // Dialog Reloads stays positive: no warning
    expect(w.body.warnings).toEqual([]);
    // voiding the Mobitel collection... voiding a positive reload in a segment that goes negative warns for that segment
    const m = (await rel(s, P.Mobitel!, 10_000)).body.item;
    const v = await relVoid(s, m.id);
    expect(v.body.warnings.map((x: any) => x.segment)).toEqual(['mobitel_reloads']);
  });
});

describe('per-segment balance equals the sum of its entries after a mixed scenario', () => {
  it('opening + flows: each segment balance and the Telecom total add up', async () => {
    const { s, P } = await setup();
    await seg.seed(s, { dialog_reloads: 1_000_000, mobitel_reloads: 500_000, dialog_cards: 200_000 }, D3);
    await rel(s, P.Dialog!, 300_000);
    await rel(s, P.Mobitel!, 120_000);
    const e = (await ez(s, 80_000)).body.item;
    await topProvider(s, P.Mobitel!, 50_000);
    await topWallet(s, 20_000);
    await ezVoid(s, e.id);
    const b = seg.balances(s);
    expect(b.dialog_reloads).toBe(1_000_000 + 300_000 - 20_000); // reload + wallet top-up (EZCash voided)
    expect(b.mobitel_reloads).toBe(500_000 + 120_000 - 50_000);
    expect(b.dialog_cards).toBe(200_000);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
    const ledger = (await seg.ledger(s, 'dialog_reloads')).body;
    expect(ledger.items.every((i: any) => i.segment === 'dialog_reloads')).toBe(true);
  });
});
