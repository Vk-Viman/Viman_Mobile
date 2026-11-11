// Phase 6 - commission maths (BUSINESS_RULES section 5), unit level, no database.
// reload commission = round(sales x bp / 10000) + extra; EZCash commission = round(bill x bp / 10000); halves round
// AWAY from zero (section 0). Every expected number below was worked out by hand (shown in the comments), not by
// running the code under test. Money is in cents: Rs 1 = 100.

import { describe, it, expect } from 'vitest';
import { ezcashCommission, reloadCommission } from '../services/telecom.service.ts';

describe('reloadCommission (section 5)', () => {
  // Rs 50,000 = 5,000,000 cents. 6% = 300,000 cents (Rs 3,000). Extra Rs 50 = 5,000 cents. Total 305,000 = Rs 3,050.
  it('owner example: Rs 50,000 at 600 bp + Rs 50 extra = Rs 3,050', () => {
    expect(reloadCommission(5_000_000, 600, 5_000)).toBe(305_000);
  });

  it('the extra is added AFTER rounding and is not itself rated: no extra = Rs 3,000', () => {
    expect(reloadCommission(5_000_000, 600, 0)).toBe(300_000);
  });

  // 1,234,567 cents (Rs 12,345.67) x 600 = 740,740,200; / 10,000 = 74,074.02 -> 74,074 cents (Rs 740.74).
  it('Rs 12,345.67 at 600 bp rounds the 0.02 of a cent down: 74,074 cents', () => {
    expect(reloadCommission(1_234_567, 600, 0)).toBe(74_074);
  });

  // Exact halves round UP (away from zero): 25 x 600 = 15,000 / 10,000 = 1.5 -> 2;  75 x 600 = 45,000 -> 4.5 -> 5.
  it('exact halves round up: 25 cents at 600 bp = 2 (1.5), 75 cents at 600 bp = 5 (4.5)', () => {
    expect(reloadCommission(25, 600, 0)).toBe(2);
    expect(reloadCommission(75, 600, 0)).toBe(5);
  });

  // 100 x 50 = 5,000 / 10,000 = 0.5 -> 1;  300 x 50 = 15,000 -> 1.5 -> 2;  just below a half: 99 x 50 = 4,950 -> 0.495 -> 0.
  it('half-a-cent boundary at 50 bp: 100 -> 1, 300 -> 2, 99 -> 0', () => {
    expect(reloadCommission(100, 50, 0)).toBe(1);
    expect(reloadCommission(300, 50, 0)).toBe(2);
    expect(reloadCommission(99, 50, 0)).toBe(0);
  });

  // 1 x 5000 = 5000 / 10000 = 0.5 -> 1; 1 x 4999 = 0.4999 -> 0.
  it('1 cent at 5000 bp = 1 (exact half), at 4999 bp = 0', () => {
    expect(reloadCommission(1, 5000, 0)).toBe(1);
    expect(reloadCommission(1, 4999, 0)).toBe(0);
  });

  it('rate 0 earns only the extra; rate 10000 (100%) earns the whole sale', () => {
    expect(reloadCommission(7_777, 0, 0)).toBe(0);
    expect(reloadCommission(7_777, 0, 123)).toBe(123);
    expect(reloadCommission(7_777, 10_000, 0)).toBe(7_777);
  });

  // 999,999,999,999 x 0.06 = 59,999,999,999.94 -> 60,000,000,000 (largest supported amount, no float drift).
  it('very large amount stays exact: 999,999,999,999 cents at 600 bp = 60,000,000,000', () => {
    expect(reloadCommission(999_999_999_999, 600, 0)).toBe(60_000_000_000);
    // 10^12 x 10000 bp = 10^12 exactly.
    expect(reloadCommission(1_000_000_000_000, 10_000, 0)).toBe(1_000_000_000_000);
  });

  // 3,333 x 1,234 = 3,333,000 + 779,922 = 4,112,922; / 10,000 = 411.2922 -> 411.
  // So a custom provider rate of 12.34 % (1234 bp) on 3,333 cents earns 411 cents.
  it('a custom provider rate of 1234 bp on 3,333 cents = 411', () => {
    expect(reloadCommission(3_333, 1_234, 0)).toBe(411);
  });
});

describe('ezcashCommission (section 5)', () => {
  // Rs 50,000 = 5,000,000 cents x 80 = 400,000,000 / 10,000 = 40,000 cents = Rs 400.
  it('owner example: Rs 50,000 at 80 bp = Rs 400', () => {
    expect(ezcashCommission(5_000_000, 80)).toBe(40_000);
  });

  // 1,234,567 x 80 = 98,765,360 / 10,000 = 9,876.536 -> 9,877 cents.
  it('Rs 12,345.67 at 80 bp = 9,877 cents (9,876.536 rounds up)', () => {
    expect(ezcashCommission(1_234_567, 80)).toBe(9_877);
  });

  // 125 x 80 = 10,000 / 10,000 = 1 exactly; 187 x 80 = 14,960 -> 1.496 -> 1; 188 x 80 = 15,040 -> 1.504 -> 2.
  it('small bills: 125 -> 1, 187 -> 1, 188 -> 2 (80 bp)', () => {
    expect(ezcashCommission(125, 80)).toBe(1);
    expect(ezcashCommission(187, 80)).toBe(1);
    expect(ezcashCommission(188, 80)).toBe(2);
  });

  // 62 x 80 = 4,960 -> 0.496 -> 0; 63 x 80 = 5,040 -> 0.504 -> 1: a bill under 62.5 cents earns nothing.
  it('tiny bills: 62 cents -> 0, 63 cents -> 1', () => {
    expect(ezcashCommission(62, 80)).toBe(0);
    expect(ezcashCommission(63, 80)).toBe(1);
  });

  it('rate 0 earns nothing', () => {
    expect(ezcashCommission(5_000_000, 0)).toBe(0);
  });
});
