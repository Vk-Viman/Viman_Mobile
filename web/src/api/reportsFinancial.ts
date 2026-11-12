/**
 * API hooks of the financial reports (Phase 11, agent A): profit and loss (Shop, Telecom, Ice Cream, Combined), the cash book report,
 * the transfers report and the Ice Cream fund statement. Endpoints: GET /reports/pnl/:segment, /reports/cashbook/:book,
 * /reports/transfers, /reports/icecream-funds (API_CONTRACTS.md "Wave 4 contract"), all with `?from&to&granularity`.
 * Reports are read-only and the money behind them changes whenever any screen saves, so they are never treated as fresh
 * (`staleTime: 0`); while the owner changes the dates the previous answer stays on screen until the new one arrives.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import { periodQuery } from '../pages/reports/shared';
import type { ReportPeriod } from '../pages/reports/shared';
import type {
  CashbookReport, CombinedPnl, FinBook, FundsReport, IceCreamPnl, PnlSegment, ShopPnl, TelecomPnl, TransfersReport,
} from '../types/reportsFinancial';

/** Root of every financial report query key. */
export const FIN_REPORTS_KEY = ['reports', 'financial'] as const;

type PnlBySegment = { shop: ShopPnl; telecom: TelecomPnl; icecream: IceCreamPnl; combined: CombinedPnl };

/** GET /reports/pnl/:segment for the chosen period. */
export function usePnl<S extends PnlSegment>(segment: S, period: ReportPeriod) {
  return useQuery({
    queryKey: [...FIN_REPORTS_KEY, 'pnl', segment, period.from, period.to, period.granularity],
    queryFn: () => apiGet<PnlBySegment[S]>(`/reports/pnl/${segment}${periodQuery(period)}`),
    enabled: period.ready, placeholderData: (prev) => prev, staleTime: 0,
  });
}

/** GET /reports/cashbook/:book: per-period opening / in / out / closing, entry types and (Ice Cream) funds. */
export const useCashbookReport = (book: FinBook, period: ReportPeriod) =>
  useQuery({
    queryKey: [...FIN_REPORTS_KEY, 'cashbook', book, period.from, period.to, period.granularity],
    queryFn: () => apiGet<CashbookReport>(`/reports/cashbook/${book}${periodQuery(period)}`),
    enabled: period.ready, placeholderData: (prev) => prev, staleTime: 0,
  });

/** GET /reports/transfers: posted transfers with totals by direction. */
export const useTransfersReport = (period: ReportPeriod) =>
  useQuery({
    queryKey: [...FIN_REPORTS_KEY, 'transfers', period.from, period.to, period.granularity],
    queryFn: () => apiGet<TransfersReport>(`/reports/transfers${periodQuery(period)}`),
    enabled: period.ready, placeholderData: (prev) => prev, staleTime: 0,
  });

/** GET /reports/icecream-funds: fund statement per period and the recognized-profit block. */
export const useFundsReport = (period: ReportPeriod) =>
  useQuery({
    queryKey: [...FIN_REPORTS_KEY, 'funds', period.from, period.to, period.granularity],
    queryFn: () => apiGet<FundsReport>(`/reports/icecream-funds${periodQuery(period)}`),
    enabled: period.ready, placeholderData: (prev) => prev, staleTime: 0,
  });
