/**
 * DataTable: the generic table used by every list screen (products, purchases, audit log...).
 * It knows nothing about the data: each screen describes its columns and how to draw each cell.
 */
import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';

/** Description of one table column for rows of type T. */
export interface Column<T> {
  /** Unique id of the column (also used as the React key). */
  key: string;
  /** Heading text. */
  header: string;
  /** Draws the cell content for one row. */
  render: (row: T) => ReactNode;
  /** Right-align numbers/money (also switches on equal-width digits). Default left. */
  align?: 'left' | 'right';
  /** Extra classes for the cells of this column. */
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  /** Stable unique key of a row (usually its database id). */
  rowKey: (row: T) => string | number;
  /** Texts for the empty state shown when `rows` is empty. */
  emptyTitle?: string;
  emptyHint?: string;
  /** Optional extra row rendered below a data row (for expandable details). */
  renderExtra?: (row: T) => ReactNode;
  /** Optional mouse row click (keyboard users need a button inside the row). */
  onRowClick?: (row: T) => void;
}

/** Renders the table, or an EmptyState when there are no rows. Wide tables scroll sideways on small screens. */
export function DataTable<T>({ columns, rows, rowKey, emptyTitle = 'Nothing here yet', emptyHint, renderExtra, onRowClick }: Props<T>) {
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
              <FragmentRow key={rowKey(row)} extra={extra} colSpan={columns.length} onClick={onRowClick ? () => onRowClick(row) : undefined}>
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

/**
 * One data row plus, when `extra` is given, a full-width detail row directly beneath it.
 * A fragment is used so both <tr> elements stay direct children of <tbody> (valid table HTML).
 */
function FragmentRow({ children, extra, colSpan, onClick }: { children: ReactNode; extra: ReactNode; colSpan: number; onClick?: () => void }) {
  return (
    <>
      <tr onClick={onClick} className={"border-b border-slate-100 hover:bg-slate-50/60 " + (onClick ? "cursor-pointer" : "")}>{children}</tr>
      {extra ? (
        <tr className="border-b border-slate-100 bg-slate-50">
          <td colSpan={colSpan} className="px-3 py-3">{extra}</td>
        </tr>
      ) : null}
    </>
  );
}
