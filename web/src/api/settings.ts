/**
 * API hooks for shop settings (shop name, tax/discount rates, printing options...).
 *
 * Used by every Settings tab (pages/settings/*) and by anything that needs a setting.
 * Endpoints: GET /settings, PUT /settings (see API_CONTRACTS.md).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import type { Settings, SettingsUpdate } from '../types/api';

/** GET /settings: the current settings object. */
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => apiGet<Settings>('/settings') });

/**
 * PUT /settings: save changed settings (only the fields sent are changed).
 * On success the cache is overwritten directly with the server's reply (no extra round trip, and the form
 * immediately shows exactly what the server stored), and the audit log is refreshed because the change was audited.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdate) => apiPut<Settings>('/settings', body),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}
