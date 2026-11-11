import { useEffect, useState } from 'react';
import { History, Pencil, Plus, Search } from 'lucide-react';
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
import { useCategories, useProducts } from '../../api/catalog';
import type { Book, Product, ProductQuery } from '../../types/api';
import { ProductDialog } from './ProductDialog';
import { MovementsDialog } from '../purchases/MovementsDialog';
import { BOOK_LABEL, CHECKBOX_CLASS, useDebounced } from './shared';

const LIMIT = 50;
type StatusFilter = 'active' | 'inactive' | 'all';

export function ProductsTab() {
  const [search, setSearch] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState<{ product: Product | null } | null>(null);
  const [history, setHistory] = useState<Product | null>(null);

  const q = useDebounced(search.trim(), 300);
  const cats = useCategories();

  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [q, book, categoryId, status, lowOnly]);

  const query: ProductQuery = {
    q: q || undefined,
    book: book || undefined,
    categoryId: categoryId ? Number(categoryId) : undefined,
    active: status === 'all' ? undefined : status === 'active',
    lowStock: lowOnly ? true : undefined,
    limit: LIMIT,
    offset: page * LIMIT,
  };
  const products = useProducts(query);

  const categoryChoices = (cats.data?.items ?? []).filter((c) => !book || c.book === book);

  const columns: Column<Product>[] = [
    { key: 'code', header: 'Code', render: (p) => p.code ?? '—' },
    {
      key: 'name',
      header: 'Name',
      render: (p) => (
        <span className="font-medium text-slate-900">{p.name}</span>
      ),
    },
    { key: 'cat', header: 'Category', render: (p) => p.categoryName },
    { key: 'book', header: 'Book', render: (p) => <Badge tone={p.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[p.book]}</Badge> },
    { key: 'kind', header: 'Kind', render: (p) => (p.kind === 'stock' ? 'Stock item' : 'Service') },
    { key: 'sell', header: 'Selling price', align: 'right', render: (p) => <Money cents={p.sellPriceCents} /> },
    { key: 'min', header: 'Min price', align: 'right', render: (p) => <Money cents={p.minPriceCents} /> },
    {
      key: 'qty',
      header: 'Stock',
      align: 'right',
      render: (p) =>
        p.kind === 'service' ? (
          '—'
        ) : (
          <span className="inline-flex items-center justify-end gap-2">
            {p.lowStock && <Badge tone="amber">Low stock</Badge>}
            <span>{p.qtyOnHand}</span>
          </span>
        ),
    },
    { key: 'avg', header: 'Avg cost', align: 'right', render: (p) => (p.avgUnitCostCents === null ? '—' : <Money cents={p.avgUnitCostCents} />) },
    { key: 'reorder', header: 'Reorder level', align: 'right', render: (p) => (p.kind === 'service' ? '—' : p.reorderLevel) },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={p.active ? 'brand' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge> },
    {
      key: 'actions',
      header: 'Actions',
      render: (p) => (
        <span className="inline-flex gap-1">
          <Button
            variant="ghost"
            className="!min-h-8 !px-2"
            aria-label={`Edit ${p.name}`}
            onClick={(e) => { e.stopPropagation(); setDialog({ product: p }); }}
          >
            <Pencil size={16} aria-hidden="true" /> Edit
          </Button>
          {p.kind === 'stock' && (
            <Button
              variant="ghost"
              className="!min-h-8 !px-2"
              aria-label={`Stock history for ${p.name}`}
              onClick={(e) => { e.stopPropagation(); setHistory(p); }}
            >
              <History size={16} aria-hidden="true" /> History
            </Button>
          )}
        </span>
      ),
    },
  ];

  const total = products.data?.total ?? 0;
  const from = total === 0 ? 0 : page * LIMIT + 1;
  const to = Math.min(total, (page + 1) * LIMIT);
  const filtered = Boolean(q || book || categoryId || lowOnly || status !== 'active');

  return (
    <>
      <p className="mb-4 text-sm text-slate-500">Stock is added through purchases and the opening-stock screen (coming in later phases).</p>
      <Card
        title="Products"
        actions={
          <Button onClick={() => setDialog({ product: null })}>
            <Plus size={16} aria-hidden="true" /> New product
          </Button>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative lg:col-span-2">
            <TextField
              label="Search products"
              placeholder="Search by name or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
              className="[&_input]:pl-9"
            />
            <Search size={16} className="pointer-events-none absolute bottom-3 left-3 text-slate-400" aria-hidden="true" />
          </div>
          <SelectField label="Book" value={book} onChange={(e) => { setBook(e.target.value as '' | Book); setCategoryId(''); }}>
            <option value="">All</option>
            <option value="shop">Shop</option>
            <option value="telecom">Telecom</option>
          </SelectField>
          <SelectField label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {categoryChoices.map((c) => (
              <option key={c.id} value={String(c.id)}>{c.name} ({BOOK_LABEL[c.book]}){c.active ? '' : ' - inactive'}</option>
            ))}
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </SelectField>
        </div>
        <label className="mb-4 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low stock only
        </label>

        {products.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading products" /></div>
        ) : products.isError ? (
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : products.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No products yet — add your first product"
            hint="Products are the items and services you sell."
            action={<Button onClick={() => setDialog({ product: null })}><Plus size={16} aria-hidden="true" /> New product</Button>}
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={products.data.items}
              rowKey={(p) => p.id}
              emptyTitle="No products match these filters"
              emptyHint="Try a different search or clear a filter."
              onRowClick={(p) => setDialog({ product: p })}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
              <span>{total === 0 ? '0 products' : `Showing ${from}–${to} of ${total} products`}</span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
                <Button variant="secondary" disabled={to >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>
      {history && <MovementsDialog product={history} onClose={() => setHistory(null)} />}
      {dialog && <ProductDialog key={dialog.product?.id ?? 'new'} product={dialog.product} onClose={() => setDialog(null)} />}
    </>
  );
}
