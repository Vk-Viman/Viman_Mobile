// PHASE 17 - THE WORKED EXAMPLE of rule R-VR (BUSINESS_RULES section 4, item 9) as a PERMANENT regression test.
//
// Every number is worked out by hand below (cents; Rs 1 = 100 cents). Nothing is read back from the code under test.
//
//   Stock:  10 units bought for Rs 7,000 (700,000 c)  -> weighted average exactly Rs 700 (70,000 c) per unit, pool 10 / 700,000.
//   Sale:   4 x Rs 1,500 = Rs 6,000 (600,000 c); the cashier raises the cost to Rs 720 per unit (72,000 c):
//           automatic cost 4 x 700 = Rs 2,800 (280,000 c) + extra cost 4 x 20 = Rs 80 (8,000 c) = cost Rs 2,880 (288,000 c);
//           profit 600,000 - 288,000 = Rs 3,120 (312,000 c). Pool 6 / 420,000.
//   Return of 1 unit (resalable): refund Rs 1,500 (150,000 c); cost reversed 70,000 + 2,000 = 72,000 c; stock back +1 / +70,000
//           (pool 7 / 490,000); profit 450,000 - 216,000 = Rs 2,340 (234,000 c).
//   VOID of that return: cash +Rs 1,500; stock -1 unit / -Rs 700 (pool 6 / 420,000); revenue Rs 6,000; cost Rs 2,880; profit Rs 3,120.
//   Cash book (Shop): opening 2,000,000 - purchase 700,000 = 1,300,000; + sale 600,000 = 1,900,000; - refund 150,000 = 1,750,000;
//                     + reversal 150,000 = 1,900,000 (the balance is back).
// Dates: opening + purchase 2025-05-01, sale 2025-05-02, return 2025-05-03.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, get } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import { mvsByRef, num, poolOf, reconOk, sql } from './helpers/phase4.ts';
import { openNew } from './helpers/phase8.ts';
import { cashBal, cashOfRef, clc, returnOk, rl, sellOk } from './helpers/phase5.ts';
import { shopIdentity } from './helpers/phase14.ts';
import { dash } from './helpers/phase12.ts';
import { returnedQtyMismatches, voidReturnOk } from './helpers/phase17.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

describe('R-VR worked example: sale 4 x Rs 1,500, cost Rs 700 + extra Rs 20, return 1, void the return', () => {
  it('every screen/report figure at each of the three states', async () => {
    const s = await apiBase(await env.build());
    const P = await mkProduct(s, { sellPriceCents: 150000, minPriceCents: 0 });
    expect((await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 2000000 })).status).toBe(201);
    await buy(s, [{ productId: P.id, packs: 1, packSize: 10, lineTotalCents: 700000 }], { businessDate: '2025-05-01' });
    expect(poolOf(s, P.id)).toEqual({ qty: 10, value: 700000 });
    const sale = (await sellOk(s, [clc(P.id, 4, 150000, 72000)], { businessDate: '2025-05-02' })).sales[0];
    const item = sale.items[0];
    expect(item).toMatchObject({ revenueCents: 600000, cogsCents: 280000, extraCostCents: 8000, chargedCostCents: 288000, returnedQty: 0 });
    expect(sale).toMatchObject({ totalCents: 600000, chargedCostCents: 288000, grossProfitCents: 312000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 6, value: 420000 });
    expect(cashBal(s, 'shop')).toBe(1900000);

    // ---- STATE 1: sale only ------------------------------------------------------------------------------------------------
    const listA = (await get(s.app, '/sales?from=2025-05-01&to=2025-05-31')).body.totals;
    expect(listA).toEqual({ revenueCents: 600000, cogsCents: 280000, extraCostCents: 8000, costCents: 288000, refundsCents: 0 });

    // ---- STATE 2: return 1 unit on 05-03 --------------------------------------------------------------------------------------
    const r = (await returnOk(s, sale.id, [rl(item.id, 1, true)], { businessDate: '2025-05-03' })).item;
    expect(r).toMatchObject({ status: 'posted', voidedAt: null, voidReason: null, refundCents: 150000, cogsReversedCents: 70000, extraCostReversedCents: 2000 });
    expect(poolOf(s, P.id)).toEqual({ qty: 7, value: 490000 });
    expect(cashBal(s, 'shop')).toBe(1750000);
    const pnlB = (await get(s.app, '/reports/pnl/shop?from=2025-05-01&to=2025-05-31&granularity=day')).body;
    expect(pnlB.totals.goods).toMatchObject({ salesCents: 600000, returnsCents: 150000, revenueCents: 450000, costAutomaticCents: 210000, costExtraCents: 6000, grossProfitCents: 234000 });
    expect(pnlB.totals.netProfitCents).toBe(234000);
    const listB = (await get(s.app, '/sales?from=2025-05-01&to=2025-05-31')).body.totals;
    expect(listB).toEqual({ revenueCents: 600000, cogsCents: 280000, extraCostCents: 8000, costCents: 288000, refundsCents: 150000 });
    const dashB = (await dash(s, '2025-05-03')).body;
    expect(dashB.today.bySegment.shop).toEqual({ salesCents: -150000, profitCents: -78000 }); // the return day: -1,500 revenue, +720 cost back
    expect(dashB.month.bySegment.shop).toEqual({ salesCents: 450000, profitCents: 234000 });

    // ---- THE VOID ---------------------------------------------------------------------------------------------------------------
    const v = await voidReturnOk(s, sale.id, r.id, 'customer kept the item');
    expect(Object.keys(v).sort()).toEqual(['item', 'sale', 'warnings']);
    expect(v.item).toMatchObject({ id: r.id, status: 'void', voidReason: 'customer kept the item', refundCents: 150000, cogsReversedCents: 70000, extraCostReversedCents: 2000 });
    expect(v.item.voidedAt).toEqual(expect.any(String));
    expect(v.warnings).toEqual([]);

    // stock leaves again: -1 unit / -70,000, pool 6 / 420,000
    expect(poolOf(s, P.id)).toEqual({ qty: 6, value: 420000 });
    expect(mvsByRef(s, 'sales_returns', r.id).map((m) => [m.type, m.qty, m.value, m.date])).toEqual([
      ['sale_return', 1, 70000, '2025-05-03'], ['sale_return', -1, -70000, '2025-05-03'],
    ]);
    // cash: original refund -150,000 kept, reversal +150,000 on the return's own date, linked to the original row; balance back to 1,900,000
    const cash = cashOfRef(s, 'sales_returns', r.id);
    expect(cash.map((c) => [c.type, c.amount_cents, c.business_date])).toEqual([['sale_refund', -150000, '2025-05-03'], ['sale_refund', 150000, '2025-05-03']]);
    expect(cash[1]!.reverses_entry_id).toBe(cash[0]!.id);
    expect(cashBal(s, 'shop')).toBe(1900000);

    // sale detail: the return is listed with its status, the line counter is back to 0, the sale itself is unchanged
    const detail = (await get(s.app, `/sales/${sale.id}`)).body.item;
    expect(detail.returns).toHaveLength(1);
    expect(detail.returns[0]).toMatchObject({ id: r.id, status: 'void', voidReason: 'customer kept the item' });
    expect(detail.items[0].returnedQty).toBe(0);
    expect(v.sale.items[0].returnedQty).toBe(0);
    expect(detail).toMatchObject({ totalCents: 600000, chargedCostCents: 288000, grossProfitCents: 312000, status: 'posted' });
    expect(num(s, 'SELECT returned_qty FROM sale_items WHERE id = ?', item.id)).toBe(0);
    expect(returnedQtyMismatches(s.ctx)).toBe(0);

    // sales list totals: the refund no longer counts
    expect((await get(s.app, '/sales?from=2025-05-01&to=2025-05-31')).body.totals).toEqual(listA);

    // Shop P&L: month and day rows; revenue 6,000, cost 2,880 (2,800 + 80), profit 3,120; no adjustment, no void gain (stock came out at the full 700)
    const pnlC = (await get(s.app, '/reports/pnl/shop?from=2025-05-01&to=2025-05-31&granularity=day')).body;
    expect(pnlC.totals.goods).toMatchObject({ salesCents: 600000, returnsCents: 0, revenueCents: 600000, costAutomaticCents: 280000, costExtraCents: 8000, costOfSalesCents: 288000, grossProfitCents: 312000 });
    expect(pnlC.totals.adjustments).toMatchObject({ netCents: 0, salesReturnVoidGainCents: 0, residualSweepsCents: 0 });
    expect(pnlC.totals.netProfitCents).toBe(312000);
    const day = (label: string) => pnlC.rows.find((x: any) => x.period.label === label);
    expect(day('2025-05-02').netProfitCents).toBe(312000);
    expect(day('2025-05-03').netProfitCents).toBe(0); // as if the return had never been recorded
    expect(day('2025-05-03').goods.returnsCents).toBe(0);
    const pnlMonth = (await get(s.app, '/reports/pnl/shop?from=2025-05-01&to=2025-05-31&granularity=month')).body;
    expect(pnlMonth.rows[0].netProfitCents).toBe(312000);
    expect(pnlMonth.totals.goods.revenueCents).toBe(600000);

    // dashboard (as of the return day and as of the sale day)
    const dashC = (await dash(s, '2025-05-03')).body;
    expect(dashC.today.bySegment.shop).toEqual({ salesCents: 0, profitCents: 0 });
    expect(dashC.month.bySegment.shop).toEqual({ salesCents: 600000, profitCents: 312000 });
    expect(dashC.month.profitCents).toBe(312000);

    // cash book report: both rows are in the ledger; the book is back where it was
    const led = (await get(s.app, '/cashbooks/shop?from=2025-05-03&to=2025-05-03')).body;
    expect(JSON.stringify(led)).toContain('150000');
    expect(cashBal(s, 'shop')).toBe(1900000);

    // profit identity: report profit == cash + stock based profit, exactly
    const id = await shopIdentity(s);
    expect(id.reportProfit).toBe(312000);
    expect(id.ledgerProfit).toBe(312000);
    await reconOk(s);

    // audit: the create row is kept, the void row records both dates (backdated: 05-03 is before today)
    const audit = auditRows(s.ctx, 'sale_return');
    expect(audit.map((a) => a.action)).toEqual(['create', 'void']);
    expect(audit[1]).toMatchObject({ entityId: String(r.id) });
    expect(audit[1]!.before).toMatchObject({ status: 'posted' });
    expect(audit[1]!.after).toMatchObject({ status: 'void', voidReason: 'customer kept the item' });
    expect(sql(s, "SELECT note FROM audit_logs WHERE entity = 'sale_return' AND action = 'void'")).toEqual([{ note: 'customer kept the item' }]);
    expect(sql(s, "SELECT action, business_date, backdated FROM audit_logs WHERE entity = 'sale_return' ORDER BY id"))
      .toEqual([{ action: 'create', business_date: '2025-05-03', backdated: 1 }, { action: 'void', business_date: '2025-05-03', backdated: 1 }]);
  });
});
