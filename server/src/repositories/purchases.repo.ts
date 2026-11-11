import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type PurchaseBook = 'shop' | 'telecom';
export type PurchaseStatus = 'posted' | 'void';

export interface PurchaseHeaderRow {
  id: number; businessDate: string; postedAt: string; supplierId: number | null; supplierName: string | null;
  billNo: string; book: PurchaseBook; totalCents: number; status: PurchaseStatus; clientRef: string;
  notes: string; voidedAt: string | null; voidReason: string | null;
}
export interface PurchaseItemRow {
  id: number; purchaseId: number; productId: number; productName: string; packs: number; packSize: number;
  units: number; lineTotalCents: number; returnedUnits: number;
}
export interface PurchaseReturnRow {
  id: number; purchaseId: number; businessDate: string; postedAt: string; refundCents: number; note: string; clientRef: string;
}
export interface PurchaseReturnItemRow {
  id: number; purchaseReturnId: number; purchaseItemId: number; productId: number; productName: string;
  units: number; valueCents: number;
}

type N = number | bigint;
interface RawHeader {
  id: N; business_date: string; posted_at: string; supplier_id: N | null; supplier_name: string | null;
  bill_no: string; book: PurchaseBook; total_cents: N; status: PurchaseStatus; client_ref: string;
  notes: string; voided_at: string | null; void_reason: string | null;
}
interface RawItem {
  id: N; purchase_id: N; product_id: N; product_name: string; packs: N; pack_size: N; units: N;
  line_total_cents: N; returned_units: N;
}
interface RawReturn {
  id: N; purchase_id: N; business_date: string; posted_at: string; refund_cents: N; note: string; client_ref: string;
}
interface RawReturnItem {
  id: N; purchase_return_id: N; purchase_item_id: N; product_id: N; product_name: string; units: N; value_cents: N;
}

const HEADER_SELECT = `SELECT p.id, p.business_date, p.posted_at, p.supplier_id, s.name AS supplier_name, p.bill_no, p.book,
  p.total_cents, p.status, p.client_ref, p.notes, p.voided_at, p.void_reason
  FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function mapHeader(r: RawHeader): PurchaseHeaderRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at,
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id), supplierName: r.supplier_name,
    billNo: r.bill_no, book: r.book, totalCents: Number(r.total_cents), status: r.status, clientRef: r.client_ref,
    notes: r.notes, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function insertPurchase(conn: DatabaseSync, p: {
  businessDate: string; supplierId: number | null; billNo: string; book: PurchaseBook; totalCents: number;
  notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO purchases (business_date, supplier_id, bill_no, book, total_cents, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.businessDate, p.supplierId, p.billNo, p.book, p.totalCents, p.notes, p.clientRef);
  return Number(res.lastInsertRowid);
}

export function insertPurchaseItem(conn: DatabaseSync, i: {
  purchaseId: number; productId: number; packs: number; packSize: number; units: number; lineTotalCents: number;
}): number {
  const res = conn.prepare(
    `INSERT INTO purchase_items (purchase_id, product_id, packs, pack_size, units, line_total_cents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(i.purchaseId, i.productId, i.packs, i.packSize, i.units, i.lineTotalCents);
  return Number(res.lastInsertRowid);
}

export function getPurchase(conn: DatabaseSync, id: number): PurchaseHeaderRow | undefined {
  const r = conn.prepare(`${HEADER_SELECT} WHERE p.id = ?`).get(id) as unknown as RawHeader | undefined;
  return r ? mapHeader(r) : undefined;
}

export function getPurchaseByClientRef(conn: DatabaseSync, ref: string): PurchaseHeaderRow | undefined {
  const r = conn.prepare(`${HEADER_SELECT} WHERE p.client_ref = ?`).get(ref) as unknown as RawHeader | undefined;
  return r ? mapHeader(r) : undefined;
}

export function listPurchaseItems(conn: DatabaseSync, purchaseId: number): PurchaseItemRow[] {
  const rows = conn.prepare(
    `SELECT i.id, i.purchase_id, i.product_id, pr.name AS product_name, i.packs, i.pack_size, i.units,
            i.line_total_cents, i.returned_units
     FROM purchase_items i JOIN products pr ON pr.id = i.product_id WHERE i.purchase_id = ? ORDER BY i.id`,
  ).all(purchaseId) as unknown as RawItem[];
  return rows.map((r) => ({
    id: Number(r.id), purchaseId: Number(r.purchase_id), productId: Number(r.product_id), productName: r.product_name,
    packs: Number(r.packs), packSize: Number(r.pack_size), units: Number(r.units),
    lineTotalCents: Number(r.line_total_cents), returnedUnits: Number(r.returned_units),
  }));
}

export function listPurchases(conn: DatabaseSync, q: {
  from?: string; to?: string; book?: PurchaseBook; supplierId?: number; status?: PurchaseStatus; q?: string;
  limit: number; offset: number;
}): { items: PurchaseHeaderRow[]; total: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('p.business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('p.business_date <= ?'); params.push(q.to); }
  if (q.book !== undefined) { where.push('p.book = ?'); params.push(q.book); }
  if (q.supplierId !== undefined) { where.push('p.supplier_id = ?'); params.push(q.supplierId); }
  if (q.status !== undefined) { where.push('p.status = ?'); params.push(q.status); }
  if (q.q !== undefined && q.q !== '') { where.push("p.bill_no LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(q.q)}%`); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((conn.prepare(`SELECT COUNT(*) AS n FROM purchases p${w}`).get(...params) as unknown as { n: N }).n);
  const rows = conn.prepare(`${HEADER_SELECT}${w} ORDER BY p.business_date DESC, p.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawHeader[];
  return { items: rows.map(mapHeader), total };
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock (= void posting time). */
export function markPurchaseVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(
    `UPDATE purchases SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = ? WHERE id = ?`,
  ).run(reason, id);
}

export function addReturnedUnits(conn: DatabaseSync, itemId: number, units: number): void {
  conn.prepare('UPDATE purchase_items SET returned_units = returned_units + ? WHERE id = ?').run(units, itemId);
}

export function insertPurchaseReturn(conn: DatabaseSync, r: {
  purchaseId: number; businessDate: string; refundCents: number; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO purchase_returns (purchase_id, business_date, refund_cents, note, client_ref) VALUES (?, ?, ?, ?, ?)`,
  ).run(r.purchaseId, r.businessDate, r.refundCents, r.note, r.clientRef);
  return Number(res.lastInsertRowid);
}

export function insertPurchaseReturnItem(conn: DatabaseSync, i: {
  purchaseReturnId: number; purchaseItemId: number; units: number; valueCents: number;
}): number {
  const res = conn.prepare(
    `INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, units, value_cents) VALUES (?, ?, ?, ?)`,
  ).run(i.purchaseReturnId, i.purchaseItemId, i.units, i.valueCents);
  return Number(res.lastInsertRowid);
}

function mapReturn(r: RawReturn): PurchaseReturnRow {
  return {
    id: Number(r.id), purchaseId: Number(r.purchase_id), businessDate: r.business_date, postedAt: r.posted_at,
    refundCents: Number(r.refund_cents), note: r.note, clientRef: r.client_ref,
  };
}

const RETURN_SELECT = 'SELECT id, purchase_id, business_date, posted_at, refund_cents, note, client_ref FROM purchase_returns';

export function getPurchaseReturnByClientRef(conn: DatabaseSync, ref: string): PurchaseReturnRow | undefined {
  const r = conn.prepare(`${RETURN_SELECT} WHERE client_ref = ?`).get(ref) as unknown as RawReturn | undefined;
  return r ? mapReturn(r) : undefined;
}

export function getPurchaseReturn(conn: DatabaseSync, id: number): PurchaseReturnRow | undefined {
  const r = conn.prepare(`${RETURN_SELECT} WHERE id = ?`).get(id) as unknown as RawReturn | undefined;
  return r ? mapReturn(r) : undefined;
}

export function listPurchaseReturns(conn: DatabaseSync, purchaseId: number): PurchaseReturnRow[] {
  const rows = conn.prepare(`${RETURN_SELECT} WHERE purchase_id = ? ORDER BY posted_at, id`).all(purchaseId) as unknown as RawReturn[];
  return rows.map(mapReturn);
}

export function listPurchaseReturnItems(conn: DatabaseSync, purchaseReturnId: number): PurchaseReturnItemRow[] {
  const rows = conn.prepare(
    `SELECT ri.id, ri.purchase_return_id, ri.purchase_item_id, pi.product_id, pr.name AS product_name, ri.units, ri.value_cents
     FROM purchase_return_items ri
     JOIN purchase_items pi ON pi.id = ri.purchase_item_id
     JOIN products pr ON pr.id = pi.product_id
     WHERE ri.purchase_return_id = ? ORDER BY ri.id`,
  ).all(purchaseReturnId) as unknown as RawReturnItem[];
  return rows.map((r) => ({
    id: Number(r.id), purchaseReturnId: Number(r.purchase_return_id), purchaseItemId: Number(r.purchase_item_id),
    productId: Number(r.product_id), productName: r.product_name, units: Number(r.units), valueCents: Number(r.value_cents),
  }));
}

export function returnedValueSoFar(conn: DatabaseSync, purchaseItemId: number): number {
  const r = conn.prepare('SELECT COALESCE(SUM(value_cents), 0) AS v FROM purchase_return_items WHERE purchase_item_id = ?')
    .get(purchaseItemId) as unknown as { v: N };
  return Number(r.v);
}
