/**
 * services/reports/transfers-report.ts - posted cash transfers between the books, with totals by direction (BUSINESS_RULES 8, 10.2, C9).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only).
 *
 * A transfer is a linked `transfer_out` + `transfer_in` pair with one `transfer_id`; it is cash moving between books and
 * never revenue, cost or profit (section 8). Only POSTED transfers are listed: a voided transfer (R1) is cancelled by its
 * reversal rows and shows nowhere here, so it changes nothing compared with never having been recorded. Rows follow the
 * business date of the transfer (R7). The Ice Cream side of a transfer names the fund it touched (10.2).
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import type { CashBook, IceFund } from '../../repositories/cash-entries.repo.ts';
import { periodIndex, wholePeriod } from './fin-common.ts';
import type { PeriodRow } from './fin-common.ts';
import type { PeriodQuery } from './pnl-shop.ts';

const BOOKS: readonly CashBook[] = ['shop', 'telecom', 'icecream'];
const BOOK_NAME: Record<CashBook, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };

/** Every direction (from -> to) with its key `"from>to"`, in a fixed order. */
export const DIRECTIONS: Array<{ key: string; from: CashBook; to: CashBook }> =
  BOOKS.flatMap((from) => BOOKS.filter((to) => to !== from).map((to) => ({ key: `${from}>${to}`, from, to })));

/** One posted transfer. */
export interface TransferItem {
  id: number; businessDate: string; fromBook: CashBook; toBook: CashBook; fromFund: IceFund | null; toFund: IceFund | null;
  amountCents: number; note: string;
}

/** Count and amount. */
export interface CountAmount { count: number; amountCents: number }

/** The figures of one transfers report row. */
export interface TransferFigures {
  count: number; totalCents: number;
  /** All six directions, zeros included, keyed `"from>to"`. */
  byDirection: Record<string, CountAmount>;
  /** Money out of / into each book by transfers in the period. */
  byBook: Record<CashBook, { outCents: number; inCents: number; netCents: number }>;
}

/** The full answer of `GET /reports/transfers`. */
export interface TransfersReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<TransferFigures>>; totals: TransferFigures; items: TransferItem[];
  table: ReportTable; itemsTable: ReportTable; warnings: never[];
}

function emptyFigures(): TransferFigures {
  return {
    count: 0, totalCents: 0, byDirection: Object.fromEntries(DIRECTIONS.map((d) => [d.key, { count: 0, amountCents: 0 }])),
    byBook: { shop: { outCents: 0, inCents: 0, netCents: 0 }, telecom: { outCents: 0, inCents: 0, netCents: 0 }, icecream: { outCents: 0, inCents: 0, netCents: 0 } },
  };
}

/** Adds one transfer into a figure record. */
function add(f: TransferFigures, t: TransferItem): void {
  f.count += 1; f.totalCents += t.amountCents;
  const d = f.byDirection[`${t.fromBook}>${t.toBook}`]!;
  d.count += 1; d.amountCents += t.amountCents;
  f.byBook[t.fromBook].outCents += t.amountCents; f.byBook[t.fromBook].netCents -= t.amountCents;
  f.byBook[t.toBook].inCents += t.amountCents; f.byBook[t.toBook].netCents += t.amountCents;
}

/** All posted transfers dated in `from..to`, oldest first (one query). */
export function listTransfers(conn: DatabaseSync, from: string, to: string): TransferItem[] {
  const rows = conn.prepare(
    `SELECT id, business_date, from_book, to_book, from_fund, to_fund, amount_cents, note FROM cash_transfers
      WHERE status = 'posted' AND business_date BETWEEN ? AND ? ORDER BY business_date, id`,
  ).all(from, to) as unknown as Array<{
    id: number | bigint; business_date: string; from_book: CashBook; to_book: CashBook; from_fund: IceFund | null;
    to_fund: IceFund | null; amount_cents: number | bigint; note: string;
  }>;
  return rows.map((r) => ({
    id: Number(r.id), businessDate: r.business_date, fromBook: r.from_book, toBook: r.to_book, fromFund: r.from_fund,
    toFund: r.to_fund, amountCents: Number(r.amount_cents), note: r.note,
  }));
}

/** Figures per period from a list of transfers (a transfer lands in the period of its business date). */
export function transferFigures(items: readonly TransferItem[], periods: readonly Period[]): TransferFigures[] {
  const out = periods.map(() => emptyFigures());
  for (const t of items) {
    const i = periodIndex(periods, t.businessDate);
    if (i >= 0) add(out[i]!, t);
  }
  return out;
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'count', label: 'Transfers', kind: 'int' },
  { key: 'total', label: 'Total moved', kind: 'money' },
  ...DIRECTIONS.map((d): ReportColumn => ({ key: d.key, label: `${BOOK_NAME[d.from]} to ${BOOK_NAME[d.to]}`, kind: 'money' })),
];

function flat(label: string, f: TransferFigures): Record<string, ReportCell> {
  const out: Record<string, ReportCell> = { period: label, count: f.count, total: f.totalCents };
  for (const d of DIRECTIONS) out[d.key] = f.byDirection[d.key]!.amountCents;
  return out;
}

/** Posted transfers for a date range: per-period totals by direction plus the list itself. */
export function transfersReport(conn: DatabaseSync, q: PeriodQuery): TransfersReport {
  const periods = listPeriods(q.from, q.to, q.granularity);
  const items = listTransfers(conn, q.from, q.to);
  const figs = transferFigures(items, periods);
  const totals = transferFigures(items, [wholePeriod(q.from, q.to)])[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));
  const table: ReportTable = {
    title: 'Transfers by direction', columns: COLUMNS, rows: rows.map((r) => flat(r.period.label, r)), totals: flat('Total', totals),
    notes: ['Transfers move cash between books; they are never income, cost or profit. Voided transfers are not listed.'],
  };
  const itemsTable: ReportTable = {
    title: 'Transfers',
    columns: [
      { key: 'date', label: 'Date', kind: 'date' }, { key: 'id', label: 'No.', kind: 'int' }, { key: 'from', label: 'From', kind: 'text' },
      { key: 'to', label: 'To', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'note', label: 'Note', kind: 'text' },
    ],
    rows: items.map((t) => ({
      date: t.businessDate, id: t.id, from: `${BOOK_NAME[t.fromBook]}${t.fromFund ? ` (${t.fromFund})` : ''}`,
      to: `${BOOK_NAME[t.toBook]}${t.toFund ? ` (${t.toFund})` : ''}`, amount: t.amountCents, note: t.note,
    })),
    totals: { date: 'Total', id: null, from: null, to: null, amount: totals.totalCents, note: null },
  };
  return { from: q.from, to: q.to, granularity: q.granularity, rows, totals, items, table, itemsTable, warnings: [] };
}
