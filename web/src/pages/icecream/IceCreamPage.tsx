/**
 * IceCreamPage (route "/ice-cream"): Ice Cream - title, tab strip and the active tab (nested routes in App.tsx). Owned by Phase 10.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/ice-cream', label: 'Daily entries', end: true },
  { to: '/ice-cream/payments', label: 'Payments' },
  { to: '/ice-cream/moves', label: 'Fund moves' },
  { to: '/ice-cream/funds', label: 'Funds' },
];

/** Renders the header and tabs; the selected tab appears at <Outlet/>. */
export function IceCreamPage() {
  return (
    <>
      <PageHeader title="Ice Cream" subtitle="Daily entries, payments, fund moves and the three funds" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
