// Helpers for the PHASE 19 independent audit of "void a sales return" (BUSINESS_RULES section 4, rule R-VR, migration 017).
// Only thin request builders, ledger readers and STRUCTURAL checkers live here. Every expected MONEY figure lives in the tests, worked out by hand
// (never derived from report code). The randomized test has its own independent model (phase19-returnvoid-random.test.ts).

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { get } from './catalog.ts';
import type { ApiBase } from './inventory.ts';
import { ledgerOf, num, poolOf, reconOk, sql } from './phase4.ts';
import { rows, n1 } from './phase14.ts';

export { rows, n1 };

/** GET a period P&L (`seg` = shop | telecom | combined) and return the body. */
export async function pnl(s: { app: FastifyInstance }, seg: 'shop' | 'telecom' | 'combined', from: string, to: string, gran: 'day' | 'month' = 'month'): Promise<any> {
  const r = await get(s.app, `/reports/pnl/${seg}?from=${from}&to=${to}&granularity=${gran}`);
  if (r.status !== 200) throw new Error(`pnl ${seg} failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The row of a day-granularity report whose label is `day`. */
export const dayRow = (body: any, day: string): any => {
  const r = body.rows.find((x: any) => x.period.label === day);
  if (!r) throw new Error(`no row ${day}`);
  return r;
};

/** Pool of a product as { qty, value } from the cache. */
export const pool = (s: { ctx: AppContext }, id: number) => poolOf(s, id);

/** (9) Stock movement reconciliation: for EVERY product the cache equals the sum of its movements, and the API reconciliation is ok. */
export async function reconAll(s: ApiBase): Promise<void> {
  for (const r of sql(s, 'SELECT id FROM products')) {
    const id = Number(r.id);
    expect(poolOf(s, id), `product ${id}: cache vs sum of movements`).toEqual(ledgerOf(s, id));
  }
  await reconOk(s);
}

/**
 * Structural duplicate / reversal checks for EVERY sales return in the database (audit item 12). Counts only; no money expectation.
 *  - posted return: exactly one refund cash entry (none when the refund is 0) of the right type/book/date/amount, no reversal entry;
 *    exactly one restock movement per RESALABLE line (qty/value as the line), no outflow movement, no sweep; one loss row per damaged line, no movement for it
 *  - void return: the above plus exactly one reversal cash entry (unique link, +refund, same book/date/type) and exactly one reversal movement per resalable line
 *    (qty -line qty) and at most one sweep per product; loss rows void
 *  - sale_items.returned_qty = qty of POSTED return lines
 */
export function assertReturnLedgers(ctx: AppContext): void {
  const returns = rows(ctx, `SELECT r.*, s.book AS book FROM sales_returns r JOIN sales s ON s.id = r.sale_id ORDER BY r.id`);
  for (const r of returns) {
    const id = Number(r.id);
    const tag = `return #${id} (${r.status})`;
    const cash = rows(ctx, `SELECT * FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? ORDER BY id`, id);
    const orig = cash.filter((c) => c.reverses_entry_id === null);
    const rev = cash.filter((c) => c.reverses_entry_id !== null);
    const refund = Number(r.refund_cents);
    const want = r.book === 'shop' ? 'sale_refund' : 'card_refund';
    expect(orig.length, `${tag}: refund entries`).toBe(refund > 0 ? 1 : 0);
    if (refund > 0) {
      expect(orig[0], `${tag}: refund row`).toMatchObject({ book: r.book, type: want, amount_cents: -refund, business_date: r.business_date });
    }
    if (r.status === 'posted') {
      expect(rev.length, `${tag}: reversal entries on a posted return`).toBe(0);
    } else {
      expect(rev.length, `${tag}: reversal entries`).toBe(refund > 0 ? 1 : 0);
      if (refund > 0) {
        expect(rev[0], `${tag}: reversal row`).toMatchObject({ book: r.book, type: want, amount_cents: refund, business_date: r.business_date, reverses_entry_id: orig[0]!.id });
      }
    }
    const lines = rows(ctx, `SELECT ri.*, si.product_id AS product_id FROM sales_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.sales_return_id = ? ORDER BY ri.id`, id);
    const resalable = lines.filter((l) => Number(l.resalable) === 1);
    const damaged = lines.filter((l) => Number(l.resalable) === 0);
    const mv = rows(ctx, `SELECT * FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = ? ORDER BY id`, id);
    const restock = mv.filter((m) => m.type === 'sale_return' && Number(m.qty_delta) > 0);
    const back = mv.filter((m) => m.type === 'sale_return' && Number(m.qty_delta) < 0);
    const sweeps = mv.filter((m) => m.type === 'adjustment');
    expect(mv.length, `${tag}: only restock / reversal / sweep movements`).toBe(restock.length + back.length + sweeps.length);
    expect(restock.length, `${tag}: one restock movement per resalable line`).toBe(resalable.length);
    const byProduct = (xs: Array<Record<string, any>>, f: (x: Record<string, any>) => number) => {
      const m = new Map<number, number>();
      for (const x of xs) m.set(Number(x.product_id), (m.get(Number(x.product_id)) ?? 0) + f(x));
      return m;
    };
    expect(byProduct(restock, (m) => Number(m.qty_delta)), `${tag}: restocked units per product`).toEqual(byProduct(resalable, (l) => Number(l.qty)));
    expect(byProduct(restock, (m) => Number(m.value_delta_cents)), `${tag}: restocked value per product`).toEqual(byProduct(resalable, (l) => Number(l.cogs_cents)));
    if (r.status === 'posted') {
      expect(back.length + sweeps.length, `${tag}: no outflow movement on a posted return`).toBe(0);
    } else {
      expect(back.length, `${tag}: one reversal movement per resalable line`).toBe(resalable.length);
      expect(byProduct(back, (m) => -Number(m.qty_delta)), `${tag}: reversed units per product`).toEqual(byProduct(resalable, (l) => Number(l.qty)));
      for (const [pid, n] of byProduct(sweeps, () => 1)) expect(n, `${tag}: sweeps of product ${pid}`).toBeLessThanOrEqual(1);
      for (const sw of sweeps) {
        expect(Number(sw.qty_delta), `${tag}: a sweep moves value only`).toBe(0);
        expect(Number(sw.value_delta_cents), `${tag}: a sweep removes value`).toBeLessThan(0);
      }
      // the reversal never removes more than the return restored (R4 limit)
      for (const [pid, restoredValue] of byProduct(restock, (m) => Number(m.value_delta_cents))) {
        const removed = back.filter((b) => Number(b.product_id) === pid).reduce((a, b) => a - Number(b.value_delta_cents), 0);
        expect(removed, `${tag}: removed value of product ${pid} within the restored value`).toBeLessThanOrEqual(restoredValue);
      }
    }
    // damaged lines: exactly one loss row each at the line's cost, void with the return; and NO stock movement of its own
    const losses = rows(ctx, `SELECT * FROM stock_losses WHERE sales_return_id = ? ORDER BY id`, id);
    expect(losses.length, `${tag}: one loss row per damaged line`).toBe(damaged.length);
    expect(losses.map((l) => Number(l.cost_cents)).sort((a, b) => a - b), `${tag}: loss costs`).toEqual(damaged.map((l) => Number(l.cogs_cents)).sort((a, b) => a - b));
    for (const l of losses) {
      expect(l.status, `${tag}: loss status follows the return`).toBe(r.status);
      expect(l.source).toBe('damaged_return');
      expect(n1(ctx, `SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'stock_losses' AND ref_id = ?`, Number(l.id)), `${tag}: a damaged-return loss writes no stock movement`).toBe(0);
    }
    // header sums equal the line sums
    expect(lines.reduce((a, l) => a + Number(l.revenue_cents), 0), `${tag}: refund = sum of line revenue`).toBe(refund);
    expect(lines.reduce((a, l) => a + Number(l.cogs_cents), 0), `${tag}: cogs reversed = sum of line cogs`).toBe(Number(r.cogs_reversed_cents));
    expect(lines.reduce((a, l) => a + Number(l.extra_cost_cents), 0), `${tag}: extra reversed = sum of line extra`).toBe(Number(r.extra_cost_reversed_cents));
  }
  // counters
  expect(n1(ctx, `SELECT COUNT(*) FROM sale_items si WHERE si.returned_qty <>
    COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.sales_return_id WHERE ri.sale_item_id = si.id AND r.status = 'posted'), 0)`),
    'returned_qty = qty of posted return lines').toBe(0);
  // a cash entry is reversed at most once; every return cash row belongs to an existing return
  expect(n1(ctx, `SELECT COUNT(*) FROM (SELECT reverses_entry_id FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND ref_table = 'sales_returns' GROUP BY reverses_entry_id HAVING COUNT(*) > 1)`), 'cash entry reversed twice').toBe(0);
  expect(n1(ctx, `SELECT COUNT(*) FROM cash_entries c WHERE c.ref_table = 'sales_returns' AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = c.ref_id)`), 'orphan return cash').toBe(0);
  expect(n1(ctx, `SELECT COUNT(*) FROM stock_movements m WHERE m.ref_table = 'sales_returns' AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = m.ref_id)`), 'orphan return movement').toBe(0);
  // sale / return interplay: a void sale has no posted return
  expect(n1(ctx, `SELECT COUNT(*) FROM sales_returns r JOIN sales s ON s.id = r.sale_id WHERE s.status = 'void' AND r.status = 'posted'`), 'posted return on a void sale').toBe(0);
}

/** Count of rows of every table that a return void may touch (a refused void must leave all of them identical; we use full snapshots too). */
export const cnt = (ctx: AppContext, table: string): number => n1(ctx, `SELECT COUNT(*) FROM "${table}"`);

/** Total of a cash book from the ledger rows (cents). */
export const cashOf = (s: { ctx: AppContext }, book: string): number =>
  num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', book);

/** All permutations of `xs` (for "every possible void order"). */
export function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => { for (const p of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}
