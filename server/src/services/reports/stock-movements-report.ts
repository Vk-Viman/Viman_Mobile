/**
 * services/reports/stock-movements-report.ts - Stock movements report: the inventory ledger with filters and paging.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only.
 *
 * Rules protected: section 3 (every stock change is exactly one movement row; voids appear as their own negated
 * reversal rows, C6, so the ledger is shown exactly as it is) and R7 (the date filter is the movement's BUSINESS
 * date; the list is ordered by business date, then by posting order). Nothing is netted or hidden: this is the audit view,
 * not a P&L figure, so reversal rows are listed and the totals include them (a voided sale nets to zero).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ReportTable } from '../../lib/report-table.ts';
import { num } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';

/** Every movement type (same list as the database CHECK). */
export const MOVEMENT_REPORT_TYPES = [
  'opening', 'purchase', 'purchase_return', 'purchase_void', 'sale', 'sale_return', 'sale_void',
  'personal_use', 'loss', 'stocktake_gain', 'stocktake_loss', 'adjustment',
] as const;
/** One movement type. */
export type MovementReportType = typeof MOVEMENT_REPORT_TYPES[number];

/** Filters and paging. `from`/`to` are optional business dates (inclusive). */
export interface MovementsQuery {
  from?: string; to?: string; productId?: number; type?: MovementReportType; book?: StockBook; limit: number; offset: number;
}

/** One ledger row with its product's name and book. */
export interface MovementReportRow {
  id: number; businessDate: string; postedAt: string; productId: number; productName: string; productCode: string | null;
  book: StockBook; type: MovementReportType; qtyDelta: number; valueDeltaCents: number; unitCostCents: number | null;
  refTable: string | null; refId: number | null; reason: string;
}

/** Report body. `totals` and `byType` cover ALL matching rows, not just the page. */
export interface MovementsReport {
  from: string | null; to: string | null; limit: number; offset: number; total: number;
  rows: MovementReportRow[];
  totals: { count: number; qtyDelta: number; valueDeltaCents: number };
  byType: Array<{ type: MovementReportType; count: number; qtyDelta: number; valueDeltaCents: number }>;
  table: ReportTable;
  warnings: ReportWarning[];
}

/** Largest number of rows an Excel export carries (the screen pages; the workbook is one sheet). */
export const MOVEMENTS_EXPORT_LIMIT = 50000;

/** Movement history, newest business date first, with filters, paging and totals over the whole filter. */
export function stockMovementsReport(conn: DatabaseSync, q: MovementsQuery): MovementsReport {
  const where: string[] = ['1 = 1'];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('m.business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('m.business_date <= ?'); params.push(q.to); }
  if (q.productId !== undefined) { where.push('m.product_id = ?'); params.push(q.productId); }
  if (q.type !== undefined) { where.push('m.type = ?'); params.push(q.type); }
  if (q.book !== undefined) { where.push('p.book = ?'); params.push(q.book); }
  const w = where.join(' AND ');
  const from = `FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE ${w}`;

  const byType = (conn.prepare(
    `SELECT m.type AS type, COUNT(*) AS n, SUM(m.qty_delta) AS qty, SUM(m.value_delta_cents) AS value ${from} GROUP BY m.type ORDER BY m.type`,
  ).all(...params) as unknown as SqlRow[]).map((r) => ({
    type: r.type as MovementReportType, count: num(r.n), qtyDelta: num(r.qty), valueDeltaCents: num(r.value),
  }));
  const totals = byType.reduce((t, r) => ({ count: t.count + r.count, qtyDelta: t.qtyDelta + r.qtyDelta, valueDeltaCents: t.valueDeltaCents + r.valueDeltaCents }),
    { count: 0, qtyDelta: 0, valueDeltaCents: 0 });

  const rows = (conn.prepare(
    `SELECT m.id, m.business_date, m.posted_at, m.product_id, p.name AS product_name, p.code AS product_code, p.book, m.type,
            m.qty_delta, m.value_delta_cents, m.unit_cost_cents, m.ref_table, m.ref_id, m.reason
       ${from} ORDER BY m.business_date DESC, m.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, q.limit, q.offset) as unknown as SqlRow[]).map((r): MovementReportRow => ({
    id: num(r.id), businessDate: String(r.business_date), postedAt: String(r.posted_at), productId: num(r.product_id),
    productName: String(r.product_name), productCode: (r.product_code as string | null) ?? null, book: r.book as StockBook,
    type: r.type as MovementReportType, qtyDelta: num(r.qty_delta), valueDeltaCents: num(r.value_delta_cents),
    unitCostCents: r.unit_cost_cents === null ? null : num(r.unit_cost_cents),
    refTable: (r.ref_table as string | null) ?? null, refId: r.ref_id === null ? null : num(r.ref_id), reason: String(r.reason),
  }));

  const table: ReportTable = {
    title: 'Stock movements',
    columns: [
      { key: 'date', label: 'Business date', kind: 'date' }, { key: 'product', label: 'Product', kind: 'text' },
      { key: 'book', label: 'Book', kind: 'text' }, { key: 'type', label: 'Type', kind: 'text' },
      { key: 'qty', label: 'Quantity', kind: 'int' }, { key: 'value', label: 'Value', kind: 'money' },
      { key: 'reason', label: 'Reason', kind: 'text' },
    ],
    rows: rows.map((r) => ({
      date: r.businessDate, product: r.productName, book: r.book, type: r.type, qty: r.qtyDelta, value: r.valueDeltaCents, reason: r.reason,
    })),
    totals: { date: null, product: 'Total of all matching movements', book: null, type: null, qty: totals.qtyDelta, value: totals.valueDeltaCents, reason: null },
    notes: ['Reversal rows of voided records are listed too, so a voided record nets to zero here.'],
  };
  const warnings: ReportWarning[] = [];
  if (q.offset + rows.length < totals.count && q.limit >= MOVEMENTS_EXPORT_LIMIT) {
    warnings.push({ code: 'EXPORT_TRUNCATED', message: `Only the first ${MOVEMENTS_EXPORT_LIMIT} movements are listed. Narrow the dates.` });
  }
  return { from: q.from ?? null, to: q.to ?? null, limit: q.limit, offset: q.offset, total: totals.count, rows, totals, byType, table, warnings };
}
