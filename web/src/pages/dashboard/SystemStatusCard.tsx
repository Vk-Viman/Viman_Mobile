/**
 * SystemStatusCard: server health (GET /health) and the newest backup file (GET /backups), kept from the Phase 1 dashboard.
 * The two queries are independent: a backup-list failure only affects its own row.
 */
import type { ReactNode } from 'react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { useBackups } from '../../api/backups';
import { useHealth } from '../../api/health';
import { formatDateTime } from '../../lib/format';

/** One "label ... value" line (a <dt>/<dd> pair). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

/** Renders the status card (loading / error with retry / data). */
export function SystemStatusCard() {
  const health = useHealth();
  const backups = useBackups();
  const latest = backups.data?.items[0]; // newest first
  return (
    <Card title="System status">
      {health.isPending ? (
        <Spinner label="Checking server" />
      ) : health.isError ? (
        <ErrorState error={health.error} onRetry={() => void health.refetch()} />
      ) : (
        <dl>
          <Row label="API status"><Badge tone="brand">{health.data.status === 'ok' ? 'OK' : health.data.status}</Badge></Row>
          <Row label="App version"><span className="num">{health.data.appVersion}</span></Row>
          <Row label="Schema version"><span className="num">{health.data.schemaVersion}</span></Row>
          <Row label="Business date"><span className="num">{health.data.today}</span></Row>
          <Row label="Latest backup">
            {backups.isPending ? <Spinner /> : backups.isError ? <span className="text-red-600">Unavailable</span> : latest ? (
              <span className="block">
                <span className="block break-all">{latest.name}</span>
                <span className="block text-xs font-normal text-slate-500">{formatDateTime(latest.createdAt)}</span>
              </span>
            ) : <span className="font-normal text-slate-500">No backups yet</span>}
          </Row>
        </dl>
      )}
    </Card>
  );
}
