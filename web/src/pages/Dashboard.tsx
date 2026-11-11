/**
 * Dashboard: the home screen (route "/").
 * For now it shows system status: server health (GET /health) and the newest backup (GET /backups).
 * The business figures (sales, profit, cash, stock alerts) arrive in Phase 12; their card is a placeholder.
 */
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/Badge';
import { Spinner } from '../components/Spinner';
import { ErrorState } from '../components/ErrorState';
import { useHealth } from '../api/health';
import { useBackups } from '../api/backups';
import { formatDateTime } from '../lib/format';
import { LayoutDashboard } from 'lucide-react';
import type { ReactNode } from 'react';

/** One "label ... value" line of the status list (a <dt>/<dd> pair, so screen readers read it as a definition). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

/**
 * Renders the status card (loading / error with retry / data) and the Phase 12 placeholder card.
 * The two queries are independent: a backup-list failure only affects its own row, never the health block.
 */
export function Dashboard() {
  const health = useHealth();
  const backups = useBackups();
  // The server lists backups newest first, so the first item is the latest one.
  const latest = backups.data?.items[0];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="System status" />
      <div className="grid gap-6 lg:grid-cols-2">
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
                {backups.isPending ? (
                  <Spinner />
                ) : backups.isError ? (
                  <span className="text-red-600">Unavailable</span>
                ) : latest ? (
                  <span className="block">
                    <span className="block break-all">{latest.name}</span>
                    <span className="block text-xs font-normal text-slate-500">{formatDateTime(latest.createdAt)}</span>
                  </span>
                ) : (
                  <span className="font-normal text-slate-500">No backups yet</span>
                )}
              </Row>
            </dl>
          )}
        </Card>
        <Card title="Business dashboard">
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="rounded-full bg-brand-50 p-4 text-brand-600"><LayoutDashboard size={28} aria-hidden="true" /></span>
            <p className="font-semibold text-slate-800">Available in Phase 12</p>
            <p className="max-w-sm text-sm text-slate-500">Sales, profit, cash balances and stock alerts will appear here once those features are built.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
