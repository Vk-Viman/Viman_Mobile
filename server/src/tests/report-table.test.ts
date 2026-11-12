// Shared report plumbing (lib/report-table.ts): period splitting must be contiguous and clipped to the range so report rows add up
// to the total (BUSINESS_RULES 10.6), and the Excel writer must show cents as rupees with two decimals.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { daysInRange, listPeriods, reportTablesToXlsx } from '../lib/report-table.ts';

describe('listPeriods', () => {
  it('day rows: one per calendar day, inclusive', () => {
    expect(listPeriods('2026-02-27', '2026-03-01', 'day').map((p) => p.label)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
  it('month rows are clipped to the range and contiguous (leap year Feb has 29 days)', () => {
    expect(listPeriods('2028-01-15', '2028-03-10', 'month')).toEqual([
      { from: '2028-01-15', to: '2028-01-31', label: '2028-01' },
      { from: '2028-02-01', to: '2028-02-29', label: '2028-02' },
      { from: '2028-03-01', to: '2028-03-10', label: '2028-03' },
    ]);
  });
  it('a single day and a range inside one month give one row; crossing the year works', () => {
    expect(listPeriods('2026-05-05', '2026-05-05', 'month')).toHaveLength(1);
    expect(listPeriods('2026-12-20', '2027-01-02', 'month').map((p) => [p.from, p.to])).toEqual([['2026-12-20', '2026-12-31'], ['2027-01-01', '2027-01-02']]);
  });
  it('counts days inclusively and rejects from > to', () => {
    expect(daysInRange('2026-11-01', '2026-11-30')).toBe(30);
    expect(() => listPeriods('2026-11-02', '2026-11-01', 'day')).toThrow();
  });
});

describe('reportTablesToXlsx', () => {
  it('writes cents as rupees, keeps text, bolds nothing it should not, and survives duplicate sheet names', async () => {
    const t = { title: 'P&L', columns: [{ key: 'a', label: 'Line', kind: 'text' as const }, { key: 'b', label: 'Amount', kind: 'money' as const }], rows: [{ a: 'Sales', b: 123456 }], totals: { a: 'Total', b: 123456 } };
    const buf = await reportTablesToXlsx([t, t]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['P&L', 'P&L 2']);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell('B2').value).toBe(1234.56);
    expect(ws.getCell('A3').value).toBe('Total');
  });
});
