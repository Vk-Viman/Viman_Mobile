/**
 * Types of the Phase 8 API: expenses, cash books (ledger, balances, Ice Cream funds), opening balances, cash counts and
 * daily closings. Mirrors API_CONTRACTS.md "Wave 2 contract - Phase 8". Money is always integer cents; the server calculates
 * every figure (balances, running balances, expected amounts, over/short) and the screens only display them.
 */
import type { PostedStatus } from './api';
import type { SegmentSummary, StoredSegment } from './segments';

/** The three logical cash books (BUSINESS_RULES section 0). */
export type CashBook = 'shop' | 'telecom' | 'icecream';
/** The three Ice Cream funds (section 10). */
export type IceFund = 'cost' | 'electricity' | 'profit';

/**
 * The one non-blocking cash warning (R13) every cash-out write returns in `warnings`. `balanceCents` is the (negative)
 * balance of the book, or of the fund when `fund` is set. `ICECREAM_FUNDS_MISMATCH` only appears on the cash book summary.
 */
export interface CashWarning {
  code: 'NEGATIVE_CASH_BALANCE' | 'NEGATIVE_FUND_BALANCE' | 'ICECREAM_FUNDS_MISMATCH';
  message: string;
  book: CashBook;
  balanceCents: number;
  fund?: IceFund;
  /** Telecom only (13D): the segment whose balance is below zero. */
  segment?: StoredSegment;
}

// ---- Expenses ----

/** A Shop or Telecom expense (never electricity, E2). A Telecom expense belongs to one segment (13D). */
export interface Expense {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: 'shop' | 'telecom'; segment: StoredSegment | null;
  category: string; amountCents: number; description: string; notes: string; status: PostedStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}
export interface ExpenseCategory { value: string; label: string }
export interface ExpenseCategoryList { items: ExpenseCategory[] }
export interface ExpenseCreate {
  businessDate: string; book: 'shop' | 'telecom'; segment?: StoredSegment; category: string; amountCents: number; description: string;
  notes?: string; clientRef: string;
}
export interface ExpenseQuery {
  from?: string; to?: string; book?: 'shop' | 'telecom'; segment?: StoredSegment; category?: string; status?: PostedStatus;
  limit?: number; offset?: number;
}
export interface ExpenseList { items: Expense[]; total: number; totals: { amountCents: number } }
export interface ExpenseOne { item: Expense }
export interface ExpenseCreated { item: Expense; warnings: CashWarning[] }

// ---- Cash books ----

export interface CashBookSummary {
  book: CashBook; balanceCents: number; lastClosedDate: string | null; funds?: Record<IceFund, number>;
  /** Telecom only: the eight segments (and "Telecom before segments" only when it has entries); `balanceCents` is their sum. */
  segments?: SegmentSummary[];
}
export interface CashBookList { books: CashBookSummary[]; warnings: CashWarning[] }

/** One ledger row with the running balance after it. `segment` is set on Telecom rows (13D). */
export interface LedgerItem {
  id: number; businessDate: string; postedAt: string; type: string; amountCents: number; runningBalanceCents: number;
  fund: IceFund | null; segment: StoredSegment | null; refTable: string | null; refId: number | null; reversesEntryId: number | null;
  note: string | null;
}
export interface FundPeriod { openingCents: number; inCents: number; outCents: number; closingCents: number }
/** `segment` is the Telecom segment shown, or null for Shop, Ice Cream and the read-only whole-Telecom total ledger. */
export interface CashBookLedger {
  book: CashBook; segment: StoredSegment | null; from: string | null; to: string | null; openingCents: number; inCents: number;
  outCents: number; closingCents: number; items: LedgerItem[]; total: number; closedDates: string[]; funds?: Record<IceFund, FundPeriod>;
}
export interface LedgerQuery { segment?: StoredSegment; from?: string; to?: string; limit?: number; offset?: number }

// ---- Opening balances ----

export interface CapitalEntry {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: CashBook; fund: IceFund | null; segment: StoredSegment | null;
  kind: 'opening_balance' | 'capital'; amountCents: number; note: string; status: PostedStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}
export interface CapitalEntryList { items: CapitalEntry[] }
/** One opening balance per scope: Telecom names its `segment` (required), Ice Cream its `fund`. */
export interface OpeningBalanceCreate { businessDate: string; amountCents: number; fund?: IceFund; segment?: StoredSegment; note?: string; clientRef: string }
export interface CapitalEntryResult { item: CapitalEntry; warnings: CashWarning[] }

// ---- Cash counts ----

export interface CashCount {
  id: number; book: CashBook; fund: IceFund | null; segment: StoredSegment | null; businessDate: string; postedAt: string;
  backdated: boolean; expectedCents: number; countedCents: number; differenceCents: number; note: string; status: PostedStatus;
  voidedAt: string | null; voidReason: string | null; cashEntryId: number | null; clientRef: string;
}
/** A Telecom count counts ONE segment's drawer: `segment` is required for Telecom. */
export interface CashCountCreate { businessDate: string; book: CashBook; segment?: StoredSegment; countedCents: number; fund?: IceFund; note?: string; clientRef: string }
export interface CashCountResult { item: CashCount; warnings: CashWarning[] }
export interface ExpectedCash { expectedCents: number }

// ---- Daily closings ----

export interface DailyClosing {
  id: number; book: CashBook; segment: StoredSegment | null; businessDate: string; postedAt: string; closedAt: string;
  reopenedAt: string | null; reopenReason: string | null; expectedCents: number; countedCents: number | null; overShortCents: number;
  cashCountId: number | null; isClosed: boolean;
}
export interface DailyClosingList { items: DailyClosing[] }
/** A Telecom closing is per segment: `segment` is required for Telecom (a day closed for one segment stays open for the others). */
export interface DailyClosingCreate {
  book: CashBook; segment?: StoredSegment; businessDate: string; countedCents?: number; fund?: IceFund; note?: string; clientRef: string;
}
export interface DailyClosingResult { item: DailyClosing; count: CashCount | null; warnings: CashWarning[] }
export interface DailyClosingOne { item: DailyClosing }
