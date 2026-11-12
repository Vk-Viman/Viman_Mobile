/**
 * services/dashboard-dates.ts - small calendar helpers for the dashboard (business dates, Asia/Colombo, no clock reads).
 *
 * Layer: pure helpers (no database). Dates are `YYYY-MM-DD` business dates (BUSINESS_RULES R7); all arithmetic is done on
 * UTC midnights so daylight-saving or the server's time zone can never shift a day.
 */

const DAY_MS = 86_400_000;

function toMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function fromMs(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** `date` shifted by `days` calendar days (negative = earlier). */
export function addDays(date: string, days: number): string {
  return fromMs(toMs(date) + days * DAY_MS);
}

/** First day of the month that contains `date`. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** First day of the month `months` months before the month of `date` (0 = this month). */
export function monthStartMonthsBack(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number);
  const idx = y! * 12 + (m! - 1) - months;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}
