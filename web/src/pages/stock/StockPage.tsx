/**
 * Stock screen shell (route "/stock"): page title, tab strip and the active tab below.
 * Tabs (nested routes in App.tsx): Stock on hand (ValuationTab), Stocktake (StocktakeTab; its count sheet is
 * "/stock/stocktake/:id"), Stock losses (StockLossesTab), Personal use (PersonalUseTab). No API calls of its own.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/stock', label: 'Stock on hand', end: true },
  { to: '/stock/stocktake', label: 'Stocktake' },
  { to: '/stock/losses', label: 'Stock losses' },
  { to: '/stock/personal-use', label: 'Personal use' },
];

/** Renders the header and tabs; the selected tab's component appears at <Outlet/>. */
export function StockPage() {
  return (
    <>
      <PageHeader title="Stock" subtitle="Stock on hand, stocktakes, losses and personal use" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
