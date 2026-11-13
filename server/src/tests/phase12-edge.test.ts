// Phase 12 DASHBOARD edge cases: empty database, past and future dates, bad input, low stock, closings (days not yet closed), the backup block,
// negative cash, and the read-only proof. Worlds are small and built through the real API; expected values are written by hand.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { buildFinWorld } from './helpers/phase11fin.ts';
import { get } from './helpers/catalog.ts';
import { closeOk, expNew, openNew, reopenNew } from './helpers/phase8.ts';
import { ZERO_TILE, dash, datesEndingOn, dbSnapshot } from './helpers/phase12.ts';
import { buildDashboard, BACKUP_STALE_HOURS } from '../services/dashboard.service.ts';
import { createBackup } from '../services/backup.service.ts';

/** The external-backup part of the dashboard backup block when no external folder is configured (migration 018). */
const NO_EXTERNAL = { status: 'not_configured', lastSuccessAt: null, daysSinceSuccess: null, warning: expect.any(String) };

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const fresh = async (): Promise<ApiBase> => apiBase(await env.build());

describe('empty database', () => {
  it('returns zeros everywhere, zero-filled series of 30 and 12 rows, no warnings and no errors', async () => {
    const s = await fresh();
    const r = await dash(s, '2025-06-15');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.asOf).toBe('2025-06-15');
    expect(d.today).toEqual(ZERO_TILE);
    expect(d.month).toEqual(ZERO_TILE);
    expect(d.cash).toEqual({
      books: [{ book: 'shop', balanceCents: 0 }, { book: 'telecom', balanceCents: 0 }, { book: 'icecream', balanceCents: 0, fundsMatchBook: true, funds: { cost: 0, electricity: 0, profit: 0 } }],
      totalCents: 0,
    });
    expect(d.stock).toEqual({ valueCents: 0, lowStockCount: 0, lowStock: [], negativeOrWarning: [] });
    expect(d.icecream).toEqual({
      recognizedProfitMonthCents: 0, funds: { cost: 0, electricity: 0, profit: 0 }, fundsTotalCents: 0, fundsMatchBook: true,
      excessCostNotChargedTodayCents: 0, excessCostNotChargedMonthCents: 0, profitAfterExcessCostMonthCents: 0, outstandingExcessCostCents: 0, warnings: [],
    });
    expect(d.closings).toEqual({
      lastClosedByBook: { shop: null, telecom: null, icecream: null },
      // a book with no entry yet has nothing to close, so a brand-new shop does not start with a list of "unclosed" days
      openDaysBehind: [{ book: 'shop', dates: [] }, { book: 'telecom', dates: [] }, { book: 'icecream', dates: [] }],
    });
    expect(d.backup).toEqual({ latestAt: null, ageHours: null, status: 'none', external: NO_EXTERNAL });
    expect(d.series.daily).toEqual(datesEndingOn('2025-06-15', 30).map((date) => ({ date, salesCents: 0, profitCents: 0 })));
    expect(d.series.monthly).toHaveLength(12);
    expect(d.series.monthly[0]).toEqual({ month: '2024-07', shopCents: 0, telecomCents: 0, icecreamCents: 0, combinedCents: 0 });
    expect(d.series.monthly[11].month).toBe('2025-06');
    expect(d.series.topProducts).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it('with no date it uses today (Asia/Colombo) and answers 200', async () => {
    const s = await fresh();
    const r = await dash(s);
    expect(r.status).toBe(200);
    expect(r.body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.series.daily).toHaveLength(30);
    expect(r.body.series.daily[29].date).toBe(r.body.asOf);
  });
});

describe('asOf validation, past and future dates', () => {
  it('rejects an impossible or badly written date with 400; accepts any real date', async () => {
    const s = await fresh();
    for (const bad of ['2025-02-30', '2025-13-01', 'yesterday', '25-01-01', '2025-1-1']) {
      const r = await dash(s, bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get(s.app, '/dashboard?asOf=2025-02-29')).body.error.fields.asOf).toBeTruthy();
    expect((await get(s.app, '/dashboard?foo=1')).status).toBe(400); // unknown query fields are refused like every other endpoint
    expect((await dash(s, '2024-02-29')).status).toBe(200); // a real leap day
  });

  it('past date: shows what was true then (balances as of the date, later records ignored); future date: today\'s balances and empty periods', async () => {
    const s = await fresh();
    await buildFinWorld(s, true);
    const before = (await dash(s, '2025-01-15')).body; // before the first record (03-01)
    expect(before.cash.totalCents).toBe(0);
    expect(before.stock.valueCents).toBe(0);
    expect(before.month).toEqual(ZERO_TILE);
    expect(before.icecream.outstandingExcessCostCents).toBe(0);
    expect(before.icecream.warnings).toEqual([]);
    expect(before.series.monthly.map((r: any) => r.combinedCents)).toEqual(new Array(12).fill(0));
    expect(before.series.topProducts).toEqual([]);

    // 2025-03-01 only: the opening balances (shop 1,000,000; telecom 500,000; Ice Cream Cost fund 500,000) less the stock bought that day
    // (A 300,000 + B 100,000 + C 40,000 + X 100,000 = 540,000 from Shop 440,000 / Telecom 100,000): Shop 560,000; Telecom 400,000; Ice Cream 500,000
    const day1 = (await dash(s, '2025-03-01')).body;
    expect(day1.cash.books.map((b: any) => b.balanceCents)).toEqual([560000, 400000, 500000]);
    expect(day1.cash.books[2].funds).toEqual({ cost: 500000, electricity: 0, profit: 0 });
    expect(day1.cash.totalCents).toBe(1460000);

    const future = (await dash(s, '2030-06-15')).body;
    expect(future.asOf).toBe('2030-06-15');
    expect(future.today).toEqual(ZERO_TILE);
    expect(future.month).toEqual(ZERO_TILE);
    expect(future.cash.books.map((b: any) => b.balanceCents)).toEqual([606000, 5778413, 586500]); // everything saved, as of the 04-30 close
    expect(future.stock.valueCents).toBe(285000);
    expect(future.icecream.outstandingExcessCostCents).toBe(16000); // balances carry forward
    expect(future.icecream.excessCostNotChargedMonthCents).toBe(0); // but no flow happens in an empty June
    expect(future.icecream.profitAfterExcessCostMonthCents).toBe(0);
    expect(future.series.daily).toHaveLength(30);
    expect(future.series.daily.every((r: any) => r.salesCents === 0 && r.profitCents === 0)).toBe(true);
    expect(future.series.monthly.map((r: any) => r.month)).toEqual(['2029-07', '2029-08', '2029-09', '2029-10', '2029-11', '2029-12', '2030-01', '2030-02', '2030-03', '2030-04', '2030-05', '2030-06']);
    expect(future.series.monthly.every((r: any) => r.combinedCents === 0)).toBe(true);
  });
});

describe('low stock', () => {
  /**
   * L1 minimum 5, bought 3 (value 9,000); L2 minimum 5, bought 5 exactly at the minimum (value 5,000) -> at or below counts (low);
   * N minimum 5, bought 6 (6,000) -> fine; Z minimum 0 and never stocked -> "no minimum", never low.
   * Shortfall order (largest first): L1 (5-3 = 2), L2 (0). Stock value = 9,000 + 5,000 + 6,000 = 20,000.
   */
  it('lists products at or below their minimum (equal counts), most urgent first; no minimum = never listed', async () => {
    const s = await fresh();
    const L1 = await mkProduct(s, { name: 'Low one', reorderLevel: 5, minPriceCents: 1 });
    const L2 = await mkProduct(s, { name: 'Low two', reorderLevel: 5, minPriceCents: 1 });
    const N = await mkProduct(s, { name: 'Fine', reorderLevel: 5, minPriceCents: 1 });
    await mkProduct(s, { name: 'No minimum', reorderLevel: 0, minPriceCents: 1 });
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 1000000 });
    await buy(s, [{ productId: L1.id, packs: 1, packSize: 3, lineTotalCents: 9000 }, { productId: L2.id, packs: 1, packSize: 5, lineTotalCents: 5000 },
      { productId: N.id, packs: 1, packSize: 6, lineTotalCents: 6000 }], { businessDate: '2025-05-02' });
    const d = (await dash(s, '2025-05-10')).body;
    expect(d.stock.valueCents).toBe(20000);
    expect(d.stock.lowStockCount).toBe(2);
    expect(d.stock.lowStock).toEqual([
      { productId: L1.id, name: 'Low one', qty: 3, reorderLevel: 5 },
      { productId: L2.id, name: 'Low two', qty: 5, reorderLevel: 5 },
    ]);
    // the list is capped at 10 while the count stays the true count
    for (let i = 0; i < 11; i++) await mkProduct(s, { name: `Empty ${i}`, reorderLevel: 2, minPriceCents: 1 }); // quantity 0, minimum 2: low (out of stock)
    const big = (await dash(s, '2025-05-10')).body;
    expect(big.stock.lowStockCount).toBe(13);
    expect(big.stock.lowStock).toHaveLength(10);
    expect(big.stock.lowStock[0].name).toBe('Empty 0'); // shortfall 2 ties with 'Low one'; ties go alphabetically, so the Empty ones fill the ten places
  });
});

describe('closings: last closed date and days not yet closed (R9, section 8)', () => {
  /**
   * Date 2025-05-10 -> window 05-03..05-09. Shop: first entry 05-01 (opening). Telecom: no entry at all. Ice Cream: first entry 05-04.
   * Closed: Shop 05-05 and 05-06; Ice Cream 05-04. Shop not closed: 05-03, 05-04, 05-07, 05-08, 05-09. Ice Cream not closed: 05-05..05-09.
   * Last closed: Shop 05-06, Telecom none, Ice Cream 05-04. Reopening Shop 05-06 (not closed again) adds it to the open days and the last closed becomes 05-05.
   * A past dashboard date only sees closings on or before it: as of 05-05 Shop's last closed is 05-05 and the window is 04-28..05-04.
   */
  it('lists the open days per book and follows reopening', async () => {
    const s = await fresh();
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await openNew(s, 'icecream', { businessDate: '2025-05-04', amountCents: 50000 });
    await closeOk(s, 'shop', '2025-05-05');
    const shop06 = await closeOk(s, 'shop', '2025-05-06');
    await closeOk(s, 'icecream', '2025-05-04');
    const d = (await dash(s, '2025-05-10')).body;
    expect(d.closings.lastClosedByBook).toEqual({ shop: '2025-05-06', telecom: null, icecream: '2025-05-04' });
    expect(d.closings.openDaysBehind).toEqual([
      { book: 'shop', dates: ['2025-05-03', '2025-05-04', '2025-05-07', '2025-05-08', '2025-05-09'] },
      { book: 'telecom', dates: [] },
      { book: 'icecream', dates: ['2025-05-05', '2025-05-06', '2025-05-07', '2025-05-08', '2025-05-09'] },
    ]);
    const past = (await dash(s, '2025-05-05')).body;
    expect(past.closings.lastClosedByBook.shop).toBe('2025-05-05');
    expect(past.closings.openDaysBehind[0]).toEqual({ book: 'shop', dates: ['2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04'] });

    expect((await reopenNew(s, shop06.id)).status).toBe(200);
    const re = (await dash(s, '2025-05-10')).body;
    expect(re.closings.lastClosedByBook.shop).toBe('2025-05-05');
    expect(re.closings.openDaysBehind[0].dates).toEqual(['2025-05-03', '2025-05-04', '2025-05-06', '2025-05-07', '2025-05-08', '2025-05-09']);
  });

  it('the date itself is never "behind", and a fully closed week is an empty list', async () => {
    const s = await fresh();
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    for (const d of ['2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05', '2025-05-06', '2025-05-07']) await closeOk(s, 'shop', d);
    const r = (await dash(s, '2025-05-08')).body; // window 05-01..05-07 all closed; 05-08 itself is open but not behind
    expect(r.closings.openDaysBehind[0]).toEqual({ book: 'shop', dates: [] });
    expect(r.closings.lastClosedByBook.shop).toBe('2025-05-07');
  });
});

describe('backup block', () => {
  it('none -> ok after a backup; age in hours from the real clock; stale after the limit', async () => {
    const s = await fresh();
    expect((await dash(s)).body.backup).toEqual({ latestAt: null, ageHours: null, status: 'none', external: NO_EXTERNAL });
    const info = createBackup(s.ctx, 'manual');
    const ok = (await dash(s)).body.backup;
    expect(ok.status).toBe('ok');
    expect(ok.latestAt).toBe(info.createdAt);
    expect(ok.ageHours).toBeGreaterThanOrEqual(0);
    expect(ok.ageHours).toBeLessThan(1);
    // fixed clocks through the service: exactly 5 hours, 48 hours (still ok) and 48.1 hours (stale) after the file time
    const at = new Date(info.createdAt).getTime();
    expect(buildDashboard(s.ctx, '2025-05-10', new Date(at + 5 * 3600000)).backup).toEqual({ latestAt: info.createdAt, ageHours: 5, status: 'ok', external: NO_EXTERNAL });
    expect(buildDashboard(s.ctx, '2025-05-10', new Date(at + BACKUP_STALE_HOURS * 3600000)).backup.status).toBe('ok');
    const stale = buildDashboard(s.ctx, '2025-05-10', new Date(at + (BACKUP_STALE_HOURS + 0.1) * 3600000)).backup;
    expect(stale).toEqual({ latestAt: info.createdAt, ageHours: 48.1, status: 'stale', external: NO_EXTERNAL });
  });

  it('the newest of several backups is the one reported', async () => {
    const s = await fresh();
    createBackup(s.ctx, 'startup', new Date('2025-01-01T01:00:00Z'));
    const newer = createBackup(s.ctx, 'manual', new Date('2025-01-02T01:00:00Z'));
    expect((await dash(s)).body.backup.latestAt).toBe(newer.createdAt);
  });
});

describe('warnings', () => {
  it('a book below zero warns (R13) and is still a normal 200 with the negative balance shown', async () => {
    const s = await fresh();
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 10000 });
    await expNew(s, { businessDate: '2025-05-02', book: 'shop', category: 'rent', amountCents: 25000 }); // the write itself only warns
    const d = (await dash(s, '2025-05-10')).body;
    expect(d.cash.books[0].balanceCents).toBe(-15000);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatchObject({ code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -15000 });
    // expense is shop profit -25,000
    expect(d.month.bySegment.shop.profitCents).toBe(-25000);
    expect(d.month.profitCents).toBe(-25000);
  });
});

describe('read-only proof', () => {
  it('reading the dashboard for several dates changes no row of any table (including audit_logs) and writes no audit entry', async () => {
    const s = await fresh();
    await buildFinWorld(s, true);
    const before = dbSnapshot(s.ctx);
    const auditBefore = JSON.parse(before.audit_logs!).length;
    for (const date of ['2025-03-31', '2025-04-30', '2030-01-01', '2020-01-01', undefined]) expect((await dash(s, date)).status).toBe(200);
    expect(buildDashboard(s.ctx, '2025-04-30').asOf).toBe('2025-04-30');
    const after = dbSnapshot(s.ctx);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const t of Object.keys(before)) expect(after[t], `table ${t} changed`).toBe(before[t]);
    expect(JSON.parse(after.audit_logs!)).toHaveLength(auditBefore);
  });
});
