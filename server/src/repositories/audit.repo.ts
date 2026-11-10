import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface AuditInsert { entity: string; entityId?: string | null; action: string; beforeJson?: string | null; afterJson?: string | null; note?: string | null }
export interface AuditRow { id: number; at: string; entity: string; entityId: string | null; action: string; beforeJson: string | null; afterJson: string | null; note: string | null }

interface RawAudit {
  id: number | bigint; at: string; entity: string; entity_id: string | null; action: string;
  before_json: string | null; after_json: string | null; note: string | null;
}

export function insertAudit(conn: DatabaseSync, row: AuditInsert): number {
  const res = conn.prepare(
    `INSERT INTO audit_logs (entity, entity_id, action, before_json, after_json, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.entity, row.entityId ?? null, row.action, row.beforeJson ?? null, row.afterJson ?? null, row.note ?? null);
  return Number(res.lastInsertRowid);
}

export function listAudit(conn: DatabaseSync, q: { entity?: string; limit: number; beforeId?: number }): AuditRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.entity !== undefined) { where.push('entity = ?'); params.push(q.entity); }
  if (q.beforeId !== undefined) { where.push('id < ?'); params.push(q.beforeId); }
  const sql = `SELECT id, at, entity, entity_id, action, before_json, after_json, note FROM audit_logs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(q.limit);
  const rows = conn.prepare(sql).all(...params) as unknown as RawAudit[];
  return rows.map((r) => ({
    id: Number(r.id), at: r.at, entity: r.entity, entityId: r.entity_id, action: r.action,
    beforeJson: r.before_json, afterJson: r.after_json, note: r.note,
  }));
}
