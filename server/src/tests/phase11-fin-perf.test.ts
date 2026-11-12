// Phase 11 FINANCIAL reports: performance sanity. A seeded full year (2025) of daily shop, telecom and Ice Cream activity is posted through the
// real API, then every report is read DAY BY DAY for the whole year. The reports use grouped SQL (a constant number of queries for any number
// of day rows) and the pure Ice Cream module once per row, so each answer must arrive within a few seconds; a per-day query loop would take
// far longer. The figures are also compared with a tiny model (sums of what was posted), so speed never hides a wrong answer.

import { describe, it, expect, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import { sellOne } from './helpers/phase5.ts';
import { providerIds, rel } from './helpers/phase6.ts';
import { expNew, rng } from './helpers/phase8.ts';
import { dayOk, payOk } from './helpers/phase10.ts';
import { q, rep } from './helpers/phase11fin.ts';

const env = new TestEnv();
afterAll(async () => { await env.cleanup(); });

/** Each report for the whole year may take at most this long (a machine-independent loose bound; real runs are far below it). */
const LIMIT_MS = 4000;

describe('a seeded year, day by day', () => {
  it('Shop, Telecom, Ice Cream, Combined, cash books, transfers and the funds report each answer 365 day rows within a few seconds, with correct totals', async () => {
    const s = await apiBase(await env.build());
    const rnd = rng(1234);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const prov = await providerIds(s);
    const p = await mkProduct(s, { minPriceCents: 1 });
    await buy(s, [{ productId: p.id, packs: 1, packSize: 4000, lineTotalCents: 4000 * 1000 }], { businessDate: '2025-01-01' }); // unit cost 1,000 exactly

    let shop = 0; let tel = 0; let ice = 0; let sales = 0; let charge = 0; let settle = 0;
    const start = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 365; i++) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      const price = int(500, 3000); const qty = int(1, 2);
      await sellOne(s, p.id, qty, price, { businessDate: d });
      shop += qty * (price - 1000);
      const relSales = int(10000, 200000);
      expect((await rel(s, prov.Dialog!, relSales, { businessDate: d })).status).toBe(201);
      tel += Math.floor((relSales * 600 + 5000) / 10000);
      const S = int(5000, 90000); const C = Math.floor(S * 0.5); const E = Math.floor(S * 0.1);
      await dayOk(s, { businessDate: d, salesCents: S, costAllocCents: C, electricityAllocCents: E });
      ice += S - C - E; sales += S; charge += C + E;
      if (i % 7 === 0) { const amt = int(1000, 40000); await payOk(s, 'materials', amt, { fund: 'cost', businessDate: d }); settle += amt; }
      if (i % 10 === 0) { const amt = int(100, 3000); expect((await expNew(s, { businessDate: d, book: 'shop', category: 'rent', amountCents: amt })).status).toBe(201); shop -= amt; }
    }

    const range = q('2025-01-01', '2025-12-31', 'day');
    const timings: Record<string, number> = {};
    const run = async (name: string, path: string) => {
      const t0 = performance.now();
      const r = await rep(s, path, range);
      timings[name] = Math.round(performance.now() - t0);
      expect(r.status, name).toBe(200);
      expect(r.body.rows, name).toHaveLength(365);
      return r.body;
    };
    const shopR = await run('pnl/shop', 'pnl/shop');
    const telR = await run('pnl/telecom', 'pnl/telecom');
    const iceR = await run('pnl/icecream', 'pnl/icecream');
    const combR = await run('pnl/combined', 'pnl/combined');
    const cashR = await run('cashbook/icecream', 'cashbook/icecream');
    await run('cashbook/shop', 'cashbook/shop');
    await run('transfers', 'transfers');
    const fundsR = await run('icecream-funds', 'icecream-funds');
    console.log('year day-by-day timings (ms):', JSON.stringify(timings));
    for (const [name, ms] of Object.entries(timings)) expect(ms, `${name} took ${ms} ms`).toBeLessThan(LIMIT_MS);

    expect(shopR.totals.netProfitCents).toBe(shop);
    expect(telR.totals.netProfitCents).toBe(tel);
    expect(iceR.totals.recognizedProfitCents).toBe(ice);
    expect(iceR.totals.salesCents).toBe(sales);
    expect(combR.totals.recognizedProfitCents).toBe(shop + tel + ice);
    // unspent = charged - settled (payments of materials only): excess cost is the shortfall, if any (it is not here: allocations are much larger)
    expect(iceR.totals.balancesAsOfPeriodEnd.unspentCents).toBe(charge - settle);
    expect(shopR.rows.reduce((a: number, x: any) => a + x.netProfitCents, 0)).toBe(shop);
    expect(cashR.rows[364].funds.cost.closingCents + cashR.rows[364].funds.electricity.closingCents + cashR.rows[364].funds.profit.closingCents).toBe(cashR.rows[364].closingCents);
    expect(fundsR.rows.every((x: any) => x.reconciled)).toBe(true);
  }, 240000);
});
