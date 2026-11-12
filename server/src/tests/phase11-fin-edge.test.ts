// Phase 11 FINANCIAL reports: request handling and edge cases (API_CONTRACTS Wave 4 conventions, BUSINESS_RULES 10.6, 12 R-FD scope, R1).
// Protects:
//   - bad input is a clean 400 on every endpoint: missing/impossible dates, from > to, more than 3,660 days, unknown granularity/format/book/field;
//   - report dates are business dates and are NEVER rejected for being in the future (R-FD is for writes); a far-future range shows today's balances;
//   - an empty database and an empty range give all-zero rows (never an error), a single day gives one row equal to the total;
//   - every endpoint answers .xlsx with the same figures as the JSON (opened with ExcelJS) and a download file name;
//   - reports are READ-ONLY: no row of any table (audit log included) changes when every endpoint is called;
//   - electricity never appears as an expense category in Shop or Telecom (E2).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { lossNew, lossVoid, sql } from './helpers/phase4.ts';
import { buy, mkProduct } from './helpers/inventory.ts';
import { clc, returnOk, rl, sellOk } from './helpers/phase5.ts';
import { buildFinWorld, cellBy, q, rep, repXlsx } from './helpers/phase11fin.ts';

const env = new TestEnv();
let s: ApiBase;
let empty: ApiBase;

beforeAll(async () => {
  s = await apiBase(await env.build());
  await buildFinWorld(s, true);
  empty = await apiBase(await env.build());
}, 120000);
afterAll(async () => { await env.cleanup(); });

/** Every period report endpoint (path under /reports). */
const ENDPOINTS = ['pnl/shop', 'pnl/telecom', 'pnl/icecream', 'pnl/combined', 'cashbook/shop', 'cashbook/telecom', 'cashbook/icecream', 'transfers', 'icecream-funds'];

describe('validation: 400 on bad input, for every endpoint', () => {
  const BAD: Array<[string, string]> = [
    ['missing from', 'to=2025-03-31&granularity=month'],
    ['missing to', 'from=2025-03-01&granularity=month'],
    ['missing both', 'granularity=day'],
    ['impossible date (30 February)', 'from=2025-02-30&to=2025-03-31'],
    ['impossible month (13)', 'from=2025-03-01&to=2025-13-01'],
    ['wrong shape', 'from=2025-3-1&to=2025-03-31'],
    ['from after to', 'from=2025-04-01&to=2025-03-31'],
    ['range over 3,660 days', 'from=2010-01-01&to=2025-03-31'],
    ['unknown granularity', 'from=2025-03-01&to=2025-03-31&granularity=week'],
    ['unknown format', 'from=2025-03-01&to=2025-03-31&format=pdf'],
    ['unknown parameter', 'from=2025-03-01&to=2025-03-31&foo=1'],
  ];
  for (const path of ENDPOINTS) {
    it(`${path}: every bad query is a 400 VALIDATION error and nothing is computed`, async () => {
      for (const [label, qs] of BAD) {
        const r = await rep(s, path, qs);
        expect(r.status, `${path} ${label}`).toBe(400);
        expect(r.body.error, `${path} ${label}`).toBeDefined();
      }
      // exactly 3,660 days is allowed, 3,661 is not
      expect((await rep(s, path, 'from=2015-01-01&to=2024-12-30&granularity=month')).status).toBe(200); // 3,651 days
      expect((await rep(s, path, 'from=2015-01-01&to=2025-01-10&granularity=month')).status).toBe(400); // 3,663 days
    });
  }

  it('cashbook: an unknown book is a 400; the three books work', async () => {
    expect((await rep(s, 'cashbook/bank', q('2025-03-01', '2025-03-31'))).status).toBe(400);
    for (const b of ['shop', 'telecom', 'icecream']) expect((await rep(s, `cashbook/${b}`, q('2025-03-01', '2025-03-31'))).status).toBe(200);
  });

  it('the 400 names the field that is wrong', async () => {
    const r = await rep(s, 'pnl/shop', 'from=2025-02-30&to=2025-03-31');
    expect(r.body.error.fields?.from ?? r.body.error.message).toBeTruthy();
    const r2 = await rep(s, 'pnl/shop', 'from=2025-04-01&to=2025-03-31');
    expect(r2.body.error.code).toBe('VALIDATION_ERROR');
    expect(r2.body.error.fields.from).toContain('cannot be after');
  });
});

describe('future dates are never rejected for reports (R-FD applies to writes only)', () => {
  it('a range entirely in the future is 200 with all-zero rows; a range ending far in the future shows the same balances as today', async () => {
    for (const path of ENDPOINTS) {
      const r = await rep(s, path, q('2099-01-01', '2099-01-03', 'day'));
      expect(r.status, path).toBe(200);
      expect(r.body.rows).toHaveLength(3);
    }
    const cb = (await rep(s, 'cashbook/shop', q('2025-03-01', '2031-12-31', 'month'))).body;
    expect(cb.totals.closingCents).toBe(606000);
    expect(cb.ledgerBalanceAsOfToCents).toBe(606000);
    // the future days open with today's balance and move nothing
    const f = (await rep(s, 'cashbook/shop', q('2099-01-01', '2099-01-02', 'day'))).body;
    expect(f.rows.map((x: any) => [x.openingCents, x.inCents, x.outCents, x.closingCents])).toEqual([[606000, 0, 0, 606000], [606000, 0, 0, 606000]]);
    // Ice Cream: the excess-cost outstanding at the end of April is still outstanding in the far future (nothing can be dated later)
    const ic = (await rep(s, 'pnl/icecream', q('2025-03-01', '2031-12-31', 'month'))).body;
    expect(ic.totals.balancesAsOfPeriodEnd.outstandingExcessCostCents).toBe(16000);
    expect(ic.warnings[0]).toMatchObject({ code: 'EXCESS_COST_OUTSTANDING', asOf: '2031-12-31' });
  });
});

describe('empty database, empty range and a single day', () => {
  it('an empty database: every report is 200 and all zero (balances too), with no warnings', async () => {
    for (const path of ENDPOINTS) {
      const r = await rep(empty, path, q('2025-03-01', '2025-03-31', 'month'));
      expect(r.status, path).toBe(200);
      expect(r.body.rows, path).toHaveLength(1);
      expect(r.body.warnings, path).toEqual([]);
    }
    const shop = (await rep(empty, 'pnl/shop', q('2025-03-01', '2025-03-31', 'day'))).body;
    expect(shop.rows).toHaveLength(31);
    expect(shop.totals.netProfitCents).toBe(0);
    expect(shop.rows.every((x: any) => x.netProfitCents === 0 && x.goods.revenueCents === 0 && x.expenses.totalCents === 0)).toBe(true);
    const ic = (await rep(empty, 'pnl/icecream', q('2025-03-01', '2025-03-31'))).body;
    expect(ic.totals).toMatchObject({ recognizedProfitCents: 0, excessCostNotChargedCents: 0, profitAfterExcessCostCents: 0 });
    expect(ic.totals.balancesAsOfPeriodEnd).toEqual({ unspentByLine: { materialsCents: 0, electricityCents: 0 }, unspentCents: 0, outstandingExcessCostCents: 0 });
    const cb = (await rep(empty, 'cashbook/icecream', q('2025-03-01', '2025-03-31'))).body;
    expect([cb.totals.openingCents, cb.totals.inCents, cb.totals.outCents, cb.totals.closingCents]).toEqual([0, 0, 0, 0]);
    expect(cb.rows[0].byType).toEqual([]);
    const tr = (await rep(empty, 'transfers', q('2025-03-01', '2025-03-31'))).body;
    expect(tr.items).toEqual([]);
    expect(tr.totals.count).toBe(0);
  });

  it('a range with no activity inside it (but data before it): rows are zero for flows, balances carry in', async () => {
    const shop = (await rep(s, 'pnl/shop', q('2025-02-01', '2025-02-28', 'month'))).body;
    expect(shop.totals.netProfitCents).toBe(0);
    const cb = (await rep(s, 'cashbook/shop', q('2025-05-01', '2025-05-31', 'month'))).body;
    expect(cb.rows[0]).toMatchObject({ openingCents: 606000, inCents: 0, outCents: 0, closingCents: 606000, byType: [] });
    const ic = (await rep(s, 'pnl/icecream', q('2025-05-01', '2025-05-31', 'month'))).body;
    // nothing moved in May: the flows are zero, but the unspent balance and the outstanding excess carry in from April (balances, never summed)
    expect(ic.totals).toMatchObject({ recognizedProfitCents: 0, excessCostNotChargedCents: 0, profitAfterExcessCostCents: 0 });
    expect(ic.totals.balancesAsOfPeriodEnd.outstandingExcessCostCents).toBe(16000);
    expect(ic.warnings).toHaveLength(1);
  });

  it('a single day: one row, equal to the total row, for every segment', async () => {
    const day = '2025-03-02';
    const shop = (await rep(s, 'pnl/shop', q(day, day, 'day'))).body;
    expect(shop.rows).toHaveLength(1);
    expect(shop.rows[0].netProfitCents).toBe(120000);
    const { period, ...fig } = shop.rows[0];
    expect(period).toEqual({ from: day, to: day, label: day });
    expect(fig).toEqual(shop.totals);
    const month = (await rep(s, 'pnl/shop', q(day, day, 'month'))).body; // a clipped month row
    expect(month.rows).toHaveLength(1);
    expect(month.rows[0].period).toEqual({ from: day, to: day, label: '2025-03' });
    expect(month.rows[0].netProfitCents).toBe(120000);
    const tel = (await rep(s, 'pnl/telecom', q(day, day, 'day'))).body;
    expect(tel.rows[0].netProfitCents).toBe(307407);
    const ice = (await rep(s, 'pnl/icecream', q(day, day, 'day'))).body;
    expect(ice.rows[0].recognizedProfitCents).toBe(30000);
    const comb = (await rep(s, 'pnl/combined', q(day, day, 'day'))).body;
    expect(comb.totals.recognizedProfitCents).toBe(120000 + 307407 + 30000);
    const cb = (await rep(s, 'cashbook/shop', q(day, day, 'day'))).body;
    expect([cb.totals.openingCents, cb.totals.inCents, cb.totals.outCents, cb.totals.closingCents]).toEqual([560000, 304000, 10000, 854000]);
  });

  it('a month range that starts and ends mid-month is clipped: rows never reach outside the request', async () => {
    const r = (await rep(s, 'pnl/shop', q('2025-03-10', '2025-04-03', 'month'))).body;
    expect(r.rows.map((x: any) => [x.period.from, x.period.to, x.period.label])).toEqual([
      ['2025-03-10', '2025-03-31', '2025-03'], ['2025-04-01', '2025-04-03', '2025-04'],
    ]);
    // 03-10 .. 03-31 = March (-77,600) minus what happened on 03-02..03-08 (120,000+30,000-19,000-52,000+13,900 = 92,900) = -170,500
    expect(r.rows[0].netProfitCents).toBe(-77600 - 92900);
    expect(r.rows[1].netProfitCents).toBe(-137000); // 04-01..04-03: the 04-02 return (-57,000) and 04-03 rent (-80,000)
  });
});

describe('Excel download: the same figures as the JSON', () => {
  it('every endpoint answers .xlsx with a download name and a workbook ExcelJS can open', async () => {
    for (const path of ENDPOINTS) {
      const x = await repXlsx(s, path, q('2025-03-01', '2025-04-30', 'month'));
      expect(x.status, path).toBe(200);
      expect(x.type, path).toContain('spreadsheetml.sheet');
      expect(x.disposition, path).toContain('attachment');
      expect(x.disposition, path).toContain('2025-03-01_2025-04-30.xlsx');
      expect(x.wb!.worksheets.length, path).toBeGreaterThan(0);
    }
  });

  it('Shop P&L workbook: header row, one row per month, bold total row in rupees, and the notes', async () => {
    const x = await repXlsx(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'month'));
    const ws = x.wb!.getWorksheet('Shop profit and loss')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Period');
    expect(cellBy(ws, '2025-03', 'Net profit')).toBe(-776); // -77,600 cents = Rs -776.00
    expect(cellBy(ws, '2025-04', 'Net profit')).toBe(-1035);
    expect(cellBy(ws, 'Total', 'Net profit')).toBe(-1811);
    expect(cellBy(ws, 'Total', 'Goods sales (net of returns)')).toBe(1920);
    expect(cellBy(ws, 'Total', 'Operating expenses')).toBe(1680);
    const notes = ws.getColumn(1).values as unknown[];
    expect(notes.some((v) => typeof v === 'string' && v.includes('Printing supplies'))).toBe(true);
  });

  it('Telecom, Ice Cream and Combined workbooks carry the hand-calculated totals', async () => {
    const tel = (await repXlsx(s, 'pnl/telecom', q('2025-03-01', '2025-04-30', 'month'))).wb!.getWorksheet('Telecom profit and loss')!;
    expect(cellBy(tel, 'Total', 'Net profit')).toBe(2786.45);
    expect(cellBy(tel, '2025-03', 'Reload rounding extra')).toBe(0.5);
    const ice = (await repXlsx(s, 'pnl/icecream', q('2025-03-01', '2025-04-30', 'month'))).wb!.getWorksheet('Ice Cream profit and loss')!;
    expect(cellBy(ice, 'Total', 'Recognized profit')).toBe(1025);
    expect(cellBy(ice, '2025-04', 'Excess cost not yet charged')).toBe(160);
    expect(cellBy(ice, '2025-04', 'Profit after excess cost')).toBe(-80);
    const comb = (await repXlsx(s, 'pnl/combined', q('2025-03-01', '2025-04-30', 'month'))).wb!.getWorksheet('Combined profit and loss')!;
    expect(cellBy(comb, 'Total', 'Combined recognized profit (official)')).toBe(2000.45);
    expect(cellBy(comb, 'Total', 'Combined profit after excess cost')).toBe(1840.45);
  });

  it('cash book workbooks: periods, entry types and (Ice Cream) the fund sheet; transfers and funds workbooks', async () => {
    const shop = (await repXlsx(s, 'cashbook/shop', q('2025-03-01', '2025-04-30', 'month'))).wb!;
    expect(shop.worksheets.map((w) => w.name)).toEqual(['Shop cash book', 'Totals by entry type']);
    expect(cellBy(shop.getWorksheet('Shop cash book')!, 'Total', 'Closing balance')).toBe(6060);
    const ice = (await repXlsx(s, 'cashbook/icecream', q('2025-03-01', '2025-04-30', 'month'))).wb!;
    expect(ice.worksheets.map((w) => w.name)).toEqual(['Ice Cream cash book', 'Totals by entry type', 'Ice Cream funds']);
    expect(cellBy(ice.getWorksheet('Ice Cream funds')!, '2025-03', 'Cost closing')).toBe(6300);
    expect(cellBy(ice.getWorksheet('Ice Cream funds')!, '2025-03', 'Electricity closing')).toBe(-330);
    const tr = (await repXlsx(s, 'transfers', q('2025-03-01', '2025-04-30', 'month'))).wb!;
    expect(tr.worksheets.map((w) => w.name)).toEqual(['Transfers by direction', 'Transfers']);
    expect(cellBy(tr.getWorksheet('Transfers by direction')!, 'Total', 'Total moved')).toBe(900);
    const f = (await repXlsx(s, 'icecream-funds', q('2025-03-01', '2025-04-30', 'month'))).wb!;
    expect(f.worksheets.map((w) => w.name)).toEqual(['Ice Cream fund statement', 'Recognized profit & excess cost']);
    expect(cellBy(f.getWorksheet('Recognized profit & excess cost')!, 'Total', 'Recognized profit')).toBe(1025);
  });
});

describe('reports are read-only and electricity is never an expense (E2)', () => {
  it('calling every endpoint (JSON and Excel) changes no row of any table, the audit log included', async () => {
    const tables = (sql(s, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name: string }>).map((t) => t.name);
    const snapshot = () => Object.fromEntries(tables.map((t) => [t, JSON.stringify(sql(s, `SELECT * FROM ${t}`))]));
    const before = snapshot();
    for (const path of ENDPOINTS) {
      await rep(s, path, q('2025-03-01', '2025-04-30', 'day'));
      await repXlsx(s, path, q('2025-03-01', '2025-04-30', 'month'));
    }
    expect(snapshot()).toEqual(before);
  });

  it('the expense categories of the Shop and Telecom reports are the nine of section 7 - electricity is not among them', async () => {
    for (const path of ['pnl/shop', 'pnl/telecom']) {
      const r = (await rep(s, path, q('2025-03-01', '2025-04-30'))).body;
      expect(Object.keys(r.totals.expenses.byCategory).sort()).toEqual(
        ['cleaning_supplies', 'internet', 'other', 'packaging', 'rent', 'repairs', 'stationery', 'transport', 'water']);
    }
  });
});

describe('damaged return and voided loss (stock adjustments, BUSINESS_RULES 4, 11, C5, C13)', () => {
  /**
   * Product Z: 10 units for 10,000 (unit 1,000). 03-01 sale of 4 @ 3,000 with the cost entered as 1,250 per unit:
   *   revenue 12,000, automatic cost 4,000, extra 4 x 250 = 1,000 -> gross profit 12,000 - 4,000 - 1,000 = 7,000.
   * 03-02 ONE unit comes back DAMAGED: revenue -3,000, automatic cost -1,000, extra -250 (reversed, NOT lost) -> return gross profit -3,000 + 1,000 + 250 = -1,750;
   *   exactly one loss at the AUTOMATIC cost 1,000 is written (no stock movement) -> adjustments 1,000 on 03-02, net 03-02 = -1,750 - 1,000 = -2,750.
   * 03-03 a manual loss of 2 units (2,000) is VOIDED: it nets to zero (the row is void; its movement is reversed).
   * Check by another route: the 3 units kept by customers earned 9,000 - 3,000 - 750 = 5,250; the damaged unit lost its cost 1,000 once -> 4,250 in total.
   */
  it('revenue and cost reverse in the return period, ONE loss at automatic cost only, a voided loss counts for nothing', async () => {
    const d = await apiBase(await env.build());
    const z = (await mkProduct(d, { minPriceCents: 1 })).id as number;
    await buy(d, [{ productId: z, packs: 1, packSize: 10, lineTotalCents: 10000 }], { businessDate: '2025-02-28' });
    const sale = (await sellOk(d, [clc(z, 4, 3000, 1250)], { businessDate: '2025-03-01' })).sales[0];
    await returnOk(d, sale.id, [rl(sale.items[0].id, 1, false)], { businessDate: '2025-03-02' });
    const loss = await lossNew(d, z, 2, { businessDate: '2025-03-03', reason: 'lost' });
    expect(loss.status).toBe(201);
    expect((await lossVoid(d, loss.body.item.id)).status).toBeLessThan(300);
    const r = (await rep(d, 'pnl/shop', q('2025-03-01', '2025-03-03', 'day'))).body;
    const [d1, d2, d3] = r.rows;
    expect(d1.netProfitCents).toBe(7000);
    expect(d1.goods).toMatchObject({ revenueCents: 12000, costAutomaticCents: 4000, costExtraCents: 1000, grossProfitCents: 7000 });
    expect(d2.goods).toMatchObject({ returnsCents: 3000, revenueCents: -3000, costAutomaticCents: -1000, costExtraCents: -250, grossProfitCents: -1750 });
    expect(d2.adjustments).toEqual({ lossesCents: 0, damagedReturnLossesCents: 1000, stocktakeLossesCents: 0, stocktakeGainsCents: 0, residualSweepsCents: 0, purchaseRefundGainCents: 0, netCents: 1000 });
    expect(d2.netProfitCents).toBe(-2750);
    expect(d3.adjustments.netCents).toBe(0);
    expect(d3.netProfitCents).toBe(0);
    expect(r.totals.netProfitCents).toBe(4250);
  });
});
