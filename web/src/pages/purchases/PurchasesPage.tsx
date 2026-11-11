/**
 * Purchases screen (route "/purchases"): filterable, paged list of stock purchases with "New purchase" and a
 * details dialog (void / return).
 * API: GET /suppliers (supplier filter), GET /purchases (api/catalog.ts, api/purchases.ts).
 * Totals shown are the server's integer cents. Voided purchases stay in the list (status "Void") for the audit trail.
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
import { PageHeader } from '../../components/PageHeader';
import { Pager } from '../../components/Pager';
import { SearchField } from '../../components/SearchField';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { BookBadge, PostedStatusBadge } from '../../components/StatusBadges';
import { useSuppliers } from '../../api/catalog';
import { usePurchases } from '../../api/purchases';
import { useDebounced } from '../../hooks/useDebounced';
import { PAGE_SIZE } from '../../lib/constants';
import type { Book, Purchase, PurchaseQuery, PurchaseStatus } from '../../types/api';
import { NewPurchaseDialog } from './NewPurchaseDialog';
import { PurchaseDetailDialog } from './PurchaseDetailDialog';

/** The screen: header with "New purchase", filter bar, purchase table, pager and the two dialogs. */
export function PurchasesPage() {
  // ---- Filter and paging state ("" means "no filter") ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PurchaseStatus>('');
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  // Dialog state: `creating` shows the new-purchase form; `openId` shows the details of that purchase.
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  // Debounced bill-number search: the box updates instantly, the server is queried once typing pauses.
  const q = useDebounced(search.trim());
  const suppliers = useSuppliers();
  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [from, to, book, status, supplierId, q]);

  // Unset filters become undefined so the API helper leaves them out of the URL.
  const query: PurchaseQuery = {
    from: from || undefined,
    to: to || undefined,
    book: book || undefined,
    status: status || undefined,
    supplierId: supplierId ? Number(supplierId) : undefined,
    q: q || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const list = usePurchases(query);
  // True when any filter is set; decides between "no purchases yet" and "no purchases match".
  const filtered = Boolean(from || to || book || status || supplierId || q);

  const columns: Column<Purchase>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (p) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {/* A real button inside the row so keyboard users can open details (row click is mouse-only). */}
          <button type="button" className="font-medium text-brand-700 underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(p.id); }}>
            {p.businessDate}
          </button>
          {p.backdated && <Badge tone="amber">Backdated</Badge>}
        </span>
      ),
    },
    { key: 'bill', header: 'Bill no', render: (p) => p.billNo || '—' },
    { key: 'sup', header: 'Supplier', render: (p) => p.supplierName ?? '—' },
    { key: 'book', header: 'Book', render: (p) => <BookBadge book={p.book} /> },
    { key: 'items', header: 'Items', align: 'right', render: (p) => p.items.length },
    { key: 'total', header: 'Total (Rs.)', align: 'right', render: (p) => <Money cents={p.totalCents} /> },
    { key: 'status', header: 'Status', render: (p) => <PostedStatusBadge status={p.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Purchases are paid in cash from the Shop or Telecom cash book. The cash book screens arrive in a later phase."
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New purchase</Button>}
      />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <BookFilterSelect value={book} onChange={setBook} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
          <SelectField label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">All suppliers</option>
            {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}{s.active ? '' : ' (inactive)'}</option>)}
          </SelectField>
          <SearchField label="Bill no" placeholder="Search bill no" value={search} onChange={setSearch} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading purchases" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No purchases yet"
            hint="Record stock you buy from suppliers here."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New purchase</Button>}
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.data.items}
              rowKey={(p) => p.id}
              emptyTitle="No purchases match these filters"
              emptyHint="Try a different date range or clear a filter."
              onRowClick={(p) => setOpenId(p.id)}
            />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="purchases" onPage={setPage} />
          </>
        )}
      </Card>
      {/* Dialogs are mounted only while open so each opening starts fresh (new clientRef, empty form). */}
      {creating && <NewPurchaseDialog onClose={() => setCreating(false)} />}
      {openId !== null && <PurchaseDetailDialog key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
