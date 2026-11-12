/**
 * DrawingsTab (route "/drawings"): everything the owner took out of the business for personal use.
 * API: GET /drawings (both kinds, filters, totals split into goods and cash, paging), POST /drawings with kind "cash",
 * POST /drawings/:id/void (api/transfers.ts).
 *
 * Two kinds sit in one list (BUSINESS_RULES section 9): CASH drawings are money out of a cash book, recorded and voided here;
 * GOODS drawings are stock taken at cost and are shown read-only - they are recorded and voided under Stock > Personal use,
 * which this screen links to. Neither kind is an expense or changes profit. Voiding never deletes: the server keeps the row
 * (shown as "Void") and posts a reversing cash entry (R1). A closed day refuses new or voided drawings until it is reopened (R9);
 * the server's message says so and is shown as it comes. Totals count POSTED drawings only; all figures come from the server.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Info, Plus } from 'lucide-react';
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
import { useOwnerDrawings, useVoidCashDrawing } from '../../api/transfers';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { CashBook } from '../../types/cashbooks';
import type { OwnerDrawing, OwnerDrawingQuery } from '../../types/transfers';
import { bookFundLabel, CashBookBadge, CashBookFilterSelect } from './BookFundFields';
import { CashDrawingDialog } from './CashDrawingDialog';

/** The drawings tab: filter bar, one list of both kinds with totals, pager, and the record / void dialogs. */
export function DrawingsTab() {
  const toast = useToast();
  const voidMut = useVoidCashDrawing();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | CashBook>('');
  const [kind, setKind] = useState<'' | 'cash' | 'goods'>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<OwnerDrawing | null>(null);

  // A new filter always starts at the first page.
  useEffect(() => { setPage(0); }, [from, to, book, kind, status]);

  const query: OwnerDrawingQuery = {
    from: from || undefined, to: to || undefined, book: book || undefined, kind: kind || undefined, status: status || undefined,
    limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = useOwnerDrawings(query);
  const filtered = Boolean(from || to || book || kind || status);

  const columns: Column<OwnerDrawing>[] = [
    { key: 'date', header: 'Date', render: (d) => <span className="inline-flex flex-wrap items-center gap-2">{d.businessDate}{d.backdated && <Badge tone="amber">Backdated</Badge>}</span> },
    { key: 'kind', header: 'Kind', render: (d) => <Badge tone={d.kind === 'cash' ? 'brand' : 'neutral'}>{d.kind === 'cash' ? 'Cash' : 'Goods'}</Badge> },
    { key: 'book', header: 'Book', render: (d) => <CashBookBadge book={d.book} fund={d.fund} /> },
    {
      key: 'what', header: 'Details',
      render: (d) => (d.kind === 'goods'
        ? <span><span className="font-medium text-slate-900">{d.productName ?? 'Goods'}</span> x {d.qty}{d.note && <span className="mt-0.5 block text-xs text-slate-500">{d.note}</span>}</span>
        : (d.note || '—')),
    },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (d) => <Money cents={d.amountCents} /> },
    {
      key: 'status', header: 'Status',
      render: (d) => (<span><PostedStatusBadge status={d.status} />{d.status === 'void' && d.voidReason && <span className="mt-1 block text-xs text-slate-500">{d.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (d) => {
        if (d.kind === 'goods') return <Link to="/stock/personal-use" className="text-sm text-brand-700 hover:underline">Manage in Stock</Link>;
        return d.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(d)} aria-label={`Void cash drawing #${d.id}`}>Void</Button> : null;
      },
    },
  ];

  return (
    <>
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>
          A drawing is something you take out of the business for yourself. It is not an expense and does not change profit.
          Cash drawings are recorded here. Goods you take from the shelf are recorded under{' '}
          <Link to="/stock/personal-use" className="text-brand-700 hover:underline">Stock &rarr; Personal use</Link>
          {' '}and are only listed here.
        </span>
      </p>
      <Card title="Owner drawings" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record cash drawing</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <CashBookFilterSelect value={book} onChange={setBook} />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as '' | 'cash' | 'goods')}>
            <option value="">Cash and goods</option>
            <option value="cash">Cash only</option>
            <option value="goods">Goods only</option>
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading drawings" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No drawings yet" hint="Record the cash you take out of a book for yourself."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record cash drawing</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Total (posted): <span className="num">{formatLKR(list.data.totals.amountCents)}</span>
              <span className="font-normal text-slate-500">
                {' '}= cash <span className="num">{formatLKR(list.data.totals.cashCents)}</span> + goods at cost <span className="num">{formatLKR(list.data.totals.goodsCents)}</span>
                . Voided drawings are not counted.
              </span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(d) => d.id} emptyTitle="No drawings match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="drawings" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <CashDrawingDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void cash drawing #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} you took on ${voiding.businessDate}: the money goes back into the ${bookFundLabel(voiding.book, voiding.fund)} cash book. It cannot be undone.`}
          submitLabel="Void drawing"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, cb)}
          onDone={() => { toast.success('Cash drawing voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
