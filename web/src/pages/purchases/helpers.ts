/**
 * Small pure helpers for the purchase and stock forms. Display and input parsing only: the server calculates
 * and stores every authoritative figure.
 */

/**
 * Display-only: cost per unit in cents, rounded half-up using integer arithmetic only.
 * floor((2*total + units) / (2*units)) equals round(total / units) with .5 rounding up, without ever creating a
 * decimal number (which could introduce floating-point error). The server's own calculation is what gets stored;
 * this just lets the owner preview "10 units at Rs. 132.00 each" while typing.
 */
export function centsPerUnit(totalCents: number, units: number): number {
  if (units <= 0) return 0;
  return Math.floor((2 * totalCents + units) / (2 * units));
}

/**
 * Parses a whole-number string ("12"): digits only, no sign, no decimals, no spaces inside, within the safe integer
 * range. Returns null when invalid. Range limits (such as "at least 1") are checked by the caller.
 */
export function parseIntStrict(s: string): number | null {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
