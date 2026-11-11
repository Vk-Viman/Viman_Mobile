import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { insertAudit, listAudit } from '../repositories/audit.repo.ts';

export interface AuditLogItem {
  id: number;
  at: string;
  postedAt: string;
  entity: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  note: string | null;
  businessDate: string | null;
  backdated: boolean;
}

export interface AuditLogsResponse {
  items: AuditLogItem[];
  nextBeforeId: number | null;
}

export function logAudit(
  conn: DatabaseSync,
  entity: string,
  entityId: string | null,
  action: string,
  before: unknown,
  after: unknown,
  note?: string,
  financial?: { businessDate?: string | null; backdated?: boolean },
): number {
  return insertAudit(conn, {
    entity,
    entityId,
    action,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: after === undefined ? null : JSON.stringify(after),
    note: note ?? null,
    businessDate: financial?.businessDate ?? null,
    backdated: financial?.backdated === true,
  });
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function getAuditLogs(
  ctx: AppContext,
  q: { entity?: string; limit?: number; beforeId?: number },
): AuditLogsResponse {
  const limit = q.limit ?? 50;
  const query: { entity?: string; limit: number; beforeId?: number } = { limit };
  if (q.entity !== undefined && q.entity !== '') query.entity = q.entity;
  if (q.beforeId !== undefined) query.beforeId = q.beforeId;
  const rows = listAudit(ctx.database.conn, query);
  const items: AuditLogItem[] = rows.map((r) => ({
    id: r.id,
    at: r.at,
    postedAt: r.at,
    entity: r.entity,
    entityId: r.entityId,
    action: r.action,
    before: parseJson(r.beforeJson),
    after: parseJson(r.afterJson),
    note: r.note,
    businessDate: r.businessDate,
    backdated: r.backdated,
  }));
  const last = items[items.length - 1];
  return { items, nextBeforeId: items.length === limit && last ? last.id : null };
}
