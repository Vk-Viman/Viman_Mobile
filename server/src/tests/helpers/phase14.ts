// Helpers for the Phase 14 independent QA / financial validation tests.
// Contents: (1) the scripted six-week world `buildWorld14` (posted ONLY through the real HTTP API; every figure the tests expect is worked out by
// hand in phase14-world.test.ts); (2) `assertGlobalInvariants`, the checker that must hold after ANY state; (3) small raw readers and a whole-database
// snapshot used by the adversarial tests ("a rejected request writes NOTHING").
// Money is integer cents everywhere (`rs()` converts rupees to cents).

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { get, post } from './catalog.ts';
import { buy, mkProduct, mkTelecom, ref } from './inventory.ts';
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
      expect(r.rk, 'same kind').toBe(r.ok);
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
