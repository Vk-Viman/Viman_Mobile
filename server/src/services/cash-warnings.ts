/**
 * services/cash-warnings.ts - the one shared "cash book went below zero" warning (R13).
 *
 * Layer: service helper used by EVERY cash-out write (purchases, sales returns/refunds, expenses, printing supplies,
 * provider and wallet top-ups, cash over/short, voids of cash-in records). BUSINESS_RULES R13 / section 4: a negative
 * cash book is a WARNING, never a block - the owner may simply not have entered the opening balance yet. Section 10.2:
 * an Ice Cream fund may also go negative with a clear warning. Before Phase 8 only printing supplies warned, with a
 * plain string; now all writes return the same object shape so the web shows one toast for all of them.
 * (`PRICE_BELOW_COST` and the sale-line warnings keep their own shapes.)
 */
import type { DatabaseSync } from 'node:sqlite';
import { formatLKR } from '../lib/money.ts';
import { cashBalance } from '../repositories/cash-entries.repo.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import { fundBalances } from '../repositories/icecream-funds.repo.ts';
import { scopeLabel, scopesOf } from './segments.ts';
import type { CashScope, StoredSegment } from './segments.ts';

/** Owner-facing fund names. */
export const FUND_LABEL: Record<IceFund, string> = { cost: 'Cost', electricity: 'Electricity', profit: 'Profit' };

/**
 * One non-blocking cash warning. `balanceCents` is the (negative) balance of the book - or of the fund when `fund`
 * is set (`NEGATIVE_FUND_BALANCE`, Ice Cream only). `ICECREAM_FUNDS_MISMATCH` (cash book summary only) carries the
 * difference between the Ice Cream book and the sum of its funds.
 */
export interface CashWarning {
  code: 'NEGATIVE_CASH_BALANCE' | 'NEGATIVE_FUND_BALANCE' | 'ICECREAM_FUNDS_MISMATCH';
  message: string;
  book: CashBook;
  balanceCents: number;
  fund?: IceFund;
  /** Telecom only (13D): the segment whose balance is below zero (a negative warning is given per segment). */
  segment?: StoredSegment;
}

/**
 * The warning for one scope whose balance is `balanceCents` (< 0). A Telecom scope names its segment in the message
 * ("The Telecom - Dialog Reloads cash book ...") and carries `segment`.
 */
export function negativeBalanceWarning(scope: CashBook | CashScope, balanceCents: number): CashWarning {
  const s: CashScope = typeof scope === 'string' ? { book: scope, segment: null } : scope;
  return {
    code: 'NEGATIVE_CASH_BALANCE', book: s.book, ...(s.segment ? { segment: s.segment } : {}), balanceCents,
    message: `The ${scopeLabel(s)} cash book is now below zero (${formatLKR(balanceCents)}). Check that the opening balance and sales are recorded.`,
  };
}

/** The warning for one Ice Cream fund whose balance is `balanceCents` (< 0). */
export function negativeFundWarning(fund: IceFund, balanceCents: number): CashWarning {
  return {
    code: 'NEGATIVE_FUND_BALANCE', book: 'icecream', fund, balanceCents,
    message: `The Ice Cream ${FUND_LABEL[fund]} fund is now below zero (${formatLKR(balanceCents)}).`,
  };
}

/**
 * Warnings for the CURRENT state of the given books, to be called inside the write's transaction right after its
 * cash entry is saved: one `NEGATIVE_CASH_BALANCE` per book below zero and, when Ice Cream is among the books, one
 * `NEGATIVE_FUND_BALANCE` per fund below zero. Never throws and never blocks (R13).
 *
 * Telecom is judged PER SEGMENT (13D): the balance of each touched segment, never the Telecom total.
 *
 * @param scopes The scopes the write moved cash in (duplicates allowed); a bare 'telecom' is TELECOM_SEGMENT_REQUIRED.
 */
export function negativeCashWarnings(conn: DatabaseSync, scopes: Iterable<CashBook | CashScope>): CashWarning[] {
  const out: CashWarning[] = [];
  for (const scope of scopesOf(scopes)) {
    const balance = cashBalance(conn, scope.segment ? { book: scope.book, segment: scope.segment } : { book: scope.book });
    if (balance < 0) out.push(negativeBalanceWarning(scope, balance));
    if (scope.book === 'icecream') {
      const funds = fundBalances(conn);
      for (const fund of ['cost', 'electricity', 'profit'] as const) {
        if (funds[fund] < 0) out.push(negativeFundWarning(fund, funds[fund]));
      }
    }
  }
  return out;
}
