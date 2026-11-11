/**
 * services/cashbooks.service.ts - read side of the three cash books: balances, ledger with running balance, Ice Cream
 * fund balances and the integrity checks (Phase 8).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 0, 8, 10.1, R13):
 *  - Sec 8    closing = opening + in - out, where opening is the ledger balance with business date BEFORE the period, in/out
 *             sum the positive/negative rows of the period and the balance is simply the sum of every ledger row. The
 *             ledger is ordered by business date, then id; each row carries the running balance after it, carried
 *             correctly across pages (it is computed over the whole period, then paged).
 *  - Sec 10.1 Cost + Electricity + Profit = the Ice Cream cash book balance (invariant). `reconcileIceCream` checks it and
 *             the summary warns if it ever fails; a fund balance is shown beside the book, never mixed into profit.
 *  - R13      a negative book (or fund) is a warning on the summary, never an error.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { formatLKR } from '../lib/money.ts';
import { cashBalance } from '../repositories/cash-entries.repo.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import { ledgerPage, periodTotals } from '../repositories/cashbook-ledger.repo.ts';
import type { LedgerRow } from '../repositories/cashbook-ledger.repo.ts';
import { closedDates, lastClosedDate } from '../repositories/daily-closings.repo.ts';
import { fundBalances, fundPeriodTotals, fundTotal } from '../repositories/icecream-funds.repo.ts';
import { negativeBalanceWarning, negativeFundWarning } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { BOOKS } from './day-closing.ts';
import { validationError } from './validation.ts';

/** Result of the Ice Cream invariant check (section 10.1). */
export interface IceCreamReconciliation {
  /** Sum of every Ice Cream cash entry. */
  cashBookCents: number;
  /** Sum of every fund ledger row (all three funds). */
  fundsCents: number;
  /** cashBookCents - fundsCents; zero when the books agree. */
  differenceCents: number;
  /** Balance of each fund. */
  byFund: Record<IceFund, number>;
  /** True when Cost + Electricity + Profit equals the cash book. */
  ok: boolean;
}

/**
 * Checks BUSINESS_RULES 10.1: the sum of the three fund balances must equal the Ice Cream cash book balance. A move
 * between funds nets to zero, so only a cash entry written without its fund row (or the reverse) can break it.
 */
export function reconcileIceCream(conn: DatabaseSync): IceCreamReconciliation {
  const cashBookCents = cashBalance(conn, 'icecream');
  const fundsCents = fundTotal(conn);
  return {
    cashBookCents, fundsCents, differenceCents: cashBookCents - fundsCents, byFund: fundBalances(conn),
    ok: cashBookCents === fundsCents,
  };
}

/** One book on the summary screen. */
export interface CashBookSummary {
  book: CashBook; balanceCents: number; funds?: Record<IceFund, number>; lastClosedDate: string | null;
}

/**
 * All three books: all-time balance, the Ice Cream fund balances and the newest closed date, plus the warnings: a
 * negative book or fund (R13) and, if it ever happens, funds that do not add up to the Ice Cream book.
 */
export function listCashBooks(ctx: AppContext): { books: CashBookSummary[]; warnings: CashWarning[] } {
  const conn = ctx.database.conn;
  const warnings: CashWarning[] = [];
  const books = BOOKS.map((book): CashBookSummary => {
    const balanceCents = cashBalance(conn, book);
    if (balanceCents < 0) warnings.push(negativeBalanceWarning(book, balanceCents));
    const summary: CashBookSummary = { book, balanceCents, lastClosedDate: lastClosedDate(conn, book) };
    if (book === 'icecream') {
      const funds = fundBalances(conn);
      summary.funds = funds;
      for (const fund of ['cost', 'electricity', 'profit'] as const) {
        if (funds[fund] < 0) warnings.push(negativeFundWarning(fund, funds[fund]));
      }
    }
    return summary;
  });
  const rec = reconcileIceCream(conn);
  if (!rec.ok) {
    warnings.push({
      code: 'ICECREAM_FUNDS_MISMATCH', book: 'icecream', balanceCents: rec.differenceCents,
      message: `The Ice Cream funds (${formatLKR(rec.fundsCents)}) do not add up to the Ice Cream cash book (${formatLKR(rec.cashBookCents)}). Please contact support.`,
    });
  }
  return { books, warnings };
}

/** One ledger row as returned by the API. */
export type CashLedgerItem = Pick<LedgerRow, 'id' | 'businessDate' | 'postedAt' | 'type' | 'amountCents' | 'runningBalanceCents'
  | 'fund' | 'refTable' | 'refId' | 'reversesEntryId' | 'note'>;

/** The ledger of one book for a period. */
export interface CashBookLedger {
  book: CashBook; from: string | null; to: string | null; openingCents: number; inCents: number; outCents: number;
  closingCents: number; items: CashLedgerItem[]; total: number; closedDates: string[];
  /** Ice Cream only: per-fund opening / in / out / closing for the period. */
  funds?: Record<IceFund, { openingCents: number; inCents: number; outCents: number; closingCents: number }>;
}

/**
 * The ledger of one book for a period with running balances (section 8). `from`/`to` are business dates (either may be
 * omitted: no `from` = from the beginning, so opening is 0; no `to` = up to the latest entry).
 *
 * @throws AppError 400 VALIDATION_ERROR when `from` is after `to`.
 */
export function getCashBookLedger(ctx: AppContext, book: CashBook, q: {
  from?: string; to?: string; limit: number; offset: number;
}): CashBookLedger {
  if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
    throw validationError({ to: 'The end date cannot be before the start date.' });
  }
  const conn = ctx.database.conn;
  const totals = periodTotals(conn, book, q.from, q.to);
  const rows = ledgerPage(conn, book, q.from, q.to, totals.openingCents, q.limit, q.offset);
  const out: CashBookLedger = {
    book, from: q.from ?? null, to: q.to ?? null, openingCents: totals.openingCents, inCents: totals.inCents,
    outCents: totals.outCents, closingCents: totals.closingCents,
    items: rows.map((r) => ({
      id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, type: r.type, amountCents: r.amountCents,
      runningBalanceCents: r.runningBalanceCents, fund: r.fund, refTable: r.refTable, refId: r.refId,
      reversesEntryId: r.reversesEntryId, note: r.note,
    })),
    total: totals.count, closedDates: closedDates(conn, book, q.from, q.to),
  };
  if (book === 'icecream') out.funds = fundPeriodTotals(conn, q.from, q.to);
  return out;
}
