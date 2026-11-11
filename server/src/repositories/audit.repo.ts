import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface AuditInsert {
  entity: string; entityId?: string | null; action: string; beforeJson?: string | null; afterJson?: string | null;
  note?: string | null; businessDate?: string | null; backdated?: boolean;
}
export interface AuditRow {
  id: number; at: string; entity: string; entityId: string | null; action: string;
  beforeJson: string | null; afterJson: string | null; note: string | null;
  businessDate: string | null; backdated: boolean;
}

interface RawAudit {
  id: number | bigint; at: string; entity: string; entity_id: string | null; action: string;
  before_json: string | null; after_json: string | null; note: string | null;
  business_date: string | null; backdated: number | bigint;
}

export function insertAudit(conn: DatabaseSync, row: AuditInsert): number {
  const res = conn.prepare(
    `INSERT INTO audit_logs (entity, entity_id, action, before_json, after_json, note, business_date, backdated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.entity, row.entityId ?? null, row.action, row.beforeJson ?? null, row.afterJson ?? null,
    row.note ?? null, row.businessDate ?? null, row.backdated === true ? 1 : 0);
  return Number(res.lastInsertRowid);
}

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
