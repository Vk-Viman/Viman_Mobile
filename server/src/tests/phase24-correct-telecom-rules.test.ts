// PHASE 24 - commission-rate rules of "correct this entry" for reloads and EZCash (owner rule, API_CONTRACTS Phase 2).
// The ORIGINAL rate is kept unless `recalculateCommission: true` (or the reload provider changes). All figures hand-calculated, in cents.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post, put } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { openNew } from './helpers/phase8.ts';
import { sql } from './helpers/phase4.ts';
import { ez, providerIds, putProvider, rel } from './helpers/phase6.ts';
import { allProblems, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const setRates = (s: ApiBase, reloadCommissionBp: number, ezcashCommissionBp: number) =>
  put(s.app, '/settings', { rates: { reloadCommissionBp, ezcashCommissionBp } });

async function world(s: ApiBase): Promise<Record<string, number>> {
  await openNew(s, 'telecom', { businessDate: daysAgo(40), amountCents: 5_000_000 });
  await setRates(s, 600, 80);
  const ids = await providerIds(s);
  await putProvider(s, ids.Dialog!, { commissionBp: 500, active: true }); // Dialog own reload rate 5.00 %
  await putProvider(s, ids.Mobitel!, { commissionBp: 450, active: true }); // Mobitel 4.50 %
  await putProvider(s, ids.Hutch!, { commissionBp: null, active: true }); // Hutch uses the shop default
  await putProvider(s, ids.Airtel!, { commissionBp: 0, active: true }); // Airtel 0 %
  return ids;
}

const correct = (s: ApiBase, res: string, id: number, reason: string, replacement: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  post(s.app, `/${res}/${id}/correct`, { reason, replacement, ...extra });
const row = (s: ApiBase, table: string, id: number) => sql(s, `SELECT * FROM ${table} WHERE id = ?`, id)[0]!;

describe('reload correction: commission rate', () => {
  it('default keeps the OLD rate after the provider rate changed: 234,567 at 500 bp = 11,728 + 30 extra = 11,758', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    // original: 123,457 at 500 bp = 6,172.85 -> 6,173, + 25 extra = 6,198
    const orig = (await rel(s, ids.Dialog!, 123_457, { extraCents: 25, businessDate: daysAgo(10) })).body.item;
    expect([orig.commissionBp, orig.commissionCents]).toEqual([500, 6198]);
    await putProvider(s, ids.Dialog!, { commissionBp: 700, active: true }); // rate changed AFTER the original
    const before = row(s, 'reload_sales', orig.id);

    const r = await correct(s, 'reload-sales', orig.id, 'wrong amount', { providerId: ids.Dialog, salesCents: 234_567, extraCents: 30, clientRef: ref() });
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ commissionBp: 500, commissionCents: 11_758, extraCents: 30, salesCents: 234_567 });
    expect(r.body.comparison).toEqual({
      originalCommissionBp: 500, replacementCommissionBp: 500, originalCommissionCents: 6198, replacementCommissionCents: 11_758, rateRecalculated: false,
    });
    expect(row(s, 'reload_sales', r.body.replacement.id)).toMatchObject({ commission_bp: 500, commission_cents: 11_758, extra_cents: 30 });
    // the original's own snapshot is untouched by the void (only the status columns change)
    const after = row(s, 'reload_sales', orig.id);
    expect([after.commission_bp, after.commission_cents, after.sales_cents, after.extra_cents]).toEqual([500, 6198, 123_457, 25]);
    expect({ ...after, status: before.status, voided_at: before.voided_at, void_reason: before.void_reason }).toEqual(before);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('recalculateCommission: true uses the NEW rate: 234,567 at 700 bp = 16,419.69 -> 16,420 + 30 = 16,450', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const orig = (await rel(s, ids.Dialog!, 123_457, { extraCents: 25, businessDate: daysAgo(10) })).body.item;
    await putProvider(s, ids.Dialog!, { commissionBp: 700, active: true });
    const rep = { providerId: ids.Dialog, salesCents: 234_567, extraCents: 30, clientRef: ref() };
    const fp = fingerprint(s.ctx);
    const p = await post(s.app, `/reload-sales/${orig.id}/correct-preview`, { reason: 'new rate', replacement: rep, recalculateCommission: true });
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(p.body.replacement).toMatchObject({ commissionBp: 700, commissionCents: 16_450 });
    const r = await correct(s, 'reload-sales', orig.id, 'new rate', rep, { recalculateCommission: true });
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ commissionBp: 700, commissionCents: 16_450 });
    expect(r.body.comparison).toEqual({
      originalCommissionBp: 500, replacementCommissionBp: 700, originalCommissionCents: 6198, replacementCommissionCents: 16_450, rateRecalculated: true,
    });
    expect(p.body.comparison).toEqual(r.body.comparison);
    expect(row(s, 'reload_sales', r.body.replacement.id).commission_bp).toBe(700);
    expect(row(s, 'reload_sales', orig.id)).toMatchObject({ commission_bp: 500, commission_cents: 6198 });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('recalculateCommission: false is the same as omitting it', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const orig = (await rel(s, ids.Dialog!, 100_000, { businessDate: daysAgo(10) })).body.item;
    await putProvider(s, ids.Dialog!, { commissionBp: 700, active: true });
    const r = await correct(s, 'reload-sales', orig.id, 'x', { providerId: ids.Dialog, salesCents: 100_000, clientRef: ref() }, { recalculateCommission: false });
    expect(r.body.replacement).toMatchObject({ commissionBp: 500, commissionCents: 5000 });
    expect(r.body.comparison.rateRecalculated).toBe(false);
  });

  it('a provider that uses the shop default keeps the old default: 100,000 at 600 bp = 6,000; recalculated at 900 bp = 9,000', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const a = (await rel(s, ids.Hutch!, 100_000, { businessDate: daysAgo(10) })).body.item;
    const b = (await rel(s, ids.Hutch!, 100_000, { businessDate: daysAgo(10) })).body.item;
    expect(a.commissionCents).toBe(6000);
    await setRates(s, 900, 80);
    const kept = await correct(s, 'reload-sales', a.id, 'x', { providerId: ids.Hutch, salesCents: 100_000, clientRef: ref() });
    expect(kept.body.replacement).toMatchObject({ commissionBp: 600, commissionCents: 6000 });
    expect(kept.body.comparison.rateRecalculated).toBe(false);
    const fresh = await correct(s, 'reload-sales', b.id, 'x', { providerId: ids.Hutch, salesCents: 100_000, clientRef: ref() }, { recalculateCommission: true });
    expect(fresh.body.replacement).toMatchObject({ commissionBp: 900, commissionCents: 9000 });
    expect(fresh.body.comparison).toMatchObject({ originalCommissionBp: 600, replacementCommissionBp: 900, rateRecalculated: true });
    // an ordinary NEW reload entry (not a correction) still takes today's rate
    expect((await rel(s, ids.Hutch!, 100_000)).body.item).toMatchObject({ commissionBp: 900, commissionCents: 9000 });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('changing the provider uses the NEW provider\'s current rate and sets rateRecalculated: Mobitel 450 bp, 234,567 -> 10,555.515 -> 10,556 + 30 = 10,586', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const orig = (await rel(s, ids.Dialog!, 123_457, { extraCents: 25, businessDate: daysAgo(10) })).body.item;
    const r = await correct(s, 'reload-sales', orig.id, 'wrong provider', { providerId: ids.Mobitel, salesCents: 234_567, extraCents: 30, clientRef: ref() });
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ providerName: 'Mobitel', commissionBp: 450, commissionCents: 10_586 });
    expect(r.body.comparison).toEqual({
      originalCommissionBp: 500, replacementCommissionBp: 450, originalCommissionCents: 6198, replacementCommissionCents: 10_586, rateRecalculated: true,
    });
    expect(row(s, 'reload_sales', r.body.replacement.id)).toMatchObject({ commission_bp: 450, commission_cents: 10_586 });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a 0 bp original rate is preserved (0 is not "missing"): commission is only the extra', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const orig = (await rel(s, ids.Airtel!, 100_000, { extraCents: 10, businessDate: daysAgo(10) })).body.item;
    expect([orig.commissionBp, orig.commissionCents]).toEqual([0, 10]);
    await putProvider(s, ids.Airtel!, { commissionBp: 300, active: true });
    const kept = await correct(s, 'reload-sales', orig.id, 'x', { providerId: ids.Airtel, salesCents: 200_000, extraCents: 40, clientRef: ref() });
    expect(kept.body.replacement).toMatchObject({ commissionBp: 0, commissionCents: 40 });
    const fresh = await correct(s, 'reload-sales', kept.body.replacement.id, 'y', { providerId: ids.Airtel, salesCents: 200_000, extraCents: 40, clientRef: ref() }, { recalculateCommission: true });
    expect(fresh.body.replacement).toMatchObject({ commissionBp: 300, commissionCents: 6040 }); // 200,000 x 3 % = 6,000 + 40
  });

  it('the rounding extra belongs to the replacement body: it is kept when sent and is 0 when left out', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const orig = (await rel(s, ids.Dialog!, 123_457, { extraCents: 25, businessDate: daysAgo(10) })).body.item;
    const noExtra = await correct(s, 'reload-sales', orig.id, 'x', { providerId: ids.Dialog, salesCents: 123_457, clientRef: ref() });
    expect(noExtra.body.replacement).toMatchObject({ extraCents: 0, commissionCents: 6173, commissionBp: 500 });
    const withExtra = await correct(s, 'reload-sales', noExtra.body.replacement.id, 'y', { providerId: ids.Dialog, salesCents: 123_457, extraCents: 27, clientRef: ref() });
    expect(withExtra.body.replacement).toMatchObject({ extraCents: 27, commissionCents: 6200 });
    // a negative or oversized extra is refused by the existing create schema, atomically
    const fp = fingerprint(s.ctx);
    expect((await correct(s, 'reload-sales', withExtra.body.replacement.id, 'z', { providerId: ids.Dialog, salesCents: 1000, extraCents: -1, clientRef: ref() })).status).toBe(400);
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('a provider switched off after the original refuses the correction for that provider, atomically', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    const orig = (await rel(s, ids.Dialog!, 100_000, { businessDate: daysAgo(10) })).body.item;
    await putProvider(s, ids.Dialog!, { commissionBp: 500, active: false });
    const fp = fingerprint(s.ctx);
    const r = await correct(s, 'reload-sales', orig.id, 'x', { providerId: ids.Dialog, salesCents: 100_000, clientRef: ref() });
    expect([r.status, r.body.error.code]).toEqual([409, 'PROVIDER_INACTIVE']);
    expect(fingerprint(s.ctx)).toBe(fp);
    // the same refusal when recalculation is requested
    const r2 = await correct(s, 'reload-sales', orig.id, 'x', { providerId: ids.Dialog, salesCents: 100_000, clientRef: ref() }, { recalculateCommission: true });
    expect(r2.body.error.code).toBe('PROVIDER_INACTIVE');
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('the public create endpoint is unchanged: a plain reload still snapshots the provider rate, and a correction replay does not change history', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    expect((await rel(s, ids.Mobitel!, 100_000)).body.item).toMatchObject({ commissionBp: 450, commissionCents: 4500 });
    const withHidden = await post(s.app, '/reload-sales', { businessDate: daysAgo(1), providerId: ids.Mobitel, salesCents: 1000, clientRef: ref(), commissionBp: 1 });
    expect(withHidden.status).toBe(400); // the rate is not a public field
    const list = (await get(s.app, '/reload-sales')).body;
    expect(list.items.every((x: any) => x.commissionBp === 450)).toBe(true);
  });
});

describe('EZCash correction: commission rate', () => {
  it('default keeps the OLD shop rate: 2,000,001 at 80 bp = 16,000.008 -> 16,000; recalculated at 120 bp = 24,000.012 -> 24,000', async () => {
    const s = await apiBase(await env.build());
    const ids = await world(s);
    // original: 1,234,567 at 80 bp = 9,876.536 -> 9,877
    const a = (await ez(s, 1_234_567, { businessDate: daysAgo(10) })).body.item;
    const b = (await ez(s, 1_234_567, { businessDate: daysAgo(10) })).body.item;
    expect([a.commissionBp, a.commissionCents, a.providerName]).toEqual([80, 9877, 'Dialog']);
    await setRates(s, 600, 120); // shop EZCash rate changed AFTER the originals
    await putProvider(s, ids.Dialog!, { commissionBp: 900, active: true }); // the provider's RELOAD rate never applies to EZCash

    const kept = await correct(s, 'ezcash-sales', a.id, 'wrong bill', { billTotalCents: 2_000_001, clientRef: ref() });
    expect(kept.status).toBe(201);
    expect(kept.body.replacement).toMatchObject({ commissionBp: 80, commissionCents: 16_000, providerName: 'Dialog', billTotalCents: 2_000_001 });
    expect(kept.body.comparison).toEqual({
      originalCommissionBp: 80, replacementCommissionBp: 80, originalCommissionCents: 9877, replacementCommissionCents: 16_000, rateRecalculated: false,
    });
    expect(row(s, 'ezcash_sales', kept.body.replacement.id)).toMatchObject({ commission_bp: 80, commission_cents: 16_000 });

    const fresh = await correct(s, 'ezcash-sales', b.id, 'new rate', { billTotalCents: 2_000_001, clientRef: ref() }, { recalculateCommission: true });
    expect(fresh.body.replacement).toMatchObject({ commissionBp: 120, commissionCents: 24_000, providerName: 'Dialog' });
    expect(fresh.body.comparison).toEqual({
      originalCommissionBp: 80, replacementCommissionBp: 120, originalCommissionCents: 9877, replacementCommissionCents: 24_000, rateRecalculated: true,
    });
    // originals keep their own snapshot
    expect(row(s, 'ezcash_sales', a.id)).toMatchObject({ commission_bp: 80, commission_cents: 9877, bill_total_cents: 1_234_567 });
    expect(row(s, 'ezcash_sales', b.id)).toMatchObject({ commission_bp: 80, commission_cents: 9877 });
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('preview and replay report the same comparison; a replay changes nothing', async () => {
    const s = await apiBase(await env.build());
    await world(s);
    const a = (await ez(s, 1_234_567, { businessDate: daysAgo(10) })).body.item;
    await setRates(s, 600, 120);
    const rep = { billTotalCents: 500_000, clientRef: ref() };
    const fp = fingerprint(s.ctx);
    const p = await post(s.app, `/ezcash-sales/${a.id}/correct-preview`, { reason: 'x', replacement: rep });
    expect(fingerprint(s.ctx)).toBe(fp);
    expect(p.body.comparison).toMatchObject({ replacementCommissionBp: 80, replacementCommissionCents: 4000, rateRecalculated: false }); // 500,000 x 0.8 %
    const first = await correct(s, 'ezcash-sales', a.id, 'x', rep);
    const again = await correct(s, 'ezcash-sales', a.id, 'x', rep);
    expect(again.status).toBe(200);
    expect(again.body.comparison).toEqual(first.body.comparison);
    expect(first.body.comparison).toEqual(p.body.comparison);
  });

  it('a normal new EZCash entry (not a correction) still takes today\'s shop rate', async () => {
    const s = await apiBase(await env.build());
    await world(s);
    await setRates(s, 600, 120);
    expect((await ez(s, 1_000_000)).body.item).toMatchObject({ commissionBp: 120, commissionCents: 12_000 });
  });
});
