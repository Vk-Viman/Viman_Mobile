// Phase 11 (agent B) - seeded randomized check and performance sanity for the operational reports.
// (1) 260 random operations per seed (purchases, sales with extra cost, partial/full returns dated later, resalable and damaged, voids,
//     losses, personal-use drawings) are sent through the REAL API while an independent in-test model (weighted-average pools, the C5
//     proportional return rule, BigInt half-away-from-zero rounding) predicts every figure. The sales report (day by day), the product
//     profitability report and the inventory valuation (today and as of past dates) are then compared with the model.
//     Posting order = call order (costs follow posting order, BUSINESS_RULES 3); report dates = business dates (R7).
// (2) Performance: a seeded year of records, a one-year day-by-day report must finish within a few seconds (grouped SQL, no per-day loops).

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { TestEnv } from './helpers/tmp.ts';
import { buy, memDb, mkProduct, sqlProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { clc, returnNew, rl, sellNew } from './helpers/phase5.ts';
import { drawNew, lossNew } from './helpers/phase4.ts';
import { rng } from './helpers/phase8.ts';
import { sqlSale, sqlSaleItem } from './helpers/phase5.ts';
import { sqlPrintSale, sqlSupply } from './helpers/phase7.ts';
import { D, newBase, rep } from './helpers/phase11ops.ts';
import { salesReport } from '../services/reports/sales-report.ts';
import { purchasesReport } from '../services/reports/purchases-report.ts';
import { printingVarianceReport } from '../services/reports/printing-variance.ts';
import { inventoryValuation } from '../services/reports/inventory-valuation.ts';
import { productProfitability } from '../services/reports/product-profitability.ts';
import { drawingsReport } from '../services/reports/drawings-report.ts';
import { stockLossesReport } from '../services/reports/stock-losses-report.ts';
import { backdatedReport } from '../services/reports/backdated-report.ts';

const env = new TestEnv();
afterAll(async () => { await env.cleanup(); });

/** round(a x b / c), half away from zero, for non-negative integers (exact BigInt arithmetic). */
const mdr = (a: number, b: number, c: number): number => Number((BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (2n * BigInt(c)));
/** C5: the return that completes the line takes the exact remainder; any other takes round(total x q / lineQty). */
const portion = (total: number, q: number, lineQty: number, soFarQty: number, soFarAmt: number): number =>
  soFarQty + q === lineQty ? total - soFarAmt : mdr(total, q, lineQty);

interface Line { itemId: number; pid: number; qty: number; rev: number; cogs: number; extra: number; retQty: number; retRev: number; retCogs: number; retExtra: number }
interface ModelSale { id: number; offset: number; voided: boolean; lines: Line[]; returned: boolean }
interface Mv { offset: number; pid: number; qty: number; value: number }
interface ModelReturn { offset: number; rev: number; cogs: number; extra: number; pid: number; qty: number }

const OPS = 260;
const DAYS = 25;

describe.each([20261112, 42])('randomized operations vs independent model (seed %i)', (seed) => {
  it(`${OPS} operations: sales, profitability and valuation match the model`, async () => {
    const r = rng(seed);
    const pick = (n: number) => Math.floor(r() * n);
    const range = (lo: number, hi: number) => lo + pick(hi - lo + 1);
    const s: ApiBase = await newBase(env);
    const pids: number[] = [];
    for (let i = 0; i < 4; i++) pids.push((await mkProduct(s, { minPriceCents: 0 })).id);
    const pool = new Map<number, { qty: number; value: number }>(pids.map((p) => [p, { qty: 0, value: 0 }]));
    const mvs: Mv[] = [];
    const sales: ModelSale[] = [];
    const rets: ModelReturn[] = [];
    const out = (pid: number, qty: number): number => {            // weighted-average removal
      const p = pool.get(pid)!;
      return qty === p.qty ? p.value : mdr(p.value, qty, p.qty);
    };
    const move = (offset: number, pid: number, qty: number, value: number) => {
      const p = pool.get(pid)!; p.qty += qty; p.value += value; mvs.push({ offset, pid, qty, value });
    };
    let done = 0;
    for (let i = 0; i < OPS; i++) {
      const roll = r();
      const withStock = pids.filter((p) => pool.get(p)!.qty > 0);
      if (roll < 0.25 || withStock.length === 0) {                                       // purchase
        const pid = pids[pick(4)]!; const units = range(1, 30); const total = range(100, 20000); const off = range(0, DAYS);
        await buy(s, [{ productId: pid, packs: 1, packSize: units, lineTotalCents: total }], { businessDate: D(off) });
        move(off, pid, units, total); done++;
      } else if (roll < 0.62) {                                                           // sale of 1-2 products, sometimes with extra cost
        const off = range(0, DAYS);
        const chosen = [...withStock].sort(() => r() - 0.5).slice(0, range(1, 2));
        const items: unknown[] = []; const lines: Line[] = [];
        for (const pid of chosen) {
          const qty = range(1, Math.min(5, pool.get(pid)!.qty)); const price = 50 * range(2, 100); const cogs = out(pid, qty);
          const entered = r() < 0.4 ? Math.ceil(cogs / qty) + range(0, 3) : null;       // the cashier may only raise the cost per unit
          items.push(entered === null ? { productId: pid, qty, unitPriceCents: price } : clc(pid, qty, price, entered));
          lines.push({ itemId: 0, pid, qty, rev: qty * price, cogs, extra: entered === null ? 0 : qty * entered - cogs, retQty: 0, retRev: 0, retCogs: 0, retExtra: 0 });
        }
        const res = await sellNew(s, items, { businessDate: D(off) });
        expect(res.status).toBe(201);
        const sale = res.body.sales[0];
        sale.items.forEach((it: any) => { lines.find((l) => l.pid === it.productId)!.itemId = it.id; });
        for (const l of lines) move(off, l.pid, -l.qty, -l.cogs);
        sales.push({ id: sale.id, offset: off, voided: false, lines, returned: false }); done++;
      } else if (roll < 0.75) {                                                           // partial / full return dated on or after the sale
        const cand = sales.filter((x) => !x.voided && x.lines.some((l) => l.retQty < l.qty));
        if (cand.length === 0) continue;
        const sale = cand[pick(cand.length)]!;
        const open = sale.lines.filter((l) => l.retQty < l.qty);
        const line = open[pick(open.length)]!; const q = range(1, line.qty - line.retQty); const resalable = r() < 0.6;
        const off = range(0, sale.offset);                                               // later than or equal to the sale: smaller offset
        const rev = portion(line.rev, q, line.qty, line.retQty, line.retRev);
        const cogs = portion(line.cogs, q, line.qty, line.retQty, line.retCogs);
        const extra = portion(line.extra, q, line.qty, line.retQty, line.retExtra);
        const res = await returnNew(s, sale.id, [rl(line.itemId, q, resalable)], { businessDate: D(off) });
        expect(res.status).toBe(201);
        line.retQty += q; line.retRev += rev; line.retCogs += cogs; line.retExtra += extra; sale.returned = true;
        rets.push({ offset: off, rev, cogs, extra, pid: line.pid, qty: q });
        if (resalable) move(off, line.pid, q, cogs);                                    // damaged: no stock movement (the loss row is separate)
        done++;
      } else if (roll < 0.80) {                                                           // void a sale that has no returns
        const cand = sales.filter((x) => !x.voided && !x.returned);
        if (cand.length === 0) continue;
        const sale = cand[pick(cand.length)]!;
        const res = await s.app.inject({ method: 'POST', url: `/api/v1/sales/${sale.id}/void`, payload: { reason: 'random' } });
        expect(res.statusCode).toBe(200);
        sale.voided = true;
        for (const l of sale.lines) move(sale.offset, l.pid, l.qty, l.cogs);            // exact negation, same business date
        done++;
      } else if (roll < 0.90) {                                                           // loss
        const pid = withStock[pick(withStock.length)]!; const qty = range(1, Math.min(3, pool.get(pid)!.qty)); const off = range(0, DAYS);
        const v = out(pid, qty);
        expect((await lossNew(s, pid, qty, { businessDate: D(off) })).status).toBe(201);
        move(off, pid, -qty, -v); done++;
      } else {                                                                            // goods drawing (personal use)
        const pid = withStock[pick(withStock.length)]!; const qty = range(1, Math.min(2, pool.get(pid)!.qty)); const off = range(0, DAYS);
        const v = out(pid, qty);
        expect((await drawNew(s, pid, qty, { businessDate: D(off) })).status).toBe(201);
        move(off, pid, -qty, -v); done++;
      }
    }
    expect(done).toBeGreaterThanOrEqual(200);
    // the run really exercised the interesting paths
    expect(rets.length).toBeGreaterThan(10);
    expect(sales.filter((x) => x.voided).length).toBeGreaterThan(3);
    expect(sales.some((x) => x.lines.some((l) => l.extra > 0))).toBe(true);

    // ---- sales report: day by day over the whole window
    const live = sales.filter((x) => !x.voided);
    const exp = new Map<number, { count: number; rev: number; auto: number; extra: number; retCount: number; retRev: number; retAuto: number; retExtra: number }>();
    const dayOf = (o: number) => { let e = exp.get(o); if (!e) { e = { count: 0, rev: 0, auto: 0, extra: 0, retCount: 0, retRev: 0, retAuto: 0, retExtra: 0 }; exp.set(o, e); } return e; };
    for (const x of live) { const e = dayOf(x.offset); e.count++; for (const l of x.lines) { e.rev += l.rev; e.auto += l.cogs; e.extra += l.extra; } }
    // a return row counts once per return (every random return here has one line)
    for (const t of rets) { const e = dayOf(t.offset); e.retCount++; e.retRev += t.rev; e.retAuto += t.cogs; e.retExtra += t.extra; }
    // (returns of voided sales cannot exist: a sale with returns is never voided in the model)
    const rpt = await rep(s, '/reports/sales', `?from=${D(DAYS)}&to=${D(0)}&granularity=day&topN=100`);
    expect(rpt.status).toBe(200);
    expect(rpt.body.rows.length).toBe(DAYS + 1);
    for (let off = 0; off <= DAYS; off++) {
      const e = exp.get(off) ?? { count: 0, rev: 0, auto: 0, extra: 0, retCount: 0, retRev: 0, retAuto: 0, retExtra: 0 };
      const row = rpt.body.rows.find((x: any) => x.period.label === D(off));
      expect(row, `day -${off}`).toMatchObject({
        salesCount: e.count, returnCount: e.retCount, salesRevenueCents: e.rev, returnsCents: e.retRev, revenueCents: e.rev - e.retRev,
        costAutoCents: e.auto - e.retAuto, costExtraCents: e.extra - e.retExtra, costCents: e.auto - e.retAuto + e.extra - e.retExtra,
        grossProfitCents: e.rev - e.retRev - (e.auto - e.retAuto + e.extra - e.retExtra),
      });
    }
    let tRev = 0; let tCost = 0;
    for (const e of exp.values()) { tRev += e.rev - e.retRev; tCost += e.auto - e.retAuto + e.extra - e.retExtra; }
    expect(rpt.body.totals).toMatchObject({ revenueCents: tRev, costCents: tCost, grossProfitCents: tRev - tCost });

    // ---- product profitability
    const prof = await rep(s, '/reports/product-profitability', `?from=${D(DAYS)}&to=${D(0)}`);
    let pRev = 0; let pCost = 0;
    for (const pid of pids) {
      const sold = live.flatMap((x) => x.lines.filter((l) => l.pid === pid));
      const rr = rets.filter((t) => t.pid === pid);
      const rev = sold.reduce((a, l) => a + l.rev, 0) - rr.reduce((a, t) => a + t.rev, 0);
      const cost = sold.reduce((a, l) => a + l.cogs + l.extra, 0) - rr.reduce((a, t) => a + t.cogs + t.extra, 0);
      const row = prof.body.rows.find((x: any) => x.productId === pid);
      if (sold.length === 0 && rr.length === 0) { expect(row).toBeUndefined(); continue; }
      expect(row).toMatchObject({
        soldQty: sold.reduce((a, l) => a + l.qty, 0), returnedQty: rr.reduce((a, t) => a + t.qty, 0), revenueCents: rev, costCents: cost, grossProfitCents: rev - cost,
      });
      pRev += rev; pCost += cost;
    }
    expect(prof.body.totals).toMatchObject({ revenueCents: pRev, costCents: pCost, grossProfitCents: pRev - pCost });
    expect(pRev).toBe(tRev);                                                              // the two reports agree with each other and the model

    // ---- valuation: today (= cache = movements) and as of past dates
    const val = await rep(s, '/reports/inventory/valuation', '?includeZero=true');
    for (const pid of pids) {
      const row = val.body.rows.find((x: any) => x.productId === pid);
      expect([row.qty, row.valueCents]).toEqual([pool.get(pid)!.qty, pool.get(pid)!.value]);
    }
    expect(val.body.reconciliation.matchesCache).toBe(true);
    for (const asOfOffset of [3, 10, 17, 24]) {
      const want = mvs.filter((m) => m.offset >= asOfOffset);                              // dated on or before D(asOfOffset)
      const q = want.reduce((a, m) => a + m.qty, 0); const v = want.reduce((a, m) => a + m.value, 0);
      const past = await rep(s, '/reports/inventory/valuation', `?asOf=${D(asOfOffset)}&includeZero=true`);
      expect([past.body.totals.qty, past.body.totals.valueCents], `as of -${asOfOffset}`).toEqual([q, v]);
    }
  }, 180000);
});

describe('performance sanity: a seeded year of data', () => {
  // One year of daily activity, written by SQL: 8 sales/day with 2 lines, a return every 5th day, a purchase/day, 2 print sales/day, supplies weekly,
  // a cash drawing/day, 3 products' movements. A one-year day-by-day report of every period report must finish in a few seconds each.
  it('every one-year day-by-day report finishes quickly and still adds up', () => {
    const track: DatabaseSync[] = [];
    const c = memDb(track);
    try {
      const prods = [sqlProduct(c), sqlProduct(c), sqlProduct(c)];
      const dayStr = (n: number) => new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);
      c.exec('BEGIN');
      let sales = 0;
      for (let d = 364; d >= 0; d--) {
        const date = dayStr(d);
        for (let k = 0; k < 8; k++) {
          const id = sqlSale(c, { date, total: 2000, ref: `perf-${d}-${k}` });
          sqlSaleItem(c, id, prods[k % 3]!, { lineNo: 1, qty: 1, price: 1000, cost: 600, cogs: 600, extra: 10 });
          sqlSaleItem(c, id, prods[(k + 1) % 3]!, { lineNo: 2, qty: 1, price: 1000, cost: 600, cogs: 600 });
          sales++;
        }
        c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 5000, ?)").run(date, `perf-pu-${d}`);
        c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'purchase', 10, 5000)").run(prods[d % 3]!, date);
        sqlPrintSale(c, { date, qty: 2, ref: `perf-ps-${d}` });
        if (d % 7 === 0) sqlSupply(c, { date, amount: 4000, ref: `perf-su-${d}` });
        c.prepare("INSERT INTO owner_drawings (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'shop', 'cash', 100, ?)").run(date, `perf-dr-${d}`);
      }
      c.exec('COMMIT');
      const from = dayStr(364); const to = dayStr(0);
      const timed = <T>(f: () => T): { out: T; ms: number } => { const t0 = performance.now(); const out = f(); return { out, ms: performance.now() - t0 }; };
      const q = { from, to, granularity: 'day' as const };

      const sr = timed(() => salesReport(c, q));
      expect(sr.out.rows.length).toBe(365);
      // 8 sales x (2 lines x 1,000) per day: revenue 365 x 16,000; automatic 365 x 8 x 1,200 = 3,504,000; extra 365 x 8 x 10 = 29,200
      expect(sr.out.totals).toMatchObject({ salesCount: 2920, revenueCents: 5840000, costAutoCents: 3504000, costExtraCents: 29200, grossProfitCents: 5840000 - 3504000 - 29200 });
      expect(sales).toBe(2920);
      const pu = timed(() => purchasesReport(c, q));
      expect(pu.out.totals).toMatchObject({ purchaseCount: 365, purchasesCents: 1825000 });
      const pr = timed(() => printingVarianceReport(c, q));
      // 365 x 2 pages x (1,500 price, 650 cost); supplies 53 weekly entries (d = 0, 7 ... 364) x 4,000
      expect(pr.out.totals).toMatchObject({ pages: 730, revenueCents: 1095000, standardCostChargedCents: 474500, suppliesSpentCents: 53 * 4000, supplyCount: 53 });
      const dr = timed(() => drawingsReport(c, q));
      expect(dr.out.totals).toMatchObject({ cashCents: 36500 });
      const va = timed(() => inventoryValuation(c, { asOf: dayStr(100) }));
      expect(va.out.totals.qty).toBe(265 * 10);                                           // purchases dated on or before 100 days ago: days 364..100 = 265
      const pf = timed(() => productProfitability(c, { from, to }));
      expect(pf.out.totals.revenueCents).toBe(5840000);
      const lo = timed(() => stockLossesReport(c, q));
      const bd = timed(() => backdatedReport(c, { from, to, limit: 50, offset: 0 }));
      // every row was saved just now with a business date before today (except today's own): per past day 8 sales + 1 purchase + 1 print sale
      // + 1 drawing = 11, plus the 52 supplies entries on past days (d = 7, 14 ... 364) -> 364 x 11 + 52 = 4,056
      expect(bd.out.total).toBe(4056);
      expect(lo.out.totals.costCents).toBe(0);
      for (const t of [sr, pu, pr, dr, va, pf, lo, bd]) expect(t.ms).toBeLessThan(3000);
      expect(sr.ms + pu.ms + pr.ms + dr.ms + va.ms + pf.ms + lo.ms + bd.ms).toBeLessThan(8000);
    } finally { for (const x of track) x.close(); }
  }, 120000);
});
