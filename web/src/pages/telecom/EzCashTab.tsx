/**
 * Telecom > EZCash tab (route "/telecom/ezcash"): summary header, "Record EZCash bills" and the history of EZCash
 * entries with filters, totals, paging and "Void".
 * API: GET/POST /ezcash-sales, POST /ezcash-sales/:id/void (api/telecom.ts); the current rate is read from Settings.
 * EZCash is a Dialog service: the whole bill total is cash in, only the commission is income (section 5). The rate
 * is changed in Settings > Rates; each entry keeps the rate it was saved with.
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
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useEzCashSales, useVoidEzCashSale } from '../../api/telecom';
import { useSettings } from '../../api/settings';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { EzCashSale, EzCashSaleQuery } from '../../types/telecom';
import { EzCashDialog } from './EzCashDialog';
import { DateCell, StatusCell, rateLabel } from './shared';
import { TelecomSummaryCard } from './TelecomSummaryCard';

/** The tab. */
export function EzCashTab() {
  const toast = useToast();
  const voidMut = useVoidEzCashSale();
  const settings = useSettings();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<EzCashSale | null>(null);

  useEffect(() => { setPage(0); }, [from, to, status]);

  const query: EzCashSaleQuery = { from: from || undefined, to: to || undefined, status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const list = useEzCashSales(query);
  const filtered = Boolean(from || to || status);

  const columns: Column<EzCashSale>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell date={r.businessDate} backdated={r.backdated} /> },
    { key: 'bills', header: 'Bills collected (Rs.)', align: 'right', render: (r) => <Money cents={r.billTotalCents} /> },
    { key: 'rate', header: 'Rate', align: 'right', render: (r) => rateLabel(r.commissionBp) },
    { key: 'comm', header: 'Commission (Rs.)', align: 'right', render: (r) => <Money cents={r.commissionCents} className="font-semibold" /> },
    { key: 'note', header: 'Notes', render: (r) => r.notes || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusCell status={r.status} reason={r.voidReason} /> },
    {
      key: 'act', header: 'Actions',
      render: (r) => (r.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(r)} aria-label={`Void EZCash entry #${r.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <TelecomSummaryCard />
      <Card title="EZCash entries" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record EZCash bills</Button>}>
        <p className="mb-4 text-sm text-slate-500">
          Bills paid through Dialog EZCash. The whole amount goes into the Telecom cash book; only the commission is income.
          {settings.data && <> Current rate: <strong>{rateLabel(settings.data.rates.ezcashCommissionBp)}</strong> (change it in Settings &gt; Rates).</>}
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading EZCash entries" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No EZCash entries yet" hint="Record the bills you collected through EZCash."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record EZCash bills</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Bills (posted): <span className="num">{formatLKR(list.data.totals.billTotalCents)}</span>
              <span className="mx-2 text-slate-300">|</span>
              Commission: <span className="num">{formatLKR(list.data.totals.commissionCents)}</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(r) => r.id} emptyTitle="No entries match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="entries" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <EzCashDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void EZCash entry #${voiding.id}`}
          intro={`This cancels the EZCash bills of ${formatLKR(voiding.billTotalCents)} dated ${voiding.businessDate}: the cash comes back out of the Telecom book and its commission is removed from the totals. It cannot be undone.`}
          submitLabel="Void entry"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, cb)}
          onDone={() => { toast.success('EZCash entry voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
