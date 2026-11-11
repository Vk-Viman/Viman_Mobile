// Phase 13 - seeded randomized check of manual opening stock batches against an INDEPENDENT model.
// The model re-implements BUSINESS_RULES section 3 with plain BigInt arithmetic (it shares no code with the server): an
// opening batch adds quantity and the exact value; a sale removes round-half-up(value x q / qty) (the last unit takes the
// whole remainder); a purchase adds its exact line total; a void removes the batch exactly, and is refused (409
// OPENING_BATCH_IN_USE) when the pool no longer holds the batch quantity, or when the value cannot be taken out.
// After every step the products cache must equal the model, and at the end SUM(movements) = cache, the valuation total
// = the model total, and no cash entry exists except the purchases' payments.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, cashRows, mkProduct, productOf, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { openingPost } from './helpers/phase13.ts';
import { issueStock, reconcileStock } from '../services/inventory.service.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

/** Small deterministic random generator (mulberry32) so a failure can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pool { qty: bigint; value: bigint }
interface Batch { id: number; lines: Array<{ p: number; qty: bigint; value: bigint }>; voided: boolean }

const voidOpeningBatchVia = (s: ApiBase, id: number) => post(s.app, `/opening-stock/${id}/void`, { reason: 'model test' });

/** Independent half-up division of a non-negative BigInt ratio (values are never negative here). */
function roundDiv(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

describe.each([1, 7, 2026])('randomized manual opening stock vs independent model (seed %i)', (seed) => {
  it('matches after every step, reconciles, and moves no cash except purchases', async () => {
    const s: ApiBase = await apiBase(await env.build());
    const rand = rng(seed);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const products = [] as number[];
    const model = new Map<number, Pool>();
    for (let i = 0; i < 6; i++) {
      const p = await mkProduct(s);
      products.push(p.id);
      model.set(p.id, { qty: 0n, value: 0n });
    }
    const batches: Batch[] = [];
    let purchaseCash = 0n;
    let refused = 0;
    let voided = 0;

    const check = async (step: string) => {
      for (const id of products) {
        const m = model.get(id)!;
        const got = await productOf(s, id);
        expect({ step, id, qty: got.qtyOnHand, value: got.stockValueCents }).toEqual({ step, id, qty: Number(m.qty), value: Number(m.value) });
      }
    };

    for (let step = 0; step < 160; step++) {
      const kind = rand();
      if (kind < 0.4) {
        // A new batch with 1-4 distinct products; each line has either a unit cost or an exact total.
        const n = int(1, 4);
        const chosen = [...products].sort(() => rand() - 0.5).slice(0, n);
        const lines = chosen.map((p) => {
          const qty = int(1, 40);
          return rand() < 0.5
            ? { productId: p, qty, unitCostCents: int(0, 20000), total: null as number | null }
            : { productId: p, qty, unitCostCents: null as number | null, total: int(0, 500000) };
        });
        const items = lines.map((l) => l.unitCostCents === null
          ? { productId: l.productId, qty: l.qty, totalValueCents: l.total! }
          : { productId: l.productId, qty: l.qty, unitCostCents: l.unitCostCents });
        const r = await openingPost(s, items);
        expect(r.status, `step ${step}`).toBe(201);
        const b: Batch = { id: r.body.item.id, lines: [], voided: false };
        for (const l of lines) {
          const value = l.unitCostCents === null ? BigInt(l.total!) : BigInt(l.qty) * BigInt(l.unitCostCents);
          const pool = model.get(l.productId)!;
          pool.qty += BigInt(l.qty);
          pool.value += value;
          b.lines.push({ p: l.productId, qty: BigInt(l.qty), value });
        }
        expect(r.body.item.totalValueCents).toBe(Number(b.lines.reduce((a, l) => a + l.value, 0n)));
        batches.push(b);
      } else if (kind < 0.6) {
        // A sale through the engine (as the POS will do).
        const p = products[int(0, products.length - 1)]!;
        const pool = model.get(p)!;
        if (pool.qty === 0n) continue;
        const q = BigInt(int(1, Number(pool.qty)));
        const removed = q === pool.qty ? pool.value : roundDiv(pool.value * q, pool.qty);
        const out = s.ctx.database.tx((c) => issueStock(c, { productId: p, businessDate: today(), type: 'sale', qty: Number(q), refTable: null, refId: null, reason: 'model' }));
        expect(BigInt(out.valueRemovedCents), `step ${step}`).toBe(removed);
        pool.qty -= q;
        pool.value -= removed;
      } else if (kind < 0.75) {
        // A purchase (adds exact value and cash).
        const p = products[int(0, products.length - 1)]!;
        const units = int(1, 30);
        const total = int(0, 300000);
        await buy(s, [{ productId: p, packs: 1, packSize: units, lineTotalCents: total }]);
        const pool = model.get(p)!;
        pool.qty += BigInt(units);
        pool.value += BigInt(total);
        purchaseCash += BigInt(total);
      } else {
        // Void a random batch (voiding twice must be 409).
        if (batches.length === 0) continue;
        const b = batches[int(0, batches.length - 1)]!;
        const r = await voidOpeningBatchVia(s, b.id);
        if (b.voided) { expect(r.status, `step ${step}`).toBe(409); expect(r.body.error.code).toBe('ALREADY_VOID'); continue; }
        const fits = b.lines.every((l) => {
          const pool = model.get(l.p)!;
          const q = pool.qty - l.qty;
          const v = pool.value - l.value;
          return q >= 0n && v >= 0n && (q !== 0n || v === 0n);
        });
        if (fits) {
          expect(r.status, `step ${step}`).toBe(200);
          for (const l of b.lines) { const pool = model.get(l.p)!; pool.qty -= l.qty; pool.value -= l.value; }
          b.voided = true;
          voided++;
        } else {
          expect(r.status, `step ${step}`).toBe(409);
          expect(r.body.error.code).toBe('OPENING_BATCH_IN_USE');
          refused++;
        }
      }
      await check(`step ${step}`);
    }

    // End state: ledger = cache, valuation = model, cash = purchases only.
    expect(reconcileStock(s.ctx.database.conn)).toMatchObject({ ok: true, mismatches: [] });
    const val = (await get(s.app, '/inventory/valuation?includeZero=true')).body;
    const modelTotal = [...model.values()].reduce((a, p) => a + p.value, 0n);
    expect(val.totals.valueCents).toBe(Number(modelTotal));
    expect(cashRows(s.ctx).reduce((a, c) => a + BigInt(c.amount_cents), 0n)).toBe(-purchaseCash);
    // The run exercised creation, void and the refusal path (guards against a model that never hits them).
    expect(batches.length).toBeGreaterThan(20);
    expect(voided).toBeGreaterThan(0);
    expect(refused + voided).toBeGreaterThan(0);
    // Listed batches agree with the model's view of which are void.
    const listed = (await get(s.app, '/opening-stock?limit=200')).body.items;
    expect(listed.filter((b: any) => b.status === 'void').map((b: any) => b.id).sort()).toEqual(batches.filter((b) => b.voided).map((b) => b.id).sort());
    expect(await post(s.app, '/opening-stock/999999/void', { reason: 'x' }).then((r) => r.status)).toBe(404);
  }, 120000);
});
