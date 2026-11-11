/**
 * SuppliesTab (route "/printing/supplies"): paper and toner purchases for the print shop.
 *
 * A supplies purchase is a CASH-OUT of the Shop cash book and has NO effect on profit (R12): profit only ever
 * charges the standard cost of each page sold. The later variance report compares that standard cost with what was
 * really spent here, so every purchase should be recorded.
 * API: GET /printing-supplies, POST /printing-supplies (SupplyDialog), POST /printing-supplies/:id/void (api/printing.ts).
 * The total comes from the server in integer cents. Voiding puts the money back in the Shop book (needs a reason).
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
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { usePrintingSupplies, useVoidPrintingSupply } from '../../api/printing';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { PrintingSupply, PrintingSupplyQuery } from '../../types/printing';
import { SupplyDialog } from './SupplyDialog';

/** The tab: explanation, filters, purchases table with total, pager and the record / void dialogs. */
export function SuppliesTab() {
  const toast = useToast();
  const voidMut = useVoidPrintingSupply();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<PrintingSupply | null>(null);
  useEffect(() => { setPage(0); }, [from, to, status]);

  const query: PrintingSupplyQuery = { from: from || undefined, to: to || undefined, status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const list = usePrintingSupplies(query);
  const filtered = Boolean(from || to || status);

  const columns: Column<PrintingSupply>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (s) => <span className="inline-flex flex-wrap items-center gap-2">{s.businessDate}{s.backdated && <Badge tone="amber">Backdated</Badge>}</span>,
    },
    { key: 'desc', header: 'What was bought', render: (s) => <span className="font-medium text-slate-900">{s.description}</span> },
    { key: 'amt', header: 'Amount paid', align: 'right', render: (s) => <Money cents={s.amountCents} /> },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (
        <span>
          <PostedStatusBadge status={s.status} />
          {s.status === 'void' && s.voidReason && <span className="mt-1 block text-xs text-slate-500">{s.voidReason}</span>}
        </span>
      ),
    },
    {
      key: 'act',
      header: 'Actions',
      render: (s) => (s.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(s)} aria-label={`Void supplies purchase #${s.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <Card
        title="Paper and toner purchases"
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record purchase</Button>}
      >
        <p className="mb-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
          Paper and toner you buy are <strong>cash paid out</strong> of the Shop cash book. They do <strong>not</strong> change your profit: profit only
          counts the standard cost of the pages you sell. These purchases are kept so a later report can compare what you really spent on
          supplies with the standard cost charged on print sales.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>
        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading supplies" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No supplies recorded"
            hint="Record each paper or toner purchase when you pay for it."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record purchase</Button>}
          />
        ) : (
          <>
            {/* Total comes from the server (sum of posted purchases matching the filters), never added up here. */}
            <p className="mb-3 text-sm font-semibold text-slate-900">Total spent on supplies (posted): <span className="num">{formatLKR(list.data.totals.amountCents)}</span></p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(s) => s.id} emptyTitle="No purchases match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="purchases" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <SupplyDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void supplies purchase #${voiding.id}`}
          intro={`This cancels the purchase "${voiding.description}" and puts ${formatLKR(voiding.amountCents)} back into the Shop cash book. The record stays in the history as Void. It cannot be undone.`}
          submitLabel="Void purchase"
          pending={voidMut.isPending}
          run={(r, cb) => voidMut.mutate({ id: voiding.id, reason: r }, cb)}
          onDone={() => { toast.success('Supplies purchase voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
