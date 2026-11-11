/**
 * EmptyState: the friendly "nothing here yet" block shown when a list has no rows
 * (either no data exists or the current filter matches nothing).
 */
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

/** @param title main sentence; @param hint optional smaller explanation; @param action optional button, e.g. "Add product". */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <Inbox size={32} className="text-slate-400" aria-hidden="true" />
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="max-w-md text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}
