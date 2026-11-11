/**
 * History tab (route "/sales/history"): filterable, paged list of past sales; a row opens the sale details dialog
 * (lines, returns, Return items, Void sale).
 * API: GET /sales (api/sales.ts); product filter via GET /products (ProductFilter).
 * C13: the cost column and totals show the CHARGED cost (automatic + extra); the extra is listed separately when > 0.
 * Figures (total, cost of goods sold, profit, the totals line) are the server's integer cents; nothing is
 * recalculated here. The totals line covers ALL matching posted sales, not just the visible page.
 * Voided sales stay in the list (status "Void") for the audit trail.
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { BookFilterSelect, DateRangeFields, PostedStatusFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { Spinner } from '../../components/Spinner';
import { BookBadge, PostedStatusBadge } from '../../components/StatusBadges';
import { useSales } from '../../api/sales';
import { PAGE_SIZE } from '../../lib/constants';
import type { Book, PostedStatus, Sale, SaleQuery } from '../../types/api';
import { ProductFilter } from './ProductFilter';
import { SaleDetailDialog } from './SaleDetailDialog';

/** The History screen: filter bar, totals line, sales table, pager and the details dialog. */
export function HistoryTab() {
  // ---- Filter and paging state ("" means "no filter") ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [productId, setProductId] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [from, to, book, status, productId]);

  const query: SaleQuery = {
    from: from || undefined,
    to: to || undefined,
    book: book || undefined,
    status: status || undefined,
    productId: productId ? Number(productId) : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const list = useSales(query);
  const filtered = Boolean(from || to || book || status || productId);

  const columns: Column<Sale>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (s) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {/* A real button inside the row so keyboard users can open details (row click is mouse-only). */}
          <button type="button" className="font-medium text-brand-700 underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(s.id); }}>
            {s.businessDate}
          </button>
          {s.backdated && <Badge tone="amber">Backdated</Badge>}
        </span>
      ),
    },
    { key: 'no', header: 'Sale #', render: (s) => `#${s.id}` },
    { key: 'book', header: 'Book', render: (s) => <BookBadge book={s.book} /> },
    { key: 'items', header: 'Items', align: 'right', render: (s) => s.items.length },
    { key: 'total', header: 'Total (Rs.)', align: 'right', render: (s) => <Money cents={s.totalCents} /> },
    { key: 'cost', header: 'Cost (Rs.)', align: 'right', render: (s) => <Money cents={s.chargedCostCents} /> },
    { key: 'profit', header: 'Profit', align: 'right', render: (s) => <Money cents={s.grossProfitCents} /> },
    { key: 'status', header: 'Status', render: (s) => <PostedStatusBadge status={s.status} /> },
    {
      key: 'returns',
      header: 'Returns',
      render: (s) => (s.returns.length > 0 ? <Badge tone="amber">{s.returns.length} return{s.returns.length === 1 ? '' : 's'}</Badge> : '—'),
    },
  ];

  return (
    <>
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <BookFilterSelect value={book} onChange={setBook} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
          <ProductFilter value={productId} onChange={setProductId} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading sales" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No sales yet" hint="Sales you record on the POS tab appear here." />
        ) : (
          <>
            {/* Totals over every matching POSTED sale (server-calculated), not only this page. */}
            <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-1 rounded-lg bg-slate-50 px-4 py-3 text-sm">
              <div className="flex gap-2"><dt className="text-slate-500">Revenue</dt><dd><Money cents={list.data.totals.revenueCents} className="font-semibold" /></dd></div>
              <div className="flex gap-2"><dt className="text-slate-500">Cost</dt><dd><Money cents={list.data.totals.costCents} className="font-semibold" /></dd></div>
              {list.data.totals.extraCostCents > 0 && (
                <div className="flex gap-2"><dt className="text-slate-500">of which extra cost</dt><dd><Money cents={list.data.totals.extraCostCents} className="font-semibold" /></dd></div>
              )}
              <div className="flex gap-2"><dt className="text-slate-500">Refunds</dt><dd><Money cents={list.data.totals.refundsCents} className="font-semibold" /></dd></div>
              <p className="w-full text-xs text-slate-500">Totals cover all matching posted sales (voided sales are left out).</p>
            </dl>
            <DataTable
              columns={columns}
              rows={list.data.items}
              rowKey={(s) => s.id}
              emptyTitle="No sales match these filters"
              emptyHint="Try a different date range or clear a filter."
              onRowClick={(s) => setOpenId(s.id)}
            />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="sales" onPage={setPage} />
          </>
        )}
      </Card>
      {/* Mounted only while open so each opening starts fresh. */}
      {openId !== null && <SaleDetailDialog key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
