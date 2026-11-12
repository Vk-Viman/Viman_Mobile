/**
 * lib/report-table.ts - the one shared shape every report returns, plus period splitting and the Excel writer.
 *
 * Layer: library (no database access). Phase 11 reports build a `ReportTable` from figures they already
 * calculated; this file turns it into JSON for the screen and into an .xlsx workbook for download, so no report
 * has its own export code.
 *
 * Rules protected here:
 *  - Money stays integer cents in JSON; the workbook shows rupees with two decimals (display only).
 *  - Period rows are calendar days or calendar months clipped to the requested range, so the rows of a report
 *    add up exactly to its total (BUSINESS_RULES 10.6 period rule: every row uses only movements dated inside it).
 *  - All dates are business dates (Asia/Colombo), never rejected for being in the future (queries are not writes).
 */
import ExcelJS from 'exceljs';

/** Longest period a report may cover, in days (keeps a day-by-day report to a sane size). */
export const MAX_REPORT_DAYS = 3660;

/** How a column's values are shown. `money` = integer cents, `percent` = basis points, `int` = plain count. */
export type ColumnKind = 'text' | 'money' | 'int' | 'percent' | 'date';

/** One column of a report table. */
export interface ReportColumn { key: string; label: string; kind: ColumnKind }

/** One cell value: text, a number (cents / count / basis points) or empty. */
export type ReportCell = string | number | null;

/** A report as a table: ordered columns, rows, an optional totals row and plain-language notes/warnings. */
export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportCell>>;
  totals?: Record<string, ReportCell>;
  notes?: string[];
}

/** Row granularity of a period report. */
export type Granularity = 'day' | 'month';

/** One report period: inclusive business dates and a label for the row. */
export interface Period { from: string; to: string; label: string }

function parseUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function fmtUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `from` to `to` inclusive (both ISO dates, from <= to). */
export function daysInRange(from: string, to: string): number {
  return Math.round((parseUtc(to) - parseUtc(from)) / 86400000) + 1;
}

/**
 * Splits [from, to] into day rows or calendar-month rows (a month row is clipped to the range, so a report
 * from the 10th to the 20th has one row 10th..20th). The rows are contiguous and never overlap.
 * @throws Error when from > to (callers validate first and answer 400).
 */
export function listPeriods(from: string, to: string, granularity: Granularity): Period[] {
  if (from > to) throw new Error('from must not be after to');
  const out: Period[] = [];
  if (granularity === 'day') {
    for (let t = parseUtc(from); t <= parseUtc(to); t += 86400000) { const d = fmtUtc(t); out.push({ from: d, to: d, label: d }); }
    return out;
  }
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const lastDay = fmtUtc(Date.UTC(y!, m!, 0)); // day 0 of the next month = last day of this month
    const end = lastDay < to ? lastDay : to;
    out.push({ from: start, to: end, label: start.slice(0, 7) });
    start = fmtUtc(parseUtc(end) + 86400000);
  }
  return out;
}

const MONEY_FORMAT = '#,##0.00;[Red]-#,##0.00';

/** Converts a cell for the workbook: cents become rupees, basis points become a percentage number. */
function excelValue(kind: ColumnKind, v: ReportCell): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (kind === 'money') return v / 100;
  if (kind === 'percent') return v / 100;
  return v;
}

/** Builds an .xlsx workbook with one worksheet per table (sheet names are cut to Excel's 31-character limit). */
export async function reportTablesToXlsx(tables: ReportTable[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const t of tables) {
    let name = t.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report';
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${n++}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    ws.columns = t.columns.map((c) => ({ header: c.label, key: c.key, width: c.kind === 'text' ? 34 : 16 }));
    ws.getRow(1).font = { bold: true };
    const add = (row: Record<string, ReportCell>, bold: boolean) => {
      const r = ws.addRow(t.columns.map((c) => excelValue(c.kind, row[c.key] ?? null)));
      t.columns.forEach((c, i) => { if (c.kind === 'money') r.getCell(i + 1).numFmt = MONEY_FORMAT; });
      if (bold) r.font = { bold: true };
    };
    for (const row of t.rows) add(row, false);
    if (t.totals) add(t.totals, true);
    (t.notes ?? []).forEach((note, i) => { ws.getCell(t.rows.length + (t.totals ? 4 : 3) + i, 1).value = note; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
