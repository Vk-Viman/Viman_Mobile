/**
 * services/excel-opening-stock.ts - the Excel side of opening stock: template builder, exact parser, row validator.
 *
 * Layer: service helper (no database access, no HTTP). The owner downloads a template, fills it in and uploads it;
 * this file turns the uploaded `.xlsx` bytes into validated rows. Three steps, each a plain function so it can be
 * tested alone:
 *   1. `buildTemplate`        - writes the template workbook ("Opening stock" sheet + "Products" reference sheet).
 *   2. `parseOpeningWorkbook` - reads the sheet and the cells exactly (money as exact decimals, never floats).
 *   3. `validateRows`         - checks each row against the product catalogue (supplied as a lookup function).
 *
 * Rules implemented here:
 *  - Section 0: money is integer cents. A cell is converted with the shared exact decimal helper
 *    (`rupeesToCents`): Rs with at most 2 decimals, thousands commas allowed, no floating-point arithmetic.
 *    Negative, non-numeric and 3-or-more-decimal values are rejected, never rounded.
 *  - Section 3: opening stock value is the EXACT entered total, or quantity x unit cost. When both are given they
 *    must agree to the cent, otherwise the row is rejected (BAD_COST) instead of guessing which one is right.
 *  - R-FD: a future business date marks every row FUTURE_DATE_NOT_ALLOWED (opening-stock import rows are in the
 *    R-FD list); the server also refuses the import itself.
 * The header names are the contract with the template: the importer finds columns by these exact names.
 */
import ExcelJS from 'exceljs';
import { AppError } from '../lib/errors.ts';
import { mulDivRound, rupeesToCents } from '../lib/money.ts';

/** Name of the sheet the importer reads. */
export const OPENING_SHEET = 'Opening stock';
/** Name of the reference sheet listing the products (ignored by the importer). */
export const PRODUCTS_SHEET = 'Products';

/** The exact header texts of the template (the contract between the template and the importer). */
export const HEADERS = {
  sku: 'SKU',
  name: 'Product name',
  qty: 'Quantity',
  unitCost: 'Unit cost (Rs)',
  total: 'Total value (Rs)',
  notes: 'Notes',
} as const;

/** Largest accepted file: 5 MB (a go-live stock list is a few hundred rows). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Largest number of filled rows in one import. */
export const MAX_ROWS = 5000;
/** Largest quantity of one line (keeps every later sum inside the safe-integer range). */
export const MAX_QTY = 1_000_000_000;
/** Largest value of one line in cents (Rs 999,999,999.99), the same cap as a purchase line. */
export const MAX_LINE_VALUE_CENTS = 99_999_999_999;

/** The row problems the importer can report (API_CONTRACTS "Phase 13"). */
export type IssueCode =
  | 'MISSING_SKU' | 'UNKNOWN_SKU' | 'INACTIVE_PRODUCT' | 'BAD_QTY' | 'BAD_COST'
  | 'DUPLICATE_SKU_IN_FILE' | 'FUTURE_DATE_NOT_ALLOWED';

/** One problem on one row; `column` is the header of the cell to fix ('' when it concerns the whole row). */
export interface RowIssue { code: IssueCode; message: string; column: string }

/** One filled row of the sheet after exact parsing (before the catalogue check). Unusable values are null. */
export interface ParsedRow {
  rowNo: number;
  sku: string;
  productNameInFile: string;
  qty: number | null;
  unitCostCents: number | null;
  totalValueCents: number | null;
  notes: string;
  issues: RowIssue[];
}

/** A catalogue product as the validator needs it. */
export interface ProductRef {
  id: number; name: string; active: boolean; kind: 'stock' | 'service';
  categoryName?: string; book?: 'shop' | 'telecom';
}

/** One row of the preview: the parsed values plus the product it matched and its final status. */
export interface PreviewRow {
  rowNo: number;
  sku: string;
  productId: number | null;
  productName: string;
  /** Category and book of the matched product (null when no product matched). */
  categoryName: string | null;
  book: 'shop' | 'telecom' | null;
  qty: number | null;
  unitCostCents: number | null;
  totalValueCents: number | null;
  notes: string;
  status: 'ok' | 'error';
  issues: Array<{ code: IssueCode; message: string }>;
  /** Header of the cell each issue belongs to (same order as `issues`); stored in the import audit. */
  issueColumns: string[];
}

// ---------- cell reading ----------

/** A cell reduced to the four things we care about. */
export type Scalar =
  | { t: 'blank' } | { t: 'str'; s: string } | { t: 'num'; n: number } | { t: 'bad'; why: string };

/**
 * Reduces any ExcelJS cell value to a `Scalar`. A formula is read through its saved result (what Excel last
 * calculated); a formula with no saved result, an error cell, a date or a TRUE/FALSE cell is `bad`.
 */
export function readCell(v: ExcelJS.CellValue | undefined): Scalar {
  if (v === null || v === undefined) return { t: 'blank' };
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? { t: 'blank' } : { t: 'str', s };
  }
  if (typeof v === 'number') return Number.isFinite(v) ? { t: 'num', n: v } : { t: 'bad', why: 'is not a valid number' };
  if (typeof v === 'boolean') return { t: 'bad', why: 'must be a number, not TRUE/FALSE' };
  if (v instanceof Date) return { t: 'bad', why: 'must be a number, not a date' };
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('error' in o) return { t: 'bad', why: `contains an Excel error (${String(o.error)})` };
    if ('formula' in o || 'sharedFormula' in o) {
      const result = o.result as ExcelJS.CellValue | undefined;
      if (result === undefined || result === null) {
        return { t: 'bad', why: 'is a formula with no calculated value (open the file in Excel, save it, and upload it again)' };
      }
      return readCell(result);
    }
    if (Array.isArray(o.richText)) {
      const s = (o.richText as Array<{ text?: string }>).map((p) => p.text ?? '').join('').trim();
      return s === '' ? { t: 'blank' } : { t: 'str', s };
    }
    if (typeof o.text === 'string') {
      const s = o.text.trim();
      return s === '' ? { t: 'blank' } : { t: 'str', s };
    }
  }
  return { t: 'bad', why: 'is not a plain value' };
}

/** Text of a cell for SKU / name / notes: numbers are written without exponent ("12345"). */
function textOf(s: Scalar): string {
  if (s.t === 'str') return s.s;
  if (s.t === 'num') return Number.isInteger(s.n) ? s.n.toFixed(0) : String(s.n);
  return '';
}

/** Result of reading a money or quantity cell. */
export type NumberCell = { kind: 'blank' } | { kind: 'ok'; value: number } | { kind: 'bad'; message: string };

/**
 * Exact money parser for one cell (section 0). Accepts a number, or text like "1,250.50" / "50"; returns cents.
 * Never uses floating-point arithmetic on the amount: a numeric cell is turned back into its shortest decimal text
 * and converted by the shared `rupeesToCents`. Rejects negatives, 3-or-more decimals, text, errors and huge values.
 */
export function parseMoneyCell(s: Scalar): NumberCell {
  if (s.t === 'blank') return { kind: 'blank' };
  if (s.t === 'bad') return { kind: 'bad', message: `This cell ${s.why}.` };
  const text = s.t === 'num' ? String(s.n) : s.s;
  if (text.startsWith('-')) return { kind: 'bad', message: 'The amount cannot be negative.' };
  // "1e+21" / "1e-7" (how JavaScript writes very large or tiny numbers) is never a sensible shop amount.
  if (/e/i.test(text)) return { kind: 'bad', message: 'This is not a valid amount in rupees.' };
  if (/\.\d{3,}/.test(text)) return { kind: 'bad', message: 'Use at most 2 decimal places (cents).' };
  let cents: number;
  try {
    cents = rupeesToCents(text);
  } catch {
    return { kind: 'bad', message: 'This is not a valid amount in rupees (example: 1,250.50).' };
  }
  if (cents > MAX_LINE_VALUE_CENTS) return { kind: 'bad', message: 'This amount is too large.' };
  return { kind: 'ok', value: cents };
}

/** Quantity parser: a whole number from 1 up to `MAX_QTY`, as a number or as text ("1,000" allowed). */
export function parseQtyCell(s: Scalar): NumberCell {
  if (s.t === 'blank') return { kind: 'bad', message: 'Enter a quantity (a whole number, 1 or more).' };
  if (s.t === 'bad') return { kind: 'bad', message: `The quantity ${s.why}.` };
  let n: number;
  if (s.t === 'num') {
    n = s.n;
  } else if (/^\d+$/.test(s.s) || /^\d{1,3}(,\d{3})+$/.test(s.s)) {
    n = Number(s.s.replaceAll(',', ''));
  } else {
    return { kind: 'bad', message: 'The quantity must be a whole number (1 or more).' };
  }
  if (!Number.isSafeInteger(n) || n < 1) return { kind: 'bad', message: 'The quantity must be a whole number (1 or more).' };
  if (n > MAX_QTY) return { kind: 'bad', message: 'This quantity is too large.' };
  return { kind: 'ok', value: n };
}

/** Rupee text of cents for messages ("1,250.50"), built with integers only. */
function rs(cents: number): string {
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Decides the line value from quantity, unit cost and total value (section 3): the exact total when only the total
 * is given, quantity x unit cost when only the unit cost is given, and when both are given they must agree exactly.
 * @returns the exact line total in cents, or a BAD_COST message.
 */
export function resolveLineValue(
  qty: number, unitCostCents: number | null, totalValueCents: number | null,
): { ok: true; totalValueCents: number } | { ok: false; message: string } {
  if (unitCostCents === null && totalValueCents === null) {
    return { ok: false, message: 'Enter a unit cost or a total value.' };
  }
  const computed = unitCostCents === null ? null : BigInt(qty) * BigInt(unitCostCents);
  if (computed !== null && computed > BigInt(MAX_LINE_VALUE_CENTS)) {
    return { ok: false, message: 'Quantity x unit cost is too large.' };
  }
  if (totalValueCents === null) return { ok: true, totalValueCents: Number(computed) };
  if (computed !== null && computed !== BigInt(totalValueCents)) {
    return {
      ok: false,
      message: `Unit cost x quantity is Rs. ${rs(Number(computed))} but the total value is Rs. ${rs(totalValueCents)}. Fill in only one of them, or make them agree.`,
    };
  }
  return { ok: true, totalValueCents };
}

// ---------- parsing the workbook ----------

/** Lower-cases and collapses spaces so "  Unit  Cost (Rs) " still matches the header. */
function normHeader(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Reads the uploaded workbook and returns the filled rows of the "Opening stock" sheet with exact values.
 * Blank rows are skipped. The cell-level problems (MISSING_SKU, BAD_QTY, BAD_COST) are recorded on each row;
 * the catalogue checks come later in `validateRows`.
 *
 * @throws AppError 400 INVALID_FILE (not a readable .xlsx), 422 MISSING_SHEET, 422 MISSING_HEADERS,
 *   422 EMPTY_FILE (no filled rows), 422 TOO_MANY_ROWS.
 */
export async function parseOpeningWorkbook(buffer: Buffer): Promise<ParsedRow[]> {
  // An .xlsx file is a zip archive, which always starts with "PK".
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new AppError(400, 'INVALID_FILE', 'This is not a valid Excel (.xlsx) file. Please use the template.');
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new AppError(400, 'INVALID_FILE', 'This is not a valid Excel (.xlsx) file. Please use the template.');
  }
  const ws = wb.worksheets.find((w) => normHeader(w.name) === normHeader(OPENING_SHEET));
  if (!ws) {
    throw new AppError(422, 'MISSING_SHEET', `The file has no sheet named "${OPENING_SHEET}". Please use the template.`);
  }

  // Column numbers by header text (row 1).
  const cols = new Map<string, number>();
  ws.getRow(1).eachCell((cell, colNumber) => {
    const h = readCell(cell.value);
    if (h.t === 'str') cols.set(normHeader(h.s), colNumber);
  });
  const need = [HEADERS.sku, HEADERS.qty, HEADERS.unitCost, HEADERS.total];
  const missing = need.filter((h) => !cols.has(normHeader(h)));
  if (missing.length > 0) {
    throw new AppError(422, 'MISSING_HEADERS',
      `The "${OPENING_SHEET}" sheet is missing these column headers in row 1: ${missing.join(', ')}. Please use the template.`,
      { headers: missing.join(', ') });
  }
  const col = (h: string): number | undefined => cols.get(normHeader(h));
  const cell = (r: number, h: string): Scalar => {
    const c = col(h);
    return c === undefined ? { t: 'blank' } : readCell(ws.getRow(r).getCell(c).value);
  };

  // A crafted file can declare millions of empty rows; refuse before looping over them.
  if (ws.rowCount > MAX_ROWS * 4) {
    throw new AppError(422, 'TOO_MANY_ROWS', `The sheet has too many rows (the limit is ${MAX_ROWS} stock lines).`);
  }
  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const sku = cell(r, HEADERS.sku);
    const name = cell(r, HEADERS.name);
    const qty = cell(r, HEADERS.qty);
    const unit = cell(r, HEADERS.unitCost);
    const total = cell(r, HEADERS.total);
    const notes = cell(r, HEADERS.notes);
    if ([sku, name, qty, unit, total, notes].every((s) => s.t === 'blank')) continue; // an empty row
    if (rows.length >= MAX_ROWS) {
      throw new AppError(422, 'TOO_MANY_ROWS', `The sheet has too many rows (the limit is ${MAX_ROWS} stock lines).`);
    }

    const issues: RowIssue[] = [];
    const skuText = textOf(sku);
    if (sku.t === 'bad') issues.push({ code: 'MISSING_SKU', message: `The SKU ${sku.why}.`, column: HEADERS.sku });
    else if (skuText === '') issues.push({ code: 'MISSING_SKU', message: 'Enter the product SKU.', column: HEADERS.sku });

    const q = parseQtyCell(qty);
    let qtyValue: number | null = null;
    if (q.kind === 'ok') qtyValue = q.value;
    else if (q.kind === 'bad') issues.push({ code: 'BAD_QTY', message: q.message, column: HEADERS.qty });

    const u = parseMoneyCell(unit);
    const t = parseMoneyCell(total);
    const unitValue = u.kind === 'ok' ? u.value : null;
    let totalValue = t.kind === 'ok' ? t.value : null;
    let costBad = false;
    if (u.kind === 'bad') { issues.push({ code: 'BAD_COST', message: `Unit cost: ${u.message}`, column: HEADERS.unitCost }); costBad = true; }
    if (t.kind === 'bad') { issues.push({ code: 'BAD_COST', message: `Total value: ${t.message}`, column: HEADERS.total }); costBad = true; }
    if (!costBad && qtyValue !== null) {
      const v = resolveLineValue(qtyValue, unitValue, totalValue);
      if (v.ok) totalValue = v.totalValueCents;
      else { issues.push({ code: 'BAD_COST', message: v.message, column: HEADERS.total }); totalValue = null; }
    } else if (!costBad && u.kind === 'blank' && t.kind === 'blank') {
      issues.push({ code: 'BAD_COST', message: 'Enter a unit cost or a total value.', column: HEADERS.unitCost });
    }
    if (costBad) totalValue = null;

    rows.push({
      rowNo: r, sku: skuText, productNameInFile: textOf(name), qty: qtyValue, unitCostCents: unitValue,
      totalValueCents: totalValue, notes: textOf(notes), issues,
    });
  }
  if (rows.length === 0) {
    throw new AppError(422, 'EMPTY_FILE', 'The file has no stock lines. Fill in at least one row under the headers.');
  }
  return rows;
}

// ---------- catalogue validation ----------

/**
 * Adds the catalogue checks to the parsed rows: UNKNOWN_SKU, INACTIVE_PRODUCT, DUPLICATE_SKU_IN_FILE and, when the
 * business date is in the future, FUTURE_DATE_NOT_ALLOWED (R-FD) on every row. A SKU is matched ignoring letter case.
 * A service product has no stock, so it is reported like an unknown SKU.
 *
 * @param lookup Finds a product by SKU (case-insensitive) or returns undefined.
 * @param futureDate True when the chosen business date is later than today in Colombo.
 */
export function validateRows(
  rows: ParsedRow[], lookup: (sku: string) => ProductRef | undefined, futureDate: boolean,
): PreviewRow[] {
  // Rows per SKU (case-insensitive) to find duplicates; every occurrence is flagged so the owner sees all of them.
  const bySku = new Map<string, number[]>();
  for (const r of rows) {
    if (r.sku === '') continue;
    const key = r.sku.toUpperCase();
    bySku.set(key, [...(bySku.get(key) ?? []), r.rowNo]);
  }
  return rows.map((r): PreviewRow => {
    const issues = [...r.issues];
    let product: ProductRef | undefined;
    if (r.sku !== '') {
      product = lookup(r.sku);
      if (!product || product.kind !== 'stock') {
        issues.push({
          code: 'UNKNOWN_SKU', column: HEADERS.sku,
          message: product
            ? `${r.sku} is a service, not a stock product, so it has no stock.`
            : `No product has the SKU "${r.sku}". Check the Products sheet of the template.`,
        });
        product = undefined;
      } else if (!product.active) {
        issues.push({ code: 'INACTIVE_PRODUCT', column: HEADERS.sku, message: `${product.name} is inactive. Reactivate it first.` });
      }
      const same = bySku.get(r.sku.toUpperCase()) ?? [];
      if (same.length > 1) {
        const others = same.filter((n) => n !== r.rowNo).join(', ');
        issues.push({ code: 'DUPLICATE_SKU_IN_FILE', column: HEADERS.sku, message: `This SKU also appears on row ${others}. Use one row per product.` });
      }
    }
    if (futureDate) {
      issues.push({
        code: 'FUTURE_DATE_NOT_ALLOWED', column: '',
        message: 'Future-dated transactions are not allowed. Please select today or an earlier date.',
      });
    }
    // Unit cost shown to the owner: what was typed, otherwise the rounded average (display only).
    let unit = r.unitCostCents;
    if (unit === null && r.qty !== null && r.totalValueCents !== null) {
      unit = mulDivRound(r.totalValueCents, 1, r.qty);
    }
    return {
      rowNo: r.rowNo, sku: r.sku, productId: product ? product.id : null,
      productName: product ? product.name : r.productNameInFile,
      categoryName: product?.categoryName ?? null, book: product?.book ?? null,
      qty: r.qty, unitCostCents: unit, totalValueCents: r.totalValueCents, notes: r.notes,
      status: issues.length === 0 ? 'ok' : 'error',
      issues: issues.map((i) => ({ code: i.code, message: i.message })),
      issueColumns: issues.map((i) => i.column),
    };
  });
}

// ---------- the template ----------

/** A product line of the "Products" reference sheet. */
export interface TemplateProduct { sku: string | null; name: string; categoryName: string; book: 'shop' | 'telecom' }

/**
 * Builds the template workbook: the "Opening stock" sheet (exact headers, one sample row, input checks and header
 * notes) and the "Products" sheet listing every active stock product so the owner can copy the exact SKUs.
 * @returns the .xlsx file bytes
 */
export async function buildTemplate(products: TemplateProduct[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Viman Mobile';
  const ws = wb.addWorksheet(OPENING_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: HEADERS.sku, key: 'sku', width: 18 },
    { header: HEADERS.name, key: 'name', width: 34 },
    { header: HEADERS.qty, key: 'qty', width: 12 },
    { header: HEADERS.unitCost, key: 'unit', width: 16 },
    { header: HEADERS.total, key: 'total', width: 18 },
    { header: HEADERS.notes, key: 'notes', width: 34 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  const notes: Record<number, string> = {
    1: 'The product SKU exactly as in the Products sheet. Required.',
    2: 'For your reference only; the product is found by SKU.',
    3: 'Whole number of units, 1 or more. Required.',
    4: 'Cost of ONE unit in rupees (up to 2 decimals). Fill this OR Total value.',
    5: 'Cost of ALL the units in rupees (up to 2 decimals). Fill this OR Unit cost. If both are filled they must agree.',
    6: 'Optional.',
  };
  for (const [c, text] of Object.entries(notes)) head.getCell(Number(c)).note = text;
  // One sample row so the format is obvious; the owner deletes it. Its SKU is not a real product on purpose.
  ws.addRow({ sku: 'SAMPLE-001', name: 'Example product (delete this row)', qty: 10, unit: 50, notes: 'Example' });
  // Input checks for the first 1000 rows (Excel shows a warning for a wrong entry).
  for (let r = 2; r <= 1001; r++) {
    ws.getCell(r, 3).dataValidation = {
      type: 'whole', operator: 'greaterThanOrEqual', formulae: [1], allowBlank: true, showErrorMessage: true,
      errorTitle: 'Quantity', error: 'Enter a whole number, 1 or more.',
    };
    for (const c of [4, 5]) {
      ws.getCell(r, c).dataValidation = {
        type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true, showErrorMessage: true,
        errorTitle: 'Amount', error: 'Enter an amount in rupees, 0 or more, with up to 2 decimals.',
      };
    }
  }

  const ref = wb.addWorksheet(PRODUCTS_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ref.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Product name', key: 'name', width: 38 },
    { header: 'Category', key: 'cat', width: 22 },
    { header: 'Book', key: 'book', width: 12 },
  ];
  ref.getRow(1).font = { bold: true };
  for (const p of products) {
    ref.addRow({ sku: p.sku ?? '(no SKU - add one in Products)', name: p.name, cat: p.categoryName, book: p.book });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
