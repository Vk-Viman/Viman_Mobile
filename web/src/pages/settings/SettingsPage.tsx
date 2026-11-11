/**
 * Settings screen shell (route "/settings"): page title, tab strip and the active tab below.
 * Tabs (nested routes in App.tsx): General, Commission rates, Printing defaults, Backups, Audit log.
 * No API calls of its own.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/settings', label: 'General', end: true },
  { to: '/settings/rates', label: 'Commission rates' },
  { to: '/settings/printing', label: 'Printing defaults' },
  { to: '/settings/backups', label: 'Backups' },
  { to: '/settings/audit', label: 'Audit log' },
];

/** Renders the header and tabs; the selected tab's component appears at <Outlet/>. */
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Shop details, rates, printing defaults, backups and history" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
