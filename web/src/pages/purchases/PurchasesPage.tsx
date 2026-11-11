import { useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { useSuppliers } from '../../api/catalog';
import { usePurchases } from '../../api/purchases';
import type { Book, Purchase, PurchaseQuery, PurchaseStatus } from '../../types/api';
import { BOOK_LABEL, useDebounced } from '../products/shared';
import { NewPurchaseDialog } from './NewPurchaseDialog';
import { PurchaseDetailDialog } from './PurchaseDetailDialog';

const LIMIT = 50;

export function PurchasesPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PurchaseStatus>('');
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const q = useDebounced(search.trim(), 300);
  const suppliers = useSuppliers();
  useEffect(() => { setPage(0); }, [from, to, book, status, supplierId, q]);

  const query: PurchaseQuery = {
    from: from || undefined,
    to: to || undefined,
    book: book || undefined,
    status: status || undefined,
    supplierId: supplierId ? Number(supplierId) : undefined,
    q: q || undefined,
    limit: LIMIT,
    offset: page * LIMIT,
  };
  const list = usePurchases(query);
  const filtered = Boolean(from || to || book || status || supplierId || q);

  const columns: Column<Purchase>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (p) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <button type="button" className="font-medium text-brand-700 underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(p.id); }}>
            {p.businessDate}
          </button>
          {p.backdated && <Badge tone="amber">Backdated</Badge>}
        </span>
      ),
    },
    { key: 'bill', header: 'Bill no', render: (p) => p.billNo || '—' },
    { key: 'sup', header: 'Supplier', render: (p) => p.supplierName ?? '—' },
    { key: 'book', header: 'Book', render: (p) => <Badge tone={p.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[p.book]}</Badge> },
    { key: 'items', header: 'Items', align: 'right', render: (p) => p.items.length },
    { key: 'total', header: 'Total (Rs.)', align: 'right', render: (p) => <Money cents={p.totalCents} /> },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={p.status === 'void' ? 'red' : 'brand'}>{p.status === 'void' ? 'Void' : 'Posted'}</Badge> },
  ];

  const total = list.data?.total ?? 0;
  const first = total === 0 ? 0 : page * LIMIT + 1;
  const last = Math.min(total, (page + 1) * LIMIT);

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Purchases are paid in cash from the Shop or Telecom cash book. The cash book screens arrive in a later phase."
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New purchase</Button>}
      />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <TextField label="From date" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To date" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          <SelectField label="Book" value={book} onChange={(e) => setBook(e.target.value as '' | Book)}>
            <option value="">All</option>
            <option value="shop">Shop</option>
            <option value="telecom">Telecom</option>
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | PurchaseStatus)}>
            <option value="">All</option>
            <option value="posted">Posted</option>
            <option value="void">Void</option>
          </SelectField>
          <SelectField label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">All suppliers</option>
            {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}{s.active ? '' : ' (inactive)'}</option>)}
          </SelectField>
          <div className="relative">
            <TextField label="Bill no" placeholder="Search bill no" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" className="[&_input]:pl-9" />
            <Search size={16} className="pointer-events-none absolute bottom-3 left-3 text-slate-400" aria-hidden="true" />
          </div>
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
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
              <span>{total === 0 ? '0 purchases' : `Showing ${first}–${last} of ${total} purchases`}</span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
                <Button variant="secondary" disabled={last >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>
      {creating && <NewPurchaseDialog onClose={() => setCreating(false)} />}
      {openId !== null && <PurchaseDetailDialog key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
