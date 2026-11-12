/**
 * services/reports/pnl-telecom.ts - Telecom profit and loss per period (BUSINESS_RULES 1, 5, 7, 11, C4, R14).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only).
 *
 *   Telecom net profit = reload commission (base + rounding extra) + EZCash commission + scratch-card gross profit
 *                        - telecom operating expenses - stock adjustments (net) +/- cash over/short.
 *
 * Why: Telecom revenue is COMMISSION ONLY (section 5). The full reload collections, EZCash bill collections and the
 * provider/wallet top-ups are cash movements, never revenue or cost (R14: the Telecom cash book will not reconcile to
 * Telecom profit - there is no float tracking, an owner decision). They are shown below as memo lines, not added.
 * Scratch cards are ordinary stock products (book `telecom`): revenue minus automatic and extra cost, net of returns.
 * There is never an electricity expense here (E2). The SQL and type mapping live in fin-queries.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import { wholePeriod } from './fin-common.ts';
import type { PeriodRow } from './fin-common.ts';
import {
  adjustmentsByPeriod, commissionsByPeriod, expensesByPeriod, overShortByPeriod, salesByPeriod, topupsByPeriod,
} from './fin-queries.ts';
import type { AdjustmentFigures, CommissionFigures, ExpenseFigures, SalesFigures } from './fin-queries.ts';
import type { PeriodQuery } from './pnl-shop.ts';
import type { Granularity } from '../../lib/report-table.ts';

/** The figures of one Telecom report row. */
export interface TelecomFigures {
  commissions: CommissionFigures;
  /** Reload commission + EZCash commission. */
  commissionRevenueCents: number;
  /** Scratch-card sales, cost and gross profit (net of returns). */
  cards: SalesFigures;
  /** Commission revenue + card gross profit. */
  grossProfitCents: number;
  expenses: ExpenseFigures;
  adjustments: AdjustmentFigures;
  cashOverShortCents: number;
  netProfitCents: number;
  /** Cash-only memo (never added to profit, R14). */
  memo: { providerTopupsCents: number; walletTopupsCents: number };
}

/** The full answer of `GET /reports/pnl/telecom`. */
export interface TelecomPnlReport {
  segment: 'telecom'; from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<TelecomFigures>>; totals: TelecomFigures; table: ReportTable; warnings: never[];
}

/** Figures for each of the given periods (constant number of grouped queries). */
export function telecomFigures(conn: DatabaseSync, periods: readonly Period[]): TelecomFigures[] {
  const comm = commissionsByPeriod(conn, periods);
  const cards = salesByPeriod(conn, periods, 'telecom');
  const expenses = expensesByPeriod(conn, periods, 'telecom');
  const adjustments = adjustmentsByPeriod(conn, periods, 'telecom');
  const overShort = overShortByPeriod(conn, periods, 'telecom');
  const topups = topupsByPeriod(conn, periods);
  return periods.map((_, i) => {
    const commissionRevenue = comm[i]!.reloadCommissionCents + comm[i]!.ezcashCommissionCents;
    const gross = commissionRevenue + cards[i]!.grossProfitCents;
    return {
      commissions: comm[i]!, commissionRevenueCents: commissionRevenue, cards: cards[i]!, grossProfitCents: gross,
      expenses: expenses[i]!, adjustments: adjustments[i]!, cashOverShortCents: overShort[i]!,
      netProfitCents: gross - expenses[i]!.totalCents - adjustments[i]!.netCents + overShort[i]!, memo: topups[i]!,
    };
  });
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'reloadBase', label: 'Reload commission', kind: 'money' },
  { key: 'reloadExtra', label: 'Reload rounding extra', kind: 'money' },
  { key: 'ezcash', label: 'EZCash commission', kind: 'money' },
  { key: 'cardRevenue', label: 'Scratch-card sales (net)', kind: 'money' },
  { key: 'cardCost', label: 'Card cost (auto + extra)', kind: 'money' },
  { key: 'cardProfit', label: 'Card gross profit', kind: 'money' },
  { key: 'expenses', label: 'Operating expenses', kind: 'money' },
  { key: 'adjustments', label: 'Stock adjustments (net)', kind: 'money' },
  { key: 'purchaseRefundGain', label: 'Purchase refund above stock value removed (R4)', kind: 'money' },
  { key: 'overShort', label: 'Cash over / short', kind: 'money' },
  { key: 'netProfit', label: 'Net profit', kind: 'money' },
  { key: 'reloadSales', label: 'Memo: reload collections', kind: 'money' },
  { key: 'ezcashBills', label: 'Memo: EZCash bills collected', kind: 'money' },
  { key: 'topups', label: 'Memo: provider + wallet top-ups', kind: 'money' },
];

function flat(label: string, f: TelecomFigures): Record<string, ReportCell> {
  return {
    period: label, reloadBase: f.commissions.reloadBaseCommissionCents, reloadExtra: f.commissions.reloadExtraCents,
    ezcash: f.commissions.ezcashCommissionCents, cardRevenue: f.cards.revenueCents, cardCost: f.cards.costOfSalesCents,
    cardProfit: f.cards.grossProfitCents, expenses: f.expenses.totalCents, adjustments: f.adjustments.netCents, purchaseRefundGain: f.adjustments.purchaseRefundGainCents,
    overShort: f.cashOverShortCents, netProfit: f.netProfitCents, reloadSales: f.commissions.reloadSalesCents,
    ezcashBills: f.commissions.ezcashBillCents, topups: f.memo.providerTopupsCents + f.memo.walletTopupsCents,
  };
}

/** Plain-language notes printed under the table and in the Excel file. */
export const TELECOM_NOTES: string[] = [
  'Telecom income is commission only: reload commission (with any rounding extra) and EZCash commission.',
  'Full reload collections, EZCash bill collections and provider/wallet top-ups are cash movements, not income or cost (memo columns).',
  'The Telecom cash book does not reconcile to Telecom profit because reload float is not tracked (owner decision, R14).',
  'Stock adjustments (net) = losses + stocktake losses + residual sweeps - stocktake gains - purchase refund gain (R4: cash refunded above the stock value removed, shown on its own line).',
  'Scratch cards are stock products: sales minus automatic and extra cost, net of returns.',
  'There is no electricity expense in Telecom: the whole shop electricity bill is carried by the Ice Cream book.',
];

/** Telecom profit and loss for a date range (rows add up to the totals row; see `shopPnl`). */
export function telecomPnl(conn: DatabaseSync, q: PeriodQuery): TelecomPnlReport {
  const periods = listPeriods(q.from, q.to, q.granularity);
  const figs = telecomFigures(conn, periods);
  const totals = telecomFigures(conn, [wholePeriod(q.from, q.to)])[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));
  const table: ReportTable = {
    title: 'Telecom profit and loss', columns: COLUMNS, rows: rows.map((r) => flat(r.period.label, r)),
    totals: flat('Total', totals), notes: TELECOM_NOTES,
  };
  return { segment: 'telecom', from: q.from, to: q.to, granularity: q.granularity, rows, totals, table, warnings: [] };
}
