import { describe, it, expect, afterEach, vi } from 'vitest';
import { AppError } from '../lib/errors.ts';
import { issueStock, reconcileStock } from '../services/inventory.service.ts';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { ledgerOf, num, poolOf, sql } from './helpers/phase4.ts';

/**
 * Randomized model check. An independent model of every product's pool (BigInt arithmetic, written from the
 * documented rules in BUSINESS_RULES section 3 / API_CONTRACTS Phase 4, NOT from the implementation) must equal
 * the database after every step, across purchases, purchase returns and voids, stocktakes (gain / loss / zero,
 * complete and void), stock losses, goods drawings (create and void) and engine sales.
 */

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

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

// ---------- model ----------
interface Pool { q: bigint; v: bigint }
interface Mov { pid: number; date: string; dq: bigint; dv: bigint }

/** round(a*b/c), half away from zero, for non-negative operands (BigInt, independent of lib/money). */
function mdr(a: bigint, b: bigint, c: bigint): bigint {
  const n = a * b;
  const q = n / c;
  return n % c * 2n >= c ? q + 1n : q;
}
/** Value an outflow of `q` units removes: whole value when the whole pool leaves, else proportional. */
function outValue(p: Pool, q: bigint): bigint { return q === p.q ? p.v : mdr(p.v, q, p.q); }

class Model {
  pools = new Map<number, Pool>();
  movs: Mov[] = [];
  pool(pid: number): Pool {
    let p = this.pools.get(pid);
    if (!p) { p = { q: 0n, v: 0n }; this.pools.set(pid, p); }
    return p;
  }
  add(pid: number, date: string, dq: bigint, dv: bigint): void {
    const p = this.pool(pid);
    p.q += dq; p.v += dv;
    this.movs.push({ pid, date, dq, dv });
  }
  snapshot(): string {
    return JSON.stringify([...this.pools.entries()].map(([k, p]) => [k, p.q.toString(), p.v.toString()]));
  }
}

interface PurchaseRec { id: number; itemId: number; pid: number; units: number; total: number; date: string; age: number; returnedUnits: number; returnedValue: number; voided: boolean }
interface StocktakeRec { id: number; movs: Array<{ pid: number; dq: bigint; dv: bigint }>; date: string; voided: boolean }
interface RowRec { id: number; pid: number; q: number; cost: number; date: string; voided: boolean }

interface Setup { s: ApiBase; shop: number[]; tel: number[]; names: Map<number, string> }

async function runModel(seed: number, steps: number): Promise<Record<string, number>> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const rnd = mulberry32(seed);
  const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(a: T[]): T => a[ri(0, a.length - 1)]!;
  const chance = (p: number): boolean => rnd() < p;

  const s = await apiBase(await env.build());
  const shop: number[] = []; const tel: number[] = []; const names = new Map<number, string>();
  for (let i = 0; i < 4; i++) { const p = await mkProduct(s, { name: `M-shop-${i}` }); shop.push(p.id); names.set(p.id, p.name); }
  for (let i = 0; i < 2; i++) { const p = await mkTelecom(s, { name: `M-tel-${i}` }); tel.push(p.id); names.set(p.id, p.name); }
  const all = [...shop, ...tel];
  const book = (pid: number): number[] => (tel.includes(pid) ? tel : shop);
  const setup: Setup = { s, shop, tel, names };
  void setup;

  const m = new Model();
  for (const pid of all) m.pool(pid);
  const purchases: PurchaseRec[] = [];
  const stocktakes: StocktakeRec[] = [];
  const losses: RowRec[] = [];
  const draws: RowRec[] = [];
  const stats: Record<string, number> = {};
  const hit = (k: string): void => { stats[k] = (stats[k] ?? 0) + 1; };
  const randDay = (): number => (chance(0.5) ? 0 : ri(1, 20));

  const dbEqualsModel = async (label: string): Promise<void> => {
    for (const pid of all) {
      const p = m.pool(pid);
      const db = poolOf(s, pid);
      expect(db, `${label}: product ${pid}`).toEqual({ qty: Number(p.q), value: Number(p.v) });
      expect(ledgerOf(s, pid), `${label}: ledger ${pid}`).toEqual(db);
      expect(db.qty).toBeGreaterThanOrEqual(0);
      expect(db.value).toBeGreaterThanOrEqual(0);
      if (db.qty === 0) expect(db.value).toBe(0);
    }
    const rec = reconcileStock(s.ctx.database.conn);
    expect(rec.ok, label).toBe(true);
  };

  for (let step = 1; step <= steps; step++) {
    const r = rnd();
    const before = m.snapshot();
    const movCountBefore = num(s, 'SELECT COUNT(*) FROM stock_movements');
    const auditBefore = num(s, 'SELECT COUNT(*) FROM audit_logs');
    let label = `seed ${seed} step ${step}`;
    let expectUnchanged = false;

    if (r < 0.17) {
      // ---- purchase ----
      label += ' purchase';
      const pid = pick(all);
      const units = ri(1, 12);
      const total = chance(0.1) ? 0 : ri(1, 4000) * units + ri(0, units);
      const age = randDay();
      const res = await post(s.app, '/purchases', {
        businessDate: daysAgo(age), items: [{ productId: pid, packs: 1, packSize: units, lineTotalCents: total }], clientRef: ref(),
      });
      expect(res.status, label + JSON.stringify(res.body)).toBe(201);
      m.add(pid, daysAgo(age), BigInt(units), BigInt(total));
      purchases.push({ id: res.body.item.id, itemId: res.body.item.items[0].id, pid, units, total, date: daysAgo(age), age, returnedUnits: 0, returnedValue: 0, voided: false });
      hit('purchase');
    } else if (r < 0.25) {
      // ---- purchase return (Phase 3, R4 / C7) ----
      label += ' purchase-return';
      const cand = purchases.filter((p) => !p.voided && p.returnedUnits < p.units);
      if (cand.length === 0) continue;
      const P = pick(cand);
      const u = ri(1, P.units - P.returnedUnits);
      const j = ri(0, P.age);
      const remainingValue = P.total - P.returnedValue;
      const v = P.returnedUnits + u === P.units ? remainingValue : Math.min(Number(mdr(BigInt(P.total), BigInt(u), BigInt(P.units))), remainingValue);
      const pool = m.pool(P.pid);
      const res = await post(s.app, `/purchases/${P.id}/returns`, { businessDate: daysAgo(j), clientRef: ref(), items: [{ purchaseItemId: P.itemId, units: u }] });
      if (BigInt(u) > pool.q) {
        expect(res.status, label).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('return-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(201);
        const removed = BigInt(v) < pool.v ? BigInt(v) : pool.v;
        const emptied = pool.q - BigInt(u) === 0n;
        const sweep = emptied && pool.v - removed > 0n ? pool.v - removed : 0n;
        if (sweep > 0n) m.add(P.pid, daysAgo(j), 0n, -sweep);
        m.add(P.pid, daysAgo(j), -BigInt(u), -removed);
        P.returnedUnits += u; P.returnedValue += v;
        hit('return'); if (sweep > 0n) hit('return-sweep');
      }
    } else if (r < 0.30) {
      // ---- purchase void (only purchases without returns) ----
      label += ' purchase-void';
      const cand = purchases.filter((p) => !p.voided && p.returnedUnits === 0);
      if (cand.length === 0) continue;
      const P = pick(cand);
      const pool = m.pool(P.pid);
      const res = await post(s.app, `/purchases/${P.id}/void`, { reason: 'model' });
      if (BigInt(P.units) > pool.q) {
        expect(res.status, label).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('pvoid-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(200);
        const removed = BigInt(P.total) < pool.v ? BigInt(P.total) : pool.v;
        const sweep = pool.q - BigInt(P.units) === 0n && pool.v - removed > 0n ? pool.v - removed : 0n;
        if (sweep > 0n) m.add(P.pid, P.date, 0n, -sweep);
        m.add(P.pid, P.date, -BigInt(P.units), -removed);
        P.voided = true;
        hit('pvoid'); if (sweep > 0n) hit('pvoid-sweep');
      }
    } else if (r < 0.46) {
      // ---- stocktake: create draft, then complete ----
      label += ' stocktake';
      const bk = chance(0.75) ? 'shop' : 'telecom';
      const pool0 = book(bk === 'shop' ? shop[0]! : tel[0]!);
      const n = ri(1, Math.min(3, pool0.length));
      const chosen = [...pool0].sort(() => rnd() - 0.5).slice(0, n);
      const items = chosen.map((pid) => {
        const cur = m.pool(pid).q;
        const choice = rnd();
        const counted = choice < 0.2 ? 0 : choice < 0.35 ? Number(cur) : choice < 0.6 ? Math.max(0, Number(cur) - ri(1, 4)) : choice < 0.85 ? Number(cur) + ri(1, 5) : ri(0, 30);
        const it: { productId: number; countedQty: number; gainUnitCostCents?: number } = { productId: pid, countedQty: counted };
        if (chance(0.5)) it.gainUnitCostCents = chance(0.1) ? 0 : ri(1, 3000);
        return it;
      });
      const age = randDay();
      const created = await post(s.app, '/stocktakes', { businessDate: daysAgo(age), book: bk, clientRef: ref(), items });
      expect(created.status, label + JSON.stringify(created.body)).toBe(201);
      // model on a copy, item order
      const work = new Map<number, Pool>();
      const movs: Array<{ pid: number; dq: bigint; dv: bigint }> = [];
      let failIndex = -1;
      items.forEach((it, idx) => {
        if (failIndex >= 0) return;
        const base = m.pool(it.productId);
        const p = work.get(it.productId) ?? { q: base.q, v: base.v };
        const diff = BigInt(it.countedQty) - p.q;
        if (diff < 0n) {
          const out = outValue(p, -diff);
          movs.push({ pid: it.productId, dq: diff, dv: -out });
          p.q += diff; p.v -= out;
        } else if (diff > 0n) {
          let value: bigint;
          if (p.q > 0n && p.v > 0n) value = mdr(p.v, diff, p.q);
          else if (it.gainUnitCostCents === undefined) { failIndex = idx; return; }
          else value = diff * BigInt(it.gainUnitCostCents);
          movs.push({ pid: it.productId, dq: diff, dv: value });
          p.q += diff; p.v += value;
        }
        work.set(it.productId, p);
      });
      const res = await post(s.app, `/stocktakes/${created.body.item.id}/complete`, {});
      if (failIndex >= 0) {
        expect(res.status, label).toBe(422);
        expect(res.body.error.code).toBe('UNIT_COST_REQUIRED');
        expect(Object.keys(res.body.error.fields)).toEqual([`items.${failIndex}.gainUnitCostCents`]);
        const st = await get(s.app, `/stocktakes/${created.body.item.id}`);
        expect(st.body.item.status).toBe('draft');
        expectUnchanged = true; hit('stocktake-cost-required');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(200);
        for (const mv of movs) m.add(mv.pid, daysAgo(age), mv.dq, mv.dv);
        stocktakes.push({ id: created.body.item.id, movs, date: daysAgo(age), voided: false });
        // stored per-item figures match the model
        const stored = res.body.item.items as Array<{ productId: number; differenceQty: number; valueDeltaCents: number }>;
        for (const it of stored) {
          const mine = movs.filter((x) => x.pid === it.productId);
          expect(it.differenceQty, label).toBe(Number(mine.reduce((a, x) => a + x.dq, 0n)));
          expect(it.valueDeltaCents, label).toBe(Number(mine.reduce((a, x) => a + x.dv, 0n)));
        }
        hit('stocktake');
        if (movs.some((x) => x.dq > 0n)) hit('stocktake-gain');
        if (movs.some((x) => x.dq < 0n)) hit('stocktake-loss');
        if (items.some((x) => x.countedQty === 0)) hit('stocktake-zero');
        if (movs.length === 0) hit('stocktake-noop');
      }
    } else if (r < 0.52) {
      // ---- stocktake void (completed) ----
      label += ' stocktake-void';
      const cand = stocktakes.filter((x) => !x.voided);
      if (cand.length === 0) continue;
      const S = pick(cand);
      const res = await post(s.app, `/stocktakes/${S.id}/void`, { reason: 'model' });
      // reversal newest-first on a copy, each against the live pool at that moment
      const work = new Map<number, Pool>();
      let ok = true;
      for (const mv of [...S.movs].reverse()) {
        const base = m.pool(mv.pid);
        const p = work.get(mv.pid) ?? { q: base.q, v: base.v };
        const nq = p.q - mv.dq; const nv = p.v - mv.dv;
        if (nq < 0n || nv < 0n || (nq === 0n && nv !== 0n)) { ok = false; break; }
        p.q = nq; p.v = nv; work.set(mv.pid, p);
      }
      if (!ok) {
        expect(res.status, label).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('stocktake-void-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(200);
        for (const mv of [...S.movs].reverse()) m.add(mv.pid, S.date, -mv.dq, -mv.dv);
        S.voided = true; hit('stocktake-void');
      }
    } else if (r < 0.64) {
      // ---- stock loss ----
      label += ' loss';
      const pid = pick(all);
      const pool = m.pool(pid);
      const q = chance(0.15) ? Number(pool.q) + ri(1, 3) : ri(1, Math.max(1, Number(pool.q)));
      const age = randDay();
      const res = await post(s.app, '/stock-losses', { businessDate: daysAgo(age), productId: pid, qty: q, reason: pick(['damaged', 'lost', 'expired', 'other']), clientRef: ref() });
      if (BigInt(q) > pool.q) {
        expect(res.status, label).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('loss-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(201);
        const cost = outValue(pool, BigInt(q));
        expect(res.body.item.costCents, label).toBe(Number(cost));
        m.add(pid, daysAgo(age), -BigInt(q), -cost);
        losses.push({ id: res.body.item.id, pid, q, cost: Number(cost), date: daysAgo(age), voided: false });
        hit('loss');
      }
    } else if (r < 0.69) {
      // ---- stock loss void ----
      label += ' loss-void';
      const cand = losses.filter((x) => !x.voided);
      if (cand.length === 0) continue;
      const L = pick(cand);
      const res = await post(s.app, `/stock-losses/${L.id}/void`, { reason: 'model' });
      expect(res.status, label + JSON.stringify(res.body)).toBe(200);
      m.add(L.pid, L.date, BigInt(L.q), BigInt(L.cost));
      L.voided = true; hit('loss-void');
    } else if (r < 0.78) {
      // ---- goods drawing ----
      label += ' drawing';
      const pid = pick(all);
      const pool = m.pool(pid);
      const q = chance(0.15) ? Number(pool.q) + ri(1, 3) : ri(1, Math.max(1, Number(pool.q)));
      const age = randDay();
      const res = await post(s.app, '/drawings', { kind: 'goods', businessDate: daysAgo(age), productId: pid, qty: q, clientRef: ref() });
      if (BigInt(q) > pool.q) {
        expect(res.status, label).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('draw-blocked');
      } else {
        expect(res.status, label + JSON.stringify(res.body)).toBe(201);
        const cost = outValue(pool, BigInt(q));
        expect(res.body.item.amountCents, label).toBe(Number(cost));
        m.add(pid, daysAgo(age), -BigInt(q), -cost);
        draws.push({ id: res.body.item.id, pid, q, cost: Number(cost), date: daysAgo(age), voided: false });
        hit('draw');
      }
    } else if (r < 0.82) {
      // ---- drawing void ----
      label += ' draw-void';
      const cand = draws.filter((x) => !x.voided);
      if (cand.length === 0) continue;
      const D = pick(cand);
      const res = await post(s.app, `/drawings/${D.id}/void`, { reason: 'model' });
      expect(res.status, label + JSON.stringify(res.body)).toBe(200);
      m.add(D.pid, D.date, BigInt(D.q), BigInt(D.cost));
      D.voided = true; hit('draw-void');
    } else {
      // ---- engine sale (what Phase 5 will do) ----
      label += ' engine-sale';
      const pid = pick(all);
      const pool = m.pool(pid);
      const q = chance(0.15) ? Number(pool.q) + ri(1, 3) : ri(1, Math.max(1, Number(pool.q)));
      let threw: unknown = null;
      try {
        s.ctx.database.tx((c) => issueStock(c, { productId: pid, businessDate: today(), type: 'sale', qty: q, refTable: null, refId: null, reason: 'model sale' }));
      } catch (e) { threw = e; }
      if (BigInt(q) > pool.q) {
        expect(threw, label).toBeInstanceOf(AppError);
        expect((threw as AppError).code).toBe('INSUFFICIENT_STOCK');
        expectUnchanged = true; hit('sale-blocked');
      } else {
        expect(threw, label).toBeNull();
        m.add(pid, today(), -BigInt(q), -outValue(pool, BigInt(q)));
        hit('sale');
      }
    }

    if (expectUnchanged) {
      expect(m.snapshot(), label).toBe(before);
      expect(num(s, 'SELECT COUNT(*) FROM stock_movements'), label + ' (blocked op wrote movements)').toBe(movCountBefore);
      // a refused stocktake completion / void still leaves exactly the draft-create audit row at most
      expect(num(s, 'SELECT COUNT(*) FROM audit_logs') - auditBefore, label).toBeLessThanOrEqual(1);
    }
    await dbEqualsModel(label);
    if (step % 50 === 0) {
      const r2 = await get(s.app, '/inventory/reconciliation');
      expect(r2.body.ok).toBe(true);
    }
  }

  // ---------- valuation as of several business dates must equal the model's movement sums ----------
  const asOfDates = [today(), daysAgo(1), daysAgo(3), daysAgo(7), daysAgo(12), daysAgo(20), daysAgo(40)];
  for (const d of asOfDates) {
    const v = (await get(s.app, `/inventory/valuation?asOf=${d}&includeZero=true`)).body;
    for (const pid of all) {
      let q = 0n; let val = 0n;
      for (const mv of m.movs) if (mv.pid === pid && mv.date <= d) { q += mv.dq; val += mv.dv; }
      const row = v.items.find((i: any) => i.productId === pid);
      expect(row, `asOf ${d} product ${pid}`).toMatchObject({ qty: Number(q), valueCents: Number(val) });
    }
    const totalQ = v.items.reduce((a: number, i: any) => a + i.qty, 0);
    expect(v.totals.qty).toBe(totalQ);
  }
  // every movement written by the system is accounted for by the model, one-to-one
  expect(num(s, 'SELECT COUNT(*) FROM stock_movements')).toBe(m.movs.length);
  const dbSum = sql(s, 'SELECT product_id, SUM(qty_delta) AS q, SUM(value_delta_cents) AS v FROM stock_movements GROUP BY product_id');
  for (const r of dbSum) {
    const p = m.pool(Number(r.product_id));
    expect([Number(r.q), Number(r.v)]).toEqual([Number(p.q), Number(p.v)]);
  }
  // personal-use movements are exactly the drawings; stock-loss movements exactly the losses
  const puNet = num(s, "SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type = 'personal_use'");
  const drawNet = num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM owner_drawings WHERE status = 'posted'");
  expect(puNet).toBe(-drawNet);
  const lossNet = num(s, "SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type = 'loss'");
  expect(lossNet).toBe(-num(s, "SELECT COALESCE(SUM(cost_cents),0) FROM stock_losses WHERE status = 'posted'"));
  expect(num(s, 'SELECT COUNT(*) FROM stock_losses WHERE client_ref IS NULL')).toBe(0);
  return stats;
}

describe('randomized model check (seeded)', () => {
  const seeds: Array<[number, number]> = [[20261111, 400], [7, 400], [424242, 400]];
  const total: Record<string, number> = {};
  it.each(seeds)('seed %i: %i operations keep the database equal to the independent model', async (seed, steps) => {
    const stats = await runModel(seed, steps);
    for (const [k, n] of Object.entries(stats)) total[k] = (total[k] ?? 0) + n;
    if (process.env.MODEL_STATS) console.log(seed, JSON.stringify(stats));
    expect(stats.purchase).toBeGreaterThan(5);
    expect(stats.stocktake).toBeGreaterThan(5);
    expect(stats.loss).toBeGreaterThan(3);
    expect(stats.draw).toBeGreaterThan(3);
  }, 300000);

  it('across the seeds every operation kind and every blocked path was exercised', () => {
    for (const k of ['purchase', 'return', 'pvoid', 'stocktake', 'stocktake-gain', 'stocktake-loss', 'stocktake-zero', 'stocktake-void',
      'loss', 'loss-void', 'draw', 'draw-void', 'sale', 'loss-blocked', 'draw-blocked', 'sale-blocked', 'stocktake-cost-required']) {
      expect(total[k], `kind ${k} never exercised: ${JSON.stringify(total)}`).toBeGreaterThan(0);
    }
  });
});
