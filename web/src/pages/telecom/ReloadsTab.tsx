/**
 * Telecom > Reloads tab (route "/telecom"): summary header, provider-rate editor, "Record reloads" and the history of
 * reload entries with filters, totals, paging and "Void".
 * API: GET/POST /reload-sales, POST /reload-sales/:id/void, providers and summary (api/telecom.ts).
 * Reload revenue is the commission only; the full collection is cash in (BUSINESS_RULES section 5). Voiding keeps the
 * entry as "Void" and the server posts a reversal; it needs a reason. Totals come from the server (posted entries only).
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { DateRangeFields, PostedStatusFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useReloadProviders, useReloadSales, useVoidReloadSale } from '../../api/telecom';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { ReloadSale, ReloadSaleQuery } from '../../types/telecom';
import { ProviderRatesCard } from './ProviderRatesCard';
import { ReloadDialog } from './ReloadDialog';
import { DateCell, StatusCell, rateLabel } from './shared';
import { TelecomSummaryCard } from './TelecomSummaryCard';

/** The tab. */
export function ReloadsTab() {
  const toast = useToast();
  const voidMut = useVoidReloadSale();
  const providers = useReloadProviders();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<ReloadSale | null>(null);

  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [from, to, providerId, status]);

  const query: ReloadSaleQuery = {
    from: from || undefined, to: to || undefined, providerId: providerId ? Number(providerId) : undefined,
    status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = useReloadSales(query);
  const filtered = Boolean(from || to || providerId || status);

  const columns: Column<ReloadSale>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell date={r.businessDate} backdated={r.backdated} /> },
    { key: 'prov', header: 'Provider', render: (r) => <span className="font-medium text-slate-900">{r.providerName}</span> },
    { key: 'sales', header: 'Collected (Rs.)', align: 'right', render: (r) => <Money cents={r.salesCents} /> },
    { key: 'rate', header: 'Rate', align: 'right', render: (r) => rateLabel(r.commissionBp) },
    {
      key: 'comm', header: 'Commission (Rs.)', align: 'right',
      render: (r) => (
        <span>
          <Money cents={r.commissionCents} className="font-semibold" />
          {r.extraCents > 0 && <span className="block text-xs text-slate-500">incl. extra {formatLKR(r.extraCents)}</span>}
        </span>
      ),
    },
    { key: 'note', header: 'Notes', render: (r) => r.notes || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusCell status={r.status} reason={r.voidReason} /> },
    {
      key: 'act', header: 'Actions',
      render: (r) => (r.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(r)} aria-label={`Void reload entry #${r.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <TelecomSummaryCard />
      <ProviderRatesCard />
      <Card title="Reload entries" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record reloads</Button>}>
        <p className="mb-4 text-sm text-slate-500">
          Record each provider's reload collection. The whole amount goes into the Telecom cash book; only the commission is income.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <SelectField label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">All providers</option>
            {(providers.data?.items ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading reload entries" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No reload entries yet" hint="Record the reloads you collected for a provider."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record reloads</Button>} />
        ) : (
          <>
            {/* Totals come from the server (posted entries matching the filters), never added up here. */}
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Collected (posted): <span className="num">{formatLKR(list.data.totals.salesCents)}</span>
              <span className="mx-2 text-slate-300">|</span>
              Commission: <span className="num">{formatLKR(list.data.totals.commissionCents)}</span>
              {list.data.totals.extraCents > 0 && <span className="font-normal text-slate-500"> (incl. extra {formatLKR(list.data.totals.extraCents)})</span>}
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(r) => r.id} emptyTitle="No entries match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="entries" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <ReloadDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void reload entry #${voiding.id}`}
          intro={`This cancels the ${voiding.providerName} reload of ${formatLKR(voiding.salesCents)} dated ${voiding.businessDate}: the cash comes back out of the Telecom book and its commission is removed from the totals. It cannot be undone.`}
          submitLabel="Void entry"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, { onSuccess: (r) => { notifyCashWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Reload entry voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
