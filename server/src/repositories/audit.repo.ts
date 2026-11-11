/**
 * repositories/audit.repo.ts - SQL for the `audit_logs` table ("who changed what, before and after").
 *
 * Layer: repository (service -> repository -> database). No business rules here; `audit.service.ts` decides
 * what to log. The table is append-only (BUSINESS_RULES R1 / section 12, enforced by the triggers of
 * migration 002), so this file only offers INSERT and SELECT - there is deliberately no update or delete.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** What a caller supplies to record one audit entry. JSON columns hold ready-made JSON text. */
export interface AuditInsert {
  entity: string; entityId?: string | null; action: string; beforeJson?: string | null; afterJson?: string | null;
  note?: string | null; businessDate?: string | null; backdated?: boolean;
}

/** One audit entry as read back (`at` is the server posting timestamp, UTC). */
export interface AuditRow {
  id: number; at: string; entity: string; entityId: string | null; action: string;
  beforeJson: string | null; afterJson: string | null; note: string | null;
  businessDate: string | null; backdated: boolean;
}

/** Row exactly as SQLite returns it (snake_case, integers possibly bigint). */
interface RawAudit {
  id: number | bigint; at: string; entity: string; entity_id: string | null; action: string;
  before_json: string | null; after_json: string | null; note: string | null;
  business_date: string | null; backdated: number | bigint;
}

/**
 * Appends one audit entry. `at` comes from the database clock (column default).
 *
 * @returns The new entry id.
 */
export function insertAudit(conn: DatabaseSync, row: AuditInsert): number {
  const res = conn.prepare(
    `INSERT INTO audit_logs (entity, entity_id, action, before_json, after_json, note, business_date, backdated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.entity, row.entityId ?? null, row.action, row.beforeJson ?? null, row.afterJson ?? null,
    row.note ?? null, row.businessDate ?? null, row.backdated === true ? 1 : 0);
  return Number(res.lastInsertRowid);
}

/**
 * Lists audit entries newest first.
 *
 * @param q.entity   Only entries of this entity type (e.g. 'purchase').
 * @param q.limit    Maximum rows to return.
 * @param q.beforeId Keyset paging: only entries with a smaller id (pass the last id of the previous page).
 */
export function listAudit(conn: DatabaseSync, q: { entity?: string; limit: number; beforeId?: number }): AuditRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.entity !== undefined) { where.push('entity = ?'); params.push(q.entity); }
  if (q.beforeId !== undefined) { where.push('id < ?'); params.push(q.beforeId); }
  const sql = `SELECT id, at, entity, entity_id, action, before_json, after_json, note, business_date, backdated FROM audit_logs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(q.limit);
  const rows = conn.prepare(sql).all(...params) as unknown as RawAudit[];
  return rows.map((r) => ({
    id: Number(r.id), at: r.at, entity: r.entity, entityId: r.entity_id, action: r.action,
    beforeJson: r.before_json, afterJson: r.after_json, note: r.note,
    businessDate: r.business_date, backdated: Number(r.backdated) === 1,
  }));
}
