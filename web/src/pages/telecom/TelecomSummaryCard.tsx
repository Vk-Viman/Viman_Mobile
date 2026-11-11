/**
 * TelecomSummaryCard: the summary header at the top of every Telecom tab.
 * API: GET /telecom/summary?from&to (api/telecom.ts). Posted entries only; voided ones never count.
 * Telecom revenue is the COMMISSION only (BUSINESS_RULES section 5): the collections and top-ups shown here are cash
 * movements, not income or expense. R14: no float is tracked, so the Telecom cash book is not expected to match profit.
 * All figures come from the server in integer cents; nothing is added up here.
 */
import { useState } from 'react';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { DateRangeFields } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { useTelecomSummary } from '../../api/telecom';
import { formatLKR } from '../../lib/format';
import type { ProviderSummary } from '../../types/telecom';

/** One headline figure. */
function Tile({ label, cents, strong = false, hint }: { label: string; cents: number; strong?: boolean; hint?: string }) {
  return (
    <div className={`rounded-lg border p-3 ${strong ? 'border-brand-200 bg-brand-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900"><Money cents={cents} /></p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** The card: optional date range (empty = all time), headline tiles and a per-provider table. */
export function TelecomSummaryCard() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const summary = useTelecomSummary({ from: from || undefined, to: to || undefined });

  const columns: Column<ProviderSummary>[] = [
    { key: 'name', header: 'Provider', render: (p) => <span className="font-medium text-slate-900">{p.name}</span> },
    { key: 'rs', header: 'Reload collected', align: 'right', render: (p) => <Money cents={p.reloadSalesCents} /> },
    { key: 'rc', header: 'Reload commission', align: 'right', render: (p) => <Money cents={p.reloadCommissionCents} /> },
    { key: 'eb', header: 'EZCash bills', align: 'right', render: (p) => <Money cents={p.ezcashBillCents} /> },
    { key: 'ec', header: 'EZCash commission', align: 'right', render: (p) => <Money cents={p.ezcashCommissionCents} /> },
    { key: 'tp', header: 'Top-ups paid', align: 'right', render: (p) => <Money cents={p.topupsCents} /> },
    { key: 'rev', header: 'Commission revenue', align: 'right', render: (p) => <Money cents={p.commissionRevenueCents} className="font-semibold" /> },
  ];

  return (
    <Card title="Telecom summary" className="mb-4">
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </div>
      {summary.isPending ? (
        <div className="flex justify-center py-8"><Spinner label="Loading summary" /></div>
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Commission revenue" cents={summary.data.totals.commissionRevenueCents} strong hint="Reload (incl. extra) + EZCash commission" />
            <Tile label="Reload collected" cents={summary.data.totals.reloadSalesCents} hint={`Commission ${formatLKR(summary.data.totals.reloadCommissionCents)}`} />
            <Tile label="EZCash bills collected" cents={summary.data.totals.ezcashBillCents} hint={`Commission ${formatLKR(summary.data.totals.ezcashCommissionCents)}`} />
            <Tile label="Top-ups paid out" cents={summary.data.totals.topupsCents} hint={`Providers ${formatLKR(summary.data.totals.providerTopupsCents)} · Wallet ${formatLKR(summary.data.totals.walletTopupsCents)}`} />
          </div>
          <div className="mt-4">
            <DataTable columns={columns} rows={summary.data.providers} rowKey={(p) => p.providerId} />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Only the commission is Telecom income. Collections and top-ups are cash movements. The Telecom cash book is not expected to
            match the profit because reload balances are not tracked.
          </p>
        </>
      )}
    </Card>
  );
}
