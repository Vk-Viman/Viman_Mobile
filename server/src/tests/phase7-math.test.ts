// Phase 7 unit tests: revenue / standard cost / gross profit of a print sale (R12), hand-calculated expected values.
// Protects the one place where print money is derived (printAmounts) so revenue = qty x price and cost = qty x snapshot
// cost can never drift, including at the largest accepted amounts (still exact integers) and when the price is below cost.

import { describe, it, expect } from 'vitest';
import { printAmounts } from '../services/printing.service.ts';
import { DEFAULTS } from '../services/settings.service.ts';
import { SEEDED } from './helpers/phase7.ts';

describe('printAmounts (R12): revenue = qty x price, cost = qty x standard cost, profit = revenue - cost', () => {
  // 3 x Rs 15.00 = 45.00; 3 x Rs 6.50 = 19.50; profit 25.50.
  it('3 B/W pages: price 1500, cost 650 -> revenue 4500, cost 1950, profit 2550', () => {
    expect(printAmounts(3, 1500, 650)).toEqual({ revenueCents: 4500, cogsCents: 1950, grossProfitCents: 2550 });
  });

  // 7 x 2500 = 17500; 7 x 900 = 6300; 17500 - 6300 = 11200.
  it('7 double-sided pages: 2500 / 900 -> 17500, 6300, 11200', () => {
    expect(printAmounts(7, 2500, 900)).toEqual({ revenueCents: 17500, cogsCents: 6300, grossProfitCents: 11200 });
  });

  it('1 page keeps the unit amounts exactly', () => {
    expect(printAmounts(1, 4000, 650)).toEqual({ revenueCents: 4000, cogsCents: 650, grossProfitCents: 3350 });
  });

  // Price overridden below cost: 10 x 500 = 5000 revenue vs 10 x 650 = 6500 cost -> loss of 1500 (R13 warns, never blocks).
  it('price below cost gives a negative gross profit: 10 @ 500 vs cost 650 -> -1500', () => {
    expect(printAmounts(10, 500, 650)).toEqual({ revenueCents: 5000, cogsCents: 6500, grossProfitCents: -1500 });
  });

  it('a free sale (price 0) has revenue 0 and the whole cost as loss: 4 @ 0, cost 650 -> -2600', () => {
    expect(printAmounts(4, 0, 650)).toEqual({ revenueCents: 0, cogsCents: 2600, grossProfitCents: -2600 });
  });

  it('zero standard cost: profit equals revenue (2 x 1000)', () => {
    expect(printAmounts(2, 1000, 0)).toEqual({ revenueCents: 2000, cogsCents: 0, grossProfitCents: 2000 });
  });

  // Largest accepted request: 1,000,000 pages x Rs 10,000,000.00 = 10^6 x 10^9 = 10^15 cents < 2^53 (9.007 x 10^15).
  it('largest accepted amounts stay exact integers: 1,000,000 x 1,000,000,000 = 10^15', () => {
    expect(printAmounts(1_000_000, 1_000_000_000, 999_999_999)).toEqual({
      revenueCents: 1_000_000_000_000_000, cogsCents: 999_999_999_000_000, grossProfitCents: 1_000_000,
    });
  });

  it('refuses a result that cannot be exact (beyond the safe integer range) instead of rounding silently', () => {
    expect(() => printAmounts(1_000_000, 10_000_000_000, 0)).toThrow(RangeError); // 10^16 > 2^53
  });

  it('refuses fractional input (quantities and cents are whole numbers)', () => {
    expect(() => printAmounts(1.5, 1000, 650)).toThrow(RangeError);
  });

  // The seed of migration 010 equals the Settings DEFAULTS, so the 7 default services give these per-page profits.
  it('default price list: per-page profit = price - cost for each of the seven defaults', () => {
    const profit: Record<string, number> = { BW_1S: 850, BW_2S: 1600, CLR_1S: 1350, CLR_2S: 2100, PC_BW_1S: 350, PC_BW_2S: 600, CUSTOM: 3350 };
    for (const p of DEFAULTS.printDefaults) {
      expect(printAmounts(1, p.priceCents, p.costCents).grossProfitCents).toBe(profit[p.code]);
      expect(SEEDED[p.code]).toEqual([p.priceCents, p.costCents]);
    }
  });
});
