// PHASE 19 - AUDIT of R-VR: DUPLICATES, CONCURRENCY, REPLAYS and RAW-SQL ATTACKS (audit item 12). New worlds, new numbers (worked out by hand in the comments).
//
// Base world "X" (used by most tests): Shop opening 100,000 (05-01). Buy 10 units for 1,000 (05-01). Sale (05-02) 6 @300 = 1,800 (cogs round(1,000x6/10) = 600 -> pool 4/400); cash 99,000+1,800 = 100,800.
//   Return R (05-03) of 4 units resalable: refund 4 x 300 = 1,200, cogs round(600x4/6) = 400 -> pool 8/800, cash 99,600.
//   Void R: pool 4/400, cash 100,800. Exactly ONE refund row (-1,200) and ONE reversal row (+1,200); exactly ONE restock (+4/+400) and ONE reversal (-4/-400) movement.
// The structural checker `assertReturnLedgers` (helpers/phase19rv.ts) counts these per return after every step.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { post } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, lossVoid, mvsByRef, poolOf, sql } from './helpers/phase4.ts';
import { openNew } from './helpers/phase8.ts';
import { cashOfRef, cl, lossRows, returnNew, returnOk, rl, sellOk, voidSaleNew } from './helpers/phase5.ts';
import { diffSnapshots, shopIdentity, snapshotAll } from './helpers/phase14.ts';
import { returnedQtyMismatches, voidReturnNew, voidReturnOk } from './helpers/phase17.ts';
import { assertReturnLedgers, cashOf, cnt, pnl, reconAll, rows } from './helpers/phase19rv.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const mk = (s: ApiBase) => mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 });
const check = async (s: ApiBase): Promise<void> => { await reconAll(s); assertReturnLedgers(s.ctx); expect(returnedQtyMismatches(s.ctx)).toBe(0); };

/** World X: product, sale of 6, return R of 4 (not void yet). */
async function worldX(s: ApiBase) {
  const X = await mk(s);
  await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
  await buy(s, [{ productId: X.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-05-01' });
  const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-05-02' })).sales[0];
  const clientRef = ref();
  const rr = await returnNew(s, sale.id, [rl(sale.items[0].id, 4, true)], { businessDate: '2025-05-03', clientRef });
  expect(rr.status).toBe(201);
  expect(cashOf(s, 'shop')).toBe(99600);
  expect(poolOf(s, X.id)).toEqual({ qty: 8, value: 800 });
  return { X, sale, R: rr.body.item, clientRef, line: sale.items[0] };
}

describe('double void, concurrent voids, replays', () => {
  it('8 concurrent void requests: exactly one 200, seven ALREADY_VOID; one reversal cash row, one reversal movement', async () => {
    const s = await setup();
    const w = await worldX(s);
    const rs = await Promise.all(Array.from({ length: 8 }, () => voidReturnNew(s, w.sale.id, w.R.id, 'racing')));
    const codes = rs.map((r) => (r.status === 200 ? 'OK' : err(r).code)).sort();
    expect(codes).toEqual(['ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'ALREADY_VOID', 'OK']);
    expect(cashOf(s, 'shop')).toBe(100800);
    expect(poolOf(s, w.X.id)).toEqual({ qty: 4, value: 400 });
    expect(cashOfRef(s, 'sales_returns', w.R.id).map((c) => c.amount_cents)).toEqual([-1200, 1200]);
    expect(mvsByRef(s, 'sales_returns', w.R.id).map((m) => [m.qty, m.value])).toEqual([[4, 400], [-4, -400]]);
    expect(sql(s, "SELECT COUNT(*) n FROM audit_logs WHERE entity = 'sale_return' AND action = 'void'")[0]!.n).toBe(1);
    await check(s);
  });

  it('8 concurrent REPLAYS of the original return clientRef after the void: nothing is created, the saved (void) return comes back', async () => {
    const s = await setup();
    const w = await worldX(s);
    await voidReturnOk(s, w.sale.id, w.R.id);
    const before = snapshotAll(s.ctx);
    const rs = await Promise.all(Array.from({ length: 8 }, () => returnNew(s, w.sale.id, [rl(w.line.id, 4, true)], { businessDate: '2025-05-03', clientRef: w.clientRef })));
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect(r.body.item).toMatchObject({ id: w.R.id, status: 'void' });
    }
    expect(diffSnapshots(before, snapshotAll(s.ctx))).toEqual([]);
    // the same clientRef on a DIFFERENT sale is a conflict, also after the void
    const other = (await sellOk(s, [cl(w.X.id, 1, 300)], { businessDate: '2025-05-04' })).sales[0];
    const c = await returnNew(s, other.id, [rl(other.items[0].id, 1, true)], { businessDate: '2025-05-05', clientRef: w.clientRef });
    expect(c.status).toBe(409);
    expect(err(c).code).toBe('CLIENT_REF_CONFLICT');
    await check(s);
  });

  it('8 concurrent returns with ONE new clientRef: one return, one refund row, one restock', async () => {
    const s = await setup();
    const w = await worldX(s);
    const clientRef = ref();
    const rs = await Promise.all(Array.from({ length: 8 }, () => returnNew(s, w.sale.id, [rl(w.line.id, 1, true)], { businessDate: '2025-05-04', clientRef })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.item.id)).size).toBe(1);
    // refund 300; cogs: line 6, returned 4 before -> now 5 of 6: round(600x1/6) = 100 -> pool 9/900
    expect(poolOf(s, w.X.id)).toEqual({ qty: 9, value: 900 });
    expect(cashOf(s, 'shop')).toBe(99300);
    expect(cnt(s.ctx, 'sales_returns')).toBe(2);
    await check(s);
  });

  it('voids of an older and a newer return fired together: the newer one always succeeds, the older one either follows (200) or is refused (RETURN_NOT_NEWEST); never inconsistent', async () => {
    const s = await setup();
    const w = await worldX(s);
    const R2 = (await returnOk(s, w.sale.id, [rl(w.line.id, 2, true)], { businessDate: '2025-05-04' })).item; // 6 of 6: remainder rev 600, cogs 600-400 = 200
    expect([R2.refundCents, R2.cogsReversedCents]).toEqual([600, 200]);
    const [a, b] = await Promise.all([voidReturnNew(s, w.sale.id, w.R.id), voidReturnNew(s, w.sale.id, R2.id)]);
    expect(b.status).toBe(200);
    expect([200, 409]).toContain(a.status);
    if (a.status === 409) expect(err(a).code).toBe('RETURN_NOT_NEWEST');
    await check(s);
    // whichever happened, the second (if refused) can be voided now and the world returns to the original
    if (a.status === 409) await voidReturnOk(s, w.sale.id, w.R.id);
    expect(cashOf(s, 'shop')).toBe(100800);
    expect(poolOf(s, w.X.id)).toEqual({ qty: 4, value: 400 });
    await check(s);
  });

  it('sale void and return void fired together: either order leaves a consistent book (HAS_RETURNS or ok), never a duplicate reversal', async () => {
    const s = await setup();
    const w = await worldX(s);
    const [a, b] = await Promise.all([voidSaleNew(s, w.sale.id), voidReturnNew(s, w.sale.id, w.R.id)]);
    const codeA = a.status === 200 ? 'OK' : err(a).code;
    expect(['OK', 'HAS_RETURNS']).toContain(codeA);
    expect(b.status).toBe(200); // the return void always works (it is the first useful call or comes first in the queue)
    if (codeA === 'HAS_RETURNS') expect((await voidSaleNew(s, w.sale.id)).status).toBe(200);
    // sale void + return void: cash back to opening - purchase = 99,000; stock back to 10/1,000
    expect(cashOf(s, 'shop')).toBe(99000);
    expect(poolOf(s, w.X.id)).toEqual({ qty: 10, value: 1000 });
    await check(s);
  });
});

// void -> re-return -> void -> re-return ... three cycles (hand figures).
//   Each cycle: return 2 of the 6 (cogs round(600x2/6)=200, refund 600; pool 6/600 then void -> 4/400). Because every earlier return is void, the line counter is 0 each time, so
//   the second request is again a normal partial return (not a remainder). After 3 cycles: 3 void returns, 6 cash rows (3 refunds -600, 3 reversals +600), 3+3 movements.
describe('cycles and ordering with the sale', () => {
  it('void -> re-return -> void three times: exactly one refund + one reversal per return; the sale can be voided at the end', async () => {
    const s = await setup();
    const X = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-06-01', amountCents: 100000 });
    await buy(s, [{ productId: X.id, packs: 1, packSize: 10, lineTotalCents: 1000 }], { businessDate: '2025-06-01' });
    const sale = (await sellOk(s, [cl(X.id, 6, 300)], { businessDate: '2025-06-02' })).sales[0];
    const ids: number[] = [];
    for (let k = 0; k < 3; k++) {
      const r = (await returnOk(s, sale.id, [rl(sale.items[0].id, 2, true)], { businessDate: `2025-06-0${3 + k}` })).item;
      expect([r.refundCents, r.cogsReversedCents]).toEqual([600, 200]);
      expect(poolOf(s, X.id)).toEqual({ qty: 6, value: 600 });
      await voidReturnOk(s, sale.id, r.id);
      expect(poolOf(s, X.id)).toEqual({ qty: 4, value: 400 });
      ids.push(r.id);
      await check(s);
    }
    expect(cnt(s.ctx, 'sales_returns')).toBe(3);
    expect(rows(s.ctx, "SELECT COUNT(*) n FROM cash_entries WHERE ref_table = 'sales_returns'")[0]!.n).toBe(6);
    expect(rows(s.ctx, "SELECT COUNT(*) n FROM stock_movements WHERE ref_table = 'sales_returns'")[0]!.n).toBe(6);
    expect(cashOf(s, 'shop')).toBe(100800);
    const sv = await voidSaleNew(s, sale.id);
    expect(sv.status).toBe(200);
    expect(cashOf(s, 'shop')).toBe(99000);
    expect(poolOf(s, X.id)).toEqual({ qty: 10, value: 1000 });
    expect(rows(s.ctx, "SELECT COUNT(*) n FROM cash_entries WHERE ref_table = 'sales_returns'")[0]!.n).toBe(6);
    expect(await shopIdentity(s)).toEqual({ reportProfit: 0, ledgerProfit: 0 });
    await check(s);
  });

  it('a sale with two posted returns cannot be voided (HAS_RETURNS, nothing written) until BOTH returns are void', async () => {
    const s = await setup();
    const w = await worldX(s);
    const R2 = (await returnOk(s, w.sale.id, [rl(w.line.id, 1, true)], { businessDate: '2025-05-04' })).item;
    const snap = snapshotAll(s.ctx);
    expect(err(await voidSaleNew(s, w.sale.id)).code).toBe('HAS_RETURNS');
    expect(diffSnapshots(snap, snapshotAll(s.ctx))).toEqual([]);
    await voidReturnOk(s, w.sale.id, R2.id);
    expect(err(await voidSaleNew(s, w.sale.id)).code).toBe('HAS_RETURNS');
    await voidReturnOk(s, w.sale.id, w.R.id);
    expect((await voidSaleNew(s, w.sale.id)).status).toBe(200);
    await check(s);
    // nothing about the voided sale's returns can be changed any more
    for (const id of [R2.id, w.R.id]) {
      const x = await voidReturnNew(s, w.sale.id, id);
      expect(err(x).code).toBe('ALREADY_VOID');
    }
    expect(err(await returnNew(s, w.sale.id, [rl(w.line.id, 1, true)], { businessDate: '2025-05-06' })).code).toBe('SALE_VOID');
    await check(s);
  });

  // Purchases interleaved (hand figures). Purchase A 5 units/500, purchase B 3 units/330 (05-01), opening 100,000. Pool 8/830.
  //   Sale 4 @300 = 1,200: cogs round(830x4/8) = 415 -> 4/415.  Return 3 res: cogs round(415x3/4) = round(311.25) = 311 -> 7/726; refund 900.
  //   VOID PURCHASE B (3 units / 330): its movement is negated exactly: 4/396. cash +330.
  //   void the SALES RETURN: needs 3 <= 4: removes min(311, 396) = 311 -> 1/85. cash +900.   (pool value 85 stays for the last unit)
  //   Now voiding purchase A (5 units) is impossible (only 1 on hand): 422 INSUFFICIENT_STOCK and nothing written.
  //   profit: sale 1,200 - cost 415 = 785; purchase void: refund gain = 330 - removed 330 = 0. cash 100,000 -500 -330 +1,200 -900 +330 +900 = 100,700; stock 85 -> +785. ok
  it('purchase void between a sales return and its void; purchase return and void refusals write nothing', async () => {
    const s = await setup();
    const P = await mk(s);
    await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 100000 });
    const A = await buy(s, [{ productId: P.id, packs: 1, packSize: 5, lineTotalCents: 500 }], { businessDate: '2025-05-01' });
    const B = await buy(s, [{ productId: P.id, packs: 1, packSize: 3, lineTotalCents: 330 }], { businessDate: '2025-05-01' });
    const sale = (await sellOk(s, [cl(P.id, 4, 300)], { businessDate: '2025-05-02' })).sales[0];
    expect(sale.items[0].cogsCents).toBe(415);
    const R = (await returnOk(s, sale.id, [rl(sale.items[0].id, 3, true)], { businessDate: '2025-05-03' })).item;
    expect([R.refundCents, R.cogsReversedCents]).toEqual([900, 311]);
    expect(poolOf(s, P.id)).toEqual({ qty: 7, value: 726 });
    const pv = await post(s.app, `/purchases/${B.id}/void`, { reason: 'wrong supplier' });
    expect(pv.status).toBe(200);
    expect(poolOf(s, P.id)).toEqual({ qty: 4, value: 396 });
    await check(s);
    await voidReturnOk(s, sale.id, R.id);
    expect(poolOf(s, P.id)).toEqual({ qty: 1, value: 85 });
    const snap = snapshotAll(s.ctx);
    const pa = await post(s.app, `/purchases/${A.id}/void`, { reason: 'too late' });
    expect(pa.status).toBe(422);
    expect(err(pa).code).toBe('INSUFFICIENT_STOCK');
    expect(diffSnapshots(snap, snapshotAll(s.ctx))).toEqual([]);
    expect(cashOf(s, 'shop')).toBe(100700);
    const t = (await pnl(s, 'shop', '2025-05-01', '2025-05-31')).totals;
    expect(t.netProfitCents).toBe(785);
    expect(t.adjustments).toMatchObject({ netCents: 0, purchaseRefundGainCents: 0, salesReturnVoidGainCents: 0 });
    expect(await shopIdentity(s)).toEqual({ reportProfit: 785, ledgerProfit: 785 });
    await check(s);
  });

  it('a damaged-return loss can never be voided on its own (API), before or after its return is void; its stock effect stays absent', async () => {
    const s = await setup();
    const w = await worldX(s);
    const D = (await returnOk(s, w.sale.id, [rl(w.line.id, 2, false)], { businessDate: '2025-05-04' })).item; // 6 of 6: remainder: rev 600, cogs 600-400 = 200 (damaged)
    expect([D.refundCents, D.cogsReversedCents]).toEqual([600, 200]);
    const loss = lossRows(s)[0]!;
    expect(Number(loss.cost_cents)).toBe(200);
    const snap = snapshotAll(s.ctx);
    expect(err(await lossVoid(s, Number(loss.id))).code).toBe('DAMAGED_RETURN_LOSS');
    expect(diffSnapshots(snap, snapshotAll(s.ctx))).toEqual([]);
    await voidReturnOk(s, w.sale.id, D.id);
    expect(sql(s, 'SELECT status FROM stock_losses WHERE id = ?', Number(loss.id))).toEqual([{ status: 'void' }]);
    expect(err(await lossVoid(s, Number(loss.id))).code).toBe('DAMAGED_RETURN_LOSS');
    expect(poolOf(s, w.X.id)).toEqual({ qty: 8, value: 800 }); // no stock movement for the damaged units, either way
    await check(s);
  });
});

// =====================================================================================================================================
// RAW SQL ATTACKS inside the test database. Each statement runs in a SAVEPOINT that is always rolled back; the DATABASE must refuse it. After every
// attempt the whole database must be byte-identical to before.
// Base: world X with R voided (pool 4/400), then a second return P of 2 units POSTED (cogs round(600x2/6) = 200, refund 600 -> pool 6/600), and a different sale Q (1 unit) with a posted return.
// =====================================================================================================================================
describe('raw SQL attempts are refused by the database', () => {
  async function attackWorld(s: ApiBase) {
    const w = await worldX(s);
    await voidReturnOk(s, w.sale.id, w.R.id);
    const P = (await returnOk(s, w.sale.id, [rl(w.line.id, 2, true)], { businessDate: '2025-05-04' })).item;
    const sale2 = (await sellOk(s, [cl(w.X.id, 1, 300)], { businessDate: '2025-05-05' })).sales[0];
    const Q = (await returnOk(s, sale2.id, [rl(sale2.items[0].id, 1, true)], { businessDate: '2025-05-06' })).item;
    const origCash = (rid: number) => rows(s.ctx, "SELECT * FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? AND reverses_entry_id IS NULL", rid)[0]!;
    return { ...w, P, Q, sale2, origCash };
  }
  /** Runs `sqlText` in a savepoint, always rolls back; returns the abort message, or null when the statement was accepted. */
  function attempt(s: ApiBase, sqlText: string): string | null {
    const c = s.ctx.database.conn;
    const before = snapshotAll(s.ctx);
    c.exec('SAVEPOINT p19');
    let msg: string | null = null;
    try { c.exec(sqlText); } catch (e: any) { msg = String(e.message); }
    c.exec('ROLLBACK TO p19'); c.exec('RELEASE p19');
    expect(diffSnapshots(before, snapshotAll(s.ctx)), 'rollback restores everything').toEqual([]);
    return msg;
  }

  it('second reversal cash entry, reversal of a posted return, reversal pointing elsewhere, wrong amount/date/book/type: all refused', async () => {
    const s = await setup();
    const w = await attackWorld(s);
    const o = w.origCash(w.R.id); // refund of the VOID return R: -1,200
    const ins = (over: Record<string, string | number>) => {
      const v = { book: "'shop'", date: "'2025-05-03'", type: "'sale_refund'", amt: 1200, rt: "'sales_returns'", rid: w.R.id, rev: o.id, ...over };
      return `INSERT INTO cash_entries (book,business_date,type,amount_cents,ref_table,ref_id,reverses_entry_id) VALUES (${v.book},${v.date},${v.type},${v.amt},${v.rt},${v.rid},${v.rev})`;
    };
    expect(attempt(s, ins({}))).toMatch(/UNIQUE|RETURN_REVERSAL/i); // a second reversal of the same original
    expect(attempt(s, ins({ amt: 600 }))).toMatch(/UNIQUE|RETURN_REVERSAL/i);
    expect(attempt(s, ins({ amt: 1201 }))).toMatch(/UNIQUE|RETURN_REVERSAL/i);
    expect(attempt(s, ins({ date: "'2025-05-04'" }))).toMatch(/UNIQUE|RETURN_REVERSAL/i);
    // reversal of the POSTED return P (not void): refused
    const op = w.origCash(w.P.id);
    expect(attempt(s, ins({ rid: w.P.id, rev: op.id, amt: 600, date: "'2025-05-04'" }))).toMatch(/RETURN_REVERSAL_INVALID/);
    // reversal of R's refund but booked under another return / sale (link mismatch)
    expect(attempt(s, ins({ rid: w.Q.id, rev: o.id, amt: 1200, date: "'2025-05-03'" }))).toMatch(/RETURN_REVERSAL_INVALID/);
    // a reversal with no link at all (positive entry on a return) is refused
    expect(attempt(s, ins({ rev: 'NULL' }))).toMatch(/RETURN_REVERSAL_INVALID/);
    // a reversal row of a void return that is not linked to ITS original (links the refund of another return)
    const oq = w.origCash(w.Q.id);
    expect(attempt(s, ins({ rev: oq.id }))).toMatch(/RETURN_REVERSAL_INVALID|UNIQUE/);
    // the legitimate reversal exists and is exactly one
    expect(rows(s.ctx, "SELECT COUNT(*) n FROM cash_entries WHERE reverses_entry_id = ?", o.id)[0]!.n).toBe(1);
    await check(s);
  });

  it('second reversal movement beyond the restocked quantity, reversal movement for a posted return: refused', async () => {
    const s = await setup();
    const w = await attackWorld(s);
    const mv = (pid: number, type: string, q: number, v: number, rid: number) =>
      `INSERT INTO stock_movements (product_id,business_date,type,qty_delta,value_delta_cents,ref_table,ref_id) VALUES (${pid},'2025-05-03','${type}',${q},${v},'sales_returns',${rid})`;
    // R restocked 4 units and already has its reversal of -4: one more unit out is refused (cap), whatever the value
    expect(attempt(s, mv(w.X.id, 'sale_return', -1, -1, w.R.id))).toMatch(/RETURN_REVERSAL_EXCEEDS/);
    expect(attempt(s, mv(w.X.id, 'sale_return', -1, -100, w.R.id))).toMatch(/RETURN_REVERSAL_EXCEEDS/);
    expect(attempt(s, mv(w.X.id, 'sale_return', -4, -400, w.R.id))).toMatch(/RETURN_REVERSAL_EXCEEDS/);
    // outflow movements of the POSTED return P (restocked 2): refused, whatever the shape
    expect(attempt(s, mv(w.X.id, 'sale_return', -1, -100, w.P.id))).toMatch(/RETURN_NOT_VOID/);
    expect(attempt(s, mv(w.X.id, 'adjustment', 0, -3, w.P.id))).toMatch(/RETURN_NOT_VOID/);
    expect(attempt(s, mv(w.X.id, 'sale_return', 0, -3, w.P.id))).toMatch(/RETURN_NOT_VOID/);
    await check(s);
  });

  it('edit / delete / revive of a void return, its lines, its loss rows and ledger rows are refused', async () => {
    const s = await setup();
    const w = await attackWorld(s);
    const R = w.R.id; const P = w.P.id;
    for (const upd of [`status='posted'`, `status='posted', voided_at=NULL, void_reason=NULL`, `void_reason='x'`, `voided_at='2099-01-01'`, `refund_cents=1`, `cogs_reversed_cents=1`,
      `extra_cost_reversed_cents=1`, `business_date='2025-05-09'`, `note='x'`, `client_ref='zz'`, `sale_id=${w.sale2.id}`, `posted_at='2020-01-01'`]) {
      expect(attempt(s, `UPDATE sales_returns SET ${upd} WHERE id = ${R}`), `UPDATE void return SET ${upd}`).not.toBeNull();
    }
    // a posted return: nothing but the valid transition may change
    for (const upd of [`refund_cents=1`, `status='void'`, `status='void', voided_at='x', void_reason='y', refund_cents=1`, `status='void', voided_at='x'`, `status='void', void_reason='y'`, `note='x'`]) {
      expect(attempt(s, `UPDATE sales_returns SET ${upd} WHERE id = ${P}`), `UPDATE posted return SET ${upd}`).not.toBeNull();
    }
    // return lines are frozen
    expect(attempt(s, `UPDATE sales_return_items SET qty = qty + 1 WHERE sales_return_id = ${R}`)).toMatch(/append-only/);
    expect(attempt(s, `UPDATE sales_return_items SET revenue_cents = 1 WHERE sales_return_id = ${P}`)).toMatch(/append-only/);
    // deletes
    for (const t of ['sales_returns', 'sales_return_items', 'cash_entries', 'stock_movements', 'audit_logs', 'sales', 'sale_items']) {
      expect(attempt(s, `DELETE FROM ${t}`), `DELETE FROM ${t}`).not.toBeNull();
    }
    expect(attempt(s, `DELETE FROM sales_returns WHERE id = ${R}`)).toMatch(/append-only/);
    // the original refund / reversal and the movements cannot be edited
    expect(attempt(s, `UPDATE cash_entries SET amount_cents = 0 WHERE ref_table = 'sales_returns' AND ref_id = ${R}`)).not.toBeNull();
    expect(attempt(s, `UPDATE stock_movements SET value_delta_cents = 0 WHERE ref_table = 'sales_returns' AND ref_id = ${R}`)).not.toBeNull();
    // the counter: cannot be lowered without a voided return behind it, cannot be raised above qty, cannot be set to a wrong sum
    expect(attempt(s, `UPDATE sale_items SET returned_qty = 0 WHERE id = ${w.sale2.items[0].id}`)).toMatch(/SALE_ITEM_IMMUTABLE/); // Q is posted
    expect(attempt(s, `UPDATE sale_items SET returned_qty = 1 WHERE id = ${w.line.id}`)).toMatch(/SALE_ITEM_IMMUTABLE/); // posted sum is 2, R is void
    expect(attempt(s, `UPDATE sale_items SET returned_qty = 7 WHERE id = ${w.line.id}`)).not.toBeNull();
    expect(attempt(s, `UPDATE sale_items SET qty = 7 WHERE id = ${w.line.id}`)).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(attempt(s, `UPDATE sale_items SET cogs_cents = 1 WHERE id = ${w.line.id}`)).toMatch(/SALE_ITEM_IMMUTABLE/);
    await check(s);
  });

  it('a damaged-return loss row cannot be voided directly while its return is posted (database guard)', async () => {
    const s = await setup();
    const w = await worldX(s);
    const D = (await returnOk(s, w.sale.id, [rl(w.line.id, 1, false)], { businessDate: '2025-05-04' })).item; // 5 of 6: cogs round(600/6) = 100
    expect(D.cogsReversedCents).toBe(100);
    const ls = lossRows(s)[0]!;
    const c = s.ctx.database.conn;
    const before = snapshotAll(s.ctx);
    c.exec('SAVEPOINT q');
    let msg = '';
    try { c.exec(`UPDATE stock_losses SET status='void', voided_at='2025-01-01T00:00:00Z', void_reason='x' WHERE id = ${ls.id}`); } catch (e: any) { msg = String(e.message); }
    c.exec('ROLLBACK TO q'); c.exec('RELEASE q');
    expect(msg).toMatch(/DAMAGED_RETURN_LOSS/);
    expect(diffSnapshots(before, snapshotAll(s.ctx))).toEqual([]);
    await check(s);
  });
});
