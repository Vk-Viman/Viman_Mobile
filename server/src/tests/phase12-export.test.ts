// Phase 12 EXPORT PACK: GET /reports/export-pack?from&to returns ONE workbook built from the Phase 11 report services (no new calculation).
// The workbook is opened with ExcelJS and key figures are checked against the hand calculations of the scripted world
// (helpers/phase11fin.ts; working in phase11-fin-world.test.ts): Shop net -181,100; Telecom 278,645; Ice Cream 102,500; Combined 200,045 cents.
// The workbook shows rupees (cents / 100) with two decimals, so -181,100 cents reads -1811.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type ExcelJS from 'exceljs';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get } from './helpers/catalog.ts';
import { buildFinWorld, cellBy, q, rep, repXlsx } from './helpers/phase11fin.ts';
import { dbSnapshot, pack } from './helpers/phase12.ts';

const env = new TestEnv();
let s: ApiBase;
let wb: ExcelJS.Workbook;

beforeAll(async () => {
  s = await apiBase(await env.build());
  await buildFinWorld(s, true);
  const r = await pack(s, 'from=2025-03-01&to=2025-04-30');
  expect(r.status).toBe(200);
  expect(r.type).toContain('spreadsheetml.sheet');
  expect(r.disposition).toContain('viman-export-pack-2025-03-01_2025-04-30.xlsx');
  wb = r.wb!;
}, 240000);
afterAll(async () => { await env.cleanup(); });

const sheet = (name: string): ExcelJS.Worksheet => {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`no sheet "${name}"; have ${wb.worksheets.map((w) => w.name).join(', ')}`);
  return ws;
};

/** The valuation's Total row has an empty first column (its label sits in "Product"), so it is found by any cell reading "Total". */
function stockTotal(ws: ExcelJS.Worksheet): ExcelJS.CellValue {
  const col = (ws.getRow(1).values as ExcelJS.CellValue[]).findIndex((h) => h === 'Stock value');
  for (let r = 2; r <= ws.rowCount; r++) {
    const vals = ws.getRow(r).values as ExcelJS.CellValue[];
    if (vals.includes('Total')) return ws.getRow(r).getCell(col).value;
  }
  throw new Error('no Total row');
}

describe('GET /reports/export-pack', () => {
  it('has every sheet of the contract, in order', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Combined P&L (by month)', 'Shop P&L', 'Telecom P&L', 'Ice Cream P&L', 'Ice Cream funds', 'Ice Cream profit and excess',
      'Cash book - Shop', 'Cash book - Telecom', 'Cash book - Ice Cream', 'Inventory valuation', 'Low stock', 'Sales', 'Purchases', 'Drawings', 'Printing variance',
    ]);
  });

  it('profit and loss sheets: one row per month plus a Total row, matching the hand calculation (rupees)', () => {
    const comb = sheet('Combined P&L (by month)');
    expect(comb.rowCount).toBeGreaterThanOrEqual(4); // header + March + April + Total (+ notes)
    expect(cellBy(comb, '2025-03', 'Shop profit')).toBe(-776); // -77,600 cents
    expect(cellBy(comb, '2025-03', 'Telecom profit')).toBe(2799.45);
    expect(cellBy(comb, '2025-03', 'Ice Cream recognized profit')).toBe(945);
    expect(cellBy(comb, '2025-03', 'Combined recognized profit (official)')).toBe(2968.45);
    expect(cellBy(comb, '2025-04', 'Combined recognized profit (official)')).toBe(-968);
    expect(cellBy(comb, 'Total', 'Combined recognized profit (official)')).toBe(2000.45);
    expect(cellBy(comb, 'Total', 'Combined profit after excess cost')).toBe(1840.45); // 200,045 - 16,000
    expect(cellBy(sheet('Shop P&L'), 'Total', 'Net profit')).toBe(-1811);
    expect(cellBy(sheet('Telecom P&L'), 'Total', 'Net profit')).toBe(2786.45);
    const ice = sheet('Ice Cream P&L');
    expect(cellBy(ice, 'Total', 'Recognized profit')).toBe(1025);
    expect(cellBy(ice, 'Total', 'Excess cost not yet charged')).toBe(160);
    expect(cellBy(ice, '2025-04', 'Outstanding excess cost at period end')).toBe(160);
  });

  it('Ice Cream funds sheets keep fund balances apart from recognized profit; cash books end at the ledger balance', () => {
    const funds = sheet('Ice Cream funds');
    expect(funds.rowCount).toBeGreaterThan(3);
    const prof = sheet('Ice Cream profit and excess');
    expect(prof.getRow(1).values).toContain('Recognized profit');
    expect(cellBy(sheet('Cash book - Shop'), 'Total', 'Closing balance')).toBe(6060);
    expect(cellBy(sheet('Cash book - Telecom'), 'Total', 'Closing balance')).toBe(57784.13);
    expect(cellBy(sheet('Cash book - Ice Cream'), 'Total', 'Closing balance')).toBe(5865);
  });

  it('inventory valuation is as of the end date (stock 285,000 cents); sales, low stock and the other sheets are present and headed', () => {
    expect(stockTotal(sheet('Inventory valuation'))).toBe(2850);
    // Sales net revenue = Shop goods 192,000 + scratch cards 18,000 = 210,000 cents
    expect(cellBy(sheet('Sales'), 'Total', 'Revenue (net)')).toBe(2100);
    expect(sheet('Low stock').getRow(1).values).toContain('Product');
    for (const name of ['Purchases', 'Drawings', 'Printing variance']) expect(sheet(name).getRow(1).getCell(1).value, name).toBe('Period');
  });

  it('negative money is stored as a negative number with a red-negative format, never as text', () => {
    const ws = sheet('Combined P&L (by month)');
    const headers = ws.getRow(1).values as ExcelJS.CellValue[];
    const col = headers.findIndex((h) => h === 'Shop profit');
    const cell = ws.getRow(2).getCell(col); // 2025-03: -776
    expect(typeof cell.value).toBe('number');
    expect(cell.value as number).toBeLessThan(0);
    expect(cell.numFmt).toContain('[Red]');
  });

  it('every sheet equals the single report of the same range (same services, no new calculation)', async () => {
    const single = await repXlsx(s, 'pnl/shop', q('2025-03-01', '2025-04-30', 'month'));
    const a = sheet('Shop P&L');
    const b = single.wb!.worksheets[0]!;
    expect(a.rowCount).toBe(b.rowCount);
    for (let r = 1; r <= a.rowCount; r++) expect(a.getRow(r).values, `row ${r}`).toEqual(b.getRow(r).values);
    const json = (await rep(s, 'pnl/combined', q('2025-03-01', '2025-04-30', 'month'))).body;
    expect(cellBy(sheet('Combined P&L (by month)'), 'Total', 'Combined recognized profit (official)')).toBe(json.totals.recognizedProfitCents / 100);
    const val = (await get(s.app, '/reports/inventory/valuation?asOf=2025-04-30')).body;
    expect(stockTotal(sheet('Inventory valuation'))).toBe(val.totals.valueCents / 100);
  });

  it('a single-day range and a range with no records both work; the workbook still has every sheet', async () => {
    const one = await pack(s, 'from=2025-03-02&to=2025-03-02');
    expect(one.status).toBe(200);
    expect(one.wb!.worksheets).toHaveLength(15);
    expect(cellBy(one.wb!.getWorksheet('Shop P&L')!, 'Total', 'Net profit')).toBe(1200); // 03-02: 120,000 cents
    const empty = await pack(s, 'from=2020-01-01&to=2020-01-31');
    expect(empty.status).toBe(200);
    expect(cellBy(empty.wb!.getWorksheet('Combined P&L (by month)')!, 'Total', 'Combined recognized profit (official)')).toBe(0);
    const future = await pack(s, 'from=2031-01-01&to=2031-03-31');
    expect(future.status).toBe(200); // R-FD is for writes only
    expect(stockTotal(future.wb!.getWorksheet('Inventory valuation')!)).toBe(2850);
  });

  it('validation: missing, impossible, reversed and over-long ranges are 400 with the field named', async () => {
    for (const [qs, field] of [
      ['to=2025-04-30', 'from'], ['from=2025-03-01', 'to'], ['from=2025-02-30&to=2025-03-01', 'from'], ['from=2025-04-30&to=2025-03-01', 'from'],
      ['from=2010-01-01&to=2025-04-30', 'to'], // 5,600 days
    ] as const) {
      const r = await pack(s, qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.fields[field], qs).toBeTruthy();
    }
    expect((await pack(s, 'from=2015-01-01&to=2024-12-31')).status).toBe(200); // exactly 3,652 days: within the 3,660-day limit
    expect((await pack(s, 'from=2015-01-01&to=2025-01-10')).status).toBe(400); // 3,663 days
  });

  it('is read-only: no table changes and no audit row', async () => {
    const before = dbSnapshot(s.ctx);
    expect((await pack(s, 'from=2025-03-01&to=2025-04-30')).status).toBe(200);
    const after = dbSnapshot(s.ctx);
    for (const t of Object.keys(before)) expect(after[t], t).toBe(before[t]);
  });
});
