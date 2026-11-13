/**
 * services/reports/pnl-shop.ts - Shop profit and loss per period (BUSINESS_RULES 1, 3, 4, 6, 7, 11, C4, C5, C13).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only; reusable by the Phase 12 dashboard).
 *
 *   Shop net profit = goods gross profit + service (print) gross profit
 *                     - shop operating expenses - stock adjustments (net) +/- cash over/short.
 *
 * Why these lines and not others (each one is a rule that must keep holding):
 *  - Goods cost of sales = automatic cost + C13 extra cost, both net of returns (R5, C5). Returns hit the return's period.
 *  - Printing supplies are cash-out only and never P&L (R12); the standard cost on each print sale is the P&L cost.
 *  - Expenses are the shop's own; there is never an electricity expense (E2) - the whole shop bill is the Ice Cream book's.
 *  - Owner drawings, capital, transfers, opening balances and purchases are below the line and never read here.
 * The SQL (grouped by business date, no per-day loop) and the movement/entry-type mapping live in fin-queries.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import { wholePeriod } from './fin-common.ts';
import type { PeriodRow } from './fin-common.ts';
import {
  adjustmentsByPeriod, expensesByPeriod, overShortByPeriod, salesByPeriod, servicesByPeriod,
} from './fin-queries.ts';
import type { AdjustmentFigures, ExpenseFigures, SalesFigures, ServiceFigures } from './fin-queries.ts';

/** The figures of one Shop report row (a period or the whole range). */
export interface ShopFigures {
  goods: SalesFigures;
  services: ServiceFigures;
  /** Goods gross profit + service gross profit. */
  grossProfitCents: number;
  expenses: ExpenseFigures;
  adjustments: AdjustmentFigures;
  cashOverShortCents: number;
  netProfitCents: number;
}

/** The request of a period report (validated by `parseReportQuery`). */
export interface PeriodQuery { from: string; to: string; granularity: Granularity }

/** The full answer of `GET /reports/pnl/shop`. */
export interface ShopPnlReport {
  segment: 'shop'; from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<ShopFigures>>; totals: ShopFigures; table: ReportTable; warnings: never[];
}

/** Figures for each of the given periods (grouped SQL: a constant number of queries for any number of periods). */
export function shopFigures(conn: DatabaseSync, periods: readonly Period[]): ShopFigures[] {
  const goods = salesByPeriod(conn, periods, 'shop');
  const services = servicesByPeriod(conn, periods);
  const expenses = expensesByPeriod(conn, periods, 'shop');
  const adjustments = adjustmentsByPeriod(conn, periods, 'shop');
  const overShort = overShortByPeriod(conn, periods, 'shop');
  return periods.map((_, i) => {
    const gross = goods[i]!.grossProfitCents + services[i]!.grossProfitCents;
    return {
      goods: goods[i]!, services: services[i]!, grossProfitCents: gross, expenses: expenses[i]!, adjustments: adjustments[i]!,
      cashOverShortCents: overShort[i]!, netProfitCents: gross - expenses[i]!.totalCents - adjustments[i]!.netCents + overShort[i]!,
    };
  });
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'goodsRevenue', label: 'Goods sales (net of returns)', kind: 'money' },
  { key: 'costAutomatic', label: 'Cost: automatic', kind: 'money' },
  { key: 'costExtra', label: 'Cost: extra', kind: 'money' },
  { key: 'goodsProfit', label: 'Goods gross profit', kind: 'money' },
  { key: 'serviceRevenue', label: 'Print/other services', kind: 'money' },
  { key: 'serviceCost', label: 'Service cost', kind: 'money' },
  { key: 'serviceProfit', label: 'Service gross profit', kind: 'money' },
  { key: 'expenses', label: 'Operating expenses', kind: 'money' },
  { key: 'adjustments', label: 'Stock adjustments (net)', kind: 'money' },
  { key: 'purchaseRefundGain', label: 'Purchase refund above stock value removed (R4)', kind: 'money' },
  { key: 'salesReturnVoidGain', label: 'Void-return stock value gain (R-VR)', kind: 'money' },
  { key: 'overShort', label: 'Cash over / short', kind: 'money' },
  { key: 'netProfit', label: 'Net profit', kind: 'money' },
];

function flat(label: string, f: ShopFigures): Record<string, ReportCell> {
  return {
    period: label, goodsRevenue: f.goods.revenueCents, costAutomatic: f.goods.costAutomaticCents, costExtra: f.goods.costExtraCents,
    goodsProfit: f.goods.grossProfitCents, serviceRevenue: f.services.revenueCents, serviceCost: f.services.costCents,
    serviceProfit: f.services.grossProfitCents, expenses: f.expenses.totalCents, adjustments: f.adjustments.netCents, purchaseRefundGain: f.adjustments.purchaseRefundGainCents,
    salesReturnVoidGain: f.adjustments.salesReturnVoidGainCents,
    overShort: f.cashOverShortCents, netProfit: f.netProfitCents,
  };
}

/** Plain-language notes printed under the table and in the Excel file. */
export const SHOP_NOTES: string[] = [
  'Goods and service sales are net of returns; a return counts in the period of the return date.',
  'Cost = automatic (weighted-average) cost plus any extra cost the cashier added on the sale (C13).',
  'Printing supplies bought, owner drawings, capital, transfers and opening balances are not in profit.',
  'There is no electricity expense in the Shop: the whole shop electricity bill is carried by the Ice Cream book.',
  'Stock adjustments (net) = losses + stocktake losses + residual sweeps - stocktake gains - purchase refund gain - void-return stock value gain.',
  'Purchase refund above stock value removed (R4): when a returned or voided purchase is refunded in cash for more than the stock value that leaves the shelf, the difference is a gain (shown positive; it is already inside Stock adjustments (net) as a reduction).',
  'Void-return stock value gain (R-VR): when a sales return is voided, the stock leaves again at the value the return restored, limited to what the stock is worth now; a lower value is a gain (shown positive, already inside Stock adjustments (net)). A voided return itself is not counted anywhere: its sales, cost and extra cost stand as if it had never been recorded.',
];

/**
 * Shop profit and loss for a date range.
 *
 * @param q.granularity `day` or `month` rows (clipped calendar months); the totals row is calculated over the whole range, so rows add up to it.
 */
export function shopPnl(conn: DatabaseSync, q: PeriodQuery): ShopPnlReport {
  const periods = listPeriods(q.from, q.to, q.granularity);
  const figs = shopFigures(conn, periods);
  const totals = shopFigures(conn, [wholePeriod(q.from, q.to)])[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));
  const table: ReportTable = {
    title: 'Shop profit and loss', columns: COLUMNS, rows: rows.map((r) => flat(r.period.label, r)),
    totals: flat('Total', totals), notes: SHOP_NOTES,
  };
  return { segment: 'shop', from: q.from, to: q.to, granularity: q.granularity, rows, totals, table, warnings: [] };
}
