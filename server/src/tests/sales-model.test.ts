// Randomized model check for Phase 5 (sales, returns, voids) - API level plus an independent BigInt model.
// IDEA: run a long, pseudo-random but fully repeatable series of REAL API operations: single and mixed-book sales, sales returns
// (resalable and damaged, partial and completing), sale voids, refused operations (over-return, return before the sale date, return
// on a void sale, void of a sale with returns, double void, selling more than is in stock) AND the Phase 3/4 operations that move
// the same pools (purchases, purchase voids, stock losses and their voids, stocktakes). In parallel an independent model, written only
// from the documented rules (BUSINESS_RULES sections 3, 4, C5, C6 and API_CONTRACTS Phase 5) with its OWN BigInt rounding, predicts every
// pool, every sale line's revenue and COGS, and every return portion. After EVERY step:
//   * the database pool of each product equals the model; the movement ledger equals the cache; nothing is negative; qty 0 means value 0;
//     reconcileStock is ok;
//   * sum over sale lines of revenue / COGS minus what returns took back equals the model (posted sales only);
//   * the cash ledger of sales and refunds equals that net revenue, per book;
//   * damaged-return losses (count and cost) and resalable restock movements equal the model;
//   * a blocked operation leaves every table and the model unchanged.
// WHY a seeded PRNG (mulberry32): the sequence looks random and finds odd combinations nobody would write by hand, yet the same seed
// always produces the same run, so a failure can be replayed exactly. Three seeds x 300 operations; a final test makes sure every kind of
// operation and every refused path was exercised (the run cannot pass by accident while doing nothing).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { ledgerOf, num, poolOf } from './helpers/phase4.ts';
import { cl, mdr, returnNew, rl, sellNew, snap5, voidSaleNew } from './helpers/phase5.ts';
import { reconcileStock } from '../services/inventory.service.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

// Deterministic random numbers: the same seed always gives the same sequence in [0, 1).
// ---------- seeded PRNG ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the independent model ----------
interface Pool { q: bigint; v: bigint }
/** Value an outflow of `q` units removes: the whole value when the whole pool leaves, else round(value x q / qty). */
function outValue(p: Pool, q: bigint): bigint { return q === p.q ? p.v : mdr(p.v, q, p.q); }

/** Pools of every product; `add` applies one movement (quantity and value change). */
class Pools {
  pools = new Map<number, Pool>();
  pool(pid: number): Pool {
    let p = this.pools.get(pid);
    if (!p) { p = { q: 0n, v: 0n }; this.pools.set(pid, p); }
    return p;
  }
  add(pid: number, dq: bigint, dv: bigint): void { const p = this.pool(pid); p.q += dq; p.v += dv; }
  snapshot(): string { return JSON.stringify([...this.pools.entries()].map(([k, p]) => [k, p.q.toString(), p.v.toString()])); }
}

/** One sold line as the model remembers it (frozen revenue/COGS and what returns already took back). */
interface Line { itemId: number; pid: number; qty: number; rev: number; cogs: number; rq: number; rrev: number; rcogs: number }
/** A sale as the model remembers it. */
interface SaleRec { id: number; book: 'shop' | 'telecom'; age: number; lines: Line[]; voided: boolean; returns: number }
interface PurchaseRec { id: number; pid: number; units: number; total: number; age: number; voided: boolean }
interface LossRec { id: number; pid: number; q: number; cost: number; voided: boolean }

/**
 * Runs one seeded scenario of `steps` operations and returns how many times each kind of operation happened.
 * Each iteration picks an operation by probability, performs it through the API, applies the SAME documented rule to the model, and then
 * compares the database with the model (check()).
 */
async function runModel(seed: number, steps: number): Promise<Record<string, number>> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const rnd = mulberry32(seed);
  const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(a: T[]): T => a[ri(0, a.length - 1)]!;
  const chance = (p: number): boolean => rnd() < p;

  const s: ApiBase = await apiBase(await env.build());
  const shop: number[] = []; const tel: number[] = [];
  for (let i = 0; i < 3; i++) shop.push((await mkProduct(s, { name: `M-shop-${i}`, minPriceCents: 0 })).id);
  for (let i = 0; i < 2; i++) tel.push((await mkTelecom(s, { name: `M-tel-${i}`, minPriceCents: 0 })).id);
  const all = [...shop, ...tel];
  const bookOf = (pid: number): 'shop' | 'telecom' => (tel.includes(pid) ? 'telecom' : 'shop');

  const m = new Pools();
  for (const pid of all) m.pool(pid);
  const sales: SaleRec[] = []; const purchases: PurchaseRec[] = []; const losses: LossRec[] = [];
  const stats: Record<string, number> = {};
  const hit = (k: string): void => { stats[k] = (stats[k] ?? 0) + 1; };
  const randDay = (): number => (chance(0.5) ? 0 : ri(1, 15));
  // Model totals that the aggregate checks compare with SQL sums.
  const agg = { resalableCogs: 0, damagedLines: 0, damagedCogs: 0 };

  // Opening stock so that sales are possible from the start (a purchase through the API, mirrored in the model).
  for (const pid of all) {
    const units = ri(8, 20); const total = ri(1, 3000) * units + ri(0, units);
    const res = await post(s.app, '/purchases', { businessDate: today(), items: [{ productId: pid, packs: 1, packSize: units, lineTotalCents: total }], clientRef: ref() });
    expect(res.status).toBe(201);
    m.add(pid, BigInt(units), BigInt(total));
  }

  /** Net revenue / COGS of the posted sales according to the model (sold minus returned), per book. */
  const modelNet = (): { rev: Record<string, number>; cogs: number } => {
    const rev: Record<string, number> = { shop: 0, telecom: 0 }; let cogs = 0;
    for (const sa of sales) {
      if (sa.voided) continue;
      for (const l of sa.lines) { rev[sa.book] = (rev[sa.book] ?? 0) + l.rev - l.rrev; cogs += l.cogs - l.rcogs; }
    }
    return { rev, cogs };
  };

  // The per-step comparison (see the file header).
  const check = (label: string): void => {
    for (const pid of all) {
      const p = m.pool(pid);
      const db = poolOf(s, pid);
      expect(db, `${label}: product ${pid}`).toEqual({ qty: Number(p.q), value: Number(p.v) });
      expect(ledgerOf(s, pid), `${label}: ledger ${pid}`).toEqual(db);
      expect(db.qty).toBeGreaterThanOrEqual(0);
      expect(db.value).toBeGreaterThanOrEqual(0);
      if (db.qty === 0) expect(db.value, label).toBe(0);
    }
    expect(reconcileStock(s.ctx.database.conn).ok, label).toBe(true);
    const net = modelNet();
    // sale lines minus returned portions (posted sales only)
    expect(num(s, `SELECT COALESCE(SUM(i.revenue_cents),0) FROM sale_items i JOIN sales x ON x.id = i.sale_id WHERE x.status = 'posted'`)
      - num(s, `SELECT COALESCE(SUM(r.revenue_cents),0) FROM sales_return_items r JOIN sale_items i ON i.id = r.sale_item_id JOIN sales x ON x.id = i.sale_id WHERE x.status = 'posted'`),
    `${label}: net revenue`).toBe(net.rev.shop! + net.rev.telecom!);
    expect(num(s, `SELECT COALESCE(SUM(i.cogs_cents),0) FROM sale_items i JOIN sales x ON x.id = i.sale_id WHERE x.status = 'posted'`)
      - num(s, `SELECT COALESCE(SUM(r.cogs_cents),0) FROM sales_return_items r JOIN sale_items i ON i.id = r.sale_item_id JOIN sales x ON x.id = i.sale_id WHERE x.status = 'posted'`),
    `${label}: net cogs`).toBe(net.cogs);
    // cash of sales and refunds per book (a void adds its own reversal, so voided sales net to 0)
    expect(num(s, `SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE type IN ('sale_goods','sale_refund')`), `${label}: shop cash`).toBe(net.rev.shop);
    expect(num(s, `SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE type IN ('card_sale','card_refund')`), `${label}: telecom cash`).toBe(net.rev.telecom);
    // the stock side: sale movements = all sold cost of POSTED sales (a void's reversal cancels it); restocks and write-offs match
    let soldCogs = 0;
    for (const sa of sales) if (!sa.voided) for (const l of sa.lines) soldCogs += l.cogs;
    expect(num(s, `SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type = 'sale'`), `${label}: sale movements`).toBe(0 - soldCogs);
    expect(num(s, `SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type = 'sale_return'`), `${label}: restock`).toBe(agg.resalableCogs);
    expect(num(s, `SELECT COUNT(*) FROM stock_losses WHERE source = 'damaged_return'`), `${label}: damaged losses`).toBe(agg.damagedLines);
    expect(num(s, `SELECT COALESCE(SUM(cost_cents),0) FROM stock_losses WHERE source = 'damaged_return' AND status = 'posted'`), `${label}: damaged cost`).toBe(agg.damagedCogs);
    expect(num(s, `SELECT COUNT(*) FROM sale_items WHERE returned_qty > qty OR returned_qty < 0`)).toBe(0);
  };

  for (let step = 1; step <= steps; step++) {
    const r = rnd();
    const before = m.snapshot();
    const tablesBefore = snap5(s);
    let label = `seed ${seed} step ${step}`;
    let expectUnchanged = false;

    if (r < 0.10) {
      // ---- purchase ----
      label += ' purchase';
      const pid = pick(all); const units = ri(1, 12);
      const total = chance(0.1) ? 0 : ri(1, 4000) * units + ri(0, units); const age = randDay();
      const res = await post(s.app, '/purchases', { businessDate: daysAgo(age), items: [{ productId: pid, packs: 1, packSize: units, lineTotalCents: total }], clientRef: ref() });
      expect(res.status, label + JSON.stringify(res.body)).toBe(201);
      m.add(pid, BigInt(units), BigInt(total));
      purchases.push({ id: res.body.item.id, pid, units, total, age, voided: false });
      hit('purchase');
    } else if (r < 0.14) {
      // ---- purchase void (only possible while the units are still in stock: otherwise INSUFFICIENT_STOCK) ----
      label += ' purchase-void';
      const cand = purchases.filter((p) => !p.voided);
      if (cand.length === 0) continue;
      const P = pick(cand); const pool = m.pool(P.pid);
      const res = await post(s.app, `/purchases/${P.id}/void`, { reason: 'model' });
      if (BigInt(P.units) > pool.q) {
        expect(res.status, label).toBe(422); expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('pvoid-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(200);
        const removed = BigInt(P.total) < pool.v ? BigInt(P.total) : pool.v;
        const sweep = pool.q - BigInt(P.units) === 0n && pool.v - removed > 0n ? pool.v - removed : 0n;
        if (sweep > 0n) m.add(P.pid, 0n, -sweep);
        m.add(P.pid, -BigInt(P.units), -removed);
        P.voided = true; hit('pvoid');
      }
    } else if (r < 0.19) {
      // ---- stock loss ----
      label += ' loss';
      const pid = pick(all); const pool = m.pool(pid);
      const q = chance(0.15) ? Number(pool.q) + ri(1, 3) : ri(1, Math.max(1, Number(pool.q)));
      const res = await post(s.app, '/stock-losses', { businessDate: daysAgo(randDay()), productId: pid, qty: q, reason: pick(['lost', 'expired', 'other']), clientRef: ref() });
      if (BigInt(q) > pool.q) {
        expect(res.status, label).toBe(422); expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('loss-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(201);
        const cost = outValue(pool, BigInt(q));
        expect(res.body.item.costCents, label).toBe(Number(cost));
        m.add(pid, -BigInt(q), -cost);
        losses.push({ id: res.body.item.id, pid, q, cost: Number(cost), voided: false });
        hit('loss');
      }
    } else if (r < 0.21) {
      // ---- manual stock loss void ----
      label += ' loss-void';
      const cand = losses.filter((x) => !x.voided);
      if (cand.length === 0) continue;
      const L = pick(cand);
      const res = await post(s.app, `/stock-losses/${L.id}/void`, { reason: 'model' });
      expect(res.status, label + JSON.stringify(res.body)).toBe(200);
      m.add(L.pid, BigInt(L.q), BigInt(L.cost)); L.voided = true; hit('loss-void');
    } else if (r < 0.26) {
      // ---- stocktake of one product (a unit cost is always supplied, used only when the pool has no average) ----
      label += ' stocktake';
      const pid = pick(all); const p = m.pool(pid);
      const counted = chance(0.2) ? 0 : chance(0.4) ? Number(p.q) + ri(1, 5) : Math.max(0, Number(p.q) - ri(0, 4));
      const unit = ri(0, 3000);
      const created = await post(s.app, '/stocktakes', { businessDate: today(), book: bookOf(pid), clientRef: ref(), items: [{ productId: pid, countedQty: counted, gainUnitCostCents: unit }] });
      expect(created.status, label + JSON.stringify(created.body)).toBe(201);
      const diff = BigInt(counted) - p.q;
      const res = await post(s.app, `/stocktakes/${created.body.item.id}/complete`, {});
      expect(res.status, label + JSON.stringify(res.body)).toBe(200);
      if (diff < 0n) m.add(pid, diff, -outValue(p, -diff));
      else if (diff > 0n) m.add(pid, diff, p.q > 0n && p.v > 0n ? mdr(p.v, diff, p.q) : diff * BigInt(unit));
      hit('stocktake');
    } else if (r < 0.46) {
      // ---- sale: a cart of 1..4 lines over any products (so carts are often MIXED across the two books) ----
      label += ' sale';
      const n = ri(1, 4);
      const cart = Array.from({ length: n }, () => ({ pid: pick(all), qty: chance(0.08) ? ri(15, 30) : ri(1, 5), price: chance(0.1) ? 0 : ri(1, 4000) }));
      const age = randDay();
      const work = new Map<number, Pool>();
      const cogs: bigint[] = []; let failIdx = -1; let onHand = 0n;
      cart.forEach((l, idx) => {
        if (failIdx >= 0) return;
        const base = m.pool(l.pid);
        const p = work.get(l.pid) ?? { q: base.q, v: base.v };
        if (BigInt(l.qty) > p.q) { failIdx = idx; onHand = p.q; return; }
        const out = outValue(p, BigInt(l.qty));
        p.q -= BigInt(l.qty); p.v -= out; work.set(l.pid, p); cogs.push(out);
      });
      const res = await sellNew(s, cart.map((l) => cl(l.pid, l.qty, l.price)), { businessDate: daysAgo(age) });
      if (failIdx >= 0) {
        expect(res.status, label + JSON.stringify(res.body)).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expect(Object.keys(res.body.error.fields), label).toEqual([`items.${failIdx}.qty`]);
        expect(res.body.error.onHand, label).toBe(Number(onHand));
        expectUnchanged = true; hit('sale-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(201);
        for (const [pid, p] of work) { const cur = m.pool(pid); cur.q = p.q; cur.v = p.v; }
        const expectedBooks = (['shop', 'telecom'] as const).filter((b) => cart.some((l) => bookOf(l.pid) === b));
        expect(res.body.sales.map((x: any) => x.book), label).toEqual(expectedBooks);
        const warn: string[] = [];
        cart.forEach((l, idx) => {
          const unit = Number(mdr(cogs[idx]!, 1n, BigInt(l.qty)));
          if (l.price < unit) warn.push(`${idx}:PRICE_BELOW_COST`);
          if (cogs[idx] === 0n) warn.push(`${idx}:ZERO_COST`);
        });
        expect(res.body.warnings.map((w: any) => `${w.lineIndex}:${w.code}`).sort(), label).toEqual(warn.sort());
        for (const sale of res.body.sales) {
          const idxs = cart.map((l, i) => i).filter((i) => bookOf(cart[i]!.pid) === sale.book);
          expect(sale.items.length, label).toBe(idxs.length);
          const rec: SaleRec = { id: sale.id, book: sale.book, age, lines: [], voided: false, returns: 0 };
          idxs.forEach((ci, k) => {
            const l = cart[ci]!; const it = sale.items[k];
            expect(it, label).toMatchObject({ lineNo: k + 1, productId: l.pid, qty: l.qty, unitPriceCents: l.price, revenueCents: l.qty * l.price, cogsCents: Number(cogs[ci]) });
            rec.lines.push({ itemId: it.id, pid: l.pid, qty: l.qty, rev: l.qty * l.price, cogs: Number(cogs[ci]), rq: 0, rrev: 0, rcogs: 0 });
          });
          expect(sale.totalCents, label).toBe(rec.lines.reduce((a, l) => a + l.rev, 0));
          expect(sale.cogsCents, label).toBe(rec.lines.reduce((a, l) => a + l.cogs, 0));
          sales.push(rec);
        }
        hit('sale'); if (expectedBooks.length === 2) hit('sale-mixed'); if (n > 1) hit('sale-multiline');
      }
    } else if (r < 0.74) {
      // ---- sales return ----
      label += ' return';
      const cand = sales.filter((x) => !x.voided && x.lines.some((l) => l.rq < l.qty));
      if (cand.length === 0) continue;
      const S = pick(cand);
      const open = S.lines.filter((l) => l.rq < l.qty);
      const chosen = [...open].sort(() => rnd() - 0.5).slice(0, ri(1, Math.min(2, open.length)));
      const mode = rnd();
      const overshoot = mode < 0.08; const tooEarly = mode >= 0.08 && mode < 0.14;
      const retAge = tooEarly ? S.age + ri(1, 5) : ri(0, S.age);
      const req = chosen.map((l) => ({ l, qty: overshoot ? l.qty - l.rq + ri(1, 2) : ri(1, l.qty - l.rq), resalable: chance(0.6) }));
      const res = await returnNew(s, S.id, req.map((x) => rl(x.l.itemId, x.qty, x.resalable)), { businessDate: daysAgo(retAge) });
      if (tooEarly) {
        expect(res.status, label).toBe(400); expect(res.body.error.code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
        expect(res.body.error.originalDate).toBe(daysAgo(S.age));
        expectUnchanged = true; hit('return-early');
      } else if (overshoot) {
        expect(res.status, label).toBe(422); expect(res.body.error.code).toBe('RETURN_EXCEEDS_SOLD');
        expectUnchanged = true; hit('return-over');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(201);
        let refund = 0; let cogsBack = 0;
        req.forEach((x, k) => {
          const l = x.l;
          const finalPart = l.rq + x.qty === l.qty;
          const remRev = l.rev - l.rrev; const remCogs = l.cogs - l.rcogs;
          const rev = finalPart ? remRev : Math.min(Number(mdr(BigInt(l.rev), BigInt(x.qty), BigInt(l.qty))), remRev);
          const cg = finalPart ? remCogs : Math.min(Number(mdr(BigInt(l.cogs), BigInt(x.qty), BigInt(l.qty))), remCogs);
          expect(res.body.item.items[k], label).toMatchObject({ saleItemId: l.itemId, qty: x.qty, resalable: x.resalable, revenueCents: rev, cogsCents: cg });
          l.rq += x.qty; l.rrev += rev; l.rcogs += cg; refund += rev; cogsBack += cg;
          if (x.resalable) { m.add(l.pid, BigInt(x.qty), BigInt(cg)); agg.resalableCogs += cg; hit('return-resalable'); }
          else { agg.damagedLines += 1; agg.damagedCogs += cg; hit('return-damaged'); }
          hit(finalPart ? 'return-final' : 'return-partial');
        });
        expect(res.body.item.refundCents, label).toBe(refund);
        expect(res.body.item.cogsReversedCents, label).toBe(cogsBack);
        S.returns += 1; hit('return');
      }
    } else if (r < 0.88) {
      // ---- sale void (also tries the refused cases: already void, has returns) ----
      label += ' sale-void';
      if (sales.length === 0) continue;
      const S = pick(sales);
      const res = await voidSaleNew(s, S.id, 'model');
      if (S.voided) {
        expect(res.status, label).toBe(409); expect(res.body.error.code).toBe('ALREADY_VOID');
        expectUnchanged = true; hit('void-already');
      } else if (S.returns > 0) {
        expect(res.status, label).toBe(409); expect(res.body.error.code).toBe('HAS_RETURNS');
        expectUnchanged = true; hit('void-has-returns');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(200);
        for (const l of S.lines) m.add(l.pid, BigInt(l.qty), BigInt(l.cogs));
        S.voided = true; hit('void');
      }
    } else {
      // ---- return against a void sale ----
      label += ' return-on-void';
      const cand = sales.filter((x) => x.voided);
      if (cand.length === 0) continue;
      const S = pick(cand);
      const res = await returnNew(s, S.id, [rl(S.lines[0]!.itemId, 1, true)]);
      expect(res.status, label).toBe(409); expect(res.body.error.code).toBe('SALE_VOID');
      expectUnchanged = true; hit('return-on-void');
    }

    if (expectUnchanged) {
      expect(m.snapshot(), label).toBe(before);
      expect(snap5(s), `${label}: a refused operation wrote something`).toEqual(tablesBefore);
    }
    check(label);
    if (step % 50 === 0) expect((await get(s.app, '/inventory/reconciliation')).body.ok).toBe(true);
  }

  // Final: the sale list totals (posted only) equal the model's, and every stored return line adds up to its sale line.
  const list = (await get(s.app, '/sales?limit=200')).body;
  const posted = sales.filter((x) => !x.voided);
  if (sales.length <= 200) {
    expect(list.total).toBe(sales.length);
    expect(list.totals.revenueCents).toBe(posted.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.rev, 0), 0));
    expect(list.totals.cogsCents).toBe(posted.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.cogs, 0), 0));
  }
  for (const x of sales) {
    for (const l of x.lines) {
      if (l.rq === l.qty) { expect(l.rrev).toBe(l.rev); expect(l.rcogs).toBe(l.cogs); }   // fully returned lines add up EXACTLY
      expect(num(s, 'SELECT returned_qty FROM sale_items WHERE id = ?', l.itemId)).toBe(l.rq);
    }
  }
  return stats;
}

// Three seeds of 300 operations each, then a coverage check over all of them.
describe('randomized model check (seeded)', () => {
  const seeds: Array<[number, number]> = [[20261111, 300], [5, 300], [987654, 300]];
  const total: Record<string, number> = {};
  // Runs one seed. The minimum counts make sure the run really contained sales, returns and voids.
  it.each(seeds)('seed %i: %i operations keep the database equal to the independent model', async (seed, steps) => {
    const stats = await runModel(seed, steps);
    for (const [k, n] of Object.entries(stats)) total[k] = (total[k] ?? 0) + n;
    if (process.env.MODEL_STATS) console.log(seed, JSON.stringify(stats));
    expect(stats.sale).toBeGreaterThan(10);
    expect(stats.return).toBeGreaterThan(5);
    expect(stats.void).toBeGreaterThan(1);
  }, 300000);

  // Coverage guard: every kind of operation and every refused path happened at least once across the seeds.
  it('across the seeds every operation kind and every refused path was exercised', () => {
    for (const k of ['purchase', 'pvoid', 'loss', 'loss-void', 'stocktake', 'sale', 'sale-mixed', 'sale-multiline', 'sale-blocked',
      'return', 'return-resalable', 'return-damaged', 'return-partial', 'return-final', 'return-over', 'return-early',
      'void', 'void-already', 'void-has-returns', 'return-on-void']) {
      expect(total[k], `kind ${k} never exercised: ${JSON.stringify(total)}`).toBeGreaterThan(0);
    }
  });
});
