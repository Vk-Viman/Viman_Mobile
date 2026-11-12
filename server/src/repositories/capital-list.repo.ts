/**
 * repositories/capital-list.repo.ts - the filtered, paged list of `capital_entries` (Phase 9 addition).
 *
 * Layer: repository (SQL only, no business rules). `capital.repo.ts` (Phase 8) only lists the opening balances of ONE
 * book; the Capital tab needs every kind, every book, date and status filters, totals and paging. This file returns the
 * matching ids (newest first) plus the counts; the service loads each row with `getCapital`, so the row mapping lives in
 * one place only.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CapitalKind } from './capital.repo.ts';
import type { CashBook } from './cash-entries.repo.ts';
import type { RecordStatus } from './expenses.repo.ts';

type N = number | bigint;

/**
 * Ids of the entries that match the filters (newest business date first, then newest id), the total number of matches
 * and the total of the POSTED amounts (voided entries are listed but not summed). `from`/`to` are inclusive business dates.
 */
export function listCapitalEntries(conn: DatabaseSync, q: {
  kind?: CapitalKind; book?: CashBook; from?: string; to?: string; status?: RecordStatus; limit: number; offset: number;
}): { ids: number[]; total: number; amountCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.kind !== undefined) { where.push('kind = ?'); params.push(q.kind); }
  if (q.book !== undefined) { where.push('book = ?'); params.push(q.book); }
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_cents END), 0) AS c FROM capital_entries${w}`,
  ).get(...params) as unknown as { n: N; c: N };
  const rows = conn.prepare(`SELECT id FROM capital_entries${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Array<{ id: N }>;
  return { ids: rows.map((r) => Number(r.id)), total: Number(agg.n), amountCents: Number(agg.c) };
}
