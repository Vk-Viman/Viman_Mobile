/**
 * services/reports/sales-report.ts - Sales per period and book: revenue, cost, gross profit, counts, returns, top products.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only. Covers goods sales (Shop) and
 * scratch-card sales (Telecom) - the `sales` tables. Print/photocopy services are in the printing-variance report,
 * reload and EZCash commission in the Telecom P&L (agent A).
 *
 * Rules protected (API_CONTRACTS Wave 4 line definitions; BUSINESS_RULES sections 3-4, C5, C13, R1, R5, R7):
 *  - Revenue = posted sales dated in the period - sales RETURNS dated in the period (a return hits its own date's period).
 *  - Cost = automatic cost (`cogs_cents`) - `cogs_reversed_cents` of returns + extra cost (`extra_cost_cents`) -
 *    `extra_cost_reversed_cents` of returns (C13); both parts are shown, and gross profit = revenue - (automatic + extra).
 *  - Voided sales are excluded (R1). Every row uses only records dated inside its own period, so days add up to the month.
 *  - Grouped SQL: one query for sales, one for returns (by period and book), plus the shared profitability query for
 *    "top products" (so the two reports cannot disagree).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Granularity, ReportTable } from '../../lib/report-table.ts';
import { addInto, fillPeriods, marginBp, num, numericOnly, periodKeySql } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';
import { productProfitability } from './product-profitability.ts';
import type { ProfitabilityRow } from './product-profitability.ts';

/** Request: dates, granularity, optional book and how many top products to list. */
export interface SalesQuery { from: string; to: string; granularity: Granularity; book?: StockBook; topN?: number }

/** One period's figures (cents). `revenueCents` is NET of returns; `salesRevenueCents`/`returnsCents` show the two parts. */
export interface SalesFigures {
  salesCount: number; returnCount: number; salesRevenueCents: number; returnsCents: number; revenueCents: number;
  costAutoCents: number; costExtraCents: number; costCents: number; grossProfitCents: number;
}

/** Report body. `byBook` repeats the figures per book for each period and for the total. */
export interface SalesReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<{ period: { from: string; to: string; label: string }; byBook: Record<StockBook, SalesFigures> } & SalesFigures>;
  totals: SalesFigures & { marginBp: number | null };
  totalsByBook: Record<StockBook, SalesFigures>;
  topProducts: ProfitabilityRow[];
  table: ReportTable; extraTables: ReportTable[]; warnings: ReportWarning[];
}

const zero = (): SalesFigures => ({
  salesCount: 0, returnCount: 0, salesRevenueCents: 0, returnsCents: 0, revenueCents: 0, costAutoCents: 0, costExtraCents: 0, costCents: 0, grossProfitCents: 0,
});
const BOOKS: StockBook[] = ['shop', 'telecom'];

function finish(f: SalesFigures): void {
  f.revenueCents = f.salesRevenueCents - f.returnsCents;
  f.costCents = f.costAutoCents + f.costExtraCents;
  f.grossProfitCents = f.revenueCents - f.costCents;
}

/** Sales report for [from, to]; `topN` (default 10) products by gross profit. */
export function salesReport(conn: DatabaseSync, q: SalesQuery): SalesReport {
  const bookSql = q.book !== undefined ? ' AND s.book = ?' : '';
  const args: SQLInputValue[] = [q.from, q.to, ...(q.book !== undefined ? [q.book] : [])];
  const cells = new Map<string, Record<StockBook, SalesFigures>>();
  const cell = (label: string, book: StockBook): SalesFigures => {
    let c = cells.get(label);
    if (!c) { c = { shop: zero(), telecom: zero() }; cells.set(label, c); }
    return c[book];
  };
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('s.business_date', q.granularity)} AS k, s.book AS book, COUNT(DISTINCT s.id) AS n,
            SUM(si.revenue_cents) AS rev, SUM(si.cogs_cents) AS cogs, SUM(si.extra_cost_cents) AS extra
       FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE s.status = 'posted' AND s.business_date BETWEEN ? AND ?${bookSql} GROUP BY k, s.book`,
  ).all(...args) as unknown as SqlRow[]) {
    const c = cell(String(r.k), r.book as StockBook);
    c.salesCount = num(r.n); c.salesRevenueCents = num(r.rev); c.costAutoCents += num(r.cogs); c.costExtraCents += num(r.extra);
  }
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('r.business_date', q.granularity)} AS k, s.book AS book, COUNT(*) AS n,
            SUM(r.refund_cents) AS rev, SUM(r.cogs_reversed_cents) AS cogs, SUM(r.extra_cost_reversed_cents) AS extra
       FROM sales_returns r JOIN sales s ON s.id = r.sale_id
      WHERE s.status = 'posted' AND r.status = 'posted' AND r.business_date BETWEEN ? AND ?${bookSql} GROUP BY k, s.book`,
  ).all(...args) as unknown as SqlRow[]) {
    const c = cell(String(r.k), r.book as StockBook);
    c.returnCount = num(r.n); c.returnsCents = num(r.rev); c.costAutoCents -= num(r.cogs); c.costExtraCents -= num(r.extra);
  }
  for (const c of cells.values()) for (const b of BOOKS) finish(c[b]);

  const rows = fillPeriods(q.from, q.to, q.granularity, cells, () => ({ shop: zero(), telecom: zero() })).map(({ period, shop, telecom }) => {
    const all = zero();
    addInto(all, shop); addInto(all, telecom);
    return { period, byBook: { shop, telecom }, ...all };
  });
  const totals = zero();
  const totalsByBook: Record<StockBook, SalesFigures> = { shop: zero(), telecom: zero() };
  for (const r of rows) { addInto(totals, r); for (const b of BOOKS) addInto(totalsByBook[b], r.byBook[b]); }

  const topProducts = productProfitability(conn, { from: q.from, to: q.to, ...(q.book !== undefined ? { book: q.book } : {}) }).rows.slice(0, q.topN ?? 10);

  const figCols = [
    { key: 'salesCount', label: 'Sales', kind: 'int' }, { key: 'salesRevenueCents', label: 'Sales revenue', kind: 'money' },
    { key: 'returnCount', label: 'Returns', kind: 'int' }, { key: 'returnsCents', label: 'Returned', kind: 'money' },
    { key: 'revenueCents', label: 'Revenue (net)', kind: 'money' }, { key: 'costAutoCents', label: 'Cost: automatic', kind: 'money' },
    { key: 'costExtraCents', label: 'Cost: extra', kind: 'money' }, { key: 'costCents', label: 'Cost', kind: 'money' },
    { key: 'grossProfitCents', label: 'Gross profit', kind: 'money' },
  ] as const satisfies ReportTable['columns'];
  const figs = numericOnly;
  const table: ReportTable = {
    title: 'Sales',
    columns: [{ key: 'period', label: 'Period', kind: 'text' }, ...figCols],
    rows: rows.map((r) => ({ period: r.period.label, ...figs(r) })),
    totals: { period: 'Total', ...figs(totals) },
    notes: [
      'Revenue is net of returns dated in the period. Cost = automatic cost + extra cost. Voided sales are not counted.',
      `Gross margin over the range: ${marginBp(totals.grossProfitCents, totals.revenueCents) === null ? 'n/a' : `${(marginBp(totals.grossProfitCents, totals.revenueCents)! / 100).toFixed(2)} %`}.`,
    ],
  };
  const extraTables: ReportTable[] = [
    { title: 'Sales by book', columns: [{ key: 'book', label: 'Book', kind: 'text' }, ...figCols], rows: BOOKS.map((b) => ({ book: b, ...figs(totalsByBook[b]) })), totals: { book: 'Total', ...figs(totals) } },
    {
      title: 'Top products',
      columns: [{ key: 'name', label: 'Product', kind: 'text' }, { key: 'book', label: 'Book', kind: 'text' }, { key: 'netQty', label: 'Net units', kind: 'int' },
        { key: 'revenueCents', label: 'Revenue', kind: 'money' }, { key: 'costCents', label: 'Cost', kind: 'money' }, { key: 'grossProfitCents', label: 'Gross profit', kind: 'money' },
        { key: 'marginBp', label: 'Margin', kind: 'percent' }],
      rows: topProducts.map((p) => ({ name: p.productName, book: p.book, netQty: p.netQty, revenueCents: p.revenueCents, costCents: p.costCents, grossProfitCents: p.grossProfitCents, marginBp: p.marginBp })),
    },
  ];
  return {
    from: q.from, to: q.to, granularity: q.granularity, rows,
    totals: { ...totals, marginBp: marginBp(totals.grossProfitCents, totals.revenueCents) }, totalsByBook, topProducts, table, extraTables, warnings: [],
  };
}
