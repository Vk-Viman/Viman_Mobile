/**
 * The five panels of Reports > Stock: Stock value (inventory valuation), Low stock, Movements, Losses, Profitability.
 * Each panel owns its filters, asks the server for the figures (api/reportsOperational.ts) and shows the report's own
 * table, with an Excel download of the same figures. Nothing is calculated here: BUSINESS_RULES 3 (weighted average),
 * 11 (stock adjustments), R7 (business dates) and C13 (extra cost) are applied by the server.
 */
import { useState } from 'react';
import { Card } from '../../components/Card';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { BookFilterSelect } from '../../components/FilterFields';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import { useCategories, useProducts } from '../../api/catalog';
import { useHealth } from '../../api/health';
import {
  useLossesReport, useLowStockReport, useMovementsReport, useProfitabilityReport, useValuationReport,
} from '../../api/reportsOperational';
import type { MovementType, StockBook } from '../../types/reportsOperational';
import { OpsDownload, OpsFilters, OpsHeadline, OpsResult, OpsTables, groupTable } from './opsParts';
import { ReportTableView, ReportToolbar, useReportPeriod } from './shared';

type Group = 'product' | 'book' | 'category';

/** Stock value as of a date: per product, or grouped by book or category, with the cache/movements check. */
export function ValuationPanel() {
  const today = useHealth().data?.today ?? '';
  const [asOf, setAsOf] = useState('');
  const [book, setBook] = useState<'' | StockBook>('');
  const [categoryId, setCategoryId] = useState('');
  const [includeZero, setIncludeZero] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [group, setGroup] = useState<Group>('product');
  const categories = useCategories({});
  const query = { asOf: asOf || undefined, book, categoryId: categoryId ? Number(categoryId) : '' as const, includeZero, includeInactive };
  const report = useValuationReport(query);
  return (
    <div>
      <OpsFilters>
        <TextField label="Stock as of" type="date" value={asOf} max={today || undefined} onChange={(e) => setAsOf(e.target.value)} hint="Empty = today" />
        <BookFilterSelect value={book} onChange={(v) => setBook(v as '' | StockBook)} />
        <SelectField label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All</option>
          {(categories.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <SelectField label="Group by" value={group} onChange={(e) => setGroup(e.target.value as Group)}>
          <option value="product">Product</option>
          <option value="book">Book</option>
          <option value="category">Category</option>
        </SelectField>
      </OpsFilters>
      <div className="mb-4 flex flex-wrap items-center gap-5 text-sm text-slate-700">
        <label className="inline-flex items-center gap-2"><input type="checkbox" className={CHECKBOX_CLASS} checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} /> Show products with no stock</label>
        <label className="inline-flex items-center gap-2"><input type="checkbox" className={CHECKBOX_CLASS} checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive products</label>
        <OpsDownload path="/reports/inventory/valuation" query={query} />
      </div>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>
              Stock on {r.asOf}: {r.totals.qty.toLocaleString('en-US')} units worth {formatLKR(r.totals.valueCents)} (average cost).{' '}
              {r.reconciliation.matchesCache === true && 'Agrees with the stock records and the movements.'}
              {r.reconciliation.matchesCache === false && 'Does NOT agree with the stock records. Please check stock reconciliation.'}
            </OpsHeadline>
            <Card>
              <ReportTableView
                table={group === 'book'
                  ? groupTable('Stock value by book', 'Book', r.byBook.map((b) => ({ ...b, name: b.book === 'shop' ? 'Shop' : 'Telecom' })), r.totals)
                  : group === 'category'
                    ? groupTable('Stock value by category', 'Category', r.byCategory.map((c) => ({ ...c, name: `${c.categoryName} (${c.book})` })), r.totals)
                    : r.table}
              />
            </Card>
          </>
        )}
      </OpsResult>
    </div>
  );
}

/** Products at or below their minimum stock level. */
export function LowStockPanel() {
  const [book, setBook] = useState<'' | StockBook>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const query = { book, includeInactive };
  const report = useLowStockReport(query);
  return (
    <div>
      <OpsFilters>
        <BookFilterSelect value={book} onChange={(v) => setBook(v as '' | StockBook)} />
        <label className="inline-flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive products
        </label>
        <div className="pb-0.5"><OpsDownload path="/reports/low-stock" query={query} /></div>
      </OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>{r.totals.products} product(s) at or below their minimum, {r.totals.outOfStock} out of stock.</OpsHeadline>
            <Card><ReportTableView table={r.table} /></Card>
          </>
        )}
      </OpsResult>
    </div>
  );
}

const PAGE = 50;
const TYPES: Array<[MovementType, string]> = [
  ['opening', 'Opening stock'], ['purchase', 'Purchase'], ['purchase_return', 'Purchase return'], ['purchase_void', 'Purchase void'], ['sale', 'Sale'],
  ['sale_return', 'Sales return'], ['personal_use', 'Personal use'], ['loss', 'Loss'], ['stocktake_gain', 'Stocktake gain'], ['stocktake_loss', 'Stocktake loss'],
  ['adjustment', 'Value adjustment'],
];

/** The stock ledger with filters (dates, book, type, product) and paging. */
export function MovementsPanel() {
  const { period, set } = useReportPeriod();
  const [book, setBook] = useState<'' | StockBook>('');
  const [type, setType] = useState<'' | MovementType>('');
  const [productId, setProductId] = useState('');
  const [page, setPage] = useState(0);
  const products = useProducts({ limit: 200 });
  const query = {
    from: period.from, to: period.to, book, type, productId: productId ? Number(productId) : '' as const, limit: PAGE, offset: page * PAGE,
  };
  const report = useMovementsReport(query);
  const { limit: _l, offset: _o, ...exportQuery } = query;
  void _l; void _o;
  return (
    <div>
      <ReportToolbar period={period} set={(p) => { setPage(0); set(p); }} showGranularity={false} />
      <OpsFilters>
        <BookFilterSelect value={book} onChange={(v) => { setPage(0); setBook(v as '' | StockBook); }} />
        <SelectField label="Type" value={type} onChange={(e) => { setPage(0); setType(e.target.value as '' | MovementType); }}>
          <option value="">All types</option>
          {TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </SelectField>
        <SelectField label="Product" value={productId} onChange={(e) => { setPage(0); setProductId(e.target.value); }}>
          <option value="">All products</option>
          {(products.data?.items ?? []).filter((p) => p.kind === 'stock').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <div className="pb-0.5"><OpsDownload path="/reports/stock-movements" query={exportQuery} /></div>
      </OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>
              {r.total} movement(s): net {r.totals.qtyDelta.toLocaleString('en-US')} units, {formatLKR(r.totals.valueDeltaCents)}.
            </OpsHeadline>
            <Card><ReportTableView table={r.table} /></Card>
            <Pager page={page} total={r.total} limit={PAGE} noun="movements" onPage={setPage} />
          </>
        )}
      </OpsResult>
    </div>
  );
}

/** Stock losses by period, reason, product and book, with the stock-adjustments memo. */
export function LossesPanel() {
  const { period, set } = useReportPeriod();
  const [book, setBook] = useState<'' | StockBook>('');
  const query = { from: period.from, to: period.to, granularity: period.granularity, book };
  const report = useLossesReport(query, period.ready);
  return (
    <div>
      <ReportToolbar period={period} set={set} />
      <OpsFilters>
        <BookFilterSelect value={book} onChange={(v) => setBook(v as '' | StockBook)} />
        <div className="pb-0.5"><OpsDownload path="/reports/stock-losses" query={query} /></div>
      </OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>{r.totals.lossCount} loss(es), {r.totals.qty} units, {formatLKR(r.totals.costCents)} at cost. Stock adjustments (net): {formatLKR(r.totals.stockAdjustmentsNetCents)}.</OpsHeadline>
            <OpsTables report={r} />
          </>
        )}
      </OpsResult>
    </div>
  );
}

/** Profit per product over the period, after returns. */
export function ProfitPanel() {
  const { period, set } = useReportPeriod();
  const [book, setBook] = useState<'' | StockBook>('');
  const query = { from: period.from, to: period.to, book };
  const report = useProfitabilityReport(query, period.ready);
  return (
    <div>
      <ReportToolbar period={period} set={set} showGranularity={false} />
      <OpsFilters>
        <BookFilterSelect value={book} onChange={(v) => setBook(v as '' | StockBook)} />
        <div className="pb-0.5"><OpsDownload path="/reports/product-profitability" query={query} /></div>
      </OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>Revenue {formatLKR(r.totals.revenueCents)}, cost {formatLKR(r.totals.costCents)}, gross profit {formatLKR(r.totals.grossProfitCents)}.</OpsHeadline>
            <OpsTables report={r} />
          </>
        )}
      </OpsResult>
    </div>
  );
}
