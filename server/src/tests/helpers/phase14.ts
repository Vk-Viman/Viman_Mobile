// Helpers for the Phase 14 independent QA / financial validation tests.
// Contents: (1) the scripted six-week world `buildWorld14` (posted ONLY through the real HTTP API; every figure the tests expect is worked out by
// hand in phase14-world.test.ts); (2) `assertGlobalInvariants`, the checker that must hold after ANY state; (3) small raw readers and a whole-database
// snapshot used by the adversarial tests ("a rejected request writes NOTHING").
// Money is integer cents everywhere (`rs()` converts rupees to cents).

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { get, post, put } from './catalog.ts';
import { buy, daysAgo, mkProduct, mkTelecom, ref } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { drawNew, lossNew, lossVoid, stComplete, stDraft } from './phase4.ts';
import { clc, cl, returnOk, rl, sellOk, voidSaleNew } from './phase5.ts';
import { ez, providerIds, putProvider, rel, relVoid, topProvider, topWallet } from './phase6.ts';
import { psNew, supNew } from './phase7.ts';
import { closeNew, countNew, expNew, expVoid, openNew, reopenNew } from './phase8.ts';
import { capNew, drawCash, tr } from './phase9.ts';
import { dayOk, dayNew, dayVoid, moveNew, payNew, payOk } from './phase10.ts';

/** Rupees to cents (exact for the whole-paisa values used in the tests). */
export const rs = (rupees: number): number => Math.round(rupees * 100);

/** One sql row set straight from the database (bigint columns are returned as numbers by node:sqlite here). */
export const rows = (ctx: AppContext, q: string, ...p: any[]): Array<Record<string, any>> =>
  ctx.database.conn.prepare(q).all(...p) as unknown as Array<Record<string, any>>;
/** First column of the first row as a number. */
export const n1 = (ctx: AppContext, q: string, ...p: any[]): number => Number(Object.values(rows(ctx, q, ...p)[0]!)[0]);

/** Calls a request and throws unless the status is < 300 (a broken set-up must fail loudly). */
export async function must(r: { status: number; body: any }, what: string): Promise<any> {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// (1) The scripted world
// ---------------------------------------------------------------------------------------------------------------------------------------

/** Ids and results of the scripted world that the tests need. */
export interface World14 {
  P: number; Q: number; R: number; S: number; K: number;
  sales: Record<string, any>;
  returns: Record<string, any>;
  d4: any;
  dayClosed: { status: number; body: any };
  iceClosed: { status: number; body: any; status2: number; body2: any };
  prov: Record<string, number>;
}

/**
 * Posts the six-week world (2025-08-04 .. 2025-09-14) through the API. The full script, with the hand arithmetic, is in phase14-world.test.ts.
 * Dates are fixed past dates so the figures are identical on every day the suite runs.
 */
export async function buildWorld14(s: ApiBase): Promise<World14> {
  const w: World14 = { P: 0, Q: 0, R: 0, S: 0, K: 0, sales: {}, returns: {}, d4: null, dayClosed: null as any, iceClosed: null as any, prov: {} };
  const lo = { minPriceCents: 100 };
  w.P = (await mkProduct(s, { name: 'Phone cover', sellPriceCents: rs(800), ...lo })).id;
  w.Q = (await mkProduct(s, { name: 'Charger', sellPriceCents: rs(1200), ...lo })).id;
  w.R = (await mkProduct(s, { name: 'Earbuds', sellPriceCents: rs(900), ...lo })).id;
  w.S = (await mkProduct(s, { name: 'Cable', sellPriceCents: rs(250), ...lo })).id;
  w.K = (await mkTelecom(s, { name: 'Scratch card 100', sellPriceCents: rs(100), ...lo })).id;
  const { P, Q, R, S, K } = w;
  w.prov = await providerIds(s);
  const prov = w.prov;
  const on = (md: string) => ({ businessDate: `2025-${md}` });

  // ---- 08-04 Mon
  await must(await openNew(s, 'shop', { ...on('08-04'), amountCents: rs(50000) }), 'open shop');
  await must(await openNew(s, 'telecom', { ...on('08-04'), amountCents: rs(20000) }), 'open telecom');
  await must(await openNew(s, 'icecream', { ...on('08-04'), amountCents: rs(3000), fund: 'cost' }), 'open ice');
  await must(await post(s.app, '/opening-stock', { ...on('08-04'), items: [{ productId: R, qty: 4, totalValueCents: rs(2000) }, { productId: S, qty: 10, totalValueCents: rs(1001) }], clientRef: ref() }), 'opening stock');
  await buy(s, [{ productId: P, packs: 1, packSize: 20, lineTotalCents: rs(6000) }, { productId: Q, packs: 1, packSize: 10, lineTotalCents: rs(7000) }], on('08-04'));
  w.sales.Sa1 = (await sellOk(s, [cl(P, 3, rs(800)), cl(S, 2, rs(250))], on('08-04'))).sales[0];
  await must(await rel(s, prov.Dialog!, rs(10000), on('08-04')), 'reload dialog');
  await must(await putProvider(s, prov.Mobitel!, { commissionBp: 450, active: true }), 'mobitel rate');
  await must(await rel(s, prov.Mobitel!, 333333, on('08-04')), 'reload mobitel');
  await dayOk(s, { ...on('08-04'), salesCents: rs(5000), costAllocCents: rs(3000), electricityAllocCents: rs(500),
    items: [{ itemName: 'Cone', qty: 50, unitPriceCents: rs(60) }, { itemName: 'Cup', qty: 20, unitPriceCents: rs(100) }] });

  // ---- 08-05 Tue
  await buy(s, [{ productId: K, packs: 1, packSize: 100, lineTotalCents: rs(9000) }], on('08-05'));
  w.sales.T1 = (await sellOk(s, [clc(K, 20, rs(100), rs(95))], on('08-05'))).sales[0];
  w.sales.Sa2 = (await sellOk(s, [clc(Q, 2, rs(1200), rs(720))], on('08-05'))).sales[0];
  await must(await psNew(s, { ...on('08-05'), qty: 100 }, 'BW_1S'), 'print 100');
  await must(await supNew(s, { ...on('08-05'), amountCents: rs(1200), description: 'A4 paper' }), 'supplies');
  await must(await expNew(s, { ...on('08-05'), book: 'shop', category: 'rent', amountCents: rs(10000) }), 'rent');

  // ---- 08-06 Wed
  const pu2 = await buy(s, [{ productId: P, packs: 1, packSize: 10, lineTotalCents: rs(3500) }], on('08-06'));
  await must(await ez(s, rs(25000), on('08-06')), 'ezcash');
  await must(await expNew(s, { ...on('08-06'), book: 'telecom', category: 'internet', amountCents: rs(1500) }), 'internet');
  await must(await topWallet(s, rs(5000), on('08-06')), 'wallet');
  await must(await topProvider(s, prov.Dialog!, rs(8000), on('08-06')), 'provider topup');
  await payOk(s, 'materials', rs(2500), { fund: 'cost', ...on('08-06') });

  // ---- 08-07 Thu
  await must(await post(s.app, `/purchases/${pu2.id}/returns`, { ...on('08-07'), items: [{ purchaseItemId: pu2.items[0].id, units: 4 }], clientRef: ref() }), 'purchase return');
  w.sales.Sa3 = (await sellOk(s, [cl(P, 5, rs(800))], on('08-07'))).sales[0];
  await must(await lossNew(s, S, 1, { ...on('08-07'), reason: 'damaged' }), 'loss S');
  await dayOk(s, { ...on('08-07'), salesCents: rs(4000), costAllocCents: rs(2400), electricityAllocCents: rs(400) });
  await payOk(s, 'electricity_bill', rs(1500), { fund: 'electricity', ...on('08-07'), description: 'July bill' });
  await must(await drawCash(s, { ...on('08-07'), book: 'shop', amountCents: rs(2000) }), 'shop drawing');

  // ---- 08-08 Fri
  w.returns.Rt1 = (await returnOk(s, w.sales.Sa3.id, [rl(w.sales.Sa3.items[0].id, 2, true)], on('08-08'))).item;
  w.returns.Rt2 = (await returnOk(s, w.sales.Sa1.id, [rl(w.sales.Sa1.items[0].id, 1, false)], on('08-08'))).item;
  await must(await drawNew(s, P, 2, on('08-08')), 'goods drawing');
  await must(await stComplete(s, (await stDraft(s, [{ productId: R, countedQty: 3 }, { productId: S, countedQty: 9 }], { ...on('08-08'), book: 'shop' })).id), 'stocktake 1');
  const sa4 = await sellOk(s, [cl(Q, 1, rs(1200))], on('08-08'));
  await must(await voidSaleNew(s, sa4.sales[0].id), 'void Sa4');
  await must(await rel(s, prov.Hutch!, rs(5000), on('08-08')), 'reload hutch');
  await must(await rel(s, prov.Airtel!, rs(2000), { ...on('08-08'), extraCents: rs(25) }), 'reload airtel');
  await payOk(s, 'other_cost', rs(300), { fund: 'profit', ...on('08-08'), description: 'Cups' });
  await must(await drawCash(s, { ...on('08-08'), book: 'telecom', amountCents: rs(1000) }), 'telecom drawing');
  await must(await capNew(s, { ...on('08-08'), book: 'shop', amountCents: rs(5000) }), 'shop capital');
  await must(await countNew(s, 'shop', rs(35050), { ...on('08-08'), note: 'Short by fifty' }), 'shop count');
  const cl1 = await must(await closeNew(s, 'shop', '2025-08-08'), 'close shop 08-08');
  w.dayClosed = await sellOkRaw(s, [cl(S, 1, rs(250))], on('08-08'));
  await must(await reopenNew(s, cl1.item.id, 'late sale to enter'), 'reopen');
  w.sales.Sa5 = (await sellOk(s, [cl(S, 1, rs(250))], on('08-08'))).sales[0];
  await must(await closeNew(s, 'shop', '2025-08-08'), 'close shop again');

  // ---- 08-09 Sat
  await must(await tr(s, 'shop', 'telecom', rs(3000), on('08-09')), 'transfer shop>telecom');
  await must(await tr(s, 'shop', 'icecream', rs(2000), { ...on('08-09'), toFund: 'cost' }), 'transfer shop>ice');

  // ---- 08-11 Mon
  await dayOk(s, { ...on('08-11'), salesCents: rs(6000), costAllocCents: rs(3500), electricityAllocCents: rs(600) });
  w.sales.Sa6 = (await sellOk(s, [cl(P, 4, rs(800)), cl(R, 1, rs(900))], on('08-11'))).sales[0];
  await must(await expNew(s, { ...on('08-11'), book: 'shop', category: 'water', amountCents: rs(800) }), 'water');
  await must(await expNew(s, { ...on('08-11'), book: 'shop', category: 'packaging', amountCents: rs(250) }), 'packaging');
  await must(await rel(s, prov.Dialog!, rs(20000), on('08-11')), 'reload dialog 2');
  await buy(s, [{ productId: R, packs: 1, packSize: 6, lineTotalCents: rs(3500) }], on('08-11'));
  w.sales.T2 = (await sellOk(s, [cl(K, 30, rs(100))], on('08-11'))).sales[0];

  // ---- 08-12 Tue
  await must(await moveNew(s, 'cost', 'electricity', rs(1000), on('08-12')), 'relabel');
  await must(await expNew(s, { ...on('08-12'), book: 'telecom', category: 'transport', amountCents: rs(600) }), 'transport');
  await must(await expNew(s, { ...on('08-12'), book: 'telecom', category: 'repairs', amountCents: rs(1200) }), 'repairs');
  w.sales.Sa7 = (await sellOk(s, [cl(R, 3, rs(900))], on('08-12'))).sales[0];
  await must(await psNew(s, { ...on('08-12'), qty: 40 }, 'CLR_1S'), 'print 40');
  await must(await tr(s, 'telecom', 'shop', rs(2500), on('08-12')), 'transfer telecom>shop');

  // ---- 08-13 Wed
  await must(await moveNew(s, 'cost', 'profit', rs(2000), on('08-13')), 'release 2000');
  await must(await expNew(s, { ...on('08-13'), book: 'shop', category: 'cleaning_supplies', amountCents: rs(450) }), 'cleaning');
  await must(await expNew(s, { ...on('08-13'), book: 'shop', category: 'other', amountCents: rs(700) }), 'other');
  await must(await expNew(s, { ...on('08-13'), book: 'telecom', category: 'stationery', amountCents: rs(300) }), 'stationery');
  const exv = await must(await expNew(s, { ...on('08-13'), book: 'shop', category: 'other', amountCents: rs(999) }), 'other to void');
  await must(await expVoid(s, exv.item.id), 'void expense');
  w.sales.Sa8 = (await sellOk(s, [cl(Q, 3, 133333)], on('08-13'))).sales[0];
  await must(await topProvider(s, prov.Mobitel!, rs(5000), on('08-13')), 'provider topup 2');

  // ---- 08-14 Thu
  w.d4 = (await moveNew(s, 'cost', 'profit', rs(4000), on('08-14'))).body;
  await must(await moveNew(s, 'cost', 'profit', rs(4000), { ...on('08-14'), confirmSplit: true, confirmedProfitEligibleCents: w.d4.error.profitEligibleCents }), 'release 4000 split');
  w.returns.Rt3 = (await returnOk(s, w.sales.Sa8.id, [rl(w.sales.Sa8.items[0].id, 1, true)], on('08-14'))).item;
  await must(await rel(s, prov.Mobitel!, 666666, on('08-14')), 'reload mobitel 2');
  await must(await ez(s, 1234567, on('08-14')), 'ezcash 2');
  await must(await stComplete(s, (await stDraft(s, [{ productId: K, countedQty: 48 }], { ...on('08-14'), book: 'telecom' })).id), 'stocktake telecom');

  // ---- 08-15 Fri
  await must(await moveNew(s, 'profit', 'electricity', rs(1500), on('08-15')), 're-allocation');
  w.returns.Rt4 = (await returnOk(s, w.sales.Sa8.id, [rl(w.sales.Sa8.items[0].id, 2, true)], on('08-15'))).item;
  w.sales.Sa9 = (await sellOk(s, [cl(S, 4, rs(250))], on('08-15'))).sales[0];
  await must(await lossNew(s, R, 1, { ...on('08-15'), reason: 'lost' }), 'loss R');
  const lossO = await must(await lossNew(s, S, 1, { ...on('08-15'), reason: 'other' }), 'loss S other');
  await must(await lossVoid(s, lossO.item.id), 'void loss');
  await must(await countNew(s, 'telecom', 7844566, { ...on('08-15'), note: 'Over by two hundred' }), 'telecom count over');

  // ---- 08-16 Sat
  await must(await tr(s, 'icecream', 'shop', rs(1000), { ...on('08-16'), fromFund: 'profit' }), 'transfer ice>shop');
  await must(await tr(s, 'telecom', 'icecream', rs(1500), { ...on('08-16'), toFund: 'electricity' }), 'transfer telecom>ice');
  await must(await tr(s, 'icecream', 'telecom', rs(800), { ...on('08-16'), fromFund: 'cost' }), 'transfer ice>telecom');
  await must(await drawCash(s, { ...on('08-16'), book: 'icecream', fund: 'profit', amountCents: rs(1000) }), 'ice drawing');

  // ---- 08-18 .. 08-25 (ice cream excess-cost story, shop activity)
  await payOk(s, 'materials', rs(3000), { fund: 'cost', ...on('08-18') });
  await buy(s, [{ productId: P, packs: 1, packSize: 10, lineTotalCents: rs(3400) }], on('08-18'));
  await dayOk(s, { ...on('08-19'), salesCents: rs(3000), costAllocCents: rs(1800), electricityAllocCents: rs(300) });
  const pv = await buy(s, [{ productId: P, packs: 1, packSize: 5, lineTotalCents: rs(2000) }], on('08-19'));
  await must(await post(s.app, `/purchases/${pv.id}/void`, { reason: 'wrong supplier' }), 'void purchase');
  await dayOk(s, { ...on('08-20'), salesCents: rs(1000), costAllocCents: rs(900), electricityAllocCents: rs(300), confirmNegativeProfit: true });
  w.sales.Sa12 = (await sellOk(s, [cl(P, 6, rs(800))], on('08-20'))).sales[0];
  await payOk(s, 'electricity_bill', rs(6000), { fund: 'electricity', ...on('08-21'), description: 'Aug bill' });
  await payOk(s, 'other_cost', rs(400), { fund: 'cost', ...on('08-22'), description: 'Repairs' });
  await dayOk(s, { ...on('08-25'), salesCents: rs(8000), costAllocCents: rs(4000), electricityAllocCents: rs(700) });

  // ---- September
  await must(await rel(s, prov.Dialog!, rs(8000), on('09-01')), 'reload sept');
  w.sales.Sa10 = (await sellOk(s, [cl(Q, 2, rs(1200))], on('09-01'))).sales[0];
  await must(await expNew(s, { ...on('09-01'), book: 'telecom', category: 'internet', amountCents: rs(1500) }), 'internet sept');
  await payOk(s, 'electricity_bill', rs(5000), { fund: 'electricity', ...on('09-02'), description: 'Sept bill' });
  await buy(s, [{ productId: R, packs: 1, packSize: 4, lineTotalCents: rs(2500) }], on('09-02'));
  await dayOk(s, { ...on('09-03'), salesCents: rs(2000), costAllocCents: rs(1000), electricityAllocCents: rs(200) });
  w.sales.T3 = (await sellOk(s, [cl(K, 10, rs(100))], on('09-03'))).sales[0];
  w.returns.Rt5 = (await returnOk(s, w.sales.Sa2.id, [rl(w.sales.Sa2.items[0].id, 1, true)], on('09-04'))).item;
  w.sales.Sa11 = (await sellOk(s, [cl(P, 3, rs(800))], on('09-04'))).sales[0];
  await must(await expNew(s, { ...on('09-05'), book: 'shop', category: 'rent', amountCents: rs(10000) }), 'rent sept');
  await must(await psNew(s, { ...on('09-05'), qty: 50 }, 'BW_2S'), 'print sept');
  await must(await supNew(s, { ...on('09-05'), amountCents: rs(800), description: 'Toner' }), 'supplies sept');
  await must(await rel(s, prov.Hutch!, rs(4000), on('09-05')), 'reload hutch sept');
  await must(await ez(s, rs(8000), on('09-05')), 'ezcash sept');
  await must(await moveNew(s, 'profit', 'cost', rs(1000), on('09-08')), 're-allocation sept');
  await must(await lossNew(s, P, 1, { ...on('09-08'), reason: 'expired' }), 'loss P');
  await must(await stComplete(s, (await stDraft(s, [{ productId: S, countedQty: 5 }], { ...on('09-08'), book: 'shop' })).id), 'stocktake sept');
  await must(await capNew(s, { ...on('09-09'), book: 'icecream', fund: 'electricity', amountCents: rs(500) }), 'ice capital');
  // ---- 09-10 counts (over / short) and 09-12 ice cream closing
  await must(await countNew(s, 'shop', 2977000, { ...on('09-10'), note: 'Over by 120' }), 'shop count sept');
  await must(await countNew(s, 'telecom', 9694566, { ...on('09-10'), note: 'Short by 300' }), 'telecom count sept');
  await must(await countNew(s, 'icecream', 1440000, { ...on('09-10'), fund: 'profit', note: 'Short by 100' }), 'ice count');
  const icl = await must(await closeNew(s, 'icecream', '2025-09-12'), 'close ice');
  const a = await payNew(s, 'other_cost', rs(50), { fund: 'cost', ...on('09-12') });
  const b = await tr(s, 'shop', 'icecream', rs(10), { ...on('09-12'), toFund: 'cost' });
  w.iceClosed = { status: a.status, body: a.body, status2: b.status, body2: b.body };
  await must(await reopenNew(s, icl.item.id, 'closed by mistake'), 'reopen ice');
  void dayNew; void payNew; void dayVoid; void relVoid; void closeNew; void get;
  return w;
}

/** Raw POST /sales (no throw) so a DAY_CLOSED rejection can be inspected. */
async function sellOkRaw(s: ApiBase, items: unknown[], over: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return post(s.app, '/sales', { items, clientRef: ref(), ...over });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// (2) Global invariants (must hold after ANY state)
// ---------------------------------------------------------------------------------------------------------------------------------------

/** Every database table that is not SQLite-internal. */
export function tableNames(ctx: AppContext): string[] {
  return rows(ctx, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name as string);
}

/** Today in Asia/Colombo, computed independently of the server code (now + 330 minutes). */
export const todayColombo = (): string => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/**
 * Append-only probes: [table, UPDATE that changes a money/identity column, whether the table is expected to refuse deletes].
 * Every statement must be REFUSED by the database (a trigger raises). Each is run inside a savepoint that is always rolled back, so
 * a probe that wrongly succeeds is undone and reported instead of corrupting the rest of the run.
 */
const UPDATE_PROBES: Array<[string, string]> = [
  ['audit_logs', 'note = COALESCE(note,\'\') || \'x\''],
  ['cash_entries', 'amount_cents = amount_cents + 1'],
  ['stock_movements', 'qty_delta = qty_delta + 1'],
  ['icecream_fund_entries', 'amount_cents = amount_cents + 1'],
  ['icecream_sales', 'qty = qty + 1'],
  ['sales_returns', 'refund_cents = refund_cents + 1'],
  ['sales_return_items', 'qty = qty + 1'],
  ['purchase_returns', 'refund_cents = refund_cents + 1'],
  ['purchase_return_items', 'units = units + 1'],
  ['expenses', 'amount_cents = amount_cents + 1'],
  ['sales', 'total_cents = total_cents + 1'],
  ['sale_items', 'qty = qty + 1'],
  ['purchases', 'total_cents = total_cents + 1'],
  ['purchase_items', 'units = units + 1'],
  ['reload_sales', 'sales_cents = sales_cents + 1'],
  ['ezcash_sales', 'bill_total_cents = bill_total_cents + 1'],
  ['telecom_topups', 'amount_cents = amount_cents + 1'],
  ['print_sales', 'revenue_cents = revenue_cents + 1'],
  ['printing_supplies', 'amount_cents = amount_cents + 1'],
  ['owner_drawings', 'amount_cents = amount_cents + 1'],
  ['capital_entries', 'amount_cents = amount_cents + 1'],
  ['cash_transfers', 'amount_cents = amount_cents + 1'],
  ['cash_counts', 'counted_cents = counted_cents + 1'],
  ['icecream_days', 'sales_cents = sales_cents + 1'],
  ['icecream_payments', 'amount_cents = amount_cents + 1'],
  ['icecream_fund_moves', 'amount_cents = amount_cents + 1'],
  ['stock_losses', 'cost_cents = cost_cents + 1'],
  ['opening_stock_batches', 'total_value_cents = total_value_cents + 1'],
];
/** Tables that carry business records and must refuse DELETE (no hard deletes of completed transactions). */
const NO_DELETE = ['audit_logs', 'cash_entries', 'stock_movements', 'icecream_fund_entries', 'icecream_sales', 'sales_returns', 'sales_return_items',
  'purchase_returns', 'purchase_return_items', 'expenses', 'sales', 'sale_items', 'purchases', 'purchase_items', 'reload_sales', 'ezcash_sales',
  'telecom_topups', 'print_sales', 'printing_supplies', 'owner_drawings', 'capital_entries', 'cash_transfers', 'cash_counts', 'icecream_days',
  'icecream_payments', 'icecream_fund_moves', 'stock_losses', 'stocktakes', 'opening_stock_batches', 'daily_closings'];
/** Tables whose voided rows must never be revivable (status void -> posted). */
const REVIVE_PROBES: Array<[string, string, string]> = [
  ['expenses', 'status', 'posted'], ['sales', 'status', 'posted'], ['purchases', 'status', 'posted'], ['reload_sales', 'status', 'posted'],
  ['ezcash_sales', 'status', 'posted'], ['telecom_topups', 'status', 'posted'], ['print_sales', 'status', 'posted'],
  ['printing_supplies', 'status', 'posted'], ['owner_drawings', 'status', 'posted'], ['capital_entries', 'status', 'posted'],
  ['cash_transfers', 'status', 'posted'], ['icecream_days', 'status', 'posted'], ['icecream_payments', 'status', 'posted'],
  ['icecream_fund_moves', 'status', 'posted'], ['stock_losses', 'status', 'posted'], ['cash_counts', 'status', 'posted'],
];

/** Runs one statement inside a savepoint; returns true if the database refused it. The savepoint is always rolled back. */
function refused(ctx: AppContext, sql: string): boolean {
  const c = ctx.database.conn;
  c.exec('SAVEPOINT p14probe');
  let ok = true;
  try { c.exec(sql); ok = false; } catch { ok = true; }
  c.exec('ROLLBACK TO p14probe');
  c.exec('RELEASE p14probe');
  return ok;
}

/** Statuses allowed per table (default posted / void). */
const STATUS_SETS: Record<string, string[]> = { stocktakes: ['draft', 'completed', 'void'], import_runs: ['preview', 'committed', 'failed', 'error', 'ok', 'previewed', 'imported'] };

/** Business-record tables that own cash / fund ledger rows by (ref_table, ref_id) and can be voided through reversal rows. */
const LEDGER_OWNERS = ['sales', 'purchases', 'expenses', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales', 'printing_supplies',
  'owner_drawings', 'capital_entries', 'cash_transfers', 'icecream_days', 'icecream_payments', 'cash_counts', 'icecream_fund_moves'];
/** Cash-entry type -> the only book it may live in (BUSINESS_RULES section 2). Types not listed may be in any book. */
const TYPE_BOOK: Record<string, string[]> = {
  sale_goods: ['shop'], sale_service: ['shop'], sale_refund: ['shop'], card_sale: ['telecom'], card_refund: ['telecom'],
  reload_collection: ['telecom'], ezcash_collection: ['telecom'], provider_topup: ['telecom'], wallet_topup: ['telecom'],
  purchase_payment: ['shop', 'telecom'], purchase_refund: ['shop', 'telecom'], expense: ['shop', 'telecom'], expense_refund: ['shop', 'telecom'],
  icecream_sale: ['icecream'], icecream_materials_payment: ['icecream'], icecream_electricity_payment: ['icecream'], icecream_other_cost: ['icecream'],
  printing_supplies: ['shop'],
};

/** Options of assertGlobalInvariants. */
export interface InvariantOptions {
  /** Skip the (slower) UPDATE/DELETE refusal probes. Default false: they run every time. */
  skipAppendOnly?: boolean;
  /** Skip the Combined = sum of segments report comparison. Default false. */
  skipReports?: boolean;
}

/**
 * The global invariant checker. Call it after ANY state of the database. Everything is derived from the raw tables or from independent
 * sums; the only API calls are the reconciliation reads at the end. It throws (via vitest `expect`) on the first violation, naming it.
 */
export async function assertGlobalInvariants(s: { app: FastifyInstance; ctx: AppContext }, opt: InvariantOptions = {}): Promise<void> {
  const { ctx } = s;
  const today = todayColombo();

  // 1. Each cash book balance = sum of its cash entries; the API agrees; entries live in an allowed book; ice cream rows name a fund.
  const bal: Record<string, number> = {};
  for (const r of rows(ctx, 'SELECT book, COALESCE(SUM(amount_cents),0) AS t FROM cash_entries GROUP BY book')) bal[r.book] = Number(r.t);
  const api = (await get(s.app, '/cashbooks')).body;
  for (const b of api.books) expect(b.balanceCents, `cashbooks API ${b.book}`).toBe(bal[b.book] ?? 0);
  expect(n1(ctx, "SELECT COUNT(*) FROM cash_entries WHERE book NOT IN ('shop','telecom','icecream')"), 'unknown book').toBe(0);
  expect(n1(ctx, "SELECT COUNT(*) FROM cash_entries WHERE book = 'icecream' AND fund IS NULL"), 'ice cream cash row without fund').toBe(0);
  expect(n1(ctx, "SELECT COUNT(*) FROM cash_entries WHERE book <> 'icecream' AND fund IS NOT NULL"), 'fund on a non-ice-cream cash row').toBe(0);
  for (const r of rows(ctx, 'SELECT DISTINCT type, book FROM cash_entries')) {
    const allowed = TYPE_BOOK[r.type as string];
    if (allowed) expect(allowed, `cash type ${r.type} in book ${r.book}`).toContain(r.book);
  }

  // 2. Ice Cream: Cost + Electricity + Profit = Ice Cream book = sum of ice cream cash entries = sum of fund entries (and per fund).
  const fund: Record<string, number> = { cost: 0, electricity: 0, profit: 0 };
  for (const r of rows(ctx, 'SELECT fund, COALESCE(SUM(amount_cents),0) AS t FROM icecream_fund_entries GROUP BY fund')) fund[r.fund as string] = Number(r.t);
  const iceBook = bal.icecream ?? 0;
  expect(fund.cost! + fund.electricity! + fund.profit!, 'funds vs Ice Cream book').toBe(iceBook);
  expect(n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries'), 'fund entries vs cash entries').toBe(iceBook);
  // (per-fund cash sums legitimately differ from the fund ledger: fund moves write fund rows and no cash rows)
  for (const r of rows(ctx, "SELECT DISTINCT fund FROM cash_entries WHERE book='icecream'")) expect(['cost', 'electricity', 'profit']).toContain(r.fund);
  const icApi = api.books.find((b: any) => b.book === 'icecream');
  expect(icApi.funds).toEqual({ cost: fund.cost, electricity: fund.electricity, profit: fund.profit });

  // 3. Stock: cache = sum of movements per product; no negative quantity; no value without quantity.
  for (const r of rows(ctx, `SELECT p.id, p.qty_on_hand q, p.stock_value_cents v,
      COALESCE((SELECT SUM(qty_delta) FROM stock_movements m WHERE m.product_id = p.id),0) mq,
      COALESCE((SELECT SUM(value_delta_cents) FROM stock_movements m WHERE m.product_id = p.id),0) mv FROM products p`)) {
    expect(Number(r.q), `product ${r.id} qty cache vs movements`).toBe(Number(r.mq));
    expect(Number(r.v), `product ${r.id} value cache vs movements`).toBe(Number(r.mv));
    expect(Number(r.q), `product ${r.id} negative stock`).toBeGreaterThanOrEqual(0);
    expect(Number(r.v), `product ${r.id} negative value`).toBeGreaterThanOrEqual(0);
    if (Number(r.q) === 0) expect(Number(r.v), `product ${r.id} value without quantity`).toBe(0);
  }
  const recon = (await get(s.app, '/inventory/reconciliation')).body;
  expect(recon.ok, JSON.stringify(recon.mismatches)).toBe(true);

  // 4. Statuses, no future business dates, valid date format, on every table that has them.
  for (const t of tableNames(ctx)) {
    const cols = rows(ctx, `PRAGMA table_info(${t})`).map((c) => c.name as string);
    if (cols.includes('status') && t !== 'import_runs') {
      const allowed = STATUS_SETS[t] ?? ['posted', 'void'];
      const bad = rows(ctx, `SELECT DISTINCT status FROM ${t} WHERE status NOT IN (${allowed.map((a) => `'${a}'`).join(',')})`);
      expect(bad, `${t}: unexpected status values`).toEqual([]);
    }
    if (cols.includes('business_date')) {
      expect(n1(ctx, `SELECT COUNT(*) FROM ${t} WHERE business_date > ?`, today), `${t}: future business date`).toBe(0);
      expect(n1(ctx, `SELECT COUNT(*) FROM ${t} WHERE business_date IS NOT NULL AND business_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`), `${t}: bad date`).toBe(0);
    }
  }

  // 5. Electricity is never an expense or a cost category, in any segment.
  expect(n1(ctx, "SELECT COUNT(*) FROM expenses WHERE lower(trim(category)) LIKE '%electric%'"), 'electricity expense').toBe(0);
  expect(n1(ctx, "SELECT COUNT(*) FROM expenses WHERE book NOT IN ('shop','telecom')"), 'expense outside shop/telecom').toBe(0);
  expect(n1(ctx, "SELECT COUNT(*) FROM icecream_payments WHERE kind = 'other_cost' AND lower(COALESCE(category,'')) LIKE '%electric%'"), 'electricity as other cost').toBe(0);
  expect(n1(ctx, "SELECT COUNT(*) FROM icecream_payments WHERE kind <> 'electricity_bill' AND lower(COALESCE(category,'')) LIKE '%electric%'"), 'electricity category on non-bill').toBe(0);
  expect(n1(ctx, "SELECT COUNT(*) FROM cash_entries WHERE type IN ('expense','expense_refund') AND book = 'icecream'"), 'expense entry in ice cream book').toBe(0);

  // 6. Voids are reversal rows that exactly negate their originals; posted records have no reversal rows.
  for (const [ledger, kindCol] of [['cash_entries', 'type'], ['icecream_fund_entries', 'kind']] as const) {
    const rev = rows(ctx, `SELECT r.id rid, r.amount_cents ra, r.business_date rd, r.ref_table rt, r.ref_id ri, r.fund rf, r.${kindCol} rk, ${ledger === 'cash_entries' ? 'r.book rb, o.book ob,' : ''}
        o.id oid, o.amount_cents oa, o.business_date od, o.ref_table ot, o.ref_id oi, o.fund ofund, o.${kindCol} ok, o.reverses_entry_id oo
        FROM ${ledger} r LEFT JOIN ${ledger} o ON o.id = r.reverses_entry_id WHERE r.reverses_entry_id IS NOT NULL`);
    const seen = new Set<number>();
    for (const r of rev) {
      expect(r.oid, `${ledger} reversal ${r.rid}: original exists`).not.toBeNull();
      expect(r.oo, `${ledger} reversal of a reversal`).toBeNull();
      expect(Number(r.ra), `${ledger} reversal ${r.rid} negates ${r.oid}`).toBe(-Number(r.oa));
      expect(r.rd, `${ledger} reversal ${r.rid} keeps the business date`).toBe(r.od);
      expect([r.rt, r.ri], `${ledger} reversal ${r.rid} same record`).toEqual([r.ot, r.oi]);
      expect(r.rf, 'same fund').toBe(r.ofund);
      // a reversal carries the original's type, or the neutral type 'reversal' (some modules use that spelling)
      if (r.rk !== 'reversal') expect(r.rk, 'same kind').toBe(r.ok);
      if (ledger === 'cash_entries') expect(r.rb, 'same book').toBe(r.ob);
      expect(seen.has(Number(r.oid)), `${ledger} entry ${r.oid} reversed twice`).toBe(false);
      seen.add(Number(r.oid));
    }
  }
  for (const t of LEDGER_OWNERS) {
    const cols = rows(ctx, `PRAGMA table_info(${t})`).map((c) => c.name as string);
    if (!cols.includes('status')) continue;
    for (const ledger of ['cash_entries', 'icecream_fund_entries']) {
      const voidNet = rows(ctx, `SELECT x.id, COALESCE(SUM(l.amount_cents),0) t, COUNT(l.id) n,
          SUM(CASE WHEN l.reverses_entry_id IS NULL THEN 1 ELSE 0 END) o, SUM(CASE WHEN l.reverses_entry_id IS NOT NULL THEN 1 ELSE 0 END) r
          FROM ${t} x JOIN ${ledger} l ON l.ref_table = '${t}' AND l.ref_id = x.id WHERE x.status = 'void' GROUP BY x.id`);
      for (const r of voidNet) {
        expect(Number(r.t), `${t} #${r.id} is void: ${ledger} rows net to zero`).toBe(0);
        expect(Number(r.o), `${t} #${r.id}: every original reversed once`).toBe(Number(r.r));
      }
      const postedRev = n1(ctx, `SELECT COUNT(*) FROM ${t} x JOIN ${ledger} l ON l.ref_table = '${t}' AND l.ref_id = x.id WHERE x.status = 'posted' AND l.reverses_entry_id IS NOT NULL`);
      expect(postedRev, `${t}: posted record with a reversal row in ${ledger}`).toBe(0);
    }
  }
  // stock: a voided sale / goods drawing / loss / stocktake / opening batch nets to zero stock movement; a voided purchase nets to zero quantity.
  const stockOwners: Array<[string, string, boolean]> = [['sales', 'sales', true], ['stock_losses', 'stock_losses', true], ['owner_drawings', 'owner_drawings', true],
    ['stocktakes', 'stocktakes', true], ['opening_stock_batches', 'opening_stock_batches', true], ['purchases', 'purchases', false]];
  for (const [t, refTable, withValue] of stockOwners) {
    const ids = rows(ctx, `SELECT id FROM ${t} WHERE status = 'void'`).map((r) => Number(r.id));
    for (const id of ids) {
      const r = rows(ctx, 'SELECT COALESCE(SUM(qty_delta),0) q, COALESCE(SUM(value_delta_cents),0) v FROM stock_movements WHERE ref_table = ? AND ref_id = ?', refTable, id)[0]!;
      expect(Number(r.q), `${t} #${id} void: stock quantity nets to zero`).toBe(0);
      if (withValue) expect(Number(r.v), `${t} #${id} void: stock value nets to zero`).toBe(0);
    }
  }

  // 7. Append-only: every UPDATE / DELETE probe must be refused by the database.
  if (!opt.skipAppendOnly) {
    for (const [t, set] of UPDATE_PROBES) {
      if (n1(ctx, `SELECT COUNT(*) FROM ${t}`) === 0) continue;
      expect(refused(ctx, `UPDATE ${t} SET ${set} WHERE rowid = (SELECT MIN(rowid) FROM ${t})`), `UPDATE on ${t} must be refused`).toBe(true);
    }
    for (const t of NO_DELETE) {
      if (n1(ctx, `SELECT COUNT(*) FROM ${t}`) === 0) continue;
      expect(refused(ctx, `DELETE FROM ${t} WHERE rowid = (SELECT MIN(rowid) FROM ${t})`), `DELETE on ${t} must be refused`).toBe(true);
    }
    for (const [t, col, val] of REVIVE_PROBES) {
      if (n1(ctx, `SELECT COUNT(*) FROM ${t} WHERE status = 'void'`) === 0) continue;
      expect(refused(ctx, `UPDATE ${t} SET ${col} = '${val}' WHERE rowid = (SELECT MIN(rowid) FROM ${t} WHERE status = 'void')`), `${t}: reviving a void row must be refused`).toBe(true);
    }
  }

  // 8. Combined P&L = sum of the segments (totals and rows), over everything ever recorded.
  if (!opt.skipReports) {
    const first = rows(ctx, `SELECT MIN(d) AS d FROM (SELECT MIN(business_date) d FROM cash_entries UNION ALL SELECT MIN(business_date) FROM stock_movements
      UNION ALL SELECT MIN(business_date) FROM icecream_fund_entries)`)[0]!.d as string | null;
    if (first) {
      const qs = `from=${first}&to=${today}&granularity=month`;
      const [shop, tel, ice, comb] = await Promise.all(['shop', 'telecom', 'icecream', 'combined'].map((x) => get(s.app, `/reports/pnl/${x}?${qs}`)));
      for (const r of [shop!, tel!, ice!, comb!]) expect(r.status, JSON.stringify(r.body)).toBe(200);
      const sum = shop!.body.totals.netProfitCents + tel!.body.totals.netProfitCents + ice!.body.totals.recognizedProfitCents;
      expect(comb!.body.totals.recognizedProfitCents, 'Combined total = Shop + Telecom + Ice Cream').toBe(sum);
      expect(comb!.body.totals.segments.shop.recognizedProfitCents).toBe(shop!.body.totals.netProfitCents);
      expect(comb!.body.totals.segments.telecom.recognizedProfitCents).toBe(tel!.body.totals.netProfitCents);
      expect(comb!.body.totals.segments.icecream.recognizedProfitCents).toBe(ice!.body.totals.recognizedProfitCents);
      expect(comb!.body.rows.reduce((a: number, r: any) => a + r.recognizedProfitCents, 0), 'Combined rows add up').toBe(sum);
      expect(shop!.body.rows.reduce((a: number, r: any) => a + r.netProfitCents, 0), 'Shop rows add up').toBe(shop!.body.totals.netProfitCents);
    }
  }
}

/**
 * A text fingerprint of every table (all rows, rowid order). Two equal snapshots prove that nothing was inserted, updated or deleted in
 * between. The `settings` table is included; nothing is excluded.
 */
export function snapshotAll(ctx: AppContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tableNames(ctx)) {
    out[t] = JSON.stringify(rows(ctx, `SELECT * FROM "${t}" ORDER BY rowid`), (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  }
  return out;
}

/** Names of the tables whose content differs between two snapshots (empty = identical). */
export function diffSnapshots(a: Record<string, string>, b: Record<string, string>): string[] {
  return Object.keys(b).filter((t) => a[t] !== b[t]);
}

/**
 * Independent RECONCILIATION of the Shop P&L with the ledgers (an accounting identity that needs no report code). Shop has no float (unlike Telecom, R14), so
 *   equity change = cash + stock value
 *   net profit    = equity change - inflows (opening balance, capital, transfers net, opening stock) + drawings (cash + goods at cost)
 *                   + printing supplies bought (cash out, never P&L) - standard print cost charged - extra cost on sales (net of returns)
 * where every figure is summed straight from the ledger tables. The ledger side already contains the purchase refund gain (cash refunded above the stock value removed, R4); the
 * report must contain it too (Stock adjustments), so the two figures must be EXACTLY equal (no tolerance).
 * @returns the report figure and the ledger figure (equal when the books reconcile)
 */
export async function shopIdentity(s: { app: FastifyInstance; ctx: AppContext }): Promise<{ reportProfit: number; ledgerProfit: number }> {
  const ctx = s.ctx; const shopP = "(SELECT id FROM products WHERE book = 'shop')";
  const cash = (types: string[]) => n1(ctx, `SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book='shop' AND type IN (${types.map((t) => `'${t}'`).join(',')})`);
  const mv = (types: string[]) => n1(ctx, `SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE product_id IN ${shopP} AND type IN (${types.map((t) => `'${t}'`).join(',')})`);
  const equity = n1(ctx, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book='shop'") + n1(ctx, "SELECT COALESCE(SUM(stock_value_cents),0) FROM products WHERE book='shop'");
  const inflows = cash(['opening_balance', 'capital', 'transfer_in', 'transfer_out']) + mv(['opening']);
  const drawings = -cash(['drawing_cash']) - mv(['personal_use']);
  const supplies = -cash(['printing_supplies']);
  const svcCost = n1(ctx, "SELECT COALESCE(SUM(cogs_cents),0) FROM print_sales WHERE status='posted'");
  const extra = n1(ctx, "SELECT COALESCE(SUM(si.extra_cost_cents),0) FROM sale_items si JOIN sales x ON x.id = si.sale_id WHERE x.status='posted' AND x.book='shop'")
    - n1(ctx, "SELECT COALESCE(SUM(r.extra_cost_reversed_cents),0) FROM sales_returns r JOIN sales x ON x.id = r.sale_id WHERE x.book='shop'");
  const ledgerProfit = equity - inflows + drawings + supplies - svcCost - extra;
  const first = rows(ctx, 'SELECT MIN(d) d FROM (SELECT MIN(business_date) d FROM cash_entries UNION ALL SELECT MIN(business_date) FROM stock_movements)')[0]!.d as string | null;
  const rep = first ? (await get(s.app, `/reports/pnl/shop?from=${first}&to=${todayColombo()}&granularity=month`)).body.totals.netProfitCents as number : 0;
  return { reportProfit: rep, ledgerProfit };
}

/**
 * Telecom net profit straight from the raw rows with plain SQL (BUSINESS_RULES 5, 11, C4, C13): reload + EZCash commission, card gross profit net of returns
 * (automatic + extra cost), minus Telecom expenses, minus stock adjustments (loss / stocktake / residual-sweep movements of Telecom products and damaged-return
 * losses), plus cash over/short of the Telecom book. Posted rows only; voided rows and reversal rows are ignored exactly as the rules say.
 */
export function telecomNetFromTables(ctx: AppContext): number { return segNetFromTables(ctx, 'telecom', '0000-01-01', '9999-12-31'); }

/**
 * Shop or Telecom net profit for business dates in [from, to], straight from the raw rows (no report code): every figure is attributed to the business date of the
 * record that carries it - a sale to its own date, a return to the RETURN's date (R5/R7), a stock adjustment to its movement's date, a cash difference to the count's.
 */
export function segNetFromTables(ctx: AppContext, book: 'shop' | 'telecom', from: string, to: string): number {
  const w = (col: string) => `${col} >= '${from}' AND ${col} <= '${to}'`;
  const comm = book === 'telecom'
    ? n1(ctx, `SELECT COALESCE(SUM(commission_cents),0) FROM reload_sales WHERE status='posted' AND ${w('business_date')}`) + n1(ctx, `SELECT COALESCE(SUM(commission_cents),0) FROM ezcash_sales WHERE status='posted' AND ${w('business_date')}`)
    : n1(ctx, `SELECT COALESCE(SUM(revenue_cents - cogs_cents),0) FROM print_sales WHERE status='posted' AND ${w('business_date')}`);
  const rev = n1(ctx, `SELECT COALESCE(SUM(si.revenue_cents),0) FROM sale_items si JOIN sales x ON x.id=si.sale_id WHERE x.status='posted' AND x.book='${book}' AND ${w('x.business_date')}`)
    - n1(ctx, `SELECT COALESCE(SUM(r.refund_cents),0) FROM sales_returns r JOIN sales x ON x.id=r.sale_id WHERE x.book='${book}' AND ${w('r.business_date')}`);
  const cost = n1(ctx, `SELECT COALESCE(SUM(si.cogs_cents + si.extra_cost_cents),0) FROM sale_items si JOIN sales x ON x.id=si.sale_id WHERE x.status='posted' AND x.book='${book}' AND ${w('x.business_date')}`)
    - n1(ctx, `SELECT COALESCE(SUM(r.cogs_reversed_cents + r.extra_cost_reversed_cents),0) FROM sales_returns r JOIN sales x ON x.id=r.sale_id WHERE x.book='${book}' AND ${w('r.business_date')}`);
  const exp = n1(ctx, `SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE status='posted' AND book='${book}' AND ${w('business_date')}`);
  const adj = -n1(ctx, `SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE type IN ('loss','stocktake_gain','stocktake_loss','adjustment') AND ${w('business_date')} AND product_id IN (SELECT id FROM products WHERE book='${book}')`)
    + n1(ctx, `SELECT COALESCE(SUM(cost_cents),0) FROM stock_losses WHERE status='posted' AND source='damaged_return' AND book='${book}' AND ${w('business_date')}`);
  const os = n1(ctx, `SELECT COALESCE(SUM(difference_cents),0) FROM cash_counts WHERE status='posted' AND book='${book}' AND ${w('business_date')}`);
  return comm + (rev - cost) - exp - adj + os;
}

/** Row count of every table: a cheap "did anything get written?" fingerprint. */
export function countsAll(ctx: AppContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tableNames(ctx)) out[t] = n1(ctx, `SELECT COUNT(*) FROM "${t}"`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// (3) Randomized multi-module simulation with an INDEPENDENT in-test model of cash books, Ice Cream funds and stock
// ---------------------------------------------------------------------------------------------------------------------------------------

type Book = 'shop' | 'telecom' | 'icecream';
type Fund = 'cost' | 'electricity' | 'profit';
const FUNDS: Fund[] = ['cost', 'electricity', 'profit'];
const CATS = ['water', 'rent', 'internet', 'transport', 'repairs', 'cleaning_supplies', 'packaging', 'stationery', 'other'];

/** round(a x b / c), half away from zero, for non-negative a, b and positive c (plain integer arithmetic; values stay far below 2^53). */
const mdr = (a: number, b: number, c: number): number => Math.floor((2 * a * b + c) / (2 * c));
/** mulberry32 seeded generator (replayable runs). */
export function rng14(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Delta {
  cash: Array<{ book: Book; amt: number; fund?: Fund }>;
  fund: Array<{ fund: Fund; amt: number }>;
  stock: Array<{ pid: number; qty: number; value: number }>;
}
interface PurLine { pid: number; units: number; total: number; returned: number; retValue: number; itemId: number }
interface SaleLine { itemId: number; pid: number; qty: number; rev: number; cogs: number; retQty: number; retRev: number; retCogs: number }
interface Rec {
  kind: string; date: string; books: Book[]; delta: Delta; voidUrl: string | null; voided: boolean; id: number; hasReturns?: boolean;
  pur?: { book: Book; lines: PurLine[] }; sale?: { book: Book; lines: SaleLine[] }; dayDate?: string; fundOnlyKind?: boolean; ice?: unknown;
}

/** Outcome of one simulated operation. */
export interface SimStats { ops: number; byKind: Record<string, number>; rejected: Record<string, number> }

/**
 * The simulation: builds a small shop through the API, then runs `n` seeded random operations from every module. After every operation
 * it (1) compares the API/database with its own independent model of the cash books, the three Ice Cream funds and the stock pools,
 * (2) checks the outcome (status and error code) the model predicted, (3) runs assertGlobalInvariants.
 */
export class Simulation {
  s: ApiBase;
  rnd: () => number;
  seed: number;
  cash: Record<Book, number> = { shop: 0, telecom: 0, icecream: 0 };
  fund: Record<Fund, number> = { cost: 0, electricity: 0, profit: 0 };
  stock = new Map<number, { qty: number; value: number }>();
  closed = new Set<string>();
  closingIds = new Map<string, number>();
  recs: Rec[] = [];
  shopP: number[] = [];
  telP: number[] = [];
  prov: number[] = [];
  iceDays = new Map<string, Rec>();
  /**
   * Independent oracle of BUSINESS_RULES section 10.4 (written from the rules, not from the service): Charged / Settled per line, recognized profit (all time,
   * posting order), net releases. `ChM`/`ChE` = Charged Materials/Electricity, `SeM`/`SeE` = Settled, `RP` = recognized profit, `rel` = profit-eligible releases - re-allocations.
   */
  ice = { ChM: 0, ChE: 0, SeM: 0, SeE: 0, RP: 0, rel: 0 };
  iceU(s = this.ice): { M: number; E: number; U: number } { const M = s.ChM - s.SeM; const E = s.ChE - s.SeE; return { M, E, U: M + E }; }
  /** D2: would moving from the current oracle state to `next` be refused (a void that lowers a Charged line or the combined Unspent AND leaves released profit unbacked)? */
  iceBlocked(next: { ChM: number; ChE: number; SeM: number; SeE: number; rel: number }): boolean {
    const cur = this.iceU(); const nx = this.iceU({ ...this.ice, ...next });
    const lowered = next.ChM < this.ice.ChM || next.ChE < this.ice.ChE || nx.U < cur.U;
    const bad = next.ChM < 0 || next.ChE < 0 || (next.rel > 0 && nx.U < 0);
    return lowered && bad;
  }
  /** Oracle effect of a fund move at the current state: charge changes, profit change and the profit-eligible limit. */
  iceMoveEffect(from: Fund, to: Fund, x: number): { dChM: number; dChE: number; dRP: number; dRel: number; limit: number | null; eligible: number } {
    const u = this.iceU(); const lim = (un: number) => Math.min(Math.max(0, un), Math.max(0, u.U));
    if (from === 'cost' && to === 'electricity') { const r = Math.min(x, Math.max(0, u.M)); return { dChM: -r, dChE: r, dRP: 0, dRel: 0, limit: null, eligible: 0 }; }
    if (from === 'electricity' && to === 'cost') { const r = Math.min(x, Math.max(0, u.E)); return { dChM: r, dChE: -r, dRP: 0, dRel: 0, limit: null, eligible: 0 }; }
    if (to === 'profit') { const limit = lim(from === 'cost' ? u.M : u.E); const e = Math.min(x, limit); return { dChM: from === 'cost' ? -e : 0, dChE: from === 'electricity' ? -e : 0, dRP: e, dRel: e, limit, eligible: e }; }
    return { dChM: to === 'cost' ? x : 0, dChE: to === 'electricity' ? x : 0, dRP: -x, dRel: -x, limit: null, eligible: 0 };
  }
  stats: SimStats = { ops: 0, byKind: {}, rejected: {} };
  log: string[] = [];
  lastExpense: Record<string, unknown> | null = null;
  skipReports: boolean;

  /** 'mixed' = every module; 'ice' = mostly Ice Cream days, payments, moves, voids and re-allocations (stresses the section 10.4 limits and the D2 guard). */
  profile: 'mixed' | 'ice';
  constructor(s: ApiBase, seed: number, skipReports = false, profile: 'mixed' | 'ice' = 'mixed') {
    this.s = s; this.seed = seed; this.rnd = rng14(seed); this.skipReports = skipReports; this.profile = profile;
  }

  // ---------- random helpers ----------
  int(lo: number, hi: number): number { return lo + Math.floor(this.rnd() * (hi - lo + 1)); }
  pick<T>(a: readonly T[]): T { return a[Math.floor(this.rnd() * a.length)]!; }
  chance(p: number): boolean { return this.rnd() < p; }
  /** Random business date in the last 14 days (0 = today) that is open for all given books; null if none found. */
  date(books: Book[], minDate?: string): string | null {
    for (let i = 0; i < 12; i++) {
      const d = daysAgo(this.int(0, 14));
      if (minDate && d < minDate) continue;
      if (!this.isClosed(books, d)) return d;
    }
    return null;
  }
  isClosed(books: Book[], d: string): boolean { return books.some((b) => this.closed.has(`${b}|${d}`)); }
  bookOf(pid: number): Book { return this.telP.includes(pid) ? 'telecom' : 'shop'; }

  // ---------- model ----------
  apply(d: Delta, sign: 1 | -1): void {
    for (const c of d.cash) { this.cash[c.book] += sign * c.amt; if (c.book === 'icecream') this.fund[c.fund!] += sign * c.amt; }
    for (const f of d.fund) this.fund[f.fund] += sign * f.amt;
    for (const st of d.stock) { const p = this.stock.get(st.pid)!; p.qty += sign * st.qty; p.value += sign * st.value; }
  }
  pool(pid: number): { qty: number; value: number } { return this.stock.get(pid)!; }
  /** value removed for q units from a pool (whole remaining value when q = qty). */
  take(pid: number, q: number): number { const p = this.pool(pid); return q === p.qty ? p.value : mdr(p.value, q, p.qty); }

  // ---------- verification after every step ----------
  async verify(label: string): Promise<void> {
    const ctx = this.s.ctx;
    for (const b of ['shop', 'telecom', 'icecream'] as Book[]) {
      expect(n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', b), `${label}: model vs ledger, ${b} cash`).toBe(this.cash[b]);
    }
    for (const f of FUNDS) {
      expect(n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries WHERE fund = ?', f), `${label}: model vs ledger, ${f} fund`).toBe(this.fund[f]);
    }
    for (const [pid, p] of this.stock) {
      const r = rows(ctx, 'SELECT qty_on_hand q, stock_value_cents v FROM products WHERE id = ?', pid)[0]!;
      expect([Number(r.q), Number(r.v)], `${label}: model vs product ${pid} stock`).toEqual([p.qty, p.value]);
    }
    // Ice Cream oracle (section 10.4): Charged / Settled / Unspent per line, recognized profit, outstanding excess, the P&L total
    const f = (await get(this.s.app, '/icecream/funds')).body;
    const u = this.iceU();
    expect([f.lines.materials.chargedCents, f.lines.materials.settledCents, f.lines.electricity.chargedCents, f.lines.electricity.settledCents], `${label}: Charged/Settled vs oracle`)
      .toEqual([this.ice.ChM, this.ice.SeM, this.ice.ChE, this.ice.SeE]);
    expect([f.unspentAllocationCents, f.outstandingExcessCostCents, f.recognizedProfitToDateCents], `${label}: Unspent / excess / recognized profit vs oracle`)
      .toEqual([u.U, Math.max(0, -u.U), this.ice.RP]);
    await this.crossChecks(label);
    const first = rows(ctx, 'SELECT MIN(d) d FROM (SELECT MIN(business_date) d FROM cash_entries UNION ALL SELECT MIN(business_date) FROM stock_movements)')[0]!.d as string;
    const telReport = (await get(this.s.app, `/reports/pnl/telecom?from=${first}&to=${daysAgo(0)}&granularity=month`)).body.totals.netProfitCents;
    expect(telReport, `${label}: Telecom P&L vs independent SQL over the raw rows`).toBe(telecomNetFromTables(ctx));
    // Shop P&L reconciles EXACTLY with the ledgers (cash + stock identity), including purchase refund gains (R4, fixed DEFECT 1).
    const id = await shopIdentity(this.s);
    expect(id.reportProfit, `${label}: Shop P&L vs ledger identity (cash + stock)`).toBe(id.ledgerProfit);
    const pnl = (await get(this.s.app, `/reports/pnl/icecream?from=${daysAgo(40)}&to=${daysAgo(0)}&granularity=month`)).body;
    expect(pnl.totals.recognizedProfitCents, `${label}: Ice Cream P&L total vs oracle`).toBe(this.ice.RP);
    await assertGlobalInvariants(this.s, { skipReports: this.skipReports });
  }

  stepNo = 0;
  /**
   * Cross-surface checks at a rotating "as of" date (backdated data makes past dates interesting): every figure that two endpoints or a ledger
   * sum must agree on is compared - valuation as-of vs movement sums, cash book opening/closing, Ice Cream funds as-of, dashboard cash/stock/profit
   * (today and month) vs the P&L reports, and additivity of the daily and monthly P&L rows.
   */
  async crossChecks(label: string): Promise<void> {
    const ctx = this.s.ctx; const app = this.s.app;
    const d = daysAgo(this.stepNo++ % 15);
    const first = d.slice(0, 8) + '01';
    // valuation as of d (from movements) = independent movement sums
    const val = (await get(app, `/reports/inventory/valuation?asOf=${d}&includeZero=true`)).body;
    expect([val.totals.qty, val.totals.valueCents], `${label}: valuation as of ${d}`).toEqual([
      n1(ctx, 'SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE business_date <= ?', d), n1(ctx, 'SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE business_date <= ?', d)]);
    // cash book as of d
    for (const book of ['shop', 'telecom', 'icecream']) {
      const led = (await get(app, `/cashbooks/${book}?from=${d}&to=${d}`)).body;
      expect([led.openingCents, led.closingCents], `${label}: ${book} cash book opening/closing on ${d}`).toEqual([
        n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND business_date < ?', book, d), n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND business_date <= ?', book, d)]);
    }
    // Ice Cream funds as of d
    const fd = (await get(app, `/icecream/funds?asOf=${d}`)).body;
    const fAt = (f: string) => n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries WHERE fund = ? AND business_date <= ?', f, d);
    expect([fd.funds.cost.balanceCents, fd.funds.electricity.balanceCents, fd.funds.profit.balanceCents], `${label}: Ice Cream funds as of ${d}`).toEqual([fAt('cost'), fAt('electricity'), fAt('profit')]);
    expect(fd.reconciled, `${label}: funds reconcile with the book as of ${d}`).toBe(true);
    // dashboard vs reports
    const dash = (await get(app, `/dashboard?asOf=${d}`)).body;
    const seg = async (x: string, a: string, b: string, key: string, g = 'month') => (await get(app, `/reports/pnl/${x}?from=${a}&to=${b}&granularity=${g}`)).body.totals[key] as number;
    for (const [tile, a] of [['today', d], ['month', first]] as const) {
      const exp = [await seg('shop', a, d, 'netProfitCents'), await seg('telecom', a, d, 'netProfitCents'), await seg('icecream', a, d, 'recognizedProfitCents')];
      const got = [dash[tile].bySegment.shop.profitCents, dash[tile].bySegment.telecom.profitCents, dash[tile].bySegment.icecream.profitCents];
      expect(got, `${label}: dashboard ${tile} profit per segment as of ${d}`).toEqual(exp);
      expect(dash[tile].profitCents, `${label}: dashboard ${tile} combined profit`).toBe(exp[0]! + exp[1]! + exp[2]!);
    }
    expect(dash.cash.books.map((b: any) => b.balanceCents), `${label}: dashboard cash as of ${d}`).toEqual(['shop', 'telecom', 'icecream'].map((b) => n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND business_date <= ?', b, d)));
    expect(dash.stock.valueCents, `${label}: dashboard stock value as of ${d}`).toBe(val.totals.valueCents);
    // dashboard series: the 30 daily points equal the sum of the three daily P&L rows; the monthly points equal the month-to-date reports
    const from30 = daysAgo(0) > d ? d : d; // (asOf is within the last 15 days, the 30-day window ends on d)
    const win0 = new Date(Date.parse(`${from30}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    expect(dash.series.daily).toHaveLength(30);
    const dayRows: Record<string, number> = {};
    for (const [x, key] of [['shop', 'netProfitCents'], ['telecom', 'netProfitCents'], ['icecream', 'recognizedProfitCents']] as const) {
      for (const r of (await get(app, `/reports/pnl/${x}?from=${win0}&to=${d}&granularity=day`)).body.rows) dayRows[r.period.label] = (dayRows[r.period.label] ?? 0) + r[key];
    }
    for (const pt of dash.series.daily) expect(pt.profitCents, `${label}: dashboard daily series ${pt.date} (asOf ${d})`).toBe(dayRows[pt.date] ?? 0);
    const lastMonth = dash.series.monthly[dash.series.monthly.length - 1];
    expect(lastMonth.month).toBe(d.slice(0, 7));
    expect(lastMonth.combinedCents, `${label}: dashboard monthly series, current month`).toBe(dash.month.profitCents);
    // per-DAY attribution (business date; a return belongs to the day of the RETURN): every day row of the Shop and Telecom P&L equals independent SQL for that single date
    for (const x of ['shop', 'telecom'] as const) {
      const days = (await get(app, `/reports/pnl/${x}?from=${daysAgo(16)}&to=${daysAgo(0)}&granularity=day`)).body;
      for (const r of days.rows) expect(r.netProfitCents, `${label}: ${x} P&L of ${r.period.label} vs SQL over the raw rows`).toBe(segNetFromTables(ctx, x, r.period.label, r.period.label));
    }
    // additivity: the day rows add up to the month rows and to the total
    for (const [x, key] of [['shop', 'netProfitCents'], ['telecom', 'netProfitCents'], ['icecream', 'recognizedProfitCents']] as const) {
      const days = (await get(app, `/reports/pnl/${x}?from=${daysAgo(14)}&to=${daysAgo(0)}&granularity=day`)).body;
      const mon = (await get(app, `/reports/pnl/${x}?from=${daysAgo(14)}&to=${daysAgo(0)}&granularity=month`)).body;
      expect(days.rows.reduce((a: number, r: any) => a + r[key], 0), `${label}: ${x} day rows add up to the total`).toBe(days.totals[key]);
      expect(mon.rows.reduce((a: number, r: any) => a + r[key], 0), `${label}: ${x} month rows add up to the total`).toBe(days.totals[key]);
    }
  }

  // ---------- setup ----------
  async setup(): Promise<void> {
    const s = this.s;
    const names = ['A', 'B', 'C', 'D'];
    for (const n of names) this.shopP.push((await mkProduct(s, { name: `Sim ${n} ${this.seed}`, sellPriceCents: 50000, minPriceCents: 100 })).id);
    for (const n of ['K', 'L']) this.telP.push((await mkTelecom(s, { name: `Sim ${n} ${this.seed}`, sellPriceCents: 10000, minPriceCents: 100 })).id);
    for (const pid of [...this.shopP, ...this.telP]) this.stock.set(pid, { qty: 0, value: 0 });
    this.prov = Object.values(await providerIds(s));
    const d = daysAgo(14);
    await must(await openNew(s, 'shop', { businessDate: d, amountCents: 5000000 }), 'open shop'); this.cash.shop += 5000000;
    await must(await openNew(s, 'telecom', { businessDate: d, amountCents: 3000000 }), 'open telecom'); this.cash.telecom += 3000000;
    await must(await openNew(s, 'icecream', { businessDate: d, amountCents: 400000, fund: 'cost' }), 'open ice cost'); this.cash.icecream += 400000; this.fund.cost += 400000;
    await must(await openNew(s, 'icecream', { businessDate: d, amountCents: 100000, fund: 'profit' }), 'open ice profit'); this.cash.icecream += 100000; this.fund.profit += 100000;
    const o1 = this.shopP[0]!; const o2 = this.telP[0]!;
    await must(await post(s.app, '/opening-stock', { businessDate: d, items: [{ productId: o1, qty: 7, totalValueCents: 70001 }, { productId: o2, qty: 30, unitCostCents: 7000 }], clientRef: ref() }), 'opening stock');
    this.apply({ cash: [], fund: [], stock: [{ pid: o1, qty: 7, value: 70001 }, { pid: o2, qty: 30, value: 210000 }] }, 1);
    await this.verify('setup');
  }

  // ---------- generic request helpers ----------
  /** Sends a request that the model predicts will be refused; checks status/code and that nothing was written. */
  async refuse(kind: string, r: { status: number; body: any }, status: number, code: string, before: Record<string, number>, ctxMsg = ''): Promise<void> {
    expect([r.status, r.body?.error?.code], `${kind} ${ctxMsg} -> ${JSON.stringify(r.body).slice(0, 300)}`).toEqual([status, code]);
    expect(countsAll(this.s.ctx), `${kind}: a refused request wrote something`).toEqual(before);
    this.stats.rejected[code] = (this.stats.rejected[code] ?? 0) + 1;
  }
  async expectCreated(kind: string, r: { status: number; body: any }): Promise<any> {
    expect(r.status, `${kind} -> ${JSON.stringify(r.body).slice(0, 400)}`).toBe(201);
    return r.body;
  }
  addRec(rec: Omit<Rec, 'voided'>): Rec {
    const full: Rec = { ...rec, voided: false };
    this.recs.push(full);
    this.apply(rec.delta, 1);
    return full;
  }
  cashRec(kind: string, id: number, date: string, book: Book, amt: number, fund?: Fund, url: string | null = null): Rec {
    return this.addRec({ kind, id, date, books: [book], delta: { cash: [{ book, amt, ...(fund ? { fund } : {}) }], fund: [], stock: [] }, voidUrl: url });
  }

  // ---------- operations ----------
  async opPurchase(): Promise<void> {
    const book: Book = this.chance(0.7) ? 'shop' : 'telecom';
    const date = this.date([book]); if (!date) return;
    const pool = book === 'shop' ? this.shopP : this.telP;
    const n = this.int(1, 2); const lines: Array<{ productId: number; packs: number; packSize: number; lineTotalCents: number }> = [];
    for (let i = 0; i < n; i++) lines.push({ productId: this.pick(pool), packs: this.int(1, 3), packSize: this.int(1, 12), lineTotalCents: this.int(0, 400000) });
    const r = await post(this.s.app, '/purchases', { businessDate: date, items: lines, clientRef: ref() });
    const body = await this.expectCreated('purchase', r);
    const total = lines.reduce((a, l) => a + l.lineTotalCents, 0);
    const stock = lines.map((l) => ({ pid: l.productId, qty: l.packs * l.packSize, value: l.lineTotalCents }));
    const pur = { book, lines: lines.map((l, i) => ({ pid: l.productId, units: l.packs * l.packSize, total: l.lineTotalCents, returned: 0, retValue: 0, itemId: body.item.items[i].id })) };
    this.addRec({ kind: 'purchase', id: body.item.id, date, books: [book], delta: { cash: total > 0 ? [{ book, amt: -total }] : [], fund: [], stock }, voidUrl: `/purchases/${body.item.id}/void`, pur });
  }

  async opPurchaseReturn(): Promise<void> {
    const cands = this.recs.filter((r) => r.kind === 'purchase' && !r.voided && r.pur!.lines.some((l) => l.returned < l.units));
    if (!cands.length) return;
    const rec = this.pick(cands); const pur = rec.pur!;
    const date = this.date([pur.book], rec.date); if (!date) return;
    const picks: Array<{ line: PurLine; units: number }> = [];
    for (const l of pur.lines) if (l.returned < l.units && this.chance(0.7)) picks.push({ line: l, units: this.int(1, l.units - l.returned) });
    if (!picks.length) return;
    // model: per item value, pool removal (R4), cash refund; refusal if the pool cannot cover the units (cumulative per product)
    const need = new Map<number, number>();
    for (const p of picks) need.set(p.line.pid, (need.get(p.line.pid) ?? 0) + p.units);
    const short = [...need].some(([pid, u]) => this.pool(pid).qty < u);
    const before = countsAll(this.s.ctx);
    const r = await post(this.s.app, `/purchases/${rec.id}/returns`, { businessDate: date, items: picks.map((p) => ({ purchaseItemId: p.line.itemId, units: p.units })), clientRef: ref() });
    if (short) return this.refuse('purchase return', r, 422, 'INSUFFICIENT_STOCK', before);
    await this.expectCreated('purchase return', r);
    let refund = 0; const stock: Delta['stock'] = [];
    for (const p of picks) {
      const l = p.line; const lastBatch = l.returned + p.units === l.units;
      const value = lastBatch ? l.total - l.retValue : mdr(l.total, p.units, l.units);
      refund += value; l.returned += p.units; l.retValue += value;
      const pool = this.pool(l.pid) as { qty: number; value: number };
      const removed = Math.min(value, pool.value);
      // apply to the model pool directly (the return is not voidable)
      pool.qty -= p.units; pool.value -= removed;
      stock.push({ pid: l.pid, qty: -p.units, value: -removed });
      if (pool.qty === 0 && pool.value > 0) pool.value = 0; // residual sweep (value-only adjustment movement)
    }
    if (refund > 0) this.cash[pur.book] += refund;
    this.log.push(`purchase return ${rec.id} refund ${refund}`);
  }

  async opSale(): Promise<void> {
    const nLines = this.int(1, 3);
    const items: Array<{ productId: number; qty: number; unitPriceCents: number; unitCostCents?: number }> = [];
    const all = [...this.shopP, ...this.telP];
    for (let i = 0; i < nLines; i++) items.push({ productId: this.chance(0.8) ? this.pick(this.shopP) : this.pick(this.telP), qty: this.int(1, 5), unitPriceCents: this.int(100, 200000) });
    void all;
    const books = [...new Set(items.map((i) => this.bookOf(i.productId)))];
    const date = this.date(books); if (!date) return;
    // model the cart line by line against a scratch copy of the pools
    const scratch = new Map<number, { qty: number; value: number }>();
    for (const [k, v] of this.stock) scratch.set(k, { ...v });
    const lineModel: Array<{ pid: number; qty: number; rev: number; cogs: number }> = [];
    let short = false;
    for (const it of items) {
      const p = scratch.get(it.productId)!;
      if (p.qty < it.qty) { short = true; break; }
      const cogs = it.qty === p.qty ? p.value : mdr(p.value, it.qty, p.qty);
      p.qty -= it.qty; p.value -= cogs;
      lineModel.push({ pid: it.productId, qty: it.qty, rev: it.qty * it.unitPriceCents, cogs });
    }
    if (!short) for (let i = 0; i < items.length; i++) if (this.chance(0.3)) items[i]!.unitCostCents = Math.ceil(lineModel[i]!.cogs / items[i]!.qty) + this.int(0, 50);
    const before = countsAll(this.s.ctx);
    const r = await post(this.s.app, '/sales', { businessDate: date, items, clientRef: ref() });
    if (short) return this.refuse('sale', r, 422, 'INSUFFICIENT_STOCK', before);
    const body = await this.expectCreated('sale', r);
    for (const sale of body.sales as any[]) {
      const sb = sale.book as Book;
      const mine = lineModel.filter((l) => this.bookOf(l.pid) === sb);
      expect(sale.items.length, 'sale lines').toBe(mine.length);
      const lines: SaleLine[] = mine.map((l, i) => ({ itemId: sale.items[i].id, pid: l.pid, qty: l.qty, rev: l.rev, cogs: l.cogs, retQty: 0, retRev: 0, retCogs: 0 }));
      const total = lines.reduce((a, l) => a + l.rev, 0);
      expect(sale.totalCents, 'sale total').toBe(total);
      this.addRec({ kind: 'sale', id: sale.id, date, books: [sb], delta: { cash: total > 0 ? [{ book: sb, amt: total }] : [], fund: [], stock: lines.map((l) => ({ pid: l.pid, qty: -l.qty, value: -l.cogs })) },
        voidUrl: `/sales/${sale.id}/void`, sale: { book: sb, lines } });
    }
  }

  async opSaleReturn(): Promise<void> {
    const cands = this.recs.filter((r) => r.kind === 'sale' && !r.voided && r.sale!.lines.some((l) => l.retQty < l.qty));
    if (!cands.length) return;
    const rec = this.pick(cands); const sale = rec.sale!;
    const date = this.date([sale.book], rec.date); if (!date) return;
    const picks: Array<{ line: SaleLine; q: number; resalable: boolean }> = [];
    for (const l of sale.lines) if (l.retQty < l.qty && this.chance(0.7)) picks.push({ line: l, q: this.int(1, l.qty - l.retQty), resalable: this.chance(0.7) });
    if (!picks.length) return;
    const r = await post(this.s.app, `/sales/${rec.id}/returns`, { businessDate: date, items: picks.map((p) => ({ saleItemId: p.line.itemId, qty: p.q, resalable: p.resalable })), clientRef: ref() });
    await this.expectCreated('sale return', r);
    let refund = 0;
    for (const p of picks) {
      const l = p.line; const last = l.retQty + p.q === l.qty;
      const rev = last ? l.rev - l.retRev : Math.min(mdr(l.rev, p.q, l.qty), l.rev - l.retRev);
      const cogs = last ? l.cogs - l.retCogs : Math.min(mdr(l.cogs, p.q, l.qty), l.cogs - l.retCogs);
      l.retQty += p.q; l.retRev += rev; l.retCogs += cogs; refund += rev;
      if (p.resalable) { const pool = this.pool(l.pid); pool.qty += p.q; pool.value += cogs; }
    }
    if (refund > 0) this.cash[sale.book] -= refund;
    rec.hasReturns = true;
  }

  /** Voids a random not-yet-voided record, predicting the outcome. */
  async opVoid(kinds?: string[]): Promise<void> {
    const cands = this.recs.filter((r) => !r.voided && r.voidUrl && (!kinds || kinds.includes(r.kind)));
    if (!cands.length) return;
    const rec = this.pick(cands);
    const before = countsAll(this.s.ctx);
    const closed = this.isClosed(rec.books, rec.date);
    const r = await post(this.s.app, rec.voidUrl!, { reason: 'sim void' });
    this.stats.byKind[`void:${rec.kind}`] = (this.stats.byKind[`void:${rec.kind}`] ?? 0) + 1;
    if (closed) return this.refuse(`void ${rec.kind}`, r, 409, 'DAY_CLOSED', before);
    if (rec.kind === 'sale' && rec.hasReturns) return this.refuse('void sale', r, 409, 'HAS_RETURNS', before);
    if (rec.kind === 'purchase') {
      const pur = rec.pur!;
      if (pur.lines.some((l) => l.returned > 0)) return this.refuse('void purchase', r, 409, 'HAS_RETURNS', before);
      const need = new Map<number, number>();
      for (const l of pur.lines) need.set(l.pid, (need.get(l.pid) ?? 0) + l.units);
      if ([...need].some(([pid, u]) => this.pool(pid).qty < u)) return this.refuse('void purchase', r, 422, 'INSUFFICIENT_STOCK', before);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      for (const l of pur.lines) {
        const pool = this.pool(l.pid);
        const removed = Math.min(l.total, pool.value);
        pool.qty -= l.units; pool.value -= removed;
        if (pool.qty === 0 && pool.value > 0) pool.value = 0;
      }
      this.cash[pur.book] += pur.lines.reduce((a, l) => a + l.total, 0);
      rec.voided = true; return;
    }
    if (rec.kind === 'iceday' || rec.kind === 'icemove' || rec.kind === 'icepay') {
      // D2 oracle: the state after the void, compared with the current one
      const ic = rec.ice as any; const n = { ChM: this.ice.ChM, ChE: this.ice.ChE, SeM: this.ice.SeM, SeE: this.ice.SeE, rel: this.ice.rel };
      let dRP = 0;
      if (ic.type === 'day') { n.ChM -= ic.C; n.ChE -= ic.E; dRP = -ic.share; }
      else if (ic.type === 'pay') { const save = { ...this.ice }; this.icePay(ic.kind, ic.fund, ic.amt, -1); n.SeM = this.ice.SeM; n.SeE = this.ice.SeE; dRP = this.ice.RP - save.RP; this.ice.SeM = save.SeM; this.ice.SeE = save.SeE; this.ice.RP = save.RP; }
      else { n.ChM -= ic.eff.dChM; n.ChE -= ic.eff.dChE; n.rel -= ic.eff.dRel; dRP = -ic.eff.dRP; }
      if (this.iceBlocked(n)) return this.refuse(`void ${rec.kind} (D2 oracle says blocked)`, r, 422, 'VOID_BREAKS_RELEASE', before);
      expect(r.status, `void ${rec.kind} #${rec.id} is allowed by the oracle: ${JSON.stringify(r.body)}`).toBe(200);
      this.ice.ChM = n.ChM; this.ice.ChE = n.ChE; this.ice.SeM = n.SeM; this.ice.SeE = n.SeE; this.ice.rel = n.rel; this.ice.RP += dRP;
    }
    if (rec.kind === 'stocktake' || rec.kind === 'loss' || rec.kind === 'goods') {
      // a negated stocktake GAIN needs the quantity to still be on hand; the server may refuse (422 INSUFFICIENT_STOCK / 409) - then nothing changes
      const neg = rec.delta.stock.some((st) => st.qty > 0 && this.pool(st.pid).qty < st.qty);
      if (neg && r.status !== 200) { expect([422, 409]).toContain(r.status); expect(countsAll(this.s.ctx), 'refused void wrote something').toEqual(before); this.stats.rejected[`${r.body.error.code}`] = (this.stats.rejected[`${r.body.error.code}`] ?? 0) + 1; return; }
    }
    expect(r.status, `void ${rec.kind} #${rec.id}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
    if (rec.kind === 'count' && rec.books[0] === 'icecream') this.ice.RP -= (rec.ice as { diff: number }).diff; // a voided count takes its over/short out of recognized profit
    this.apply(rec.delta, -1);
    rec.voided = true;
    if (rec.kind === 'iceday' && rec.dayDate) this.iceDays.delete(rec.dayDate);
  }

  async opStockOut(kind: 'loss' | 'goods'): Promise<void> {
    const pid = this.pick([...this.shopP, ...this.telP]); const book = this.bookOf(pid);
    const date = this.date([book]); if (!date) return;
    const p = this.pool(pid); const q = this.int(1, 4);
    const before = countsAll(this.s.ctx);
    const body = kind === 'loss'
      ? { businessDate: date, productId: pid, qty: q, reason: this.pick(['damaged', 'lost', 'expired', 'other']), clientRef: ref() }
      : { kind: 'goods', businessDate: date, productId: pid, qty: q, clientRef: ref() };
    const r = await post(this.s.app, kind === 'loss' ? '/stock-losses' : '/drawings', body);
    if (p.qty < q) return this.refuse(kind, r, 422, 'INSUFFICIENT_STOCK', before);
    const out = await this.expectCreated(kind, r);
    const value = this.take(pid, q);
    this.addRec({ kind, id: out.item.id, date, books: [book], delta: { cash: [], fund: [], stock: [{ pid, qty: -q, value: -value }] }, voidUrl: kind === 'loss' ? `/stock-losses/${out.item.id}/void` : `/drawings/${out.item.id}/void` });
  }

  async opStocktake(): Promise<void> {
    const book: Book = this.chance(0.7) ? 'shop' : 'telecom';
    const date = this.date([book]); if (!date) return;
    const pool = book === 'shop' ? this.shopP : this.telP;
    const pid = this.pick(pool); const p = this.pool(pid);
    const counted = Math.max(0, p.qty + this.int(-3, 3));
    if (counted === p.qty) return;
    const item: Record<string, number> = { productId: pid, countedQty: counted };
    const diff = counted - p.qty;
    let unit = 0;
    if (diff > 0 && (p.qty === 0 || p.value === 0)) { unit = this.int(100, 5000); item.gainUnitCostCents = unit; }
    const d = await post(this.s.app, '/stocktakes', { businessDate: date, book, items: [item], clientRef: ref() });
    const draft = await this.expectCreated('stocktake draft', d);
    const r = await post(this.s.app, `/stocktakes/${draft.item.id}/complete`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    let value: number;
    if (diff < 0) value = -this.take(pid, -diff);
    else value = unit > 0 ? unit * diff : mdr(p.value, diff, p.qty);
    this.addRec({ kind: 'stocktake', id: draft.item.id, date, books: [book], delta: { cash: [], fund: [], stock: [{ pid, qty: diff, value }] }, voidUrl: `/stocktakes/${draft.item.id}/void` });
  }

  async opCashOnly(): Promise<void> {
    const t = this.int(0, 9);
    const amt = this.int(100, 90000);
    if (t === 0 || t === 1) { // expense
      const book: Book = this.chance(0.6) ? 'shop' : 'telecom'; const date = this.date([book]); if (!date) return;
      const body = { businessDate: date, book, category: this.pick(CATS), amountCents: amt, description: 'sim', clientRef: ref() };
      const out = await this.expectCreated('expense', await post(this.s.app, '/expenses', body));
      this.lastExpense = body;
      this.cashRec('expense', out.item.id, date, book, -amt, undefined, `/expenses/${out.item.id}/void`);
    } else if (t === 2) { // reload
      const date = this.date(['telecom']); if (!date) return;
      const extra = this.chance(0.3) ? this.int(0, 500) : undefined;
      const out = await this.expectCreated('reload', await post(this.s.app, '/reload-sales', { businessDate: date, providerId: this.pick(this.prov), salesCents: amt, ...(extra !== undefined ? { extraCents: extra } : {}), clientRef: ref() }));
      this.cashRec('reload', out.item.id, date, 'telecom', amt, undefined, `/reload-sales/${out.item.id}/void`);
    } else if (t === 3) { // ezcash
      const date = this.date(['telecom']); if (!date) return;
      const out = await this.expectCreated('ezcash', await post(this.s.app, '/ezcash-sales', { businessDate: date, billTotalCents: amt, clientRef: ref() }));
      this.cashRec('ezcash', out.item.id, date, 'telecom', amt, undefined, `/ezcash-sales/${out.item.id}/void`);
    } else if (t === 4) { // top-up
      const date = this.date(['telecom']); if (!date) return;
      const provider = this.chance(0.5);
      const out = await this.expectCreated('topup', await post(this.s.app, '/telecom/topups', { businessDate: date, kind: provider ? 'provider_topup' : 'wallet_topup', ...(provider ? { providerId: this.pick(this.prov) } : {}), amountCents: amt, clientRef: ref() }));
      this.cashRec('topup', out.item.id, date, 'telecom', -amt, undefined, `/telecom/topups/${out.item.id}/void`);
    } else if (t === 5) { // print sale or supplies
      const date = this.date(['shop']); if (!date) return;
      if (this.chance(0.6)) {
        const types = (await get(this.s.app, '/print-service-types')).body.items as any[];
        const ty = this.pick(types); const qty = this.int(1, 40);
        const out = await this.expectCreated('print sale', await post(this.s.app, '/print-sales', { businessDate: date, serviceTypeId: ty.id, qty, clientRef: ref() }));
        this.cashRec('print', out.item.id, date, 'shop', qty * ty.priceCents, undefined, `/print-sales/${out.item.id}/void`);
      } else {
        const out = await this.expectCreated('supplies', await post(this.s.app, '/printing-supplies', { businessDate: date, amountCents: amt, description: 'paper', clientRef: ref() }));
        this.cashRec('supplies', out.item.id, date, 'shop', -amt, undefined, `/printing-supplies/${out.item.id}/void`);
      }
    } else if (t === 6 || t === 7) { // cash drawing / capital
      const book: Book = this.pick(['shop', 'telecom', 'icecream']); const date = this.date([book]); if (!date) return;
      const fund: Fund | undefined = book === 'icecream' ? this.pick(FUNDS) : undefined;
      if (t === 6) {
        const out = await this.expectCreated('cash drawing', await post(this.s.app, '/drawings', { kind: 'cash', businessDate: date, book, ...(fund ? { fund } : {}), amountCents: amt, clientRef: ref() }));
        this.cashRec('cashdraw', out.item.id, date, book, -amt, fund, `/drawings/${out.item.id}/void`);
      } else {
        const out = await this.expectCreated('capital', await post(this.s.app, '/capital', { businessDate: date, book, ...(fund ? { fund } : {}), amountCents: amt, clientRef: ref() }));
        this.cashRec('capital', out.item.id, date, book, amt, fund, `/capital-entries/${out.item.id}/void`);
      }
    } else { // transfer
      const from: Book = this.pick(['shop', 'telecom', 'icecream']); let to: Book = this.pick(['shop', 'telecom', 'icecream']);
      if (to === from) to = from === 'shop' ? 'telecom' : 'shop';
      const date = this.date([from, to]); if (!date) return;
      const ff: Fund | undefined = from === 'icecream' ? this.pick(FUNDS) : undefined; const tf: Fund | undefined = to === 'icecream' ? this.pick(FUNDS) : undefined;
      const out = await this.expectCreated('transfer', await post(this.s.app, '/cash-transfers', { businessDate: date, fromBook: from, toBook: to, ...(ff ? { fromFund: ff } : {}), ...(tf ? { toFund: tf } : {}), amountCents: amt, clientRef: ref() }));
      this.addRec({ kind: 'transfer', id: out.item.id, date, books: [from, to], delta: { cash: [{ book: from, amt: -amt, ...(ff ? { fund: ff } : {}) }, { book: to, amt, ...(tf ? { fund: tf } : {}) }], fund: [], stock: [] }, voidUrl: `/cash-transfers/${out.item.id}/void` });
    }
  }

  async opCount(): Promise<void> {
    const book: Book = this.pick(['shop', 'telecom', 'icecream']);
    const today = daysAgo(0);
    const before = countsAll(this.s.ctx);
    const expected = this.cash[book];
    const delta = this.chance(0.2) ? 0 : this.int(-4000, 4000);
    const counted = Math.max(0, expected + delta); const diff = counted - expected;
    const fund: Fund | undefined = book === 'icecream' ? this.pick(FUNDS) : undefined;
    const r = await post(this.s.app, '/cash-counts', { businessDate: today, book, countedCents: counted, ...(fund && diff !== 0 ? { fund } : {}), ...(diff !== 0 ? { note: 'sim count' } : {}), clientRef: ref() });
    if (this.isClosed([book], today)) return this.refuse('count', r, 409, 'DAY_CLOSED', before);
    const out = await this.expectCreated('count', r);
    expect([out.item.expectedCents, out.item.differenceCents], 'count expected/difference vs model').toEqual([expected, diff]);
    if (diff !== 0) this.addRec({ kind: 'count', id: out.item.id, date: today, books: [book], delta: { cash: [{ book, amt: diff, ...(fund ? { fund } : {}) }], fund: [], stock: [] }, voidUrl: `/cash-counts/${out.item.id}/void`, ice: { type: 'count', diff } });
    if (diff !== 0 && book === 'icecream') this.ice.RP += diff; // cash over/short is a recognition event whatever fund is chosen (C4)
  }

  async opIceDay(): Promise<void> {
    const date = this.date(['icecream']); if (!date) return;
    const exists = this.iceDays.has(date);
    const S = this.int(0, 80000); const C = this.int(0, Math.min(S, 60000)); let E = this.int(0, Math.max(0, S - C));
    if (this.chance(0.15)) E = E + this.int(1, 5000); // profit share may become negative
    const share = S - C - E;
    if (S === 0 && C === 0 && E === 0) return;
    const confirm = share < 0 ? this.chance(0.8) : false;
    const before = countsAll(this.s.ctx);
    const r = await post(this.s.app, '/icecream/days', { businessDate: date, salesCents: S, costAllocCents: C, electricityAllocCents: E, ...(confirm ? { confirmNegativeProfit: true } : {}), clientRef: ref() });
    if (exists) return this.refuse('ice day', r, 409, 'DAY_EXISTS', before);
    if (share < 0 && !confirm) return this.refuse('ice day', r, 422, 'NEGATIVE_PROFIT_UNCONFIRMED', before);
    const out = await this.expectCreated('ice day', r);
    const rec = this.addRec({ kind: 'iceday', id: out.day.id, date, books: ['icecream'], delta: { cash: [{ book: 'icecream', amt: C, fund: 'cost' }, { book: 'icecream', amt: E, fund: 'electricity' }, { book: 'icecream', amt: share, fund: 'profit' }].filter((c) => c.amt !== 0) as Delta['cash'], fund: [], stock: [] }, voidUrl: `/icecream/days/${date}/void`, dayDate: date, ice: { type: 'day', C, E, share } });
    this.iceDays.set(date, rec);
    this.ice.ChM += C; this.ice.ChE += E; this.ice.RP += share;
  }

  async opIceDayReplace(): Promise<void> {
    const cands = [...this.iceDays.values()].filter((r) => !r.voided); if (!cands.length) return;
    const rec = this.pick(cands);
    const S = this.int(1, 80000); const C = this.int(0, S); const E = this.int(0, S - C); const share = S - C - E;
    const before = countsAll(this.s.ctx);
    const r = await put(this.s.app, `/icecream/days/${rec.dayDate}`, { salesCents: S, costAllocCents: C, electricityAllocCents: E, clientRef: ref() });
    if (this.isClosed(['icecream'], rec.date)) return this.refuse('ice day replace', r, 409, 'DAY_CLOSED', before);
    // D2 judged on the FINAL state (old entry removed, new one in)
    const old = rec.ice as { C: number; E: number; share: number };
    const next = { ChM: this.ice.ChM - old.C + C, ChE: this.ice.ChE - old.E + E, SeM: this.ice.SeM, SeE: this.ice.SeE, rel: this.ice.rel };
    if (this.iceBlocked(next)) return this.refuse('ice day replace (D2)', r, 422, 'VOID_BREAKS_RELEASE', before);
    expect(r.status, `replace should be allowed by the oracle: ${JSON.stringify(r.body)}`).toBe(200);
    this.apply(rec.delta, -1); rec.voided = true; this.iceDays.delete(rec.dayDate!);
    const nr = this.addRec({ kind: 'iceday', id: r.body.day.id, date: rec.date, books: ['icecream'], delta: { cash: [{ book: 'icecream', amt: C, fund: 'cost' }, { book: 'icecream', amt: E, fund: 'electricity' }, { book: 'icecream', amt: share, fund: 'profit' }].filter((c) => c.amt !== 0) as Delta['cash'], fund: [], stock: [] }, voidUrl: `/icecream/days/${rec.dayDate}/void`, dayDate: rec.dayDate, ice: { type: 'day', C, E, share } });
    this.iceDays.set(rec.dayDate!, nr);
    this.ice.ChM = next.ChM; this.ice.ChE = next.ChE; this.ice.RP += share - old.share;
  }

  async opIcePay(): Promise<void> {
    const date = this.date(['icecream']); if (!date) return;
    const kind = this.pick(['materials', 'electricity_bill', 'other_cost'] as const); const fund = this.pick(FUNDS); const amt = this.int(100, 60000);
    const out = await this.expectCreated('ice payment', await post(this.s.app, '/icecream/payments', { businessDate: date, kind, fund, amountCents: amt, description: `sim ${kind}`, clientRef: ref() }));
    // settlement lines (10.4): materials -> Materials; electricity bill -> Electricity; other cost from Cost -> Materials, from Electricity -> Electricity, from Profit -> an expense
    const line: 'M' | 'E' | 'P' = kind === 'materials' ? 'M' : kind === 'electricity_bill' ? 'E' : fund === 'cost' ? 'M' : fund === 'electricity' ? 'E' : 'P';
    this.addRec({ kind: 'icepay', id: out.payment.id, date, books: ['icecream'], delta: { cash: [{ book: 'icecream', amt: -amt, fund }], fund: [], stock: [] }, voidUrl: `/icecream/payments/${out.payment.id}/void`, ice: { type: 'pay', kind, fund, amt, line } });
    this.icePay(kind, fund, amt, 1);
  }
  /** Oracle effect of a payment (sign -1 = its void). Materials/electricity payments are settlements; other cost from the Profit fund is an expense; from Cost/Electricity a settlement of that line. */
  icePay(kind: string, fund: Fund, amt: number, sign: 1 | -1): void {
    if (kind === 'materials') this.ice.SeM += sign * amt;
    else if (kind === 'electricity_bill') this.ice.SeE += sign * amt;
    else if (fund === 'cost') this.ice.SeM += sign * amt;
    else if (fund === 'electricity') this.ice.SeE += sign * amt;
    else this.ice.RP -= sign * amt;
  }

  async opIceMove(): Promise<void> {
    const date = this.date(['icecream']); if (!date) return;
    let from = this.pick(FUNDS); let to = this.pick(FUNDS.filter((f) => f !== from)); const amt = this.int(100, 40000);
    if (this.profile === 'ice' && this.chance(0.5)) { from = this.pick(['cost', 'electricity'] as Fund[]); to = 'profit'; } // releases: the profit-eligible limit and the D2 guard need them
    const body = { businessDate: date, fromFund: from, toFund: to, amountCents: amt, clientRef: ref() };
    const eff = this.iceMoveEffect(from, to, amt);
    let r = await post(this.s.app, '/icecream/fund-moves', body);
    const needsSplit = eff.limit !== null && amt > eff.limit;
    if (r.status === 409 && r.body.error.code === 'SPLIT_CONFIRMATION_REQUIRED') {
      const e = r.body.error;
      expect(needsSplit, `the oracle expected NO split for ${from}->${to} ${amt} (limit ${eff.limit}) but the server asked for one: ${JSON.stringify(e)}`).toBe(true);
      expect([e.profitEligibleCents, e.cashOnlyCents], `D4 split of ${from}->${to} ${amt} (oracle limit ${eff.limit})`).toEqual([eff.limit, amt - eff.limit!]);
      this.stats.rejected.SPLIT_CONFIRMATION_REQUIRED = (this.stats.rejected.SPLIT_CONFIRMATION_REQUIRED ?? 0) + 1;
      r = await post(this.s.app, '/icecream/fund-moves', { ...body, confirmSplit: true, confirmedProfitEligibleCents: e.profitEligibleCents });
    } else expect(needsSplit, `the oracle expected a D4 split for ${from}->${to} ${amt} (limit ${eff.limit}) but the move was ${r.status}`).toBe(false);
    const out = await this.expectCreated('ice move', r);
    this.addRec({ kind: 'icemove', id: out.move.id, date, books: ['icecream'], delta: { cash: [], fund: [{ fund: from, amt: -amt }, { fund: to, amt }], stock: [] }, voidUrl: `/icecream/fund-moves/${out.move.id}/void`, ice: { type: 'move', eff } });
    this.ice.ChM += eff.dChM; this.ice.ChE += eff.dChE; this.ice.RP += eff.dRP; this.ice.rel += eff.dRel;
    if (to === 'profit') expect(out.move.cashOnlyCents, 'cash-only part of the release').toBe(amt - eff.eligible);
  }

  async opClose(): Promise<void> {
    const book: Book = this.pick(['shop', 'telecom', 'icecream']); const date = daysAgo(this.int(0, 14));
    const key = `${book}|${date}`; const before = countsAll(this.s.ctx);
    const r = await post(this.s.app, '/daily-closings', { book, businessDate: date, clientRef: ref() });
    if (this.closed.has(key)) return this.refuse('close', r, 409, 'DAY_ALREADY_CLOSED', before);
    const out = await this.expectCreated('close', r);
    this.closed.add(key); this.closingIds.set(key, out.item.id);
  }
  async opReopen(): Promise<void> {
    const keys = [...this.closed]; if (!keys.length) return;
    const key = this.pick(keys);
    const r = await post(this.s.app, `/daily-closings/${this.closingIds.get(key)}/reopen`, { reason: 'sim reopen' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    this.closed.delete(key);
  }

  /** An attempt on a closed day must be refused with DAY_CLOSED and write nothing. */
  async opClosedAttempt(): Promise<void> {
    const keys = [...this.closed]; if (!keys.length) return;
    const [book, date] = this.pick(keys).split('|') as [Book, string];
    const before = countsAll(this.s.ctx);
    let r: { status: number; body: any };
    if (book === 'icecream') r = await post(this.s.app, '/icecream/payments', { businessDate: date, kind: 'materials', fund: 'cost', amountCents: 500, description: 'closed', clientRef: ref() });
    else if (this.chance(0.5)) r = await post(this.s.app, '/expenses', { businessDate: date, book, category: 'other', amountCents: 500, description: 'closed', clientRef: ref() });
    else r = await post(this.s.app, '/cash-transfers', { businessDate: date, fromBook: book, toBook: book === 'shop' ? 'telecom' : 'shop', amountCents: 500, clientRef: ref() });
    await this.refuse('closed-day attempt', r, 409, 'DAY_CLOSED', before);
  }

  /** Requests that must be rejected with a documented code and write nothing. */
  async opInvalid(): Promise<void> {
    const before = countsAll(this.s.ctx);
    const t = this.int(0, 8);
    const today = daysAgo(0); const fut = daysAgo(-3);
    let r: { status: number; body: any }; let status = 400; let code = 'VALIDATION_ERROR';
    if (t === 0) { r = await post(this.s.app, '/expenses', { businessDate: fut, book: 'shop', category: 'rent', amountCents: 100, description: 'x', clientRef: ref() }); code = 'FUTURE_DATE_NOT_ALLOWED'; }
    else if (t === 1) r = await post(this.s.app, '/expenses', { businessDate: today, book: 'shop', category: 'rent', amountCents: -5, description: 'x', clientRef: ref() });
    else if (t === 2) r = await post(this.s.app, '/expenses', { businessDate: today, book: 'shop', category: 'rent', amountCents: '100', description: 'x', clientRef: ref() });
    else if (t === 3) r = await post(this.s.app, '/expenses', { businessDate: today, book: 'shop', category: 'electricity', amountCents: 100, description: 'x', clientRef: ref() }), code = 'ELECTRICITY_NOT_ALLOWED';
    else if (t === 4) r = await post(this.s.app, '/capital', { businessDate: today, book: 'shop', amountCents: 100, bogus: 1, clientRef: ref() });
    else if (t === 5) { r = await post(this.s.app, '/cash-transfers', { businessDate: today, fromBook: 'shop', toBook: 'shop', amountCents: 100, clientRef: ref() }); code = 'SAME_BOOK'; }
    else if (t === 6) r = await post(this.s.app, '/sales', { businessDate: today, items: [{ productId: this.shopP[0], qty: 1, unitPriceCents: -1 }], clientRef: ref() });
    else if (t === 7) { r = await post(this.s.app, '/icecream/days', { businessDate: fut, salesCents: 1000, costAllocCents: 100, electricityAllocCents: 100, clientRef: ref() }); code = 'FUTURE_DATE_NOT_ALLOWED'; }
    else { r = await post(this.s.app, '/opening-stock', { businessDate: today, items: [{ productId: this.shopP[0], qty: 1.5, totalValueCents: 100 }], clientRef: ref() }); }
    await this.refuse(`invalid#${t}`, r, status, code, before);
  }

  /** The same clientRef twice returns the original with 200 and writes nothing the second time. */
  async opDuplicate(): Promise<void> {
    if (!this.lastExpense) return;
    const book = this.lastExpense.book as Book; const date = this.lastExpense.businessDate as string;
    if (this.isClosed([book], date)) return;
    const before = countsAll(this.s.ctx);
    const r = await post(this.s.app, '/expenses', this.lastExpense);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(countsAll(this.s.ctx), 'duplicate clientRef wrote something').toEqual(before);
    this.stats.rejected.DUPLICATE_OK = (this.stats.rejected.DUPLICATE_OK ?? 0) + 1;
  }

  /** Voiding something twice: 409 ALREADY_VOID, nothing written. */
  async opDoubleVoid(): Promise<void> {
    const cands = this.recs.filter((r) => r.voided && r.voidUrl && r.kind !== 'iceday'); if (!cands.length) return;
    const rec = this.pick(cands); const before = countsAll(this.s.ctx);
    const r = await post(this.s.app, rec.voidUrl!, { reason: 'again' });
    if (this.isClosed(rec.books, rec.date)) return this.refuse('double void', r, 409, 'DAY_CLOSED', before);
    await this.refuse(`double void ${rec.kind}`, r, 409, 'ALREADY_VOID', before);
  }

  /** Executes one random operation (weighted) and returns its label. */
  async step(): Promise<string> {
    const table: Array<[string, number, () => Promise<void>]> = [
      ['purchase', 9, () => this.opPurchase()], ['purchaseReturn', 3, () => this.opPurchaseReturn()], ['sale', 18, () => this.opSale()],
      ['saleReturn', 7, () => this.opSaleReturn()], ['void', 9, () => this.opVoid()], ['voidSale', 3, () => this.opVoid(['sale'])],
      ['voidPurchase', 2, () => this.opVoid(['purchase'])], ['loss', 3, () => this.opStockOut('loss')], ['goods', 3, () => this.opStockOut('goods')],
      ['stocktake', 4, () => this.opStocktake()], ['cashOnly', 22, () => this.opCashOnly()], ['count', 4, () => this.opCount()],
      ['iceDay', 6, () => this.opIceDay()], ['iceDayReplace', 1, () => this.opIceDayReplace()], ['icePay', 6, () => this.opIcePay()],
      ['iceMove', 7, () => this.opIceMove()], ['close', 3, () => this.opClose()], ['reopen', 2, () => this.opReopen()],
      ['closedAttempt', 3, () => this.opClosedAttempt()], ['invalid', 4, () => this.opInvalid()], ['duplicate', 2, () => this.opDuplicate()],
      ['doubleVoid', 2, () => this.opDoubleVoid()],
    ];
    if (this.profile === 'ice') {
      const w: Record<string, number> = { iceDay: 14, iceDayReplace: 5, icePay: 16, iceMove: 22, void: 0, count: 4, cashOnly: 6, close: 1, reopen: 1, sale: 3, purchase: 2, saleReturn: 0, purchaseReturn: 0,
        voidSale: 0, voidPurchase: 0, loss: 0, goods: 0, stocktake: 0, closedAttempt: 1, invalid: 2, duplicate: 1, doubleVoid: 1 };
      for (const t of table) t[1] = w[t[0]] ?? t[1];
      table.push(['voidIce', 14, () => this.opVoid(['iceday', 'icemove', 'icepay'])]);
    }
    const total = table.reduce((a, t) => a + t[1], 0);
    let x = this.rnd() * total; let chosen = table[0]!;
    for (const t of table) { x -= t[1]; if (x < 0) { chosen = t; break; } }
    this.stats.ops++; this.stats.byKind[chosen[0]] = (this.stats.byKind[chosen[0]] ?? 0) + 1;
    await chosen[2]();
    return chosen[0];
  }

  /** Runs n operations, verifying the model and every invariant after EACH one. */
  async run(n: number): Promise<SimStats> {
    for (let i = 0; i < n; i++) {
      const label = await this.step();
      await this.verify(`seed ${this.seed} op ${i} (${label})`);
    }
    return this.stats;
  }
}
