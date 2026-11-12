// Helpers for the Phase 11 FINANCIAL report tests (profit and loss, cash books, transfers, Ice Cream funds).
// Three groups: (1) report readers (JSON and .xlsx through the real routes); (2) `buildFinWorld`, ONE scripted two-month shop
// (March-April 2025) that is posted through the REAL API only - every figure the tests expect is worked out BY HAND in the test
// files from the script below, never read from report code; (3) small reading helpers.
// All dates are fixed past dates, so the tests give the same answer on any day. Money is in CENTS.
//
// THE SCRIPT (what is posted, by date; "A" etc. are products). Hand calculations live in phase11-fin-world.test.ts.
//
//  Stock (weighted average): A shop 10 @ 300,000 total; B shop 3 @ 100,000 (rounding!); C shop 4 @ 40,000; E shop opening 1 @ 50,000 + purchase
//  1 @ 10,000; X scratch card (telecom) 20 @ 100,000.
//  03-01 opening balances (shop 1,000,000, telecom 500,000, ice cream Cost 500,000); opening stock E; purchases A B C X
//  03-02 purchase E; sales S1 (A x4 @ 50,000, cost entered 31,000/unit = extra 4,000) and S2 (A x2 @ 52,000); reloads Dialog 5,000,000
//        and Hutch 123,456; ice day S100,000 C60,000 E10,000
//  03-03 sale E1 (E x1 @ 60,000); shop capital 100,000; card sale T1 (X x5 @ 6,000, cost entered 5,100 = extra 500); ice day 80,000/50,000/8,000
//  03-04 sale S3 (A x1 @ 50,000) VOID; card sale T2 (X x1) VOID; EZCash bill 250,000; ice day 50,000/30,000/5,000 VOID
//  03-05 return R1 of S1 (1 unit, resalable); reload Mobitel 100,000 + extra 50; reload Airtel 77,777 VOID; ice materials payment 100,000 (Cost)
//  03-06 return R2 of S2 (1 unit, DAMAGED); EZCash bill 123,457; EZCash bill 99,999 VOID; ice electricity bill 30,000 (Electricity)
//  03-07 return of T1 (2 cards, resalable); provider top-up Dialog 200,000; ice other cost 2,000 from the Profit fund
//  03-08 print sales BW_1S x10 and CLR_1S x4, CUSTOM x5 VOID; wallet top-up 150,000; ice other cost 1,000 from the Cost fund
//  03-09 printing supplies 100,000; loss X x1; ice day 60,000/36,000/6,000
//  03-10 sale B1 (B x1 @ 40,000); shop expenses rent 80,000 and water 5,000
//  03-11 sale B2 (B x1 @ 40,000); shop expense other 9,999 VOID
//  03-12 loss B x1 (lost); transfer Shop -> Telecom 50,000; telecom expense internet 30,000; ice electricity bill 50,000
//  03-13 ice re-allocation Profit -> Electricity 4,000
//  03-14 telecom stocktake X counted 15; ice move Cost -> Profit 5,000 (D4: all cash-only)
//  03-15 shop stocktake A counted 4; ice re-label Cost -> Electricity 10,000
//  03-16 shop stocktake C counted 6; ice cash count 556,500 (short 500, Profit fund)
//  03-17 ice cash drawing 20,000 (Profit)
//  03-18 transfer Ice Cream (Profit) -> Shop 30,000
//  03-19 transfer Shop -> Ice Cream (Cost) 10,000
//  03-20 loss A x1; ice capital 40,000 (Cost); transfer Telecom -> Shop 7,777 VOID; telecom cash count 5,685,713 (over 800)
//  03-21 loss C x1 VOID
//  03-24 purchase return of E's purchase (residual sweep 20,000); 03-25 shop expense transport 3,000; ice day 90,000/50,000/9,000
//  03-26 shop cash drawing 20,000; 03-27 goods drawing A x1; 03-28 shop cash count 784,500 (short 2,500)
//  04-01 reload Dialog 100,000; ice electricity bill 80,000
//  04-02 return R3 of S1 (remaining 3 units, resalable); telecom expense repairs 7,000; ice day 20,000/10,000/2,000
//  04-03 shop expense rent 80,000; ice move Cost -> Profit 3,000 (D4: all cash-only)
//  04-04 print sale BW_2S x20; 04-05 shop cash count 606,000 (over 1,500); 04-06 telecom cash count 5,778,413 (short 300)

import ExcelJS from 'exceljs';
import { get, post } from './catalog.ts';
import { mkProduct, mkTelecom, ref, buy } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { lossNew, lossVoid, drawNew, stComplete, stDraft } from './phase4.ts';
import { clc, cl, returnOk, rl, sellOk, sellOne, voidSaleNew } from './phase5.ts';
import { ez, ezVoid, providerIds, rel, relVoid, topProvider, topWallet } from './phase6.ts';
import { psNew, psVoid, supNew } from './phase7.ts';
import { countNew, expNew, expVoid, openNew } from './phase8.ts';
import { capNew, drawCash, tr, trVoid } from './phase9.ts';
import { dayOk, dayVoid, moveOk, payOk } from './phase10.ts';

/** GET a report path under /reports (e.g. `pnl/shop`) with a query string such as `from=2025-03-01&to=2025-03-31&granularity=month`. */
export const rep = (s: ApiBase, path: string, qs: string) => get(s.app, `/reports/${path}?${qs}`);

/** The standard query for a range. */
export const q = (from: string, to: string, granularity: 'day' | 'month' = 'month', extra = ''): string =>
  `from=${from}&to=${to}&granularity=${granularity}${extra}`;

/** GET a report as .xlsx and open it with ExcelJS. */
export async function repXlsx(s: ApiBase, path: string, qs: string): Promise<{ status: number; type: string; disposition: string; wb: ExcelJS.Workbook | null }> {
  const res = await s.app.inject({ method: 'GET', url: `/api/v1/reports/${path}?${qs}&format=xlsx` });
  if (res.statusCode !== 200) return { status: res.statusCode, type: String(res.headers['content-type']), disposition: '', wb: null };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
  return { status: 200, type: String(res.headers['content-type']), disposition: String(res.headers['content-disposition']), wb };
}

/** Value of a cell in a worksheet by header text and row label in column 1 (e.g. `cellBy(ws, 'Total', 'Net profit')`). */
export function cellBy(ws: ExcelJS.Worksheet, rowLabel: string, header: string): ExcelJS.CellValue {
  const headers = (ws.getRow(1).values as ExcelJS.CellValue[]);
  const col = headers.findIndex((h) => h === header);
  if (col < 0) throw new Error(`no column "${header}"`);
  for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(1).value === rowLabel) return ws.getRow(r).getCell(col).value;
  throw new Error(`no row "${rowLabel}"`);
}

/** Row of a ReportTable (JSON) by its first column. */
export const tableRow = (t: { rows: Array<Record<string, any>> }, period: string): Record<string, any> => {
  const r = t.rows.find((x) => x.period === period);
  if (!r) throw new Error(`no table row ${period}`);
  return r;
};

/** What `buildFinWorld` returns: ids a test may need. */
export interface FinWorld { A: number; B: number; C: number; E: number; X: number; s1: any; s2: any }

/**
 * Posts the whole scripted world through the real API (see the script at the top of this file).
 * @param withVoids false = leave out every record that the script voids (and its void): used to prove that a voided record changes nothing
 *                  compared with never having been recorded.
 */
export async function buildFinWorld(s: ApiBase, withVoids = true): Promise<FinWorld> {
  const must = (r: { status: number; body: any }, what: string) => {
    if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const price = { minPriceCents: 1000 };
  const A = (await mkProduct(s, { name: 'Phone case A', sellPriceCents: 50000, ...price })).id as number;
  const B = (await mkProduct(s, { name: 'Charger B', sellPriceCents: 40000, ...price })).id as number;
  const C = (await mkProduct(s, { name: 'Cable C', sellPriceCents: 10000, ...price })).id as number;
  const E = (await mkProduct(s, { name: 'Earphone E', sellPriceCents: 60000, ...price })).id as number;
  const X = (await mkTelecom(s, { name: 'Scratch card X', sellPriceCents: 6000, ...price })).id as number;
  const prov = await providerIds(s);
  const sid = async (code: string) => (await get(s.app, '/print-service-types')).body.items.find((t: any) => t.code === code).id as number;

  // ---- 03-01
  must(await openNew(s, 'shop', { businessDate: '2025-03-01', amountCents: 1000000 }), 'open shop');
  must(await openNew(s, 'telecom', { businessDate: '2025-03-01', amountCents: 500000 }), 'open telecom');
  must(await openNew(s, 'icecream', { businessDate: '2025-03-01', amountCents: 500000, fund: 'cost' }), 'open ice');
  must(await post(s.app, '/opening-stock', { businessDate: '2025-03-01', items: [{ productId: E, qty: 1, totalValueCents: 50000 }], clientRef: ref() }), 'opening stock');
  await buy(s, [{ productId: A, packs: 1, packSize: 10, lineTotalCents: 300000 }], { businessDate: '2025-03-01' });
  await buy(s, [{ productId: B, packs: 1, packSize: 3, lineTotalCents: 100000 }], { businessDate: '2025-03-01' });
  await buy(s, [{ productId: C, packs: 1, packSize: 4, lineTotalCents: 40000 }], { businessDate: '2025-03-01' });
  await buy(s, [{ productId: X, packs: 1, packSize: 20, lineTotalCents: 100000 }], { businessDate: '2025-03-01' });
  // ---- 03-02
  const pe = await buy(s, [{ productId: E, packs: 1, packSize: 1, lineTotalCents: 10000 }], { businessDate: '2025-03-02' });
  const s1 = (await sellOk(s, [clc(A, 4, 50000, 31000)], { businessDate: '2025-03-02' })).sales[0];
  const s2 = await sellOne(s, A, 2, 52000, { businessDate: '2025-03-02' });
  must(await rel(s, prov.Dialog!, 5000000, { businessDate: '2025-03-02' }), 'reload Dialog');
  must(await rel(s, prov.Hutch!, 123456, { businessDate: '2025-03-02' }), 'reload Hutch');
  await dayOk(s, { businessDate: '2025-03-02', salesCents: 100000, costAllocCents: 60000, electricityAllocCents: 10000 });
  // ---- 03-03
  await sellOne(s, E, 1, 60000, { businessDate: '2025-03-03' });
  must(await capNew(s, { businessDate: '2025-03-03', book: 'shop', amountCents: 100000 }), 'capital shop');
  const t1 = (await sellOk(s, [clc(X, 5, 6000, 5100)], { businessDate: '2025-03-03' })).sales[0];
  await dayOk(s, { businessDate: '2025-03-03', salesCents: 80000, costAllocCents: 50000, electricityAllocCents: 8000 });
  // ---- 03-04
  if (withVoids) {
    const s3 = await sellOne(s, A, 1, 50000, { businessDate: '2025-03-04' });
    must(await voidSaleNew(s, s3.id), 'void S3');
    const t2 = await sellOne(s, X, 1, 6000, { businessDate: '2025-03-04' });
    must(await voidSaleNew(s, t2.id), 'void T2');
  }
  must(await ez(s, 250000, { businessDate: '2025-03-04' }), 'ezcash');
  if (withVoids) {
    await dayOk(s, { businessDate: '2025-03-04', salesCents: 50000, costAllocCents: 30000, electricityAllocCents: 5000 });
    must(await dayVoid(s, '2025-03-04'), 'void day');
  }
  // ---- 03-05
  await returnOk(s, s1.id, [rl(s1.items[0].id, 1, true)], { businessDate: '2025-03-05' });
  must(await rel(s, prov.Mobitel!, 100000, { businessDate: '2025-03-05', extraCents: 50 }), 'reload Mobitel');
  if (withVoids) must(await relVoid(s, (must(await rel(s, prov.Airtel!, 77777, { businessDate: '2025-03-05' }), 'reload Airtel')).item.id), 'void reload');
  await payOk(s, 'materials', 100000, { fund: 'cost', businessDate: '2025-03-05' });
  // ---- 03-06
  await returnOk(s, s2.id, [rl(s2.items[0].id, 1, false)], { businessDate: '2025-03-06' });
  must(await ez(s, 123457, { businessDate: '2025-03-06' }), 'ezcash 2');
  if (withVoids) must(await ezVoid(s, (must(await ez(s, 99999, { businessDate: '2025-03-06' }), 'ezcash void')).item.id), 'void ezcash');
  await payOk(s, 'electricity_bill', 30000, { fund: 'electricity', businessDate: '2025-03-06' });
  // ---- 03-07
  await returnOk(s, t1.id, [rl(t1.items[0].id, 2, true)], { businessDate: '2025-03-07' });
  must(await topProvider(s, prov.Dialog!, 200000, { businessDate: '2025-03-07' }), 'provider topup');
  await payOk(s, 'other_cost', 2000, { fund: 'profit', businessDate: '2025-03-07', description: 'Cups' });
  // ---- 03-08
  must(await psNew(s, { businessDate: '2025-03-08', qty: 10 }, 'BW_1S'), 'print 1');
  must(await psNew(s, { businessDate: '2025-03-08', qty: 4 }, 'CLR_1S'), 'print 2');
  if (withVoids) must(await psVoid(s, (must(await psNew(s, { businessDate: '2025-03-08', qty: 5 }, 'CUSTOM'), 'print void')).item.id), 'void print');
  must(await topWallet(s, 150000, { businessDate: '2025-03-08' }), 'wallet topup');
  await payOk(s, 'other_cost', 1000, { fund: 'cost', businessDate: '2025-03-08', description: 'Spoons' });
  // ---- 03-09
  must(await supNew(s, { businessDate: '2025-03-09', amountCents: 100000 }), 'supplies');
  must(await lossNew(s, X, 1, { businessDate: '2025-03-09', reason: 'damaged' }), 'loss X');
  await dayOk(s, { businessDate: '2025-03-09', salesCents: 60000, costAllocCents: 36000, electricityAllocCents: 6000 });
  // ---- 03-10
  await sellOne(s, B, 1, 40000, { businessDate: '2025-03-10' });
  must(await expNew(s, { businessDate: '2025-03-10', book: 'shop', category: 'rent', amountCents: 80000 }), 'rent');
  must(await expNew(s, { businessDate: '2025-03-10', book: 'shop', category: 'water', amountCents: 5000 }), 'water');
  // ---- 03-11
  await sellOne(s, B, 1, 40000, { businessDate: '2025-03-11' });
  if (withVoids) must(await expVoid(s, (must(await expNew(s, { businessDate: '2025-03-11', book: 'shop', category: 'other', amountCents: 9999 }), 'exp void')).item.id), 'void exp');
  // ---- 03-12
  must(await lossNew(s, B, 1, { businessDate: '2025-03-12', reason: 'lost' }), 'loss B');
  must(await tr(s, 'shop', 'telecom', 50000, { businessDate: '2025-03-12' }), 'transfer 1');
  must(await expNew(s, { businessDate: '2025-03-12', book: 'telecom', category: 'internet', amountCents: 30000 }), 'internet');
  await payOk(s, 'electricity_bill', 50000, { fund: 'electricity', businessDate: '2025-03-12' });
  // ---- 03-13 .. 03-16
  await moveOk(s, 'profit', 'electricity', 4000, { businessDate: '2025-03-13' });
  must(await stComplete(s, (await stDraft(s, [{ productId: X, countedQty: 15 }], { businessDate: '2025-03-14', book: 'telecom' })).id), 'stocktake X');
  await moveOk(s, 'cost', 'profit', 5000, { businessDate: '2025-03-14' });
  must(await stComplete(s, (await stDraft(s, [{ productId: A, countedQty: 4 }], { businessDate: '2025-03-15', book: 'shop' })).id), 'stocktake A');
  await moveOk(s, 'cost', 'electricity', 10000, { businessDate: '2025-03-15' });
  must(await stComplete(s, (await stDraft(s, [{ productId: C, countedQty: 6 }], { businessDate: '2025-03-16', book: 'shop' })).id), 'stocktake C');
  must(await countNew(s, 'icecream', 556500, { businessDate: '2025-03-16', fund: 'profit', note: 'Short in the drawer' }), 'ice count');
  // ---- 03-17 .. 03-21
  must(await drawCash(s, { businessDate: '2025-03-17', book: 'icecream', fund: 'profit', amountCents: 20000 }), 'ice drawing');
  must(await tr(s, 'icecream', 'shop', 30000, { businessDate: '2025-03-18', fromFund: 'profit' }), 'transfer 2');
  must(await tr(s, 'shop', 'icecream', 10000, { businessDate: '2025-03-19', toFund: 'cost' }), 'transfer 3');
  must(await lossNew(s, A, 1, { businessDate: '2025-03-20', reason: 'lost' }), 'loss A');
  must(await capNew(s, { businessDate: '2025-03-20', book: 'icecream', fund: 'cost', amountCents: 40000 }), 'ice capital');
  if (withVoids) must(await trVoid(s, (must(await tr(s, 'telecom', 'shop', 7777, { businessDate: '2025-03-20' }), 'transfer void')).item.id), 'void transfer');
  must(await countNew(s, 'telecom', 5685713, { businessDate: '2025-03-20', note: 'Over' }), 'telecom count');
  if (withVoids) must(await lossVoid(s, (must(await lossNew(s, C, 1, { businessDate: '2025-03-21', reason: 'other' }), 'loss C')).item.id), 'void loss C');
  // ---- 03-24 .. 03-28
  must(await post(s.app, `/purchases/${pe.id}/returns`, { businessDate: '2025-03-24', items: [{ purchaseItemId: pe.items[0].id, units: 1 }], clientRef: ref() }), 'purchase return');
  must(await expNew(s, { businessDate: '2025-03-25', book: 'shop', category: 'transport', amountCents: 3000 }), 'transport');
  await dayOk(s, { businessDate: '2025-03-25', salesCents: 90000, costAllocCents: 50000, electricityAllocCents: 9000 });
  must(await drawCash(s, { businessDate: '2025-03-26', book: 'shop', amountCents: 20000 }), 'shop drawing');
  must(await drawNew(s, A, 1, { businessDate: '2025-03-27' }), 'goods drawing');
  must(await countNew(s, 'shop', 784500, { businessDate: '2025-03-28', note: 'Short' }), 'shop count');
  // ---- April
  must(await rel(s, prov.Dialog!, 100000, { businessDate: '2025-04-01' }), 'reload April');
  await payOk(s, 'electricity_bill', 80000, { fund: 'electricity', businessDate: '2025-04-01' });
  await returnOk(s, s1.id, [rl(s1.items[0].id, 3, true)], { businessDate: '2025-04-02' });
  must(await expNew(s, { businessDate: '2025-04-02', book: 'telecom', category: 'repairs', amountCents: 7000 }), 'repairs');
  await dayOk(s, { businessDate: '2025-04-02', salesCents: 20000, costAllocCents: 10000, electricityAllocCents: 2000 });
  must(await expNew(s, { businessDate: '2025-04-03', book: 'shop', category: 'rent', amountCents: 80000 }), 'rent April');
  await moveOk(s, 'cost', 'profit', 3000, { businessDate: '2025-04-03' });
  must(await psNew(s, { businessDate: '2025-04-04', qty: 20 }, 'BW_2S'), 'print April');
  must(await countNew(s, 'shop', 606000, { businessDate: '2025-04-05', note: 'Over' }), 'shop count 2');
  must(await countNew(s, 'telecom', 5778413, { businessDate: '2025-04-06', note: 'Short' }), 'telecom count 2');
  void cl; void sid; void ezVoid;
  return { A, B, C, E, X, s1, s2 };
}
