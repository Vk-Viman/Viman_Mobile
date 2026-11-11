/** Display-only: cents per unit, half-up integer rounding. */
export function centsPerUnit(totalCents: number, units: number): number {
  if (units <= 0) return 0;
  return Math.floor((2 * totalCents + units) / (2 * units));
}

/** Parse a strictly positive/non-negative integer string; null when invalid. */
export function parseIntStrict(s: string): number | null {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
