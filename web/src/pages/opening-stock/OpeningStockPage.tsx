/**
 * Opening Stock screen shell (route "/opening-stock"): title, tab strip and the active tab.
 * Tabs: Manual entry, Excel import. No API calls of its own. Owned by Phase 13.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/opening-stock', label: 'Manual entry', end: true },
  { to: '/opening-stock/import', label: 'Excel import' },
];

/** Renders the header and tabs; the selected tab appears at <Outlet/>. */
export function OpeningStockPage() {
  return (
    <>
      <PageHeader title="Opening Stock" subtitle="Starting stock for go-live, by hand or from an Excel template" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
