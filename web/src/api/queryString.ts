/**
 * Query-string helper shared by every API module (catalog, purchases, stock).
 *
 * It used to be copy-pasted into three files; one shared copy keeps the filtering rules identical everywhere.
 */

/**
 * Turns a plain object of filters into a URL query string such as "?q=case&active=true".
 *
 * - undefined, null and empty-string values are skipped, so an untouched filter box never reaches the server.
 * - Booleans and numbers become "true"/"false" and digits via String().
 * - Returns "" (nothing at all) when no filter is set, so the caller can always append it to a path.
 */
export function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
