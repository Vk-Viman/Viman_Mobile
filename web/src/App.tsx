/**
 * Route table of the whole application: which screen appears at which address (URL).
 *
 * Everything sits inside <AppLayout/> (sidebar + page area); the matching page renders where AppLayout shows its
 * <Outlet/>. Screens with tabs (Sales, Products, Stock, Settings) are "parent" routes: the parent page draws the tab
 * strip and the active tab renders as its child route.
 *
 * Sidebar entries that are not built yet (`built: false` in layout/navItems.ts) get a "Coming soon" placeholder
 * automatically, so the menu and the routes can never disagree. Unknown addresses redirect to the Dashboard.
 */
import { Navigate, Route, Routes } from 'react-router';
import { AppLayout } from './layout/AppLayout';
import { NAV_ITEMS } from './layout/navItems';
import { ComingSoon } from './pages/ComingSoon';
import { Dashboard } from './pages/Dashboard';
import { SettingsPage } from './pages/settings/SettingsPage';
import { GeneralTab } from './pages/settings/GeneralTab';
import { RatesTab } from './pages/settings/RatesTab';
import { PrintingTab } from './pages/settings/PrintingTab';
import { BackupsTab } from './pages/settings/BackupsTab';
import { AuditTab } from './pages/settings/AuditTab';
import { ProductsPage } from './pages/products/ProductsPage';
import { ProductsTab } from './pages/products/ProductsTab';
import { CategoriesTab } from './pages/products/CategoriesTab';
import { PurchasesPage } from './pages/purchases/PurchasesPage';
import { StockPage } from './pages/stock/StockPage';
import { ValuationTab } from './pages/stock/ValuationTab';
import { StocktakeTab } from './pages/stock/StocktakeTab';
import { StocktakeSheet } from './pages/stock/StocktakeSheet';
import { StockLossesTab } from './pages/stock/StockLossesTab';
import { PersonalUseTab } from './pages/stock/PersonalUseTab';
import { SalesPage } from './pages/sales/SalesPage';
import { PosTab } from './pages/sales/PosTab';
import { HistoryTab } from './pages/sales/HistoryTab';
import { SuppliersTab } from './pages/products/SuppliersTab';

/** Root component: declares every route. Renders no markup of its own. */
export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        {/* Placeholder pages for menu items whose screens are planned but not built yet */}
        {NAV_ITEMS.filter((n) => !n.built).map((n) => (
          <Route key={n.to} path={n.to.slice(1)} element={<ComingSoon title={n.label} icon={n.icon} phase={n.phase} description={n.description} />} />
        ))}
        <Route path="sales" element={<SalesPage />}>
          <Route index element={<PosTab />} />
          <Route path="history" element={<HistoryTab />} />
        </Route>
        <Route path="products" element={<ProductsPage />}>
          <Route index element={<ProductsTab />} />
          <Route path="categories" element={<CategoriesTab />} />
          <Route path="suppliers" element={<SuppliersTab />} />
        </Route>
        <Route path="purchases" element={<PurchasesPage />} />
        <Route path="stock" element={<StockPage />}>
          <Route index element={<ValuationTab />} />
          <Route path="stocktake" element={<StocktakeTab />} />
          <Route path="stocktake/:id" element={<StocktakeSheet />} />
          <Route path="losses" element={<StockLossesTab />} />
          <Route path="personal-use" element={<PersonalUseTab />} />
        </Route>
        <Route path="settings" element={<SettingsPage />}>
          <Route index element={<GeneralTab />} />
          <Route path="rates" element={<RatesTab />} />
          <Route path="printing" element={<PrintingTab />} />
          <Route path="backups" element={<BackupsTab />} />
          <Route path="audit" element={<AuditTab />} />
        </Route>
        {/* Anything unknown goes home (replace: the bad address is not kept in the back-button history) */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
