import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { isIsoDate, todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { FUTURE_DATE_MESSAGE } from './purchases.service.ts';

// Helpers shared by the Phase 4 write services (stocktakes, stock losses, goods drawings).

export type Fields = Record<string, string>;

export function validationError(fields: Fields): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
}

export function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`);
}

export function futureDateError(): AppError {
  return new AppError(400, 'FUTURE_DATE_NOT_ALLOWED', FUTURE_DATE_MESSAGE, { businessDate: FUTURE_DATE_MESSAGE });
}

/** Real-calendar-date check (400 VALIDATION_ERROR) then R-FD (400 FUTURE_DATE_NOT_ALLOWED). */
export function checkBusinessDate(date: string): void {
  if (!isIsoDate(date)) throw validationError({ businessDate: 'Enter a valid date (YYYY-MM-DD).' });
  if (date > todayBusinessDate()) throw futureDateError();
}

/** `backdated` = business date earlier than the Colombo date of the posting time. */
export function isBackdated(businessDate: string, postedAt: string): boolean {
  return businessDate < todayBusinessDate(new Date(postedAt));
}

/** Trims and length-checks a text field, recording the problem in `fields`. */
export function trimmed(fields: Fields, key: string, label: string, value: string | undefined, min: number, max: number): string {
  const v = (value ?? '').trim();
  if (v.length < min) fields[key] = `${label} is required.`;
  else if (v.length > max) fields[key] = `${label} must be at most ${max} characters.`;
  return v;
}

/** Safety net: maps database trigger / constraint aborts and arithmetic overflow to the contract's envelopes. */
function mapDbAbort(err: unknown): never {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('FUTURE_DATE_NOT_ALLOWED')) throw futureDateError();
  if (msg.includes('PRODUCT_NOT_IN_BOOK')) {
    throw new AppError(400, 'PRODUCT_NOT_IN_BOOK', 'A product does not belong to this stocktake\'s book.');
  }
  if (msg.includes('STOCKTAKE_NOT_DRAFT') || msg.includes('STOCKTAKE_TRANSITION')) {
    throw new AppError(409, 'NOT_DRAFT', 'Only a draft stocktake can be changed or completed.');
  }
  if (msg.includes('STOCK_VALUE_WITHOUT_QTY') || /CHECK constraint failed: .*(qty_on_hand|stock_value_cents)/.test(msg)) {
    throw new AppError(422, 'INSUFFICIENT_STOCK', 'Not enough stock for this operation.');
  }
  if (err instanceof RangeError) throw validationError({ body: 'An amount or quantity is too large.' });
  throw err;
}

/** One database transaction; AppErrors pass through, DB aborts are mapped. */
export function runWrite<T>(ctx: AppContext, fn: (conn: DatabaseSync) => T): T {
  try {
    return ctx.database.tx(fn);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return mapDbAbort(err);
  }
}
