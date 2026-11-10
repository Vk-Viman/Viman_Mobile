export function isCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

function assertSafeInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} must be a safe integer`);
}

/** round(a * b / c) using exact BigInt arithmetic, halves rounded away from zero. */
export function mulDivRound(a: number, b: number, c: number): number {
  assertSafeInt(a, 'a');
  assertSafeInt(b, 'b');
  assertSafeInt(c, 'c');
  if (c === 0) throw new RangeError('Division by zero');
  let num = BigInt(a) * BigInt(b);
  let den = BigInt(c);
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
  return q === 0n ? 0 : Number(q);
}

export function applyBp(amountCents: number, bp: number): number {
  return mulDivRound(amountCents, bp, 10000);
}

const PLAIN_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const GROUPED_RE = /^(-?)(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

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
  const frac = BigInt(((m[3] ?? '') + '00').slice(0, 2));
  const cents = sign * (whole * 100n + frac);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Amount is too large');
  }
  return cents === 0n ? 0 : Number(cents);
}

export function formatLKR(cents: number): string {
  assertSafeInt(cents, 'cents');
  const neg = cents < 0;
  const abs = BigInt(cents) * (neg ? -1n : 1n);
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}Rs. ${whole}.${frac}`;
}
