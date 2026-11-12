/**
 * Dashboard: the home screen (route "/"). One call to GET /dashboard feeds every tile and chart (pages/dashboard/*):
 * today and this month per segment, cash per book (Ice Cream funds apart), stock, Ice Cream (recognized profit vs funds, excess-cost
 * warning), closings, backup, four charts with table alternatives, the Excel export pack and the system-status card.
 * Loading, error (with retry) and empty states are handled here; the data is re-read when the browser tab regains focus.
 * The screen never calculates a business figure; it shows what the server sent.
 */
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useDashboard } from '../api/dashboard';
import { ErrorState } from '../components/ErrorState';
import { PageHeader } from '../components/PageHeader';
import { Spinner } from '../components/Spinner';
import { CashChart, DailyChart, MonthlyChart, TopProductsChart } from './dashboard/Charts';
import { ExportPackCard } from './dashboard/ExportPackCard';
import { IceCreamBlock } from './dashboard/IceCreamBlock';
import { SystemStatusCard } from './dashboard/SystemStatusCard';
import { BackupCard, CashCard, ClosingsCard, PeriodCard, StockCard } from './dashboard/Tiles';

/** The dashboard page. */
export function Dashboard() {
  const [asOf, setAsOf] = useState('');
  const q = useDashboard(asOf || undefined);
  const d = q.data;
  const picker = (
    <label className="text-sm text-slate-600">Show figures as of
      <input type="date" value={asOf || d?.asOf || ''} onChange={(e) => setAsOf(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
    </label>
  );
  return (
    <>
      <PageHeader title="Dashboard" subtitle={d ? `Figures as of ${d.asOf}` : 'Today at a glance'} actions={picker} />
      {q.isPending ? (
        <div className="py-12 text-center"><Spinner label="Loading the dashboard" /></div>
      ) : q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : d ? (
        <div className={`space-y-6 ${q.isPlaceholderData ? 'opacity-60' : ''}`} aria-busy={q.isFetching}>
          {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
          {d.warnings.filter((w) => w.code !== 'EXCESS_COST_OUTSTANDING').length > 0 && (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <ul className="space-y-1">
                {d.warnings.filter((w) => w.code !== 'EXCESS_COST_OUTSTANDING').map((w, i) => (
                  <li key={`${w.code}-${i}`} className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{w.message}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
            <PeriodCard title="Today" subtitle={d.asOf} tile={d.today} />
            <PeriodCard title="This month" subtitle={`${d.asOf.slice(0, 8)}01 to ${d.asOf}`} tile={d.month} />
          </div>
          <IceCreamBlock ice={d.icecream} />
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <CashCard cash={d.cash} />
            <StockCard stock={d.stock} />
            <ClosingsCard closings={d.closings} />
            <BackupCard backup={d.backup} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <DailyChart rows={d.series.daily} />
            <MonthlyChart rows={d.series.monthly} />
            <TopProductsChart rows={d.series.topProducts} />
            <CashChart cash={d.cash} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <ExportPackCard asOf={d.asOf} />
            <SystemStatusCard />
          </div>
        </div>
      ) : null}
    </>
  );
}
