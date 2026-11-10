import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  emptyTitle?: string;
  emptyHint?: string;
  /** Optional extra row rendered below a data row (for expandable details). */
  renderExtra?: (row: T) => ReactNode;
}

export function DataTable<T>({ columns, rows, rowKey, emptyTitle = 'Nothing here yet', emptyHint, renderExtra }: Props<T>) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const extra = renderExtra?.(row);
            return (
              <FragmentRow key={rowKey(row)} extra={extra} colSpan={columns.length}>
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2.5 align-middle ${c.align === 'right' ? 'num text-right' : 'text-left'} ${c.className ?? ''}`}>
                    {c.render(row)}
                  </td>
                ))}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ children, extra, colSpan }: { children: ReactNode; extra: ReactNode; colSpan: number }) {
  return (
    <>
      <tr className="border-b border-slate-100 hover:bg-slate-50/60">{children}</tr>
      {extra ? (
        <tr className="border-b border-slate-100 bg-slate-50">
          <td colSpan={colSpan} className="px-3 py-3">{extra}</td>
        </tr>
      ) : null}
    </>
  );
}
