/**
 * Money: displays an amount of integer cents as rupees (see lib/format.ts formatLKR).
 * The single place that styles money, so every figure in the app looks the same.
 */
import { formatLKR } from '../lib/format';

/**
 * @param cents     Amount in integer cents exactly as the server sent it; this component never calculates.
 * @param className Extra classes (e.g. bold for totals).
 * Negative amounts are red so losses/shortfalls stand out; no-wrap keeps "Rs. 1,000.00" on one line, and
 * the `num` class gives equal-width digits so columns align.
 */
export function Money({ cents, className = '' }: { cents: number; className?: string }) {
  return (
    <span className={`num whitespace-nowrap ${cents < 0 ? 'text-red-700' : ''} ${className}`}>{formatLKR(cents)}</span>
  );
}
