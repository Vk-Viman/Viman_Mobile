/**
 * Settings > Backups > "External backup" card: the folder (for example a USB drive) that backups are also copied to.
 * API: GET/PUT /backups/external, POST /backups/external/copy (api/backups.ts). The server validates the folder
 * (absolute local path, exists, writable, not in the data folder, not cloud-synced), verifies every copy by size and
 * SHA-256, never overwrites, and keeps the newest 30. A missing drive only shows a warning here and on the Dashboard.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, HardDriveUpload } from 'lucide-react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCopyExternalNow, useExternalBackup, useSetExternalFolder } from '../../api/backups';
import { EXTERNAL_STATUS_LABEL } from '../../types/externalBackup';
import type { ExternalCopy, ExternalCopyResult } from '../../types/externalBackup';
import { formatBytes, formatDateTime } from '../../lib/format';
import { errorMessage } from './formUtils';

/** The sentence shown under the folder field. */
const HELP = 'Use a USB drive or another local drive. Backups are not encrypted, so cloud-synced folders (OneDrive, Google Drive, Dropbox, iCloud) are not allowed.';

/** One plain-English line summarising a copy run. */
function summarise(r: ExternalCopyResult): string {
  const parts = [`${r.copied.length} copied`];
  if (r.skipped.length > 0) parts.push(`${r.skipped.filter((s) => s.reason === 'already_present').length} already there`);
  if (r.failed.length > 0) parts.push(`${r.failed.length} failed`);
  return parts.join(', ');
}

/** The card. Hidden-state free: it always shows the live status read from the server. */
export function ExternalBackupSection() {
  const q = useExternalBackup();
  const save = useSetExternalFolder();
  const copy = useCopyExternalNow();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  // What the last "Copy backup now" did (shown until the next click).
  const [lastRun, setLastRun] = useState<ExternalCopyResult | null>(null);

  // Show the saved folder in the box when it loads or changes on the server (but never overwrite what the owner is typing).
  const saved = q.data?.folder ?? '';
  useEffect(() => { setDraft(saved); }, [saved]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft.trim() === '' ? null : draft.trim(), {
      onSuccess: (d) => toast.success(d.configured ? 'External backup folder saved.' : 'External backup folder removed.'),
    });
  };

  const columns: Column<ExternalCopy>[] = [
    { key: 'name', header: 'File', render: (c) => <span className="break-all font-mono text-xs">{c.name}</span> },
    { key: 'size', header: 'Size', align: 'right', render: (c) => formatBytes(c.sizeBytes) },
    { key: 'created', header: 'Copied (Colombo)', render: (c) => <span className="num whitespace-nowrap">{formatDateTime(c.createdAt)}</span> },
  ];

  const d = q.data;
  const label = d ? EXTERNAL_STATUS_LABEL[d.status] : null;
  const dirty = d !== undefined && draft.trim() !== (d.folder ?? '');
  const fieldError = save.isError ? ((save.error as { fields?: Record<string, string> }).fields?.folder ?? errorMessage(save.error)) : undefined;

  return (
    <Card
      title="External backup (USB drive)"
      actions={
        <Button
          loading={copy.isPending}
          disabled={!d?.configured}
          onClick={() => copy.mutate(undefined, {
            onSuccess: (r) => {
              setLastRun(r);
              if (r.failed.length === 0) toast.success(`External copy done: ${summarise(r)}.`);
              else toast.error(`External copy problem: ${r.failed[0]!.error}`);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })}
        >
          <HardDriveUpload size={16} aria-hidden="true" /> {copy.isPending ? 'Copying…' : 'Copy backup now'}
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          className="flex-1"
          label="External backup folder"
          placeholder="For example E:\Viman-Backups"
          value={draft}
          onChange={(e) => { save.reset(); setDraft(e.target.value); }}
          error={fieldError}
          hint={HELP}
          autoComplete="off"
        />
        <div className="flex gap-2 sm:mt-6">
          <Button type="submit" loading={save.isPending} disabled={!dirty}>Save</Button>
        </div>
      </form>

      {q.isPending ? <div className="mt-4"><Spinner label="Loading external backup status" /></div> : q.isError ? (
        <div className="mt-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
      ) : (
        <div className="mt-5 space-y-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">Status</dt>
              <dd>{label && <Badge tone={label.tone}>{label.text}</Badge>}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">Last successful copy</dt>
              <dd className="num font-medium text-slate-900">{d!.lastSuccessAt ? formatDateTime(d!.lastSuccessAt) : 'Never'}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">Last attempt</dt>
              <dd className="num font-medium text-slate-900">{d!.lastAttemptAt ? formatDateTime(d!.lastAttemptAt) : 'None yet'}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">Folder</dt>
              <dd className="break-all text-right font-medium text-slate-900">
                {d!.folder ?? 'Not set'}
                {d!.configured && d!.folderAvailable && d!.writable === false && <span className="ml-2 text-red-700">(not writable)</span>}
              </dd>
            </div>
          </dl>

          {d!.warning && (
            <p role="alert" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${d!.status === 'ok' || d!.status === 'not_configured' || d!.status === 'drive_missing' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{d!.warning}</span>
            </p>
          )}

          {copy.isPending && <p className="flex items-center gap-2 text-sm text-slate-600"><Spinner size={16} /> Copying and checking the backup on the drive&hellip; this can take a moment.</p>}
          {lastRun && !copy.isPending && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" role="status">
              <p className="font-medium">Last "Copy backup now": {summarise(lastRun)}.</p>
              {lastRun.failed.map((f) => <p key={f.name} className="text-red-800">{f.name}: {f.error}</p>)}
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Copies on the external drive (newest 30 are kept)</h3>
            <DataTable columns={columns} rows={d!.copies} rowKey={(c) => c.name} emptyTitle="No copies on the drive yet" emptyHint={d!.configured ? 'Use Copy backup now, or wait: new backups are copied automatically.' : 'Choose a folder above first.'} />
          </div>
        </div>
      )}
    </Card>
  );
}
