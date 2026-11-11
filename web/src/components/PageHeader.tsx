/**
 * PageHeader: the big title at the top of each screen, with an optional one-line subtitle and action buttons.
 */
import type { ReactNode } from 'react';

/** @param title page name (the page's h1); @param subtitle optional description; @param actions optional right-side buttons. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
