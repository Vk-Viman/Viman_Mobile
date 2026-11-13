/**
 * The list of sidebar / menu entries, defined once and used by three consumers:
 *  - layout/Sidebar.tsx (desktop sidebar) and layout/MobileMenu.tsx (phone-width overlay) draw the links;
 *  - App.tsx builds "Coming soon" routes for entries that are not built yet.
 * Keeping one list means the menu and the routes cannot drift apart.
 */
import {
  LayoutDashboard, ShoppingCart, Package, Truck, Boxes, ClipboardList, Smartphone, Receipt,
  Wallet, HandCoins, IceCreamCone, BarChart3, Settings, Printer,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** One menu entry. */
export interface NavItem {
  /** URL path, e.g. "/products". */
  to: string;
  /** Text shown in the menu and as the placeholder page title. */
  label: string;
  icon: LucideIcon;
  /** Implementation phase in which the screen is (or will be) delivered; shown on the "Coming soon" page. */
  phase: number;
  /** One-line explanation of the screen, shown on the "Coming soon" page. */
  description: string;
  /** True once the real screen exists; false/absent entries get a placeholder route. */
  built?: boolean;
}

/** Menu order, top to bottom. To add a screen: add it here, then (when built) set `built: true` and add its route. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, phase: 12, description: 'Today at a glance: sales, profit, cash in each book and stock alerts.', built: true },
  { to: '/sales', label: 'Sales', icon: ShoppingCart, phase: 5, description: 'Record cash sales of stock products, with returns and voids.', built: true },
  { to: '/products', label: 'Products', icon: Package, phase: 2, description: 'Manage the product catalogue, prices, categories and suppliers.', built: true },
  { to: '/purchases', label: 'Purchases', icon: Truck, phase: 3, description: 'Record stock bought from suppliers and what you paid.', built: true },
  { to: '/stock', label: 'Stock', icon: Boxes, phase: 4, description: 'See stock on hand, and record stocktakes, stock losses and personal use.', built: true },
  { to: '/opening-stock', label: 'Opening Stock', icon: ClipboardList, phase: 13, description: 'Enter starting stock by hand or from an Excel template at go-live.', built: true },
  { to: '/services', label: 'Services', icon: Printer, phase: 7, description: 'Printing, photocopying and other services: sales, service prices and paper/toner supplies.', built: true },
  { to: '/telecom', label: 'Telecom', icon: Smartphone, phase: 6, description: 'Record reload and EZCash collections and provider top-ups, with commissions. Scratch cards are sold in Sales.', built: true },
  { to: '/expenses', label: 'Expenses', icon: Receipt, phase: 8, description: 'Record shop and telecom expenses (ice cream costs are recorded under Ice Cream).', built: true },
  { to: '/cash-books', label: 'Cash Books', icon: Wallet, phase: 8, description: 'Cash book for each of the three segments: balances, ledgers, opening balances, cash counts and daily closings.', built: true },
  { to: '/drawings', label: 'Drawings', icon: HandCoins, phase: 9, description: 'Owner drawings, capital introduced into the business, and transfers between cash books.', built: true },
  { to: '/ice-cream', label: 'Ice Cream', icon: IceCreamCone, phase: 10, description: 'Daily ice cream entries, payments, fund moves and the cost, electricity and profit funds.', built: true },
  { to: '/reports', label: 'Reports', icon: BarChart3, phase: 11, description: 'Profit and loss, cash and stock reports by segment and period.', built: true },
  { to: '/settings', label: 'Settings', icon: Settings, phase: 1, description: 'Shop details, commission rates, backups and the audit log. Print and service prices are under Services.', built: true },
];
