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
