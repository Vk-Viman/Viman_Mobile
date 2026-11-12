/**
 * services/dashboard-segments.ts - per-period "sales" and "profit" of each segment, taken from the Phase 11 report functions.
 *
 * Layer: dashboard helper (read-only; no writes, no audit rows). It calculates NOTHING of its own about profit: every profit
 * figure is read from the report service that owns it (`combinedFigures` for the three segment profits and the combined profit,
 * which in turn call the Shop/Telecom/Ice Cream report functions), so a dashboard tile can never disagree with a report
 * (API_CONTRACTS Phase 12: "every number must equal the corresponding Phase 11 report for the same range").
 *
 * What "sales" means per segment (stated in the API response `definitions` block; BUSINESS_RULES 1, 5, 10, R5, R14):
 *  - Shop       = goods revenue + service (print) revenue, both net of returns - the revenue lines of the Shop P&L.
 *  - Telecom    = scratch-card revenue (net of returns) + reload commission + EZCash commission. Reload and EZCash collections and
 *                 provider/wallet top-ups are cash only and never sales (R14).
 *  - Ice Cream  = the recognized `salesCents` of the Ice Cream report (posted daily entries dated in the period).
 *  - Combined   = the sum of the three lines above (a total of display figures; the combined PROFIT is the report's own figure).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Period } from '../lib/report-table.ts';
import type { IceFacts } from './icecream-rules.ts';
import { periodReport } from './icecream-rules.ts';
import { combinedFigures } from './reports/pnl-combined.ts';
import { shopFigures } from './reports/pnl-shop.ts';
import { telecomFigures } from './reports/pnl-telecom.ts';

/** Sales and profit of one segment (or of the whole business) for one period, in cents. May be negative (returns, losses). */
export interface SalesProfit { salesCents: number; profitCents: number }

/** The three segments and the combined total for one period. */
export interface SegmentLines { shop: SalesProfit; telecom: SalesProfit; icecream: SalesProfit; combined: SalesProfit }

/**
 * Sales and profit per segment for each of the given periods (contiguous, sorted; grouped SQL, a constant number of queries).
 *
 * @param facts the already-loaded Ice Cream records (`loadFacts`), shared so the dashboard loads them once.
 */
export function segmentLines(conn: DatabaseSync, facts: IceFacts, periods: readonly Period[]): SegmentLines[] {
  const shop = shopFigures(conn, periods);
  const telecom = telecomFigures(conn, periods);
  const combined = combinedFigures(conn, facts, periods);
  return periods.map((p, i) => {
    const shopSales = shop[i]!.goods.revenueCents + shop[i]!.services.revenueCents;
    const telecomSales = telecom[i]!.cards.revenueCents + telecom[i]!.commissionRevenueCents;
    const iceSales = periodReport(facts, p.from, p.to).salesCents;
    const c = combined[i]!;
    return {
      shop: { salesCents: shopSales, profitCents: c.segments.shop.recognizedProfitCents },
      telecom: { salesCents: telecomSales, profitCents: c.segments.telecom.recognizedProfitCents },
      icecream: { salesCents: iceSales, profitCents: c.segments.icecream.recognizedProfitCents },
      combined: { salesCents: shopSales + telecomSales + iceSales, profitCents: c.recognizedProfitCents },
    };
  });
}
