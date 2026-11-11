/**
 * repositories/capital.repo.ts - SQL for `capital_entries` (migration 012): opening balances and capital.
 *
 * Layer: repository (SQL only, no business rules). Both are cash IN and never revenue (section 9). Phase 8 only
 * writes `kind = 'opening_balance'`. A wrong entry is voided (`status = 'void'`, R1) and entered again; a partial
 * unique index allows one POSTED opening balance per book (per fund for Ice Cream).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CashBook, IceFund } from './cash-entries.repo.ts';
import type { RecordStatus } from './expenses.repo.ts';
import { SQL_NOW_UTC } from './sql-helpers.ts';

/** What the entry is. */
export type CapitalKind = 'opening_balance' | 'capital';
type N = number | bigint;

/** One capital / opening-balance row. */
export interface CapitalRow {
  id: number; businessDate: string; postedAt: string; book: CashBook; fund: IceFund | null; kind: CapitalKind;
  amountCents: number; note: string; status: RecordStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}
interface Raw {
  id: N; business_date: string; posted_at: string; book: CashBook; fund: IceFund | null; kind: CapitalKind; amount_cents: N;
  note: string; status: RecordStatus; voided_at: string | null; void_reason: string | null; client_ref: string;
}

const SELECT = `SELECT id, business_date, posted_at, book, fund, kind, amount_cents, note, status, voided_at, void_reason,
  client_ref FROM capital_entries`;

function map(r: Raw): CapitalRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, book: r.book, fund: r.fund, kind: r.kind,
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

/** The POSTED opening balance of a book (and fund, for Ice Cream), or undefined. */
export function findPostedOpening(conn: DatabaseSync, book: CashBook, fund: IceFund | null): CapitalRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE book = ? AND COALESCE(fund, '') = ? AND kind = 'opening_balance' AND status = 'posted'`)
    .get(book, fund ?? '') as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Adds a posted entry; returns its id. */
export function insertCapital(conn: DatabaseSync, e: {
  businessDate: string; book: CashBook; fund: IceFund | null; kind: CapitalKind; amountCents: number; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO capital_entries (business_date, book, fund, kind, amount_cents, note, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.businessDate, e.book, e.fund, e.kind, e.amountCents, e.note, e.clientRef);
  return Number(res.lastInsertRowid);
}

/** posted -> void; the DB triggers forbid anything else. */
export function markCapitalVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE capital_entries SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/** Entries of one kind for a book, oldest first (all statuses; the screen shows voided ones greyed out). */
export function listCapital(conn: DatabaseSync, book: CashBook, kind: CapitalKind): CapitalRow[] {
  const rows = conn.prepare(`${SELECT} WHERE book = ? AND kind = ? ORDER BY business_date, id`).all(book, kind) as unknown as Raw[];
  return rows.map(map);
}
