/**
 * services/dashboard-export.ts - the tables of the "Excel export pack" (one workbook with the main reports for a period).
 *
 * Layer: dashboard helper (read-only). It only CALLS the Phase 11 report services and collects their `ReportTable`s; the workbook is
 * written by the shared `reportTablesToXlsx` (lib/report-table.ts). No figure is calculated here, so every sheet equals the matching
 * report for the same range (BUSINESS_RULES 10.6 period rule: month rows are clipped calendar months that add up to the total row).
 *
 * Sheets: Combined P&L (by month), Shop P&L, Telecom P&L, Ice Cream P&L, Ice Cream funds (statement + the separate recognized-profit
 * block, 10.1), Shop / Telecom / Ice Cream cash book, Inventory valuation (as of `to`), Low stock (live), Sales, Purchases, Drawings,
 * Printing variance.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ReportTable } from '../lib/report-table.ts';
import { cashbookReport } from './reports/cashbook-report.ts';
import { drawingsReport } from './reports/drawings-report.ts';
import { icecreamFundsReport } from './reports/icecream-funds-report.ts';
import { inventoryValuation } from './reports/inventory-valuation.ts';
import { lowStockReport } from './reports/low-stock.ts';
import { combinedPnl } from './reports/pnl-combined.ts';
import { icecreamPnl } from './reports/pnl-icecream.ts';
import { shopPnl } from './reports/pnl-shop.ts';
import type { PeriodQuery } from './reports/pnl-shop.ts';
import { telecomPnl } from './reports/pnl-telecom.ts';
import { printingVarianceReport } from './reports/printing-variance.ts';
import { purchasesReport } from './reports/purchases-report.ts';
import { salesReport } from './reports/sales-report.ts';

/** Same table with a shorter, Excel-friendly sheet name (sheet names are cut at 31 characters). */
const named = (t: ReportTable, title: string): ReportTable => ({ ...t, title });

/**
 * The tables of the export pack for `from..to` (business dates, already validated), in sheet order.
 * Period reports use month rows; the valuation is as of `to`; the low-stock list is the live list (it has no date).
 */
export function exportPackTables(conn: DatabaseSync, from: string, to: string): ReportTable[] {
  const month: PeriodQuery = { from, to, granularity: 'month' };
  const funds = icecreamFundsReport(conn, month);
  const lowStock = lowStockReport(conn, {});
  return [
    named(combinedPnl(conn, month).table, 'Combined P&L (by month)'),
    named(shopPnl(conn, month).table, 'Shop P&L'),
    named(telecomPnl(conn, month).table, 'Telecom P&L'),
    named(icecreamPnl(conn, month).table, 'Ice Cream P&L'),
    named(funds.table, 'Ice Cream funds'),
    named(funds.profitTable, 'Ice Cream profit and excess'),
    named(cashbookReport(conn, 'shop', month).table, 'Cash book - Shop'),
    named(cashbookReport(conn, 'telecom', month).table, 'Cash book - Telecom'),
    named(cashbookReport(conn, 'icecream', month).table, 'Cash book - Ice Cream'),
    named(inventoryValuation(conn, { asOf: to }).table, 'Inventory valuation'),
    named(lowStock.table, 'Low stock'),
    named(salesReport(conn, month).table, 'Sales'),
    named(purchasesReport(conn, month).table, 'Purchases'),
    named(drawingsReport(conn, month).table, 'Drawings'),
    named(printingVarianceReport(conn, month).table, 'Printing variance'),
  ];
}
