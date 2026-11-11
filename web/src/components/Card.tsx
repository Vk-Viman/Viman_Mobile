/**
 * Card: a white rounded panel with an optional title bar, used to group related content on a page.
 */
import type { ReactNode } from 'react';

/**
 * @param title     Optional heading shown in the card's top bar.
 * @param actions   Optional controls (buttons) shown on the right of the top bar.
 * @param className Extra classes for the outer panel (spacing/width tweaks).
 * The top bar is drawn only when a title or actions are given.
 */
export function Card({ title, actions, children, className = '' }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}
