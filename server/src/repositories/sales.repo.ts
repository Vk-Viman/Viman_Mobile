/**
 * repositories/sales.repo.ts - SQL for sales, their lines, sales returns and the return lines.
 *
 * Tables: `sales` (one receipt per book), `sale_items` (lines with the frozen revenue, cost and extra cost C13),
 * `sales_returns` and `sales_return_items` (goods a customer brought back).
 *
 * Layer: repository - SQL only, no business rules. `sales.service.ts` decides prices, stock, cash, rounding of
 * return portions (C5), R-FD/R-RD and the audit row. The triggers of migration 006 are the backstop: a sale can
 * only go posted -> void, its date, amounts and cost snapshot never change (R1, C5), a return line cannot take
 * back more than was sold, and returns are append-only. `(client_ref, book)` is unique so a repeated
 * submission cannot create a second sale, while one cart may still create a shop sale AND a telecom sale.
 *
 * The posting time (`posted_at`) and the void time are always the DATABASE clock; code never passes them.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC } from './sql-helpers.ts';

export type SaleBook = 'shop' | 'telecom';
export type SaleStatus = 'posted' | 'void';
export type SaleLineType = 'goods' | 'card';

/**
 * A sale header. `cogsCents` = sum of its lines' frozen automatic costs; `extraCostCents` = sum of their extra
 * costs (C13); both before any returns.
 */
export interface SaleRow {
  id: number; businessDate: string; postedAt: string; book: SaleBook; totalCents: number; cogsCents: number;
  extraCostCents: number; status: SaleStatus; notes: string; clientRef: string; voidedAt: string | null;
  voidReason: string | null;
}
/**
 * One sold line with the product's name and code. `returnedQty` = how many have come back so far.
 * `extraCostCents` = cost charged above the automatic `cogsCents` (C13).
 */
export interface SaleItemRow {
  id: number; saleId: number; lineNo: number; lineType: SaleLineType; productId: number; productName: string;
  productCode: string | null; description: string; qty: number; unitPriceCents: number; unitCostCents: number;
  revenueCents: number; cogsCents: number; extraCostCents: number; returnedQty: number;
}
/** A return header: money refunded and cost (automatic and extra, C13) taken back out of cost of goods sold. */
export interface SaleReturnRow {
  id: number; saleId: number; businessDate: string; postedAt: string; refundCents: number;
  cogsReversedCents: number; extraCostReversedCents: number; note: string; clientRef: string;
}
/** One returned line; `resalable` false means the goods were damaged (written off, not restocked). */
export interface SaleReturnItemRow {
  id: number; salesReturnId: number; saleItemId: number; productId: number; productName: string; qty: number;
  resalable: boolean; revenueCents: number; cogsCents: number; extraCostCents: number;
}
/** Money totals over the posted sales matching a list filter (C13: `costCents` = automatic + extra cost). */
export interface SalesTotals {
  revenueCents: number; cogsCents: number; extraCostCents: number; costCents: number; refundsCents: number;
}
/** Running totals of what earlier returns already took back for one sale line (rule C5 remainder logic, C13). */
export interface ReturnedAmounts { qty: number; revenueCents: number; cogsCents: number; extraCostCents: number }

type N = number | bigint;
interface RawSale {
  id: N; business_date: string; posted_at: string; book: SaleBook; total_cents: N; cogs_cents: N;
  extra_cost_cents: N; status: SaleStatus; notes: string; client_ref: string; voided_at: string | null; void_reason: string | null;
}
interface RawItem {
  id: N; sale_id: N; line_no: N; line_type: SaleLineType; product_id: N; product_name: string;
  product_code: string | null; description: string; qty: N; unit_price_cents: N; unit_cost_cents: N;
  revenue_cents: N; cogs_cents: N; extra_cost_cents: N; returned_qty: N;
}
interface RawReturn {
  id: N; sale_id: N; business_date: string; posted_at: string; refund_cents: N; cogs_reversed_cents: N;
  extra_cost_reversed_cents: N; note: string; client_ref: string;
}
interface RawReturnItem {
  id: N; sales_return_id: N; sale_item_id: N; product_id: N; product_name: string; qty: N; resalable: N;
  revenue_cents: N; cogs_cents: N; extra_cost_cents: N;
}

const SALE_SELECT = `SELECT s.id, s.business_date, s.posted_at, s.book, s.total_cents,
  COALESCE((SELECT SUM(i.cogs_cents) FROM sale_items i WHERE i.sale_id = s.id), 0) AS cogs_cents,
  COALESCE((SELECT SUM(i.extra_cost_cents) FROM sale_items i WHERE i.sale_id = s.id), 0) AS extra_cost_cents,
  s.status, s.notes, s.client_ref, s.voided_at, s.void_reason FROM sales s`;

const ITEM_SELECT = `SELECT i.id, i.sale_id, i.line_no, i.line_type, i.product_id, p.name AS product_name,
  p.code AS product_code, i.description, i.qty, i.unit_price_cents, i.unit_cost_cents, i.revenue_cents,
  i.cogs_cents, i.extra_cost_cents, i.returned_qty FROM sale_items i JOIN products p ON p.id = i.product_id`;

const RETURN_SELECT = `SELECT r.id, r.sale_id, r.business_date, r.posted_at, r.refund_cents, r.cogs_reversed_cents,
  r.extra_cost_reversed_cents, r.note, r.client_ref FROM sales_returns r`;

const RETURN_ITEM_SELECT = `SELECT ri.id, ri.sales_return_id, ri.sale_item_id, i.product_id, p.name AS product_name,
  ri.qty, ri.resalable, ri.revenue_cents, ri.cogs_cents, ri.extra_cost_cents
  FROM sales_return_items ri JOIN sale_items i ON i.id = ri.sale_item_id JOIN products p ON p.id = i.product_id`;

function mapSale(r: RawSale): SaleRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, book: r.book,
    totalCents: Number(r.total_cents), cogsCents: Number(r.cogs_cents),
    extraCostCents: Number(r.extra_cost_cents), status: r.status, notes: r.notes,
    clientRef: r.client_ref, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
}
function mapItem(r: RawItem): SaleItemRow {
  return {
    id: Number(r.id), saleId: Number(r.sale_id), lineNo: Number(r.line_no), lineType: r.line_type,
    productId: Number(r.product_id), productName: r.product_name, productCode: r.product_code,
    description: r.description, qty: Number(r.qty), unitPriceCents: Number(r.unit_price_cents),
    unitCostCents: Number(r.unit_cost_cents), revenueCents: Number(r.revenue_cents),
    cogsCents: Number(r.cogs_cents), extraCostCents: Number(r.extra_cost_cents), returnedQty: Number(r.returned_qty),
  };
}
function mapReturn(r: RawReturn): SaleReturnRow {
  return {
    id: Number(r.id), saleId: Number(r.sale_id), businessDate: r.business_date, postedAt: r.posted_at,
    refundCents: Number(r.refund_cents), cogsReversedCents: Number(r.cogs_reversed_cents),
    extraCostReversedCents: Number(r.extra_cost_reversed_cents), note: r.note, clientRef: r.client_ref,
  };
}
function mapReturnItem(r: RawReturnItem): SaleReturnItemRow {
  return {
    id: Number(r.id), salesReturnId: Number(r.sales_return_id), saleItemId: Number(r.sale_item_id),
    productId: Number(r.product_id), productName: r.product_name, qty: Number(r.qty), resalable: Number(r.resalable) === 1,
    revenueCents: Number(r.revenue_cents), cogsCents: Number(r.cogs_cents),
    extraCostCents: Number(r.extra_cost_cents),
  };
}

/**
 * Inserts a sale header (status 'posted', posting time from the DB clock).
 * @param s the header; `totalCents` is the sum of its lines' revenue (the service computes it)
 * @returns the new sale id. Throws with `FUTURE_DATE_NOT_ALLOWED` (R-FD) or a UNIQUE error on a repeated
 *          `(clientRef, book)`.
 */
export function insertSale(conn: DatabaseSync, s: {
  businessDate: string; book: SaleBook; totalCents: number; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO sales (business_date, book, total_cents, notes, client_ref) VALUES (?, ?, ?, ?, ?)`,
  ).run(s.businessDate, s.book, s.totalCents, s.notes, s.clientRef);
  return Number(res.lastInsertRowid);
}

/**
 * Inserts one sale line with its frozen price and cost snapshot (C5) and its extra cost (C13).
 * @param i the line; `revenueCents` must equal `qty * unitPriceCents` (the database checks it);
 *          `extraCostCents` is the cost charged above `cogsCents` (0 when the cashier kept the automatic cost)
 * @returns the new line id. Throws `SALE_ITEM_BOOK_MISMATCH` when the line type / product book does not fit the sale.
 */
export function insertSaleItem(conn: DatabaseSync, i: {
  saleId: number; lineNo: number; lineType: SaleLineType; productId: number; description: string; qty: number;
  unitPriceCents: number; unitCostCents: number; revenueCents: number; cogsCents: number; extraCostCents: number;
}): number {
  const res = conn.prepare(
    `INSERT INTO sale_items (sale_id, line_no, line_type, product_id, description, qty, unit_price_cents,
                             unit_cost_cents, revenue_cents, cogs_cents, extra_cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(i.saleId, i.lineNo, i.lineType, i.productId, i.description, i.qty, i.unitPriceCents, i.unitCostCents,
    i.revenueCents, i.cogsCents, i.extraCostCents);
  return Number(res.lastInsertRowid);
}

/** One sale header by id, or undefined. */
export function getSale(conn: DatabaseSync, id: number): SaleRow | undefined {
  const r = conn.prepare(`${SALE_SELECT} WHERE s.id = ?`).get(id) as unknown as RawSale | undefined;
  return r ? mapSale(r) : undefined;
}

/**
 * The sale already saved under this client reference IN THIS BOOK (idempotent retry), or undefined.
 * A single cart can create one sale per book with the same reference, so the book is part of the key.
 */
export function getSaleByClientRef(conn: DatabaseSync, clientRef: string, book: SaleBook): SaleRow | undefined {
  const r = conn.prepare(`${SALE_SELECT} WHERE s.client_ref = ? AND s.book = ?`).get(clientRef, book) as unknown as RawSale | undefined;
  return r ? mapSale(r) : undefined;
}

/** The lines of one sale in receipt order (`lineNo`). */
export function listSaleItems(conn: DatabaseSync, saleId: number): SaleItemRow[] {
  const rows = conn.prepare(`${ITEM_SELECT} WHERE i.sale_id = ? ORDER BY i.line_no`).all(saleId) as unknown as RawItem[];
  return rows.map(mapItem);
}

/** One sale line by id, or undefined. */
export function getSaleItem(conn: DatabaseSync, id: number): SaleItemRow | undefined {
  const r = conn.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as unknown as RawItem | undefined;
  return r ? mapItem(r) : undefined;
}

/**
 * Lists sales, newest business date first, with the total match count and money totals over the POSTED sales
 * that match the same filter (voided sales are listed but never summed).
 * @param q `from`/`to` inclusive business dates; `productId` keeps only sales that contain that product;
 *          `limit`/`offset` page the list (totals ignore paging).
 * @returns `totals.revenueCents` = sum of sale totals, `cogsCents` = sum of line automatic costs,
 *          `extraCostCents` = sum of line extra costs (C13), `costCents` = cogs + extra, `refundsCents` = sum
 *          of refunds of returns made against those sales.
 */
export function listSales(conn: DatabaseSync, q: {
  from?: string; to?: string; book?: SaleBook; status?: SaleStatus; productId?: number; limit: number; offset: number;
}): { items: SaleRow[]; total: number; totals: SalesTotals } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('s.business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('s.business_date <= ?'); params.push(q.to); }
  if (q.book !== undefined) { where.push('s.book = ?'); params.push(q.book); }
  if (q.status !== undefined) { where.push('s.status = ?'); params.push(q.status); }
  if (q.productId !== undefined) {
    where.push('EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_id = s.id AND x.product_id = ?)');
    params.push(q.productId);
  }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const posted = `${w ? `${w} AND` : ' WHERE'} s.status = 'posted'`;
  const total = Number((conn.prepare(`SELECT COUNT(*) AS n FROM sales s${w}`).get(...params) as unknown as { n: N }).n);
  const revenue = (conn.prepare(`SELECT COALESCE(SUM(s.total_cents), 0) AS v FROM sales s${posted}`)
    .get(...params) as unknown as { v: N }).v;
  const cost = conn.prepare(
    `SELECT COALESCE(SUM(i.cogs_cents), 0) AS c, COALESCE(SUM(i.extra_cost_cents), 0) AS x
     FROM sale_items i JOIN sales s ON s.id = i.sale_id${posted}`,
  ).get(...params) as unknown as { c: N; x: N };
  const cogsCents = Number(cost.c);
  const extraCostCents = Number(cost.x);
  const refunds = (conn.prepare(
    `SELECT COALESCE(SUM(r.refund_cents), 0) AS v FROM sales_returns r JOIN sales s ON s.id = r.sale_id${posted}`,
  ).get(...params) as unknown as { v: N }).v;
  const rows = conn.prepare(`${SALE_SELECT}${w} ORDER BY s.business_date DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawSale[];
  return {
    items: rows.map(mapSale), total,
    totals: {
      revenueCents: Number(revenue), cogsCents, extraCostCents, costCents: cogsCents + extraCostCents,
      refundsCents: Number(refunds),
    },
  };
}

/** posted -> void; the DB triggers forbid anything else. `voided_at` is the DB clock (= void posting time). */
export function markSaleVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(
    `UPDATE sales SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`,
  ).run(reason, id);
}

/**
 * Adds to a line's returned quantity (the only thing a sale line may ever change; it can never go down).
 * Call it AFTER inserting the return lines. The DB refuses a total above the quantity sold.
 */
export function addReturnedQty(conn: DatabaseSync, saleItemId: number, qty: number): void {
  conn.prepare(`UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ?`).run(qty, saleItemId);
}

/**
 * Inserts a return header (posting time from the DB clock).
 * @returns the new return id. Throws `RETURN_BEFORE_ORIGINAL_DATE` (R-RD), `FUTURE_DATE_NOT_ALLOWED` (R-FD)
 *          or `SALE_VOID` from the database triggers.
 */
export function insertSaleReturn(conn: DatabaseSync, r: {
  saleId: number; businessDate: string; refundCents: number; cogsReversedCents: number; extraCostReversedCents: number; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO sales_returns (sale_id, business_date, refund_cents, cogs_reversed_cents, extra_cost_reversed_cents,
                                note, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.saleId, r.businessDate, r.refundCents, r.cogsReversedCents, r.extraCostReversedCents, r.note, r.clientRef);
  return Number(res.lastInsertRowid);
}

/**
 * Inserts one returned line. Throws `RETURN_ITEM_MISMATCH` (line of another sale), `RETURN_EXCEEDS_SOLD` or
 * `RETURN_EXCEEDS_EXTRA_COST` (C13 backstop).
 * @returns the new return-line id.
 */
export function insertSaleReturnItem(conn: DatabaseSync, i: {
  salesReturnId: number; saleItemId: number; qty: number; resalable: boolean; revenueCents: number; cogsCents: number;
  extraCostCents: number;
}): number {
  const res = conn.prepare(
    `INSERT INTO sales_return_items (sales_return_id, sale_item_id, qty, resalable, revenue_cents, cogs_cents,
                                     extra_cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(i.salesReturnId, i.saleItemId, i.qty, i.resalable ? 1 : 0, i.revenueCents, i.cogsCents, i.extraCostCents);
  return Number(res.lastInsertRowid);
}

/** One return header by id, or undefined. */
export function getSaleReturn(conn: DatabaseSync, id: number): SaleReturnRow | undefined {
  const r = conn.prepare(`${RETURN_SELECT} WHERE r.id = ?`).get(id) as unknown as RawReturn | undefined;
  return r ? mapReturn(r) : undefined;
}

/** The return already saved under this client reference (idempotent retry), or undefined. */
export function getSaleReturnByClientRef(conn: DatabaseSync, clientRef: string): SaleReturnRow | undefined {
  const r = conn.prepare(`${RETURN_SELECT} WHERE r.client_ref = ?`).get(clientRef) as unknown as RawReturn | undefined;
  return r ? mapReturn(r) : undefined;
}

/** All returns of one sale, oldest first. */
export function listSaleReturns(conn: DatabaseSync, saleId: number): SaleReturnRow[] {
  const rows = conn.prepare(`${RETURN_SELECT} WHERE r.sale_id = ? ORDER BY r.id`).all(saleId) as unknown as RawReturn[];
  return rows.map(mapReturn);
}

/** The lines of one return, in entry order. */
export function listSaleReturnItems(conn: DatabaseSync, salesReturnId: number): SaleReturnItemRow[] {
  const rows = conn.prepare(`${RETURN_ITEM_SELECT} WHERE ri.sales_return_id = ? ORDER BY ri.id`)
    .all(salesReturnId) as unknown as RawReturnItem[];
  return rows.map(mapReturnItem);
}

/**
 * What earlier returns already took back for one sale line: total quantity, revenue, automatic cost and extra cost (C13). The service
 * uses it to give the LAST return the exact remainder so the portions add up to the line with no rounding gap (C5).
 */
export function returnedAmountsSoFar(conn: DatabaseSync, saleItemId: number): ReturnedAmounts {
  const r = conn.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS q, COALESCE(SUM(revenue_cents), 0) AS rev, COALESCE(SUM(cogs_cents), 0) AS cogs,
            COALESCE(SUM(extra_cost_cents), 0) AS extra
     FROM sales_return_items WHERE sale_item_id = ?`,
  ).get(saleItemId) as unknown as { q: N; rev: N; cogs: N; extra: N };
  return {
    qty: Number(r.q), revenueCents: Number(r.rev), cogsCents: Number(r.cogs), extraCostCents: Number(r.extra),
  };
}
