/**
 * services/audit.service.ts - writes and reads the audit trail ("who changed what").
 *
 * Layer: service (route -> SERVICE -> repository -> database). BUSINESS_RULES section 12: every edit, void,
 * reopen, restore and settings change is logged with a before/after snapshot, and every entry for a financial
 * record also stores its business date and a `backdated` flag (R-FD keeps backdating legal but traceable).
 * `logAudit` is called by the other services INSIDE their transaction, so a change and its audit entry are
 * saved together or not at all. The table is append-only (migration 002), so there is no edit/delete here.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { insertAudit, listAudit } from '../repositories/audit.repo.ts';

/** One audit entry as returned by the API (`before`/`after` are parsed JSON, not text). */
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

/** A page of audit entries, newest first. `nextBeforeId` is the cursor for the next page (null = no more). */
export interface AuditLogsResponse {
  items: AuditLogItem[];
  nextBeforeId: number | null;
}

/** How many audit entries one page returns when the caller does not say. */
const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * Records one audit entry. Must be called inside the caller's transaction (pass its `conn`).
 *
 * @param entity    Kind of record, e.g. 'purchase', 'settings', 'backup'.
 * @param entityId  The record's id or key (text, so keys like 'rates' fit too).
 * @param action    'create', 'update', 'void', 'complete', 'restore' ...
 * @param before    Snapshot before the change (undefined/null for a create).
 * @param after     Snapshot after the change.
 * @param note      Free text, e.g. the void reason.
 * @param financial Pass `{ businessDate, backdated }` for financial records (section 12); omit for settings/backups.
 * @returns The new audit entry id.
 */
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

/** Parses stored JSON text; if it somehow is not valid JSON the raw text is returned instead of failing the page. */
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Reads a page of the audit trail, newest first.
 *
 * @param q.entity   Only this entity type (empty string = all).
 * @param q.limit    Page size (default 50; the route limits it to 1-200).
 * @param q.beforeId Cursor: only entries older than this id.
 */
export function getAuditLogs(
  ctx: AppContext,
  q: { entity?: string; limit?: number; beforeId?: number },
): AuditLogsResponse {
  const limit = q.limit ?? DEFAULT_AUDIT_PAGE_SIZE;
  const query: { entity?: string; limit: number; beforeId?: number } = { limit };
  if (q.entity !== undefined && q.entity !== '') query.entity = q.entity;
  if (q.beforeId !== undefined) query.beforeId = q.beforeId;
  const rows = listAudit(ctx.database.conn, query);
  const items: AuditLogItem[] = rows.map((r) => ({
    id: r.id,
    at: r.at,
    // `at` is the server posting time; `postedAt` is the contract's name for the same value.
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
  // A full page means there may be more; a short page is the end.
  return { items, nextBeforeId: items.length === limit && last ? last.id : null };
}
