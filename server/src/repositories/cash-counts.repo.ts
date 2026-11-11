/**
 * repositories/cash-counts.repo.ts - SQL for `cash_counts` (migration 012): the owner's physical drawer counts.
 *
 * Layer: repository (SQL only, no business rules). A count stores the expected balance (ledger as of the end of its
 * business date), the counted amount and the difference (C4: counted - expected). It is never edited; a void marks
 * `status = 'void'` (R1). The adjustment cash entry is written by the service and linked once via `cash_entry_id`.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CashBook, IceFund } from './cash-entries.repo.ts';
import type { RecordStatus } from './expenses.repo.ts';
import { SQL_NOW_UTC, numberOrNull } from './sql-helpers.ts';

type N = number | bigint;

/** One cash count row. */
export interface CashCountRow {
  id: number; book: CashBook; fund: IceFund | null; businessDate: string; postedAt: string; expectedCents: number;
  countedCents: number; differenceCents: number; note: string; status: RecordStatus; voidedAt: string | null;
  voidReason: string | null; cashEntryId: number | null; clientRef: string;
}
interface Raw {
  id: N; book: CashBook; fund: IceFund | null; business_date: string; posted_at: string; expected_cents: N; counted_cents: N;
  difference_cents: N; note: string; status: RecordStatus; voided_at: string | null; void_reason: string | null;
  cash_entry_id: N | null; client_ref: string;
}

const SELECT = `SELECT id, book, fund, business_date, posted_at, expected_cents, counted_cents, difference_cents, note, status,
  voided_at, void_reason, cash_entry_id, client_ref FROM cash_counts`;

function map(r: Raw): CashCountRow {
  return {
    id: Number(r.id), book: r.book, fund: r.fund, businessDate: r.business_date, postedAt: r.posted_at,
    expectedCents: Number(r.expected_cents), countedCents: Number(r.counted_cents), differenceCents: Number(r.difference_cents),
    note: r.note, status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason, cashEntryId: numberOrNull(r.cash_entry_id),
    clientRef: r.client_ref,
  };
}

/** One count by id, or undefined. */
export function getCashCount(conn: DatabaseSync, id: number): CashCountRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The count saved under a `clientRef`, or undefined. */
export function getCashCountByClientRef(conn: DatabaseSync, clientRef: string): CashCountRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Adds a posted count (adjustment link still empty); returns its id. */
export function insertCashCount(conn: DatabaseSync, c: {
  book: CashBook; fund: IceFund | null; businessDate: string; expectedCents: number; countedCents: number;
  differenceCents: number; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO cash_counts (book, fund, business_date, expected_cents, counted_cents, difference_cents, note, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.book, c.fund, c.businessDate, c.expectedCents, c.countedCents, c.differenceCents, c.note, c.clientRef);
  return Number(res.lastInsertRowid);
}

/** Links the count to its adjustment cash entry (allowed once, NULL -> id). */
export function linkCashEntry(conn: DatabaseSync, id: number, cashEntryId: number): void {
  conn.prepare('UPDATE cash_counts SET cash_entry_id = ? WHERE id = ?').run(cashEntryId, id);
}

/** posted -> void; the DB triggers forbid anything else. */
export function markCashCountVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE cash_counts SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/** Counts newest business date first; `differenceCents` sums only POSTED rows that match the filters. */
export function listCashCounts(conn: DatabaseSync, q: {
  book?: CashBook; from?: string; to?: string; status?: RecordStatus; limit: number; offset: number;
}): { items: CashCountRow[]; total: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.book !== undefined) { where.push('book = ?'); params.push(q.book); }
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(`SELECT COUNT(*) AS n FROM cash_counts${w}`).get(...params) as unknown as { n: N };
  const rows = conn.prepare(`${SELECT}${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total: Number(agg.n) };
}
