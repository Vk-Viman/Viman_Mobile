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

const tone = { startup: 'neutral', manual: 'brand', 'pre-restore': 'amber' } as const;

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.message} (${e.code})`;
  return errorMessage(e);
}

export function BackupsTab() {
  const q = useBackups();
  const create = useCreateBackup();
  const restore = useRestoreBackup();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<RestoreInput | null>(null);

  const targetLabel = target ? (target.kind === 'name' ? target.name : target.file.name) : '';

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
    <Card
      title="Backups"
      actions={
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".db"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a backup file to restore"
            onChange={(e) => {
              const f = e.target.files?.[0];
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

      <ConfirmDialog
        open={target !== null}
        title="Restore data from backup?"
        confirmLabel="Restore"
        danger
        requireText="RESTORE"
        loading={restore.isPending}
        error={restore.isError ? describeError(restore.error) : null}
        onConfirm={doRestore}
        onClose={closeDialog}
      >
        <p>You are about to restore <strong className="break-all">{targetLabel}</strong>.</p>
        <p><strong>All current data will be replaced</strong> by the contents of this backup. Anything entered since it was made will be lost from the live system.</p>
        <p>A safety backup of the current data is made first, so you can undo this by restoring that safety backup.</p>
      </ConfirmDialog>
    </Card>
  );
}
