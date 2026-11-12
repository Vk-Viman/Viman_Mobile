/**
 * API hooks for the operational reports (Phase 11): stock valuation, movements, losses, profitability, low stock,
 * sales, purchases, drawings, printing variance and backdated entries.
 *
 * Used by the Reports > Stock / Activity / Backdated tabs. All figures are calculated by the server in integer cents;
 * these hooks only fetch them. Reports are read-only, so there are no mutations here. Dates are business dates.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import { qs } from './queryString';
import type {
  BackdatedQuery, BackdatedReport, DrawingsReport, LossesReport, LowStockQuery, LowStockReport, MovementsQuery, MovementsReport,
  PeriodQuery, PrintingReport, ProfitabilityReport, PurchasesReport, SalesReport, ValuationQuery, ValuationReport,
} from '../types/reportsOperational';

/** Root of every operational-report query key (so one call can refresh them all). */
export const OPS_REPORT_KEY = ['reports-ops'] as const;

/** Builds one report query: `path` relative to /api/v1, `query` = the filters (empty values are left out). */
function useOps<T>(name: string, path: string, query: object, enabled = true) {
  return useQuery({
    queryKey: [...OPS_REPORT_KEY, name, query],
    queryFn: () => apiGet<T>(`${path}${qs(query)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Link that downloads the same report as an Excel file (`format=xlsx`). */
export function opsDownloadUrl(path: string, query: object): string {
  return `/api/v1${path}${qs({ ...query, format: 'xlsx' })}`;
}

/** GET /reports/inventory/valuation: stock and value as of a date. */
export const useValuationReport = (q: ValuationQuery) => useOps<ValuationReport>('valuation', '/reports/inventory/valuation', q);
/** GET /reports/low-stock. */
export const useLowStockReport = (q: LowStockQuery) => useOps<LowStockReport>('low-stock', '/reports/low-stock', q);
/** GET /reports/stock-movements (paged). */
export const useMovementsReport = (q: MovementsQuery) => useOps<MovementsReport>('movements', '/reports/stock-movements', q);
/** GET /reports/stock-losses. */
export const useLossesReport = (q: PeriodQuery & { book?: string }, enabled = true) => useOps<LossesReport>('losses', '/reports/stock-losses', q, enabled);
/** GET /reports/product-profitability. */
export const useProfitabilityReport = (q: PeriodQuery & { book?: string }, enabled = true) => useOps<ProfitabilityReport>('profit', '/reports/product-profitability', q, enabled);
/** GET /reports/sales. */
export const useSalesReport = (q: PeriodQuery & { book?: string }, enabled = true) => useOps<SalesReport>('sales', '/reports/sales', q, enabled);
/** GET /reports/purchases. */
export const usePurchasesReport = (q: PeriodQuery & { book?: string }, enabled = true) => useOps<PurchasesReport>('purchases', '/reports/purchases', q, enabled);
/** GET /reports/drawings. */
export const useDrawingsReport = (q: PeriodQuery & { book?: string }, enabled = true) => useOps<DrawingsReport>('drawings', '/reports/drawings', q, enabled);
/** GET /reports/printing-variance. */
export const usePrintingReport = (q: PeriodQuery, enabled = true) => useOps<PrintingReport>('printing', '/reports/printing-variance', q, enabled);
/** GET /reports/backdated (paged). */
export const useBackdatedReport = (q: BackdatedQuery, enabled = true) => useOps<BackdatedReport>('backdated', '/reports/backdated', q, enabled);
