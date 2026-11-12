// Phase 11 FINANCIAL reports: a SEEDED randomized check. More than 200 random operations across all segments (sales with extra cost, partial
// returns resalable/damaged on later dates, voids, losses, stocktakes, expenses, print sales, reloads, EZCash, cash counts over/short,
// Ice Cream days / payments / re-allocations / counts, drawings and transfers) are posted through the REAL API while a small INDEPENDENT
// MODEL in this file keeps the books. The model is deliberately simple arithmetic: every product is always bought at one fixed unit cost, so
// the weighted average is exactly that cost and nothing needs rounding; it never calls report code. After the run every P&L total, every
// day row's net, the Ice Cream recognized profit and excess-cost flow, and the ledger reconciliations are compared with the model.
// A failing run can be replayed: the seed is printed in the test name. Protects BUSINESS_RULES 1, 3-6, 10.3-10.6, 11, C4, C5, C13, R1, R5, R7.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct, mkTelecom } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post } from './helpers/catalog.ts';
import { lossNew, stComplete, stDraft } from './helpers/phase4.ts';
import { clc, rl, returnNew, sellNew, voidSaleNew } from './helpers/phase5.ts';
import { ez, providerIds, rel } from './helpers/phase6.ts';
import { psNew, SEEDED } from './helpers/phase7.ts';
import { countNew, expNew, openNew, rng } from './helpers/phase8.ts';
import { drawCash, tr } from './helpers/phase9.ts';
import { dayNew, moveNew, payNew } from './helpers/phase10.ts';
import { q, rep } from './helpers/phase11fin.ts';
import { sql } from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

/** Two seeds: the second pays far more than is allocated, so excess cost (10.5) is outstanding at the end and the warning/flow lines are exercised. */
const RUNS: Array<[number, number]> = [[20251112, 60000], [4242, 400000]];
const DATES: string[] = [];
for (let i = 0; i < 40; i++) DATES.push(new Date(Date.UTC(2025, 4, 1 + i)).toISOString().slice(0, 10)); // 2025-05-01 .. 2025-06-09
const FROM = DATES[0]!; const TO = DATES[DATES.length - 1]!;

interface Sale {
  id: number; itemId: number; date: string; productIdx: number; book: 'shop' | 'telecom'; qty: number; price: number; unit: number; extra: number;
  returned: number; voided: boolean;
}
interface Prod { id: number; book: 'shop' | 'telecom'; unit: number; qty: number }

const mapAdd = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

for (const [SEED, MAX_PAY] of RUNS) describe(`randomized model check (seed ${SEED})`, () => {
  it('every P&L total, every day row and the ledger reconciliations match an independent model after 300 random operations', async () => {
    const s = await apiBase(await env.build());
    const rnd = rng(SEED);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = <T,>(a: readonly T[]): T => a[int(0, a.length - 1)]!;

    // ---- model state: net profit per day for each segment, plus a few component totals
    const shopNet = new Map<string, number>(); const telNet = new Map<string, number>(); const iceRec = new Map<string, number>();
    const net = (book: 'shop' | 'telecom') => (book === 'shop' ? shopNet : telNet);
    let iceCharge = 0; let iceSettle = 0; let iceSales = 0; // cumulative, for the excess-cost check at the end
    const iceDays = new Map<string, { share: number; id: number | null }>();
    let ops = 0;

    // ---- fixed-cost products (value = qty x unit cost always)
    const prods: Prod[] = [];
    for (const [unit, book] of [[1000, 'shop'], [2500, 'shop'], [777, 'shop'], [400, 'telecom']] as const) {
      const p = await (book === 'shop' ? mkProduct(s, { minPriceCents: 1 }) : mkTelecom(s, { minPriceCents: 1 }));
      prods.push({ id: p.id, book, unit, qty: 0 });
    }
    const providers = await providerIds(s);
    const sales: Sale[] = [];
    const svcIds: Record<string, number> = Object.fromEntries(
      (await get(s.app, '/print-service-types')).body.items.map((t: any) => [t.code, t.id]));
    // generous opening balances so cash counts and cash-outs are always valid
    for (const book of ['shop', 'telecom'] as const) await openNew(s, book, { businessDate: FROM, amountCents: 900000000 });
    await openNew(s, 'icecream', { businessDate: FROM, amountCents: 900000000, fund: 'cost' });

    const buyUnits = async (p: Prod, n: number) => {
      await buy(s, [{ productId: p.id, packs: 1, packSize: n, lineTotalCents: n * p.unit }], { businessDate: FROM });
      p.qty += n; ops++;
    };
    for (const p of prods) await buyUnits(p, 60);

    const usedIceDates = new Set<string>();
    for (let step = 0; step < 300; step++) {
      const r = rnd();
      const date = pick(DATES);
      if (r < 0.20) { // sale (maybe with extra cost)
        const pi = int(0, prods.length - 1); const p = prods[pi]!;
        if (p.qty < 1) { await buyUnits(p, 30); continue; }
        const qty = int(1, Math.min(5, p.qty)); const price = int(1, 9000); const extra = rnd() < 0.4 ? int(1, 150) : 0;
        const res = await sellNew(s, [extra ? clc(p.id, qty, price, p.unit + extra) : { productId: p.id, qty, unitPriceCents: price }], { businessDate: date });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const sale = res.body.sales[0];
        p.qty -= qty; ops++;
        sales.push({ id: sale.id, itemId: sale.items[0].id, date, productIdx: pi, book: p.book, qty, price, unit: p.unit, extra, returned: 0, voided: false });
        mapAdd(net(p.book), date, qty * price - qty * p.unit - qty * extra);
      } else if (r < 0.32) { // return (later date, partial or full; resalable or damaged)
        const open = sales.filter((x) => !x.voided && x.returned < x.qty);
        if (open.length === 0) continue;
        const sl = pick(open); const retDate = pick(DATES.filter((d) => d >= sl.date));
        const n = int(1, sl.qty - sl.returned); const resalable = rnd() < 0.5;
        const res = await returnNew(s, sl.id, [rl(sl.itemId, n, resalable)], { businessDate: retDate });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        sl.returned += n; ops++;
        const p = prods[sl.productIdx]!;
        // revenue, automatic cost and extra cost of the returned units reverse on the RETURN date; a damaged return also writes off the cost once
        let d = -n * sl.price + n * sl.unit + n * sl.extra;
        if (resalable) p.qty += n; else d -= n * sl.unit;
        mapAdd(net(sl.book), retDate, d);
      } else if (r < 0.38) { // void a sale that has no returns
        const ok = sales.filter((x) => !x.voided && x.returned === 0);
        if (ok.length === 0) continue;
        const sl = pick(ok);
        const res = await voidSaleNew(s, sl.id);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        sl.voided = true; ops++;
        prods[sl.productIdx]!.qty += sl.qty;
        mapAdd(net(sl.book), sl.date, -(sl.qty * sl.price - sl.qty * sl.unit - sl.qty * sl.extra));
      } else if (r < 0.43) { // stock loss
        const p = pick(prods); if (p.qty < 1) continue;
        const n = int(1, Math.min(3, p.qty));
        expect((await lossNew(s, p.id, n, { businessDate: date, reason: 'lost' })).status).toBe(201);
        p.qty -= n; ops++; mapAdd(net(p.book), date, -n * p.unit);
      } else if (r < 0.47) { // stocktake gain or loss
        const p = pick(prods); if (p.qty < 1) continue;
        const counted = Math.max(0, p.qty + int(-3, 3)); if (counted === p.qty) continue;
        const draft = await stDraft(s, [{ productId: p.id, countedQty: counted }], { businessDate: date, book: p.book });
        expect((await stComplete(s, draft.id)).status).toBeLessThan(300);
        mapAdd(net(p.book), date, (counted - p.qty) * p.unit); // gain adds value (+), loss removes it (-): same sign as the quantity change
        p.qty = counted; ops++;
      } else if (r < 0.53) { // expense
        const book = pick(['shop', 'telecom'] as const); const amount = int(100, 20000);
        expect((await expNew(s, { businessDate: date, book, category: pick(['rent', 'water', 'transport', 'other', 'repairs']), amountCents: amount })).status).toBe(201);
        mapAdd(net(book), date, -amount); ops++;
      } else if (r < 0.57) { // print sale
        const code = pick(Object.keys(SEEDED)); const qty = int(1, 30);
        expect((await psNew(s, { businessDate: date, qty }, code)).status).toBe(201);
        mapAdd(shopNet, date, qty * (SEEDED[code]![0] - SEEDED[code]![1])); ops++;
        void svcIds;
      } else if (r < 0.62) { // reload (rate 600 bp, half away from zero) with optional rounding extra
        const sales_ = int(1000, 900000); const extra = rnd() < 0.3 ? int(1, 100) : 0;
        expect((await rel(s, providers[pick(['Dialog', 'Mobitel', 'Hutch', 'Airtel'])]!, sales_, { businessDate: date, extraCents: extra })).status).toBe(201);
        mapAdd(telNet, date, Math.floor((sales_ * 600 + 5000) / 10000) + extra); ops++;
      } else if (r < 0.66) { // EZCash (80 bp)
        const bill = int(1000, 900000);
        expect((await ez(s, bill, { businessDate: date })).status).toBe(201);
        mapAdd(telNet, date, Math.floor((bill * 80 + 5000) / 10000)); ops++;
      } else if (r < 0.70) { // cash count (shop or telecom): over or short
        const book = pick(['shop', 'telecom'] as const);
        const expected = (await get(s.app, `/cash-counts/expected?book=${book}&businessDate=${date}`)).body.expectedCents as number;
        let diff = int(-300, 300); if (diff === 0) diff = 7;
        expect((await countNew(s, book, expected + diff, { businessDate: date, note: 'random' })).status).toBe(201);
        mapAdd(net(book), date, diff); ops++;
      } else if (r < 0.76) { // Ice Cream daily entry (one per date); sometimes voided straight away
        if (usedIceDates.has(date)) continue;
        const S = int(0, 200000); const C = int(0, Math.floor(S * 0.6)); const E = int(0, Math.floor(S * 0.2)); const share = S - C - E;
        const res = await dayNew(s, { businessDate: date, salesCents: S, costAllocCents: C, electricityAllocCents: E });
        expect(res.status, JSON.stringify(res.body)).toBe(201); ops++;
        if (rnd() < 0.2) {
          expect((await post(s.app, `/icecream/days/${date}/void`, { reason: 'random void' })).status).toBeLessThan(300); ops++;
          // a voided day stays unusable for a new row in this run: keep it simple
          usedIceDates.add(date);
        } else {
          usedIceDates.add(date); iceDays.set(date, { share, id: null });
          mapAdd(iceRec, date, share); iceCharge += C + E; iceSales += S;
        }
      } else if (r < 0.84) { // Ice Cream payment (materials, bill, or other cost from any fund)
        const kind = pick(['materials', 'electricity_bill', 'other_cost'] as const);
        const fund = kind === 'other_cost' ? pick(['cost', 'electricity', 'profit'] as const) : pick(['cost', 'electricity', 'profit'] as const);
        const amount = int(100, MAX_PAY);
        expect((await payNew(s, kind, amount, { businessDate: date, fund })).status).toBe(201); ops++;
        if (kind === 'other_cost' && fund === 'profit') mapAdd(iceRec, date, -amount); // the only payment that lowers profit (10.3)
        else iceSettle += amount; // materials / bill settle their line; other costs from Cost/Electricity reduce that fund's allocation (10.4)
      } else if (r < 0.88) { // re-allocation Profit -> Cost / Electricity: lowers profit by the FULL amount and charges the line (D1)
        const to = pick(['cost', 'electricity'] as const); const amount = int(100, 30000);
        const res = await moveNew(s, 'profit', to, amount, { businessDate: date });
        expect(res.status, JSON.stringify(res.body)).toBe(201); ops++;
        mapAdd(iceRec, date, -amount); iceCharge += amount;
      } else if (r < 0.91) { // Ice Cream cash count over/short (fund Profit or other)
        const expected = (await get(s.app, `/cash-counts/expected?book=icecream&businessDate=${date}`)).body.expectedCents as number;
        let diff = int(-300, 300); if (diff === 0) diff = -9;
        expect((await countNew(s, 'icecream', expected + diff, { businessDate: date, fund: pick(['profit', 'cost', 'electricity'] as const), note: 'random' })).status).toBe(201);
        mapAdd(iceRec, date, diff); ops++;
      } else if (r < 0.95) { // drawings and transfers: below the line, change no profit
        const which = int(0, 2);
        if (which === 0) expect((await drawCash(s, { businessDate: date, book: 'icecream', fund: pick(['cost', 'electricity', 'profit'] as const), amountCents: int(100, 5000) })).status).toBe(201);
        else if (which === 1) expect((await tr(s, 'shop', 'telecom', int(100, 5000), { businessDate: date })).status).toBe(201);
        else expect((await tr(s, 'icecream', 'shop', int(100, 5000), { businessDate: date, fromFund: pick(['cost', 'electricity', 'profit'] as const) })).status).toBe(201);
        ops++;
      } else { // restock
        const p = pick(prods); await buyUnits(p, int(10, 40));
      }
    }
    expect(ops).toBeGreaterThanOrEqual(200);
    // the run must really have exercised every segment and event type (a degenerate seed would make the comparison meaningless)
    console.log('random run:', JSON.stringify({ ops, sales: sales.length, returned: sales.filter((x) => x.returned > 0).length, voided: sales.filter((x) => x.voided).length, iceDays: iceDays.size, iceCharge, iceSettle }));
    expect(sales.length).toBeGreaterThan(20);
    expect(sales.filter((x) => x.returned > 0).length).toBeGreaterThan(3);
    expect(sales.filter((x) => x.voided).length).toBeGreaterThan(0);
    expect(iceDays.size).toBeGreaterThan(4);

    // ---------------- compare every report with the model ----------------
    const sumMap = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const days = (b: any) => Object.fromEntries(b.rows.map((x: any) => [x.period.label, x]));

    const shop = (await rep(s, 'pnl/shop', q(FROM, TO, 'day'))).body;
    const tel = (await rep(s, 'pnl/telecom', q(FROM, TO, 'day'))).body;
    const ice = (await rep(s, 'pnl/icecream', q(FROM, TO, 'day'))).body;
    const comb = (await rep(s, 'pnl/combined', q(FROM, TO, 'day'))).body;
    expect(shop.totals.netProfitCents, 'shop total').toBe(sumMap(shopNet));
    expect(tel.totals.netProfitCents, 'telecom total').toBe(sumMap(telNet));
    expect(ice.totals.recognizedProfitCents, 'ice cream recognized total').toBe(sumMap(iceRec));
    expect(comb.totals.recognizedProfitCents, 'combined total').toBe(sumMap(shopNet) + sumMap(telNet) + sumMap(iceRec));
    for (const date of DATES) {
      expect(days(shop)[date].netProfitCents, `shop ${date}`).toBe(shopNet.get(date) ?? 0);
      expect(days(tel)[date].netProfitCents, `telecom ${date}`).toBe(telNet.get(date) ?? 0);
      expect(days(ice)[date].recognizedProfitCents, `ice ${date}`).toBe(iceRec.get(date) ?? 0);
    }
    // month granularity: the same totals; day rows add up to month rows
    const mShop = (await rep(s, 'pnl/shop', q(FROM, TO, 'month'))).body;
    expect(mShop.rows.map((x: any) => x.netProfitCents)).toEqual([
      DATES.filter((d) => d.startsWith('2025-05')).reduce((a, d) => a + (shopNet.get(d) ?? 0), 0),
      DATES.filter((d) => d.startsWith('2025-06')).reduce((a, d) => a + (shopNet.get(d) ?? 0), 0),
    ]);
    expect(mShop.totals.netProfitCents).toBe(sumMap(shopNet));
    expect(shop.rows.reduce((a: number, x: any) => a + x.netProfitCents, 0)).toBe(sumMap(shopNet));

    // Ice Cream sales / excess cost (10.4, 10.5): excess at the end = max(0, -(Charged - Settled)); the flow over the whole range from zero equals it
    const unspent = iceCharge - iceSettle;
    const excess = Math.max(0, -unspent);
    expect(ice.totals.salesCents).toBe(iceSales);
    expect(ice.totals.balancesAsOfPeriodEnd.unspentCents).toBe(unspent);
    expect(ice.totals.balancesAsOfPeriodEnd.outstandingExcessCostCents).toBe(excess);
    expect(ice.totals.excessCostNotChargedCents).toBe(excess);
    expect(ice.totals.profitAfterExcessCostCents).toBe(sumMap(iceRec) - excess);
    expect(ice.rows.reduce((a: number, x: any) => a + x.excessCostNotChargedCents, 0)).toBe(excess);
    expect(comb.totals.combinedProfitAfterExcessCostCents).toBe(comb.totals.recognizedProfitCents - excess);
    expect(ice.warnings.length).toBe(excess > 0 ? 1 : 0);
    if (MAX_PAY > 100000) expect(excess, 'this seed must end with excess cost outstanding').toBeGreaterThan(0);
    // identity of 10.4: recognized profit - true profit = -Unspent, where true profit = sales - settled - other from profit + over/short
    // (recognized = shares - realloc - other + os; with Charged = allocations + realloc: recognized + (-unspent)... checked through the model's own sums above)

    // ledger reconciliations: cash report closing = ledger balance; fund closings = fund balances and add up to the Ice Cream book
    for (const book of ['shop', 'telecom', 'icecream'] as const) {
      const cb = (await rep(s, `cashbook/${book}`, q(FROM, TO, 'day'))).body;
      const ledger = Number((sql(s, 'SELECT COALESCE(SUM(amount_cents),0) AS t FROM cash_entries WHERE book = ?', book)[0] as any).t);
      expect(cb.rows[cb.rows.length - 1].closingCents, `${book} closing`).toBe(ledger);
      expect(cb.ledgerBalanceAsOfToCents).toBe(ledger);
      if (book === 'icecream') {
        const f = cb.totals.funds;
        expect(f.cost.closingCents + f.electricity.closingCents + f.profit.closingCents).toBe(ledger);
        const api = (await get(s.app, '/icecream/funds')).body;
        expect([f.cost.closingCents, f.electricity.closingCents, f.profit.closingCents])
          .toEqual([api.funds.cost.balanceCents, api.funds.electricity.balanceCents, api.funds.profit.balanceCents]);
      }
    }
    const fr = (await rep(s, 'icecream-funds', q(FROM, TO, 'day'))).body;
    for (const row of fr.rows) expect(row.reconciled, row.period.label).toBe(true);
    expect(fr.totals.profit.recognizedProfitCents).toBe(sumMap(iceRec));
    expect((await get(s.app, `/icecream/funds?asOf=${TO}`)).body.recognizedProfitToDateCents).toBe(sumMap(iceRec));
  }, 240000);
});
