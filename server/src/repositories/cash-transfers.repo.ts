/**
 * repositories/cash-transfers.repo.ts - SQL for `cash_transfers` (migration 013) and the transfer legs in `cash_entries`.
 *
 * Layer: repository (SQL only, no business rules). A transfer moves cash between two different books (BUSINESS_RULES
 * section 8): one record here plus two ledger rows (`transfer_out`, `transfer_in`) that share `transfer_id`. Rows are never
 * edited or deleted (R1): a void marks `status = 'void'` and the service adds reversing ledger rows. `client_ref` is unique
 * so a double submit cannot create two transfers.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CashBook, IceFund } from './cash-entries.repo.ts';
import type { RecordStatus } from './expenses.repo.ts';
import { SQL_NOW_UTC } from './sql-helpers.ts';

type N = number | bigint;

/** One transfer. A fund is set exactly on the Ice Cream side(s). */
export interface TransferRow {
  id: number; businessDate: string; postedAt: string; fromBook: CashBook; toBook: CashBook; fromFund: IceFund | null;
  toFund: IceFund | null; amountCents: number; note: string; status: RecordStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}
interface Raw {
  id: N; business_date: string; posted_at: string; from_book: CashBook; to_book: CashBook; from_fund: IceFund | null;
  to_fund: IceFund | null; amount_cents: N; note: string; status: RecordStatus; voided_at: string | null;
  void_reason: string | null; client_ref: string;
}

const SELECT = `SELECT id, business_date, posted_at, from_book, to_book, from_fund, to_fund, amount_cents, note, status,
  voided_at, void_reason, client_ref FROM cash_transfers`;

function map(r: Raw): TransferRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, fromBook: r.from_book, toBook: r.to_book,
    fromFund: r.from_fund, toFund: r.to_fund, amountCents: Number(r.amount_cents), note: r.note, status: r.status,
    voidedAt: r.voided_at, voidReason: r.void_reason, clientRef: r.client_ref,
  };
}

/** Adds a posted transfer; returns its id. */
export function insertTransfer(conn: DatabaseSync, t: {
  businessDate: string; fromBook: CashBook; toBook: CashBook; fromFund: IceFund | null; toFund: IceFund | null;
  amountCents: number; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO cash_transfers (business_date, from_book, to_book, from_fund, to_fund, amount_cents, note, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.businessDate, t.fromBook, t.toBook, t.fromFund, t.toFund, t.amountCents, t.note, t.clientRef);
  return Number(res.lastInsertRowid);
}

/** One transfer by id, or undefined. */
export function getTransfer(conn: DatabaseSync, id: number): TransferRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The transfer saved under a `clientRef`, or undefined. */
export function getTransferByClientRef(conn: DatabaseSync, clientRef: string): TransferRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markTransferVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE cash_transfers SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/**
 * Lists transfers, newest business date first, with the total count and the total of POSTED amounts (voided rows are
 * listed but not summed). `book` matches EITHER side. `from`/`to` are inclusive business dates.
 */
export function listTransfers(conn: DatabaseSync, q: {
  from?: string; to?: string; book?: CashBook; status?: RecordStatus; limit: number; offset: number;
}): { items: TransferRow[]; total: number; amountCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.book !== undefined) { where.push('(from_book = ? OR to_book = ?)'); params.push(q.book, q.book); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_cents END), 0) AS c FROM cash_transfers${w}`,
  ).get(...params) as unknown as { n: N; c: N };
  const rows = conn.prepare(`${SELECT}${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total: Number(agg.n), amountCents: Number(agg.c) };
}

/**
 * Appends one ledger leg of a transfer: like `insertCashEntry` but carrying `transfer_id` (the shared link of the two
 * legs). `insertCashEntry` has no such parameter and the ledger is append-only, so the link cannot be added afterwards.
 * The database trigger `TRANSFER_LEG_MISMATCH` checks the leg against its transfer (type, book, fund).
 *
 * @param e.type         `transfer_out` (negative amount, source book) or `transfer_in` (positive, destination book).
 * @param e.reversesEntryId Set when this leg cancels an earlier leg (void, R1).
 * @returns The new cash entry id.
 */
export function insertTransferLeg(conn: DatabaseSync, e: {
  transferId: number; book: CashBook; fund: IceFund | null; businessDate: string; type: 'transfer_out' | 'transfer_in';
  amountCents: number; reversesEntryId?: number | null; note?: string | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, transfer_id, reverses_entry_id, note)
     VALUES (?, ?, ?, ?, ?, 'cash_transfers', ?, ?, ?, ?)`,
  ).run(e.book, e.businessDate, e.type, e.amountCents, e.fund, e.transferId, e.transferId, e.reversesEntryId ?? null, e.note ?? null);
  return Number(res.lastInsertRowid);
}
