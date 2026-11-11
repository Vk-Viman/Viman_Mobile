/**
 * API hook for the audit trail ("who changed what, when").
 *
 * Used by Settings > Audit log (pages/settings/AuditTab.tsx). The log is append-only on the server
 * (ARCHITECTURE.md), so this module only reads.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { AuditLogPage } from '../types/api';

/**
 * Root query key of every audit-log query.
 * Other API modules invalidate this key after any write, because each write adds audit rows on the server.
 */
export const AUDIT_LOGS_KEY = ['audit-logs'] as const;

/** Rows requested per "page" of the audit list (the "Load more" button fetches the next page). */
const AUDIT_PAGE_SIZE = 50;

/**
 * GET /audit-logs  (cursor paging, newest first).
 *
 * @param entity Optional entity filter (e.g. "product"); empty string means all entities.
 * Paging uses `beforeId` (the id of the oldest row already loaded) rather than page numbers, so new rows arriving
 * while the owner reads cannot shift or duplicate entries. `nextBeforeId` from the server is the next cursor,
 * null when there is nothing older. The entity is part of the query key so each filter has its own cache.
 */
export function useAuditLogs(entity: string) {
  return useInfiniteQuery({
    queryKey: [...AUDIT_LOGS_KEY, entity],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
      if (entity) p.set('entity', entity);
      if (pageParam !== null) p.set('beforeId', String(pageParam));
      return apiGet<AuditLogPage>(`/audit-logs?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextBeforeId,
  });
}
