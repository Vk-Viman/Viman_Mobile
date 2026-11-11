import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/stock', label: 'Stock on hand', end: true },
  { to: '/stock/stocktake', label: 'Stocktake' },
  { to: '/stock/losses', label: 'Stock losses' },
  { to: '/stock/personal-use', label: 'Personal use' },
];

export function StockPage() {
  return (
    <>
      <PageHeader title="Stock" subtitle="Stock on hand, stocktakes, losses and personal use" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
