/**
 * Telecom > Top-ups tab (route "/telecom/topups"): summary header, "Record top-up" and the history of provider and
 * wallet top-ups with filters, totals by kind, paging and "Void".
 * API: GET/POST /telecom/topups, POST /telecom/topups/:id/void (api/telecom.ts).
 * A top-up is cash paid OUT of the Telecom book to refill a provider or the EZCash wallet; it is neither an expense
 * nor income, and no reload float is tracked (R14). Voiding puts the cash back (the entry stays as "Void").
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
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
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useReloadProviders, useTopups, useVoidTopup } from '../../api/telecom';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { Topup, TopupKind, TopupQuery } from '../../types/telecom';
import { DateCell, StatusCell } from './shared';
import { TelecomSummaryCard } from './TelecomSummaryCard';
import { TopupDialog } from './TopupDialog';

/** The tab. */
export function TopupsTab() {
  const toast = useToast();
  const voidMut = useVoidTopup();
  const providers = useReloadProviders();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<'' | TopupKind>('');
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Topup | null>(null);

  useEffect(() => { setPage(0); }, [from, to, kind, providerId, status]);

  const query: TopupQuery = {
    from: from || undefined, to: to || undefined, kind: kind || undefined, providerId: providerId ? Number(providerId) : undefined,
    status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = useTopups(query);
  const filtered = Boolean(from || to || kind || providerId || status);

  const columns: Column<Topup>[] = [
    { key: 'date', header: 'Date', render: (t) => <DateCell date={t.businessDate} backdated={t.backdated} /> },
    {
      key: 'kind', header: 'For',
      render: (t) => (t.kind === 'wallet_topup' ? <Badge tone="neutral">EZCash wallet</Badge> : <span className="font-medium text-slate-900">{t.providerName}</span>),
    },
    { key: 'amount', header: 'Paid out (Rs.)', align: 'right', render: (t) => <Money cents={t.amountCents} /> },
    { key: 'note', header: 'Notes', render: (t) => t.notes || '—' },
    { key: 'status', header: 'Status', render: (t) => <StatusCell status={t.status} reason={t.voidReason} /> },
    {
      key: 'act', header: 'Actions',
      render: (t) => (t.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(t)} aria-label={`Void top-up #${t.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <TelecomSummaryCard />
      <Card title="Top-ups" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record top-up</Button>}>
        <p className="mb-4 text-sm text-slate-500">
          Cash you paid to refill a provider or the EZCash wallet. It is a cash-out only: not an expense and not income.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <SelectField label="Top-up for" value={kind} onChange={(e) => setKind(e.target.value as '' | TopupKind)}>
            <option value="">All</option>
            <option value="provider_topup">Reload providers</option>
            <option value="wallet_topup">EZCash wallet</option>
          </SelectField>
          <SelectField label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">All providers</option>
            {(providers.data?.items ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading top-ups" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No top-ups yet" hint="Record cash you paid to refill a provider or the EZCash wallet."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record top-up</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Paid out (posted): <span className="num">{formatLKR(list.data.totals.totalCents)}</span>
              <span className="font-normal text-slate-500"> (providers {formatLKR(list.data.totals.providerTopupCents)} · wallet {formatLKR(list.data.totals.walletTopupCents)})</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(t) => t.id} emptyTitle="No top-ups match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="top-ups" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <TopupDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void top-up #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} top-up of ${voiding.businessDate}: the cash goes back into the Telecom book. It cannot be undone.`}
          submitLabel="Void top-up"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, cb)}
          onDone={() => { toast.success('Top-up voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
