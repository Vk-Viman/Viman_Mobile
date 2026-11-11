/**
 * Sales screen shell (route "/sales"): page title, tab strip and the active tab below.
 * Tabs (nested routes in App.tsx): POS (PosTab, the index route) and History (HistoryTab, "/sales/history").
 * No API calls of its own.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/sales', label: 'POS', end: true },
  { to: '/sales/history', label: 'History' },
];

/** Renders the header and tabs; the selected tab's component appears at <Outlet/>. */
export function SalesPage() {
  return (
    <>
      <PageHeader title="Sales" subtitle="Record cash sales, review past sales, take returns and void mistakes" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
