/**
 * repositories/telecom.repo.ts - SQL for the Phase 6 telecom tables (migration 009): `reload_providers`,
 * `reload_sales`, `ezcash_sales` and `telecom_topups`, plus the period summary query.
 *
 * Layer: repository (SQL only, no business rules). Rows are never deleted; a void marks `status = 'void'` (R1) and
 * the triggers of migration 009 forbid every other edit. `client_ref` is unique so a double submit cannot create
 * two rows. Totals and summaries add up POSTED rows only (voided rows stay listed but never count, R1).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC, numberOrNull } from './sql-helpers.ts';

type N = number | bigint;
export type TelecomStatus = 'posted' | 'void';
export type TopupKind = 'provider_topup' | 'wallet_topup';

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

/** One reload provider; `ownCommissionBp` null means "use the shop default rate". */
export interface ProviderRow { id: number; name: string; ownCommissionBp: number | null; active: boolean; sortOrder: number }
interface RawProvider { id: N; name: string; commission_bp: N | null; active: N; sort_order: N }

function mapProvider(r: RawProvider): ProviderRow {
  return { id: Number(r.id), name: r.name, ownCommissionBp: numberOrNull(r.commission_bp), active: Number(r.active) === 1, sortOrder: Number(r.sort_order) };
}

/** All providers in display order. */
export function listProviders(conn: DatabaseSync): ProviderRow[] {
  const rows = conn.prepare('SELECT id, name, commission_bp, active, sort_order FROM reload_providers ORDER BY sort_order, id')
    .all() as unknown as RawProvider[];
  return rows.map(mapProvider);
}

/** One provider by id, or undefined. */
export function getProvider(conn: DatabaseSync, id: number): ProviderRow | undefined {
  const r = conn.prepare('SELECT id, name, commission_bp, active, sort_order FROM reload_providers WHERE id = ?')
    .get(id) as unknown as RawProvider | undefined;
  return r ? mapProvider(r) : undefined;
}

/** The provider with this exact name (used to find Dialog for EZCash), or undefined. */
export function getProviderByName(conn: DatabaseSync, name: string): ProviderRow | undefined {
  const r = conn.prepare('SELECT id, name, commission_bp, active, sort_order FROM reload_providers WHERE name = ?')
    .get(name) as unknown as RawProvider | undefined;
  return r ? mapProvider(r) : undefined;
}

/** Updates the only editable provider fields: its own rate (null = shop default) and the active flag. */
export function updateProvider(conn: DatabaseSync, id: number, v: { commissionBp: number | null; active: boolean }): void {
  conn.prepare('UPDATE reload_providers SET commission_bp = ?, active = ? WHERE id = ?').run(v.commissionBp, v.active ? 1 : 0, id);
}

// ---------------------------------------------------------------------------------------------
// Shared list helpers
// ---------------------------------------------------------------------------------------------

/** Filters common to every telecom list (`from`/`to` are inclusive business dates). */
interface BaseFilter { from?: string; to?: string; status?: TelecomStatus; providerId?: number }

/** Builds " WHERE ..." plus parameters for the common filters (`alias` is the table alias). */
function where(alias: string, q: BaseFilter, extra: string[] = [], extraParams: SQLInputValue[] = []): { sql: string; params: SQLInputValue[] } {
  const w: string[] = [...extra];
  const params: SQLInputValue[] = [...extraParams];
  if (q.from !== undefined) { w.push(`${alias}.business_date >= ?`); params.push(q.from); }
  if (q.to !== undefined) { w.push(`${alias}.business_date <= ?`); params.push(q.to); }
  if (q.providerId !== undefined) { w.push(`${alias}.provider_id = ?`); params.push(q.providerId); }
  if (q.status !== undefined) { w.push(`${alias}.status = ?`); params.push(q.status); }
  return { sql: w.length ? ` WHERE ${w.join(' AND ')}` : '', params };
}

// ---------------------------------------------------------------------------------------------
// Reload sales
// ---------------------------------------------------------------------------------------------

/** One reload entry. `commissionCents` already includes `extraCents`. */
export interface ReloadSaleRow {
  id: number; businessDate: string; postedAt: string; providerId: number; providerName: string; salesCents: number;
  commissionBp: number; extraCents: number; commissionCents: number; status: TelecomStatus; voidedAt: string | null;
  voidReason: string | null; notes: string; clientRef: string;
}
interface RawReload {
  id: N; business_date: string; posted_at: string; provider_id: N; provider_name: string; sales_cents: N; commission_bp: N;
  extra_cents: N; commission_cents: N; status: TelecomStatus; voided_at: string | null; void_reason: string | null;
  notes: string; client_ref: string;
}
const RELOAD_SELECT = `SELECT s.id, s.business_date, s.posted_at, s.provider_id, p.name AS provider_name, s.sales_cents,
  s.commission_bp, s.extra_cents, s.commission_cents, s.status, s.voided_at, s.void_reason, s.notes, s.client_ref
  FROM reload_sales s JOIN reload_providers p ON p.id = s.provider_id`;

function mapReload(r: RawReload): ReloadSaleRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, providerId: Number(r.provider_id),
    providerName: r.provider_name, salesCents: Number(r.sales_cents), commissionBp: Number(r.commission_bp),
    extraCents: Number(r.extra_cents), commissionCents: Number(r.commission_cents), status: r.status,
    voidedAt: r.voided_at, voidReason: r.void_reason, notes: r.notes, clientRef: r.client_ref,
  };
}

/** Inserts a reload entry (status 'posted', posting time from the DB clock) and returns its id. */
export function insertReloadSale(conn: DatabaseSync, s: {
  businessDate: string; providerId: number; salesCents: number; commissionBp: number; extraCents: number;
  commissionCents: number; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO reload_sales (business_date, provider_id, sales_cents, commission_bp, extra_cents, commission_cents, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.businessDate, s.providerId, s.salesCents, s.commissionBp, s.extraCents, s.commissionCents, s.notes, s.clientRef);
  return Number(res.lastInsertRowid);
}

/** One reload entry by id, or undefined. */
export function getReloadSale(conn: DatabaseSync, id: number): ReloadSaleRow | undefined {
  const r = conn.prepare(`${RELOAD_SELECT} WHERE s.id = ?`).get(id) as unknown as RawReload | undefined;
  return r ? mapReload(r) : undefined;
}

/** The reload entry already saved under this client reference (idempotent retry), or undefined. */
export function getReloadSaleByClientRef(conn: DatabaseSync, ref: string): ReloadSaleRow | undefined {
  const r = conn.prepare(`${RELOAD_SELECT} WHERE s.client_ref = ?`).get(ref) as unknown as RawReload | undefined;
  return r ? mapReload(r) : undefined;
}

/** Lists reload entries newest business date first, with the count and the sums of POSTED rows that match. */
export function listReloadSales(conn: DatabaseSync, q: BaseFilter & { limit: number; offset: number }): {
  items: ReloadSaleRow[]; total: number; totals: { salesCents: number; commissionCents: number; extraCents: number };
} {
  const w = where('s', q);
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.sales_cents END), 0) AS sales,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.commission_cents END), 0) AS commission,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.extra_cents END), 0) AS extra
     FROM reload_sales s${w.sql}`,
  ).get(...w.params) as unknown as { n: N; sales: N; commission: N; extra: N };
  const rows = conn.prepare(`${RELOAD_SELECT}${w.sql} ORDER BY s.business_date DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...w.params, q.limit, q.offset) as unknown as RawReload[];
  return {
    items: rows.map(mapReload), total: Number(agg.n),
    totals: { salesCents: Number(agg.sales), commissionCents: Number(agg.commission), extraCents: Number(agg.extra) },
  };
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markReloadSaleVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE reload_sales SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

// ---------------------------------------------------------------------------------------------
// EZCash sales
// ---------------------------------------------------------------------------------------------

/** One EZCash bill collection. */
export interface EzCashSaleRow {
  id: number; businessDate: string; postedAt: string; providerId: number; providerName: string; billTotalCents: number;
  commissionBp: number; commissionCents: number; status: TelecomStatus; voidedAt: string | null; voidReason: string | null;
  notes: string; clientRef: string;
}
interface RawEz {
  id: N; business_date: string; posted_at: string; provider_id: N; provider_name: string; bill_total_cents: N;
  commission_bp: N; commission_cents: N; status: TelecomStatus; voided_at: string | null; void_reason: string | null;
  notes: string; client_ref: string;
}
const EZ_SELECT = `SELECT s.id, s.business_date, s.posted_at, s.provider_id, p.name AS provider_name, s.bill_total_cents,
  s.commission_bp, s.commission_cents, s.status, s.voided_at, s.void_reason, s.notes, s.client_ref
  FROM ezcash_sales s JOIN reload_providers p ON p.id = s.provider_id`;

function mapEz(r: RawEz): EzCashSaleRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, providerId: Number(r.provider_id),
    providerName: r.provider_name, billTotalCents: Number(r.bill_total_cents), commissionBp: Number(r.commission_bp),
    commissionCents: Number(r.commission_cents), status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason,
    notes: r.notes, clientRef: r.client_ref,
  };
}

/** Inserts an EZCash entry and returns its id. */
export function insertEzCashSale(conn: DatabaseSync, s: {
  businessDate: string; providerId: number; billTotalCents: number; commissionBp: number; commissionCents: number;
  notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO ezcash_sales (business_date, provider_id, bill_total_cents, commission_bp, commission_cents, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.businessDate, s.providerId, s.billTotalCents, s.commissionBp, s.commissionCents, s.notes, s.clientRef);
  return Number(res.lastInsertRowid);
}

/** One EZCash entry by id, or undefined. */
export function getEzCashSale(conn: DatabaseSync, id: number): EzCashSaleRow | undefined {
  const r = conn.prepare(`${EZ_SELECT} WHERE s.id = ?`).get(id) as unknown as RawEz | undefined;
  return r ? mapEz(r) : undefined;
}

/** The EZCash entry already saved under this client reference, or undefined. */
export function getEzCashSaleByClientRef(conn: DatabaseSync, ref: string): EzCashSaleRow | undefined {
  const r = conn.prepare(`${EZ_SELECT} WHERE s.client_ref = ?`).get(ref) as unknown as RawEz | undefined;
  return r ? mapEz(r) : undefined;
}

/** Lists EZCash entries newest first with the count and the sums of POSTED rows that match. */
export function listEzCashSales(conn: DatabaseSync, q: BaseFilter & { limit: number; offset: number }): {
  items: EzCashSaleRow[]; total: number; totals: { billTotalCents: number; commissionCents: number };
} {
  const w = where('s', q);
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.bill_total_cents END), 0) AS bills,
       COALESCE(SUM(CASE WHEN s.status = 'posted' THEN s.commission_cents END), 0) AS commission
     FROM ezcash_sales s${w.sql}`,
  ).get(...w.params) as unknown as { n: N; bills: N; commission: N };
  const rows = conn.prepare(`${EZ_SELECT}${w.sql} ORDER BY s.business_date DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...w.params, q.limit, q.offset) as unknown as RawEz[];
  return { items: rows.map(mapEz), total: Number(agg.n), totals: { billTotalCents: Number(agg.bills), commissionCents: Number(agg.commission) } };
}

/** posted -> void. */
export function markEzCashSaleVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE ezcash_sales SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

// ---------------------------------------------------------------------------------------------
// Top-ups
// ---------------------------------------------------------------------------------------------

/** One top-up; `providerId`/`providerName` are null for a wallet top-up. */
export interface TopupRow {
  id: number; businessDate: string; postedAt: string; kind: TopupKind; providerId: number | null; providerName: string | null;
  amountCents: number; status: TelecomStatus; voidedAt: string | null; voidReason: string | null; notes: string; clientRef: string;
}
interface RawTopup {
  id: N; business_date: string; posted_at: string; kind: TopupKind; provider_id: N | null; provider_name: string | null;
  amount_cents: N; status: TelecomStatus; voided_at: string | null; void_reason: string | null; notes: string; client_ref: string;
}
const TOPUP_SELECT = `SELECT t.id, t.business_date, t.posted_at, t.kind, t.provider_id, p.name AS provider_name, t.amount_cents,
  t.status, t.voided_at, t.void_reason, t.notes, t.client_ref
  FROM telecom_topups t LEFT JOIN reload_providers p ON p.id = t.provider_id`;

function mapTopup(r: RawTopup): TopupRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, kind: r.kind, providerId: numberOrNull(r.provider_id),
    providerName: r.provider_name, amountCents: Number(r.amount_cents), status: r.status, voidedAt: r.voided_at,
    voidReason: r.void_reason, notes: r.notes, clientRef: r.client_ref,
  };
}

/** Inserts a top-up and returns its id. */
export function insertTopup(conn: DatabaseSync, t: {
  businessDate: string; kind: TopupKind; providerId: number | null; amountCents: number; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO telecom_topups (business_date, kind, provider_id, amount_cents, notes, client_ref) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(t.businessDate, t.kind, t.providerId, t.amountCents, t.notes, t.clientRef);
  return Number(res.lastInsertRowid);
}

/** One top-up by id, or undefined. */
export function getTopup(conn: DatabaseSync, id: number): TopupRow | undefined {
  const r = conn.prepare(`${TOPUP_SELECT} WHERE t.id = ?`).get(id) as unknown as RawTopup | undefined;
  return r ? mapTopup(r) : undefined;
}

/** The top-up already saved under this client reference, or undefined. */
export function getTopupByClientRef(conn: DatabaseSync, ref: string): TopupRow | undefined {
  const r = conn.prepare(`${TOPUP_SELECT} WHERE t.client_ref = ?`).get(ref) as unknown as RawTopup | undefined;
  return r ? mapTopup(r) : undefined;
}

/** Lists top-ups newest first with the count and POSTED sums split by kind. */
export function listTopups(conn: DatabaseSync, q: BaseFilter & { kind?: TopupKind; limit: number; offset: number }): {
  items: TopupRow[]; total: number; totals: { providerTopupCents: number; walletTopupCents: number; totalCents: number };
} {
  const extra: string[] = [];
  const extraParams: SQLInputValue[] = [];
  if (q.kind !== undefined) { extra.push('t.kind = ?'); extraParams.push(q.kind); }
  const w = where('t', q, extra, extraParams);
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN t.status = 'posted' AND t.kind = 'provider_topup' THEN t.amount_cents END), 0) AS provider,
       COALESCE(SUM(CASE WHEN t.status = 'posted' AND t.kind = 'wallet_topup' THEN t.amount_cents END), 0) AS wallet
     FROM telecom_topups t${w.sql}`,
  ).get(...w.params) as unknown as { n: N; provider: N; wallet: N };
  const rows = conn.prepare(`${TOPUP_SELECT}${w.sql} ORDER BY t.business_date DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...w.params, q.limit, q.offset) as unknown as RawTopup[];
  const provider = Number(agg.provider);
  const wallet = Number(agg.wallet);
  return { items: rows.map(mapTopup), total: Number(agg.n), totals: { providerTopupCents: provider, walletTopupCents: wallet, totalCents: provider + wallet } };
}

/** posted -> void. */
export function markTopupVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE telecom_topups SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

/** Posted totals of one provider for a period (every figure in cents). */
export interface ProviderTotalsRow {
  providerId: number; name: string; reloadSalesCents: number; reloadCommissionCents: number; reloadExtraCents: number;
  ezcashBillCents: number; ezcashCommissionCents: number; providerTopupsCents: number;
}

/** Posted wallet top-ups of the period (the wallet belongs to no provider). */
export interface WalletTotals { walletTopupsCents: number }

/**
 * Posted totals per provider (all four providers always appear, zeros included) and the wallet top-up total, for
 * the inclusive business-date range `from`..`to` (either may be omitted). Each source table is summed on its own
 * so a join can never multiply rows.
 */
export function summaryTotals(conn: DatabaseSync, q: { from?: string; to?: string }): { providers: ProviderTotalsRow[]; wallet: WalletTotals } {
  const dateSql = (alias: string): { sql: string; params: SQLInputValue[] } => {
    const w: string[] = [`${alias}.status = 'posted'`];
    const params: SQLInputValue[] = [];
    if (q.from !== undefined) { w.push(`${alias}.business_date >= ?`); params.push(q.from); }
    if (q.to !== undefined) { w.push(`${alias}.business_date <= ?`); params.push(q.to); }
    return { sql: w.join(' AND '), params };
  };
  const reload = dateSql('s');
  const ez = dateSql('e');
  const top = dateSql('t');
  const rows = conn.prepare(
    `SELECT p.id, p.name,
       COALESCE((SELECT SUM(s.sales_cents) FROM reload_sales s WHERE s.provider_id = p.id AND ${reload.sql}), 0) AS reload_sales,
       COALESCE((SELECT SUM(s.commission_cents) FROM reload_sales s WHERE s.provider_id = p.id AND ${reload.sql}), 0) AS reload_comm,
       COALESCE((SELECT SUM(s.extra_cents) FROM reload_sales s WHERE s.provider_id = p.id AND ${reload.sql}), 0) AS reload_extra,
       COALESCE((SELECT SUM(e.bill_total_cents) FROM ezcash_sales e WHERE e.provider_id = p.id AND ${ez.sql}), 0) AS ez_bill,
       COALESCE((SELECT SUM(e.commission_cents) FROM ezcash_sales e WHERE e.provider_id = p.id AND ${ez.sql}), 0) AS ez_comm,
       COALESCE((SELECT SUM(t.amount_cents) FROM telecom_topups t
                 WHERE t.provider_id = p.id AND t.kind = 'provider_topup' AND ${top.sql}), 0) AS topups
     FROM reload_providers p ORDER BY p.sort_order, p.id`,
  ).all(...reload.params, ...reload.params, ...reload.params, ...ez.params, ...ez.params, ...top.params) as unknown as Array<{
    id: N; name: string; reload_sales: N; reload_comm: N; reload_extra: N; ez_bill: N; ez_comm: N; topups: N;
  }>;
  const wallet = conn.prepare(
    `SELECT COALESCE(SUM(t.amount_cents), 0) AS total FROM telecom_topups t WHERE t.kind = 'wallet_topup' AND ${top.sql}`,
  ).get(...top.params) as unknown as { total: N };
  return {
    providers: rows.map((r) => ({
      providerId: Number(r.id), name: r.name, reloadSalesCents: Number(r.reload_sales), reloadCommissionCents: Number(r.reload_comm),
      reloadExtraCents: Number(r.reload_extra), ezcashBillCents: Number(r.ez_bill), ezcashCommissionCents: Number(r.ez_comm),
      providerTopupsCents: Number(r.topups),
    })),
    wallet: { walletTopupsCents: Number(wallet.total) },
  };
}
