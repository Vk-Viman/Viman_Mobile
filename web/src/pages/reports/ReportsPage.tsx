/**
 * Reports screen shell (route "/reports"): title, tab strip and the active tab (nested routes in App.tsx).
 * Tabs: Profit & loss, Cash books, Ice Cream, Stock, Activity, Backdated. No API calls of its own. Owned by Phase 11.
 */
import { Outlet, useLocation } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/reports', label: 'Profit & loss', end: true },
  { to: '/reports/cash', label: 'Cash books' },
  { to: '/reports/icecream', label: 'Ice Cream' },
  { to: '/reports/stock', label: 'Stock' },
  { to: '/reports/activity', label: 'Activity' },
  { to: '/reports/backdated', label: 'Backdated' },
];

/** Renders the header and tabs; the period in the URL is kept when switching tabs. */
export function ReportsPage() {
  const { search } = useLocation();
  return (
    <>
      <PageHeader title="Reports" subtitle="Profit and loss, cash, stock and activity by period" />
      <Tabs items={TABS.map((t) => ({ ...t, to: `${t.to}${search}` }))} />
      <Outlet />
    </>
  );
}
