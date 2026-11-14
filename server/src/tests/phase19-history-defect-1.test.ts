// Phase 19 HISTORY audit - DEFECT 1 (expected RED, severity MEDIUM, missing protection introduced by migration 017 / PR #13).
// Before PR #13 sales_returns was fully append-only. Since 017 a raw `UPDATE sales_returns SET status='void', ...` is ACCEPTED by the database even though NO
// reversal rows exist: the return is then "void" but its refund (cash_entries) and its restock (stock_movements) are still in the ledgers, so
// cash book balance, stock quantity and the Profit and Loss disagree with the document status. Migration 017's header says "the database itself guarantees
// the parts that must never go wrong"; the ledger part is left entirely to the service. Reaching it needs raw SQL (the API always writes the reversal rows).
// Expected after a fix: the flip is refused unless the reversal rows already exist (or the trigger writes them itself).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, today } from './helpers/inventory.ts';
import { mkProduct } from './helpers/inventory.ts';
import { cl, rl, returnOk, sellOk } from './helpers/phase5.ts';
import { n1, probe } from './helpers/phase19h.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

describe('DEFECT 1: a return can be flipped to void by raw SQL without its reversal rows', () => {
  it('after the flip the cash and stock effects of the return must net to zero, or the flip must be refused', async () => {
    const s = await apiBase(await env.build());
    const p = (await mkProduct(s, { name: 'Defect item', sellPriceCents: 100000, minPriceCents: 100 })).id;
    await buy(s, [{ productId: p, packs: 1, packSize: 10, lineTotalCents: 500000 }], { businessDate: today() });
    const sale = (await sellOk(s, [cl(p, 4, 100000)], { businessDate: today() })).sales[0];
    const ret = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: today() })).item;
    const cashBefore = n1(s.ctx, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE ref_table='sales_returns' AND ref_id = ?", ret.id);
    expect(cashBefore).toBe(-200000); // the refund is in the cash ledger
    const c = s.ctx.database.conn;
    c.exec('SAVEPOINT d1');
    let refused: string | null = null;
    let cashNet = 0, stockQty = 0;
    try {
      try { c.exec(`UPDATE sales_returns SET status = 'void', voided_at = '${today()}T00:00:00.000Z', void_reason = 'raw' WHERE id = ${ret.id}`); } catch (e) { refused = (e as Error).message; }
      cashNet = n1(s.ctx, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE ref_table='sales_returns' AND ref_id = ?", ret.id);
      stockQty = n1(s.ctx, "SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE ref_table='sales_returns' AND ref_id = ?", ret.id);
    } finally { c.exec('ROLLBACK TO d1'); c.exec('RELEASE d1'); }
    void probe;
    if (refused === null) {
      // accepted: then a void return must have no net cash or stock effect left in the ledgers
      expect(cashNet, 'void return still has its refund in the cash ledger').toBe(0);
      expect(stockQty, 'void return still has its restock in the stock ledger').toBe(0);
    }
  });
});
