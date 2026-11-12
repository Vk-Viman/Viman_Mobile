// Phase 14: three seeded randomized multi-module simulations (>= 400 operations each) against an INDEPENDENT in-test model.
// Every operation is posted through the real HTTP API (sales with edited cost, partial/full/damaged returns, voids, backdated entries within the last
// 14 days, purchases and purchase returns/voids, losses, goods drawings, stocktakes, expenses, reloads, EZCash, top-ups, print sales/supplies,
// cash drawings, capital, transfers between every pair of books, cash counts, Ice Cream days/payments/fund moves/replacements, daily closings and
// reopens, plus deliberately invalid or closed-day requests). After EVERY operation the test checks:
//   1. the model's cash book balances, the three Ice Cream fund balances and every product's (quantity, value) equal the ledger/cache;
//   2. the outcome the model predicted for the request (success, or the exact documented refusal code, with nothing written on refusal);
//   3. assertGlobalInvariants (cash = sum of entries, funds = Ice Cream book, stock cache = movements, no negative stock, append-only probes,
//      reversal rows, no future dates, no electricity expense, Combined = sum of segments).
// A failing run prints its seed and operation number; the run is exactly replayable.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { Simulation } from './helpers/phase14.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const OPS = 420;
describe('randomized simulations vs independent model', () => {
  for (const seed of [14001, 271828, 31415926]) {
    it(`seed ${seed}: ${OPS} operations keep model, ledgers and every invariant in agreement`, async () => {
      const sim = new Simulation(await apiBase(await env.build()), seed);
      await sim.setup();
      const stats = await sim.run(OPS);
      expect(stats.ops).toBe(OPS);
      // the run must have actually exercised the interesting paths (guards against a simulation that silently skips everything)
      const k = stats.byKind;
      console.log(`seed ${seed}`, JSON.stringify(k), JSON.stringify(stats.rejected));
      for (const must of ['purchase', 'sale', 'saleReturn', 'cashOnly', 'iceDay', 'icePay', 'iceMove', 'count']) expect(k[must], `${must} ran`).toBeGreaterThan(5);
      expect(sim.recs.filter((r) => r.voided).length, 'some records were voided').toBeGreaterThan(5);
    }, 900000);
  }
});
