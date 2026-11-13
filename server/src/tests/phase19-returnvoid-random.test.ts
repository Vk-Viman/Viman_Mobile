// PHASE 19 - AUDIT of R-VR: RANDOMIZED SIMULATIONS against an INDEPENDENT MODEL (audit item 13).
// Six seeds x 400 operations each (override the count with PHASE19_OPS for a quick local run). Every operation is chosen at random from: purchase (new costs, some zero), sale (1-3 lines, mixed Shop/Telecom carts,
// same product on two lines, C13 entered costs, free items), partial / multi-line / damaged / resalable returns, void-return attempts (valid and invalid), sale voids, purchase returns, purchase voids,
// day closings and reopenings. The model (helpers/phase19rv.ts RvSim) predicts success with exact figures or the exact refusal (status, code, error fields); a refusal must write NOTHING (full-database snapshot).
// After EVERY operation: pools, cash books, statuses, returned quantities, the day-by-day and total P&L of Shop and Telecom, the Shop identity (report vs cash + stock), the closing expectation, assertGlobalInvariants
// (with the append-only probes, after every operation), assertReturnLedgers (one refund / one reversal / one restock per line / at most one sweep ...), the reconciliation of every product and the dashboard
// and the valuation are checked.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { RvSim, newStats } from './helpers/phase19rv.ts';
import type { RvStats } from './helpers/phase19rv.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const OPS = Number(process.env.PHASE19_OPS ?? 400);
const SEEDS = [190301, 190302, 190303, 190304, 190305, 190306];
const all: RvStats[] = [];

describe('randomized simulations vs the independent model', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${OPS} operations`, async () => {
      const s = await apiBase(await env.build());
      const sim = new RvSim(s, seed);
      await sim.run(OPS);
      all.push(sim.stats);
      console.log(`seed ${seed}`, JSON.stringify(sim.stats));
      expect(sim.stats.ok['void-return'] ?? 0, 'void-return successes').toBeGreaterThanOrEqual(10);
    }, 1800000);
  }

  it('the simulations exercised the corner cases (aggregated over all seeds)', () => {
    expect(all.length).toBe(SEEDS.length);
    const sum = newStats();
    for (const st of all) {
      sum.ops += st.ops; sum.voidSweeps += st.voidSweeps; sum.voidGains += st.voidGains; sum.purchaseSweeps += st.purchaseSweeps; sum.purchaseGains += st.purchaseGains;
      sum.damagedReturns += st.damagedReturns; sum.multiLineReturns += st.multiLineReturns; sum.sameProductTwoLines += st.sameProductTwoLines; sum.extraCostLines += st.extraCostLines;
      for (const [k, v] of Object.entries(st.ok)) sum.ok[k] = (sum.ok[k] ?? 0) + v;
      for (const [k, v] of Object.entries(st.refused)) sum.refused[k] = (sum.refused[k] ?? 0) + v;
    }
    console.log('TOTAL', JSON.stringify(sum));
    expect(sum.ops).toBeGreaterThanOrEqual(SEEDS.length * OPS);
    expect(sum.voidSweeps, 'voids with a residual sweep').toBeGreaterThanOrEqual(3);
    expect(sum.voidGains, 'voids with a value gain').toBeGreaterThanOrEqual(3);
    expect(sum.damagedReturns).toBeGreaterThanOrEqual(10);
    expect(sum.multiLineReturns).toBeGreaterThanOrEqual(10);
    expect(sum.extraCostLines).toBeGreaterThanOrEqual(20);
    for (const code of ['RETURN_NOT_NEWEST', 'RETURN_STOCK_NOT_AVAILABLE', 'ALREADY_VOID', 'DAY_CLOSED', 'BACKDATE_BEFORE_CLOSED_DAY', 'HAS_RETURNS', 'RETURN_EXCEEDS_SOLD', 'INSUFFICIENT_STOCK', 'SALE_VOID']) {
      expect(sum.refused[code] ?? 0, `refusal ${code} exercised`).toBeGreaterThanOrEqual(1);
    }
  });
});
