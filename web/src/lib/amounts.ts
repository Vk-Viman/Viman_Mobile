/**
 * Parsing of rupee amounts typed into the Phase 8 forms (expenses, opening balance, cash count, daily closing).
 *
 * Input convenience only: the server re-validates every amount (1 .. 10^12 cents for money written to a book, 0 .. 10^12 for a
 * counted amount) and is the authority. The text is converted with exact integer parsing (lib/units.ts), never floating point.
 */
import { rupeesToCents } from './units';

/** Largest single amount the server accepts for these records (10^12 cents = Rs 10,000,000,000.00). */
export const MAX_CENTS = 1_000_000_000_000;

/**
 * Parses what the owner typed into whole cents, or null when it is empty, malformed, below `min` or above the limit.
 *
 * @param text Rupees such as "2500", "2,500.50" or ".5".
 * @param min  Smallest accepted amount in cents: 1 for money moved (default), 0 for a counted amount ("the drawer is empty").
 */
export function parseMoney(text: string, min = 1): number | null {
  if (text.trim() === '') return null;
  const cents = rupeesToCents(text);
  if (cents === null || cents < min || cents > MAX_CENTS) return null;
  return cents;
}

/** Longest free-text note the server accepts. */
export const MAX_NOTE = 500;
