/**
 * routes/catalog-query.ts - request-parsing helpers shared by ALL route files (despite the file name).
 *
 * Layer: route (the thin top layer: JSON-schema validation -> call a service -> shape the response).
 *
 * Type coercion is switched off app-wide (`app.ts`), so a JSON body can never turn null or "6" into a number.
 * The consequence is that numeric query parameters arrive as digit STRINGS; the schemas below check their
 * shape and the helpers convert and range-check them. Collecting these here means every list endpoint
 * validates ids, dates, client references and paging in exactly the same way.
 */
import { isIsoDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';

// ---------- reusable JSON-schema pieces ----------

/** Path parameter `:id` - 1 to 9 digits (so it always fits a safe integer). */
export const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9]{1,9}$' } },
} as const;

/** A numeric query parameter (arrives as a digit string). */
export const intQuery = { type: 'string', pattern: '^[0-9]{1,9}$' } as const;
/** A true/false query parameter (arrives as the text "true" / "false"). */
export const boolQuery = { type: 'string', enum: ['true', 'false'] } as const;
/** The two stock-holding books. */
export const bookQuery = { type: 'string', enum: ['shop', 'telecom'] } as const;

/** Shape of a date: `YYYY-MM-DD`. Whether it is a REAL calendar day is checked separately (`isIsoDate`). */
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
/** A date in a query string (`from`, `to`, `asOf`). */
export const dateQuery = { type: 'string', pattern: DATE_PATTERN } as const;
/** A business date in a request body. */
export const dateField = { type: 'string', pattern: DATE_PATTERN } as const;

/**
 * `clientRef`: a unique reference the browser generates per form submission (8-64 letters, digits, `_`, `-`).
 * Sending the same reference twice returns the already-saved record instead of creating a duplicate
 * (BUSINESS_RULES section 12 - protects against double clicks and retries).
 */
export const CLIENT_REF_PATTERN = '^[A-Za-z0-9_-]{8,64}$';
export const clientRef = { type: 'string', pattern: CLIENT_REF_PATTERN } as const;

/** Body of every "void" request: just the reason (trimmed and length-checked by the service). */
export const voidBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

// ---------- parsing helpers ----------

/** Reads the numeric `:id` path parameter (the schema already guaranteed it is digits). */
export function parseId(params: unknown): number {
  return Number((params as { id: string }).id);
}

/** Converts an optional "true"/"false" query value to a boolean (undefined stays undefined). */
export function parseBool(v: string | undefined): boolean | undefined {
  return v === undefined ? undefined : v === 'true';
}

/** Throws 400 VALIDATION_ERROR with the given per-field messages. */
export function fail(fields: Record<string, string>): never {
  throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
}

/**
 * Digit-pattern dates must also be real calendar dates (400 VALIDATION_ERROR). Report/query dates are never
 * rejected for being in the future (R-FD applies to transactions only), so only the calendar check is made.
 */
export function checkQueryDates(raw: { from?: string; to?: string }): void {
  const bad: Record<string, string> = {};
  if (raw.from !== undefined && !isIsoDate(raw.from)) bad.from = 'must be a valid date (YYYY-MM-DD)';
  if (raw.to !== undefined && !isIsoDate(raw.to)) bad.to = 'must be a valid date (YYYY-MM-DD)';
  if (Object.keys(bad).length > 0) fail(bad);
}

/**
 * Reads and range-checks `limit` / `offset` from a list request.
 *
 * @param defaultLimit Page size when `limit` is not given.
 * @param maxLimit     Largest allowed page size.
 * @throws AppError 400 VALIDATION_ERROR when `limit` is outside 1..maxLimit.
 */
export function parsePaging(
  raw: { limit?: string; offset?: string }, defaultLimit: number, maxLimit: number,
): { limit: number; offset: number } {
  const limit = raw.limit === undefined ? defaultLimit : Number(raw.limit);
  const offset = raw.offset === undefined ? 0 : Number(raw.offset);
  if (limit < 1 || limit > maxLimit) fail({ limit: `must be between 1 and ${maxLimit}` });
  return { limit, offset };
}
