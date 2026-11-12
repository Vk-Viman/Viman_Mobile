// Phase 12 performance sanity: a seeded full year (2025) of daily shop, telecom and Ice Cream activity is posted through the real API, then the
// dashboard (as of the last day) and the export pack (the whole year) are read. The dashboard calls the Phase 11 report functions, which use
// grouped SQL, so it must answer in about a second or two whatever the history; a per-day query loop would be far slower. The figures are also
// compared with a tiny model (sums of what was posted) so speed never hides a wrong answer.

import { describe, it, expect, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import { sellOne } from './helpers/phase5.ts';
import { providerIds, rel } from './helpers/phase6.ts';
import { expNew, rng } from './helpers/phase8.ts';
import { dayOk, payOk } from './helpers/phase10.ts';
import { dash, pack } from './helpers/phase12.ts';

const env = new TestEnv();
afterAll(async () => { await env.cleanup(); });

/** The dashboard may take at most this long (loose, machine-independent; real runs are a small fraction of it). */
const DASHBOARD_LIMIT_MS = 2000;
const PACK_LIMIT_MS = 6000;

describe('a seeded year', () => {
  it('the dashboard answers within two seconds with figures equal to a simple model; the one-year export pack within a few seconds', async () => {
    const s = await apiBase(await env.build());
    const rnd = rng(4321);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const prov = await providerIds(s);
    const p = await mkProduct(s, { minPriceCents: 1 });
    await buy(s, [{ productId: p.id, packs: 1, packSize: 4000, lineTotalCents: 4000 * 1000 }], { businessDate: '2025-01-01' }); // unit cost exactly 1,000

    // model for December (the dashboard's "month") and for 31 December ("today")
    let monthShop = 0; let monthTel = 0; let monthIce = 0; let monthSales = 0; let todaySales = 0; let todayProfit = 0; let sumDaily30 = 0;
    const start = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 365; i++) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      const price = int(500, 3000); const qty = int(1, 2);
      await sellOne(s, p.id, qty, price, { businessDate: d });
      const shop = qty * (price - 1000);
      const relSales = int(10000, 200000);
      expect((await rel(s, prov.Dialog!, relSales, { businessDate: d })).status).toBe(201);
      const comm = Math.floor((relSales * 600 + 5000) / 10000);
      const S = int(5000, 90000); const C = Math.floor(S * 0.5); const E = Math.floor(S * 0.1);
      await dayOk(s, { businessDate: d, salesCents: S, costAllocCents: C, electricityAllocCents: E });
      const ice = S - C - E;
      let exp = 0;
      if (i % 10 === 0) { exp = int(100, 3000); expect((await expNew(s, { businessDate: d, book: 'shop', category: 'rent', amountCents: exp })).status).toBe(201); }
      if (i % 7 === 0) await payOk(s, 'materials', int(1000, 40000), { fund: 'cost', businessDate: d });
      const sales = qty * price + comm + S;
      const profit = shop - exp + comm + ice;
      if (d >= '2025-12-01') { monthShop += shop - exp; monthTel += comm; monthIce += ice; monthSales += sales; }
      if (d >= '2025-12-02') sumDaily30 += profit; // 2025-12-02 .. 12-31 = the 30 daily rows
      if (d === '2025-12-31') { todaySales = sales; todayProfit = profit; }
    }

    const t0 = performance.now();
    const r = await dash(s, '2025-12-31');
    const dashMs = Math.round(performance.now() - t0);
    expect(r.status).toBe(200);
    const t1 = performance.now();
    const x = await pack(s, 'from=2025-01-01&to=2025-12-31');
    const packMs = Math.round(performance.now() - t1);
    console.log(`seeded year: dashboard ${dashMs} ms, export pack ${packMs} ms`);
    expect(dashMs, `dashboard took ${dashMs} ms`).toBeLessThan(DASHBOARD_LIMIT_MS);
    expect(x.status).toBe(200);
    expect(packMs, `export pack took ${packMs} ms`).toBeLessThan(PACK_LIMIT_MS);

    const d = r.body;
    expect(d.today.salesCents).toBe(todaySales);
    expect(d.today.profitCents).toBe(todayProfit);
    expect(d.month.bySegment.shop.profitCents).toBe(monthShop);
    expect(d.month.bySegment.telecom.profitCents).toBe(monthTel);
    expect(d.month.bySegment.icecream.profitCents).toBe(monthIce);
    expect(d.month.profitCents).toBe(monthShop + monthTel + monthIce);
    expect(d.month.salesCents).toBe(monthSales);
    expect(d.series.daily).toHaveLength(30);
    expect(d.series.monthly).toHaveLength(12);
    expect(d.series.daily.reduce((a: number, row: any) => a + row.profitCents, 0)).toBe(sumDaily30);
    expect(d.series.monthly[11].combinedCents).toBe(monthShop + monthTel + monthIce);
    expect(d.series.monthly.every((row: any) => row.month.startsWith('2025-'))).toBe(true);
    const f = d.icecream.funds;
    expect(f.cost + f.electricity + f.profit).toBe(d.cash.books[2].balanceCents); // the invariant holds after a year too
    expect(d.icecream.fundsMatchBook).toBe(true);
  }, 300000);
});
