// Helpers for Phase 13 tests: opening stock batches and the Excel import (BUSINESS_RULES section 3, R-FD, R1, section 12).
// Three groups: (1) in-memory .xlsx builders (ExcelJS) so tests can create exactly the file they want - formulas, text
// numbers, blanks, wrong headers; (2) request builders for the multipart endpoints (preview / import) and the manual
// endpoint; (3) readers of the stock ledger and the batch tables for ledger-level assertions.

import ExcelJS from 'exceljs';
import type { DatabaseSync } from 'node:sqlite';
import { post } from './catalog.ts';
import { ref, today, mkProduct } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { buildMultipart } from './multipart.ts';
import type { Part } from './multipart.ts';

/** The exact template header row. */
export const HEADER_ROW = ['SKU', 'Product name', 'Quantity', 'Unit cost (Rs)', 'Total value (Rs)', 'Notes'];

/** A cell value a test may put in a sheet (plain value, or an Excel formula with its saved result). */
export type Cell = string | number | boolean | null | Date | { formula: string; result?: string | number };

/**
 * Builds an .xlsx file in memory.
 * @param rows data rows (below the header); each row is [sku, name, qty, unitCost, total, notes] (shorter rows allowed)
 * @param o headers: replace the header row; sheet: replace the sheet name; extraSheets: add empty sheets by name
 * @returns the file bytes
 */
export async function xlsx(
  rows: Cell[][], o: { headers?: string[]; sheet?: string; extraSheets?: string[] } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(o.sheet ?? 'Opening stock');
  ws.addRow(o.headers ?? HEADER_ROW);
  for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
  for (const name of o.extraSheets ?? []) wb.addWorksheet(name);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Raw multipart upload to an /excel/opening-stock/* endpoint. */
export async function upload(
  s: ApiBase, path: 'preview' | 'import', file: { name: string; content: Buffer } | null,
  fields: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const parts: Part[] = Object.entries(fields).map(([name, value]) => ({ name, value }));
  if (file) parts.push({ name: 'file', filename: file.name, content: file.content, contentType: 'application/octet-stream' });
  const mp = buildMultipart(parts);
  const res = await s.app.inject({ method: 'POST', url: `/api/v1/excel/opening-stock/${path}`, payload: mp.payload, headers: mp.headers });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/** Preview of a file (date defaults to today). */
export const previewFile = (s: ApiBase, content: Buffer, over: { name?: string; date?: string | null } = {}) =>
  upload(s, 'preview', { name: over.name ?? 'stock.xlsx', content }, over.date === null ? {} : { businessDate: over.date ?? today() });

/** Import of a file (fresh clientRef and today's date unless overridden). */
export const importFile = (
  s: ApiBase, content: Buffer, over: { name?: string; date?: string | null; clientRef?: string } = {},
) => upload(s, 'import', { name: over.name ?? 'stock.xlsx', content },
  { ...(over.date === null ? {} : { businessDate: over.date ?? today() }), clientRef: over.clientRef ?? ref() });

let skuSeq = 0;
/** Creates a stock product with a SKU (code) through the API; returns the item. */
export async function mkSku(s: ApiBase, code?: string, over: Record<string, unknown> = {}): Promise<any> {
  return mkProduct(s, { code: code ?? `SKU${skuSeq++}`, ...over });
}

/** One manual line. */
export const unitLine = (productId: number, qty: number, unitCostCents: number) => ({ productId, qty, unitCostCents });
export const totalLine = (productId: number, qty: number, totalValueCents: number) => ({ productId, qty, totalValueCents });

/** POST /opening-stock with today's date and a fresh clientRef unless overridden. */
export const openingPost = (s: ApiBase, items: unknown[], over: Record<string, unknown> = {}) =>
  post(s.app, '/opening-stock', { businessDate: today(), items, clientRef: ref(), ...over });

/** Posts a manual batch and returns the saved batch (throws unless 201). */
export async function openingOk(s: ApiBase, items: unknown[], over: Record<string, unknown> = {}): Promise<any> {
  const r = await openingPost(s, items, over);
  if (r.status !== 201) throw new Error(`opening stock failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
}

/** Rows of a table by raw SQL (oldest first). */
export const rowsOf = (c: DatabaseSync, q: string, ...p: any[]) => c.prepare(q).all(...p) as unknown as Array<Record<string, any>>;

/** Row counts of every table an opening stock write could touch (proof that a failed request wrote nothing). */
export const WRITE_TABLES = ['opening_stock_batches', 'stock_movements', 'cash_entries', 'audit_logs', 'purchases', 'stock_losses'];
