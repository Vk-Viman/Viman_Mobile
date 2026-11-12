/**
 * DaysTab (route "/ice-cream"): the Ice Cream daily entries - add, replace (void-and-replace) and void.
 * API: GET /icecream/days, POST /icecream/days, PUT /icecream/days/:date, POST /icecream/days/:date/void (api/icecream.ts).
 *
 * One POSTED entry per date (BUSINESS_RULES 10.2): each entry splits the day's sales into the Cost, Electricity and Profit funds and
 * adds the profit share to the recognized profit (10.3). Editing is void-and-replace (C9) and voiding never deletes: the server
 * keeps the entry (shown as "Void") and posts reversals (R1). The server refuses a replace or void that would leave released
 * profit without backing (D2, VOID_BREAKS_RELEASE) and writes to a closed day (R9); its messages are shown as they come.
 * Totals count POSTED entries only. All figures are calculated by the server.
 */
import { useEffect, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
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
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useDays, useVoidDay } from '../../api/icecream';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { DayQuery, IceDay } from '../../types/icecream';
import { DayDialog } from './DayDialog';
import { notifyIceWarnings } from './shared';

/** The daily entries screen. */
export function DaysTab() {
  const toast = useToast();
  const voidMut = useVoidDay();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<IceDay | null>(null);
  const [voiding, setVoiding] = useState<IceDay | null>(null);

  useEffect(() => { setPage(0); }, [from, to, status]);

  const query: DayQuery = { from: from || undefined, to: to || undefined, status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const list = useDays(query);
  const filtered = Boolean(from || to || status);

  const columns: Column<IceDay>[] = [
    {
      key: 'date', header: 'Date',
      render: (d) => <span className="inline-flex flex-wrap items-center gap-2">{d.businessDate}{d.backdated && <Badge tone="amber">Backdated</Badge>}</span>,
    },
    {
      key: 'sales', header: 'Sales (Rs.)', align: 'right',
      render: (d) => (
        <span><Money cents={d.salesCents} />{d.items.length > 0 && <span className="mt-0.5 block text-xs text-slate-500">{d.items.length} item line{d.items.length === 1 ? '' : 's'}</span>}</span>
      ),
    },
    { key: 'cost', header: 'Cost (Rs.)', align: 'right', render: (d) => <Money cents={d.costAllocCents} /> },
    { key: 'elec', header: 'Electricity (Rs.)', align: 'right', render: (d) => <Money cents={d.electricityAllocCents} /> },
    {
      key: 'profit', header: 'Profit share (Rs.)', align: 'right',
      render: (d) => <span><Money cents={d.profitShareCents} />{d.negativeConfirmed && <span className="mt-0.5 block text-xs text-red-700">Confirmed negative</span>}</span>,
    },
    {
      key: 'status', header: 'Status',
      render: (d) => (<span><PostedStatusBadge status={d.status} />{d.status === 'void' && d.voidReason && <span className="mt-1 block text-xs text-slate-500">{d.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (d) => (d.status === 'posted' ? (
        <span className="inline-flex gap-1">
          <Button variant="ghost" onClick={() => setReplacing(d)} aria-label={`Replace the daily entry of ${d.businessDate}`}><Pencil size={14} aria-hidden="true" /> Replace</Button>
          <Button variant="ghost" onClick={() => setVoiding(d)} aria-label={`Void the daily entry of ${d.businessDate}`}>Void</Button>
        </span>
      ) : null),
    },
  ];

  return (
    <>
      <p className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        One entry per day. Sales are split into the <strong>Cost</strong> fund (materials), the <strong>Electricity</strong> fund and the <strong>Profit</strong> fund.
        To correct a day, use Replace: the old entry stays in the history as void.
      </p>
      <Card title="Daily entries" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add daily entry</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading daily entries" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No daily entries yet" hint="Record each day's ice cream sales and how much is set aside for materials and electricity."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add daily entry</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Posted entries: sales <span className="num">{formatLKR(list.data.totals.salesCents)}</span>, cost <span className="num">{formatLKR(list.data.totals.costAllocCents)}</span>,
              electricity <span className="num">{formatLKR(list.data.totals.electricityAllocCents)}</span>, profit share <span className="num">{formatLKR(list.data.totals.profitShareCents)}</span>
              <span className="font-normal text-slate-500"> for the entries that match these filters; voided ones are not counted.</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(d) => d.id} emptyTitle="No daily entries match these filters" emptyHint="Try a different date range or clear a filter."
              renderExtra={(d) => (d.items.length > 0 ? (
                <ul className="text-xs text-slate-600">
                  {d.items.map((i) => <li key={i.id}>{i.qty} x {i.itemName} at {formatLKR(i.unitPriceCents)} = {formatLKR(i.lineTotalCents)}</li>)}
                </ul>
              ) : null)} />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="entries" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <DayDialog onClose={() => setCreating(false)} />}
      {replacing && <DayDialog replacing={replacing} onClose={() => setReplacing(null)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void the daily entry of ${voiding.businessDate}`}
          intro={`This cancels the entry of ${voiding.businessDate} (sales ${formatLKR(voiding.salesCents)}): its cost, electricity and profit shares leave the funds. `
            + 'If profit was already released from it the server will refuse - reverse that release first. It cannot be undone.'}
          submitLabel="Void entry"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ date: voiding.businessDate, reason }, { onSuccess: (r) => { notifyIceWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Daily entry voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
