/**
 * lib/dates.ts - business dates and timestamps.
 *
 * Layer: shared library. Two different kinds of date exist in this system (BUSINESS_RULES section 12):
 *  - the BUSINESS DATE (`YYYY-MM-DD`, Asia/Colombo) that the owner picks and that drives all reports;
 *  - the POSTING TIMESTAMP (ISO-8601 UTC) that the server sets when a record is saved.
 * The helpers here convert between "now" and the Colombo calendar date so the "no future dates" rule (R-FD)
 * and the "backdated" flag are judged on the shop's own clock, not on the PC's or UTC's.
 */

/** The shop's time zone. Colombo is UTC+5:30 all year (no daylight saving), matching the SQL triggers. */
export const BUSINESS_TZ = 'Asia/Colombo';

// One formatter is built once and reused: constructing Intl.DateTimeFormat is comparatively slow.
// `hourCycle: 'h23'` avoids the "24:00" midnight quirk that `hour12: false` can produce.
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Splits an instant into its Colombo calendar parts: `{ year, month, day, hour, minute, second }` (strings). */
function partsOf(now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(now)) out[p.type] = p.value;
  return out;
}

/**
 * Today's date in Colombo as `YYYY-MM-DD`.
 *
 * R-FD: a business date later than this value is a future date and must be rejected.
 *
 * @param now The instant to convert (defaults to the current time; tests pass a fixed one).
 */
export function todayBusinessDate(now: Date = new Date()): string {
  const p = partsOf(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * True when `s` is written `YYYY-MM-DD` AND is a real calendar day (so 2026-02-30 and 2026-13-01 are rejected).
 *
 * @param s Text to check.
 */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear avoids that.
  dt.setUTCFullYear(y);
  // JavaScript silently rolls an impossible day over (31 Feb -> 3 Mar), so compare the parts back.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** The current instant as an ISO-8601 UTC string (the format of every posting timestamp). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Colombo date and time as `YYYYMMDD-HHmmss`, used inside backup file names
 * (e.g. `viman-20261111-093000-manual.db`) so they sort oldest-to-newest alphabetically.
 */
export function backupStamp(now: Date = new Date()): string {
  const p = partsOf(now);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
