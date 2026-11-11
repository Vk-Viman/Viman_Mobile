/**
 * Products screen shell (route "/products"): page title, tab strip, and the active tab below.
 * Tabs are nested routes defined in App.tsx: Products (ProductsTab), Categories (CategoriesTab),
 * Suppliers (SuppliersTab). No API calls of its own.
 */
import { Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';

/** `end: true` on the first tab so "/products" is not highlighted while on "/products/categories". */
const TABS = [
  { to: '/products', label: 'Products', end: true },
  { to: '/products/categories', label: 'Categories' },
  { to: '/products/suppliers', label: 'Suppliers' },
];

/** Renders the header and tabs; the selected tab's component appears at <Outlet/>. */
export function ProductsPage() {
  return (
    <>
      <PageHeader title="Products" subtitle="Product catalogue, categories and suppliers" />
      <Tabs items={TABS} />
      <Outlet />
    </>
  );
}
