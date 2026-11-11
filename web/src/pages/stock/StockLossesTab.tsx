/**
 * Stock > Stock losses tab (route "/stock/losses"): damaged, lost or expired stock that was written off, with
 * filters, a total at cost, paging, "Record loss" and "Void".
 * API: GET /stock-losses, POST /stock-losses (via StockOutDialog), POST /stock-losses/:id/void (api/stock.ts).
 * The server removes the stock at average cost and reports the total cost; amounts are integer cents. Voiding
 * puts the stock back at the original cost (and needs a reason; the entry stays in the list as "Void").
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
import { useStockLosses, useVoidStockLoss } from '../../api/stock';
import { useDebounced } from '../../hooks/useDebounced';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { Book, PostedStatus, StockLoss, StockLossQuery, StockLossReason } from '../../types/api';
import { REASON_LABEL, useStockProductChoices } from './shared';
import { StockOutDialog } from './StockOutDialog';

/** The tab: filter bar, losses table with total, pager, and the record / void dialogs. */
export function StockLossesTab() {
  const toast = useToast();
  const voidMut = useVoidStockLoss();
  // ---- Filter and paging state ("" means "no filter") ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [reason, setReason] = useState<'' | StockLossReason>('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  // Dialog state: `creating` shows the record form; `voiding` holds the loss being voided.
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<StockLoss | null>(null);

  // The "Find product" box narrows the Product drop-down (debounced so the server is queried once typing pauses).
  const q = useDebounced(search.trim());
  const stockProducts = useStockProductChoices(q);
  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [from, to, productId, reason, book, status]);

  // Unset filters become undefined so the API helper leaves them out of the URL.
  const query: StockLossQuery = {
    from: from || undefined,
    to: to || undefined,
    productId: productId ? Number(productId) : undefined,
    reason: reason || undefined,
    book: book || undefined,
    status: status || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const list = useStockLosses(query);
  // True when any filter is set; decides between "no losses yet" and "no losses match".
  const filtered = Boolean(from || to || productId || reason || book || status);

  const columns: Column<StockLoss>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (l) => (
        <span className="inline-flex flex-wrap items-center gap-2">{l.businessDate}{l.backdated && <Badge tone="amber">Backdated</Badge>}</span>
      ),
    },
    { key: 'prod', header: 'Product', render: (l) => <span className="font-medium text-slate-900">{l.productName}</span> },
    { key: 'book', header: 'Book', render: (l) => <BookBadge book={l.book} /> },
    { key: 'qty', header: 'Qty', align: 'right', render: (l) => l.qty },
    { key: 'cost', header: 'Cost (Rs.)', align: 'right', render: (l) => <Money cents={l.costCents} /> },
    { key: 'reason', header: 'Reason', render: (l) => <Badge tone={l.reason === 'other' ? 'neutral' : 'amber'}>{REASON_LABEL[l.reason]}</Badge> },
    { key: 'note', header: 'Note', render: (l) => l.note || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (l) => (
        <span>
          <PostedStatusBadge status={l.status} />
          {l.status === 'void' && l.voidReason && <span className="mt-1 block text-xs text-slate-500">{l.voidReason}</span>}
        </span>
      ),
    },
    {
      key: 'act',
      header: 'Actions',
      // Only live (posted) manual entries can be voided; a damaged sales-return loss belongs to its return
      // (the server answers 409 DAMAGED_RETURN_LOSS), so it is labelled instead of offering a Void button.
      render: (l) => (l.status === 'posted' && l.source === 'damaged_return' ? <span className="text-xs text-slate-500">From sale return #{l.salesReturnId}</span> : l.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(l)} aria-label={`Void loss #${l.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <Card
        title="Stock losses"
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record loss</Button>}
      >
        <p className="mb-4 text-sm text-slate-500">Damaged, lost or expired stock is removed at its average cost and counted as a stock adjustment.</p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <TextField label="Find product" placeholder="Name or code" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          <SelectField label="Product" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {stockProducts.map((p) => <option key={p.id} value={String(p.id)}>{p.name}{p.code ? ` (${p.code})` : ''}</option>)}
          </SelectField>
          <SelectField label="Reason" value={reason} onChange={(e) => setReason(e.target.value as '' | StockLossReason)}>
            <option value="">All</option>
            <option value="damaged">Damaged</option>
            <option value="lost">Lost</option>
            <option value="expired">Expired</option>
            <option value="other">Other</option>
          </SelectField>
          <BookFilterSelect value={book} onChange={setBook} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading stock losses" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No stock losses recorded"
            hint="Record damaged, lost or expired stock here."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Record loss</Button>}
          />
        ) : (
          <>
            {/* Total comes from the server (sum of posted losses matching the filters), never added up here. */}
            <p className="mb-3 text-sm font-semibold text-slate-900">Total cost of losses (posted): <span className="num">{formatLKR(list.data.totalCostCents)}</span></p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(l) => l.id} emptyTitle="No losses match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="losses" onPage={setPage} />
          </>
        )}
      </Card>
      {/* Dialogs are mounted only while open so each opening starts fresh (new clientRef, empty form). */}
      {creating && <StockOutDialog mode="loss" onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void stock loss #${voiding.id}`}
          intro={`This puts ${voiding.qty} × ${voiding.productName} back into stock at the original cost. It cannot be undone.`}
          submitLabel="Void loss"
          pending={voidMut.isPending}
          run={(r, cb) => voidMut.mutate({ id: voiding.id, reason: r }, cb)}
          onDone={() => { toast.success('Stock loss voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
