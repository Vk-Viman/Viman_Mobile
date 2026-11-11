/**
 * Stock > Stock on hand tab (route "/stock", the default tab): the stock valuation report: quantity and value
 * (at average cost) per product, with totals for the Shop book, the Telecom book and overall.
 * API: GET /categories, GET /inventory/valuation (api/stock.ts) and GET /inventory/reconciliation (on demand,
 * api/purchases.ts). Every quantity, value and total is calculated by the server in integer cents and only
 * formatted here; the two books are always reported separately.
 * The "as of" date is a REPORT date, so it may be any date (R-FD applies to transactions only); the picker's max
 * of today is just a convenience, because a later date would show the same figures as today.
 */
import { useState } from 'react';
import { CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { BookFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { BookBadge } from '../../components/StatusBadges';
import { TextField } from '../../components/TextField';
import { useCategories } from '../../api/catalog';
import { useHealth } from '../../api/health';
import { useInventoryReconciliation } from '../../api/purchases';
import { useValuation } from '../../api/stock';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { Book, ValuationItem } from '../../types/api';

/**
 * "Check stock reconciliation" button and result. The server compares each product's stored quantity/value with
 * the sum of its stock movements. The check runs only when the owner asks (the query starts disabled), because it
 * scans every product.
 */
function Reconciliation() {
  // First click enables the query (which then fetches); later clicks re-run it with refetch().
  const [enabled, setEnabled] = useState(false);
  const rec = useInventoryReconciliation(enabled);
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Button variant="secondary" onClick={() => (enabled ? void rec.refetch() : setEnabled(true))} loading={enabled && rec.isFetching}>
        <ShieldCheck size={16} aria-hidden="true" /> Check stock reconciliation
      </Button>
      {/* aria-live: the result is announced to screen readers when it appears */}
      <div aria-live="polite" className="text-sm">
        {enabled && rec.isError && <span className="text-red-700">{rec.error.message}</span>}
        {enabled && rec.data && rec.data.ok && (
          <span className="inline-flex items-center gap-1.5 text-brand-700">
            <CheckCircle2 size={16} aria-hidden="true" /> OK — {rec.data.checkedProducts} products checked, stock records agree with the movements.
          </span>
        )}
        {enabled && rec.data && !rec.data.ok && (
          <div className="text-red-700">
            <p className="inline-flex items-center gap-1.5 font-medium"><AlertTriangle size={16} aria-hidden="true" /> {rec.data.mismatches.length} mismatch(es) found</p>
            <ul className="mt-1 list-disc pl-5">
              {rec.data.mismatches.map((m) => (
                <li key={m.productId}>
                  {m.name}: stock record {m.cacheQty} / {formatLKR(m.cacheValueCents)}, movements {m.movementQty} / {formatLKR(m.movementValueCents)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The tab: filters, reconciliation check, three total cards and the per-product valuation table. */
export function ValuationTab() {
  const health = useHealth();
  const today = health.data?.today;
  // ---- Filter state ("" means "no filter") ----
  const [book, setBook] = useState<'' | Book>('');
  const [categoryId, setCategoryId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [includeZero, setIncludeZero] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);

  const categories = useCategories({ active: true });
  // The category filter only offers categories of the selected book.
  const cats = (categories.data?.items ?? []).filter((c) => !book || c.book === book);
  const val = useValuation({
    book: book || undefined,
    categoryId: categoryId ? Number(categoryId) : undefined,
    asOf: asOf || undefined,
    includeZero,
    includeInactive,
  });

  const columns: Column<ValuationItem>[] = [
    { key: 'code', header: 'Code', render: (i) => i.code ?? '—' },
    { key: 'name', header: 'Name', render: (i) => <span className="font-medium text-slate-900">{i.name}</span> },
    { key: 'cat', header: 'Category', render: (i) => i.categoryName },
    { key: 'book', header: 'Book', render: (i) => <BookBadge book={i.book} /> },
    { key: 'qty', header: 'Qty', align: 'right', render: (i) => i.qty },
    { key: 'val', header: 'Value (Rs.)', align: 'right', render: (i) => <Money cents={i.valueCents} /> },
    { key: 'avg', header: 'Avg cost', align: 'right', render: (i) => (i.avgUnitCostCents === null ? '—' : <Money cents={i.avgUnitCostCents} />) },
    { key: 'act', header: 'Active', render: (i) => (i.active ? 'Yes' : <Badge tone="amber">Inactive</Badge>) },
  ];

  const t = val.data?.totals;

  return (
    <div className="space-y-5">
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Changing the book also clears the category, which may belong to the other book. */}
          <BookFilterSelect value={book} onChange={(b) => { setBook(b); setCategoryId(''); }} />
          <SelectField label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </SelectField>
          <TextField label="As of date (optional)" type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} hint="Leave empty for stock right now." />
          <fieldset className="flex flex-col justify-center gap-2">
            <legend className="sr-only">Options</legend>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className={CHECKBOX_CLASS} checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} /> Show zero stock
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className={CHECKBOX_CLASS} checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive
            </label>
          </fieldset>
        </div>
        <Reconciliation />
      </Card>

      {val.isPending ? (
        <div className="flex justify-center py-12"><Spinner label="Loading stock" /></div>
      ) : val.isError ? (
        <ErrorState error={val.error} onRetry={() => void val.refetch()} />
      ) : (
        <>
          {/* Totals per book and overall, exactly as summed by the server */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card title="Shop stock">
              <p className="num text-xl font-semibold text-slate-900">{val.data.totals.byBook.shop.qty} units</p>
              <p className="num text-sm text-slate-600">{formatLKR(val.data.totals.byBook.shop.valueCents)}</p>
            </Card>
            <Card title="Telecom stock">
              <p className="num text-xl font-semibold text-slate-900">{val.data.totals.byBook.telecom.qty} units</p>
              <p className="num text-sm text-slate-600">{formatLKR(val.data.totals.byBook.telecom.valueCents)}</p>
            </Card>
            <Card title="Total">
              <p className="num text-xl font-semibold text-slate-900">{val.data.totals.qty} units</p>
              <p className="num text-sm text-slate-600">{formatLKR(val.data.totals.valueCents)}</p>
            </Card>
          </div>
          <p className="text-sm text-slate-500">
            Shop and Telecom stock are kept separate.
            {val.data.asOf ? ` Showing stock as of ${val.data.asOf}.` : ''}
          </p>
          <Card>
            <DataTable
              columns={columns}
              rows={val.data.items}
              rowKey={(i) => i.productId}
              emptyTitle="No stock to show"
              emptyHint="Try 'Show zero stock' or clear a filter."
            />
            {t && val.data.items.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-end gap-x-8 gap-y-1 border-t border-slate-200 px-3 pt-3 text-sm font-semibold text-slate-900">
                <span>Totals</span>
                <span className="num">Qty {t.qty}</span>
                <span className="num">Value {formatLKR(t.valueCents)}</span>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
