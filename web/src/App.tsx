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
import { SuppliersTab } from './pages/products/SuppliersTab';

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        {NAV_ITEMS.filter((n) => !n.built).map((n) => (
          <Route key={n.to} path={n.to.slice(1)} element={<ComingSoon title={n.label} icon={n.icon} phase={n.phase} description={n.description} />} />
        ))}
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
