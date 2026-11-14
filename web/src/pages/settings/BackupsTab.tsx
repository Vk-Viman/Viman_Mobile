/**
 * Settings > Backups tab (route "/settings/backups"): list the database backups, take one now, or restore.
 * API: GET /backups, POST /backups, POST /backups/restore (api/backups.ts). The server makes the consistent
 * snapshot and performs all safety checks (including a safety copy of the live data before any restore).
 * Restoring replaces ALL current data, so it is guarded by a dialog that requires typing RESTORE.
 */
import { useRef, useState } from 'react';
import { DatabaseBackup, RotateCcw, Upload } from 'lucide-react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { useBackups, useCreateBackup, useRestoreBackup } from '../../api/backups';
import type { RestoreInput } from '../../api/backups';
import type { Backup } from '../../types/api';
import { formatBytes, formatDateTime } from '../../lib/format';
import { errorMessage } from './formUtils';
import { ApiError } from '../../api/client';
import { ExternalBackupSection } from './ExternalBackupSection';

/** Badge colour per backup reason (why it was taken). */
const tone = { startup: 'neutral', manual: 'brand', 'pre-restore': 'amber' } as const;

/** Error text including the machine code, so the owner can quote it when asking for support. */
function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.message} (${e.code})`;
  return errorMessage(e);
}

/** One failed safety check of a refused restore, as sent by the server (plain language). */
interface RestoreFailure { code: string; message: string; detail?: string }

/** The failed checks carried by a refused restore (422), or an empty list for any other error. */
function refusalFailures(e: unknown): { items: RestoreFailure[]; total: number } {
  if (!(e instanceof ApiError) || !Array.isArray(e.extra.failures)) return { items: [], total: 0 };
  const items = (e.extra.failures as unknown[]).filter((f): f is RestoreFailure =>
    typeof f === 'object' && f !== null && typeof (f as RestoreFailure).message === 'string');
  return { items, total: typeof e.extra.totalFailures === 'number' ? e.extra.totalFailures : items.length };
}

/** The tab: backup table, "Backup now" / "Restore from file" buttons and the restore confirmation dialog. */
export function BackupsTab() {
  const q = useBackups();
  const create = useCreateBackup();
  const restore = useRestoreBackup();
  const toast = useToast();
  // Hidden <input type="file">; the visible button forwards its click to it.
  const fileRef = useRef<HTMLInputElement>(null);
  // What the owner chose to restore (null = dialog closed). The dialog is open exactly while this is set.
  const [target, setTarget] = useState<RestoreInput | null>(null);

  const refusal = refusalFailures(restore.error);
  const targetLabel = target ? (target.kind === 'name' ? target.name : target.file.name) : '';

  // Closing is blocked while the restore is running, so the owner cannot dismiss the dialog mid-operation.
  const closeDialog = () => {
    if (restore.isPending) return;
    setTarget(null);
    restore.reset();
  };

  const doRestore = () => {
    if (!target) return;
    restore.mutate(target, {
      onSuccess: (r) => {
        toast.success(`Restored from ${r.restoredFrom}. Safety backup: ${r.safetyBackup}.`);
        setTarget(null);
        restore.reset();
      },
    });
  };

  const columns: Column<Backup>[] = [
    { key: 'name', header: 'Name', render: (b) => <span className="break-all font-mono text-xs">{b.name}</span> },
    { key: 'reason', header: 'Reason', render: (b) => <Badge tone={tone[b.reason]}>{b.reason}</Badge> },
    { key: 'size', header: 'Size', align: 'right', render: (b) => formatBytes(b.sizeBytes) },
    { key: 'created', header: 'Created (Colombo)', render: (b) => <span className="num whitespace-nowrap">{formatDateTime(b.createdAt)}</span> },
    {
      key: 'actions', header: '', align: 'right',
      render: (b) => (
        <Button variant="secondary" onClick={() => { restore.reset(); setTarget({ kind: 'name', name: b.name }); }}>
          <RotateCcw size={16} aria-hidden="true" /> Restore
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
    <ExternalBackupSection />
    <Card
      title="Backups"
      actions={
        <div className="flex flex-wrap gap-2">
          {/* Native file picker kept invisible (but still labelled for screen readers). Only ".db" files are offered. */}
          <input
            ref={fileRef}
            type="file"
            accept=".db"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a backup file to restore"
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Clear the input so choosing the same file again later still triggers onChange.
              e.target.value = '';
              if (f) { restore.reset(); setTarget({ kind: 'file', file: f }); }
            }}
          />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload size={16} aria-hidden="true" /> Restore from file&hellip;</Button>
          <Button
            loading={create.isPending}
            onClick={() => create.mutate(undefined, {
              onSuccess: (r) => toast.success(`Backup created: ${r.item.name}`),
              onError: (e) => toast.error(describeError(e)),
            })}
          >
            <DatabaseBackup size={16} aria-hidden="true" /> Backup now
          </Button>
        </div>
      }
    >
      {q.isPending ? <Spinner label="Loading backups" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <DataTable columns={columns} rows={q.data.items} rowKey={(b) => b.name} emptyTitle="No backups yet" emptyHint="Use Backup now to create the first one." />
      )}

      {/* Typing RESTORE is required: this replaces every current record, so a stray click must not be enough. */}
      <ConfirmDialog
        open={target !== null}
        title="Restore data from backup?"
        confirmLabel="Restore"
        danger
        requireText="RESTORE"
        loading={restore.isPending}
        error={restore.isError ? (refusal.items.length > 0 && restore.error instanceof ApiError ? restore.error.message : describeError(restore.error)) : null}
        onConfirm={doRestore}
        onClose={closeDialog}
      >
        <p>You are about to restore <strong className="break-all">{targetLabel}</strong>.</p>
        <p><strong>All current data will be replaced</strong> by the contents of this backup. Anything entered since it was made will be lost from the live system.</p>
        <p>A safety backup of the current data is made first, so you can undo this by restoring that safety backup.</p>
        {refusal.items.length > 0 && (
          <div data-testid="restore-failures" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium">What is wrong with this file:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {refusal.items.map((f, i) => (
                <li key={`${f.code}-${i}`}>{f.message}{f.detail ? <span className="block break-words text-xs text-red-700">{f.detail}</span> : null}</li>
              ))}
            </ul>
            {refusal.total > refusal.items.length && <p className="mt-1">&hellip; and {refusal.total - refusal.items.length} more problems.</p>}
            <p className="mt-2">Your current data was not changed. Please choose a different backup file.</p>
          </div>
        )}
      </ConfirmDialog>
    </Card>
    </div>
  );
}
