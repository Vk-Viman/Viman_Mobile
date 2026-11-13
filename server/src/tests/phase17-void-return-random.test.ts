// PHASE 17 - RANDOMIZED simulation of sales, partial / multi-line / damaged returns, void-return attempts (newest-first, resales that make
// a void impossible), sale voids, repeated voids and day closings, against an INDEPENDENT in-test model of quantities and cash.
//
// After EVERY operation the test checks, from the raw tables (no report code except where noted):
//   * every cash book balance (sum of its ledger rows) = the model's balance (model: +purchase refunds never occur here; sale +revenue, refund -x, void-return +x ...);
//   * every product's quantity = the model's quantity, never negative; stock cache = sum of movements (reconciliation API);
//   * sale_items.returned_qty = sum of qty of POSTED return lines (per line, vs the model);
//   * the model's expected answer to each void attempt (200, RETURN_NOT_NEWEST naming the newest blocker, RETURN_STOCK_NOT_AVAILABLE with
//     onHand/needed, ALREADY_VOID, HAS_RETURNS, DAY_CLOSED) is exactly what the API says, and a refused attempt leaves EVERY table untouched;
//   * Shop P&L (report) = cash + stock based profit from the ledgers (accounting identity, exact), and every 5 operations the Telecom P&L
//     equals the straight-from-the-tables figure.
// At the end the global invariant checker of Phase 14 runs once over the whole database. Seeds are fixed (replayable).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get } from './helpers/catalog.ts';
import { apiBase, buy, mkProduct, mkTelecom } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { poolOf, reconOk } from './helpers/phase4.ts';
import { closeOk, reopenNew } from './helpers/phase8.ts';
import { cashBal, cl, clc, returnNew, rl, sellNew, voidSaleNew } from './helpers/phase5.ts';
import { assertGlobalInvariants, rng14, shopIdentity, snapshotAll, telecomNetFromTables } from './helpers/phase14.ts';
import { returnedQtyMismatches, voidReturnNew } from './helpers/phase17.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const DATES = ['2025-06-01', '2025-06-02', '2025-06-03', '2025-06-04', '2025-06-05', '2025-06-06', '2025-06-07', '2025-06-08'];
const LAST = '2025-06-10';

interface MItem { id: number; productId: number; qty: number; returned: number }
interface MSale { id: number; book: 'shop' | 'telecom'; date: string; totalCents: number; items: MItem[]; status: 'posted' | 'void' }
interface MRet { id: number; saleId: number; date: string; lines: Array<{ itemId: number; productId: number; qty: number; resalable: boolean }>; refund: number; status: 'posted' | 'void' }

async function simulate(seed: number, ops: number): Promise<Record<string, number>> {
  const s: ApiBase = await apiBase(await env.build());
  const rnd = rng14(seed);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  const prods = [
    { id: (await mkProduct(s, { name: 'Sim A', sellPriceCents: 1000, minPriceCents: 0 })).id as number, book: 'shop' as const },
    { id: (await mkProduct(s, { name: 'Sim B', sellPriceCents: 1000, minPriceCents: 0 })).id as number, book: 'shop' as const },
    { id: (await mkTelecom(s, { name: 'Sim C', sellPriceCents: 1000, minPriceCents: 0 })).id as number, book: 'telecom' as const },
  ];
  const qty = new Map<number, number>(prods.map((p) => [p.id, 0]));
  const cash = { shop: 0, telecom: 0 };
  const sales: MSale[] = [];
  const rets: MRet[] = [];
  const kinds: Record<string, number> = {};
  const count = (k: string) => { kinds[k] = (kinds[k] ?? 0) + 1; };
  const bookOf = (p: number) => prods.find((x) => x.id === p)!.book;

  const checkInvariants = async (label: string, full: boolean) => {
    for (const b of ['shop', 'telecom'] as const) expect(cashBal(s, b), `${label}: cash ${b}`).toBe(cash[b]);
    for (const p of prods) {
      const pool = poolOf(s, p.id);
      expect(pool.qty, `${label}: qty of product ${p.id}`).toBe(qty.get(p.id));
      expect(pool.qty >= 0 && pool.value >= 0, `${label}: negative pool`).toBe(true);
    }
    expect(returnedQtyMismatches(s.ctx), `${label}: returned_qty = sum of posted return lines`).toBe(0);
    for (const sale of sales) for (const it of sale.items) {
      const row = s.ctx.database.conn.prepare('SELECT returned_qty AS r FROM sale_items WHERE id = ?').get(it.id) as unknown as { r: number | bigint };
      expect(Number(row.r), `${label}: returned_qty of line ${it.id}`).toBe(it.returned);
    }
    await reconOk(s);
    const id = await shopIdentity(s);
    expect(id.reportProfit, `${label}: shop profit identity`).toBe(id.ledgerProfit);
    if (full) {
      const t = (await get(s.app, '/reports/pnl/telecom?from=2025-05-01&to=2025-07-01&granularity=month')).body.totals.netProfitCents;
      expect(t, `${label}: telecom profit`).toBe(telecomNetFromTables(s.ctx));
    }
  };

  /** The model's expected answer to "void return r now". */
  const expectVoid = (r: MRet): { status: number; code?: string; extra?: Record<string, number> } => {
    if (r.status === 'void') return { status: 409, code: 'ALREADY_VOID' };
    const items = new Set(r.lines.map((l) => l.itemId));
    const newer = rets.filter((o) => o.status === 'posted' && o.id > r.id && o.saleId === r.saleId && o.lines.some((l) => items.has(l.itemId)));
    if (newer.length > 0) return { status: 409, code: 'RETURN_NOT_NEWEST', extra: { newerReturnId: Math.max(...newer.map((o) => o.id)) } };
    const need = new Map<number, number>();
    for (const l of r.lines) if (l.resalable) need.set(l.productId, (need.get(l.productId) ?? 0) + l.qty);
    for (const [pid, n] of need) if ((qty.get(pid) ?? 0) < n) return { status: 409, code: 'RETURN_STOCK_NOT_AVAILABLE', extra: { productId: pid, onHand: qty.get(pid) ?? 0, needed: n } };
    return { status: 200 };
  };

  const applyVoid = (r: MRet) => {
    const sale = sales.find((x) => x.id === r.saleId)!;
    for (const l of r.lines) {
      if (l.resalable) qty.set(l.productId, qty.get(l.productId)! - l.qty);
      sale.items.find((i) => i.id === l.itemId)!.returned -= l.qty;
    }
    cash[sale.book] += r.refund;
    r.status = 'void';
  };

  let done = 0;
  while (done < ops) {
    const roll = rnd();
    const label = `seed ${seed} op ${done}`;
    if (roll < 0.2) {                                              // purchase
      const p = pick(prods);
      // 30%: a very cheap lot (pulls the weighted average down, so a later void finds the pool worth less than what the return restored = gain);
      // 20%: a very expensive lot of exactly the units still needed (pushes the pool above the restored value = residual sweep when the pool empties)
      const cheap = rnd() < 0.3;
      const units = cheap ? int(4, 8) : int(1, 8);
      const total = cheap ? int(1, 40) : rnd() < 0.3 ? int(3000, 9000) : int(100, 4000);
      await buy(s, [{ productId: p.id, packs: 1, packSize: units, lineTotalCents: total }], { businessDate: pick(DATES) });
      qty.set(p.id, qty.get(p.id)! + units);
      cash[p.book] -= total;
      count('purchase');
    } else if (roll < 0.42) {                                      // sale (one product; sometimes with raised cost)
      const avail = prods.filter((p) => qty.get(p.id)! > 0);
      if (avail.length === 0) continue;
      const p = pick(avail);
      const q = int(1, Math.min(qty.get(p.id)!, 6));
      const price = int(50, 3000);
      const pool = poolOf(s, p.id);
      let line: any = cl(p.id, q, price);
      if (rnd() < 0.35) {
        const auto = q === pool.qty ? pool.value : Math.floor((2 * pool.value * q + pool.qty) / (2 * pool.qty)); // round half up, integers only
        line = clc(p.id, q, price, Math.ceil(auto / q) + int(0, 30));
      }
      const date = pick(DATES);
      const r = await sellNew(s, [line], { businessDate: date });
      expect(r.status, label).toBe(201);
      const sale = r.body.sales[0];
      sales.push({ id: sale.id, book: p.book, date, totalCents: sale.totalCents, status: 'posted',
        items: sale.items.map((i: any) => ({ id: i.id, productId: i.productId, qty: i.qty, returned: 0 })) });
      qty.set(p.id, qty.get(p.id)! - q);
      cash[p.book] += sale.totalCents;
      count('sale');
    } else if (roll < 0.62) {                                      // return (1-2 lines of one sale; resalable or damaged)
      const open = sales.filter((x) => x.status === 'posted' && x.items.some((i) => i.qty - i.returned > 0));
      if (open.length === 0) continue;
      const sale = pick(open);
      const lines = sale.items.filter((i) => i.qty - i.returned > 0).slice(0, int(1, 2));
      const body = lines.map((i) => ({ item: i, q: int(1, i.qty - i.returned), res: rnd() < 0.7 }));
      const date = DATES.filter((d) => d >= sale.date).length > 0 && rnd() < 0.8 ? pick(DATES.filter((d) => d >= sale.date)) : LAST;
      const r = await returnNew(s, sale.id, body.map((b) => rl(b.item.id, b.q, b.res)), { businessDate: date });
      expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(201);
      const mr: MRet = { id: r.body.item.id, saleId: sale.id, date, refund: r.body.item.refundCents, status: 'posted',
        lines: body.map((b) => ({ itemId: b.item.id, productId: b.item.productId, qty: b.q, resalable: b.res })) };
      rets.push(mr);
      for (const b of body) { b.item.returned += b.q; if (b.res) qty.set(b.item.productId, qty.get(b.item.productId)! + b.q); }
      cash[sale.book] -= mr.refund;
      count('return');
    } else if (roll < 0.85) {                                      // void-return attempt (posted ones mostly; sometimes an already void one)
      const posted = rets.filter((x) => x.status === 'posted');
      const pool = rnd() < 0.15 ? rets : posted;
      if (pool.length === 0) continue;
      // half of the time aim at an OLDER return that has a newer one on the same sale, to exercise RETURN_NOT_NEWEST
      const r = rnd() < 0.5 ? pool.slice().sort((a, b) => a.id - b.id)[0]! : pick(pool);
      const exp = expectVoid(r);
      const before = exp.status === 200 ? null : snapshotAll(s.ctx);
      const res = await voidReturnNew(s, r.saleId, r.id, `sim ${done}`);
      expect(res.status, `${label}: void return #${r.id} -> ${JSON.stringify(res.body).slice(0, 200)}`).toBe(exp.status);
      if (exp.status === 200) {
        expect(res.body.item.status).toBe('void');
        applyVoid(r);
        count('voidReturn');
      } else {
        expect(res.body.error.code, label).toBe(exp.code);
        for (const [k, v] of Object.entries(exp.extra ?? {})) expect(res.body.error[k], `${label}: error.${k}`).toBe(v);
        expect(snapshotAll(s.ctx), `${label}: a refused void changes nothing`).toEqual(before);
        count(`refused:${exp.code}`);
      }
    } else if (roll < 0.91) {                                      // sale void: only possible without posted returns
      const sale = pick(sales.filter((x) => x.status === 'posted').concat(sales.filter((x) => x.status === 'void').slice(0, 1)));
      if (!sale) continue;
      const hasPosted = rets.some((r) => r.saleId === sale.id && r.status === 'posted');
      const res = await voidSaleNew(s, sale.id, 'sim');
      if (sale.status === 'void') expect(res.body.error.code).toBe('ALREADY_VOID');
      else if (hasPosted) expect(res.body.error.code, label).toBe('HAS_RETURNS');
      else {
        expect(res.status, label).toBe(200);
        sale.status = 'void';
        for (const it of sale.items) qty.set(it.productId, qty.get(it.productId)! + it.qty);
        cash[sale.book] -= sale.totalCents;
        count('voidSale');
      }
    } else if (roll < 0.955) {                                     // squeeze: sell the product down to EXACTLY the returned units, then void that return
      // (the pool then holds exactly what the return restocked; if its value is above the restored value the void must sweep the residue)
      const cand = rets.filter((r) => r.status === 'posted' && expectVoid(r).status === 200 && r.lines.every((l) => l.resalable)
        && new Set(r.lines.map((l) => l.productId)).size === 1);
      if (cand.length === 0) continue;
      const r = pick(cand);
      const pid = r.lines[0]!.productId;
      const n = r.lines.reduce((a, l) => a + l.qty, 0);
      const excess = qty.get(pid)! - n;
      if (excess < 1 || excess > 40) continue;
      for (let left = excess; left > 0; left -= 6) {
        const q = Math.min(6, left);
        const sr = await sellNew(s, [cl(pid, q, 100)], { businessDate: pick(DATES) });
        expect(sr.status, label).toBe(201);
        const sale = sr.body.sales[0];
        sales.push({ id: sale.id, book: bookOf(pid), date: sale.businessDate, totalCents: sale.totalCents, status: 'posted',
          items: sale.items.map((i: any) => ({ id: i.id, productId: i.productId, qty: i.qty, returned: 0 })) });
        qty.set(pid, qty.get(pid)! - q);
        cash[bookOf(pid)] += sale.totalCents;
      }
      const res = await voidReturnNew(s, r.saleId, r.id, 'after squeeze');
      expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      applyVoid(r);
      count('squeezeVoid');
    } else {                                                       // closing: the return's day is closed -> its void is refused DAY_CLOSED; reopen afterwards
      const cand = rets.filter((r) => r.status === 'posted' && expectVoid(r).status === 200);
      if (cand.length === 0) continue;
      const r = pick(cand);
      const book = sales.find((x) => x.id === r.saleId)!.book;
      const closing = await closeOk(s, book, r.date);
      const before = snapshotAll(s.ctx);
      const res = await voidReturnNew(s, r.saleId, r.id, 'closed day');
      expect(res.status, label).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'DAY_CLOSED', book, businessDate: r.date });
      expect(snapshotAll(s.ctx)).toEqual(before);
      expect((await reopenNew(s, closing.id, 'sim reopen')).status).toBe(200);
      count('closedDayRefused');
    }
    done += 1;
    await checkInvariants(label, done % 5 === 0);
  }
  await checkInvariants(`seed ${seed} final`, true);
  await assertGlobalInvariants(s, { skipAppendOnly: false });
  const c = s.ctx.database.conn;
  const one = (q: string) => Number((c.prepare(q).get() as unknown as { n: number | bigint }).n);
  kinds.sweepMovements = one("SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'adjustment' AND ref_table = 'sales_returns'");
  kinds.voidsWithValueGain = one(`SELECT COUNT(*) AS n FROM (SELECT m.ref_id FROM stock_movements m JOIN sales_returns r ON r.id = m.ref_id
    WHERE m.type = 'sale_return' AND m.ref_table = 'sales_returns' AND r.status = 'void' GROUP BY m.ref_id HAVING SUM(m.value_delta_cents) <> 0)`);
  return kinds;
}

const seen = { sweep: 0, gain: 0 };
describe('randomized void-return simulations vs an independent model', () => {
  it.each([[17001, 170], [17002, 170], [17003, 200], [17004, 200], [17005, 200]])('seed %i: %i operations keep model, ledgers, stock and profit identity in agreement', async (seed, ops) => {
    const kinds = await simulate(seed, ops);
    // the run must really have exercised the interesting paths
    expect(kinds.sale).toBeGreaterThan(5);
    expect(kinds.return).toBeGreaterThan(5);
    expect(kinds.voidReturn).toBeGreaterThan(3);
    console.log(`seed ${seed}`, JSON.stringify(kinds));
    seen.sweep += kinds.sweepMovements ?? 0; seen.gain += kinds.voidsWithValueGain ?? 0;
  }, 600000);
});

describe('the simulations exercised the accounting corner cases', () => {
  // Runs after the seeds above (same file, in order): across all seeds at least one void had a stock-value difference and one a residual sweep.
  it('at least one void with a value gain and one with a residual sweep happened', () => {
    expect(seen.gain).toBeGreaterThan(0);
    expect(seen.sweep).toBeGreaterThan(0);
  });
});
