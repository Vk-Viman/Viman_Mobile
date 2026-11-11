/**
 * Helpers that turn API errors into text for forms.
 *
 * Every API failure arrives as an `ApiError` (api/client.ts) carrying a general message plus optional per-field
 * messages from the server's validation. Forms show field messages under the matching input and everything else
 * in one banner; these helpers do that sorting in one shared place instead of in each dialog.
 */
import { ApiError } from '../api/client';

/**
 * Banner text for an error: the general message plus any field messages that differ from it.
 * @param err        whatever a mutation reported (ApiError, Error, null/undefined for "no error").
 * @param skipFields field names already shown under their own inputs, so they are not repeated in the banner.
 * @returns the text, or null when there is no error.
 */
export function errorBanner(err: unknown, skipFields: string[] = []): string | null {
  if (!err) return null;
  if (err instanceof ApiError) {
    const extra = Object.entries(err.fields)
      .filter(([k, m]) => m !== err.message && !skipFields.includes(k))
      .map(([, m]) => m);
    return [err.message, ...extra].join(' ');
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** The server's validation message for one field (e.g. "businessDate"), or undefined when there is none. */
export function fieldError(err: unknown, name: string): string | undefined {
  return err instanceof ApiError ? err.fields[name] : undefined;
}

/** Plain message of any thrown value, with a generic fallback; for toasts. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}
