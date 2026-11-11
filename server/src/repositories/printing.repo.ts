/**
 * repositories/printing.repo.ts - SQL for `print_service_types`, `print_sales` and `printing_supplies` (migration 010).
 *
 * Layer: repository (SQL only, no business rules). Print sales and supplies are never deleted; a void marks
 * `status = 'void'` (R1) and the triggers of migration 010 forbid every other edit. `client_ref` is unique so a
 * double submit cannot create two rows. List totals count POSTED rows only (voided rows are shown, not summed).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC } from './sql-helpers.ts';

export type PrintStatus = 'posted' | 'void';
type N = number | bigint;

// ---------------------------------------------------------------------------------------------
// service types
// ---------------------------------------------------------------------------------------------

/** One print service type (the price list entry). */
export interface ServiceTypeRow {
  id: number; code: string; name: string; priceCents: number; costCents: number; active: boolean; sortOrder: number;
}
interface RawType { id: N; code: string; name: string; price_cents: N; cost_cents: N; active: N; sort_order: N }

const TYPE_SELECT = 'SELECT id, code, name, price_cents, cost_cents, active, sort_order FROM print_service_types';

function mapType(r: RawType): ServiceTypeRow {
  return {
    id: Number(r.id), code: r.code, name: r.name, priceCents: Number(r.price_cents), costCents: Number(r.cost_cents),
    active: Number(r.active) === 1, sortOrder: Number(r.sort_order),
  };
}

/** All service types in display order (`sort_order`, then id); `active` limits the list to active/inactive ones. */
export function listServiceTypes(conn: DatabaseSync, active?: boolean): ServiceTypeRow[] {
  const rows = (active === undefined
    ? conn.prepare(`${TYPE_SELECT} ORDER BY sort_order, id`).all()
    : conn.prepare(`${TYPE_SELECT} WHERE active = ? ORDER BY sort_order, id`).all(active ? 1 : 0)) as unknown as RawType[];
  return rows.map(mapType);
}

/** One service type by id, or undefined. */
export function getServiceType(conn: DatabaseSync, id: number): ServiceTypeRow | undefined {
  const r = conn.prepare(`${TYPE_SELECT} WHERE id = ?`).get(id) as unknown as RawType | undefined;
  return r ? mapType(r) : undefined;
}

/** One service type by its (unique, permanent) code, or undefined. */
export function getServiceTypeByCode(conn: DatabaseSync, code: string): ServiceTypeRow | undefined {
  const r = conn.prepare(`${TYPE_SELECT} WHERE code = ?`).get(code) as unknown as RawType | undefined;
  return r ? mapType(r) : undefined;
}

/** Adds a new, active service type at the end of the list; returns its id. */
export function insertServiceType(conn: DatabaseSync, t: { code: string; name: string; priceCents: number; costCents: number }): number {
  const next = conn.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM print_service_types').get() as unknown as { n: N };
  const res = conn.prepare(
    'INSERT INTO print_service_types (code, name, price_cents, cost_cents, active, sort_order) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(t.code, t.name, t.priceCents, t.costCents, Number(next.n));
  return Number(res.lastInsertRowid);
}

/** Updates the editable fields of a type (the code never changes). */
export function updateServiceType(conn: DatabaseSync, id: number, t: { name: string; priceCents: number; costCents: number; active: boolean }): void {
  conn.prepare('UPDATE print_service_types SET name = ?, price_cents = ?, cost_cents = ?, active = ? WHERE id = ?')
    .run(t.name, t.priceCents, t.costCents, t.active ? 1 : 0, id);
}

// ---------------------------------------------------------------------------------------------
// print sales
// ---------------------------------------------------------------------------------------------

/** One print sale with the code of its service type. */
export interface PrintSaleRow {
  id: number; businessDate: string; postedAt: string; serviceTypeId: number; serviceTypeCode: string; description: string;
  qty: number; unitPriceCents: number; unitCostCents: number; revenueCents: number; cogsCents: number;
  status: PrintStatus; voidedAt: string | null; voidReason: string | null; notes: string; clientRef: string;
}
interface RawSale {
  id: N; business_date: string; posted_at: string; service_type_id: N; code: string; description: string; qty: N;
  unit_price_cents: N; unit_cost_cents: N; revenue_cents: N; cogs_cents: N; status: PrintStatus;
  voided_at: string | null; void_reason: string | null; notes: string; client_ref: string;
}

const SALE_SELECT = `SELECT s.id, s.business_date, s.posted_at, s.service_type_id, t.code, s.description, s.qty,
  s.unit_price_cents, s.unit_cost_cents, s.revenue_cents, s.cogs_cents, s.status, s.voided_at, s.void_reason,
  s.notes, s.client_ref
  FROM print_sales s JOIN print_service_types t ON t.id = s.service_type_id`;

function mapSale(r: RawSale): PrintSaleRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, serviceTypeId: Number(r.service_type_id),
    serviceTypeCode: r.code, description: r.description, qty: Number(r.qty), unitPriceCents: Number(r.unit_price_cents),
    unitCostCents: Number(r.unit_cost_cents), revenueCents: Number(r.revenue_cents), cogsCents: Number(r.cogs_cents),
    status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason, notes: r.notes, clientRef: r.client_ref,
  };
}

/** Inserts a print sale (status 'posted', posting time from the DB clock) and returns its id. */
export function insertPrintSale(conn: DatabaseSync, s: {
  businessDate: string; serviceTypeId: number; description: string; qty: number; unitPriceCents: number;
  unitCostCents: number; revenueCents: number; cogsCents: number; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO print_sales (business_date, service_type_id, description, qty, unit_price_cents, unit_cost_cents,
       revenue_cents, cogs_cents, notes, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.businessDate, s.serviceTypeId, s.description, s.qty, s.unitPriceCents, s.unitCostCents, s.revenueCents,
    s.cogsCents, s.notes, s.clientRef);
  return Number(res.lastInsertRowid);
}

/** One print sale by id, or undefined. */
export function getPrintSale(conn: DatabaseSync, id: number): PrintSaleRow | undefined {
  const r = conn.prepare(`${SALE_SELECT} WHERE s.id = ?`).get(id) as unknown as RawSale | undefined;
  return r ? mapSale(r) : undefined;
}

/** The print sale already saved under this client reference (idempotent retry), or undefined. */
export function getPrintSaleByClientRef(conn: DatabaseSync, ref: string): PrintSaleRow | undefined {
  const r = conn.prepare(`${SALE_SELECT} WHERE s.client_ref = ?`).get(ref) as unknown as RawSale | undefined;
  return r ? mapSale(r) : undefined;
}

/** Filters of the print-sale list; `from`/`to` are inclusive business dates. */
export interface PrintSaleFilter { from?: string; to?: string; serviceTypeId?: number; status?: PrintStatus }

/** Builds the shared WHERE clause of a list/total query. */
function saleWhere(q: PrintSaleFilter): { sql: string; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('s.business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('s.business_date <= ?'); params.push(q.to); }
  if (q.serviceTypeId !== undefined) { where.push('s.service_type_id = ?'); params.push(q.serviceTypeId); }
  if (q.status !== undefined) { where.push('s.status = ?'); params.push(q.status); }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Lists print sales (newest business date first) with the match count and the revenue / standard-cost totals of
 * the POSTED matches. Gross profit is derived by the service (revenue - cost).
 */
export function listPrintSales(conn: DatabaseSync, q: PrintSaleFilter & { limit: number; offset: number }): {
  items: PrintSaleRow[]; total: number; revenueCents: number; cogsCents: number;
} {
  const w = saleWhere(q);
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.revenue_cents END), 0) AS rev,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.cogs_cents END), 0) AS cogs
     FROM print_sales s${w.sql}`,
  ).get(...w.params) as unknown as { n: N; rev: N; cogs: N };
  const rows = conn.prepare(`${SALE_SELECT}${w.sql} ORDER BY s.business_date DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...w.params, q.limit, q.offset) as unknown as RawSale[];
  return { items: rows.map(mapSale), total: Number(agg.n), revenueCents: Number(agg.rev), cogsCents: Number(agg.cogs) };
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markPrintSaleVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE print_sales SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

// ---------------------------------------------------------------------------------------------
// printing supplies
// ---------------------------------------------------------------------------------------------

/** One paper/toner purchase. */
export interface SupplyRow {
  id: number; businessDate: string; postedAt: string; amountCents: number; description: string; status: PrintStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}
interface RawSupply {
  id: N; business_date: string; posted_at: string; amount_cents: N; description: string; status: PrintStatus;
  voided_at: string | null; void_reason: string | null; client_ref: string;
}

const SUPPLY_SELECT = `SELECT id, business_date, posted_at, amount_cents, description, status, voided_at, void_reason,
  client_ref FROM printing_supplies`;

function mapSupply(r: RawSupply): SupplyRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, amountCents: Number(r.amount_cents),
    description: r.description, status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason, clientRef: r.client_ref,
  };
}

/** Inserts a supplies purchase (status 'posted', posting time from the DB clock) and returns its id. */
export function insertSupply(conn: DatabaseSync, s: { businessDate: string; amountCents: number; description: string; clientRef: string }): number {
  const res = conn.prepare('INSERT INTO printing_supplies (business_date, amount_cents, description, client_ref) VALUES (?, ?, ?, ?)')
    .run(s.businessDate, s.amountCents, s.description, s.clientRef);
  return Number(res.lastInsertRowid);
}

/** One supplies purchase by id, or undefined. */
export function getSupply(conn: DatabaseSync, id: number): SupplyRow | undefined {
  const r = conn.prepare(`${SUPPLY_SELECT} WHERE id = ?`).get(id) as unknown as RawSupply | undefined;
  return r ? mapSupply(r) : undefined;
}

/** The supplies purchase already saved under this client reference (idempotent retry), or undefined. */
export function getSupplyByClientRef(conn: DatabaseSync, ref: string): SupplyRow | undefined {
  const r = conn.prepare(`${SUPPLY_SELECT} WHERE client_ref = ?`).get(ref) as unknown as RawSupply | undefined;
  return r ? mapSupply(r) : undefined;
}

/** Lists supplies purchases (newest business date first) with the match count and the total of POSTED amounts. */
export function listSupplies(conn: DatabaseSync, q: { from?: string; to?: string; status?: PrintStatus; limit: number; offset: number }): {
  items: SupplyRow[]; total: number; amountCents: number;
} {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_cents END), 0) AS amt FROM printing_supplies${w}`,
  ).get(...params) as unknown as { n: N; amt: N };
  const rows = conn.prepare(`${SUPPLY_SELECT}${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawSupply[];
  return { items: rows.map(mapSupply), total: Number(agg.n), amountCents: Number(agg.amt) };
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markSupplyVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE printing_supplies SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}
