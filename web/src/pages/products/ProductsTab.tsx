/**
 * Products > Products tab (route "/products", the default tab): searchable, filterable, paged catalogue with
 * add/edit and a per-product stock history.
 * API: GET /categories (for the category filter), GET /products (api/catalog.ts); stock history opens
 * MovementsDialog (GET /products/:id/movements). Quantities, values and averages shown are calculated by the
 * server; this screen only formats them.
 */
import { useEffect, useState } from 'react';
import { History, Pencil, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { BookFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { SearchField } from '../../components/SearchField';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { ActiveBadge, BookBadge } from '../../components/StatusBadges';
import { useCategories, useProducts } from '../../api/catalog';
import { useDebounced } from '../../hooks/useDebounced';
import { BOOK_LABEL, CHECKBOX_CLASS, PAGE_SIZE } from '../../lib/constants';
import type { Book, Product, ProductQuery } from '../../types/api';
import { ProductDialog } from './ProductDialog';
import { MovementsDialog } from '../purchases/MovementsDialog';
import { StatusFilterOptions, statusToActive } from './shared';
import type { StatusFilter } from './shared';

/** The tab: filter bar, product table, pager and the add/edit and history dialogs. */
export function ProductsTab() {
  // ---- Filter and paging state ("" means "no filter") ----
  const [search, setSearch] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(0);
  // Dialog state: null = closed; { product: null } = "new product"; { product: p } = editing p.
  const [dialog, setDialog] = useState<{ product: Product | null } | null>(null);
  const [history, setHistory] = useState<Product | null>(null);

  // Debounced search text: the box updates instantly, the server is queried once typing pauses.
  const q = useDebounced(search.trim());
  const cats = useCategories();

  // Back to the first page whenever a filter changes (otherwise page 3 of a smaller result could be empty).
  useEffect(() => { setPage(0); }, [q, book, categoryId, status, lowOnly]);

  // Unset filters become undefined so the API helper leaves them out of the URL.
  const query: ProductQuery = {
    q: q || undefined,
    book: book || undefined,
    categoryId: categoryId ? Number(categoryId) : undefined,
    active: statusToActive(status),
    lowStock: lowOnly ? true : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const products = useProducts(query);

  // The category filter only offers categories of the selected book.
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
    { key: 'book', header: 'Book', render: (p) => <BookBadge book={p.book} /> },
    { key: 'kind', header: 'Kind', render: (p) => (p.kind === 'stock' ? 'Stock item' : 'Service') },
    { key: 'sell', header: 'Selling price', align: 'right', render: (p) => <Money cents={p.sellPriceCents} /> },
    { key: 'min', header: 'Min price', align: 'right', render: (p) => <Money cents={p.minPriceCents} /> },
    {
      key: 'qty',
      header: 'Stock',
      align: 'right',
      // Services hold no stock, so quantity-related columns show a dash for them.
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
    { key: 'status', header: 'Status', render: (p) => <ActiveBadge active={p.active} /> },
    {
      key: 'actions',
      header: 'Actions',
      // stopPropagation on these buttons: the whole row is also clickable (opens edit); avoid a double action.
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
  // True when any filter differs from the default view; decides between "nothing yet" and "nothing matches".
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
          <SearchField label="Search products" placeholder="Search by name or code" value={search} onChange={setSearch} className="lg:col-span-2" />
          {/* Changing the book also clears the category, which may belong to the other book. */}
          <BookFilterSelect value={book} onChange={(b) => { setBook(b); setCategoryId(''); }} />
          <SelectField label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {categoryChoices.map((c) => (
              <option key={c.id} value={String(c.id)}>{c.name} ({BOOK_LABEL[c.book]}){c.active ? '' : ' - inactive'}</option>
            ))}
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <StatusFilterOptions />
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
            <Pager page={page} total={total} limit={PAGE_SIZE} noun="products" onPage={setPage} />
          </>
        )}
      </Card>
      {history && <MovementsDialog product={history} onClose={() => setHistory(null)} />}
      {/* Mounted only while open (with a key per product) so the form always starts with fresh values. */}
      {dialog && <ProductDialog key={dialog.product?.id ?? 'new'} product={dialog.product} onClose={() => setDialog(null)} />}
    </>
  );
}
