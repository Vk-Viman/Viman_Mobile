/**
 * services/reports/fin-queries.ts - the grouped, read-only SQL behind the Shop and Telecom profit and loss reports.
 *
 * Layer: report query helper. Each function runs a FEW grouped queries over the whole report range and returns one
 * figure record per period (see fin-common.ts), so the number of queries is constant no matter how many day rows are
 * asked for. Nothing here writes, and nothing re-derives a business rule: it only adds up the stored, snapshotted
 * figures (R7: reports follow the business date; R1: only `status = 'posted'` business rows, never reversal rows).
 *
 * LINE-TO-SOURCE MAPPING (BUSINESS_RULES 1-6, 11, C4, C5, C13; API_CONTRACTS Wave 4 line definitions):
 *  - Goods / card revenue  = posted `sales` of the book (+ `sale_items`) by sale date, minus `sales_returns` by RETURN date (R5).
 *  - Cost of sales         = sale_items.cogs_cents (automatic) - sales_returns.cogs_reversed_cents, plus the C13 extra
 *                            cost sale_items.extra_cost_cents - sales_returns.extra_cost_reversed_cents.
 *  - Service revenue/cost  = posted `print_sales` (R12); `printing_supplies` are never read (variance report only).
 *  - Reload / EZCash       = posted `reload_sales` / `ezcash_sales` commission_cents (R14: collections and top-ups never read).
 *  - Operating expenses    = posted `expenses` of the book by category (E2: there is no electricity category).
 *  - Stock adjustments     = movement types of the product's book (migration 004, services/inventory.service.ts):
 *        'loss'            (value_delta < 0)  -> losses; its void is the exact negation, so it nets out
 *        'stocktake_loss'  (value_delta < 0)  -> stocktake losses;  'stocktake_gain' (value_delta > 0) -> stocktake gains
 *        'adjustment'      (value-only)       -> residual sweeps of purchase returns/voids (R4)
 *      plus `stock_losses` rows with source = 'damaged_return' (a damaged sales return writes NO stock movement, only
 *      that one loss row at the original automatic cost - so it is counted exactly once, section 4).
 *      NOT adjustments: 'personal_use' (goods drawing, below the line), 'sale', 'sale_return', 'sale_void', 'purchase',
 *      'purchase_return', 'purchase_void', 'opening'.
 *  - Cash over/short       = posted `cash_counts.difference_cents` of the book (C4: over +, short -).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Period } from '../../lib/report-table.ts';
import { EXPENSE_CATEGORIES } from '../expenses.service.ts';
import { neg, sumByPeriod, sumByPeriodAndGroup } from './fin-common.ts';

/** The two stock books the Shop and Telecom reports cover. */
export type StockBook = 'shop' | 'telecom';

function range(periods: readonly Period[]): [string, string] {
  return [periods[0]!.from, periods[periods.length - 1]!.to];
}

/** Revenue and cost lines of stock sales (Shop goods / Telecom scratch cards), net of returns. */
export interface SalesFigures {
  salesCents: number; returnsCents: number; revenueCents: number;
  costAutomaticCents: number; costExtraCents: number; costOfSalesCents: number; grossProfitCents: number;
}

/**
 * Sales minus returns per period. A return is counted in the period of the RETURN date, whatever the sale's date (R5, R7).
 * `costAutomaticCents` / `costExtraCents` are net of the cost the returns reversed (C5, C13).
 */
export function salesByPeriod(conn: DatabaseSync, periods: readonly Period[], book: StockBook): SalesFigures[] {
  const [from, to] = range(periods);
  const sales = sumByPeriod(conn, periods,
    `SELECT s.business_date AS d, SUM(si.revenue_cents) AS rev, SUM(si.cogs_cents) AS cogs, SUM(si.extra_cost_cents) AS extra
       FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE s.book = ? AND s.status = 'posted' AND s.business_date BETWEEN ? AND ?
      GROUP BY s.business_date`, [book, from, to], ['rev', 'cogs', 'extra'] as const);
  const returns = sumByPeriod(conn, periods,
    `SELECT r.business_date AS d, SUM(r.refund_cents) AS rev, SUM(r.cogs_reversed_cents) AS cogs, SUM(r.extra_cost_reversed_cents) AS extra
       FROM sales_returns r JOIN sales s ON s.id = r.sale_id
      WHERE s.book = ? AND s.status = 'posted' AND r.business_date BETWEEN ? AND ?
      GROUP BY r.business_date`, [book, from, to], ['rev', 'cogs', 'extra'] as const);
  return periods.map((_, i) => {
    const s = sales[i]!;
    const r = returns[i]!;
    const revenue = s.rev - r.rev;
    const auto = s.cogs - r.cogs;
    const extra = s.extra - r.extra;
    return {
      salesCents: s.rev, returnsCents: r.rev, revenueCents: revenue,
      costAutomaticCents: auto, costExtraCents: extra, costOfSalesCents: auto + extra, grossProfitCents: revenue - auto - extra,
    };
  });
}

/** Print / photocopy service lines (Shop only, R12). */
export interface ServiceFigures { revenueCents: number; costCents: number; grossProfitCents: number }

/** Posted print sales per period: revenue, snapshotted standard cost, gross profit. */
export function servicesByPeriod(conn: DatabaseSync, periods: readonly Period[]): ServiceFigures[] {
  const [from, to] = range(periods);
  const rows = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(revenue_cents) AS rev, SUM(cogs_cents) AS cogs FROM print_sales
      WHERE status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date`, [from, to], ['rev', 'cogs'] as const);
  return rows.map((r) => ({ revenueCents: r.rev, costCents: r.cogs, grossProfitCents: r.rev - r.cogs }));
}

/** Operating expenses of one book with the by-category breakdown (all nine categories are always present). */
export interface ExpenseFigures { totalCents: number; byCategory: Record<string, number> }

/** Posted expenses of the book per period (E2: electricity is not a category and never appears). */
export function expensesByPeriod(conn: DatabaseSync, periods: readonly Period[], book: StockBook): ExpenseFigures[] {
  const [from, to] = range(periods);
  const groups = sumByPeriodAndGroup(conn, periods,
    `SELECT business_date AS d, category AS g, SUM(amount_cents) AS amt FROM expenses
      WHERE book = ? AND status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date, category`,
    [book, from, to], ['amt'] as const);
  return periods.map((_, i) => {
    const byCategory: Record<string, number> = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, 0]));
    let total = 0;
    for (const [cat, arr] of groups) { byCategory[cat] = arr[i]!.amt; total += arr[i]!.amt; }
    return { totalCents: total, byCategory };
  });
}

/** Stock adjustments (net) of one book, BUSINESS_RULES 11: losses + stocktake losses + residual sweeps - stocktake gains. */
export interface AdjustmentFigures {
  lossesCents: number; damagedReturnLossesCents: number; stocktakeLossesCents: number; stocktakeGainsCents: number;
  residualSweepsCents: number; netCents: number;
}

/**
 * Stock adjustments per period from the stock ledger of the book's products (see the mapping in the file header).
 * Reversal rows of voided losses/stocktakes carry the original business date and the exact negated value, so a voided
 * record nets to zero inside its own period.
 */
export function adjustmentsByPeriod(conn: DatabaseSync, periods: readonly Period[], book: StockBook): AdjustmentFigures[] {
  const [from, to] = range(periods);
  const moves = sumByPeriodAndGroup(conn, periods,
    `SELECT m.business_date AS d, m.type AS g, SUM(m.value_delta_cents) AS v
       FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE p.book = ? AND m.type IN ('loss','stocktake_loss','stocktake_gain','adjustment') AND m.business_date BETWEEN ? AND ?
      GROUP BY m.business_date, m.type`, [book, from, to], ['v'] as const);
  const damaged = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(cost_cents) AS c FROM stock_losses
      WHERE book = ? AND source = 'damaged_return' AND status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
    [book, from, to], ['c'] as const);
  const v = (type: string, i: number): number => moves.get(type)?.[i]?.v ?? 0;
  return periods.map((_, i) => {
    // A loss removes value (negative delta) = a cost; a gain adds value (positive delta) = a credit.
    const losses = neg(v('loss', i));
    const stocktakeLosses = neg(v('stocktake_loss', i));
    const gains = v('stocktake_gain', i);
    const sweeps = neg(v('adjustment', i));
    const damagedReturn = damaged[i]!.c;
    return {
      lossesCents: losses, damagedReturnLossesCents: damagedReturn, stocktakeLossesCents: stocktakeLosses,
      stocktakeGainsCents: gains, residualSweepsCents: sweeps,
      netCents: losses + damagedReturn + stocktakeLosses + sweeps - gains,
    };
  });
}

/** Net cash over/short of one book per period: + over (income), - short (cost) (C4). Posted counts only. */
export function overShortByPeriod(conn: DatabaseSync, periods: readonly Period[], book: StockBook): number[] {
  const [from, to] = range(periods);
  return sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(difference_cents) AS diff FROM cash_counts
      WHERE book = ? AND status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
    [book, from, to], ['diff'] as const).map((r) => r.diff);
}

/** Telecom commission lines (section 5). Collections and top-ups are cash only and never read here (R14). */
export interface CommissionFigures {
  reloadSalesCents: number; reloadBaseCommissionCents: number; reloadExtraCents: number; reloadCommissionCents: number;
  ezcashBillCents: number; ezcashCommissionCents: number;
}

/** Posted reload and EZCash entries per period. Base commission = commission - extra (the extra is shown separately). */
export function commissionsByPeriod(conn: DatabaseSync, periods: readonly Period[]): CommissionFigures[] {
  const [from, to] = range(periods);
  const rel = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(sales_cents) AS sales, SUM(commission_cents) AS comm, SUM(extra_cents) AS extra FROM reload_sales
      WHERE status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date`, [from, to], ['sales', 'comm', 'extra'] as const);
  const ez = sumByPeriod(conn, periods,
    `SELECT business_date AS d, SUM(bill_total_cents) AS bill, SUM(commission_cents) AS comm FROM ezcash_sales
      WHERE status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date`, [from, to], ['bill', 'comm'] as const);
  return periods.map((_, i) => ({
    reloadSalesCents: rel[i]!.sales, reloadBaseCommissionCents: rel[i]!.comm - rel[i]!.extra, reloadExtraCents: rel[i]!.extra,
    reloadCommissionCents: rel[i]!.comm, ezcashBillCents: ez[i]!.bill, ezcashCommissionCents: ez[i]!.comm,
  }));
}

/** Memo (cash only, never P&L): provider and wallet top-ups of the telecom book per period (R14). */
export function topupsByPeriod(conn: DatabaseSync, periods: readonly Period[]): Array<{ providerTopupsCents: number; walletTopupsCents: number }> {
  const [from, to] = range(periods);
  return sumByPeriod(conn, periods,
    `SELECT business_date AS d,
            SUM(CASE WHEN kind = 'provider_topup' THEN amount_cents ELSE 0 END) AS p,
            SUM(CASE WHEN kind = 'wallet_topup' THEN amount_cents ELSE 0 END) AS w
       FROM telecom_topups WHERE status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
    [from, to], ['p', 'w'] as const).map((r) => ({ providerTopupsCents: r.p, walletTopupsCents: r.w }));
}
