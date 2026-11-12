/**
 * DrawingsPage (route "/drawings"): Drawings - title, tab strip and the active tab (nested routes in App.tsx). Owned by Phase 9.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/drawings', label: 'Drawings', end: true },
  { to: '/drawings/capital', label: 'Capital' },
  { to: '/drawings/transfers', label: 'Transfers' },
];

/** Renders the header and tabs; the selected tab appears at <Outlet/>. */
export function DrawingsPage() {
  return (
    <>
      <PageHeader title="Drawings" subtitle="Owner drawings, capital and transfers between books" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
