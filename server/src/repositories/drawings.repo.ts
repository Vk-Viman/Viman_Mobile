import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type DrawingBook = 'shop' | 'telecom' | 'icecream';
export type DrawingKind = 'cash' | 'goods';
export type DrawingStatus = 'posted' | 'void';
export type DrawingFund = 'cost' | 'electricity' | 'profit';

export interface DrawingRow {
  id: number; businessDate: string; postedAt: string; book: DrawingBook; fund: DrawingFund | null; kind: DrawingKind;
  amountCents: number; productId: number | null; productName: string | null; qty: number | null; note: string;
  status: DrawingStatus; clientRef: string; voidedAt: string | null; voidReason: string | null;
}

type N = number | bigint;
interface Raw {
  id: N; business_date: string; posted_at: string; book: DrawingBook; fund: DrawingFund | null; kind: DrawingKind;
  amount_cents: N; product_id: N | null; product_name: string | null; qty: N | null; note: string;
  status: DrawingStatus; client_ref: string; voided_at: string | null; void_reason: string | null;
}

const SELECT = `SELECT d.id, d.business_date, d.posted_at, d.book, d.fund, d.kind, d.amount_cents, d.product_id,
  p.name AS product_name, d.qty, d.note, d.status, d.client_ref, d.voided_at, d.void_reason
  FROM owner_drawings d LEFT JOIN products p ON p.id = d.product_id`;

function map(r: Raw): DrawingRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, book: r.book, fund: r.fund, kind: r.kind,
    amountCents: Number(r.amount_cents), productId: r.product_id === null ? null : Number(r.product_id),
    productName: r.product_name, qty: r.qty === null ? null : Number(r.qty), note: r.note, status: r.status,
    clientRef: r.client_ref, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
}

export function insertDrawing(conn: DatabaseSync, d: {
  businessDate: string; book: DrawingBook; fund?: DrawingFund | null; kind: DrawingKind; amountCents: number;
  productId?: number | null; qty?: number | null; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO owner_drawings (business_date, book, fund, kind, amount_cents, product_id, qty, note, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(d.businessDate, d.book, d.fund ?? null, d.kind, d.amountCents, d.productId ?? null, d.qty ?? null, d.note, d.clientRef);
  return Number(res.lastInsertRowid);
}

export function getDrawing(conn: DatabaseSync, id: number): DrawingRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE d.id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

export function getDrawingByClientRef(conn: DatabaseSync, ref: string): DrawingRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE d.client_ref = ?`).get(ref) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

export function listDrawings(conn: DatabaseSync, q: {
  kind?: DrawingKind; from?: string; to?: string; book?: DrawingBook; productId?: number; status?: DrawingStatus;
  limit: number; offset: number;
}): { items: DrawingRow[]; total: number; totalAmountCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.kind !== undefined) { where.push('d.kind = ?'); params.push(q.kind); }
  if (q.from !== undefined) { where.push('d.business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('d.business_date <= ?'); params.push(q.to); }
  if (q.book !== undefined) { where.push('d.book = ?'); params.push(q.book); }
  if (q.productId !== undefined) { where.push('d.product_id = ?'); params.push(q.productId); }
  if (q.status !== undefined) { where.push('d.status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN d.status = 'posted' THEN d.amount_cents END), 0) AS c FROM owner_drawings d${w}`,
  ).get(...params) as unknown as { n: N; c: N };
  const rows = conn.prepare(`${SELECT}${w} ORDER BY d.business_date DESC, d.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total: Number(agg.n), totalAmountCents: Number(agg.c) };
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markDrawingVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(
    `UPDATE owner_drawings SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = ? WHERE id = ?`,
  ).run(reason, id);
}
