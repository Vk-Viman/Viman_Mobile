/**
 * Display formatting helpers (money, date-time, file size).
 *
 * These only turn values that the server already calculated into text. They never compute business figures:
 * the server is authoritative for every amount (ARCHITECTURE.md, BUSINESS_RULES.md section 0).
 */

/** Thousands-separator formatter ("12,345"). Whole numbers only; cents are handled separately below. */
const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Formats integer cents as Sri Lankan rupees: 1234550 -> "Rs. 12,345.50"; -123450 -> "-Rs. 1,234.50".
 *
 * Money is stored and sent as INTEGER CENTS (no decimals) because floating-point numbers cannot represent
 * values like 0.10 exactly and errors would creep into totals. So the split into rupees and cents here uses
 * integer division and remainder only, never `cents / 100` as a decimal.
 */
export function formatLKR(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rupees = Math.trunc(abs / 100);
  const c = abs % 100;
  return `${neg ? '-' : ''}Rs. ${group.format(rupees)}.${String(c).padStart(2, '0')}`;
}

/**
 * Date-time formatter fixed to Asia/Colombo (the shop's business time zone, UTC+5:30), 24-hour clock.
 * Timestamps arrive from the server as UTC ISO-8601; showing them in shop time keeps what the owner sees
 * consistent regardless of the PC's own time-zone setting.
 */
const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Colombo',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Formats a server ISO timestamp for display in shop time, e.g. "10 Nov 2026, 14:05:09".
 * Returns an em dash for empty values and the original text if it is not a valid date (never throws).
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dtf.format(d);
}

/** Formats a byte count as a short human size: 512 -> "512 B", 1536 -> "1.5 KB", 5_242_880 -> "5.0 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
