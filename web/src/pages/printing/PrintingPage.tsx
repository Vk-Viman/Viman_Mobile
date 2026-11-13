/**
 * Services screen shell (route "/services"; "/printing/*" redirects here): title, tab strip and the active tab (nested routes in App.tsx).
 * Tabs: Print & service sales, Service types, Supplies. No API calls of its own. Owned by Phase 7.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/services', label: 'Print & service sales', end: true },
  { to: '/services/types', label: 'Service types' },
  { to: '/services/supplies', label: 'Supplies' },
];

/** Renders the header and tabs; the selected tab appears at <Outlet/>. */
export function PrintingPage() {
  return (
    <>
      <PageHeader title="Services" subtitle="Printing, photocopying and other services: sales, prices and paper/toner supplies" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
