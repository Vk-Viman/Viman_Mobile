// Phase 13 - Excel parsing and exact money parsing (pure unit tests; the workbooks are built in memory with ExcelJS).
// Protects BUSINESS_RULES section 0 (money = integer cents, exact decimal parsing, no floating point) and section 3
// (line value = exact entered total, or qty x unit cost; both given must agree to the cent).
// Organised as: readCell, parseMoneyCell, parseQtyCell, resolveLineValue, parseOpeningWorkbook (sheet/headers/rows,
// formulas, text numbers, blanks, file errors), validateRows (catalogue checks), buildTemplate.

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  HEADERS, MAX_ROWS, buildTemplate, parseMoneyCell, parseOpeningWorkbook, parseQtyCell, readCell, resolveLineValue,
  validateRows,
} from '../services/excel-opening-stock.ts';
import type { ParsedRow, ProductRef, Scalar } from '../services/excel-opening-stock.ts';
import { xlsx } from './helpers/phase13.ts';

const S = (s: string): Scalar => ({ t: 'str', s });
const N = (n: number): Scalar => ({ t: 'num', n });
const money = (s: Scalar) => parseMoneyCell(s);
const ok = (value: number) => ({ kind: 'ok', value });

describe('readCell', () => {
  it('reduces ExcelJS values to blank / string / number / bad', () => {
    expect(readCell(null)).toEqual({ t: 'blank' });
    expect(readCell(undefined)).toEqual({ t: 'blank' });
    expect(readCell('   ')).toEqual({ t: 'blank' });
    expect(readCell('  abc ')).toEqual({ t: 'str', s: 'abc' });
    expect(readCell(12.5)).toEqual({ t: 'num', n: 12.5 });
    expect(readCell(NaN).t).toBe('bad');
    expect(readCell(Infinity).t).toBe('bad');
    expect(readCell(true).t).toBe('bad');
    expect(readCell(new Date()).t).toBe('bad');
  });
  it('reads a formula through its saved result, and rejects a formula without one or an error cell', () => {
    expect(readCell({ formula: 'A1*2', result: 10 })).toEqual({ t: 'num', n: 10 });
    expect(readCell({ formula: 'A1&"x"', result: 'abx' })).toEqual({ t: 'str', s: 'abx' });
    expect(readCell({ formula: 'A1' } as any).t).toBe('bad');
    expect(readCell({ error: '#DIV/0!' } as any).t).toBe('bad');
    expect(readCell({ richText: [{ text: ' 1,2' }, { text: '00 ' }] } as any)).toEqual({ t: 'str', s: '1,200' });
    expect(readCell({ text: ' link ', hyperlink: 'http://x' } as any)).toEqual({ t: 'str', s: 'link' });
  });
});

describe('parseMoneyCell - exact decimals', () => {
  it('converts whole and decimal rupees to cents', () => {
    expect(money(N(50))).toEqual(ok(5000));
    expect(money(N(50.5))).toEqual(ok(5050));
    expect(money(N(0.05))).toEqual(ok(5));
    expect(money(N(0))).toEqual(ok(0));
    expect(money(S('1234.56'))).toEqual(ok(123456));
    expect(money(S('  7 '))).toEqual(ok(700));
  });
  it('accepts thousands commas in text', () => {
    expect(money(S('1,250.50'))).toEqual(ok(125050));
    expect(money(S('1,000,000'))).toEqual(ok(100000000));
  });
  it('is exact where floating point is not (0.1 + 0.2 style values, large amounts)', () => {
    expect(money(N(19.99))).toEqual(ok(1999)); // 19.99 * 100 = 1998.9999999999998 in floating point
    expect(money(N(1.15))).toEqual(ok(115)); // 1.15 * 100 = 114.99999999999999
    expect(money(N(8.2))).toEqual(ok(820)); // 8.2 * 100 = 819.9999999999999
    expect(money(S('999999999.99'))).toEqual(ok(99999999999));
  });
  it('treats an empty cell as blank (not zero)', () => {
    expect(money({ t: 'blank' })).toEqual({ kind: 'blank' });
  });
  it('rejects negatives, 3-or-more decimals, text, errors, exponent forms and huge values', () => {
    for (const bad of [S('-5'), N(-5), S('-0.01'), N(-0.5)]) expect(money(bad).kind).toBe('bad');
    expect((money(S('1.234')) as any).message).toMatch(/2 decimal/);
    expect(money(N(0.1 + 0.2)).kind).toBe('bad'); // 0.30000000000000004 - never silently rounded
    expect(money(N(33.333)).kind).toBe('bad');
    for (const bad of [S('abc'), S('NaN'), S('Infinity'), S('1e3'), S('1,2'), S('12,34.5'), S('.5'), S('5.'), S('Rs 5'), S('1 000')]) {
      expect(money(bad).kind, JSON.stringify(bad)).toBe('bad');
    }
    expect(money(N(1e21)).kind).toBe('bad');
    expect(money(N(1e-7)).kind).toBe('bad');
    expect(money(S('1000000000')).kind).toBe('bad'); // above Rs 999,999,999.99
    expect(money({ t: 'bad', why: 'is a date' }).kind).toBe('bad');
  });
});

describe('parseQtyCell', () => {
  it('accepts whole numbers (numeric or text, commas allowed)', () => {
    expect(parseQtyCell(N(10))).toEqual(ok(10));
    expect(parseQtyCell(S('25'))).toEqual(ok(25));
    expect(parseQtyCell(S('1,000'))).toEqual(ok(1000));
  });
  it('rejects blank, zero, negative, fractions, text and huge', () => {
    for (const bad of [{ t: 'blank' } as Scalar, N(0), N(-3), N(2.5), S('abc'), S('2.0'), S('-1'), N(1e12), N(NaN)]) {
      expect(parseQtyCell(bad).kind, JSON.stringify(bad)).toBe('bad');
    }
  });
});

describe('resolveLineValue (section 3)', () => {
  it('uses the exact total when only the total is given', () => {
    expect(resolveLineValue(3, null, 10000)).toEqual({ ok: true, totalValueCents: 10000 }); // 3 units for Rs 100.00: no per-unit rounding
  });
  it('uses qty x unit cost when only the unit cost is given', () => {
    expect(resolveLineValue(3, 3333, null)).toEqual({ ok: true, totalValueCents: 9999 });
  });
  it('accepts both when they agree exactly, rejects when they do not', () => {
    expect(resolveLineValue(4, 2500, 10000)).toEqual({ ok: true, totalValueCents: 10000 });
    const r = resolveLineValue(3, 3333, 10000);
    expect(r.ok).toBe(false);
    expect((r as any).message).toContain('99.99');
  });
  it('rejects neither given, and an overflowing product', () => {
    expect(resolveLineValue(3, null, null).ok).toBe(false);
    expect(resolveLineValue(1_000_000_000, 99_999_999_999, null).ok).toBe(false);
  });
});

describe('parseOpeningWorkbook', () => {
  it('reads a plain sheet exactly', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([
      ['A1', 'Alpha', 10, 50, null, 'note a'],
      ['B2', 'Beta', 3, null, 100, null],
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rowNo: 2, sku: 'A1', qty: 10, unitCostCents: 5000, totalValueCents: 50000, notes: 'note a', issues: [] });
    expect(rows[1]).toMatchObject({ rowNo: 3, sku: 'B2', qty: 3, unitCostCents: null, totalValueCents: 10000, issues: [] });
  });
  it('handles formula results, text numbers with commas and numeric SKUs', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([
      [12345, 'Numeric SKU', { formula: '2+3', result: 5 }, '1,250.50', null],
      ['F1', 'Formula cost', '1,000', null, { formula: '25*4', result: 100 }],
    ]));
    expect(rows[0]).toMatchObject({ sku: '12345', qty: 5, unitCostCents: 125050, totalValueCents: 625250, issues: [] });
    expect(rows[1]).toMatchObject({ qty: 1000, totalValueCents: 10000, issues: [] });
  });
  it('skips fully blank rows but keeps the real row numbers', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([['A', 'a', 1, 1], [], [null, null, null], ['B', 'b', 2, 2]]));
    expect(rows.map((r) => r.rowNo)).toEqual([2, 5]);
  });
  it('flags missing SKU, bad quantity and bad cost per row, without throwing', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([
      [null, 'No sku', 1, 1],
      ['Q0', 'Zero qty', 0, 5],
      ['Qx', 'Text qty', 'ten', 5],
      ['Qn', 'Blank qty', null, 5],
      ['C-', 'Negative cost', 1, -5],
      ['C3', 'Three decimals', 1, 1.234],
      ['Ct', 'Text cost', 1, 'abc'],
      ['Cb', 'No cost at all', 1, null, null],
      ['Cm', 'Mismatch', 3, 33.33, 100],
      ['Ct2', 'Negative total', 1, null, -1],
    ]));
    const codes = rows.map((r) => r.issues.map((i) => i.code));
    expect(codes).toEqual([
      ['MISSING_SKU'], ['BAD_QTY'], ['BAD_QTY'], ['BAD_QTY'], ['BAD_COST'], ['BAD_COST'], ['BAD_COST'], ['BAD_COST'], ['BAD_COST'], ['BAD_COST'],
    ]);
    expect(rows[8]!.issues[0]!.message).toContain('99.99');
    expect(rows[4]).toMatchObject({ unitCostCents: null, totalValueCents: null });
    expect(rows[2]!.qty).toBeNull();
  });
  it('rejects a formula cell that has no saved result', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([['F', 'x', 1, { formula: 'A9' }]]));
    expect(rows[0]!.issues[0]).toMatchObject({ code: 'BAD_COST' });
    expect(rows[0]!.issues[0]!.message).toContain('formula');
  });
  it('finds columns by header text, in any order, ignoring case and spacing', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([[5, 'z', 'SKU9', 200]], {
      headers: ['quantity', 'Notes', ' sku ', 'TOTAL  VALUE (rs)', 'Unit cost (Rs)'],
    }));
    expect(rows[0]).toMatchObject({ sku: 'SKU9', qty: 5, totalValueCents: 20000, issues: [] });
  });
  it('accepts the sheet name in any letter case and extra sheets', async () => {
    const rows = await parseOpeningWorkbook(await xlsx([['A', 'a', 1, 1]], { sheet: 'OPENING STOCK', extraSheets: ['Products'] }));
    expect(rows).toHaveLength(1);
  });
  it('MISSING_SHEET when there is no "Opening stock" sheet', async () => {
    await expect(parseOpeningWorkbook(await xlsx([['A', 'a', 1, 1]], { sheet: 'Sheet1' })))
      .rejects.toMatchObject({ statusCode: 422, code: 'MISSING_SHEET' });
  });
  it('MISSING_HEADERS names the missing columns', async () => {
    const e: any = await parseOpeningWorkbook(await xlsx([['A', 1]], { headers: ['SKU', 'Quantity'] })).catch((x) => x);
    expect(e).toMatchObject({ statusCode: 422, code: 'MISSING_HEADERS' });
    expect(e.message).toContain('Unit cost (Rs)');
    expect(e.message).toContain('Total value (Rs)');
    expect(e.message).not.toContain('SKU,');
  });
  it('EMPTY_FILE when there are only headers (or only blank rows)', async () => {
    await expect(parseOpeningWorkbook(await xlsx([]))).rejects.toMatchObject({ statusCode: 422, code: 'EMPTY_FILE' });
    await expect(parseOpeningWorkbook(await xlsx([[], [null]]))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });
  it('TOO_MANY_ROWS above the row limit', async () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => [`S${i}`, 'x', 1, 1]);
    await expect(parseOpeningWorkbook(await xlsx(rows))).rejects.toMatchObject({ statusCode: 422, code: 'TOO_MANY_ROWS' });
  }, 60000);
  it('accepts exactly the row limit', async () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => [`S${i}`, 'x', 1, 1]);
    expect(await parseOpeningWorkbook(await xlsx(rows))).toHaveLength(MAX_ROWS);
  }, 60000);
  it('INVALID_FILE for bytes that are not an xlsx (text, empty, truncated zip, a zip that is not a workbook)', async () => {
    for (const bytes of [Buffer.from('a,b,c\n1,2,3'), Buffer.alloc(0), Buffer.from('PK\x03\x04garbage'), Buffer.from('PK')]) {
      await expect(parseOpeningWorkbook(bytes)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_FILE' });
    }
  });
});

describe('validateRows', () => {
  const products: Record<string, ProductRef> = {
    A1: { id: 1, name: 'Alpha', active: true, kind: 'stock' },
    OFF: { id: 2, name: 'Retired', active: false, kind: 'stock' },
    SVC: { id: 3, name: 'Photocopy', active: true, kind: 'service' },
  };
  const lookup = (sku: string) => products[sku.toUpperCase()];
  const row = (rowNo: number, sku: string, over: Partial<ParsedRow> = {}): ParsedRow => ({
    rowNo, sku, productNameInFile: 'n', qty: 2, unitCostCents: 500, totalValueCents: 1000, notes: '', issues: [], ...over,
  });

  it('matches a product (any letter case) and reports ok', () => {
    const [r] = validateRows([row(2, 'a1')], lookup, false);
    expect(r).toMatchObject({ status: 'ok', productId: 1, productName: 'Alpha', issues: [] });
  });
  it('UNKNOWN_SKU for an unknown SKU and for a service product; INACTIVE_PRODUCT for an inactive one', () => {
    const r = validateRows([row(2, 'NOPE'), row(3, 'SVC'), row(4, 'OFF')], lookup, false);
    expect(r.map((x) => x.issues.map((i) => i.code))).toEqual([['UNKNOWN_SKU'], ['UNKNOWN_SKU'], ['INACTIVE_PRODUCT']]);
    expect(r.every((x) => x.status === 'error')).toBe(true);
    expect(r[0]!.productId).toBeNull();
    expect(r[1]!.issues[0]!.message).toContain('service');
  });
  it('flags EVERY occurrence of a duplicated SKU (case-insensitive) and names the other rows', () => {
    const r = validateRows([row(2, 'A1'), row(3, 'a1'), row(4, 'A1')], lookup, false);
    expect(r.map((x) => x.issues.map((i) => i.code))).toEqual([['DUPLICATE_SKU_IN_FILE'], ['DUPLICATE_SKU_IN_FILE'], ['DUPLICATE_SKU_IN_FILE']]);
    expect(r[0]!.issues[0]!.message).toContain('3, 4');
  });
  it('keeps the parser issues and adds catalogue issues', () => {
    const [r] = validateRows([row(2, 'NOPE', { qty: null, issues: [{ code: 'BAD_QTY', message: 'x', column: HEADERS.qty }] })], lookup, false);
    expect(r!.issues.map((i) => i.code)).toEqual(['BAD_QTY', 'UNKNOWN_SKU']);
    expect(r!.issueColumns).toEqual(['Quantity', 'SKU']);
  });
  it('a missing SKU is not looked up (only MISSING_SKU from the parser)', () => {
    const [r] = validateRows([row(2, '', { issues: [{ code: 'MISSING_SKU', message: 'x', column: 'SKU' }] })], lookup, false);
    expect(r!.issues.map((i) => i.code)).toEqual(['MISSING_SKU']);
  });
  it('R-FD: a future date marks every row FUTURE_DATE_NOT_ALLOWED', () => {
    const r = validateRows([row(2, 'A1'), row(3, 'NOPE')], lookup, true);
    expect(r[0]!.issues.map((i) => i.code)).toEqual(['FUTURE_DATE_NOT_ALLOWED']);
    expect(r[1]!.issues.map((i) => i.code)).toEqual(['UNKNOWN_SKU', 'FUTURE_DATE_NOT_ALLOWED']);
    expect(r[0]!.issues[0]!.message).toBe('Future-dated transactions are not allowed. Please select today or an earlier date.');
  });
  it('shows the rounded unit cost when only a total was given (display only)', () => {
    const [r] = validateRows([row(2, 'A1', { qty: 3, unitCostCents: null, totalValueCents: 10000 })], lookup, false);
    expect(r).toMatchObject({ unitCostCents: 3333, totalValueCents: 10000 });
  });
});

describe('buildTemplate', () => {
  it('writes the exact headers, a sample row and the Products sheet', async () => {
    const buf = await buildTemplate([
      { sku: 'P1', name: 'Alpha', categoryName: 'Other', book: 'shop' },
      { sku: null, name: 'No code', categoryName: 'Scratch Cards', book: 'telecom' },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Opening stock', 'Products']);
    const ws = wb.getWorksheet('Opening stock')!;
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual(['SKU', 'Product name', 'Quantity', 'Unit cost (Rs)', 'Total value (Rs)', 'Notes']);
    expect(ws.getRow(2).getCell(1).value).toBe('SAMPLE-001');
    const products = wb.getWorksheet('Products')!;
    expect(products.getRow(2).getCell(1).value).toBe('P1');
    expect(products.getRow(3).getCell(2).value).toBe('No code');
  });
  it('the template itself parses (its sample row is the only row, with an unknown SKU)', async () => {
    const rows = await parseOpeningWorkbook(await buildTemplate([]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: 'SAMPLE-001', qty: 10, unitCostCents: 5000, totalValueCents: 50000, issues: [] });
  });
});
