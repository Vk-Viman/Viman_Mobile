import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut } from './client';
import type { Settings, SettingsUpdate } from '../types/api';

export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => apiGet<Settings>('/settings') });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdate) => apiPut<Settings>('/settings', body),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}
