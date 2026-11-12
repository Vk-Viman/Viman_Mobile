// Helpers for the Phase 11 operational-report tests (agent B): report readers and ONE shared hand-calculated scenario.
// The scenario is built entirely through the real API, in the order written below (costs follow POSTING order, report
// dates follow BUSINESS dates, so the order of the calls matters and is part of the hand calculations in the tests).
// Nothing here calls report code to derive an expected value; the expected figures live in the tests with their working.

import type { ApiBase } from './inventory.ts';
import { apiBase, buy, daysAgo, mkProduct, mkSupplier, mkTelecom, ref } from './inventory.ts';
import { BASE, post, put } from './catalog.ts';
import { cl, clc, returnOk, rl, sellOk, voidSaleNew } from './phase5.ts';
import { drawNew, lossNew, lossVoid, stComplete, stDraft, stVoid } from './phase4.ts';
import { drawCash, capNew, trNew, trVoid } from './phase9.ts';
import { psNew, psVoid, supNew, supVoid } from './phase7.ts';
import { openNew } from './phase8.ts';
import { TestEnv } from './tmp.ts';

/** GET /api/v1/reports/... with a query string; returns status and parsed JSON. */
export async function rep(s: ApiBase, path: string, qs = ''): Promise<{ status: number; body: any }> {
  const res = await s.app.inject({ method: 'GET', url: `${BASE}${path}${qs}` });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/** GET with `format=xlsx`: returns status, content type and whether the body is a real zip (.xlsx is a zip, starts with "PK"). */
export async function repXlsx(s: ApiBase, path: string, qs: string): Promise<{ status: number; type: string; isZip: boolean; disposition: string }> {
  const res = await s.app.inject({ method: 'GET', url: `${BASE}${path}${qs}${qs.includes('?') ? '&' : '?'}format=xlsx` });
  const buf = res.rawPayload;
  return { status: res.statusCode, type: String(res.headers['content-type']), isZip: buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b, disposition: String(res.headers['content-disposition'] ?? '') };
}

/** Day offsets used by the scenario: D10 = ten days ago ... D1 = yesterday, D0 = today. */
export const D = (n: number): string => daysAgo(n);

/** Query string for a day-by-day report over the scenario window (ten days ago .. today). */
export const WINDOW = (): string => `?from=${D(10)}&to=${D(0)}&granularity=day`;

/** Makes an app + ApiBase in a fresh temp data folder; the caller owns `env.cleanup()`. */
export async function newBase(env: TestEnv): Promise<ApiBase> {
  return apiBase(await env.build());
}

/** Ids of everything the shared scenario created. */
export interface Scenario {
  s: ApiBase;
  p1: number; p2: number; p3: number; p4: number; p5: number; p6: number;
  supA: number; supB: number;
  sale1: any; cartShop: any; cartTel: any; voidedSale: any;
}

/**
 * THE SCENARIO (all amounts cents). Hand-calculated working is in phase11-ops-*.test.ts next to each assertion.
 *
 * Products: P1 "Cable" (shop, minimum 10), P2 "Pen" (shop, minimum 60), P3 "Dialog card" (telecom, minimum 5),
 *           P4 shop minimum 0 (never stocked), P5 shop minimum 5 INACTIVE (never stocked), P6 shop minimum 5 (holds 6, above it).
 * Posting order (date in brackets):
 *   PU1 [D10] P1 10 units 10,000 (supplier A)      PU2 [D9] P1 10 units 12,000 (A)
 *   PU3 [D9]  P2 100 units 5,000 (B)               PU4 [D9] P3 50 cards 4,500, telecom (A)
 *   PU5 [D8]  P2 10 units 3,000 (B) then VOIDED    PU6 [D9] P6 6 units 600 (B)
 *   PR1 [D8]  return 2 units of PU1 (2,000)
 *   S1  [D7]  P1 x6 @ 2,000, cost charged 1,120/unit (extra cost)
 *   cart [D6] P1 x2 @ 2,000 + P2 x40 @ 100 (shop sale) + P3 x20 @ 100 (telecom sale)
 *   S5  [D5]  P2 x10 @ 100, then VOIDED
 *   R1  [D5]  return 2 of S1 (resalable)           R2 [D4] return 1 of S1 (DAMAGED)
 *   L1  [D3]  loss P1 x1 'lost'                    L2 [D3] loss P3 x2 'expired'      L3 [D3] loss P2 x3 then VOIDED
 *   G1  [D2]  personal use P1 x1
 *   T1  [D1]  stocktake P1 count 12 (gain)         T2 [D1] stocktake P1 count 11 (loss)
 *   T3  [D2]  stocktake P2 count 59 then VOIDED
 *   cash drawings, capital, transfer, printing: see the drawings / printing tests.
 */
export async function buildScenario(env: TestEnv): Promise<Scenario> {
  const s = await newBase(env);
  const supA = (await mkSupplier(s, 'Supplier A')).id;
  const supB = (await mkSupplier(s, 'Supplier B')).id;
  const p1 = (await mkProduct(s, { name: 'Cable', minPriceCents: 0, reorderLevel: 10 })).id;
  const p2 = (await mkProduct(s, { name: 'Pen', minPriceCents: 0, reorderLevel: 60 })).id;
  const p3 = (await mkTelecom(s, { name: 'Dialog card', minPriceCents: 0, reorderLevel: 5 })).id;
  const p4 = (await mkProduct(s, { name: 'No minimum', minPriceCents: 0, reorderLevel: 0 })).id;
  const p5 = (await mkProduct(s, { name: 'Inactive item', minPriceCents: 0, reorderLevel: 5 })).id;
  const p6 = (await mkProduct(s, { name: 'Above minimum', minPriceCents: 0, reorderLevel: 5 })).id;
  await put(s.app, `/products/${p5}`, { active: false });

  const one = (productId: number, units: number, lineTotalCents: number) => [{ productId, packs: 1, packSize: units, lineTotalCents }];
  const pu1 = await buy(s, one(p1, 10, 10000), { businessDate: D(10), supplierId: supA });
  await buy(s, one(p1, 10, 12000), { businessDate: D(9), supplierId: supA });
  await buy(s, one(p2, 100, 5000), { businessDate: D(9), supplierId: supB });
  await buy(s, one(p3, 50, 4500), { businessDate: D(9), supplierId: supA });
  const pu5 = await buy(s, one(p2, 10, 3000), { businessDate: D(8), supplierId: supB });
  await post(s.app, `/purchases/${pu5.id}/void`, { reason: 'test void' });
  await buy(s, one(p6, 6, 600), { businessDate: D(9), supplierId: supB });
  const pr = await post(s.app, `/purchases/${pu1.id}/returns`, { businessDate: D(8), clientRef: ref(), items: [{ purchaseItemId: pu1.items[0].id, units: 2 }] });
  if (pr.status !== 201) throw new Error(`purchase return failed ${JSON.stringify(pr.body)}`);

  const sale1 = (await sellOk(s, [clc(p1, 6, 2000, 1120)], { businessDate: D(7) })).sales[0];
  const cart = await sellOk(s, [cl(p1, 2, 2000), cl(p2, 40, 100), cl(p3, 20, 100)], { businessDate: D(6) });
  const cartShop = cart.sales.find((x: any) => x.book === 'shop');
  const cartTel = cart.sales.find((x: any) => x.book === 'telecom');
  const voidedSale = (await sellOk(s, [cl(p2, 10, 100)], { businessDate: D(5) })).sales[0];
  await voidSaleNew(s, voidedSale.id);
  await returnOk(s, sale1.id, [rl(sale1.items[0].id, 2, true)], { businessDate: D(5) });
  await returnOk(s, sale1.id, [rl(sale1.items[0].id, 1, false)], { businessDate: D(4) });

  const l1 = await lossNew(s, p1, 1, { businessDate: D(3), reason: 'lost' });
  const l2 = await lossNew(s, p3, 2, { businessDate: D(3), reason: 'expired' });
  const l3 = await lossNew(s, p2, 3, { businessDate: D(3), reason: 'damaged' });
  for (const r of [l1, l2, l3]) if (r.status !== 201) throw new Error(`loss failed ${JSON.stringify(r.body)}`);
  await lossVoid(s, l3.body.item.id);
  const g1 = await drawNew(s, p1, 1, { businessDate: D(2) });
  if (g1.status !== 201) throw new Error(`goods drawing failed ${JSON.stringify(g1.body)}`);

  const t1 = await stDraft(s, [{ productId: p1, countedQty: 12 }], { businessDate: D(1) });
  await stComplete(s, t1.id);
  const t2 = await stDraft(s, [{ productId: p1, countedQty: 11 }], { businessDate: D(1) });
  await stComplete(s, t2.id);
  const t3 = await stDraft(s, [{ productId: p2, countedQty: 59 }], { businessDate: D(2) });
  await stComplete(s, t3.id);
  await stVoid(s, t3.id);
  return { s, p1, p2, p3, p4, p5, p6, supA, supB, sale1, cartShop, cartTel, voidedSale };
}

/** Adds the money records of the drawings / printing tests on top of the scenario (all dated inside the window). */
export async function addMoneyRecords(sc: Scenario): Promise<void> {
  const { s } = sc;
  const ok = (r: { status: number; body: any }) => { if (r.status !== 201) throw new Error(`setup failed ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  await openNew(s, 'shop', { businessDate: D(10), amountCents: 10000000 });         // opening balance: NOT capital
  ok(await drawCash(s, { businessDate: D(3), book: 'shop', amountCents: 5000 }));
  ok(await drawCash(s, { businessDate: D(3), book: 'telecom', amountCents: 2000 }));
  ok(await drawCash(s, { businessDate: D(2), book: 'icecream', fund: 'profit', amountCents: 3000 }));
  const v = ok(await drawCash(s, { businessDate: D(3), book: 'shop', amountCents: 700 }));
  await post(s.app, `/drawings/${v.item.id}/void`, { reason: 'test void' });
  ok(await capNew(s, { businessDate: D(9), book: 'shop', amountCents: 20000 }));
  ok(await capNew(s, { businessDate: D(9), book: 'icecream', fund: 'cost', amountCents: 4000 }));
  ok(await trNew(s, { businessDate: D(5), fromBook: 'shop', toBook: 'telecom', amountCents: 6000 }));
  const t = ok(await trNew(s, { businessDate: D(5), fromBook: 'shop', toBook: 'telecom', amountCents: 999 }));
  await trVoid(s, t.item.id);
  // printing: B/W 3 pages @1500/650 and Colour 2 pages @2000/650 on D6; B/W 10 pages on D5; a voided 5-page sale; supplies 10,000 (D7) and 3,000 (D5), one voided
  ok(await psNew(s, { businessDate: D(6), qty: 3 }, 'BW_1S'));
  ok(await psNew(s, { businessDate: D(6), qty: 2 }, 'CLR_1S'));
  ok(await psNew(s, { businessDate: D(5), qty: 10 }, 'BW_1S'));
  const vp = ok(await psNew(s, { businessDate: D(5), qty: 5 }, 'BW_1S'));
  await psVoid(s, vp.item.id);
  ok(await supNew(s, { businessDate: D(7), amountCents: 10000 }));
  ok(await supNew(s, { businessDate: D(5), amountCents: 3000 }));
  const vs = ok(await supNew(s, { businessDate: D(5), amountCents: 999 }));
  await supVoid(s, vs.item.id);
}
