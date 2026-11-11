/**
 * Telecom screen shell (route "/telecom"): title, tab strip and the active tab (nested routes in App.tsx).
 * Tabs: Reloads, EZCash, Top-ups. No API calls of its own. Owned by Phase 6.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/telecom', label: 'Reloads', end: true },
  { to: '/telecom/ezcash', label: 'EZCash' },
  { to: '/telecom/topups', label: 'Top-ups' },
];

/** Renders the header and tabs; the selected tab appears at <Outlet/>. */
export function TelecomPage() {
  return (
    <>
      <PageHeader title="Telecom" subtitle="Reloads, EZCash and top-ups (commission-only revenue)" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
