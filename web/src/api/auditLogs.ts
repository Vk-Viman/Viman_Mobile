import { useInfiniteQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { AuditLogPage } from '../types/api';

export function useAuditLogs(entity: string) {
  return useInfiniteQuery({
    queryKey: ['audit-logs', entity],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (entity) p.set('entity', entity);
      if (pageParam !== null) p.set('beforeId', String(pageParam));
      return apiGet<AuditLogPage>(`/audit-logs?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextBeforeId,
  });
}
