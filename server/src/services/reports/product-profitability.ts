/**
 * services/reports/product-profitability.ts - Profit per product over a period, after returns.
 *
 * Layer: report service, a pure function `(conn, query) => figures` (the sales report reuses it for "top products").
 * Read-only.
 *
 * Rules protected (API_CONTRACTS Wave 4 line definitions; BUSINESS_RULES sections 3, 4, C5, C13):
 *  - Revenue = posted sale lines dated in the period - return lines dated in the period (R5/R7: a return hits the
 *    period of the RETURN's date whatever the sale's date).
 *  - Cost = automatic cost (`cogs_cents`) + extra cost (`extra_cost_cents`, C13), each reduced by the proportional
 *    part reversed by returns dated in the period. Gross profit = revenue - (automatic + extra).
 *  - Voided sales are excluded (R1); a sale cannot be voided once it has returns, so no return of a void sale exists.
 *  - A damaged return reverses revenue and cost like any return; its single stock-loss row is NOT part of this report
 *    (it is a stock adjustment, section 4 / 11) so nothing is counted twice.
 *  - Grouped SQL only: one query for sale lines, one for return lines, merged by product.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ReportTable } from '../../lib/report-table.ts';
import { marginBp, num } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';

/** Request: a business-date range and optional filters. */
export interface ProfitabilityQuery { from: string; to: string; book?: StockBook; categoryId?: number }

/** One product's figures. Money in cents, margin in basis points (null when the net revenue is 0). */
export interface ProfitabilityRow {
  productId: number; productName: string; productCode: string | null; categoryName: string; book: StockBook;
  soldQty: number; returnedQty: number; netQty: number;
  salesRevenueCents: number; returnsRevenueCents: number; revenueCents: number;
  costAutoCents: number; costExtraCents: number; costCents: number; grossProfitCents: number; marginBp: number | null;
}

/** Totals over all rows. */
export interface ProfitabilityTotals {
  soldQty: number; returnedQty: number; netQty: number; salesRevenueCents: number; returnsRevenueCents: number; revenueCents: number;
  costAutoCents: number; costExtraCents: number; costCents: number; grossProfitCents: number; marginBp: number | null;
}

/** Report body. */
export interface ProfitabilityReport {
  from: string; to: string;
  rows: ProfitabilityRow[]; totals: ProfitabilityTotals; table: ReportTable; warnings: ReportWarning[];
}

/** Builds the profitability figures per product for [from, to], most profitable first. */
export function productProfitability(conn: DatabaseSync, q: ProfitabilityQuery): ProfitabilityReport {
  const filt: string[] = [];
  const extra: SQLInputValue[] = [];
  if (q.book !== undefined) { filt.push('p.book = ?'); extra.push(q.book); }
  if (q.categoryId !== undefined) { filt.push('p.category_id = ?'); extra.push(q.categoryId); }
  const f = filt.length > 0 ? ` AND ${filt.join(' AND ')}` : '';

  const sold = conn.prepare(
    `SELECT si.product_id AS pid, p.name, p.code, c.name AS cat, p.book,
            SUM(si.qty) AS qty, SUM(si.revenue_cents) AS rev, SUM(si.cogs_cents) AS cogs, SUM(si.extra_cost_cents) AS extra
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'posted' AND s.business_date BETWEEN ? AND ?${f} GROUP BY si.product_id`,
  ).all(q.from, q.to, ...extra) as unknown as SqlRow[];
  const returned = conn.prepare(
    `SELECT si.product_id AS pid, p.name, p.code, c.name AS cat, p.book,
            SUM(ri.qty) AS qty, SUM(ri.revenue_cents) AS rev, SUM(ri.cogs_cents) AS cogs, SUM(ri.extra_cost_cents) AS extra
       FROM sales_return_items ri
       JOIN sales_returns r ON r.id = ri.sales_return_id
       JOIN sale_items si ON si.id = ri.sale_item_id
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'posted' AND r.business_date BETWEEN ? AND ?${f} GROUP BY si.product_id`,
  ).all(q.from, q.to, ...extra) as unknown as SqlRow[];

  const byProduct = new Map<number, ProfitabilityRow>();
  const rowFor = (r: SqlRow): ProfitabilityRow => {
    const id = num(r.pid);
    let row = byProduct.get(id);
    if (!row) {
      row = {
        productId: id, productName: String(r.name), productCode: (r.code as string | null) ?? null, categoryName: String(r.cat), book: r.book as StockBook,
        soldQty: 0, returnedQty: 0, netQty: 0, salesRevenueCents: 0, returnsRevenueCents: 0, revenueCents: 0,
        costAutoCents: 0, costExtraCents: 0, costCents: 0, grossProfitCents: 0, marginBp: null,
      };
      byProduct.set(id, row);
    }
    return row;
  };
  for (const r of sold) {
    const row = rowFor(r);
    row.soldQty += num(r.qty); row.salesRevenueCents += num(r.rev); row.costAutoCents += num(r.cogs); row.costExtraCents += num(r.extra);
  }
  for (const r of returned) {
    const row = rowFor(r);
    row.returnedQty += num(r.qty); row.returnsRevenueCents += num(r.rev); row.costAutoCents -= num(r.cogs); row.costExtraCents -= num(r.extra);
  }
  const rows = [...byProduct.values()];
  for (const r of rows) {
    r.netQty = r.soldQty - r.returnedQty;
    r.revenueCents = r.salesRevenueCents - r.returnsRevenueCents;
    r.costCents = r.costAutoCents + r.costExtraCents;
    r.grossProfitCents = r.revenueCents - r.costCents;
    r.marginBp = marginBp(r.grossProfitCents, r.revenueCents);
  }
  rows.sort((a, b) => b.grossProfitCents - a.grossProfitCents || a.productName.localeCompare(b.productName));

  const t: ProfitabilityTotals = {
    soldQty: 0, returnedQty: 0, netQty: 0, salesRevenueCents: 0, returnsRevenueCents: 0, revenueCents: 0,
    costAutoCents: 0, costExtraCents: 0, costCents: 0, grossProfitCents: 0, marginBp: null,
  };
  for (const r of rows) {
    t.soldQty += r.soldQty; t.returnedQty += r.returnedQty; t.netQty += r.netQty; t.salesRevenueCents += r.salesRevenueCents;
    t.returnsRevenueCents += r.returnsRevenueCents; t.revenueCents += r.revenueCents; t.costAutoCents += r.costAutoCents;
    t.costExtraCents += r.costExtraCents; t.costCents += r.costCents; t.grossProfitCents += r.grossProfitCents;
  }
  t.marginBp = marginBp(t.grossProfitCents, t.revenueCents);

  const table: ReportTable = {
    title: 'Product profitability',
    columns: [
      { key: 'name', label: 'Product', kind: 'text' }, { key: 'category', label: 'Category', kind: 'text' }, { key: 'book', label: 'Book', kind: 'text' },
      { key: 'netQty', label: 'Net units sold', kind: 'int' }, { key: 'revenueCents', label: 'Revenue', kind: 'money' },
      { key: 'costAutoCents', label: 'Cost: automatic', kind: 'money' }, { key: 'costExtraCents', label: 'Cost: extra', kind: 'money' },
      { key: 'costCents', label: 'Cost', kind: 'money' }, { key: 'grossProfitCents', label: 'Gross profit', kind: 'money' },
      { key: 'marginBp', label: 'Margin', kind: 'percent' },
    ],
    rows: rows.map((r) => ({
      name: r.productName, category: r.categoryName, book: r.book, netQty: r.netQty, revenueCents: r.revenueCents,
      costAutoCents: r.costAutoCents, costExtraCents: r.costExtraCents, costCents: r.costCents, grossProfitCents: r.grossProfitCents, marginBp: r.marginBp,
    })),
    totals: {
      name: 'Total', category: null, book: null, netQty: t.netQty, revenueCents: t.revenueCents, costAutoCents: t.costAutoCents,
      costExtraCents: t.costExtraCents, costCents: t.costCents, grossProfitCents: t.grossProfitCents, marginBp: t.marginBp,
    },
    notes: ['Figures are after returns dated in the period. Cost = automatic cost + extra cost. Voided sales are not counted.'],
  };
  return { from: q.from, to: q.to, rows, totals: t, table, warnings: [] };
}
