import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useProducts } from '../../api/catalog';
import { useStockLosses, useVoidStockLoss } from '../../api/stock';
import { formatLKR } from '../../lib/format';
import type { Book, PostedStatus, StockLoss, StockLossQuery, StockLossReason } from '../../types/api';
import { BOOK_LABEL, useDebounced } from '../products/shared';
import { Pager, REASON_LABEL, VoidRecordDialog } from './shared';
import { StockOutDialog } from './StockOutDialog';

const LIMIT = 50;

export function StockLossesTab() {
  const toast = useToast();
  const voidMut = useVoidStockLoss();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [reason, setReason] = useState<'' | StockLossReason>('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<StockLoss | null>(null);

  const q = useDebounced(search.trim(), 300);
  const products = useProducts({ q: q || undefined, limit: 500 });
  const stockProducts = useMemo(() => (products.data?.items ?? []).filter((p) => p.kind === 'stock'), [products.data]);
  useEffect(() => { setPage(0); }, [from, to, productId, reason, book, status]);

  const query: StockLossQuery = {
    from: from || undefined,
    to: to || undefined,
    productId: productId ? Number(productId) : undefined,
    reason: reason || undefined,
    book: book || undefined,
    status: status || undefined,
    limit: LIMIT,
    offset: page * LIMIT,
  };
  const list = useStockLosses(query);
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
    { key: 'book', header: 'Book', render: (l) => <Badge tone={l.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[l.book]}</Badge> },
    { key: 'qty', header: 'Qty', align: 'right', render: (l) => l.qty },
    { key: 'cost', header: 'Cost (Rs.)', align: 'right', render: (l) => <Money cents={l.costCents} /> },
    { key: 'reason', header: 'Reason', render: (l) => <Badge tone={l.reason === 'other' ? 'neutral' : 'amber'}>{REASON_LABEL[l.reason]}</Badge> },
    { key: 'note', header: 'Note', render: (l) => l.note || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (l) => (
        <span>
          <Badge tone={l.status === 'void' ? 'red' : 'brand'}>{l.status === 'void' ? 'Void' : 'Posted'}</Badge>
          {l.status === 'void' && l.voidReason && <span className="mt-1 block text-xs text-slate-500">{l.voidReason}</span>}
        </span>
      ),
    },
    {
      key: 'act',
      header: 'Actions',
      render: (l) => (l.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(l)} aria-label={`Void loss #${l.id}`}>Void</Button> : null),
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
          <TextField label="From date" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To date" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
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
          <SelectField label="Book" value={book} onChange={(e) => setBook(e.target.value as '' | Book)}>
            <option value="">All</option>
            <option value="shop">Shop</option>
            <option value="telecom">Telecom</option>
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | PostedStatus)}>
            <option value="">All</option>
            <option value="posted">Posted</option>
            <option value="void">Void</option>
          </SelectField>
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
            <p className="mb-3 text-sm font-semibold text-slate-900">Total cost of losses (posted): <span className="num">{formatLKR(list.data.totalCostCents)}</span></p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(l) => l.id} emptyTitle="No losses match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={LIMIT} noun="losses" onPage={setPage} />
          </>
        )}
      </Card>
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
