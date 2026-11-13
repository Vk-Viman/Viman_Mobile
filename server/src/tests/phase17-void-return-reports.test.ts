// PHASE 17 - reports and dashboard read POSTED returns only (R-VR 8): the books look as if a voided return had never been recorded.
//
// Method: the SAME scripted shop is built twice in two fresh databases.
//   World A has extra returns that are voided later (a return of two lines incl. a damaged one, and a telecom card return);
//   World B never had them. Every report that reads sales, returns, cost, profit, stock or cash balances must answer EXACTLY the same in
//   both worlds (only the audit trail and the ledger rows themselves - cash book lines, stock movements - differ, by design).
//
// Script (cents, all dates 2025-04, returns dated BEFORE they are voided; voids are dated "now"):
//   A 10 u / 10,000 and B 6 u / 3,000 (shop), card C 20 u / 10,000 (telecom), bought 04-01.
//   04-02 shop sale: A 4 @ 2,500 with cost raised to 1,100 per unit (auto 4,000 + extra 400), B 2 @ 900; telecom sale: C 5 @ 700.
//   04-03 kept return R0: A 1 resalable.
//   World A only: 04-04 R1 = A 2 resalable + B 1 damaged (refund 5,900), 04-05 R2 = C 2 resalable (refund 1,400) ... both voided on "today".

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct, mkTelecom } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { poolOf, reconOk } from './helpers/phase4.ts';
import { cashBal, cl, clc, returnOk, rl, sellOk } from './helpers/phase5.ts';
import { dash } from './helpers/phase12.ts';
import { shopIdentity, telecomNetFromTables } from './helpers/phase14.ts';
import { voidReturnOk } from './helpers/phase17.ts';

const envA = new TestEnv();
const envB = new TestEnv();
afterEach(async () => { await envA.cleanup(); await envB.cleanup(); });

/** Removes volatile keys (timestamps, backup status) so two worlds can be compared. */
function strip(v: any): any {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) { if (!/(At|Timestamp)$/.test(k) && k !== 'backup' && k !== 'generatedAt') o[k] = strip(x); }
    return o;
  }
  return v;
}

async function build(s: ApiBase, withVoided: boolean) {
  const A = await mkProduct(s, { name: 'Prod A', sellPriceCents: 2500, minPriceCents: 0 });
  const B = await mkProduct(s, { name: 'Prod B', sellPriceCents: 900, minPriceCents: 0 });
  const C = await mkTelecom(s, { name: 'Card C', sellPriceCents: 700, minPriceCents: 0 });
  await buy(s, [{ productId: A.id, packs: 1, packSize: 10, lineTotalCents: 10000 }, { productId: B.id, packs: 1, packSize: 6, lineTotalCents: 3000 }], { businessDate: '2025-04-01' });
  await buy(s, [{ productId: C.id, packs: 1, packSize: 20, lineTotalCents: 10000 }], { businessDate: '2025-04-01' });
  const sales = (await sellOk(s, [clc(A.id, 4, 2500, 1100), cl(B.id, 2, 900), cl(C.id, 5, 700)], { businessDate: '2025-04-02' })).sales;
  const shop = sales.find((x: any) => x.book === 'shop');
  const tel = sales.find((x: any) => x.book === 'telecom');
  await returnOk(s, shop.id, [rl(shop.items[0].id, 1, true)], { businessDate: '2025-04-03' });
  if (withVoided) {
    const r1 = (await returnOk(s, shop.id, [rl(shop.items[0].id, 2, true), rl(shop.items[1].id, 1, false)], { businessDate: '2025-04-04' })).item;
    const r2 = (await returnOk(s, tel.id, [rl(tel.items[0].id, 2, true)], { businessDate: '2025-04-05' })).item;
    await voidReturnOk(s, tel.id, r2.id, 'mistake');
    await voidReturnOk(s, shop.id, r1.id, 'mistake');
  }
  return { A, B, C, shop, tel };
}

describe('every report equals the world where the voided return never existed', () => {
  it('P&L (shop, telecom, combined; day and month), sales, profitability, losses, valuation, dashboard, sales totals and cash balances', async () => {
    const a = await apiBase(await envA.build());
    const b = await apiBase(await envB.build());
    const wa = await build(a, true);
    const wb = await build(b, false);
    const urls = [
      '/reports/pnl/shop?from=2025-04-01&to=2025-04-30&granularity=day', '/reports/pnl/shop?from=2025-04-01&to=2025-04-30&granularity=month',
      '/reports/pnl/telecom?from=2025-04-01&to=2025-04-30&granularity=day', '/reports/pnl/telecom?from=2025-04-01&to=2025-04-30&granularity=month',
      '/reports/pnl/combined?from=2025-04-01&to=2025-04-30&granularity=day', '/reports/pnl/combined?from=2025-04-01&to=2025-04-30&granularity=month',
      '/reports/sales?from=2025-04-01&to=2025-04-30&granularity=day', '/reports/sales?from=2025-04-01&to=2025-04-30&granularity=month',
      '/reports/product-profitability?from=2025-04-01&to=2025-04-30',
      '/reports/stock-losses?from=2025-04-01&to=2025-04-30&granularity=day',
      '/reports/inventory/valuation',
    ];
    for (const u of urls) {
      const ra = await get(a.app, u); const rb = await get(b.app, u);
      expect(ra.status, u).toBe(200);
      expect(strip(ra.body), u).toEqual(strip(rb.body));
    }
    // the sales list totals (refunds count posted returns only)
    const la = (await get(a.app, '/sales?from=2025-04-01&to=2025-04-30')).body.totals;
    const lb = (await get(b.app, '/sales?from=2025-04-01&to=2025-04-30')).body.totals;
    expect(la).toEqual(lb);
    // dashboard on the return days and at month end
    for (const d of ['2025-04-04', '2025-04-05', '2025-04-30']) {
      const da = (await dash(a, d)).body; const db = (await dash(b, d)).body;
      expect(strip(da), d).toEqual(strip(db));
    }
    // cash balances and stock pools are identical (refund + reversal cancel; stock left and came back at the same value)
    for (const book of ['shop', 'telecom'] as const) expect(cashBal(a, book)).toBe(cashBal(b, book));
    for (const k of ['A', 'B', 'C'] as const) expect(poolOf(a, (wa as any)[k].id)).toEqual(poolOf(b, (wb as any)[k].id));
    // every posted-only figure from first principles: shop revenue 10,000 + 1,800 - R0 2,500 = 9,300; telecom revenue 3,500
    const shopPnl = (await get(a.app, '/reports/pnl/shop?from=2025-04-01&to=2025-04-30&granularity=month')).body.totals;
    // shop cost: A line 4,000 auto + 400 extra, B 1,000 -> 5,400; R0 reverses 1,000 auto + 100 extra -> 4,300; revenue 11,800 - 2,500 = 9,300; profit 5,000
    expect(shopPnl.goods).toMatchObject({ revenueCents: 9300, costAutomaticCents: 4000, costExtraCents: 300, grossProfitCents: 5000 });
    expect(shopPnl.adjustments).toMatchObject({ damagedReturnLossesCents: 0, salesReturnVoidGainCents: 0, netCents: 0 });
    expect(shopPnl.netProfitCents).toBe(5000);
    expect(await shopIdentity(a)).toEqual({ reportProfit: 5000, ledgerProfit: 5000 });
    expect(await shopIdentity(b)).toEqual({ reportProfit: 5000, ledgerProfit: 5000 });
    // telecom: revenue 3,500, cost 5 x 500 = 2,500 -> profit 1,000 (the voided card return does not appear)
    const telPnl = (await get(a.app, '/reports/pnl/telecom?from=2025-04-01&to=2025-04-30&granularity=month')).body.totals;
    expect(telPnl.cards).toMatchObject({ revenueCents: 3500, costOfSalesCents: 2500, grossProfitCents: 1000 });
    expect(telPnl.netProfitCents).toBe(1000);
    expect(telecomNetFromTables(a.ctx)).toBe(1000);
    await reconOk(a); await reconOk(b);
  });

  // The voided damaged return's loss is still in the stock-loss LIST (history) with status void, but it is not in any total.
  it('the history keeps the voided return, its loss row and the ledger rows; they are simply not counted', async () => {
    const a = await apiBase(await envA.build());
    const w = await build(a, true);
    const sale = (await get(a.app, `/sales/${w.shop.id}`)).body.item;
    expect(sale.returns.map((r: any) => r.status)).toEqual(['posted', 'void']);
    expect(sale.items.map((i: any) => i.returnedQty)).toEqual([1, 0]);
    const losses = (await get(a.app, '/stock-losses?from=2025-04-01&to=2025-04-30')).body;
    expect(losses.items.map((l: any) => [l.status, l.source])).toEqual([['void', 'damaged_return']]);
    expect(losses.totalCostCents).toBe(0);
    // the backdated report lists the return with its real status
    const bd = (await get(a.app, '/reports/backdated?from=2025-04-01&to=2025-04-30&limit=200&offset=0')).body;
    const rets = bd.rows.filter((r: any) => r.recordType === 'sale_return');
    expect(rets.map((r: any) => r.status).sort()).toEqual(['posted', 'void', 'void']);
  });
});
