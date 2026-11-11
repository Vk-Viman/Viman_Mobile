/**
 * repositories/expenses.repo.ts - SQL for `expenses` (migration 012): Shop and Telecom operating expenses.
 *
 * Layer: repository (SQL only, no business rules). An expense is never edited or deleted; a void marks
 * `status = 'void'` (R1) and the migration-012 triggers forbid every other edit. `client_ref` is unique so a double
 * submit cannot create two rows. List totals count POSTED rows only (voided rows are shown, not summed).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC } from './sql-helpers.ts';

/** The two books that may have expenses (section 7). */
export type ExpenseBook = 'shop' | 'telecom';
/** posted -> void only (R1). */
export type RecordStatus = 'posted' | 'void';
type N = number | bigint;

/** One expense row. */
export interface ExpenseRow {
  id: number; businessDate: string; postedAt: string; book: ExpenseBook; category: string; amountCents: number;
  description: string; notes: string; status: RecordStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}
interface Raw {
  id: N; business_date: string; posted_at: string; book: ExpenseBook; category: string; amount_cents: N; description: string;
  notes: string; status: RecordStatus; voided_at: string | null; void_reason: string | null; client_ref: string;
}

const SELECT = `SELECT id, business_date, posted_at, book, category, amount_cents, description, notes, status, voided_at,
  void_reason, client_ref FROM expenses`;

function map(r: Raw): ExpenseRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, book: r.book, category: r.category,
    amountCents: Number(r.amount_cents), description: r.description, notes: r.notes, status: r.status,
    voidedAt: r.voided_at, voidReason: r.void_reason, clientRef: r.client_ref,
  };
}

/** One expense by id, or undefined. */
export function getExpense(conn: DatabaseSync, id: number): ExpenseRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The expense saved under a `clientRef`, or undefined (duplicate-submission guard). */
export function getExpenseByClientRef(conn: DatabaseSync, clientRef: string): ExpenseRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Adds a posted expense; returns its id. */
export function insertExpense(conn: DatabaseSync, e: {
  businessDate: string; book: ExpenseBook; category: string; amountCents: number; description: string; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO expenses (business_date, book, category, amount_cents, description, notes, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.businessDate, e.book, e.category, e.amountCents, e.description, e.notes, e.clientRef);
  return Number(res.lastInsertRowid);
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markExpenseVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE expenses SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/** Expenses newest business date first; `amountCents` sums only POSTED rows that match the filters. */
export function listExpenses(conn: DatabaseSync, q: {
  from?: string; to?: string; book?: ExpenseBook; category?: string; status?: RecordStatus; limit: number; offset: number;
}): { items: ExpenseRow[]; total: number; amountCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.book !== undefined) { where.push('book = ?'); params.push(q.book); }
  if (q.category !== undefined) { where.push('category = ?'); params.push(q.category); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_cents END), 0) AS amt FROM expenses${w}`,
  ).get(...params) as unknown as { n: N; amt: N };
  const rows = conn.prepare(`${SELECT}${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total: Number(agg.n), amountCents: Number(agg.amt) };
}
