/**
 * The page frame shared by every screen: sidebar on the left, top bar, and the current page in the main area.
 *
 * Top bar shows the shop name (GET /settings), the server's business date "today" in Asia/Colombo and an
 * Online/Offline dot (GET /health, re-checked every 30 s). The business date comes from the server, not the PC
 * clock, so what the owner sees matches the date the server enforces for future-date rules (R-FD).
 */
import { useState } from 'react';
import { Outlet } from 'react-router';
import { Menu } from 'lucide-react';
import { useHealth } from '../api/health';
import { useSettings } from '../api/settings';
import { MobileMenu } from './MobileMenu';
import { Sidebar } from './Sidebar';

/** Layout route component: renders the frame and, via <Outlet/>, whichever page matches the URL. */
export function AppLayout() {
  // Whether the phone-width overlay menu is open. Irrelevant on desktop, where the Sidebar is always visible.
  const [open, setOpen] = useState(false);
  const health = useHealth();
  const settings = useSettings();
  const reachable = health.isSuccess;

  return (
    <div className="flex h-full">
      <Sidebar />

      {/* Mobile / narrow overlay menu (mounted only while open) */}
      {open && <MobileMenu onClose={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="rounded p-2 text-slate-600 hover:bg-slate-100 md:hidden">
            <Menu size={20} />
          </button>
          <span className="truncate text-base font-semibold text-slate-900">{settings.data?.shop.name ?? 'Viman Mobile'}</span>
          <div className="ml-auto flex items-center gap-4 text-sm text-slate-600">
            <span className="num hidden sm:inline">
              {health.data ? <>Business date: <strong className="font-semibold text-slate-800">{health.data.today}</strong></> : '—'}
            </span>
            {/* Connection indicator: green = reachable, grey = still checking, red = server not answering */}
            <span className="inline-flex items-center gap-2" title={reachable ? 'API reachable' : 'API not reachable'}>
              <span className={`h-2.5 w-2.5 rounded-full ${reachable ? 'bg-emerald-500' : health.isPending ? 'bg-slate-300' : 'bg-red-500'}`} aria-hidden="true" />
              <span className="text-xs">{reachable ? 'Online' : health.isPending ? 'Checking' : 'Offline'}</span>
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
