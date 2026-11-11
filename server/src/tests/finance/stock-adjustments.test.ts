// Stocktake gains/losses and stock adjustments - API level (Fastify inject + real temp database).
// Protects R2/R3 (BUSINESS_RULES sections 3 and 11): a stocktake loss removes value at the current average, a gain adds
// value at the current average (C10: if qty = 0 or value = 0 the owner must enter a unit cost), losing everything leaves
// no residue, "Stock adjustments (net)" = losses + stocktake losses + residual sweeps - stocktake gains per book, and
// voids (R1, C6) reverse an adjustment exactly. Goods drawings are NOT stock adjustments (section 1 "below the line").
// Organised as: unit rules for gainValue, then API scenarios on a standard pool of 20 units / Rs 7,000.
// Money values are hand-derived in the comments.

import { describe, it, expect, afterEach } from 'vitest';
import { AppError } from '../../lib/errors.ts';
import { gainValue } from '../../services/inventory.service.ts';
import { TestEnv } from '../helpers/tmp.ts';
import { post } from '../helpers/catalog.ts';
import { apiBase, buy, mkProduct, mkTelecom, today } from '../helpers/inventory.ts';
import type { ApiBase } from '../helpers/inventory.ts';
import {
  drawNew, err, ledgerOf, lossNew, mvs, mvsOf, num, poolOf, reconOk, sql, stComplete, stDraft, stNew, stVoid,
} from '../helpers/phase4.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const bl = (productId: number, units: number, lineTotalCents: number) => ({ productId, packs: 1, packSize: units, lineTotalCents });

// (Shared fixture; its derivation: 10 @ 300,000 + 10 @ 400,000 cents = 20 units / 700,000.)
/** Product with 10 @ Rs 3,000 and 10 @ Rs 4,000: pool 20 / 700000 (average 35000 = Rs 350.00). */
async function pool20(s: ApiBase, mk = mkProduct): Promise<number> {
  const p = await mk(s);
  await buy(s, [bl(p.id, 10, 300000)]);
  await buy(s, [bl(p.id, 10, 400000)]);
  expect(poolOf(s, p.id)).toEqual({ qty: 20, value: 700000 });
  return p.id;
}
async function count(s: ApiBase, items: Array<{ productId: number; countedQty: number; gainUnitCostCents?: number }>, book = 'shop') {
  const d = await stDraft(s, items, { book });
  const r = await stComplete(s, d.id);
  return r;
}

// C10: a stocktake gain is valued at the current average, unless the pool has no quantity or no value to average.
describe('gainValue (C10) unit rules', () => {
  // value = mulDivRound(poolValue, gainQty, poolQty), e.g. 700,000 x 3 / 20 = 105,000; 10,000 x 2 / 7 = 2,857.14 -> 2,857;
  // 5 x 1 / 2 = 2.5 -> 3 (half away from zero). A cost typed by the owner is ignored when the average is usable.
  it('uses the average when qty > 0 and value > 0', () => {
    expect(gainValue({ qty: 20, valueCents: 700000 }, 3, null)).toBe(105000);   // 700000*3/20
    expect(gainValue({ qty: 17, valueCents: 595000 }, 3, null)).toBe(105000);   // 595000*3/17
    expect(gainValue({ qty: 7, valueCents: 10000 }, 2, null)).toBe(2857);       // 2857.14
    expect(gainValue({ qty: 3, valueCents: 1000 }, 1, null)).toBe(333);         // 333.33
    expect(gainValue({ qty: 2, valueCents: 5 }, 1, null)).toBe(3);              // 2.5 -> 3 (half away from zero)
    expect(gainValue({ qty: 3, valueCents: 1001 }, 1, null)).toBe(334);         // 333.67
    expect(gainValue({ qty: 20, valueCents: 700000 }, 3, 99999)).toBe(105000);  // supplied cost ignored
  });
  // With nothing to average, the owner's unit cost is required (UNIT_COST_REQUIRED); value = gain x cost, e.g. 2 x 1,250 = 2,500.
  it('needs a unit cost when qty = 0 or value = 0; value = gain x cost', () => {
    for (const pool of [{ qty: 0, valueCents: 0 }, { qty: 5, valueCents: 0 }]) {
      const e = (() => { try { gainValue(pool, 2, null); } catch (x) { return x as AppError; } throw new Error('no throw'); })();
      expect(e).toBeInstanceOf(AppError);
      expect(e).toMatchObject({ statusCode: 422, code: 'UNIT_COST_REQUIRED' });
      expect(gainValue(pool, 2, 1250)).toBe(2500);
      expect(gainValue(pool, 3, 0)).toBe(0);
    }
  });
});

// A stocktake that finds fewer units than the system expects removes them at the average (shop loss).
describe('stocktake loss: counted 17 vs system 20', () => {
  // Pool 20 / 700,000, average 35,000. Counted 17 -> lose 3 x 35,000 = 105,000 -> pool 17 / 595,000, average still 35,000.
  it('removes 3 at the average 35000 = 105000; pool 17 / 595000; item stores expected 20 / diff -3 / value -105000', async () => {
    const s = await setup();
    const p = await pool20(s);
    const avgBefore = 700000 / 20;
    const r = await count(s, [{ productId: p, countedQty: 17 }]);
    expect(r.status).toBe(200);
    expect(r.body.item.items[0]).toMatchObject({ countedQty: 17, expectedQty: 20, differenceQty: -3, valueDeltaCents: -105000, gainUnitCostCents: null });
    expect(poolOf(s, p)).toEqual({ qty: 17, value: 595000 });
    expect(595000 / 17).toBe(avgBefore); // average unchanged
    const m = mvs(s, "type = 'stocktake_loss'");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ qty: -3, value: -105000, unit: 35000, refTable: 'stocktakes', refId: r.body.item.id, date: today() });
    await reconOk(s);
  });

  // Loss 7 of 17: 595,000 x 7 / 17 = 245,000 -> 10 / 350,000. Gain 5 of 10: 350,000 x 5 / 10 = 175,000 -> 15 / 525,000.
  // Loss and gain both use the average, so the average (35,000) never drifts.
  it('a loss of 7 from 17/595000 and a following gain back to 15 keep the average 35000', async () => {
    const s = await setup();
    const p = await pool20(s);
    await count(s, [{ productId: p, countedQty: 17 }]);
    const r2 = await count(s, [{ productId: p, countedQty: 10 }]);
    expect(r2.body.item.items[0]).toMatchObject({ expectedQty: 17, differenceQty: -7, valueDeltaCents: -245000 }); // 595000*7/17
    expect(poolOf(s, p)).toEqual({ qty: 10, value: 350000 });
    const r3 = await count(s, [{ productId: p, countedQty: 15 }]);
    expect(r3.body.item.items[0]).toMatchObject({ expectedQty: 10, differenceQty: 5, valueDeltaCents: 175000 }); // 350000*5/10
    expect(poolOf(s, p)).toEqual({ qty: 15, value: 525000 });
    expect(525000 / 15).toBe(35000);
    await reconOk(s);
  });
});

// A stocktake that finds more units than the system expects adds them at the current average.
describe('stocktake gain: counted 20 vs system 17', () => {
  // Pool 17 / 595,000 -> gain 3 = 595,000 x 3 / 17 = 105,000 exactly -> back to 20 / 700,000.
  it('adds 3 at the average = mulDivRound(595000,3,17) = 105000; pool back to 20 / 700000', async () => {
    const s = await setup();
    const p = await pool20(s);
    await count(s, [{ productId: p, countedQty: 17 }]);
    const r = await count(s, [{ productId: p, countedQty: 20 }]);
    expect(r.body.item.items[0]).toMatchObject({ expectedQty: 17, differenceQty: 3, valueDeltaCents: 105000, gainUnitCostCents: null });
    expect(poolOf(s, p)).toEqual({ qty: 20, value: 700000 });
    expect(mvs(s, "type = 'stocktake_gain'")).toEqual([expect.objectContaining({ qty: 3, value: 105000, unit: 35000 })]);
    await reconOk(s);
  });

  // Each case [units / value, gain -> value added]: 7/10,000 +2 = 2,857.14 -> 2,857; 3/1,000 +1 = 333.33 -> 333;
  // 2/5 +1 = 2.5 -> 3; 3/1,001 +1 = 333.67 -> 334.
  it('rounding: 7/10000 + 2 -> 2857 (2857.14); 3/1000 + 1 -> 333; 2/5 + 1 -> 3 (half up); 3/1001 + 1 -> 334', async () => {
    const s = await setup();
    const cases: Array<[number, number, number, number]> = [ // [units, value, gain, expected gain value]
      [7, 10000, 2, 2857], [3, 1000, 1, 333], [2, 5, 1, 3], [3, 1001, 1, 334],
    ];
    for (const [units, value, gain, expectValue] of cases) {
      const p = await mkProduct(s);
      await buy(s, [bl(p.id, units, value)]);
      const r = await count(s, [{ productId: p.id, countedQty: units + gain }]);
      expect(r.status).toBe(200);
      expect(r.body.item.items[0]).toMatchObject({ differenceQty: gain, valueDeltaCents: expectValue });
      expect(poolOf(s, p.id), `${units}/${value}`).toEqual({ qty: units + gain, value: value + expectValue });
    }
    await reconOk(s);
  });
});

// Empty or zero-value pools cannot give an average, so the owner must supply the unit cost; otherwise nothing is posted.
describe('gain when the average cannot be used (C10)', () => {
  // Without a cost the request fails naming the exact field, nothing is posted and the stocktake stays a draft.
  it('qty 0 and no cost: 422 UNIT_COST_REQUIRED with the exact field, nothing posted, stocktake stays a draft', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const d = await stDraft(s, [{ productId: p.id, countedQty: 5 }]);
    const before = num(s, 'SELECT COUNT(*) FROM stock_movements');
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('UNIT_COST_REQUIRED');
    expect(Object.keys(err(r).fields)).toEqual(['items.0.gainUnitCostCents']);
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(before);
    expect(poolOf(s, p.id)).toEqual({ qty: 0, value: 0 });
    expect(sql(s, 'SELECT status, completed_at FROM stocktakes WHERE id = ?', d.id)[0]).toMatchObject({ status: 'draft', completed_at: null });
    expect(sql(s, 'SELECT expected_qty, difference_qty, value_delta_cents FROM stocktake_items')[0]).toEqual({ expected_qty: null, difference_qty: null, value_delta_cents: null });
  });

  // 5 units found in an empty pool at Rs 12.50 = 5 x 1,250 = 6,250 cents.
  it('qty 0 with a unit cost: value = gain x cost; the cost is stored on the item', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const r = await count(s, [{ productId: p.id, countedQty: 5, gainUnitCostCents: 1250 }]);
    expect(r.status).toBe(200);
    expect(r.body.item.items[0]).toMatchObject({ expectedQty: 0, differenceQty: 5, valueDeltaCents: 6250, gainUnitCostCents: 1250 });
    expect(poolOf(s, p.id)).toEqual({ qty: 5, value: 6250 });
    expect(mvsOf(s, p.id)).toEqual([expect.objectContaining({ type: 'stocktake_gain', qty: 5, value: 6250, unit: 1250 })]);
    await reconOk(s);
  });

  // 4 free units (value 0) then counted 6: needs a cost; 2 gained x 300 = 600.
  it('qty > 0 but value 0 also needs a cost; with 300 the gain of 2 is worth 600', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await buy(s, [bl(p.id, 4, 0)]);
    expect(poolOf(s, p.id)).toEqual({ qty: 4, value: 0 });
    const d = await stDraft(s, [{ productId: p.id, countedQty: 6 }]);
    const bad = await stComplete(s, d.id);
    expect(bad.status).toBe(422);
    expect(err(bad).code).toBe('UNIT_COST_REQUIRED');
    expect(poolOf(s, p.id)).toEqual({ qty: 4, value: 0 });
    const ok = await count(s, [{ productId: p.id, countedQty: 6, gainUnitCostCents: 300 }]);
    expect(ok.status).toBe(200);
    expect(poolOf(s, p.id)).toEqual({ qty: 6, value: 600 });
    expect(ok.body.item.items[0]).toMatchObject({ valueDeltaCents: 600, gainUnitCostCents: 300 });
    await reconOk(s);
  });

  // 10 units / 300,000 -> average 30,000. Gain 2 = 60,000 (the typed 99,999 is ignored) -> 12 / 360,000.
  it('a supplied cost is ignored when the average is usable', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await buy(s, [bl(p.id, 10, 300000)]);
    const r = await count(s, [{ productId: p.id, countedQty: 12, gainUnitCostCents: 99999 }]);
    expect(r.status).toBe(200);
    expect(r.body.item.items[0]).toMatchObject({ differenceQty: 2, valueDeltaCents: 60000, gainUnitCostCents: null });
    expect(poolOf(s, p.id)).toEqual({ qty: 12, value: 360000 });
  });

  // Completing a stocktake is all-or-nothing: item 2 lacks a cost, so item 1's loss is rolled back as well.
  it('multi-item: an earlier priced item is rolled back when a later one needs a cost', async () => {
    const s = await setup();
    const a = await pool20(s);
    const b = await mkProduct(s);
    const d = await stDraft(s, [{ productId: a, countedQty: 10 }, { productId: b.id, countedQty: 3 }]);
    const r = await stComplete(s, d.id);
    expect(r.status).toBe(422);
    expect(Object.keys(err(r).fields)).toEqual(['items.1.gainUnitCostCents']);
    expect(poolOf(s, a)).toEqual({ qty: 20, value: 700000 });
    expect(mvs(s, "type LIKE 'stocktake%'")).toEqual([]);
    expect(sql(s, 'SELECT status FROM stocktakes')[0]!.status).toBe('draft');
    await reconOk(s);
  });
});

// Counting down to zero must remove every cent of value (last unit takes the remainder).
describe('loss to zero leaves no residue', () => {
  // 1,000/3 = 333; 667/2 = 333.5 -> 334; last unit 333. 333 + 334 + 333 = 1,000, pool 0/0 and ledger 0/0.
  it('3/1000: counts 2, 1, 0 remove 333, 334 and 333 = exactly 1000', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await buy(s, [bl(p.id, 3, 1000)]);
    const r1 = await count(s, [{ productId: p.id, countedQty: 2 }]);
    expect(r1.body.item.items[0].valueDeltaCents).toBe(-333); // 1000/3
    expect(poolOf(s, p.id)).toEqual({ qty: 2, value: 667 });
    const r2 = await count(s, [{ productId: p.id, countedQty: 1 }]);
    expect(r2.body.item.items[0].valueDeltaCents).toBe(-334); // 667/2 = 333.5 -> 334
    expect(poolOf(s, p.id)).toEqual({ qty: 1, value: 333 });
    const r3 = await count(s, [{ productId: p.id, countedQty: 0 }]);
    expect(r3.body.item.items[0]).toMatchObject({ expectedQty: 1, differenceQty: -1, valueDeltaCents: -333 });
    expect(poolOf(s, p.id)).toEqual({ qty: 0, value: 0 });
    expect(ledgerOf(s, p.id)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  // Counting 0 on 3 units / 1,001 removes the whole 1,001 in one movement (no rounding leftover).
  it('counting 0 on 3/1001 removes the whole 1001 in one movement', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await buy(s, [bl(p.id, 3, 1001)]);
    const r = await count(s, [{ productId: p.id, countedQty: 0 }]);
    expect(r.body.item.items[0]).toMatchObject({ differenceQty: -3, valueDeltaCents: -1001 });
    expect(poolOf(s, p.id)).toEqual({ qty: 0, value: 0 });
  });
});

// The P&L line "Stock adjustments (net)" per book = losses + stocktake losses - stocktake gains (section 11).
describe('stock adjustments total per book (R2/R3)', () => {
  // Shop: stocktake loss 105,000 + stock loss 70,000 (2 x 35,000) - stocktake gain 70,000 = net 105,000 cost.
  // Telecom: loss 5,000 - gain 15,000 = net -10,000 (a profit). Both are checked from the movements and from the records.
  // The goods drawing (35,000) is recorded separately in owner_drawings and must NOT appear in the adjustments.
  it('Σ(stocktake_loss + loss) - Σ(stocktake_gain) from movements equals the rows; goods drawings are excluded', async () => {
    const s = await setup();
    const A = await pool20(s);                                         // shop 20 / 700000
    const T = (await mkTelecom(s)).id;
    await buy(s, [bl(T, 10, 50000)]);                                  // telecom 10 / 50000 (5000 each)

    const st1 = await count(s, [{ productId: A, countedQty: 17 }]);   // loss 105000 -> 17 / 595000
    expect(st1.body.item.items[0].valueDeltaCents).toBe(-105000);
    const l1 = await lossNew(s, A, 2);                                // 2 x 35000 = 70000 -> 15 / 525000
    expect(l1.body.item.costCents).toBe(70000);
    const dr = await drawNew(s, A, 1);                                // 35000 personal use -> 14 / 490000
    expect(dr.body.item.amountCents).toBe(35000);
    const st2 = await count(s, [{ productId: A, countedQty: 16 }]);   // gain 2 = 490000*2/14 = 70000 -> 16 / 560000
    expect(st2.body.item.items[0].valueDeltaCents).toBe(70000);
    expect(poolOf(s, A)).toEqual({ qty: 16, value: 560000 });
    const lt = await lossNew(s, T, 1, { reason: 'expired' });         // 5000 -> 9 / 45000
    expect(lt.body.item.costCents).toBe(5000);
    const st3 = await count(s, [{ productId: T, countedQty: 12 }], 'telecom'); // gain 3 = 45000*3/9 = 15000 -> 12 / 60000
    expect(st3.body.item.items[0].valueDeltaCents).toBe(15000);
    expect(poolOf(s, T)).toEqual({ qty: 12, value: 60000 });

    const net = (book: string): number => -num(s,
      `SELECT COALESCE(SUM(m.value_delta_cents),0) FROM stock_movements m JOIN products p ON p.id = m.product_id
       WHERE p.book = ? AND m.type IN ('stocktake_loss','loss','stocktake_gain')`, book);
    expect(net('shop')).toBe(105000 + 70000 - 70000);
    expect(net('telecom')).toBe(5000 - 15000);

    // the same figures from the records
    const itemsNet = (book: string): number => -num(s,
      `SELECT COALESCE(SUM(i.value_delta_cents),0) FROM stocktake_items i JOIN stocktakes t ON t.id = i.stocktake_id
       WHERE t.book = ? AND t.status = 'completed'`, book);
    const lossNet = (book: string): number => num(s,
      "SELECT COALESCE(SUM(cost_cents),0) FROM stock_losses WHERE book = ? AND status = 'posted'", book);
    expect(itemsNet('shop') + lossNet('shop')).toBe(net('shop'));
    expect(itemsNet('telecom') + lossNet('telecom')).toBe(net('telecom'));

    // goods drawing: its own record + personal_use movement, not part of the adjustments
    expect(num(s, "SELECT COUNT(*) FROM stock_losses WHERE product_id = ? AND qty = 1 AND cost_cents = 35000", A)).toBe(0);
    expect(num(s, "SELECT COUNT(*) FROM stock_losses")).toBe(2);
    expect(mvs(s, "type = 'personal_use'")).toEqual([expect.objectContaining({ qty: -1, value: -35000, refTable: 'owner_drawings' })]);
    expect(num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM owner_drawings WHERE status = 'posted'")).toBe(35000);
    await reconOk(s);
  });

  // C6: voiding writes exact negations. Stocktake loss -105,000 voided = +105,000; the 2-unit loss (-70,000) voided = +70,000;
  // the net adjustment returns to 0 and the pool to 20 / 700,000.
  it('voiding a stocktake / loss reverses the adjustment exactly: net movement value returns to 0', async () => {
    const s = await setup();
    const A = await pool20(s);
    const st = await stDraft(s, [{ productId: A, countedQty: 17 }]);
    expect((await stComplete(s, st.id)).status).toBe(200);
    const l = await lossNew(s, A, 2);                       // 17/595000 -> 15/525000
    expect(l.status).toBe(201);
    expect(poolOf(s, A)).toEqual({ qty: 15, value: 525000 });
    expect((await stVoid(s, st.id)).status).toBe(200);      // +3 / +105000 -> 18/630000
    expect(poolOf(s, A)).toEqual({ qty: 18, value: 630000 });
    const adj = (): number => num(s, "SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type IN ('stocktake_loss','loss','stocktake_gain')");
    expect(adj()).toBe(-70000 - 105000 + 105000);           // only the loss remains
    const lv = await post(s.app, `/stock-losses/${l.body.item.id}/void`, { reason: 'x' });
    expect(lv.status).toBe(200);
    expect(adj()).toBe(0);
    expect(poolOf(s, A)).toEqual({ qty: 20, value: 700000 });
    await reconOk(s);
  });
});

// Counting exactly what the system expects must not create any stock movement.
describe('stocktake of an untouched product is a no-op', () => {
  it('counted = system writes no movement, stores diff 0 / value 0', async () => {
    const s = await setup();
    const p = await pool20(s);
    const before = num(s, 'SELECT COUNT(*) FROM stock_movements');
    const r = await count(s, [{ productId: p, countedQty: 20 }]);
    expect(r.body.item.items[0]).toMatchObject({ expectedQty: 20, differenceQty: 0, valueDeltaCents: 0 });
    expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(before);
    const empty = await mkProduct(s);
    const r2 = await count(s, [{ productId: empty.id, countedQty: 0 }]);
    expect(r2.body.item.items[0]).toMatchObject({ expectedQty: 0, differenceQty: 0, valueDeltaCents: 0 });
    expect(stNew).toBeDefined();
  });
});
