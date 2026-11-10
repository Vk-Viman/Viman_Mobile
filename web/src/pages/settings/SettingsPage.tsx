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

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Shop details, rates, printing defaults, backups and history" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
