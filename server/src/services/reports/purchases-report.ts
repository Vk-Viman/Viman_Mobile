/**
 * services/reports/purchases-report.ts - Purchases per period, per supplier and per product, net of purchase returns.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only.
 *
 * Rules protected:
 *  - Purchases are fully paid in cash and are stock, never P&L (section 3, R11); this report is an activity view.
 *  - Only `status = 'posted'` purchases count (R1). A purchase with returns cannot be voided, so no return of a void
 *    purchase exists.
 *  - Purchase returns count in the period of the RETURN's business date (R7), whatever the purchase's date; the
 *    supplier/product of a return is that of the purchase it returns.
 *  - Net = purchases - returns. Grouped SQL: periods, suppliers and products are each one query per side.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Granularity, ReportTable } from '../../lib/report-table.ts';
import { addInto, fillPeriods, num, periodKeySql } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';

/** Request: dates, granularity and optional filters. */
export interface PurchasesQuery { from: string; to: string; granularity: Granularity; book?: StockBook; supplierId?: number }

/** Figures of a period row (cents). */
export interface PurchaseFigures { purchaseCount: number; purchasesCents: number; returnCount: number; returnsCents: number; netCents: number }
/** A supplier line over the whole range. `supplierId` is null for purchases without a supplier. */
export interface SupplierLine extends PurchaseFigures { supplierId: number | null; supplierName: string }
/** A product line over the whole range (units and value). */
export interface ProductLine {
  productId: number; productName: string; book: StockBook;
  unitsBought: number; boughtCents: number; unitsReturned: number; returnedCents: number; netUnits: number; netCents: number;
}

/** Report body. */
export interface PurchasesReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<{ period: { from: string; to: string; label: string } } & PurchaseFigures>;
  totals: PurchaseFigures;
  bySupplier: SupplierLine[];
  byProduct: ProductLine[];
  table: ReportTable; extraTables: ReportTable[]; warnings: ReportWarning[];
}

const zero = (): PurchaseFigures => ({ purchaseCount: 0, purchasesCents: 0, returnCount: 0, returnsCents: 0, netCents: 0 });
const NO_SUPPLIER = '(no supplier)';

/** Purchases report for [from, to]. */
export function purchasesReport(conn: DatabaseSync, q: PurchasesQuery): PurchasesReport {
  const f: string[] = [];
  const fp: SQLInputValue[] = [];
  if (q.book !== undefined) { f.push('pu.book = ?'); fp.push(q.book); }
  if (q.supplierId !== undefined) { f.push('pu.supplier_id = ?'); fp.push(q.supplierId); }
  const filt = f.length > 0 ? ` AND ${f.join(' AND ')}` : '';
  const args: SQLInputValue[] = [q.from, q.to, ...fp];

  // --- period rows
  const byLabel = new Map<string, PurchaseFigures>();
  const at = (k: string): PurchaseFigures => { let x = byLabel.get(k); if (!x) { x = zero(); byLabel.set(k, x); } return x; };
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('pu.business_date', q.granularity)} AS k, COUNT(*) AS n, SUM(pu.total_cents) AS t
       FROM purchases pu WHERE pu.status = 'posted' AND pu.business_date BETWEEN ? AND ?${filt} GROUP BY k`,
  ).all(...args) as unknown as SqlRow[]) { const x = at(String(r.k)); x.purchaseCount = num(r.n); x.purchasesCents = num(r.t); }
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('pr.business_date', q.granularity)} AS k, COUNT(*) AS n, SUM(pr.refund_cents) AS t
       FROM purchase_returns pr JOIN purchases pu ON pu.id = pr.purchase_id
      WHERE pu.status = 'posted' AND pr.business_date BETWEEN ? AND ?${filt} GROUP BY k`,
  ).all(...args) as unknown as SqlRow[]) { const x = at(String(r.k)); x.returnCount = num(r.n); x.returnsCents = num(r.t); }
  for (const x of byLabel.values()) x.netCents = x.purchasesCents - x.returnsCents;
  const rows = fillPeriods(q.from, q.to, q.granularity, byLabel, zero);
  const totals = zero();
  for (const r of rows) addInto(totals, r);

  // --- suppliers
  const sup = new Map<number | null, SupplierLine>();
  const line = (id: number | null, name: string): SupplierLine => {
    let s = sup.get(id);
    if (!s) { s = { supplierId: id, supplierName: name, ...zero() }; sup.set(id, s); }
    return s;
  };
  for (const r of conn.prepare(
    `SELECT pu.supplier_id AS sid, COALESCE(su.name, '${NO_SUPPLIER}') AS name, COUNT(*) AS n, SUM(pu.total_cents) AS t
       FROM purchases pu LEFT JOIN suppliers su ON su.id = pu.supplier_id
      WHERE pu.status = 'posted' AND pu.business_date BETWEEN ? AND ?${filt} GROUP BY pu.supplier_id`,
  ).all(...args) as unknown as SqlRow[]) { const s = line(r.sid === null ? null : num(r.sid), String(r.name)); s.purchaseCount = num(r.n); s.purchasesCents = num(r.t); }
  for (const r of conn.prepare(
    `SELECT pu.supplier_id AS sid, COALESCE(su.name, '${NO_SUPPLIER}') AS name, COUNT(*) AS n, SUM(pr.refund_cents) AS t
       FROM purchase_returns pr JOIN purchases pu ON pu.id = pr.purchase_id LEFT JOIN suppliers su ON su.id = pu.supplier_id
      WHERE pu.status = 'posted' AND pr.business_date BETWEEN ? AND ?${filt} GROUP BY pu.supplier_id`,
  ).all(...args) as unknown as SqlRow[]) { const s = line(r.sid === null ? null : num(r.sid), String(r.name)); s.returnCount = num(r.n); s.returnsCents = num(r.t); }
  const bySupplier = [...sup.values()];
  for (const s of bySupplier) s.netCents = s.purchasesCents - s.returnsCents;
  bySupplier.sort((a, b) => b.netCents - a.netCents || a.supplierName.localeCompare(b.supplierName));

  // --- products
  const prod = new Map<number, ProductLine>();
  const pl = (r: SqlRow): ProductLine => {
    const id = num(r.pid);
    let p = prod.get(id);
    if (!p) { p = { productId: id, productName: String(r.name), book: r.book as StockBook, unitsBought: 0, boughtCents: 0, unitsReturned: 0, returnedCents: 0, netUnits: 0, netCents: 0 }; prod.set(id, p); }
    return p;
  };
  for (const r of conn.prepare(
    `SELECT pi.product_id AS pid, p.name, p.book, SUM(pi.units) AS u, SUM(pi.line_total_cents) AS t
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN products p ON p.id = pi.product_id
      WHERE pu.status = 'posted' AND pu.business_date BETWEEN ? AND ?${filt} GROUP BY pi.product_id`,
  ).all(...args) as unknown as SqlRow[]) { const p = pl(r); p.unitsBought = num(r.u); p.boughtCents = num(r.t); }
  for (const r of conn.prepare(
    `SELECT pi.product_id AS pid, p.name, p.book, SUM(ri.units) AS u, SUM(ri.value_cents) AS t
       FROM purchase_return_items ri JOIN purchase_returns pr ON pr.id = ri.purchase_return_id
       JOIN purchase_items pi ON pi.id = ri.purchase_item_id JOIN purchases pu ON pu.id = pi.purchase_id JOIN products p ON p.id = pi.product_id
      WHERE pu.status = 'posted' AND pr.business_date BETWEEN ? AND ?${filt} GROUP BY pi.product_id`,
  ).all(...args) as unknown as SqlRow[]) { const p = pl(r); p.unitsReturned = num(r.u); p.returnedCents = num(r.t); }
  const byProduct = [...prod.values()];
  for (const p of byProduct) { p.netUnits = p.unitsBought - p.unitsReturned; p.netCents = p.boughtCents - p.returnedCents; }
  byProduct.sort((a, b) => b.netCents - a.netCents || a.productName.localeCompare(b.productName));

  const money = (key: string, label: string) => ({ key, label, kind: 'money' as const });
  const table: ReportTable = {
    title: 'Purchases',
    columns: [
      { key: 'period', label: 'Period', kind: 'text' }, { key: 'purchaseCount', label: 'Purchases', kind: 'int' }, money('purchasesCents', 'Bought'),
      { key: 'returnCount', label: 'Returns', kind: 'int' }, money('returnsCents', 'Returned'), money('netCents', 'Net purchases'),
    ],
    rows: rows.map((r) => ({ period: r.period.label, purchaseCount: r.purchaseCount, purchasesCents: r.purchasesCents, returnCount: r.returnCount, returnsCents: r.returnsCents, netCents: r.netCents })),
    totals: { period: 'Total', ...totals },
    notes: ['Voided purchases are not counted. A return is counted in the period of the return date. Purchases are stock, not an expense.'],
  };
  const extraTables: ReportTable[] = [
    {
      title: 'Purchases by supplier',
      columns: [{ key: 'name', label: 'Supplier', kind: 'text' }, { key: 'purchaseCount', label: 'Purchases', kind: 'int' }, money('purchasesCents', 'Bought'),
        { key: 'returnCount', label: 'Returns', kind: 'int' }, money('returnsCents', 'Returned'), money('netCents', 'Net purchases')],
      rows: bySupplier.map((s) => ({ name: s.supplierName, purchaseCount: s.purchaseCount, purchasesCents: s.purchasesCents, returnCount: s.returnCount, returnsCents: s.returnsCents, netCents: s.netCents })),
      totals: { name: 'Total', ...totals },
    },
    {
      title: 'Purchases by product',
      columns: [{ key: 'name', label: 'Product', kind: 'text' }, { key: 'book', label: 'Book', kind: 'text' }, { key: 'unitsBought', label: 'Units bought', kind: 'int' },
        money('boughtCents', 'Bought'), { key: 'unitsReturned', label: 'Units returned', kind: 'int' }, money('returnedCents', 'Returned'),
        { key: 'netUnits', label: 'Net units', kind: 'int' }, money('netCents', 'Net purchases')],
      rows: byProduct.map((p) => ({ name: p.productName, book: p.book, unitsBought: p.unitsBought, boughtCents: p.boughtCents, unitsReturned: p.unitsReturned, returnedCents: p.returnedCents, netUnits: p.netUnits, netCents: p.netCents })),
    },
  ];
  return { from: q.from, to: q.to, granularity: q.granularity, rows, totals, bySupplier, byProduct, table, extraTables, warnings: [] };
}
