import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type LossBook = 'shop' | 'telecom';
export type LossReason = 'damaged' | 'lost' | 'expired' | 'other';
export type LossSource = 'manual' | 'damaged_return';
export type LossStatus = 'posted' | 'void';

export interface StockLossRow {
  id: number; businessDate: string; postedAt: string; productId: number; productName: string; book: LossBook;
  qty: number; costCents: number; reason: LossReason; note: string; source: LossSource; status: LossStatus;
  clientRef: string; voidedAt: string | null; voidReason: string | null;
}

type N = number | bigint;
interface Raw {
  id: N; business_date: string; posted_at: string; product_id: N; product_name: string; book: LossBook;
  qty: N; cost_cents: N; reason: LossReason; note: string; source: LossSource; status: LossStatus;
  client_ref: string; voided_at: string | null; void_reason: string | null;
}

const SELECT = `SELECT l.id, l.business_date, l.posted_at, l.product_id, p.name AS product_name, l.book, l.qty, l.cost_cents,
  l.reason, l.note, l.source, l.status, l.client_ref, l.voided_at, l.void_reason
  FROM stock_losses l JOIN products p ON p.id = l.product_id`;

function map(r: Raw): StockLossRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, productId: Number(r.product_id),
    productName: r.product_name, book: r.book, qty: Number(r.qty), costCents: Number(r.cost_cents), reason: r.reason,
    note: r.note, source: r.source, status: r.status, clientRef: r.client_ref, voidedAt: r.voided_at,
    voidReason: r.void_reason,
  };
}

export function insertStockLoss(conn: DatabaseSync, l: {
  businessDate: string; productId: number; book: LossBook; qty: number; costCents: number; reason: LossReason;
  note: string; clientRef: string; source?: LossSource;
}): number {
  const res = conn.prepare(
    `INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, note, source, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(l.businessDate, l.productId, l.book, l.qty, l.costCents, l.reason, l.note, l.source ?? 'manual', l.clientRef);
  return Number(res.lastInsertRowid);
}

export function getStockLoss(conn: DatabaseSync, id: number): StockLossRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE l.id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

export function getStockLossByClientRef(conn: DatabaseSync, ref: string): StockLossRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE l.client_ref = ?`).get(ref) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

export function listStockLosses(conn: DatabaseSync, q: {
  from?: string; to?: string; productId?: number; book?: LossBook; reason?: LossReason; status?: LossStatus;
  limit: number; offset: number;
}): { items: StockLossRow[]; total: number; totalCostCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('l.business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('l.business_date <= ?'); params.push(q.to); }
  if (q.productId !== undefined) { where.push('l.product_id = ?'); params.push(q.productId); }
  if (q.book !== undefined) { where.push('l.book = ?'); params.push(q.book); }
  if (q.reason !== undefined) { where.push('l.reason = ?'); params.push(q.reason); }
  if (q.status !== undefined) { where.push('l.status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN l.status = 'posted' THEN l.cost_cents END), 0) AS c FROM stock_losses l${w}`,
  ).get(...params) as unknown as { n: N; c: N };
  const rows = conn.prepare(`${SELECT}${w} ORDER BY l.business_date DESC, l.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total: Number(agg.n), totalCostCents: Number(agg.c) };
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markStockLossVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(
    `UPDATE stock_losses SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = ? WHERE id = ?`,
  ).run(reason, id);
}
