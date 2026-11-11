/**
 * Slide-in navigation menu for narrow (phone-width) screens, where the desktop Sidebar is hidden.
 * Rendered by AppLayout only while open. Entries come from navItems.ts. No API calls.
 */
import { NavLink } from 'react-router';
import { X } from 'lucide-react';
import { NAV_ITEMS } from './navItems';

interface MobileMenuProps {
  /** Called when the menu should close: backdrop click, close button, or after choosing a link. */
  onClose: () => void;
}

/** Overlay menu: dark backdrop (click to close) plus a white panel with the same links as the Sidebar. */
export function MobileMenu({ onClose }: MobileMenuProps) {
  return (
    <div className="fixed inset-0 z-40 flex md:hidden">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <nav aria-label="Main menu" className="relative w-64 overflow-y-auto bg-white p-3 shadow-xl">
        <button type="button" onClick={onClose} aria-label="Close menu" className="mb-2 rounded p-2 text-slate-600 hover:bg-slate-100">
          <X size={20} />
        </button>
        {NAV_ITEMS.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            onClick={onClose}
            className={({ isActive }) =>
              `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`
            }
          >
            <n.icon size={20} aria-hidden="true" /> {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
