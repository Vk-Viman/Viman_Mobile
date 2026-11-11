/**
 * repositories/opening-stock.repo.ts - SQL for `opening_stock_batches`, `import_runs` and `import_issues`.
 *
 * Layer: repository (SQL only, no business rules). An opening stock batch is the header of the go-live stock
 * entry (manual or Excel). Its LINES are not stored here: they are the `opening` rows of `stock_movements`
 * that point at the batch (`ref_table = 'opening_stock_batches'`), written by the inventory engine
 * (BUSINESS_RULES section 3). Batches are never deleted: a void marks `status = 'void'` (R1); the migration 011
 * triggers forbid any other change. `import_runs` / `import_issues` are an append-only audit of every Excel
 * preview and import attempt. The rules (R-FD, duplicate files, all-or-nothing) live in the service.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC, numberOrNull } from './sql-helpers.ts';

export type BatchSource = 'manual' | 'excel';
export type BatchStatus = 'posted' | 'void';
export type RunMode = 'preview' | 'commit';
export type RunStatus = 'previewed' | 'committed' | 'rejected';

/** One batch header. */
export interface BatchRow {
  id: number; businessDate: string; postedAt: string; source: BatchSource; fileName: string | null;
  rowCount: number; totalValueCents: number; status: BatchStatus; voidedAt: string | null;
  voidReason: string | null; notes: string; clientRef: string;
}

/** One import attempt (preview or import). */
export interface ImportRunRow {
  id: number; kind: 'opening_stock'; fileName: string; fileSha256: string; businessDate: string;
  mode: RunMode; status: RunStatus; rowsTotal: number; rowsOk: number; rowsFailed: number;
  batchId: number | null; createdAt: string;
}

/** One problem found in an import file (`rowNo` 0 = the whole file / the date). */
export interface ImportIssueRow {
  id: number; importRunId: number; rowNo: number; columnName: string; code: string; message: string;
}

type N = number | bigint;
interface RawBatch {
  id: N; business_date: string; posted_at: string; source: BatchSource; file_name: string | null;
  row_count: N; total_value_cents: N; status: BatchStatus; voided_at: string | null; void_reason: string | null;
  notes: string; client_ref: string;
}
interface RawRun {
  id: N; kind: 'opening_stock'; file_name: string; file_sha256: string; business_date: string; mode: RunMode;
  status: RunStatus; rows_total: N; rows_ok: N; rows_failed: N; batch_id: N | null; created_at: string;
}
interface RawIssue { id: N; import_run_id: N; row_no: N; column_name: string; code: string; message: string }

const BATCH_SELECT = `SELECT id, business_date, posted_at, source, file_name, row_count, total_value_cents, status,
  voided_at, void_reason, notes, client_ref FROM opening_stock_batches`;

function mapBatch(r: RawBatch): BatchRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, source: r.source, fileName: r.file_name,
    rowCount: Number(r.row_count), totalValueCents: Number(r.total_value_cents), status: r.status,
    voidedAt: r.voided_at, voidReason: r.void_reason, notes: r.notes, clientRef: r.client_ref,
  };
}

function mapRun(r: RawRun): ImportRunRow {
  return {
    id: Number(r.id), kind: r.kind, fileName: r.file_name, fileSha256: r.file_sha256, businessDate: r.business_date,
    mode: r.mode, status: r.status, rowsTotal: Number(r.rows_total), rowsOk: Number(r.rows_ok),
    rowsFailed: Number(r.rows_failed), batchId: numberOrNull(r.batch_id), createdAt: r.created_at,
  };
}

/** Inserts a batch (status 'posted') and returns its id. The database refuses a future date (R-FD). */
export function insertBatch(conn: DatabaseSync, b: {
  businessDate: string; source: BatchSource; fileName: string | null; rowCount: number; totalValueCents: number;
  notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO opening_stock_batches (business_date, source, file_name, row_count, total_value_cents, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.businessDate, b.source, b.fileName, b.rowCount, b.totalValueCents, b.notes, b.clientRef);
  return Number(res.lastInsertRowid);
}

/** One batch by id, or undefined. */
export function getBatch(conn: DatabaseSync, id: number): BatchRow | undefined {
  const r = conn.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id) as unknown as RawBatch | undefined;
  return r ? mapBatch(r) : undefined;
}

/** The batch already saved under this client reference (idempotent retry), or undefined. */
export function getBatchByClientRef(conn: DatabaseSync, ref: string): BatchRow | undefined {
  const r = conn.prepare(`${BATCH_SELECT} WHERE client_ref = ?`).get(ref) as unknown as RawBatch | undefined;
  return r ? mapBatch(r) : undefined;
}

/**
 * Lists batches, newest business date first, with the total count and the sums of the POSTED batches
 * (voided rows are listed but not summed). `from` / `to` are inclusive business dates.
 */
export function listBatches(conn: DatabaseSync, q: {
  from?: string; to?: string; status?: BatchStatus; limit: number; offset: number;
}): { items: BatchRow[]; total: number; totalValueCents: number; lineCount: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN status = 'posted' THEN total_value_cents END), 0) AS v,
            COALESCE(SUM(CASE WHEN status = 'posted' THEN row_count END), 0) AS r
       FROM opening_stock_batches${w}`,
  ).get(...params) as unknown as { n: N; v: N; r: N };
  const rows = conn.prepare(`${BATCH_SELECT}${w} ORDER BY business_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawBatch[];
  return { items: rows.map(mapBatch), total: Number(agg.n), totalValueCents: Number(agg.v), lineCount: Number(agg.r) };
}

/** posted -> void; the DB triggers forbid anything else. `voided_at` is the DB clock. */
export function markBatchVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(
    `UPDATE opening_stock_batches SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`,
  ).run(reason, id);
}

/** Appends an import attempt and returns its id. */
export function insertImportRun(conn: DatabaseSync, r: {
  fileName: string; fileSha256: string; businessDate: string; mode: RunMode; status: RunStatus;
  rowsTotal: number; rowsOk: number; rowsFailed: number; batchId: number | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO import_runs (kind, file_name, file_sha256, business_date, mode, status, rows_total, rows_ok, rows_failed, batch_id)
     VALUES ('opening_stock', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.fileName, r.fileSha256, r.businessDate, r.mode, r.status, r.rowsTotal, r.rowsOk, r.rowsFailed, r.batchId);
  return Number(res.lastInsertRowid);
}

/** Appends one issue of an import attempt. */
export function insertImportIssue(conn: DatabaseSync, i: {
  importRunId: number; rowNo: number; columnName: string; code: string; message: string;
}): void {
  conn.prepare(
    'INSERT INTO import_issues (import_run_id, row_no, column_name, code, message) VALUES (?, ?, ?, ?, ?)',
  ).run(i.importRunId, i.rowNo, i.columnName, i.code, i.message);
}

/** The issues recorded for one import attempt, in row order. */
export function listImportIssues(conn: DatabaseSync, importRunId: number): ImportIssueRow[] {
  const rows = conn.prepare(
    'SELECT id, import_run_id, row_no, column_name, code, message FROM import_issues WHERE import_run_id = ? ORDER BY id',
  ).all(importRunId) as unknown as RawIssue[];
  return rows.map((r) => ({
    id: Number(r.id), importRunId: Number(r.import_run_id), rowNo: Number(r.row_no),
    columnName: r.column_name, code: r.code, message: r.message,
  }));
}

/** The committed import that created this batch, or undefined (manual batches have none). */
export function getCommittedRunForBatch(conn: DatabaseSync, batchId: number): ImportRunRow | undefined {
  const r = conn.prepare(
    `SELECT id, kind, file_name, file_sha256, business_date, mode, status, rows_total, rows_ok, rows_failed, batch_id, created_at
       FROM import_runs WHERE batch_id = ? AND status = 'committed'`,
  ).get(batchId) as unknown as RawRun | undefined;
  return r ? mapRun(r) : undefined;
}

/**
 * The still-active committed import of this exact file (same SHA-256), or undefined. "Active" = its batch has not
 * been voided: after a void the owner may legitimately import the corrected file again.
 */
export function findActiveCommittedRunBySha(conn: DatabaseSync, sha256: string): ImportRunRow | undefined {
  const r = conn.prepare(
    `SELECT r.id, r.kind, r.file_name, r.file_sha256, r.business_date, r.mode, r.status, r.rows_total, r.rows_ok,
            r.rows_failed, r.batch_id, r.created_at
       FROM import_runs r JOIN opening_stock_batches b ON b.id = r.batch_id
      WHERE r.file_sha256 = ? AND r.status = 'committed' AND b.status = 'posted'
      ORDER BY r.id LIMIT 1`,
  ).get(sha256) as unknown as RawRun | undefined;
  return r ? mapRun(r) : undefined;
}
