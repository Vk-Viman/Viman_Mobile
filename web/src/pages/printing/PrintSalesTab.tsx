/**
 * PrintSalesTab (route "/printing"): quick print / photocopy sales, period totals and the sales history.
 *
 * Top: the quick-entry panel (QuickEntry.tsx). Below: a history with filters (dates, service, status), paging and
 * "Void", plus the period totals (revenue, standard cost, gross profit) of the POSTED sales that match the filters.
 * API: GET /print-service-types?active=true, GET /print-sales, POST /print-sales/:id/void (api/printing.ts).
 * All totals come from the server in integer cents. Voiding never deletes: the server keeps the sale and posts a
 * reversing cash entry (R1), so a reason is required.
 */
import { useEffect, useState } from 'react';
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
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { usePrintSales, usePrintServiceTypes, useVoidPrintSale } from '../../api/printing';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { PAGE_SIZE } from '../../lib/constants';
import type { PostedStatus } from '../../types/api';
import type { PrintSale, PrintSaleQuery, PrintWarning } from '../../types/printing';
import { QuickEntry } from './QuickEntry';
import { warningsText } from './shared';

/** The tab: quick entry, filters + totals, history table, pager and the void dialog. */
export function PrintSalesTab() {
  const toast = useToast();
  const voidMut = useVoidPrintSale();
  const { today } = useBusinessDate();
  const activeTypes = usePrintServiceTypes(true);
  const allTypes = usePrintServiceTypes(false);

  // Changing this key re-mounts the quick-entry form, which gives the next sale a fresh clientRef and an empty form.
  const [formKey, setFormKey] = useState(0);
  const [last, setLast] = useState<{ sale: PrintSale; warnings: PrintWarning[] } | null>(null);

  // ---- Filter and paging state ("" means "no filter") ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [typeId, setTypeId] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [voiding, setVoiding] = useState<PrintSale | null>(null);
  useEffect(() => { setPage(0); }, [from, to, typeId, status]);

  const query: PrintSaleQuery = {
    from: from || undefined,
    to: to || undefined,
    serviceTypeId: typeId ? Number(typeId) : undefined,
    status: status || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const list = usePrintSales(query);
  const filtered = Boolean(from || to || typeId || status);
  // Range shortcuts use the server's business date (not the PC clock).
  const monthStart = today ? `${today.slice(0, 8)}01` : '';

  const columns: Column<PrintSale>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (s) => <span className="inline-flex flex-wrap items-center gap-2">{s.businessDate}{s.backdated && <Badge tone="amber">Backdated</Badge>}</span>,
    },
    {
      key: 'svc',
      header: 'Service',
      render: (s) => (
        <span>
          <span className="font-medium text-slate-900">{s.description}</span>
          {s.notes && <span className="block text-xs text-slate-500">{s.notes}</span>}
        </span>
      ),
    },
    { key: 'qty', header: 'Pages', align: 'right', render: (s) => s.qty },
    { key: 'price', header: 'Price / page', align: 'right', render: (s) => <Money cents={s.unitPriceCents} /> },
    { key: 'rev', header: 'Revenue', align: 'right', render: (s) => <Money cents={s.revenueCents} /> },
    { key: 'cost', header: 'Std cost', align: 'right', render: (s) => <Money cents={s.cogsCents} /> },
    { key: 'gp', header: 'Gross profit', align: 'right', render: (s) => <Money cents={s.grossProfitCents} /> },
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
      render: (s) => (s.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(s)} aria-label={`Void print sale #${s.id}`}>Void</Button> : null),
    },
  ];

  return (
    <div className="space-y-5">
      <Card title="Record a print sale">
        {activeTypes.isPending ? (
          <div className="flex justify-center py-8"><Spinner label="Loading services" /></div>
        ) : activeTypes.isError ? (
          <ErrorState error={activeTypes.error} onRetry={() => void activeTypes.refetch()} />
        ) : (
          <>
            {last && (
              <div role="status" className="mb-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-800">
                Saved sale #{last.sale.id}: {last.sale.qty} × {last.sale.description} = <Money cents={last.sale.revenueCents} className="font-semibold" /> added to the Shop cash book.
                {last.warnings.length > 0 && <span className="mt-1 block text-amber-800">{warningsText(last.warnings)}</span>}
              </div>
            )}
            <QuickEntry
              key={formKey}
              types={activeTypes.data.items}
              onSaved={(sale, warnings) => { setLast({ sale, warnings }); setFormKey((k) => k + 1); }}
            />
          </>
        )}
      </Card>

      <Card title="Sales history">
        <div className="mb-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { setFrom(today); setTo(today); }} disabled={!today}>Today</Button>
          <Button variant="secondary" onClick={() => { setFrom(monthStart); setTo(today); }} disabled={!today}>This month</Button>
          <Button variant="secondary" onClick={() => { setFrom(''); setTo(''); }} disabled={!from && !to}>All dates</Button>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <SelectField label="Service" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">All services</option>
            {(allTypes.data?.items ?? []).map((t) => <option key={t.id} value={String(t.id)}>{t.name}{t.active ? '' : ' (off)'}</option>)}
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading print sales" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No print sales yet" hint="Choose a service above and record the first sale." />
        ) : (
          <>
            {/* Totals come from the server (posted sales matching the filters), never added up here. */}
            <dl className="mb-4 grid gap-3 sm:grid-cols-3">
              <Tile label="Revenue (posted)" cents={list.data.totals.revenueCents} />
              <Tile label="Standard cost (posted)" cents={list.data.totals.cogsCents} />
              <Tile label="Gross profit (posted)" cents={list.data.totals.grossProfitCents} strong />
            </dl>
            <DataTable columns={columns} rows={list.data.items} rowKey={(s) => s.id} emptyTitle="No sales match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="sales" onPage={setPage} />
          </>
        )}
      </Card>

      {voiding && (
        <VoidRecordDialog
          title={`Void print sale #${voiding.id}`}
          intro={`This cancels the sale of ${voiding.qty} × ${voiding.description} and takes its revenue out of the Shop cash book. The record stays in the history as Void. It cannot be undone.`}
          submitLabel="Void sale"
          pending={voidMut.isPending}
          run={(r, cb) => voidMut.mutate({ id: voiding.id, reason: r }, cb)}
          onDone={() => { toast.success('Print sale voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </div>
  );
}

/** One total in the totals strip. */
function Tile({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-1 text-lg ${strong ? 'font-bold' : 'font-semibold'} text-slate-900`}><Money cents={cents} /></dd>
    </div>
  );
}
