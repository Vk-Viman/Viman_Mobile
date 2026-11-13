// PHASE 19 - DEFECT 2 (EXPECTED RED, Low-Medium: missing database protection, reachable only by direct SQL): the database accepts a SECOND refund cash entry and a SECOND restock movement for one sales return.
//
// Rule: BUSINESS_RULES section 4 (R5 returns) and R-VR 2 ("no duplicate cash or stock movements"); the audit brief: per return exactly ONE refund cash entry and at most ONE restock movement per line.
// The service guarantees this (clientRef guard, one write path), but unlike the reversal side (migration 017: unique link + cap) nothing in the DATABASE bounds the ORIGINAL side:
//   (a) INSERT cash_entries(type 'sale_refund', amount < 0, ref sales_returns/R) a second time is accepted (no unique key, the 017 trigger only watches amount > 0);
//   (b) INSERT stock_movements(type 'sale_return', qty > 0, ref sales_returns/R) beyond the restocked quantity is accepted (the 017 cap only watches qty < 0).
// A second refund row would make the cash book pay the customer twice while the P&L (read from sales_returns) shows one refund; a second restock would create stock out of nothing.
//
// Reproduction numbers (hand): X buy 10/1,000, sale 6 @300 (cogs 600 -> 4/400), return 2 res (refund 600, cogs round(600x2/6) = 200 -> pool 6/600).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { poolOf } from './helpers/phase4.ts';
import { openNew } from './helpers/phase8.ts';
import { cl, returnOk, rl, sellOk } from './helpers/phase5.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

function attempt(s: ApiBase, sqlText: string): string | null {
  const c = s.ctx.database.conn;
  c.exec('SAVEPOINT d2');
  let msg: string | null = null;
  try { c.exec(sqlText); } catch (e: any) { msg = String(e.message); }
  c.exec('ROLLBACK TO d2'); c.exec('RELEASE d2');
  return msg;
}

describe('DEFECT 2: duplicate refund / restock rows of one sales return are not refused by the database', () => {
  it('(a) a second refund cash entry for the same return must be refused; (b) a second restock movement beyond the returned quantity must be refused', async () => {
    const s = await apiBase(await env.build());
    const X = await mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 });
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const R = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: '2025-05-03' })).item;
    expect(poolOf(s, X.id)).toEqual({ qty: 6, value: 600 });
    const refund = attempt(s, `INSERT INTO cash_entries (book,business_date,type,amount_cents,ref_table,ref_id)
      VALUES ('shop','2025-05-03','sale_refund',-600,'sales_returns',${R.id})`);
    expect(refund, 'second refund entry for one return must be refused').not.toBeNull();
    const restock = attempt(s, `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id)
      VALUES (${X.id},'2025-05-03','sale_return',2,200,'sales_returns',${R.id})`);
    expect(restock, 'second restock movement for one return must be refused').not.toBeNull();
  });
});
