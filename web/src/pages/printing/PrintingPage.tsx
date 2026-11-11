/**
 * Printing screen shell (route "/printing"): title, tab strip and the active tab (nested routes in App.tsx).
 * Tabs: Print sales, Service types, Supplies. No API calls of its own. Owned by Phase 7.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/printing', label: 'Print sales', end: true },
  { to: '/printing/types', label: 'Service types' },
  { to: '/printing/supplies', label: 'Supplies' },
];

/** Renders the header and tabs; the selected tab appears at <Outlet/>. */
export function PrintingPage() {
  return (
    <>
      <PageHeader title="Printing" subtitle="Print and photocopy sales, prices and paper/toner supplies" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
