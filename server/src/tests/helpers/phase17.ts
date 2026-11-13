// Helpers for the Phase 17 tests: voiding a sales return (BUSINESS_RULES section 4, rule R-VR).
// Only thin request builders and ledger readers; every expected number lives in the tests, worked out by hand.

import type { AppContext } from '../../app.ts';
import { get, post } from './catalog.ts';
import type { ApiBase } from './inventory.ts';
import { n1, rows } from './phase14.ts';

/** POST /sales/:saleId/returns/:returnId/void (raw response). */
export const voidReturnNew = (s: ApiBase, saleId: number, returnId: number, reason = 'test void') =>
  post(s.app, `/sales/${saleId}/returns/${returnId}/void`, { reason });

/** The same call, which must answer 200; returns the body `{ item, sale, warnings }`. */
export async function voidReturnOk(s: ApiBase, saleId: number, returnId: number, reason = 'test void'): Promise<any> {
  const r = await voidReturnNew(s, saleId, returnId, reason);
  if (r.status !== 200) throw new Error(`void return failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Shop P&L totals for a date range (month granularity). */
export const shopPnlTotals = async (s: ApiBase, from: string, to: string) =>
  (await get(s.app, `/reports/pnl/shop?from=${from}&to=${to}&granularity=month`)).body.totals;

/** Every table a return void may touch, as row counts + a content hash-free fingerprint (JSON of all rows). */
const VOID_TABLES = ['sales', 'sale_items', 'sales_returns', 'sales_return_items', 'stock_losses', 'stock_movements', 'cash_entries',
  'audit_logs', 'products', 'daily_closings'];
export function fingerprint(ctx: AppContext): string {
  return JSON.stringify(VOID_TABLES.map((t) => rows(ctx, `SELECT * FROM "${t}" ORDER BY rowid`)), (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
}

/** Invariant: every sale line's returned_qty equals the quantity of its POSTED return lines. */
export function returnedQtyMismatches(ctx: AppContext): number {
  return n1(ctx, `SELECT COUNT(*) FROM sale_items si WHERE si.returned_qty <>
    COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.sales_return_id
               WHERE ri.sale_item_id = si.id AND r.status = 'posted'), 0)`);
}
