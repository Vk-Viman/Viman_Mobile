import { NavLink } from 'react-router';

export interface TabItem { to: string; label: string; end?: boolean }

/** Route-based tabs (nested routes). */
export function Tabs({ items }: { items: TabItem[] }) {
  return (
    <nav aria-label="Sections" className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200">
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${
              isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900'
            }`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
