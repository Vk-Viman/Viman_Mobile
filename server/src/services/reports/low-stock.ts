/**
 * services/reports/low-stock.ts - Products at or below their minimum stock level ("reorder level").
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only, live (today's stock cache).
 *
 * Rule protected: the catalogue's own `lowStock` flag (API_CONTRACTS Phase 2, catalog.service.ts) =
 * `kind = 'stock' AND active AND reorderLevel > 0 AND qtyOnHand <= reorderLevel`. This report uses exactly that
 * definition so the two screens can never disagree. Boundary decision: a quantity EQUAL to the reorder level IS low
 * stock ("at or below"). A reorder level of 0 means "no minimum set", so such products are never listed (otherwise
 * every never-stocked catalogue item would flood the list). Inactive products are left out unless asked for.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mulDivRound } from '../../lib/money.ts';
import type { ReportTable } from '../../lib/report-table.ts';
import { num } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';

/** Optional filters. */
export interface LowStockQuery { book?: StockBook; categoryId?: number; includeInactive?: boolean }

/** One product below its minimum. `shortfall` = reorderLevel - qtyOnHand (0 when exactly at the minimum). */
export interface LowStockRow {
  productId: number; code: string | null; name: string; categoryName: string; book: StockBook; active: boolean;
  qtyOnHand: number; reorderLevel: number; shortfall: number; outOfStock: boolean; stockValueCents: number; avgUnitCostCents: number | null;
}

/** Report body. */
export interface LowStockReport {
  rows: LowStockRow[];
  totals: { products: number; outOfStock: number; stockValueCents: number };
  table: ReportTable;
  warnings: ReportWarning[];
}

/** Lists products whose quantity on hand is at or below their reorder level, most urgent (largest shortfall) first. */
export function lowStockReport(conn: DatabaseSync, q: LowStockQuery): LowStockReport {
  const where = ["p.kind = 'stock'", 'p.reorder_level > 0', 'p.qty_on_hand <= p.reorder_level'];
  const params: SQLInputValue[] = [];
  if (q.includeInactive !== true) where.push('p.active = 1');
  if (q.book !== undefined) { where.push('p.book = ?'); params.push(q.book); }
  if (q.categoryId !== undefined) { where.push('p.category_id = ?'); params.push(q.categoryId); }
  const rows = (conn.prepare(
    `SELECT p.id, p.code, p.name, c.name AS cat, p.book, p.active, p.qty_on_hand, p.reorder_level, p.stock_value_cents
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')} ORDER BY (p.reorder_level - p.qty_on_hand) DESC, p.name`,
  ).all(...params) as unknown as SqlRow[]).map((r): LowStockRow => {
    const qty = num(r.qty_on_hand);
    const value = num(r.stock_value_cents);
    return {
      productId: num(r.id), code: (r.code as string | null) ?? null, name: String(r.name), categoryName: String(r.cat), book: r.book as StockBook,
      active: num(r.active) === 1, qtyOnHand: qty, reorderLevel: num(r.reorder_level), shortfall: num(r.reorder_level) - qty, outOfStock: qty === 0,
      stockValueCents: value, avgUnitCostCents: qty > 0 ? mulDivRound(value, 1, qty) : null,
    };
  });
  const totals = {
    products: rows.length, outOfStock: rows.filter((r) => r.outOfStock).length, stockValueCents: rows.reduce((s, r) => s + r.stockValueCents, 0),
  };
  const table: ReportTable = {
    title: 'Low stock',
    columns: [
      { key: 'name', label: 'Product', kind: 'text' }, { key: 'category', label: 'Category', kind: 'text' }, { key: 'book', label: 'Book', kind: 'text' },
      { key: 'qty', label: 'On hand', kind: 'int' }, { key: 'reorder', label: 'Minimum', kind: 'int' }, { key: 'shortfall', label: 'Short by', kind: 'int' },
      { key: 'value', label: 'Stock value', kind: 'money' },
    ],
    rows: rows.map((r) => ({ name: r.name, category: r.categoryName, book: r.book, qty: r.qtyOnHand, reorder: r.reorderLevel, shortfall: r.shortfall, value: r.stockValueCents })),
    totals: { name: 'Total', category: null, book: null, qty: null, reorder: null, shortfall: null, value: totals.stockValueCents },
    notes: ['A product is listed when the quantity on hand is equal to or below its minimum. Products with no minimum set are not listed.'],
  };
  return { rows, totals, table, warnings: [] };
}
