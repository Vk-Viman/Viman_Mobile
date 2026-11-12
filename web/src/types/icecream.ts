/**
 * Types of the Phase 10 API: Ice Cream daily entries, payments, fund moves and the funds summary. Mirrors API_CONTRACTS.md
 * "Wave 3 contracts - Phase 10" and BUSINESS_RULES section 10 (three funds, D1-D4). Money is always integer cents; the server
 * calculates every figure (profit share, Charged / Settled / Unspent, profit-eligible split, recognized profit, excess cost)
 * and the screens only display them (the live profit share in the entry form is a preview of S - C - E; the server decides).
 */
import type { PostedStatus } from './api';
import type { CashWarning, IceFund } from './cashbooks';

export type { IceFund } from './cashbooks';

// ---- warnings ----

/** 10.5 (D3): real spending exceeded the allocations. Official profit is NOT reduced automatically. */
export interface ExcessCostWarning {
  code: 'EXCESS_COST_OUTSTANDING'; message: string; book: 'icecream'; outstandingExcessCostCents: number; asOf: string;
}
/** Every warning an Ice Cream response may carry. */
export type IceWarning = CashWarning | ExcessCostWarning;

// ---- funds summary (GET /icecream/funds and the `funds` block of every write) ----

/** One charge line (Materials or Electricity): Charged, Settled and Unspent = Charged - Settled (10.4). */
export interface LineState { chargedCents: number; settledCents: number; unspentCents: number }
/** Signed contributions to recognized profit (10.3); re-allocations and other expenses are negative. */
export interface Recognition {
  dailyProfitShareCents: number; profitEligibleReleasesCents: number; reallocationsCents: number; otherExpensesCents: number;
  cashOverShortCents: number;
}
/** The three period-flow lines of 10.6 for one period. */
export interface PeriodFlows {
  from: string | null; to: string | null; recognizedProfitCents: number; excessCostNotChargedCents: number; profitAfterExcessCostCents: number;
}
export interface FundsSummary {
  asOf: string | null;
  funds: Record<IceFund, { balanceCents: number }>;
  totalCents: number;
  cashBookBalanceCents: number;
  reconciled: boolean;
  lines: { materials: LineState; electricity: LineState };
  unspentAllocationCents: number;
  outstandingExcessCostCents: number;
  recognizedProfitToDateCents: number;
  profitAfterExcessCostToDateCents: number;
  recognition: Recognition;
  period: PeriodFlows;
  warnings: IceWarning[];
}
export interface FundsQuery { asOf?: string; from?: string }

// ---- fund ledger (GET /icecream/funds/entries) ----

export type FundEntryKind = 'daily_allocation' | 'payment' | 'fund_move' | 'drawing' | 'transfer_out' | 'transfer_in' | 'opening_balance'
  | 'capital' | 'cash_over_short' | 'reversal';
export interface FundEntry {
  id: number; businessDate: string; postedAt: string; fund: IceFund; amountCents: number; kind: FundEntryKind; refTable: string | null;
  refId: number | null; reversesEntryId: number | null; note: string | null;
}
export interface FundLedgerQuery { fund?: IceFund; from?: string; to?: string; limit?: number; offset?: number }
export interface FundLedger { items: FundEntry[]; total: number; totals: { inCents: number; outCents: number; netCents: number } }

/** What every Ice Cream write returns next to the record. */
export interface WriteExtras { funds: FundsSummary; warnings: IceWarning[] }

// ---- daily entries ----

export interface DayItem { id: number; itemName: string; qty: number; unitPriceCents: number; lineTotalCents: number }
export interface IceDay {
  id: number; businessDate: string; postedAt: string; backdated: boolean; salesCents: number; costAllocCents: number;
  electricityAllocCents: number; profitShareCents: number; negativeConfirmed: boolean; notes: string; status: PostedStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string; items: DayItem[];
}
export interface DayItemInput { itemName: string; qty: number; unitPriceCents: number }
/** The editable fields of a daily entry (the same for a new entry and a replacement). */
export interface DayInput {
  salesCents: number; costAllocCents: number; electricityAllocCents: number; items?: DayItemInput[]; confirmNegativeProfit?: boolean;
  notes?: string; clientRef: string;
}
export interface DayCreate extends DayInput { businessDate: string }
export interface DayReplace extends DayInput { reason?: string }
export interface DayWriteResult extends WriteExtras { day: IceDay }
export interface DayQuery { from?: string; to?: string; status?: PostedStatus; limit?: number; offset?: number }
export interface DayList {
  items: IceDay[]; total: number;
  totals: { salesCents: number; costAllocCents: number; electricityAllocCents: number; profitShareCents: number };
}

// ---- payments ----

export type PaymentKind = 'materials' | 'electricity_bill' | 'other_cost';
export interface IcePayment {
  id: number; businessDate: string; postedAt: string; backdated: boolean; kind: PaymentKind; fund: IceFund; amountCents: number;
  category: string | null; description: string; pnlTreatment: 'settlement' | 'expense'; status: PostedStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}
export interface PaymentCreate {
  businessDate: string; kind: PaymentKind; fund: IceFund; amountCents: number; category?: string; description: string; clientRef: string;
}
export interface PaymentWriteResult extends WriteExtras { payment: IcePayment }
export interface PaymentQuery { from?: string; to?: string; kind?: PaymentKind; fund?: IceFund; status?: PostedStatus; limit?: number; offset?: number }
export interface PaymentList { items: IcePayment[]; total: number; totals: { amountCents: number } }

// ---- fund moves ----

export type MoveKind = 'release' | 'reallocation' | 'relabel';
export interface IceMove {
  id: number; businessDate: string; postedAt: string; backdated: boolean; fromFund: IceFund; toFund: IceFund; amountCents: number;
  kind: MoveKind; profitEffectCents: number; chargeRelabelCents: number; cashOnlyCents: number; note: string; status: PostedStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}
export interface MovePreviewBody { fromFund: IceFund; toFund: IceFund; amountCents: number }
/** What a move WOULD do (no write): the split of 10.4 / D4 in numbers and in plain words. */
export interface MovePreview {
  profitEligibleCents: number; cashOnlyCents: number; chargeRelabelCents: number; profitEffectCents: number; needsConfirmation: boolean;
  kind: MoveKind; explanation: string; warnings: CashWarning[];
}
export interface MoveCreate extends MovePreviewBody {
  businessDate: string; confirmSplit?: boolean; confirmedProfitEligibleCents?: number; note?: string; clientRef: string;
}
export interface MoveWriteResult extends WriteExtras { move: IceMove }
export interface MoveQuery { from?: string; to?: string; status?: PostedStatus; limit?: number; offset?: number }
export interface MoveList {
  items: IceMove[]; total: number; totals: { amountCents: number; profitEffectCents: number; cashOnlyCents: number };
}
