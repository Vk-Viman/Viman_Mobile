/**
 * lib/errors.ts - the one error type the whole server uses to say "this request cannot be done".
 *
 * Layer: shared library (used by routes, services and the app error handler).
 *
 * Services throw an `AppError`; `app.ts` turns it into the JSON error body documented in
 * API_CONTRACTS.md: `{ error: { code, message, fields?, ...extra } }`. Anything that is NOT an
 * `AppError` is treated as a bug and answered with a generic 500 so internals never leak to the screen.
 */

/**
 * A problem the user can understand and fix (validation failure, not found, business-rule refusal...).
 *
 * - `statusCode` the HTTP status (400 bad input, 404 missing, 409 conflict, 422 business rule refused).
 * - `code`       a stable machine-readable code such as `FUTURE_DATE_NOT_ALLOWED` (R-FD) or
 *                `INSUFFICIENT_STOCK`; the web app switches on this, so codes must never change.
 * - `message`    plain-English text that is safe to show to the shop owner.
 * - `fields`     optional map of form-field name -> message, so the screen can mark the wrong inputs.
 * - `extra`      optional extra top-level keys of the error body.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  /** Extra top-level keys of the error body (e.g. `originalDate`, `onHand`). Never overrides code/message/fields. */
  readonly extra?: Record<string, unknown>;

  constructor(
    statusCode: number, code: string, message: string, fields?: Record<string, string>,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    // Only set the optional properties when given, so JSON output never contains `fields: undefined`.
    if (fields !== undefined) this.fields = fields;
    if (extra !== undefined) this.extra = extra;
  }
}

/**
 * Builds a plain `Error` that carries a machine-readable `code` property.
 *
 * Used by the database layer (`DB_CLOSED`, `MIGRATION_DB_TOO_NEW`, `MIGRATION_CHECKSUM_MISMATCH`) where there
 * is no HTTP request to answer; `index.ts` reads the code to print a friendly start-up message.
 *
 * @param message Human-readable description.
 * @param code    Stable code that callers can test with `err.code === '...'`.
 */
export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
