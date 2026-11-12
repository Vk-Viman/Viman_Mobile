/**
 * services/reports/drawings-report.ts - Owner drawings (cash and goods) by book and period, with capital and transfers as memo lines.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only.
 *
 * Rules protected (BUSINESS_RULES section 9, section 1 "below the line"):
 *  - Cash drawings are money taken from a chosen book; goods drawings (personal use) are stock taken at average cost
 *    and recorded at that cost. NEITHER is a P&L item - this report never feeds profit.
 *  - Capital entries (`kind = 'capital'`; opening balances are not capital and are left out) and cash transfers between
 *    books are shown as separate MEMO lines, never mixed into the drawings totals.
 *  - Only `status = 'posted'` records count (R1); each row uses only records dated inside its period (R7).
 *  - Ice Cream drawings name a fund (section 10.2); the `byFund` block splits them by fund.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Granularity, ReportTable } from '../../lib/report-table.ts';
import { addInto, fillPeriods, num, numericOnly, periodKeySql } from './ops-common.ts';
import type { Book, ReportWarning, SqlRow } from './ops-common.ts';

/** Request: dates, granularity and an optional book (limits drawings and capital; transfers match either side). */
export interface DrawingsQuery { from: string; to: string; granularity: Granularity; book?: Book }

/** Figures of one period (cents). */
export interface DrawingFigures {
  cashShopCents: number; cashTelecomCents: number; cashIcecreamCents: number; goodsShopCents: number; goodsTelecomCents: number;
  cashCents: number; goodsCents: number; totalCents: number;
  /** Memo lines, never part of the totals above. */
  capitalCents: number; transfersCents: number; transferCount: number;
}

/** Report body. */
export interface DrawingsReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<{ period: { from: string; to: string; label: string } } & DrawingFigures>;
  totals: DrawingFigures;
  byBook: Array<{ book: Book; cashCents: number; goodsCents: number; totalCents: number; capitalCents: number }>;
  icecreamByFund: Array<{ fund: 'cost' | 'electricity' | 'profit'; cashCents: number }>;
  table: ReportTable; extraTables: ReportTable[]; warnings: ReportWarning[];
}

const zero = (): DrawingFigures => ({
  cashShopCents: 0, cashTelecomCents: 0, cashIcecreamCents: 0, goodsShopCents: 0, goodsTelecomCents: 0, cashCents: 0, goodsCents: 0, totalCents: 0,
  capitalCents: 0, transfersCents: 0, transferCount: 0,
});
const BOOKS: Book[] = ['shop', 'telecom', 'icecream'];

/** Drawings report for [from, to]. */
export function drawingsReport(conn: DatabaseSync, q: DrawingsQuery): DrawingsReport {
  const byLabel = new Map<string, DrawingFigures>();
  const at = (k: string): DrawingFigures => { let x = byLabel.get(k); if (!x) { x = zero(); byLabel.set(k, x); } return x; };
  const bookSql = (col: string) => (q.book !== undefined ? ` AND ${col} = ?` : '');
  const bookArg: SQLInputValue[] = q.book !== undefined ? [q.book] : [];

  for (const r of conn.prepare(
    `SELECT ${periodKeySql('business_date', q.granularity)} AS k, book, kind, SUM(amount_cents) AS t
       FROM owner_drawings WHERE status = 'posted' AND business_date BETWEEN ? AND ?${bookSql('book')} GROUP BY k, book, kind`,
  ).all(q.from, q.to, ...bookArg) as unknown as SqlRow[]) {
    const x = at(String(r.k));
    const t = num(r.t);
    const key = `${r.kind}${String(r.book).charAt(0).toUpperCase()}${String(r.book).slice(1)}Cents` as keyof DrawingFigures;
    if (key in x) (x[key] as number) += t; // cash/goods x shop/telecom/icecream (goods drawings never exist for icecream)
    if (r.kind === 'cash') x.cashCents += t; else x.goodsCents += t;
    x.totalCents += t;
  }
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('business_date', q.granularity)} AS k, SUM(amount_cents) AS t
       FROM capital_entries WHERE status = 'posted' AND kind = 'capital' AND business_date BETWEEN ? AND ?${bookSql('book')} GROUP BY k`,
  ).all(q.from, q.to, ...bookArg) as unknown as SqlRow[]) at(String(r.k)).capitalCents = num(r.t);
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('business_date', q.granularity)} AS k, COUNT(*) AS n, SUM(amount_cents) AS t
       FROM cash_transfers WHERE status = 'posted' AND business_date BETWEEN ? AND ?${q.book !== undefined ? ' AND (from_book = ? OR to_book = ?)' : ''} GROUP BY k`,
  ).all(q.from, q.to, ...(q.book !== undefined ? [q.book, q.book] : [])) as unknown as SqlRow[]) {
    const x = at(String(r.k)); x.transferCount = num(r.n); x.transfersCents = num(r.t);
  }

  const rows = fillPeriods(q.from, q.to, q.granularity, byLabel, zero);
  const totals = zero();
  for (const r of rows) addInto(totals, r);

  const bookRows = new Map<Book, { book: Book; cashCents: number; goodsCents: number; totalCents: number; capitalCents: number }>(
    BOOKS.map((b) => [b, { book: b, cashCents: 0, goodsCents: 0, totalCents: 0, capitalCents: 0 }]));
  for (const r of conn.prepare(
    `SELECT book, kind, SUM(amount_cents) AS t FROM owner_drawings WHERE status = 'posted' AND business_date BETWEEN ? AND ?${bookSql('book')} GROUP BY book, kind`,
  ).all(q.from, q.to, ...bookArg) as unknown as SqlRow[]) {
    const b = bookRows.get(r.book as Book)!;
    if (r.kind === 'cash') b.cashCents += num(r.t); else b.goodsCents += num(r.t);
    b.totalCents += num(r.t);
  }
  for (const r of conn.prepare(
    `SELECT book, SUM(amount_cents) AS t FROM capital_entries WHERE status = 'posted' AND kind = 'capital' AND business_date BETWEEN ? AND ?${bookSql('book')} GROUP BY book`,
  ).all(q.from, q.to, ...bookArg) as unknown as SqlRow[]) bookRows.get(r.book as Book)!.capitalCents = num(r.t);
  const byBook = [...bookRows.values()].filter((b) => q.book === undefined || b.book === q.book);
  const icecreamByFund = (conn.prepare(
    `SELECT fund, SUM(amount_cents) AS t FROM owner_drawings WHERE status = 'posted' AND book = 'icecream' AND business_date BETWEEN ? AND ? GROUP BY fund ORDER BY fund`,
  ).all(q.from, q.to) as unknown as SqlRow[]).map((r) => ({ fund: r.fund as 'cost' | 'electricity' | 'profit', cashCents: num(r.t) }));

  const m = (key: string, label: string) => ({ key, label, kind: 'money' as const });
  const table: ReportTable = {
    title: 'Owner drawings',
    columns: [
      { key: 'period', label: 'Period', kind: 'text' }, m('cashShopCents', 'Cash: Shop'), m('cashTelecomCents', 'Cash: Telecom'), m('cashIcecreamCents', 'Cash: Ice Cream'),
      m('goodsShopCents', 'Goods: Shop'), m('goodsTelecomCents', 'Goods: Telecom'), m('cashCents', 'Cash total'), m('goodsCents', 'Goods total'), m('totalCents', 'Total drawings'),
      m('capitalCents', 'Memo: capital in'), m('transfersCents', 'Memo: transfers'),
    ],
    rows: rows.map((r) => ({ period: r.period.label, ...numericOnly(r) })),
    totals: { period: 'Total', ...numericOnly(totals) },
    notes: [
      'Drawings and capital are not part of profit. Goods drawings are stock taken for personal use, valued at average cost.',
      'Memo lines (capital in, transfers between books) are shown for reference and are not added to the drawings totals. Opening balances are not capital.',
    ],
  };
  const extraTables: ReportTable[] = [{
    title: 'Drawings by book',
    columns: [{ key: 'book', label: 'Book', kind: 'text' }, m('cashCents', 'Cash'), m('goodsCents', 'Goods'), m('totalCents', 'Total'), m('capitalCents', 'Memo: capital in')],
    rows: byBook.map((b) => ({ ...b })),
  }];
  return { from: q.from, to: q.to, granularity: q.granularity, rows, totals, byBook, icecreamByFund, table, extraTables, warnings: [] };
}
