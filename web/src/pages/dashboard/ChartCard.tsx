/**
 * ChartCard: a card that holds one chart and offers the same data as a plain table.
 *
 * Accessibility (the reason this wrapper exists): a chart is a picture, so every chart on the dashboard is paired with a real
 * `<table>` of the same numbers. The "Show as table" button swaps between them (aria-pressed tells a screen reader which is on),
 * the chart area has a text summary (`summary`, role="img" + aria-label), and an empty data set shows a plain sentence instead
 * of an empty axis. Nothing here calculates a figure.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { formatLKR } from '../../lib/format';

/** One column of the table alternative; `money` columns are shown as rupees and negatives in red. */
export interface TableColumn { key: string; label: string; money?: boolean }

/**
 * @param title    card heading
 * @param summary  one-sentence text description of what the chart shows (read by screen readers)
 * @param columns  columns of the table alternative
 * @param rows     rows of the table alternative (values are server figures; cents for `money` columns)
 * @param isEmpty  true when there is nothing to draw; a friendly sentence is shown instead (`emptyText`)
 * @param legend   optional legend shown under the chart
 * @param children the chart itself
 */
export function ChartCard({ title, summary, columns, rows, isEmpty, emptyText, legend, children }: {
  title: string; summary: string; columns: TableColumn[]; rows: Array<Record<string, string | number>>;
  isEmpty: boolean; emptyText: string; legend?: ReactNode; children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const toggle = (
    <button type="button" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
      {asTable ? <BarChart3 size={16} aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />}
      {asTable ? 'Show as chart' : 'Show as table'}
    </button>
  );
  return (
    <Card title={title} actions={isEmpty ? undefined : toggle}>
      {isEmpty ? (
        <EmptyState title={emptyText} hint="It will appear here once there is something to show." />
      ) : asTable ? (
        <div className="max-h-80 overflow-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200 text-slate-500">
                {columns.map((c, i) => <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-slate-100">
                  {columns.map((c, i) => {
                    const v = r[c.key];
                    const neg = c.money && typeof v === 'number' && v < 0;
                    return (
                      <td key={c.key} className={`px-3 py-1.5 ${i === 0 ? 'text-left' : 'text-right num whitespace-nowrap'} ${neg ? 'text-red-700' : ''}`}>
                        {c.money && typeof v === 'number' ? formatLKR(v) : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div role="img" aria-label={summary} className="h-64 w-full">{children}</div>
          {legend && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">{legend}</div>}
        </>
      )}
    </Card>
  );
}

/** One legend entry: a colour swatch and a name (a swatch is never the only cue: the name is always written). */
export function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
