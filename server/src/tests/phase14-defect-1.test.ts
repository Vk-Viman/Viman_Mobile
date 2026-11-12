// PHASE 14 DEFECT 1 - EXPECTED RED until the orchestrator fixes it.
//
// Rule: BUSINESS_RULES section 3 (R4) "Purchase return / void: remove min(purchase-cost value, pool value); ... residual -> Stock adjustments line" and
// API_CONTRACTS Phase 3: "The difference refundCents - sum(value removed from stock) is not stored: it is derivable ... and is reported as a *Stock
// adjustment* in the P&L (BUSINESS_RULES R2/R4)." Also the basic accounting identity (BUSINESS_RULES 0/1): the P&L must reconcile with the books.
//
// Defect: when the weighted-average value of the pool is LOWER than the purchase cost of the units sent back (the average fell after a cheaper purchase),
// the supplier refunds the full purchase value in cash but only the (smaller) pool value leaves stock. The difference is a real gain, but NO P&L line
// contains it: Stock adjustments stay 0 and the Shop net profit is understated by exactly that difference. Cash + stock say one thing, the report another.
// The same happens when such a purchase is VOIDED (cash reversal = whole purchase total, stock removed = min(total, pool value)).
//
// Reproduction A (return): buy 10 @ Rs 1,000.00; buy 10 @ Rs 100.00; sell 15 @ Rs 100.00 (stock value 1,100.00 x 15/20 -> COGS 825.00, pool 5 / 275.00);
//   return 5 units of the first purchase: refund Rs 500.00 cash, stock removed Rs 275.00.
//   Cash = -1,000 - 100 + 1,500 + 500 = +900.00; stock 0 -> the shop has made Rs 900.00. Report says Rs 675.00 (revenue 1,500 - COGS 825); gain 225.00 is missing.
// Reproduction B (void): buy 10 @ 1,000.00; buy 10 @ 100.00; sell 8 @ 100.00 (COGS 440.00, pool 12 / 660.00); VOID the first purchase: cash +1,000.00, stock removed 660.00.
//   Cash = -1,000 - 100 + 800 + 1,000 = +700.00, stock value 0 -> profit Rs 700.00. Report says 360.00 (revenue 800 - COGS 440); gain 340.00 is missing.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct, ref } from './helpers/inventory.ts';
import { get, post } from './helpers/catalog.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { shopIdentity } from './helpers/phase14.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const pnl = async (s: Awaited<ReturnType<typeof apiBase>>) => (await get(s.app, '/reports/pnl/shop?from=2025-05-01&to=2025-05-31&granularity=month')).body;

describe('DEFECT 1: a purchase refund above the stock value removed is missing from the Shop P&L', () => {
  it('A: purchase return after the average cost fell - the P&L must equal what cash + stock say (Rs 900.00) and show the gain as a Stock adjustment (-Rs 225.00)', async () => {
    const s = await apiBase(await env.build());
    const Z = (await mkProduct(s, { name: 'Z', sellPriceCents: 10000, minPriceCents: 1 })).id;
    const p1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 100000 }], { businessDate: '2025-05-01' });
    await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: '2025-05-02' });
    await sellOk(s, [cl(Z, 15, 10000)], { businessDate: '2025-05-03' });
    const r = await post(s.app, `/purchases/${p1.id}/returns`, { businessDate: '2025-05-04', items: [{ purchaseItemId: p1.items[0].id, units: 5 }], clientRef: ref() });
    expect(r.status).toBe(201);
    const p = await pnl(s);
    expect(p.totals.adjustments.netCents, 'stock adjustments (net): the refund gain of 22,500 cents is a negative adjustment').toBe(-22500);
    expect(p.totals.netProfitCents, 'net profit must equal cash + stock truth').toBe(90000);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
  });

  it('B: VOID of a purchase after the average cost fell - the P&L must show the gain too (Rs 700.00 profit, adjustments -Rs 340.00)', async () => {
    const s = await apiBase(await env.build());
    const Z = (await mkProduct(s, { name: 'Z', sellPriceCents: 10000, minPriceCents: 1 })).id;
    const p1 = await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 100000 }], { businessDate: '2025-05-01' });
    await buy(s, [{ productId: Z, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: '2025-05-02' });
    await sellOk(s, [cl(Z, 8, 10000)], { businessDate: '2025-05-03' });
    const v = await post(s.app, `/purchases/${p1.id}/void`, { reason: 'wrong bill' });
    expect(v.status).toBe(200);
    const p = await pnl(s);
    expect(p.totals.adjustments.netCents).toBe(-34000);
    expect(p.totals.netProfitCents).toBe(70000);
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(id.ledgerProfit);
  });
});
