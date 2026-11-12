/**
 * services/dashboard.service.ts - everything the home-screen dashboard shows, in ONE read-only call (Phase 12).
 *
 * Layer: service (route -> SERVICE -> report services -> database). It is a thin COMPOSER: every figure comes from a Phase 11
 * report function or an existing read service, called directly (no HTTP self-calls), inside one transaction so all tiles describe
 * the same instant. It never re-derives a profit, balance or valuation, and it never writes (no rows, no audit entries).
 *
 * Rules protected (BUSINESS_RULES):
 *  - 1 / 7 / 10.6  profit = the reports' segment net profit; Ice Cream profit = RECOGNIZED profit; every period figure uses only
 *                  records whose business date is inside the period (month = 1st of the month .. asOf).
 *  - 10.1          Ice Cream fund balances are shown beside, never inside, profit; Cost + Electricity + Profit = the Ice Cream book
 *                  (`reconciled` carries that check).
 *  - 10.5 (D3)     excess cost: whenever outstanding excess > 0 the warning and the three period-flow lines are included; official
 *                  profit is never reduced.
 *  - 8 / R9        closings are per book; R13 a negative book is a warning, never an error.
 *  - R-FD          `asOf` is a read-only business date: past and future dates are accepted (nothing is written).
 */
import type { AppContext } from '../app.ts';
import { isIsoDate, todayBusinessDate } from '../lib/dates.ts';
import { listPeriods } from '../lib/report-table.ts';
import { cashBalanceAsOf } from '../repositories/cash-entries.repo.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import { loadFacts } from '../repositories/icecream.repo.ts';
import { AppError } from '../lib/errors.ts';
import { listBackups } from './backup.service.ts';
import { negativeBalanceWarning } from './cash-warnings.ts';
import { addDays, monthStart, monthStartMonthsBack } from './dashboard-dates.ts';
import { closingsBlock } from './dashboard-closings.ts';
import type { ClosingsBlock } from './dashboard-closings.ts';
import { segmentLines } from './dashboard-segments.ts';
import type { SalesProfit, SegmentLines } from './dashboard-segments.ts';
import { BOOKS } from './day-closing.ts';
import { fundsSummary } from './icecream.service.ts';
import type { IceWarning } from './icecream.service.ts';
import { periodReport } from './icecream-rules.ts';
import { inventoryValuation } from './reports/inventory-valuation.ts';
import { lowStockReport } from './reports/low-stock.ts';
import type { ReportWarning } from './reports/ops-common.ts';
import { productProfitability } from './reports/product-profitability.ts';
import type { CashWarning } from './cash-warnings.ts';

/** Days shown in the daily chart (ending on the dashboard date). */
export const DAILY_SERIES_DAYS = 30;
/** Months shown in the monthly chart (the month of the dashboard date and the 11 before it). */
export const MONTHLY_SERIES_MONTHS = 12;
/** Products listed in the "top products" chart. */
export const TOP_PRODUCTS = 5;
/** Products listed in the low-stock tile. */
export const LOW_STOCK_LIST = 10;
/** A backup older than this many hours is reported as `stale` (the shop PC takes one at every start-up). */
export const BACKUP_STALE_HOURS = 48;

/** Any warning the dashboard can carry (all have `code` and `message`). */
export type DashboardWarning = CashWarning | IceWarning | ReportWarning;

/** Sales and profit of one period, per segment and combined (the tiles). */
export interface PeriodTile extends SalesProfit { bySegment: { shop: SalesProfit; telecom: SalesProfit; icecream: SalesProfit } }

/** One cash book tile; Ice Cream also carries its three funds (always apart from profit, 10.1). */
export interface CashBookTile {
  book: CashBook; balanceCents: number;
  funds?: Record<IceFund, number>;
  /** Ice Cream only: true when Cost + Electricity + Profit equals the book (the "= book" check). */
  fundsMatchBook?: boolean;
}

/** The whole dashboard answer. */
export interface DashboardResponse {
  asOf: string;
  today: PeriodTile;
  month: PeriodTile;
  cash: { books: CashBookTile[]; totalCents: number };
  stock: {
    valueCents: number; lowStockCount: number;
    lowStock: Array<{ productId: number; name: string; qty: number; reorderLevel: number }>;
    negativeOrWarning: ReportWarning[];
  };
  icecream: {
    recognizedProfitMonthCents: number;
    funds: Record<IceFund, number>;
    fundsTotalCents: number;
    fundsMatchBook: boolean;
    excessCostNotChargedTodayCents: number;
    excessCostNotChargedMonthCents: number;
    profitAfterExcessCostMonthCents: number;
    outstandingExcessCostCents: number;
    warnings: IceWarning[];
  };
  closings: ClosingsBlock;
  backup: { latestAt: string | null; ageHours: number | null; status: 'ok' | 'stale' | 'none' };
  series: {
    daily: Array<{ date: string; salesCents: number; profitCents: number }>;
    monthly: Array<{ month: string; shopCents: number; telecomCents: number; icecreamCents: number; combinedCents: number }>;
    topProducts: Array<{ name: string; revenueCents: number; grossProfitCents: number }>;
  };
  warnings: DashboardWarning[];
  definitions: Record<string, string>;
}

/** Plain-language definitions returned with every answer so the screen (and a reader of the JSON) never has to guess. */
export const DASHBOARD_DEFINITIONS: Record<string, string> = {
  sales: 'Sales are the revenue lines of the profit and loss reports, net of returns (a return counts on the day it was made).',
  salesShop: 'Shop sales = goods revenue + print/service revenue.',
  salesTelecom: 'Telecom sales = scratch-card revenue + reload commission + EZCash commission. Reload and EZCash collections and top-ups are cash only, never sales.',
  salesIcecream: 'Ice Cream sales = the daily sales entered for the Ice Cream book.',
  salesCombined: 'Combined sales = Shop + Telecom + Ice Cream sales.',
  profit: 'Profit = the segment net profit of the reports (gross profit and commissions - expenses - stock adjustments +/- cash over/short). Ice Cream profit is the RECOGNIZED profit. Combined profit = Shop + Telecom + Ice Cream recognized profit.',
  today: 'Today = the dashboard date only.',
  month: 'This month = the 1st of the dashboard date\'s month up to and including the dashboard date.',
  cash: 'Cash balances are the sum of every ledger entry dated on or before the dashboard date. Ice Cream fund balances are shown separately and are not profit.',
  stock: 'Stock value is the value of stock on hand at the dashboard date (from the stock movements). The low-stock list is the live list of products at or below their minimum.',
  excessCost: 'Excess cost = money actually spent beyond what was set aside in the daily allocations. Official profit is not reduced automatically; the "profit after excess cost" line shows what it would be.',
  closings: 'Days not yet closed = the 7 days before the dashboard date, from the book\'s first entry onward, that have no active daily closing.',
  backup: `Backup age is measured from the real current time. Status is "stale" after ${BACKUP_STALE_HOURS} hours and "none" when there is no backup.`,
  seriesDaily: `Daily series = the last ${DAILY_SERIES_DAYS} days ending on the dashboard date (days without records are zero). Profit is the combined recognized profit.`,
  seriesMonthly: `Monthly series = the last ${MONTHLY_SERIES_MONTHS} calendar months ending with the dashboard date's month (the last month runs only up to the dashboard date).`,
  topProducts: `Top products = the ${TOP_PRODUCTS} stock products (Shop goods and scratch cards) with the highest gross profit this month, net of returns.`,
};

function tile(l: SegmentLines): PeriodTile {
  return { ...l.combined, bySegment: { shop: l.shop, telecom: l.telecom, icecream: l.icecream } };
}

/**
 * Validates the optional `asOf` query value and falls back to today (Asia/Colombo).
 * @throws AppError 400 VALIDATION_ERROR for something that is not a real `YYYY-MM-DD` date.
 */
export function resolveAsOf(raw: string | undefined, now: Date = new Date()): string {
  if (raw === undefined) return todayBusinessDate(now);
  if (!isIsoDate(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the date.', { asOf: 'Not a real date (use YYYY-MM-DD).' });
  return raw;
}

function backupBlock(ctx: AppContext, now: Date): DashboardResponse['backup'] {
  const latest = listBackups(ctx)[0];
  if (!latest) return { latestAt: null, ageHours: null, status: 'none' };
  const ageHours = Math.max(0, Math.round(((now.getTime() - new Date(latest.createdAt).getTime()) / 3_600_000) * 10) / 10);
  return { latestAt: latest.createdAt, ageHours, status: ageHours > BACKUP_STALE_HOURS ? 'stale' : 'ok' };
}

/**
 * Builds the dashboard for a business date.
 *
 * @param asOf business date (default today in Colombo); a future date is accepted and simply shows today's balances and empty periods.
 * @param now  the real clock, used only for the backup age (tests pass a fixed one).
 */
export function buildDashboard(ctx: AppContext, asOf: string, now: Date = new Date()): DashboardResponse {
  return ctx.database.tx((conn) => {
    const facts = loadFacts(conn);
    const monthFrom = monthStart(asOf);

    // Tiles: each is one period through the same report functions the P&L reports use.
    const [todayLine] = segmentLines(conn, facts, [{ from: asOf, to: asOf, label: asOf }]);
    const [monthLine] = segmentLines(conn, facts, [{ from: monthFrom, to: asOf, label: monthFrom.slice(0, 7) }]);

    // Charts: 30 day rows and 12 clipped month rows, zero-filled by `listPeriods`.
    const dailyPeriods = listPeriods(addDays(asOf, 1 - DAILY_SERIES_DAYS), asOf, 'day');
    const monthlyPeriods = listPeriods(monthStartMonthsBack(asOf, MONTHLY_SERIES_MONTHS - 1), asOf, 'month');
    const daily = segmentLines(conn, facts, dailyPeriods);
    const monthly = segmentLines(conn, facts, monthlyPeriods);

    // Cash and the Ice Cream funds (10.1): balances as of the date, funds kept apart from profit.
    const ice = fundsSummary(conn, asOf);
    const books: CashBookTile[] = BOOKS.map((book) => {
      const balanceCents = cashBalanceAsOf(conn, book, asOf);
      if (book !== 'icecream') return { book, balanceCents };
      return {
        book, balanceCents, fundsMatchBook: ice.reconciled,
        funds: { cost: ice.funds.cost.balanceCents, electricity: ice.funds.electricity.balanceCents, profit: ice.funds.profit.balanceCents },
      };
    });

    // Ice Cream recognized profit and the D3 period flows, straight from the rules module's period report.
    const iceMonth = periodReport(facts, monthFrom, asOf);
    const iceToday = periodReport(facts, asOf, asOf);

    // Stock.
    const valuation = inventoryValuation(conn, { asOf });
    const low = lowStockReport(conn, {});
    const stockWarnings: ReportWarning[] = [...valuation.warnings];
    if (valuation.reconciliation.matchesCache === false) {
      stockWarnings.push({ code: 'STOCK_CACHE_MISMATCH', message: 'The stock on hand does not agree with the stock movements. Please contact support.' });
    }

    const top = productProfitability(conn, { from: monthFrom, to: asOf }).rows.slice(0, TOP_PRODUCTS);

    const warnings: DashboardWarning[] = [];
    for (const b of books) if (b.balanceCents < 0) warnings.push(negativeBalanceWarning(b.book, b.balanceCents));
    warnings.push(...ice.warnings, ...stockWarnings);

    return {
      asOf,
      today: tile(todayLine!),
      month: tile(monthLine!),
      cash: { books, totalCents: books.reduce((s, b) => s + b.balanceCents, 0) },
      stock: {
        valueCents: valuation.totals.valueCents, lowStockCount: low.totals.products,
        lowStock: low.rows.slice(0, LOW_STOCK_LIST).map((r) => ({ productId: r.productId, name: r.name, qty: r.qtyOnHand, reorderLevel: r.reorderLevel })),
        negativeOrWarning: stockWarnings,
      },
      icecream: {
        recognizedProfitMonthCents: iceMonth.recognizedProfitCents,
        funds: { cost: ice.funds.cost.balanceCents, electricity: ice.funds.electricity.balanceCents, profit: ice.funds.profit.balanceCents },
        fundsTotalCents: ice.totalCents, fundsMatchBook: ice.reconciled,
        excessCostNotChargedTodayCents: iceToday.excessCostNotChargedCents,
        excessCostNotChargedMonthCents: iceMonth.excessCostNotChargedCents,
        profitAfterExcessCostMonthCents: iceMonth.profitAfterExcessCostCents,
        outstandingExcessCostCents: iceMonth.balancesAsOfPeriodEnd.outstandingExcessCostCents,
        warnings: ice.warnings,
      },
      closings: closingsBlock(conn, asOf),
      backup: backupBlock(ctx, now),
      series: {
        daily: dailyPeriods.map((p, i) => ({ date: p.from, salesCents: daily[i]!.combined.salesCents, profitCents: daily[i]!.combined.profitCents })),
        monthly: monthlyPeriods.map((p, i) => ({
          month: p.label, shopCents: monthly[i]!.shop.profitCents, telecomCents: monthly[i]!.telecom.profitCents,
          icecreamCents: monthly[i]!.icecream.profitCents, combinedCents: monthly[i]!.combined.profitCents,
        })),
        topProducts: top.map((r) => ({ name: r.productName, revenueCents: r.revenueCents, grossProfitCents: r.grossProfitCents })),
      },
      warnings,
      definitions: DASHBOARD_DEFINITIONS,
    };
  });
}
