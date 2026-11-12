/**
 * Types of the financial report answers (Phase 11, agent A): profit and loss per segment, the cash book report, the transfers
 * report and the Ice Cream fund statement. They mirror `server/src/services/reports/*` and API_CONTRACTS.md "Wave 4 contract".
 * Money is integer cents, rates basis points; every figure comes from the server - nothing here is calculated on the screen.
 */
import type { ReportTable } from '../pages/reports/shared';

/** The four P&L views. */
export type PnlSegment = 'shop' | 'telecom' | 'icecream' | 'combined';
/** The three cash books and funds. */
export type FinBook = 'shop' | 'telecom' | 'icecream';
export type FinFund = 'cost' | 'electricity' | 'profit';

/** One report period (inclusive business dates). */
export interface FinPeriod { from: string; to: string; label: string }
/** Every period report row. */
export type FinRow<F> = { period: FinPeriod } & F;

/** A warning of a report (the excess-cost warning or a negative balance). */
export interface FinWarning { code: string; message: string; outstandingExcessCostCents?: number; asOf?: string; balanceCents?: number; fund?: FinFund }

/** Common envelope. */
export interface FinReport<F> { from: string; to: string; granularity: 'day' | 'month'; rows: Array<FinRow<F>>; totals: F; table: ReportTable; warnings: FinWarning[] }

export interface SalesLines {
  salesCents: number; returnsCents: number; revenueCents: number; costAutomaticCents: number; costExtraCents: number; costOfSalesCents: number; grossProfitCents: number;
}
export interface ExpenseLines { totalCents: number; byCategory: Record<string, number> }
export interface AdjustmentLines {
  lossesCents: number; damagedReturnLossesCents: number; stocktakeLossesCents: number; stocktakeGainsCents: number; residualSweepsCents: number; purchaseRefundGainCents: number; netCents: number;
}

export interface ShopFigures {
  goods: SalesLines; services: { revenueCents: number; costCents: number; grossProfitCents: number }; grossProfitCents: number;
  expenses: ExpenseLines; adjustments: AdjustmentLines; cashOverShortCents: number; netProfitCents: number;
}
export interface TelecomFigures {
  commissions: {
    reloadSalesCents: number; reloadBaseCommissionCents: number; reloadExtraCents: number; reloadCommissionCents: number;
    ezcashBillCents: number; ezcashCommissionCents: number;
  };
  commissionRevenueCents: number; cards: SalesLines; grossProfitCents: number; expenses: ExpenseLines; adjustments: AdjustmentLines;
  cashOverShortCents: number; netProfitCents: number; memo: { providerTopupsCents: number; walletTopupsCents: number };
}
/** Ice Cream P&L row = the rules module's period report (BUSINESS_RULES 10.6). */
export interface IceFigures {
  salesCents: number; materialsChargeCents: number; electricityChargeCents: number; otherExpensesCents: number; cashOverShortCents: number;
  recognizedProfitCents: number;
  recognition: { dailyProfitShareCents: number; profitEligibleReleasesCents: number; reallocationsCents: number; otherExpensesCents: number; cashOverShortCents: number };
  memo: { actualMaterialsPaidCents: number; actualElectricityPaidCents: number; otherCostsFromCostElecFundsCents: number };
  excessCostNotChargedCents: number; profitAfterExcessCostCents: number;
  balancesAsOfPeriodEnd: { unspentByLine: { materialsCents: number; electricityCents: number }; unspentCents: number; outstandingExcessCostCents: number };
}
export interface CombinedFigures {
  segments: { shop: { recognizedProfitCents: number }; telecom: { recognizedProfitCents: number }; icecream: { recognizedProfitCents: number } };
  recognizedProfitCents: number; electricityChargedCents: number; electricityBillsPaidCents: number;
  icecreamExcessCostNotChargedCents: number; combinedProfitAfterExcessCostCents: number; outstandingExcessCostCents: number;
}

export type ShopPnl = FinReport<ShopFigures>;
export type TelecomPnl = FinReport<TelecomFigures>;
export type IceCreamPnl = FinReport<IceFigures>;
export type CombinedPnl = FinReport<CombinedFigures>;

export interface TypeTotal { type: string; label: string; inCents: number; outCents: number; netCents: number }
export interface FundPeriod { openingCents: number; inCents: number; outCents: number; movesNetCents: number; closingCents: number }
export interface CashbookFigures {
  openingCents: number; inCents: number; outCents: number; closingCents: number; byType: TypeTotal[]; funds?: Record<FinFund, FundPeriod>;
}
export interface CashbookReport extends FinReport<CashbookFigures> {
  book: FinBook; ledgerBalanceAsOfToCents: number; typeTable: ReportTable; fundTable?: ReportTable;
}

export interface TransferItem {
  id: number; businessDate: string; fromBook: FinBook; toBook: FinBook; fromFund: FinFund | null; toFund: FinFund | null; amountCents: number; note: string;
}
export interface TransferFigures {
  count: number; totalCents: number; byDirection: Record<string, { count: number; amountCents: number }>;
  byBook: Record<FinBook, { outCents: number; inCents: number; netCents: number }>;
}
export interface TransfersReport extends FinReport<TransferFigures> { items: TransferItem[]; itemsTable: ReportTable }

export interface FundStatement {
  openingCents: number; allocationsCents: number; openingBalanceCents: number; capitalCents: number; transfersInCents: number;
  movesIn: { totalCents: number; profitEligibleCents: number; cashOnlyCents: number };
  movesOutCents: number; paymentsCents: number; drawingsCents: number; transfersOutCents: number; overShortCents: number; closingCents: number;
}
export interface FundsFigures {
  funds: Record<FinFund, FundStatement>; total: FundStatement; cashBookClosingCents: number; reconciled: boolean; profit: IceFigures;
}
export interface FundsReport extends FinReport<FundsFigures> { profitTable: ReportTable }
