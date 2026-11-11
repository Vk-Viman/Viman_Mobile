/**
 * lib/money.ts - the single place where money arithmetic and rounding live.
 *
 * Layer: shared library. BUSINESS_RULES section 0: money is stored as whole CENTS (integers) and rates as
 * BASIS POINTS (600 bp = 6.00 %), so no floating-point error can ever creep into the books. Every derived
 * amount (weighted-average removal values, commissions, proportional returns) must go through
 * `mulDivRound` so that two parts of the system can never round the same figure differently.
 */

/** True when `n` is a whole number of cents that JavaScript can hold exactly (a "safe integer"). */
export function isCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** Guard used by the arithmetic below: refuse fractions / values too big to be exact. */
function assertSafeInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} must be a safe integer`);
}

/**
 * round(a * b / c) using exact BigInt arithmetic, halves rounded away from zero.
 *
 * The product `a * b` can exceed what a normal number holds exactly, so BigInt is used; the answer is checked
 * to fit back into a safe integer. Used for COGS, commissions, partial returns (C5, C7) and stocktake gains.
 *
 * @throws RangeError when an input is not a safe integer, `c` is 0, or the result is too large.
 */
export function mulDivRound(a: number, b: number, c: number): number {
  assertSafeInt(a, 'a');
  assertSafeInt(b, 'b');
  assertSafeInt(c, 'c');
  if (c === 0) throw new RangeError('Division by zero');
  let num = BigInt(a) * BigInt(b);
  let den = BigInt(c);
  // Work with positive numbers, remember the sign, and re-apply it at the end: this is what makes
  // "half away from zero" symmetric (2.5 -> 3 and -2.5 -> -3).
  let negative = false;
  if (num < 0n) { num = -num; negative = !negative; }
  if (den < 0n) { den = -den; negative = !negative; }
  let q = num / den;
  const r = num % den;
  if (r * 2n >= den) q += 1n;
  if (negative) q = -q;
  if (q > BigInt(Number.MAX_SAFE_INTEGER) || q < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Result is outside the safe integer range');
  }
  // `q === 0n` check turns a negative zero into a plain 0.
  return q === 0n ? 0 : Number(q);
}

/** One basis point is 1/10000. Applies a rate in basis points to an amount in cents, e.g. a commission (section 5). */
export function applyBp(amountCents: number, bp: number): number {
  return mulDivRound(amountCents, bp, 10000);
}

// Accepted text shapes for an amount in rupees: "1234", "1234.5", "-1.25" ...
const PLAIN_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
// ... and the same with thousands separators: "1,234,567.89".
const GROUPED_RE = /^(-?)(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

/**
 * Converts a rupee amount typed as text (or a number) into cents without any floating-point maths.
 *
 * @throws RangeError for text that is not an amount, has more than 2 decimals, or is too large.
 */
export function rupeesToCents(input: string | number): number {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new RangeError('Amount must be a finite number');
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    throw new RangeError('Amount must be a string or number');
  }
  const m = PLAIN_RE.exec(text) ?? GROUPED_RE.exec(text);
  if (!m) throw new RangeError(`Invalid amount: "${text}"`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt((m[2] as string).replaceAll(',', ''));
  // Pad then cut so "5" -> "50" cents, "5.5" -> "50", "5.05" -> "05".
  const frac = BigInt(((m[3] ?? '') + '00').slice(0, 2));
  const cents = sign * (whole * 100n + frac);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Amount is too large');
  }
  return cents === 0n ? 0 : Number(cents);
}

/** Formats cents for display as `Rs. 12,345.00` (negative: `-Rs. 1,234.50`), per BUSINESS_RULES section 0. */
export function formatLKR(cents: number): string {
  assertSafeInt(cents, 'cents');
  const neg = cents < 0;
  const abs = BigInt(cents) * (neg ? -1n : 1n);
  // Insert a comma before every group of three digits counted from the right.
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}Rs. ${whole}.${frac}`;
}
