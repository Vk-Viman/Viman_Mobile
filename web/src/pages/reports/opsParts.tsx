/**
 * Small building blocks shared by the operational report tabs (Stock, Activity, Backdated): the section picker kept in
 * the URL, the Excel download link, a loading/error/warnings wrapper and the table renderer for a report's `table` and
 * breakdown tables. No API calls of its own and no money maths (the server calculated every figure).
 */
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { Card } from '../../components/Card';
import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { opsDownloadUrl } from '../../api/reportsOperational';
import type { OpsReportBase } from '../../types/reportsOperational';
import { ReportTableView } from './shared';
import type { ReportTable } from './shared';

/** Reads/writes which sub-section is open (`?section=`), falling back to the first one for an unknown value. */
export function useOpsSection<K extends string>(keys: readonly K[]): [K, (k: K) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('section');
  const value = (keys as readonly string[]).includes(raw ?? '') ? (raw as K) : keys[0]!;
  const set = (k: K) => {
    const next = new URLSearchParams(params);
    next.set('section', k);
    setParams(next, { replace: true });
  };
  return [value, set];
}

/** The row of buttons that switches between the sub-sections of a tab. */
export function SectionPills<K extends string>({ items, value, onChange }: { items: Array<{ key: K; label: string }>; value: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" aria-label="Report sections" className="mb-4 flex flex-wrap gap-2">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={it.key === value}
          onClick={() => onChange(it.key)}
          className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
            it.key === value ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** "Download Excel" link for a report path and its current filters. */
export function OpsDownload({ path, query }: { path: string; query: object }) {
  return (
    <a
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      href={opsDownloadUrl(path, query)}
      download
    >
      <Download size={16} aria-hidden="true" /> Download Excel
    </a>
  );
}

/** The report's warnings as a plain amber notice (nothing when there are none). */
export function OpsWarnings({ warnings }: { warnings: OpsReportBase['warnings'] }) {
  if (warnings.length === 0) return null;
  return (
    <ul role="status" className="mb-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      {warnings.map((w) => <li key={w.code}>{w.message}</li>)}
    </ul>
  );
}

/** Shows a spinner while loading, an error with retry on failure, otherwise `children(data)` under the warnings. */
export function OpsResult<T extends OpsReportBase>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <div className="py-10 text-center"><Spinner label="Loading report" /></div>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <div className={query.isFetching ? 'opacity-70' : undefined}>
      <OpsWarnings warnings={query.data.warnings} />
      {children(query.data)}
    </div>
  );
}

/** The main table of a report, followed by its breakdown tables, each in its own titled card. */
export function OpsTables({ report, mainTitle }: { report: OpsReportBase; mainTitle?: string }) {
  return (
    <div className="space-y-5">
      <Card title={mainTitle ?? report.table.title}><ReportTableView table={report.table} /></Card>
      {(report.extraTables ?? []).map((t) => <Card key={t.title} title={t.title}><ReportTableView table={t} /></Card>)}
    </div>
  );
}

/** A small headline line such as "Stock value Rs 1,200.00 - 105 units" shown above a table. */
export function OpsHeadline({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-sm font-medium text-slate-700">{children}</p>;
}

/** Builds a simple table (used for the valuation grouped by book or by category, from figures the server already totalled). */
export function groupTable(title: string, nameLabel: string, rows: Array<{ name: string; products: number; qty: number; valueCents: number }>, total: { products: number; qty: number; valueCents: number }): ReportTable {
  return {
    title,
    columns: [
      { key: 'name', label: nameLabel, kind: 'text' }, { key: 'products', label: 'Products', kind: 'int' },
      { key: 'qty', label: 'Quantity', kind: 'int' }, { key: 'value', label: 'Stock value', kind: 'money' },
    ],
    rows: rows.map((r) => ({ name: r.name, products: r.products, qty: r.qty, value: r.valueCents })),
    totals: { name: 'Total', products: total.products, qty: total.qty, value: total.valueCents },
  };
}

/** Shared look of the filter row above a report. */
export function OpsFilters({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}
