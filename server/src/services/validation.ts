/**
 * services/validation.ts - input-checking and error-building helpers shared by every service.
 *
 * Layer: service (route -> SERVICE -> repository -> database). These small functions used to be copied into
 * `catalog.service.ts`, `purchases.service.ts` and `stock-common.ts`; they now live here once so every
 * service produces the same error shapes and the same messages (API_CONTRACTS.md "Errors").
 *
 * Business rules implemented here:
 *  - R-FD  no future-dated transactions (`checkBusinessDate`, `futureDateError`, `FUTURE_DATE_MESSAGE`);
 *  - R-RD  the "return before original" message builder lives with the purchase service (it names the document).
 */
import { isIsoDate, todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';

/** Field-name -> message map used for form errors (`error.fields` in the API). */
export type Fields = Record<string, string>;

/** R-FD: the exact owner-approved wording shown when a business date is later than today in Colombo. */
export const FUTURE_DATE_MESSAGE = 'Future-dated transactions are not allowed. Please select today or an earlier date.';

/** Longest allowed free-text note on any record (purchase notes, stock-loss note, stocktake notes ...). */
export const NOTE_MAX_LENGTH = 500;
/** Longest allowed void reason. */
export const REASON_MAX_LENGTH = 200;

/**
 * 400 VALIDATION_ERROR carrying the per-field messages.
 * @param fields Field name (e.g. `items.0.productId`) -> message.
 */
export function validationError(fields: Fields): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
}

/** Throws `validationError(fields)` when at least one problem was collected; does nothing otherwise. */
export function assertNoFieldErrors(fields: Fields): void {
  if (Object.keys(fields).length > 0) throw validationError(fields);
}

/** 404 NOT_FOUND, e.g. `notFound('Purchase')` -> "Purchase not found." */
export function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`);
}

/** 409 ALREADY_VOID, e.g. `alreadyVoid('purchase')` -> "This purchase is already void." (R1: a void is final). */
export function alreadyVoid(noun: string): AppError {
  return new AppError(409, 'ALREADY_VOID', `This ${noun} is already void.`);
}

/** R-FD: 400 FUTURE_DATE_NOT_ALLOWED (the same text is also attached to the `businessDate` field). */
export function futureDateError(): AppError {
  return new AppError(400, 'FUTURE_DATE_NOT_ALLOWED', FUTURE_DATE_MESSAGE, { businessDate: FUTURE_DATE_MESSAGE });
}

/**
 * Checks a business date in two steps: it must be a real calendar day (400 VALIDATION_ERROR), then it must not
 * be later than today in Colombo (R-FD, 400 FUTURE_DATE_NOT_ALLOWED). Backdated dates are allowed (audited).
 * The database triggers repeat the future-date check as a backstop.
 */
export function checkBusinessDate(date: string): void {
  if (!isIsoDate(date)) throw validationError({ businessDate: 'Enter a valid date (YYYY-MM-DD).' });
  if (date > todayBusinessDate()) throw futureDateError();
}

/**
 * `backdated` = the business date is earlier than the Colombo date of the moment the record was posted
 * (BUSINESS_RULES section 12). Backdated entries are flagged in the audit log and listed in a report.
 *
 * @param businessDate The date the owner chose.
 * @param postedAt     The server posting timestamp (ISO UTC).
 */
export function isBackdated(businessDate: string, postedAt: string): boolean {
  return businessDate < todayBusinessDate(new Date(postedAt));
}

/** Like `isBackdated`, judged against "now" - used for a void, whose posting time is the moment of the void. */
export function isBackdatedToday(businessDate: string): boolean {
  return businessDate < todayBusinessDate();
}

/**
 * Trims a text field and checks its length. A problem is recorded in `fields[key]` (the caller throws once
 * all fields were checked) and the trimmed text is returned either way.
 *
 * @param min 0 for an optional field, 1 for a required one (an empty required field reads "<label> is required.").
 * @param max Maximum length after trimming.
 */
export function trimmed(
  fields: Fields, key: string, label: string, value: string | undefined, min: number, max: number,
): string {
  const v = (value ?? '').trim();
  if (v.length < min) fields[key] = `${label} is required.`;
  else if (v.length > max) fields[key] = `${label} must be at most ${max} characters.`;
  return v;
}
