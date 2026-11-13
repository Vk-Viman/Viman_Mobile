/**
 * services/reports/backdated-report.ts - Backdated entries: records whose business date is earlier than the day they were saved.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only; it writes no audit rows.
 *
 * Rules protected (BUSINESS_RULES section 12, R-FD):
 *  - An entry is BACKDATED when its business date is earlier than the posting date in Asia/Colombo. Both values come from
 *    the record itself (`business_date` and `posted_at`, which the server sets and nobody can edit): the Colombo posting
 *    date is `date(posted_at, '+330 minutes')` (UTC+5:30, no daylight saving, the same expression the database triggers use),
 *    so an entry saved at 00:30 Colombo time on the 11th (19:00 UTC on the 10th) and dated the 10th IS backdated.
 *  - `from`/`to` are BUSINESS dates (every report follows the business date, section 10.6). The list is a trace, so voided
 *    records are listed too, marked by `status`; nothing is hidden.
 *  - Each line links its audit entry: the first audit row of that record (create / complete / close / replace), found by
 *    entity and record id. Audit rows are never read for the definition itself, so older records without a flag still show.
 *  - One record type per source table (the audit entity name is the type). Amount = the record's own money figure
 *    (sale total, refund, cost, signed cash difference ...). Stocktakes are listed once completed (their posting time is
 *    `completed_at`); drafts post nothing. Opening-stock batches have no single book (`book` is null) and are left out when a book is chosen.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { todayBusinessDate } from '../../lib/dates.ts';
import { daysInRange } from '../../lib/report-table.ts';
import type { ReportTable } from '../../lib/report-table.ts';
import { num } from './ops-common.ts';
import type { Book, ReportWarning, SqlRow } from './ops-common.ts';

/** Request: business-date range, optional book, paging. */
export interface BackdatedQuery { from: string; to: string; book?: Book; limit: number; offset: number }

/** One backdated record. */
export interface BackdatedRow {
  recordType: string; recordLabel: string; recordId: number; amountCents: number; book: Book | null; status: string;
  businessDate: string; postedAt: string; postedDate: string; daysBackdated: number; auditId: number | null;
}

/** Report body. */
export interface BackdatedReport {
  from: string; to: string; limit: number; offset: number; total: number;
  rows: BackdatedRow[]; byType: Array<{ recordType: string; recordLabel: string; count: number }>;
  table: ReportTable; warnings: ReportWarning[];
}

interface Spec {
  type: string; label: string; from: string; date: string; posted: string; id: string; amount: string; book: string; status: string;
  /** Extra condition (e.g. only completed stocktakes). */
  where?: string;
  /** Book filter SQL; default `<book> = ?`. */
  bookFilter?: { sql: string; args: number };
}

const specs: Spec[] = [
  { type: 'sale', label: 'Sale', from: 'sales t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.total_cents', book: 't.book', status: 't.status' },
  { type: 'sale_return', label: 'Sales return', from: 'sales_returns t JOIN sales o ON o.id = t.sale_id', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.refund_cents', book: 'o.book', status: 't.status' },
  { type: 'purchase', label: 'Purchase', from: 'purchases t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.total_cents', book: 't.book', status: 't.status' },
  { type: 'purchase_return', label: 'Purchase return', from: 'purchase_returns t JOIN purchases o ON o.id = t.purchase_id', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.refund_cents', book: 'o.book', status: "'posted'" },
  { type: 'stock_loss', label: 'Stock loss', from: 'stock_losses t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.cost_cents', book: 't.book', status: 't.status' },
  { type: 'drawing', label: 'Owner drawing', from: 'owner_drawings t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: 't.book', status: 't.status' },
  { type: 'capital_entry', label: 'Capital / opening balance', from: 'capital_entries t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: 't.book', status: 't.status' },
  { type: 'cash_transfer', label: 'Cash transfer', from: 'cash_transfers t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: 't.from_book', status: 't.status',
    bookFilter: { sql: '(t.from_book = ? OR t.to_book = ?)', args: 2 } },
  { type: 'expense', label: 'Expense', from: 'expenses t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: 't.book', status: 't.status' },
  { type: 'cash_count', label: 'Cash count', from: 'cash_counts t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.difference_cents', book: 't.book', status: 't.status' },
  { type: 'daily_closing', label: 'Daily closing', from: 'daily_closings t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.expected_cents', book: 't.book', status: "'posted'" },
  { type: 'print_sale', label: 'Print sale', from: 'print_sales t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.revenue_cents', book: "'shop'", status: 't.status' },
  { type: 'printing_supply', label: 'Printing supplies', from: 'printing_supplies t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: "'shop'", status: 't.status' },
  { type: 'reload_sale', label: 'Reload sale', from: 'reload_sales t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.sales_cents', book: "'telecom'", status: 't.status' },
  { type: 'ezcash_sale', label: 'EZCash sale', from: 'ezcash_sales t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.bill_total_cents', book: "'telecom'", status: 't.status' },
  { type: 'telecom_topup', label: 'Telecom top-up', from: 'telecom_topups t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: "'telecom'", status: 't.status' },
  { type: 'icecream_day', label: 'Ice Cream day', from: 'icecream_days t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.sales_cents', book: "'icecream'", status: 't.status' },
  { type: 'icecream_payment', label: 'Ice Cream payment', from: 'icecream_payments t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: "'icecream'", status: 't.status' },
  { type: 'icecream_fund_move', label: 'Ice Cream fund move', from: 'icecream_fund_moves t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.amount_cents', book: "'icecream'", status: 't.status' },
  { type: 'opening_stock_batch', label: 'Opening stock', from: 'opening_stock_batches t', date: 't.business_date', posted: 't.posted_at', id: 't.id', amount: 't.total_value_cents', book: 'NULL', status: 't.status' },
  { type: 'stocktake', label: 'Stocktake', from: 'stocktakes t', date: 't.business_date', posted: 't.completed_at', id: 't.id',
    amount: '(SELECT COALESCE(SUM(i.value_delta_cents), 0) FROM stocktake_items i WHERE i.stocktake_id = t.id)', book: 't.book', status: 't.status',
    where: "t.status <> 'draft' AND t.completed_at IS NOT NULL" },
];

/** Colombo posting date of a UTC timestamp, in SQL (same expression as the triggers; UTC+5:30, no daylight saving). */
const colomboDate = (posted: string): string => `date(${posted}, '+330 minutes')`;

function unionSql(q: BackdatedQuery): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (const s of specs) {
    const conds = [`${s.date} BETWEEN ? AND ?`, `${s.date} < ${colomboDate(s.posted)}`];
    params.push(q.from, q.to);
    if (s.where) conds.push(s.where);
    if (q.book !== undefined) {
      const bf = s.bookFilter ?? { sql: `${s.book} = ?`, args: 1 };
      conds.push(bf.sql);
      for (let i = 0; i < bf.args; i++) params.push(q.book);
    }
    parts.push(`SELECT '${s.type}' AS type, ${s.id} AS id, ${s.date} AS business_date, ${s.posted} AS posted_at, ${s.amount} AS amount, ${s.book} AS book, ${s.status} AS status FROM ${s.from} WHERE ${conds.join(' AND ')}`);
  }
  return { sql: parts.join(' UNION ALL '), params };
}

/** Backdated entries with their audit entry ids, newest posting first. */
export function backdatedReport(conn: DatabaseSync, q: BackdatedQuery): BackdatedReport {
  const { sql, params } = unionSql(q);
  const labels = new Map(specs.map((s) => [s.type, s.label]));
  const byType = (conn.prepare(`SELECT type, COUNT(*) AS n FROM (${sql}) GROUP BY type ORDER BY n DESC, type`).all(...params) as unknown as SqlRow[])
    .map((r) => ({ recordType: String(r.type), recordLabel: labels.get(String(r.type)) ?? String(r.type), count: num(r.n) }));
  const total = byType.reduce((n, r) => n + r.count, 0);

  const auditOf = conn.prepare(
    `SELECT MIN(id) AS id FROM audit_logs WHERE entity = ? AND entity_id = ? AND action IN ('create', 'complete', 'close', 'replace')`,
  );
  const rows = (conn.prepare(`SELECT * FROM (${sql}) ORDER BY posted_at DESC, type, id DESC LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset) as unknown as SqlRow[])
    .map((r): BackdatedRow => {
      const postedDate = todayBusinessDate(new Date(String(r.posted_at)));
      const a = auditOf.get(String(r.type), String(num(r.id))) as unknown as { id: number | bigint | null } | undefined;
      return {
        recordType: String(r.type), recordLabel: labels.get(String(r.type)) ?? String(r.type), recordId: num(r.id), amountCents: num(r.amount),
        book: (r.book as Book | null) ?? null, status: String(r.status), businessDate: String(r.business_date), postedAt: String(r.posted_at), postedDate,
        daysBackdated: daysInRange(String(r.business_date), postedDate) - 1, auditId: a?.id === null || a?.id === undefined ? null : Number(a.id),
      };
    });

  const table: ReportTable = {
    title: 'Backdated entries',
    columns: [
      { key: 'type', label: 'Record', kind: 'text' }, { key: 'id', label: 'No.', kind: 'int' }, { key: 'book', label: 'Book', kind: 'text' },
      { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'status', label: 'Status', kind: 'text' }, { key: 'businessDate', label: 'Business date', kind: 'date' },
      { key: 'postedAt', label: 'Saved at (UTC)', kind: 'text' }, { key: 'days', label: 'Days back', kind: 'int' }, { key: 'auditId', label: 'Audit entry', kind: 'int' },
    ],
    rows: rows.map((r) => ({
      type: r.recordLabel, id: r.recordId, book: r.book, amount: r.amountCents, status: r.status, businessDate: r.businessDate,
      postedAt: r.postedAt, days: r.daysBackdated, auditId: r.auditId,
    })),
    notes: [
      'Backdated = the business date is earlier than the day (Sri Lanka time) the entry was saved. Dates in this list are business dates.',
      `${total} backdated entr${total === 1 ? 'y' : 'ies'} in the range.`,
    ],
  };
  return { from: q.from, to: q.to, limit: q.limit, offset: q.offset, total, rows, byType, table, warnings: [] };
}
