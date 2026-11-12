/**
 * Types of the operational report responses (Phase 11, agent B): inventory valuation, stock movements, stock losses,
 * product profitability, low stock, purchases, sales, drawings, printing variance and backdated entries.
 *
 * They mirror the server report services (`server/src/services/reports/*.ts`). Money is integer cents, margins are
 * basis points; every report also carries the shared `table` (see `pages/reports/shared.tsx`) and `warnings`.
 */
import type { ReportTable } from '../pages/reports/shared';

export type OpsBook = 'shop' | 'telecom' | 'icecream';
export type StockBook = 'shop' | 'telecom';
export interface OpsWarning { code: string; message: string }
export interface OpsPeriod { from: string; to: string; label: string }

/** Fields every operational report response has. `extraTables` holds breakdown tables (also written to the Excel file). */
export interface OpsReportBase { table: ReportTable; extraTables?: ReportTable[]; warnings: OpsWarning[] }

export interface ValuationRow {
  productId: number; code: string | null; name: string; categoryId: number; categoryName: string; book: StockBook;
  active: boolean; qty: number; valueCents: number; avgUnitCostCents: number | null;
}
export interface ValuationGroup { qty: number; valueCents: number; products: number }
export interface ValuationReport extends OpsReportBase {
  asOf: string; rows: ValuationRow[];
  byBook: Array<{ book: StockBook } & ValuationGroup>;
  byCategory: Array<{ categoryId: number; categoryName: string; book: StockBook } & ValuationGroup>;
  totals: ValuationGroup;
  reconciliation: { asOfIsLive: boolean; cacheQty: number; cacheValueCents: number; matchesCache: boolean | null };
}
export interface ValuationQuery { asOf?: string; book?: StockBook | ''; categoryId?: number | ''; includeZero?: boolean; includeInactive?: boolean }

export interface LowStockRow {
  productId: number; name: string; categoryName: string; book: StockBook; qtyOnHand: number; reorderLevel: number;
  shortfall: number; outOfStock: boolean; stockValueCents: number;
}
export interface LowStockReport extends OpsReportBase { rows: LowStockRow[]; totals: { products: number; outOfStock: number; stockValueCents: number } }
export interface LowStockQuery { book?: StockBook | ''; includeInactive?: boolean }

export type MovementType =
  | 'opening' | 'purchase' | 'purchase_return' | 'purchase_void' | 'sale' | 'sale_return' | 'sale_void'
  | 'personal_use' | 'loss' | 'stocktake_gain' | 'stocktake_loss' | 'adjustment';
export interface MovementsReport extends OpsReportBase {
  total: number; limit: number; offset: number;
  totals: { count: number; qtyDelta: number; valueDeltaCents: number };
  byType: Array<{ type: MovementType; count: number; qtyDelta: number; valueDeltaCents: number }>;
}
export interface MovementsQuery { from?: string; to?: string; productId?: number | ''; type?: MovementType | ''; book?: StockBook | ''; limit?: number; offset?: number }

export interface PeriodQuery { from: string; to: string; granularity?: 'day' | 'month' }

export interface LossesReport extends OpsReportBase {
  totals: { lossCount: number; qty: number; costCents: number; stockAdjustmentsNetCents: number };
}
export interface ProfitabilityReport extends OpsReportBase {
  totals: { revenueCents: number; costCents: number; grossProfitCents: number; marginBp: number | null };
}
export interface PurchasesReport extends OpsReportBase { totals: { purchasesCents: number; returnsCents: number; netCents: number } }
export interface SalesReport extends OpsReportBase { totals: { revenueCents: number; costCents: number; grossProfitCents: number; marginBp: number | null } }
export interface DrawingsReport extends OpsReportBase { totals: { cashCents: number; goodsCents: number; totalCents: number; capitalCents: number; transfersCents: number } }
export interface PrintingReport extends OpsReportBase {
  totals: { revenueCents: number; standardCostChargedCents: number; suppliesSpentCents: number; varianceCents: number };
}

export interface BackdatedReport extends OpsReportBase {
  total: number; limit: number; offset: number;
  byType: Array<{ recordType: string; recordLabel: string; count: number }>;
}
export interface BackdatedQuery { from: string; to: string; book?: OpsBook | ''; limit?: number; offset?: number }
