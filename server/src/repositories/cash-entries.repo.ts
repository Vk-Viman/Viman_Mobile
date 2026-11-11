/**
 * repositories/cash-entries.repo.ts - SQL for `cash_entries`, the append-only cash ledger.
 *
 * Layer: repository. Every cash movement of the three logical cash books (shop, telecom, icecream) is one
 * signed row (money in is positive, money out is negative). Balance = SUM of all rows (BUSINESS_RULES
 * section 8). Rows are never edited or deleted (R1): a void adds a row that points back at the original via
 * `reverses_entry_id`. The database refuses future dates (R-FD) and edits (migration 004 triggers).
 */
import type { DatabaseSync } from 'node:sqlite';
import { numberOrNull } from './sql-helpers.ts';

/** The three logical cash books (BUSINESS_RULES section 0). */
export type CashBook = 'shop' | 'telecom' | 'icecream';

/** The three Ice Cream funds (BUSINESS_RULES section 10). */
export type IceFund = 'cost' | 'electricity' | 'profit';

/** One cash ledger row. `fund` is only set for the ice-cream book (section 10.2). */
export interface CashEntryRow {
  id: number; book: CashBook; businessDate: string; postedAt: string; type: string; amountCents: number;
  fund: IceFund | null; refTable: string | null; refId: number | null;
  transferId: number | null; reversesEntryId: number | null; note: string | null;
}

/** Row as SQLite returns it. */
interface Raw {
  id: number | bigint; book: CashBook; business_date: string; posted_at: string; type: string;
  amount_cents: number | bigint; fund: IceFund | null;
  ref_table: string | null; ref_id: number | bigint | null; transfer_id: number | bigint | null;
  reverses_entry_id: number | bigint | null; note: string | null;
}

const SELECT = `SELECT id, book, business_date, posted_at, type, amount_cents, fund, ref_table, ref_id,
  transfer_id, reverses_entry_id, note FROM cash_entries`;

function map(r: Raw): CashEntryRow {
  return {
    id: Number(r.id), book: r.book, businessDate: r.business_date, postedAt: r.posted_at, type: r.type,
    amountCents: Number(r.amount_cents), fund: r.fund, refTable: r.ref_table, refId: numberOrNull(r.ref_id),
    transferId: numberOrNull(r.transfer_id), reversesEntryId: numberOrNull(r.reverses_entry_id), note: r.note,
  };
}

/**
 * Appends a cash entry (posted_at comes from the DB default). Shop/telecom callers pass no fund; every Ice Cream
 * entry names exactly one fund (section 10.2, enforced by a CHECK).
 *
 * @param e.amountCents      Signed: positive = cash in, negative = cash out.
 * @param e.refTable/refId   The business record that caused the entry (e.g. 'purchases', 12).
 * @param e.reversesEntryId  Set when this row cancels an earlier row (void, R1).
 * @param e.fund             Ice Cream only: the fund this movement belongs to.
 * @returns The new entry id.
 */
export function insertCashEntry(conn: DatabaseSync, e: {
  book: CashBook; businessDate: string; type: string; amountCents: number; refTable: string | null; refId: number | null;
  reversesEntryId?: number | null; note?: string | null; fund?: IceFund | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, reverses_entry_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.book, e.businessDate, e.type, e.amountCents, e.fund ?? null, e.refTable, e.refId, e.reversesEntryId ?? null, e.note ?? null);
  return Number(res.lastInsertRowid);
}

/** One cash entry by id, or undefined. */
export function getCashEntry(conn: DatabaseSync, id: number): CashEntryRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** All entries written for one source record (e.g. refTable 'purchases', id 12), oldest first. */
export function findCashEntriesByRef(conn: DatabaseSync, refTable: string, refId: number): CashEntryRow[] {
  const rows = conn.prepare(`${SELECT} WHERE ref_table = ? AND ref_id = ? ORDER BY id`).all(refTable, refId) as unknown as Raw[];
  return rows.map(map);
}

/** Current balance of a cash book in cents: opening + in - out, i.e. the sum of every ledger row (section 8). */
export function cashBalance(conn: DatabaseSync, book: CashBook): number {
  const r = conn.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_entries WHERE book = ?')
    .get(book) as unknown as { total: number | bigint };
  return Number(r.total);
}

/**
 * Balance of a cash book at the END of a business date: the sum of every ledger row dated on or before it
 * (section 8, "expected" of a cash count). Business date, not posting time, decides which rows count (R7).
 */
export function cashBalanceAsOf(conn: DatabaseSync, book: CashBook, date: string): number {
  const r = conn.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_entries WHERE book = ? AND business_date <= ?')
    .get(book, date) as unknown as { total: number | bigint };
  return Number(r.total);
}
