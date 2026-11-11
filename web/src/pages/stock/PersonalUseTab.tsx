/**
 * Stock > Personal use tab (route "/stock/personal-use"): goods the owner took from stock for personal use
 * (recorded as owner drawings at cost), with filters, a total, paging, "Record personal use" and "Void".
 * API: GET /drawings (kind "goods"), POST /drawings (via StockOutDialog), POST /drawings/:id/void (api/stock.ts).
 * It is not a sale and not a stock loss; the server values it at average cost and reports the total in integer
 * cents. Voiding puts the stock back at the original cost (needs a reason; the entry stays as "Void").
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
import { BookFilterSelect, DateRangeFields, PostedStatusFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { BookBadge, PostedStatusBadge } from '../../components/StatusBadges';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useDrawings, useVoidDrawing } from '../../api/stock';
import { useDebounced } from '../../hooks/useDebounced';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { Book, Drawing, DrawingQuery, PostedStatus } from '../../types/api';
import { useStockProductChoices } from './shared';
import { StockOutDialog } from './StockOutDialog';

/** The tab: filter bar, drawings table with total, pager, and the record / void dialogs. */
export function PersonalUseTab() {
  const toast = useToast();
  const voidMut = useVoidDrawing();
  // ---- Filter and paging state ("" means "no filter") ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  // Dialog state: `creating` shows the record form; `voiding` holds the drawing being voided.
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Drawing | null>(null);

  // The "Find product" box narrows the Product drop-down (debounced so the server is queried once typing pauses).
  const q = useDebounced(search.trim());
  const stockProducts = useStockProductChoices(q);
  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [from, to, productId, book, status]);

  // Unset filters become undefined so the API helper leaves them out of the URL. `kind: 'goods'` excludes cash drawings.
  const query: DrawingQuery = {
    kind: 'goods',
    from: from || undefined,
    to: to || undefined,
    productId: productId ? Number(productId) : undefined,
    book: book || undefined,
    status: status || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const list = useDrawings(query);
  // True when any filter is set; decides between "nothing yet" and "nothing matches".
  const filtered = Boolean(from || to || productId || book || status);

  const columns: Column<Drawing>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (d) => (
        <span className="inline-flex flex-wrap items-center gap-2">{d.businessDate}{d.backdated && <Badge tone="amber">Backdated</Badge>}</span>
      ),
    },
    { key: 'prod', header: 'Product', render: (d) => <span className="font-medium text-slate-900">{d.productName ?? '—'}</span> },
    { key: 'book', header: 'Book', render: (d) => <BookBadge book={d.book} /> },
    { key: 'qty', header: 'Qty', align: 'right', render: (d) => d.qty ?? '—' },
    { key: 'cost', header: 'Cost (Rs.)', align: 'right', render: (d) => <Money cents={d.amountCents} /> },
    { key: 'note', header: 'Note', render: (d) => d.note || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (d) => (
        <span>
          <PostedStatusBadge status={d.status} />
          {d.status === 'void' && d.voidReason && <span className="mt-1 block text-xs text-slate-500">{d.voidReason}</span>}
        </span>
      ),
    },
    {
      key: 'act',
      header: 'Actions',
      // Only live (posted) entries can be voided.
      render: (d) => (d.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(d)} aria-label={`Void personal use #${d.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <Card
        title="Personal use"
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record personal use</Button>}
      >
        <p className="mb-4 text-sm text-slate-500">
          Stock taken for your own use is recorded at cost as an owner drawing. It is not a sale and not a stock loss.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <TextField label="Find product" placeholder="Name or code" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          <SelectField label="Product" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {stockProducts.map((p) => <option key={p.id} value={String(p.id)}>{p.name}{p.code ? ` (${p.code})` : ''}</option>)}
          </SelectField>
          <BookFilterSelect value={book} onChange={setBook} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading personal use" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No personal use recorded"
            hint="Record goods you take from stock for your own use."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record personal use</Button>}
          />
        ) : (
          <>
            {/* Total comes from the server (sum of posted drawings matching the filters), never added up here. */}
            <p className="mb-3 text-sm font-semibold text-slate-900">Total drawn at cost (posted): <span className="num">{formatLKR(list.data.totalAmountCents)}</span></p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(d) => d.id} emptyTitle="No records match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="records" onPage={setPage} />
          </>
        )}
      </Card>
      {/* Dialogs are mounted only while open so each opening starts fresh (new clientRef, empty form). */}
      {creating && <StockOutDialog mode="use" onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void personal use #${voiding.id}`}
          intro={`This puts ${voiding.qty ?? ''} × ${voiding.productName ?? 'the product'} back into stock at the original cost. It cannot be undone.`}
          submitLabel="Void record"
          pending={voidMut.isPending}
          run={(r, cb) => voidMut.mutate({ id: voiding.id, reason: r }, cb)}
          onDone={() => { toast.success('Personal use voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
