import {
  LayoutDashboard, ShoppingCart, Package, Truck, Boxes, ClipboardList, Smartphone, Receipt,
  Wallet, HandCoins, IceCreamCone, BarChart3, Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  phase: number;
  description: string;
  built?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, phase: 12, description: 'Today at a glance: sales, profit, cash in each book and stock alerts.', built: true },
  { to: '/sales', label: 'Sales', icon: ShoppingCart, phase: 5, description: 'Record cash sales of goods and services, with returns and voids.' },
  { to: '/products', label: 'Products', icon: Package, phase: 2, description: 'Manage the product catalogue, prices and categories.', built: true },
  { to: '/purchases', label: 'Purchases', icon: Truck, phase: 3, description: 'Record stock bought from suppliers and what you paid.', built: true },
  { to: '/stock', label: 'Stock', icon: Boxes, phase: 4, description: 'See stock on hand, movements, adjustments and losses.', built: true },
  { to: '/opening-stock', label: 'Opening Stock', icon: ClipboardList, phase: 13, description: 'Enter starting stock by hand or from an Excel template at go-live.' },
  { to: '/telecom', label: 'Telecom', icon: Smartphone, phase: 6, description: 'Reloads, EZCash bill payments and scratch cards with commissions.' },
  { to: '/expenses', label: 'Expenses', icon: Receipt, phase: 8, description: 'Record shop, telecom and ice cream expenses.' },
  { to: '/cash-books', label: 'Cash Books', icon: Wallet, phase: 8, description: 'Daily cash book for each of the three segments, with transfers and cash counts.' },
  { to: '/drawings', label: 'Drawings', icon: HandCoins, phase: 9, description: 'Owner drawings and capital introduced into the business.' },
  { to: '/ice-cream', label: 'Ice Cream', icon: IceCreamCone, phase: 10, description: 'Daily ice cream sales, costs and electricity.' },
  { to: '/reports', label: 'Reports', icon: BarChart3, phase: 11, description: 'Profit and loss, cash and stock reports by segment and period.' },
  { to: '/settings', label: 'Settings', icon: Settings, phase: 1, description: 'Shop details, commission rates, printing defaults, backups and audit log.', built: true },
];
