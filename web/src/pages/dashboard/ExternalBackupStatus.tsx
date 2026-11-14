/**
 * ExternalBackupStatus: the "External copy" part of the dashboard backup card (dashboard `backup.external`).
 * Green = synchronized, amber = not set up / drive not found, red = last copy failed or no copy for 7+ days.
 * A missing or failing drive only warns here; it never stops shop work.
 */
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { externalStatusLabel } from '../../types/externalBackup';
import type { ExternalBackupSummary } from '../../types/externalBackup';
import { formatDateTime } from '../../lib/format';

export function ExternalBackupStatus({ external }: { external: ExternalBackupSummary }) {
  const label = externalStatusLabel(external.status, external.daysSinceSuccess, external.lastSuccessAt !== null);
  const red = external.status === 'failed' || external.status === 'stale';
  return (
    <div className="mt-4 border-t border-slate-100 pt-3" data-testid="external-backup-status">
      <p className="text-sm font-medium text-slate-800">
        External copy (USB drive) <Badge tone={label.tone}>{label.text}</Badge>
      </p>
      {external.status !== 'not_configured' && (
        <p className="mt-1 text-xs text-slate-500">
          Last confirmed sync: <span className="num">{external.lastSuccessAt ? formatDateTime(external.lastSuccessAt) : 'never'}</span>
          {external.daysSinceSuccess !== null && external.daysSinceSuccess > 0 ? ` (${external.daysSinceSuccess} days ago)` : ''}
        </p>
      )}
      {external.warning && (
        <p className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${red ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{external.warning} <Link to="/settings/backups" className="font-medium underline">Open Backups</Link></span>
        </p>
      )}
    </div>
  );
}
