/**
 * services/expenses.service.ts - Shop and Telecom operating expenses (Phase 8).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 1, 2, 7, 12):
 *  - Sec 7  expenses belong to the SHOP or TELECOM book only; Ice Cream costs use the ice-cream records
 *           (`USE_ICECREAM_PAYMENTS`). The categories are Water, Rent, Internet, Transport, Repairs, Cleaning
 *           supplies, Packaging, Stationery and Other.
 *  - E1-E4  there is NO electricity category: the whole shop's electricity is paid from the Ice Cream book, and the
 *           bill is a settlement, never an expense. `ELECTRICITY_NOT_ALLOWED` is returned for any spelling of
 *           "electricity"; the database CHECK in migration 012 repeats the rule (E2).
 *  - Sec 2  an expense is cash OUT of its own book (type `expense`); P&L = that segment's operating expense.
 *  - R13    a cash-out that leaves the book negative returns the shared warning, never a block.
 *  - R9     a closed day of the expense's book refuses create and void (`assertDayOpen`).
 *  - R-FD, Sec 12  no future dates; idempotent by `clientRef`; every write is audited with its business date and
 *           `backdated` flag; business row + cash entry + audit row are ONE transaction.
 *  - R1     a void adds a reversing cash entry (same type, negated, `reverses_entry_id`) and marks the expense
 *           `void`; nothing is edited or deleted.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { findCashEntriesByRef, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import {
  getExpense as getExpenseRow, getExpenseByClientRef, insertExpense, listExpenses as listExpenseRows, markExpenseVoid,
} from '../repositories/expenses.repo.ts';
import type { ExpenseBook, ExpenseRow, RecordStatus } from '../repositories/expenses.repo.ts';
import { logAudit } from './audit.service.ts';
import { negativeCashWarnings } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday,
  notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** Longest expense description. */
export const DESCRIPTION_MAX_LENGTH = 200;

/** The nine allowed categories with their display labels (section 7). Electricity is deliberately absent (E2). */
export const EXPENSE_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'water', label: 'Water' },
  { value: 'rent', label: 'Rent' },
  { value: 'internet', label: 'Internet' },
  { value: 'transport', label: 'Transport' },
  { value: 'repairs', label: 'Repairs' },
  { value: 'cleaning_supplies', label: 'Cleaning supplies' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'stationery', label: 'Stationery' },
  { value: 'other', label: 'Other' },
];

/** The exact owner-approved wording of the electricity refusal (E2). */
export const ELECTRICITY_MESSAGE = 'Electricity is paid from the Ice Cream book.';

/** An expense as returned by the API (adds the `backdated` flag). */
export interface Expense {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: ExpenseBook; category: string;
  amountCents: number; description: string; notes: string; status: RecordStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}

function toExpense(r: ExpenseRow): Expense {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    book: r.book, category: r.category, amountCents: r.amountCents, description: r.description, notes: r.notes,
    status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadExpense(conn: DatabaseSync, id: number): Expense {
  const r = getExpenseRow(conn, id);
  if (!r) throw notFound('Expense');
  return toExpense(r);
}

/** The category list for the add-expense form. */
export function listExpenseCategories(): { items: Array<{ value: string; label: string }> } {
  return { items: EXPENSE_CATEGORIES.map((c) => ({ ...c })) };
}

/** One expense by id. @throws AppError 404 NOT_FOUND. */
export function getExpense(ctx: AppContext, id: number): Expense {
  return loadExpense(ctx.database.conn, id);
}

/** Lists expenses, newest first; `totals.amountCents` sums only POSTED expenses that match the filters. */
export function listExpenses(ctx: AppContext, q: {
  from?: string; to?: string; book?: ExpenseBook; category?: string; status?: RecordStatus; limit: number; offset: number;
}): { items: Expense[]; total: number; totals: { amountCents: number } } {
  const r = listExpenseRows(ctx.database.conn, q);
  return { items: r.items.map(toExpense), total: r.total, totals: { amountCents: r.amountCents } };
}

/** Request body of an expense (`book` may also be 'icecream' only so the service can refuse it with advice). */
export interface ExpenseCreate {
  businessDate: string; book: ExpenseBook | 'icecream'; category: string; amountCents: number; description: string;
  notes?: string; clientRef: string;
}

/**
 * Checks the book and category rules that need no database (E2, section 7). Electricity is recognised in any
 * spelling or case ("Electricity", " ELECTRICITY ").
 *
 * @throws AppError 400 USE_ICECREAM_PAYMENTS, 400 ELECTRICITY_NOT_ALLOWED, 400 VALIDATION_ERROR (unknown category).
 */
function checkBookAndCategory(body: ExpenseCreate): void {
  if (body.book === 'icecream') {
    throw new AppError(400, 'USE_ICECREAM_PAYMENTS',
      'Ice Cream costs are not recorded as expenses. Use the Ice Cream payments instead.',
      { book: 'Expenses are for the Shop and Telecom books only.' });
  }
  if (body.category.trim().toLowerCase() === 'electricity') {
    throw new AppError(400, 'ELECTRICITY_NOT_ALLOWED', ELECTRICITY_MESSAGE, { category: ELECTRICITY_MESSAGE });
  }
  if (!EXPENSE_CATEGORIES.some((c) => c.value === body.category)) {
    throw validationError({ category: 'Choose one of the listed categories.' });
  }
}

/**
 * Records an expense: -amount from its book (`expense`), audited, in one transaction. Idempotent by `clientRef`: a
 * repeat returns the saved expense with `created: false` and no warnings.
 *
 * Validation order: fields -> book/category (E2) -> R-FD -> clientRef repeat -> DAY_CLOSED (R9).
 *
 * @throws AppError 400 VALIDATION_ERROR / ELECTRICITY_NOT_ALLOWED / USE_ICECREAM_PAYMENTS / FUTURE_DATE_NOT_ALLOWED,
 *   409 DAY_CLOSED.
 */
export function createExpense(ctx: AppContext, body: ExpenseCreate): { item: Expense; warnings: CashWarning[]; created: boolean } {
  const fields: Fields = {};
  const description = trimmed(fields, 'description', 'Description', body.description, 1, DESCRIPTION_MAX_LENGTH);
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBookAndCategory(body);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD
  const book = body.book as ExpenseBook;

  return runWrite(ctx, (conn) => {
    const existing = getExpenseByClientRef(conn, body.clientRef);
    if (existing) return { item: toExpense(existing), warnings: [], created: false };

    assertDayOpen(conn, [book], body.businessDate); // R9
    const id = insertExpense(conn, {
      businessDate: body.businessDate, book, category: body.category, amountCents: body.amountCents, description, notes,
      clientRef: body.clientRef,
    });
    insertCashEntry(conn, {
      book, businessDate: body.businessDate, type: 'expense', amountCents: -body.amountCents, refTable: 'expenses', refId: id,
    });
    const item = loadExpense(conn, id);
    logAudit(conn, 'expense', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    return { item, warnings: negativeCashWarnings(conn, [book]), created: true }; // R13: warn, never block
  });
}

/**
 * Voids an expense (R1): the cash-out is cancelled by a reversing entry that keeps the expense's business date, and
 * the expense is marked `void` (it leaves the totals, which count posted rows only).
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID.
 */
export function voidExpense(ctx: AppContext, id: number, body: { reason: string }): Expense {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getExpenseRow(conn, id);
    if (!row) throw notFound('Expense');
    assertDayOpen(conn, [row.book], row.businessDate); // R9: judged on the expense's own date (the reversal copies it)
    if (row.status === 'void') throw alreadyVoid('expense');
    const before = toExpense(row);

    const original = findCashEntriesByRef(conn, 'expenses', id).find((e) => e.type === 'expense' && e.reversesEntryId === null);
    if (!original) throw new Error(`Expense #${id} has no cash entry to reverse`);
    insertCashEntry(conn, {
      book: row.book, businessDate: row.businessDate, type: 'expense', amountCents: -original.amountCents,
      refTable: 'expenses', refId: id, reversesEntryId: original.id, note: `Void of expense #${id}`,
    });
    markExpenseVoid(conn, id, reason);
    const after = loadExpense(conn, id);
    logAudit(conn, 'expense', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
