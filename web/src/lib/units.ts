// Display/input conversion only. Pure string/integer parsing; no float arithmetic.

/** Parse a decimal string with at most `maxDecimals` places into an integer scaled by 10^maxDecimals. */
function parseScaled(input: string, maxDecimals: number): number | null {
  const raw = input.trim();
  // Commas only as thousands separators ("12,345.50"); "1,2,3" is a typo, not 123.
  if (raw.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(raw)) return null;
  const s = raw.replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!m) return null;
  const whole = m[1] || '0';
  let frac = m[2] ?? '';
  if (frac.length > maxDecimals) return null;
  frac = frac.padEnd(maxDecimals, '0');
  const n = Number(whole + frac);
  return Number.isSafeInteger(n) ? n : null;
}

/** "6.25" -> 625 basis points. Null when invalid (more than 2 decimals, negative, junk). */
export function percentToBp(input: string): number | null {
  return parseScaled(input, 2);
}

/** "1234.5" -> 123450 cents. Null when invalid. */
export function rupeesToCents(input: string): number | null {
  return parseScaled(input, 2);
}

function scaledToString(n: number, trimZeros: boolean): string {
  const neg = n < 0;
  const abs = Math.abs(Math.trunc(n));
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  let f = String(frac).padStart(2, '0');
  if (trimZeros) f = f.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${f ? '.' + f : ''}`;
}

/** 625 -> "6.25", 600 -> "6", 80 -> "0.8". */
export function bpToPercent(bp: number): string {
  return scaledToString(bp, true);
}

/** 123450 -> "1234.50" (always two decimals, for editing). */
export function centsToRupees(cents: number): string {
  return scaledToString(cents, false);
}
