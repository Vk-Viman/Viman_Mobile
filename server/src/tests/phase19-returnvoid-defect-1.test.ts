// PHASE 19 - DEFECT 1 (EXPECTED RED): the database does not bound the VALUE-ONLY reversal rows of a void sales return.
//
// Rule: migration 017 header ("reversal rows ... cannot undo more than the return restocked/refunded") and BUSINESS_RULES section 4 R-VR 2/3 ("a repeated request cannot post a second set of reversal rows
// (unique reversal links ...)"; value removed = restored value limited to the pool; at most ONE residual sweep). The audit brief: a raw-SQL attempt to insert a second reversal movement must be refused BY THE DATABASE.
//
// What happens: trg_stock_movements_return_reversal_cap (017) only fires for `qty_delta < 0`, and trg_stock_movements_return_reversal_void only requires the return to be void. So for a VOID return a movement
//   (a) type 'sale_return', qty_delta 0, value_delta < 0   (a "reversal" that removes value only), and
//   (b) a second type 'adjustment' value-only row (a second residual sweep) for a return that already has its sweep
// is ACCEPTED, as many times as wanted, as long as the product still has stock value. Each such row silently moves value out of stock and (because the P&L reads 'sale_return' movements of void returns as the
// void gain and 'adjustment' movements as sweeps) into / out of profit, without any cash or quantity trace, and `assertReturnLedgers` (one reversal per line, at most one sweep) would flag it.
// The service never writes such rows; this is a MISSING DATABASE PROTECTION (Medium: needs direct SQL access or a future code bug).
//
// Reproduction numbers (hand): X buy 10/1,000, sale 6 @300 (cogs 600, pool 4/400), return 4 res (cogs 400, pool 8/800), void -> pool 4/400.
//   (a) INSERT stock_movements(product X, type 'sale_return', qty 0, value -5, ref sales_returns/R) -> must be refused (accepted today: pool becomes 4/395).
//   (b) world H: buy 6/600, sale 3 @250 (cogs 300), return 3 (cogs 300) -> 6/600, buy 3/450 -> 9/1,050, sale 6 (cogs 700) -> 3/350, void the return: sweep 50 + removal 300 -> 0/0.
//       Then buy 1 unit for 100 and INSERT a SECOND adjustment (qty 0, value -5) for the same return -> must be refused (accepted today).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { poolOf } from './helpers/phase4.ts';
import { openNew } from './helpers/phase8.ts';
import { cl, returnOk, rl, sellOk } from './helpers/phase5.ts';
import { voidReturnOk } from './helpers/phase17.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const mk = (s: ApiBase) => mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 });

function attempt(s: ApiBase, sqlText: string): string | null {
  const c = s.ctx.database.conn;
  c.exec('SAVEPOINT d1');
  let msg: string | null = null;
  try { c.exec(sqlText); } catch (e: any) { msg = String(e.message); }
  c.exec('ROLLBACK TO d1'); c.exec('RELEASE d1');
  return msg;
}

describe('DEFECT 1: value-only reversal rows of a void return are not bounded by the database', () => {
  it('(a) a value-only "sale_return" movement (qty 0) for a void return must be refused', async () => {
    const s = await apiBase(await env.build());
    const X = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
    const R = (await returnOk(s, sale.id, [rl(sale.items[0].id, 4, true)], { businessDate: '2025-05-03' })).item;
    await voidReturnOk(s, sale.id, R.id);
    expect(poolOf(s, X.id)).toEqual({ qty: 4, value: 400 });
    const msg = attempt(s, `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id)
      VALUES (${X.id},'2025-05-03','sale_return',0,-5,'sales_returns',${R.id})`);
    expect(msg, 'the database must refuse a second (value-only) reversal movement').not.toBeNull();
  });

  it('(b) a SECOND residual sweep (value-only adjustment) for the same void return must be refused', async () => {
    const s = await apiBase(await env.build());
    const H = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    await buy(s, [{ productId: H.id, packs: 1, packSize: 6, lineTotalCents: 600 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(H.id, 3, 250)], { businessDate: '2025-05-02' })).sales[0];
    const R = (await returnOk(s, sale.id, [rl(sale.items[0].id, 3, true)], { businessDate: '2025-05-03' })).item;
    await buy(s, [{ productId: H.id, packs: 1, packSize: 3, lineTotalCents: 450 }], { businessDate: '2025-05-04' });
    await sellOk(s, [cl(H.id, 6, 250)], { businessDate: '2025-05-05' });
    expect(poolOf(s, H.id)).toEqual({ qty: 3, value: 350 });
    await voidReturnOk(s, sale.id, R.id); // sweep 50 + removal 300
    expect(poolOf(s, H.id)).toEqual({ qty: 0, value: 0 });
    await buy(s, [{ productId: H.id, packs: 1, packSize: 1, lineTotalCents: 100 }], { businessDate: '2025-05-06' });
    const msg = attempt(s, `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id)
      VALUES (${H.id},'2025-05-03','adjustment',0,-5,'sales_returns',${R.id})`);
    expect(msg, 'the database must refuse a second sweep for the same return').not.toBeNull();
  });
});
