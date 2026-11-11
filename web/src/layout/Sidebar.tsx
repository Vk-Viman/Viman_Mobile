/**
 * Desktop sidebar navigation (the left column of the app).
 * Rendered by AppLayout. Entries come from navItems.ts. No API calls.
 */
import { NavLink } from 'react-router';
import { Smartphone } from 'lucide-react';
import { NAV_ITEMS } from './navItems';

/**
 * Fixed left sidebar: icons only between md and lg, icons + labels from lg up. Hidden below md (overlay menu used).
 * In the icon-only width the label stays available to screen readers (sr-only) and as a hover tooltip (title).
 */
export function Sidebar() {
  return (
    <aside className="hidden w-16 shrink-0 flex-col border-r border-slate-200 bg-white md:flex lg:w-60">
      <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
        <Smartphone size={22} className="shrink-0 text-brand-600" aria-hidden="true" />
        <span className="hidden text-base font-semibold text-slate-900 lg:inline">Viman Mobile</span>
      </div>
      <nav aria-label="Main menu" className="flex-1 space-y-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            // "end" only for Dashboard: "/" would otherwise count as active on every page.
            end={n.to === '/'}
            title={n.label}
            className={({ isActive }) =>
              `flex min-h-11 items-center justify-center gap-3 rounded-lg px-3 text-sm font-medium lg:justify-start ${
                isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100'
              }`
            }
          >
            <n.icon size={20} className="shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">{n.label}</span>
            <span className="sr-only lg:hidden">{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
