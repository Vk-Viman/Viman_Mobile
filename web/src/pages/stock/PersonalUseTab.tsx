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
import { useDrawings, useVoidDrawing } from '../../api/stock';
import { formatLKR } from '../../lib/format';
import type { Book, Drawing, DrawingQuery, PostedStatus } from '../../types/api';
import { BOOK_LABEL, useDebounced } from '../products/shared';
import { Pager, VoidRecordDialog } from './shared';
import { StockOutDialog } from './StockOutDialog';

const LIMIT = 50;

export function PersonalUseTab() {
  const toast = useToast();
  const voidMut = useVoidDrawing();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Drawing | null>(null);

  const q = useDebounced(search.trim(), 300);
  const products = useProducts({ q: q || undefined, limit: 500 });
  const stockProducts = useMemo(() => (products.data?.items ?? []).filter((p) => p.kind === 'stock'), [products.data]);
  useEffect(() => { setPage(0); }, [from, to, productId, book, status]);

  const query: DrawingQuery = {
    kind: 'goods',
    from: from || undefined,
    to: to || undefined,
    productId: productId ? Number(productId) : undefined,
    book: book || undefined,
    status: status || undefined,
    limit: LIMIT,
    offset: page * LIMIT,
  };
  const list = useDrawings(query);
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
    { key: 'book', header: 'Book', render: (d) => <Badge tone={d.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[d.book]}</Badge> },
    { key: 'qty', header: 'Qty', align: 'right', render: (d) => d.qty ?? '—' },
    { key: 'cost', header: 'Cost (Rs.)', align: 'right', render: (d) => <Money cents={d.amountCents} /> },
    { key: 'note', header: 'Note', render: (d) => d.note || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (d) => (
        <span>
          <Badge tone={d.status === 'void' ? 'red' : 'brand'}>{d.status === 'void' ? 'Void' : 'Posted'}</Badge>
          {d.status === 'void' && d.voidReason && <span className="mt-1 block text-xs text-slate-500">{d.voidReason}</span>}
        </span>
      ),
    },
    {
      key: 'act',
      header: 'Actions',
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
          <TextField label="From date" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To date" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          <TextField label="Find product" placeholder="Name or code" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          <SelectField label="Product" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {stockProducts.map((p) => <option key={p.id} value={String(p.id)}>{p.name}{p.code ? ` (${p.code})` : ''}</option>)}
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
            <p className="mb-3 text-sm font-semibold text-slate-900">Total drawn at cost (posted): <span className="num">{formatLKR(list.data.totalAmountCents)}</span></p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(d) => d.id} emptyTitle="No records match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={LIMIT} noun="records" onPage={setPage} />
          </>
        )}
      </Card>
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
