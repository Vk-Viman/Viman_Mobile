import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPostForm } from './client';
import type { BackupCreated, BackupList, RestoreResult } from '../types/api';

export const useBackups = () => useQuery({ queryKey: ['backups'], queryFn: () => apiGet<BackupList>('/backups') });

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<BackupCreated>('/backups'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });
}

export type RestoreInput = { kind: 'name'; name: string } | { kind: 'file'; file: File };

export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RestoreInput) => {
      if (input.kind === 'name') {
        return apiPost<RestoreResult>('/backups/restore', { name: input.name, confirm: 'RESTORE' });
      }
      const form = new FormData();
      form.append('confirm', 'RESTORE'); // must precede the file field
      form.append('file', input.file);
      return apiPostForm<RestoreResult>('/backups/restore', form);
    },
    onSuccess: () => qc.invalidateQueries(),
  });
}
