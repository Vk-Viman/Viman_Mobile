/**
 * Types of the dashboard answer (GET /dashboard, Phase 12). They mirror server/src/services/dashboard.service.ts.
 * All money is integer cents exactly as the server sent it; the screen never calculates a business figure.
 */

import type { ExternalBackupSummary } from './externalBackup';

/** The three business segments (cash books). */
export type Segment = 'shop' | 'telecom' | 'icecream';

/** Sales and profit of one segment (or of the whole business) for one period. May be negative. */
export interface SalesProfit { salesCents: number; profitCents: number }

/** One tile: combined figures plus each segment. */
export interface PeriodTile extends SalesProfit { bySegment: Record<Segment, SalesProfit> }

/** Ice Cream fund balances (never part of profit). */
export interface IceFunds { cost: number; electricity: number; profit: number }

/** A warning the server attached (`code` is stable, `message` is plain English). */
export interface DashboardWarning { code: string; message: string; [extra: string]: unknown }

/** One cash book line. */
export interface CashBookTile { book: Segment; balanceCents: number; funds?: IceFunds; fundsMatchBook?: boolean }

/** Response of GET /dashboard. */
export interface Dashboard {
  asOf: string;
  today: PeriodTile;
  month: PeriodTile;
  cash: { books: CashBookTile[]; totalCents: number };
  stock: {
    valueCents: number;
    lowStockCount: number;
    lowStock: Array<{ productId: number; name: string; qty: number; reorderLevel: number }>;
    negativeOrWarning: DashboardWarning[];
  };
  icecream: {
    recognizedProfitMonthCents: number;
    funds: IceFunds;
    fundsTotalCents: number;
    fundsMatchBook: boolean;
    excessCostNotChargedTodayCents: number;
    excessCostNotChargedMonthCents: number;
    profitAfterExcessCostMonthCents: number;
    outstandingExcessCostCents: number;
    warnings: DashboardWarning[];
  };
  closings: {
    lastClosedByBook: Record<Segment, string | null>;
    openDaysBehind: Array<{ book: Segment; dates: string[] }>;
  };
  backup: { latestAt: string | null; ageHours: number | null; status: 'ok' | 'stale' | 'none'; external: ExternalBackupSummary };
  series: {
    daily: Array<{ date: string; salesCents: number; profitCents: number }>;
    monthly: Array<{ month: string; shopCents: number; telecomCents: number; icecreamCents: number; combinedCents: number }>;
    topProducts: Array<{ name: string; revenueCents: number; grossProfitCents: number }>;
  };
  warnings: DashboardWarning[];
  definitions: Record<string, string>;
}
