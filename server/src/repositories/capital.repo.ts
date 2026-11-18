/**
 * repositories/capital.repo.ts - SQL for `capital_entries` (migration 012): opening balances and capital.
 *
 * Layer: repository (SQL only, no business rules). Both are cash IN and never revenue (section 9). Phase 8 only
 * writes `kind = 'opening_balance'`. A wrong entry is voided (`status = 'void'`, R1) and entered again; a partial
 * unique index allows one POSTED opening balance per scope: book (+ Telecom segment, 13D) (+ fund for Ice Cream) -
 * `ux_capital_opening_balance` of migration 024.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StoredSegment } from '../services/segments.ts';
import type { CashBook, IceFund } from './cash-entries.repo.ts';
import type { RecordStatus } from './expenses.repo.ts';
import { SQL_NOW_UTC } from './sql-helpers.ts';

/** What the entry is. */
export type CapitalKind = 'opening_balance' | 'capital';
type N = number | bigint;

/** One capital / opening-balance row. `segment` is set exactly for Telecom entries. */
export interface CapitalRow {
  id: number; businessDate: string; postedAt: string; book: CashBook; fund: IceFund | null; segment: StoredSegment | null;
  kind: CapitalKind; amountCents: number; note: string; status: RecordStatus; voidedAt: string | null; voidReason: string | null;
  clientRef: string;
}
interface Raw {
  id: N; business_date: string; posted_at: string; book: CashBook; fund: IceFund | null; segment: StoredSegment | null; kind: CapitalKind;
  amount_cents: N; note: string; status: RecordStatus; voided_at: string | null; void_reason: string | null; client_ref: string;
}

const SELECT = `SELECT id, business_date, posted_at, book, fund, segment, kind, amount_cents, note, status, voided_at, void_reason,
  client_ref FROM capital_entries`;

function map(r: Raw): CapitalRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, book: r.book, fund: r.fund, segment: r.segment, kind: r.kind,
    amountCents: Number(r.amount_cents), note: r.note, status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason,
    clientRef: r.client_ref,
  };
}

/** One entry by id, or undefined. */
export function getCapital(conn: DatabaseSync, id: number): CapitalRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The entry saved under a `clientRef`, or undefined. */
export function getCapitalByClientRef(conn: DatabaseSync, clientRef: string): CapitalRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** The POSTED opening balance of a scope (book, Telecom segment, Ice Cream fund), or undefined. */
export function findPostedOpening(conn: DatabaseSync, book: CashBook, fund: IceFund | null, segment: StoredSegment | null = null): CapitalRow | undefined {
  const r = conn.prepare(
    `${SELECT} WHERE book = ? AND COALESCE(segment, '') = ? AND COALESCE(fund, '') = ? AND kind = 'opening_balance' AND status = 'posted'`,
  ).get(book, segment ?? '', fund ?? '') as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Adds a posted entry; returns its id. */
export function insertCapital(conn: DatabaseSync, e: {
  businessDate: string; book: CashBook; fund: IceFund | null; segment?: StoredSegment | null; kind: CapitalKind; amountCents: number;
  note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO capital_entries (business_date, book, fund, segment, kind, amount_cents, note, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.businessDate, e.book, e.fund, e.segment ?? null, e.kind, e.amountCents, e.note, e.clientRef);
  return Number(res.lastInsertRowid);
}

/** posted -> void; the DB triggers forbid anything else. */
export function markCapitalVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE capital_entries SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/**
 * Entries of one kind for a book, oldest first (all statuses; the screen shows voided ones greyed out). With `segment` only that
 * Telecom segment; a Telecom book without a segment lists every segment (legacy included).
 */
export function listCapital(conn: DatabaseSync, book: CashBook, kind: CapitalKind, segment?: StoredSegment): CapitalRow[] {
  const params: SQLInputValue[] = [book, kind];
  let seg = '';
  if (segment !== undefined) { seg = ' AND segment = ?'; params.push(segment); }
  const rows = conn.prepare(`${SELECT} WHERE book = ? AND kind = ?${seg} ORDER BY business_date, id`).all(...params) as unknown as Raw[];
  return rows.map(map);
}
