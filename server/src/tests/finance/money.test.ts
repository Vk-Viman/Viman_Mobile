// Independent money test vectors (Financial Logic agent).
// Every expected value was derived by hand, never by calling the implementation.
import { describe, it, expect } from 'vitest';
import { isCents, mulDivRound, applyBp, rupeesToCents, formatLKR } from '../../lib/money.ts';

describe('isCents', () => {
  it('accepts safe integers (positive, negative, zero)', () => {
    expect(isCents(5)).toBe(true);
    expect(isCents(-5)).toBe(true);
    expect(isCents(0)).toBe(true);
    expect(isCents(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
  it('rejects fractions, NaN, Infinity, strings, null and unsafe integers', () => {
    expect(isCents(1.5)).toBe(false);
    expect(isCents(NaN)).toBe(false);
    expect(isCents(Infinity)).toBe(false);
    expect(isCents('5')).toBe(false);
    expect(isCents(null)).toBe(false);
    expect(isCents(undefined)).toBe(false);
    expect(isCents(2 ** 53)).toBe(false);
  });
});

describe('mulDivRound: half away from zero (R0)', () => {
  it('R0: rounds half up for positives (0.5 -> 1, 1.5 -> 2, 2.5 -> 3)', () => {
    expect(mulDivRound(1, 1, 2)).toBe(1);
    expect(mulDivRound(3, 1, 2)).toBe(2);
    expect(mulDivRound(5, 1, 2)).toBe(3);
  });
  it('R0: rounds half away from zero (negative numerator)', () => {
    expect(mulDivRound(-1, 1, 2)).toBe(-1);
    expect(mulDivRound(-3, 1, 2)).toBe(-2);
    expect(mulDivRound(-5, 1, 2)).toBe(-3);
  });
  it('R0: rounds half away from zero (negative multiplier)', () => {
    expect(mulDivRound(1, -1, 2)).toBe(-1);
    expect(mulDivRound(3, -1, 2)).toBe(-2);
  });
  it('R0: negative divisor flips the sign; negative x negative is positive', () => {
    expect(mulDivRound(1, 1, -2)).toBe(-1);
    expect(mulDivRound(-1, 1, -2)).toBe(1);
    expect(mulDivRound(-1, -1, 2)).toBe(1);
  });
  it('R0: below half rounds toward zero, above half away (2/3 -> 1, 1/3 -> 0, -2/3 -> -1, -1/3 -> 0)', () => {
    expect(mulDivRound(2, 1, 3)).toBe(1);
    expect(mulDivRound(1, 1, 3)).toBe(0);
    expect(mulDivRound(-2, 1, 3)).toBe(-1);
    expect(mulDivRound(-1, 1, 3)).toBe(0);
  });
  it('R0: exact divisions are unchanged', () => {
    expect(mulDivRound(10, 3, 5)).toBe(6);
    expect(mulDivRound(-10, 3, 5)).toBe(-6);
    expect(mulDivRound(0, 7, 3)).toBe(0);
    expect(mulDivRound(12345, 1, 1)).toBe(12345);
    expect(mulDivRound(7, 4, 4)).toBe(7);
  });
  it('R0: zero result for zero numerator regardless of divisor sign', () => {
    expect(mulDivRound(0, 5, -3)).toBe(0);
  });
});

describe('mulDivRound: value-pool removal sequences (R0, costing)', () => {
  it('pool 3 units / 1000 cents, removing 1,1,1 -> 333, 334, 333, pool ends 0/0', () => {
    let qty = 3;
    let value = 1000;
    const removed: number[] = [];
    for (let i = 0; i < 3; i++) {
      // q = 1; full removal when q === qty
      const out = qty === 1 ? value : mulDivRound(value, 1, qty);
      removed.push(out);
      value -= out;
      qty -= 1;
    }
    // step1: 1000*1/3 = 333.33 -> 333, pool 2/667
    // step2: 667*1/2 = 333.5 -> 334 (half away), pool 1/333
    // step3: last unit takes whole remainder 333, pool 0/0
    expect(removed).toEqual([333, 334, 333]);
    expect(qty).toBe(0);
    expect(value).toBe(0);
    expect(removed.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('weighted average: 10@30000 + 10@40000 = pool 20/700000; sell 2 -> 70000', () => {
    let qty = 10 + 10;
    let value = 10 * 30000 + 10 * 40000; // 300000 + 400000 = 700000
    expect(qty).toBe(20);
    expect(value).toBe(700000);
    // 700000*2/20 = 70000 exact
    const cogs1 = mulDivRound(value, 2, qty);
    expect(cogs1).toBe(70000);
    value -= cogs1; // 630000
    qty -= 2; // 18
    expect(qty).toBe(18);
    expect(value).toBe(630000);

    // +5 @ 42000 = 210000 -> pool 23 / 840000
    qty += 5;
    value += 5 * 42000;
    expect(qty).toBe(23);
    expect(value).toBe(840000);

    // sell 3: 840000*3/23 = 2520000/23 = 109565.217... -> 109565
    // check: 23*109565 = 2519995, remainder 5 (< 11.5) so rounds down
    const cogs2 = mulDivRound(value, 3, qty);
    expect(cogs2).toBe(109565);
    value -= cogs2; // 730435
    qty -= 3; // 20
    expect(qty).toBe(20);
    expect(value).toBe(730435);
  });

  it('simple average: 300 and 400 -> average 350 (value pool 700 over 2)', () => {
    expect(mulDivRound(30000 + 40000, 1, 2)).toBe(35000);
  });
});

describe('mulDivRound: pack size and proportional splits', () => {
  it('R-pack: 1 box of 10 for Rs 1,320 -> unit cost 13200 cents', () => {
    expect(mulDivRound(132000, 1, 10)).toBe(13200);
  });
  it('R-pack: 100000 cents over 3 units removes 33333, 33334, 33333 (sums to 100000)', () => {
    // 100000/3 = 33333.33 -> 33333, pool 2/66667
    // 66667/2 = 33333.5 -> 33334, pool 1/33333; last takes 33333
    let qty = 3;
    let value = 100000;
    const removed: number[] = [];
    while (qty > 0) {
      const out = qty === 1 ? value : mulDivRound(value, 1, qty);
      removed.push(out);
      value -= out;
      qty -= 1;
    }
    expect(removed).toEqual([33333, 33334, 33333]);
    expect(value).toBe(0);
  });
  it('R5: partial return takes proportional line total, final unit takes remainder', () => {
    // line total 1000 cents, qty 3. Return 1: 333. Cumulative returns reach 1000 exactly.
    const first = mulDivRound(1000, 1, 3); // 333.33 -> 333
    expect(first).toBe(333);
    // remaining 2 units: returning both at once = final unit takes remainder 1000 - 333
    expect(1000 - first).toBe(667);
    // returning 2 of 3 in one go: 1000*2/3 = 666.67 -> 667
    expect(mulDivRound(1000, 2, 3)).toBe(667);
  });
});

describe('applyBp (commission, rates in basis points)', () => {
  it('R-commission: 6% reload on 50,000.00 = 3,000.00', () => {
    expect(applyBp(5000000, 600)).toBe(300000);
  });
  it('R-commission: 0.8% EZCash on 50,000.00 = 400.00', () => {
    expect(applyBp(5000000, 80)).toBe(40000);
  });
  it('R-commission: 159900 @ 600 bp = 9594 exactly (95,940,000 / 10000)', () => {
    expect(applyBp(159900, 600)).toBe(9594);
  });
  it('R0: 12345 @ 80 bp = 98.76 rounds to 99', () => {
    // 12345 * 80 = 987,600 ; / 10000 = 98.76
    expect(applyBp(12345, 80)).toBe(99);
  });
  it('R-commission: 125 @ 400 bp = 5 exactly (50,000 / 10000)', () => {
    expect(applyBp(125, 400)).toBe(5);
  });
  it('R0: half case rounds up (125 @ 40 bp = 0.5 -> 1; 375 @ 40 bp = 1.5 -> 2)', () => {
    expect(applyBp(125, 40)).toBe(1);
    expect(applyBp(375, 40)).toBe(2);
    expect(applyBp(25, 200)).toBe(1); // 5000/10000 = 0.5
  });
  it('R0: negative half rounds away from zero (-125 @ 40 bp = -1)', () => {
    expect(applyBp(-125, 40)).toBe(-1);
  });
  it('R-commission: 0 bp gives 0, 0 amount gives 0', () => {
    expect(applyBp(5000000, 0)).toBe(0);
    expect(applyBp(0, 600)).toBe(0);
  });
  it('R-commission: 10000 bp is 100% (identity)', () => {
    expect(applyBp(123457, 10000)).toBe(123457);
  });
  it('R-commission: reload 50,000 @ 600 bp + 50 extra = 3,050 (extra added after rounding)', () => {
    expect(applyBp(5000000, 600) + 5000).toBe(305000);
  });
  it('R0: rejects non-integer inputs', () => {
    expect(() => applyBp(1.5, 100)).toThrow(RangeError);
    expect(() => applyBp(100, 0.5)).toThrow(RangeError);
  });
});

describe('mulDivRound: large values and errors', () => {
  it('R0: 9_000_000_000_000 x 3 / 7 = 3_857_142_857_143 (exact)', () => {
    // 9e12*3 = 27e12 = 27,000,000,000,000
    // 27,000,000,000,000 / 7 = 3,857,142,857,142 remainder 6  (7*3,857,142,857,142 = 26,999,999,999,994)
    // 6/7 = 0.857 > 0.5 -> round up -> 3,857,142,857,143
    expect(mulDivRound(9_000_000_000_000, 3, 7)).toBe(3_857_142_857_143);
  });
  it('R0: intermediate product beyond 2^53 is exact (9e12 x 9e12 / 9e12 = 9e12)', () => {
    // product 8.1e25 overflows double precision; BigInt must keep it exact
    expect(mulDivRound(9_000_000_000_000, 9_000_000_000_000, 9_000_000_000_000)).toBe(9_000_000_000_000);
  });
  it('R0: intermediate overflow with remainder (MAX_SAFE x MAX_SAFE / MAX_SAFE)', () => {
    expect(mulDivRound(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it('R0: MAX_SAFE_INTEGER / 2 (…991 / 2 = …495.5) rounds half away to 4503599627370496', () => {
    expect(mulDivRound(Number.MAX_SAFE_INTEGER, 1, 2)).toBe(4503599627370496);
    expect(mulDivRound(-Number.MAX_SAFE_INTEGER, 1, 2)).toBe(-4503599627370496);
  });
  it('R0: result exceeding the safe range throws RangeError', () => {
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(RangeError);
    expect(() => mulDivRound(-Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(RangeError);
  });
  it('R0: result equal to MAX_SAFE_INTEGER via intermediate product is allowed', () => {
    expect(mulDivRound(Number.MAX_SAFE_INTEGER, 2, 2)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('R0: non-integer arguments throw RangeError', () => {
    expect(() => mulDivRound(1.5, 1, 2)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1.5, 2)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1, 2.5)).toThrow(RangeError);
    expect(() => mulDivRound(NaN, 1, 2)).toThrow(RangeError);
    expect(() => mulDivRound(Infinity, 1, 2)).toThrow(RangeError);
  });
  it('R0: unsafe integer arguments (2^53) throw RangeError', () => {
    expect(() => mulDivRound(2 ** 53, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1, 2 ** 53)).toThrow(RangeError);
  });
  it('R0: divisor zero throws RangeError', () => {
    expect(() => mulDivRound(1, 1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(0, 0, 0)).toThrow(RangeError);
  });
});

describe('rupeesToCents', () => {
  it('parses thousands separators and two decimals', () => {
    expect(rupeesToCents('1,320.50')).toBe(132050);
  });
  it('parses whole rupees', () => {
    expect(rupeesToCents('15')).toBe(1500);
    expect(rupeesToCents('0')).toBe(0);
    expect(rupeesToCents('1,234')).toBe(123400);
  });
  it('parses one decimal digit as tenths (0.8 -> 80)', () => {
    expect(rupeesToCents('0.8')).toBe(80);
  });
  it('parses negatives ("-2.5" -> -250)', () => {
    expect(rupeesToCents('-2.5')).toBe(-250);
  });
  it('parses numbers (1320.5 -> 132050) without float drift (19.99 -> 1999)', () => {
    expect(rupeesToCents(1320.5)).toBe(132050);
    expect(rupeesToCents(19.99)).toBe(1999);
    expect(rupeesToCents(15)).toBe(1500);
  });
  it('trims surrounding whitespace ("  7 " -> 700)', () => {
    expect(rupeesToCents('  7 ')).toBe(700);
  });
  it('rejects more than 2 decimals', () => {
    expect(() => rupeesToCents('1.234')).toThrow(RangeError);
    expect(() => rupeesToCents(1.234)).toThrow(RangeError);
  });
  it('rejects junk, empty and malformed separators', () => {
    expect(() => rupeesToCents('abc')).toThrow(RangeError);
    expect(() => rupeesToCents('')).toThrow(RangeError);
    expect(() => rupeesToCents('1,2,3.4.5')).toThrow(RangeError);
  });
  it('rejects NaN and Infinity numbers', () => {
    expect(() => rupeesToCents(NaN)).toThrow(RangeError);
    expect(() => rupeesToCents(Infinity)).toThrow(RangeError);
  });
});

describe('formatLKR', () => {
  it('formats with grouping and two decimals', () => {
    expect(formatLKR(1234567)).toBe('Rs. 12,345.67');
    expect(formatLKR(100000000)).toBe('Rs. 1,000,000.00');
  });
  it('formats negatives as -Rs. (sign before prefix)', () => {
    expect(formatLKR(-123450)).toBe('-Rs. 1,234.50');
    expect(formatLKR(-5)).toBe('-Rs. 0.05');
  });
  it('formats zero and sub-rupee amounts', () => {
    expect(formatLKR(0)).toBe('Rs. 0.00');
    expect(formatLKR(5)).toBe('Rs. 0.05');
    expect(formatLKR(99)).toBe('Rs. 0.99');
    expect(formatLKR(100)).toBe('Rs. 1.00');
  });
  it('does not group below 1,000.00', () => {
    expect(formatLKR(99999)).toBe('Rs. 999.99');
    expect(formatLKR(100000)).toBe('Rs. 1,000.00');
  });
  it('round-trips with rupeesToCents', () => {
    expect(rupeesToCents('12,345.67')).toBe(1234567);
    expect(formatLKR(rupeesToCents('12,345.67'))).toBe('Rs. 12,345.67');
  });
});
