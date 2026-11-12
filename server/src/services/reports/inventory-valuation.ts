/**
 * services/reports/inventory-valuation.ts - Inventory valuation report: stock on hand and its value, as of a date.
 *
 * Layer: report service, a pure function `(conn, query) => figures` (also called directly by the Phase 12 dashboard).
 * Read-only; no audit rows.
 *
 * Rules protected:
 *  - BUSINESS_RULES section 3: SUM(stock_movements) = the products cache. Figures here are ALWAYS the sum of the
 *    movements dated on or before `asOf` (business date, R7) - one grouped query, no per-product loop. For today
 *    (or any later date, R-FD: nothing can be dated later) that sum equals the stock cache, and the report says so
 *    in `reconciliation` so a mismatch would be visible instead of silently averaged away.
 *  - A past `asOf` can show a negative quantity only when records were backdated before the purchase that covers
 *    them; the report keeps the true sums and adds a `NEGATIVE_STOCK_AS_OF` warning rather than hiding it.
 *  - Average cost = value / quantity is display only (section 3).
 */
import type { DatabaseSync } from 'node:sqlite';
import { todayBusinessDate } from '../../lib/dates.ts';
import { mulDivRound } from '../../lib/money.ts';
import type { ReportTable } from '../../lib/report-table.ts';
import { num } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';

/** What the owner can ask for. `asOf` is a business date (any real date; a future one shows today's figures). */
export interface ValuationQuery {
  asOf: string; book?: StockBook; categoryId?: number; includeZero?: boolean; includeInactive?: boolean;
}

/** One product line. `avgUnitCostCents` is display only (null when nothing is on hand). */
export interface ValuationRow {
  productId: number; code: string | null; name: string; categoryId: number; categoryName: string; book: StockBook;
  active: boolean; qty: number; valueCents: number; avgUnitCostCents: number | null;
}

/** A subtotal for a book or a category. */
export interface ValuationGroup { qty: number; valueCents: number; products: number }

/** Result of the report; `table` is the shared table shape, `warnings` the plain-language notices. */
export interface ValuationReport {
  asOf: string;
  rows: ValuationRow[];
  byBook: Array<{ book: StockBook } & ValuationGroup>;
  byCategory: Array<{ categoryId: number; categoryName: string; book: StockBook } & ValuationGroup>;
  totals: ValuationGroup;
  /** Compares the movement sums with the products cache (only meaningful, and only checked, when asOf is today or later). */
  reconciliation: { asOfIsLive: boolean; cacheQty: number; cacheValueCents: number; matchesCache: boolean | null };
  table: ReportTable;
  warnings: ReportWarning[];
}

/**
 * Stock on hand and value per stock product, with subtotals per book and per category.
 *
 * @param q.includeZero     also list products with nothing on hand (default off)
 * @param q.includeInactive also list inactive products (default on, like `GET /inventory/valuation`)
 */
export function inventoryValuation(conn: DatabaseSync, q: ValuationQuery): ValuationReport {
  const where = ["p.kind = 'stock'"];
  const params: Array<string | number> = [q.asOf];
  if (q.book !== undefined) { where.push('p.book = ?'); params.push(q.book); }
  if (q.categoryId !== undefined) { where.push('p.category_id = ?'); params.push(q.categoryId); }
  if (q.includeInactive === false) where.push('p.active = 1');
  const raw = conn.prepare(
    `SELECT p.id, p.code, p.name, p.category_id, c.name AS category_name, p.book, p.active,
            p.qty_on_hand AS cache_qty, p.stock_value_cents AS cache_value,
            COALESCE(m.qty, 0) AS qty, COALESCE(m.value, 0) AS value
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN (SELECT product_id, SUM(qty_delta) AS qty, SUM(value_delta_cents) AS value
                    FROM stock_movements WHERE business_date <= ? GROUP BY product_id) m ON m.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY p.book, c.name, p.name`,
  ).all(...params) as unknown as SqlRow[];

  const live = q.asOf >= todayBusinessDate();
  const rows: ValuationRow[] = [];
  const byBook = new Map<StockBook, ValuationGroup>();
  const byCat = new Map<number, { categoryId: number; categoryName: string; book: StockBook } & ValuationGroup>();
  const totals: ValuationGroup = { qty: 0, valueCents: 0, products: 0 };
  let cacheQty = 0;
  let cacheValue = 0;
  let anomalies = 0;
  let allQty = 0; // movement sums over EVERY matching product, including the ones hidden for being empty
  let allValue = 0;
  for (const r of raw) {
    cacheQty += num(r.cache_qty);
    cacheValue += num(r.cache_value);
    const qty = num(r.qty);
    const valueCents = num(r.value);
    allQty += qty;
    allValue += valueCents;
    if (!q.includeZero && qty === 0 && valueCents === 0) continue;
    if (qty < 0 || valueCents < 0) anomalies++;
    const book = r.book as StockBook;
    rows.push({
      productId: num(r.id), code: (r.code as string | null) ?? null, name: String(r.name), categoryId: num(r.category_id),
      categoryName: String(r.category_name), book, active: num(r.active) === 1, qty, valueCents,
      avgUnitCostCents: qty > 0 ? mulDivRound(valueCents, 1, qty) : null,
    });
    const b = byBook.get(book) ?? { qty: 0, valueCents: 0, products: 0 };
    const c = byCat.get(num(r.category_id)) ?? { categoryId: num(r.category_id), categoryName: String(r.category_name), book, qty: 0, valueCents: 0, products: 0 };
    for (const g of [b, c, totals]) { g.qty += qty; g.valueCents += valueCents; g.products += 1; }
    byBook.set(book, b);
    byCat.set(num(r.category_id), c);
  }

  const warnings: ReportWarning[] = [];
  if (anomalies > 0) {
    warnings.push({
      code: 'NEGATIVE_STOCK_AS_OF',
      message: `${anomalies} product(s) show a negative quantity or value on ${q.asOf}: records dated that day or earlier were entered after the purchases that cover them (backdating).`,
    });
  }
  const matches = live ? cacheQty === allQty && cacheValue === allValue : null;
  const table: ReportTable = {
    title: 'Inventory valuation',
    columns: [
      { key: 'code', label: 'Code', kind: 'text' }, { key: 'name', label: 'Product', kind: 'text' },
      { key: 'category', label: 'Category', kind: 'text' }, { key: 'book', label: 'Book', kind: 'text' },
      { key: 'qty', label: 'Quantity', kind: 'int' }, { key: 'avg', label: 'Average cost', kind: 'money' },
      { key: 'value', label: 'Stock value', kind: 'money' },
    ],
    rows: rows.map((r) => ({
      code: r.code, name: r.name, category: r.categoryName, book: r.book, qty: r.qty, avg: r.avgUnitCostCents, value: r.valueCents,
    })),
    totals: { code: null, name: 'Total', category: null, book: null, qty: totals.qty, avg: null, value: totals.valueCents },
    notes: [`Stock as of ${q.asOf}, from the stock movements by business date. Average cost is value / quantity (display only).`],
  };
  return {
    asOf: q.asOf, rows,
    byBook: [...byBook.entries()].map(([book, g]) => ({ book, ...g })),
    byCategory: [...byCat.values()],
    totals,
    reconciliation: { asOfIsLive: live, cacheQty, cacheValueCents: cacheValue, matchesCache: matches },
    table, warnings,
  };
}
