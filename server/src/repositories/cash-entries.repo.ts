import type { DatabaseSync } from 'node:sqlite';

export type CashBook = 'shop' | 'telecom' | 'icecream';

export interface CashEntryRow {
  id: number; book: CashBook; businessDate: string; postedAt: string; type: string; amountCents: number;
  fund: 'cost' | 'electricity' | 'profit' | null; refTable: string | null; refId: number | null;
  transferId: number | null; reversesEntryId: number | null; note: string | null;
}

interface Raw {
  id: number | bigint; book: CashBook; business_date: string; posted_at: string; type: string;
  amount_cents: number | bigint; fund: 'cost' | 'electricity' | 'profit' | null;
  ref_table: string | null; ref_id: number | bigint | null; transfer_id: number | bigint | null;
  reverses_entry_id: number | bigint | null; note: string | null;
}

const SELECT = `SELECT id, book, business_date, posted_at, type, amount_cents, fund, ref_table, ref_id,
  transfer_id, reverses_entry_id, note FROM cash_entries`;

const n = (v: number | bigint | null): number | null => (v === null ? null : Number(v));

function map(r: Raw): CashEntryRow {
  return {
    id: Number(r.id), book: r.book, businessDate: r.business_date, postedAt: r.posted_at, type: r.type,
    amountCents: Number(r.amount_cents), fund: r.fund, refTable: r.ref_table, refId: n(r.ref_id),
    transferId: n(r.transfer_id), reversesEntryId: n(r.reverses_entry_id), note: r.note,
  };
}

/** Appends a cash entry (posted_at comes from the DB default). Phase 3 callers pass no fund (shop/telecom only). */
export function insertCashEntry(conn: DatabaseSync, e: {
  book: CashBook; businessDate: string; type: string; amountCents: number; refTable: string | null; refId: number | null;
  reversesEntryId?: number | null; note?: string | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.book, e.businessDate, e.type, e.amountCents, e.refTable, e.refId, e.reversesEntryId ?? null, e.note ?? null);
  return Number(res.lastInsertRowid);
}

export function getCashEntry(conn: DatabaseSync, id: number): CashEntryRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

export function findCashEntriesByRef(conn: DatabaseSync, refTable: string, refId: number): CashEntryRow[] {
  const rows = conn.prepare(`${SELECT} WHERE ref_table = ? AND ref_id = ? ORDER BY id`).all(refTable, refId) as unknown as Raw[];
  return rows.map(map);
}

export function cashBalance(conn: DatabaseSync, book: CashBook): number {
  const r = conn.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_entries WHERE book = ?')
    .get(book) as unknown as { total: number | bigint };
  return Number(r.total);
}
