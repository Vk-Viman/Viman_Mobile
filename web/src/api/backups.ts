/**
 * API hooks for database backups and restore.
 *
 * Used by Settings > Backups (pages/settings/BackupsTab.tsx).
 * Endpoints: GET /backups, POST /backups, POST /backups/restore (see API_CONTRACTS.md).
 * The server does all the safety work (consistent snapshot, integrity checks, safety copy before restore).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPostForm, apiPut } from './client';
import type { BackupCreated, BackupList, RestoreResult } from '../types/api';
import type { ExternalBackupStatus, ExternalCopyResult } from '../types/externalBackup';
import { AUDIT_LOGS_KEY } from './auditLogs';

/** GET /backups: the list of backup files kept on disk, newest first. */
export const useBackups = () => useQuery({ queryKey: ['backups'], queryFn: () => apiGet<BackupList>('/backups') });

/** POST /backups: take a manual backup now. Refreshes the backup list afterwards so the new file shows up. */
export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<BackupCreated>('/backups'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });
}

/** What to restore from: a backup already on the server (by file name) or a file picked from the computer. */
export type RestoreInput = { kind: 'name'; name: string } | { kind: 'file'; file: File };

/**
 * POST /backups/restore: replace the live database with a backup (by name, or by uploading a file).
 * The word "RESTORE" is sent as an explicit confirmation token so a stray request can never restore by accident.
 * On success EVERY cached query is invalidated: the whole database was swapped, so any figure on screen could
 * now be wrong and must be re-read from the server.
 */
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

/** Query key of the external backup status (also refreshed by the dashboard when it changes). */
export const EXTERNAL_BACKUP_KEY = ['backups', 'external'] as const;

/**
 * GET /backups/external: folder, status, warning and the list of external copies.
 * Re-read every 20 seconds while the page is open, so plugging the USB drive in or out shows up by itself.
 */
export const useExternalBackup = () => useQuery({
  queryKey: EXTERNAL_BACKUP_KEY,
  queryFn: () => apiGet<ExternalBackupStatus>('/backups/external'),
  refetchInterval: 20_000,
});

/** PUT /backups/external: set the folder (or clear it with null). The server checks the folder and audits the change. */
export function useSetExternalFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folder: string | null) => apiPut<ExternalBackupStatus>('/backups/external', { folder }),
    onSuccess: (data) => {
      qc.setQueryData(EXTERNAL_BACKUP_KEY, data);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}

/** POST /backups/external/copy: copy the backups to the external folder now ("Copy backup now"). */
export function useCopyExternalNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<ExternalCopyResult>('/backups/external/copy'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: EXTERNAL_BACKUP_KEY });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
