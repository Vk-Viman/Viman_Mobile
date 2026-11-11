import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { todayBusinessDate } from '../../lib/dates.ts';
import { mulDivRound } from '../../lib/money.ts';
import {
  getPool, issueStock, issueStockCapped, receiveStock, reconcileStock,
} from '../../services/inventory.service.ts';
import type { MovementType } from '../../services/inventory.service.ts';
import { errOf, memDb, movements, pool, sqlProduct } from '../helpers/inventory.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns) { try { c.close(); } catch { /* ignore */ } } conns.length = 0; });

const D = todayBusinessDate();
const recv = (c: DatabaseSync, productId: number, qty: number, valueCents: number, type: MovementType = 'purchase') =>
  receiveStock(c, { productId, businessDate: D, type, qty, valueCents, refTable: null, refId: null, reason: 't' });
const sell = (c: DatabaseSync, productId: number, qty: number, type: MovementType = 'sale') =>
  issueStock(c, { productId, businessDate: D, type, qty, refTable: null, refId: null, reason: 't' });
const capped = (c: DatabaseSync, productId: number, qty: number, maxValueCents: number) =>
  issueStockCapped(c, {
    productId, businessDate: D, type: 'purchase_return', qty, maxValueCents, refTable: null, refId: null, reason: 't',
  });
const reconOk = (c: DatabaseSync) => expect(reconcileStock(c)).toMatchObject({ ok: true, mismatches: [] });

describe('weighted average: the owner demonstration', () => {
  it('3 purchases and 3 sales keep exact pool values and immutable COGS snapshots', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);

    // Purchase 1: 10 units, Rs 3,000 total -> 300000 cents
    const r1 = recv(c, p, 10, 300000);
    expect(r1.unitCostCents).toBe(30000);
    expect(pool(c, p)).toEqual({ qty: 10, value: 300000 });

    // Purchase 2: 2 packs x 5 = 10 units, Rs 4,000 -> 400000 cents
    const r2 = recv(c, p, 2 * 5, 400000);
    expect(r2.unitCostCents).toBe(40000);
    expect(pool(c, p)).toEqual({ qty: 20, value: 700000 }); // average Rs 350.00 = 35000

    // Sale of 2 at the average: 2 x 35000 = 70000 (Rs 700.00)
    const s1 = sell(c, p, 2);
    expect(s1.valueRemovedCents).toBe(70000);
    expect(s1.unitCostCents).toBe(35000);
    expect(pool(c, p)).toEqual({ qty: 18, value: 630000 });

    // Purchase 3: 5 units at Rs 420 each = 210000
    recv(c, p, 5, 210000);
    expect(pool(c, p)).toEqual({ qty: 23, value: 840000 }); // average 365.2174 rupees

    // Sale of 3: 840000 * 3 / 23 = 109565.217... -> 109565 (Rs 1,095.65)
    const s2 = sell(c, p, 3);
    expect(s2.valueRemovedCents).toBe(109565);
    expect(s2.valueRemovedCents).toBe(mulDivRound(840000, 3, 23));
    expect(s2.unitCostCents).toBe(36522); // 109565 / 3 = 36521.67
    expect(pool(c, p)).toEqual({ qty: 20, value: 730435 });

    // Historical snapshots: COGS of the first sale did not change after purchase 3 / sale 2.
    const mv = movements(c, p);
    const firstSale = mv.find((m) => m.id === s1.movementId)!;
    expect(firstSale).toMatchObject({ type: 'sale', qty: -2, value: -70000, unit: 35000 });
    expect(mv.find((m) => m.id === s2.movementId)).toMatchObject({ type: 'sale', qty: -3, value: -109565, unit: 36522 });
    expect(mv.filter((m) => m.type === 'purchase').map((m) => [m.qty, m.value, m.unit]))
      .toEqual([[10, 300000, 30000], [10, 400000, 40000], [5, 210000, 42000]]);
    reconOk(c);

    // Selling all remaining 20 removes the whole remaining value, no residue
    const s3 = sell(c, p, 20);
    expect(s3.valueRemovedCents).toBe(730435);
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
    expect(movements(c, p).find((m) => m.id === s1.movementId)).toEqual(firstSale);
    const m = movements(c, p);
    expect(m.reduce((a, x) => a + x.qty, 0)).toBe(0);
    expect(m.reduce((a, x) => a + x.value, 0)).toBe(0);
    reconOk(c);
  });
});

describe('weighted average: rounding', () => {
  it('3 units / 1000 cents: 333, 334, 333 -> 0/0', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 3, 1000);
    expect(sell(c, p, 1).valueRemovedCents).toBe(333); // 1000/3 = 333.33
    expect(pool(c, p)).toEqual({ qty: 2, value: 667 });
    expect(sell(c, p, 1).valueRemovedCents).toBe(334); // 667/2 = 333.5 -> half away from zero
    expect(pool(c, p)).toEqual({ qty: 1, value: 333 });
    expect(sell(c, p, 1).valueRemovedCents).toBe(333); // last unit takes everything
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
    reconOk(c);
  });

  it('half rounds up: pool 4/10 sell 1 -> 2.5 -> 3; pool 2/5 sell 1 -> 2.5 -> 3', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 4, 10);
    expect(sell(c, p, 1).valueRemovedCents).toBe(3);
    expect(pool(c, p)).toEqual({ qty: 3, value: 7 });
    const q = sqlProduct(c);
    recv(c, q, 2, 5);
    expect(sell(c, q, 1).valueRemovedCents).toBe(3);
    expect(pool(c, q)).toEqual({ qty: 1, value: 2 });
    reconOk(c);
  });

  it('below half rounds down: 7 units / 10 cents, sell 3 -> 4.2857 -> 4', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 7, 10);
    expect(sell(c, p, 3).valueRemovedCents).toBe(4);
    expect(pool(c, p)).toEqual({ qty: 4, value: 6 });
  });

  it('zero-value stock (free goods) is valid and sells at zero cost', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 5, 0);
    expect(pool(c, p)).toEqual({ qty: 5, value: 0 });
    expect(sell(c, p, 2)).toMatchObject({ valueRemovedCents: 0, unitCostCents: 0 });
    expect(sell(c, p, 3).valueRemovedCents).toBe(0);
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
    reconOk(c);
  });

  it('large values stay exact: 99,999,999,999 cents over 999,999 units, sell 333,333', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 999999, 99999999999);
    const r = sell(c, p, 333333);
    const expected = Number((BigInt(99999999999) * 333333n * 2n + 999999n) / (999999n * 2n));
    expect(r.valueRemovedCents).toBe(expected);
    expect(pool(c, p).value).toBe(99999999999 - expected);
    reconOk(c);
  });
});

describe('weighted average: guards', () => {
  it('over-issue -> INSUFFICIENT_STOCK with onHand, and no movement is written', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 5, 5000);
    const e = errOf(() => sell(c, p, 6));
    expect(e).toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_STOCK' });
    expect(e.extra.onHand).toBe(5);
    expect(movements(c, p)).toHaveLength(1);
    expect(pool(c, p)).toEqual({ qty: 5, value: 5000 });
    const q = sqlProduct(c);
    const e2 = errOf(() => sell(c, q, 1));
    expect(e2).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(e2.extra.onHand).toBe(0);
    expect(movements(c, q)).toHaveLength(0);
  });

  it('qty 0 / negative / fractional are rejected and never valued', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 5, 5000);
    for (const q of [0, -1, 1.5, Number.NaN]) {
      expect(errOf(() => sell(c, p, q))).toBeInstanceOf(RangeError);
      expect(errOf(() => recv(c, p, q, 100))).toBeInstanceOf(RangeError);
    }
    expect(errOf(() => recv(c, p, 1, -1))).toBeInstanceOf(RangeError);
    expect(errOf(() => recv(c, p, 1, 1.5))).toBeInstanceOf(RangeError);
    expect(movements(c, p)).toHaveLength(1);
    expect(pool(c, p)).toEqual({ qty: 5, value: 5000 });
  });

  it('getPool of an unknown product -> 404 NOT_FOUND', () => {
    const c = memDb(conns);
    expect(errOf(() => getPool(c, 9999))).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('services cannot receive stock (nothing written)', () => {
    const c = memDb(conns);
    const s = sqlProduct(c, { kind: 'service' });
    expect(errOf(() => recv(c, s, 1, 100)).message).toMatch(/CHECK/);
    expect(movements(c, s)).toHaveLength(0);
  });

  it('movement type and unit-cost snapshot are stored', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 4, 1000, 'opening');
    const r = sell(c, p, 1, 'personal_use');
    expect(r).toMatchObject({ valueRemovedCents: 250, unitCostCents: 250 });
    expect(movements(c, p).map((m) => m.type)).toEqual(['opening', 'personal_use']);
  });
});

describe('issueStockCapped (R4)', () => {
  it('pool cheaper than the purchase cost: removes the pool value; quantity stays with value 0', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 10, 5000);
    const r = capped(c, p, 4, 8000);
    expect(r.valueRemovedCents).toBe(5000); // min(8000, 5000)
    expect(r.sweepMovementId).toBeNull();
    expect(r.sweptCents).toBe(0);
    expect(pool(c, p)).toEqual({ qty: 6, value: 0 }); // qty > 0 with value 0 is allowed
    expect(movements(c, p)[1]).toMatchObject({ type: 'purchase_return', qty: -4, value: -5000, unit: 1250 });
    reconOk(c);
    expect(sell(c, p, 6).valueRemovedCents).toBe(0);
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
  });

  it('pool richer than the purchase cost: removes only the purchase-cost value', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 10, 10000);
    recv(c, p, 10, 30000); // pool 20 / 40000
    const r = capped(c, p, 10, 10000);
    expect(r.valueRemovedCents).toBe(10000);
    expect(pool(c, p)).toEqual({ qty: 10, value: 30000 });
    reconOk(c);
  });

  it('residual sweep: pool 3/7500, return all 3 with max 5000 -> adjustment -2500 first, then -5000, 0/0', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 3, 7500);
    const r = capped(c, p, 3, 5000);
    expect(r).toMatchObject({ valueRemovedCents: 5000, sweptCents: 2500 });
    expect(r.sweepMovementId).not.toBeNull();
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
    const mv = movements(c, p);
    expect(mv).toHaveLength(3);
    expect(mv[1]).toMatchObject({ id: r.sweepMovementId, type: 'adjustment', qty: 0, value: -2500, unit: null });
    expect(mv[2]).toMatchObject({ id: r.movementId, type: 'purchase_return', qty: -3, value: -5000 });
    expect(mv[1]!.id).toBeLessThan(mv[2]!.id);
    reconOk(c);
  });

  it('no sweep when the whole pool value is covered; purchase_void type accepted', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 3, 7500);
    const r = issueStockCapped(c, {
      productId: p, businessDate: D, type: 'purchase_void', qty: 3, maxValueCents: 9000,
      refTable: 'purchases', refId: 1, reason: 'v',
    });
    expect(r).toMatchObject({ valueRemovedCents: 7500, sweepMovementId: null, sweptCents: 0 });
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
    expect(movements(c, p)[1]).toMatchObject({ type: 'purchase_void', refTable: 'purchases', refId: 1 });
  });

  it('over-return -> INSUFFICIENT_STOCK, nothing written', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 3, 7500);
    const e = errOf(() => capped(c, p, 4, 5000));
    expect(e).toMatchObject({ code: 'INSUFFICIENT_STOCK', statusCode: 422 });
    expect(e.extra.onHand).toBe(3);
    expect(movements(c, p)).toHaveLength(1);
  });

  it('maxValue 0 removes units for free; leftover value is swept only when quantity hits 0', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    recv(c, p, 4, 400);
    expect(capped(c, p, 1, 0).valueRemovedCents).toBe(0);
    expect(pool(c, p)).toEqual({ qty: 3, value: 400 });
    const r = capped(c, p, 3, 0);
    expect(r.sweptCents).toBe(400);
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
    reconOk(c);
  });
});
