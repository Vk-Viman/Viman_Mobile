/**
 * Helpers for the Settings forms (General, Rates, Printing).
 * `errorMessage` now lives in lib/errors.ts with the other error helpers; it is re-exported here so the Settings
 * tabs keep one import for their form helpers.
 */
import { ApiError } from '../../api/client';

export { errorMessage } from '../../lib/errors';

/**
 * Picks the server's field errors that belong to one settings section and strips the section name.
 * The server reports nested fields with dotted paths ("shop.name"); the form wants just "name".
 * @param err    the mutation error (anything that is not an ApiError yields no field errors).
 * @param prefix section name, e.g. "shop", "rates".
 */
export function serverFields(err: unknown, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError)) return out;
  const p = prefix + '.';
  for (const [k, v] of Object.entries(err.fields)) {
    if (k.startsWith(p)) out[k.slice(p.length)] = v;
  }
  return out;
}
