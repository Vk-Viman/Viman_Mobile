import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

const TABS = [
  { to: '/products', label: 'Products', end: true },
  { to: '/products/categories', label: 'Categories' },
  { to: '/products/suppliers', label: 'Suppliers' },
];

export function ProductsPage() {
  return (
    <>
      <PageHeader title="Products" subtitle="Product catalogue, categories and suppliers" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
