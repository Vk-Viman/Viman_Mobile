// Phase 13 - Excel template, preview and import endpoints - API level (Fastify inject with hand-built multipart bodies).
// Protects BUSINESS_RULES section 3 (exact value from the file, weighted average with existing stock, no cash/P&L), R-FD
// (future date refused), R1 (a voided import can be redone), section 12 (clientRef idempotency, same-file guard by SHA-256,
// append-only import audit) and the all-or-nothing rule: ONE bad row among many good ones saves nothing.
// Organised as: template, preview (codes, nothing written, file errors), import (success, all-or-nothing, same file,
// clientRef, date), import audit trail.

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { TestEnv } from './helpers/tmp.ts';
import { count, get, post } from './helpers/catalog.ts';
import { apiBase, buy, cashRows, daysAgo, daysAhead, mkProduct, productOf, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { WRITE_TABLES, importFile, mkSku, openingOk, previewFile, rowsOf, unitLine, upload, xlsx } from './helpers/phase13.ts';
import { reconcileStock } from '../services/inventory.service.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const err = (r: { body: any }) => r.body.error;
const snap = (s: ApiBase) => Object.fromEntries([...WRITE_TABLES, 'import_runs', 'import_issues'].map((t) => [t, count(s.ctx, t)]));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const recon = (s: ApiBase) => expect(reconcileStock(s.ctx.database.conn)).toMatchObject({ ok: true, mismatches: [] });
const FUTURE_MSG = 'Future-dated transactions are not allowed. Please select today or an earlier date.';
const ROW_KEYS = ['issues', 'productId', 'productName', 'qty', 'rowNo', 'sku', 'status', 'totalValueCents', 'unitCostCents'].sort();

describe('GET /excel/opening-stock-template', () => {
  it('downloads an .xlsx with the exact headers, a sample row and a Products sheet of ACTIVE STOCK products only', async () => {
    const s = await setup();
    const a = await mkSku(s, 'TPL-A');
    await mkSku(s, 'TPL-OFF');
    await s.app.inject({ method: 'PUT', url: '/api/v1/products/' + (await get(s.app, '/products?q=TPL-OFF')).body.items[0].id, payload: { active: false } });
    await mkSku(s, 'TPL-SVC', { kind: 'service' });
    const res = await s.app.inject({ method: 'GET', url: '/api/v1/excel/opening-stock-template' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe('attachment; filename="opening-stock-template.xlsx"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Opening stock', 'Products']);
    expect((wb.getWorksheet('Opening stock')!.getRow(1).values as any[]).slice(1))
      .toEqual(['SKU', 'Product name', 'Quantity', 'Unit cost (Rs)', 'Total value (Rs)', 'Notes']);
    const skus: string[] = [];
    wb.getWorksheet('Products')!.eachRow((row, n) => { if (n > 1) skus.push(String(row.getCell(1).value)); });
    expect(skus).toContain('TPL-A');
    expect(skus).not.toContain('TPL-OFF');
    expect(skus).not.toContain('TPL-SVC');
    expect(a.code).toBe('TPL-A');
  });
  it('the downloaded template uploads cleanly except for its sample SKU, which is not a product', async () => {
    const s = await setup();
    const res = await s.app.inject({ method: 'GET', url: '/api/v1/excel/opening-stock-template' });
    const r = await previewFile(s, res.rawPayload);
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0].issues.map((i: any) => i.code)).toEqual(['UNKNOWN_SKU']);
  });
});

describe('POST /excel/opening-stock/preview', () => {
  it('returns per-row values, the summary and the SHA-256; writes NOTHING to stock, cash or purchases', async () => {
    const s = await setup();
    const a = await mkSku(s, 'P-A', { name: 'Alpha cable' });
    const b = await mkSku(s, 'P-B', { name: 'Beta case' });
    const file = await xlsx([['P-A', 'x', 10, 50, null, 'n'], ['p-b', 'y', 3, null, '1,000.00', null]]);
    const before = snap(s);
    const r = await previewFile(s, file);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['alreadyCommitted', 'fileSha256', 'importRunId', 'rows', 'summary']);
    expect(r.body.fileSha256).toBe(sha(file));
    expect(r.body.alreadyCommitted).toBe(false);
    expect(Object.keys(r.body.rows[0]).sort()).toEqual(ROW_KEYS);
    expect(r.body.rows).toEqual([
      { rowNo: 2, sku: 'P-A', productId: a.id, productName: 'Alpha cable', qty: 10, unitCostCents: 5000, totalValueCents: 50000, status: 'ok', issues: [] },
      { rowNo: 3, sku: 'p-b', productId: b.id, productName: 'Beta case', qty: 3, unitCostCents: 33333, totalValueCents: 100000, status: 'ok', issues: [] },
    ]);
    expect(r.body.summary).toEqual({ total: 2, ok: 2, failed: 0, totalValueCents: 150000 });
    // Only the audit of the preview itself is written.
    const after = snap(s);
    expect(after).toEqual({ ...before, import_runs: 1 });
    expect(count(s.ctx, 'stock_movements')).toBe(0);
    expect(cashRows(s.ctx)).toEqual([]);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(rowsOf(s.ctx.database.conn, 'SELECT * FROM import_runs')[0]).toMatchObject({
      kind: 'opening_stock', file_name: 'stock.xlsx', file_sha256: sha(file), business_date: today(), mode: 'preview',
      status: 'previewed', rows_total: 2, rows_ok: 2, rows_failed: 0, batch_id: null,
    });
  });
  it('reports every row code, records the issues, and keeps the good rows ok', async () => {
    const s = await setup();
    await mkSku(s, 'OK-1');
    await mkSku(s, 'DUP-1');
    const off = await mkSku(s, 'OFF-1');
    await s.app.inject({ method: 'PUT', url: `/api/v1/products/${off.id}`, payload: { active: false } });
    await mkSku(s, 'SVC-1', { kind: 'service' });
    const file = await xlsx([
      ['OK-1', 'fine', 5, 10],              // row 2 ok
      [null, 'no sku', 1, 1],               // row 3 MISSING_SKU
      ['NOPE', 'unknown', 1, 1],            // row 4 UNKNOWN_SKU
      ['OFF-1', 'inactive', 1, 1],          // row 5 INACTIVE_PRODUCT
      ['SVC-1', 'service', 1, 1],           // row 6 UNKNOWN_SKU (service)
      ['OK-1', 'again', 0, 1],              // row 7 duplicate of row 2 + BAD_QTY
      ['DUP-1', 'a', 1, 1], ['dup-1', 'b', 1, 1], // rows 8, 9 DUPLICATE_SKU_IN_FILE
      ['OK-1', 'x', 1, -1],                 // row 10 BAD_COST + duplicate
      ['OK-1', 'x', 1, 1.005],              // row 11 BAD_COST (3 decimals)
    ]);
    const r = await previewFile(s, file);
    expect(r.status).toBe(200);
    const codes = r.body.rows.map((x: any) => [x.rowNo, x.status, x.issues.map((i: any) => i.code)]);
    expect(codes).toEqual([
      [2, 'error', ['DUPLICATE_SKU_IN_FILE']], // OK-1 appears on rows 2, 7, 10, 11
      [3, 'error', ['MISSING_SKU']],
      [4, 'error', ['UNKNOWN_SKU']],
      [5, 'error', ['INACTIVE_PRODUCT']],
      [6, 'error', ['UNKNOWN_SKU']],
      [7, 'error', ['BAD_QTY', 'DUPLICATE_SKU_IN_FILE']],
      [8, 'error', ['DUPLICATE_SKU_IN_FILE']],
      [9, 'error', ['DUPLICATE_SKU_IN_FILE']],
      [10, 'error', ['BAD_COST', 'DUPLICATE_SKU_IN_FILE']],
      [11, 'error', ['BAD_COST', 'DUPLICATE_SKU_IN_FILE']],
    ]);
    expect(r.body.summary).toEqual({ total: 10, ok: 0, failed: 10, totalValueCents: 0 });
    const issues = rowsOf(s.ctx.database.conn, 'SELECT * FROM import_issues ORDER BY id');
    // Issues per row: rows 2-6 one each (5), row 7 two, rows 8-9 one each (2), rows 10-11 two each (4) = 13.
    expect(issues).toHaveLength(13);
    expect(issues.find((i) => i.code === 'UNKNOWN_SKU' && i.row_no === 4)).toMatchObject({ column_name: 'SKU', import_run_id: r.body.importRunId });
    expect(issues.find((i) => i.code === 'BAD_QTY')).toMatchObject({ row_no: 7, column_name: 'Quantity' });
    expect(count(s.ctx, 'stock_movements')).toBe(0);
  });
  it('a clean row next to bad rows stays ok (the status is per row)', async () => {
    const s = await setup();
    await mkSku(s, 'G-1');
    const r = await previewFile(s, await xlsx([['G-1', 'g', 2, 5], ['BAD', 'b', 1, 1]]));
    expect(r.body.rows.map((x: any) => x.status)).toEqual(['ok', 'error']);
    expect(r.body.summary).toEqual({ total: 2, ok: 1, failed: 1, totalValueCents: 1000 });
  });
  it('mismatched unit cost and total -> BAD_COST naming both amounts; both consistent -> ok', async () => {
    const s = await setup();
    await mkSku(s, 'M-1');
    await mkSku(s, 'M-2');
    const r = await previewFile(s, await xlsx([['M-1', 'm', 3, 33.33, 100], ['M-2', 'm', 4, 25, 100]]));
    expect(r.body.rows[0].issues[0].code).toBe('BAD_COST');
    expect(r.body.rows[0].issues[0].message).toContain('99.99');
    expect(r.body.rows[1]).toMatchObject({ status: 'ok', totalValueCents: 10000, unitCostCents: 2500 });
  });
  it('R-FD: a future business date marks every row FUTURE_DATE_NOT_ALLOWED (preview still answers 200)', async () => {
    const s = await setup();
    await mkSku(s, 'F-1');
    const r = await previewFile(s, await xlsx([['F-1', 'f', 1, 1]]), { date: daysAhead(1) });
    expect(r.status).toBe(200);
    expect(r.body.rows[0].status).toBe('error');
    expect(r.body.rows[0].issues).toEqual([{ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG }]);
    expect((await previewFile(s, await xlsx([['F-1', 'f', 1, 1]]), { date: daysAgo(2) })).body.rows[0].status).toBe('ok');
  });
  it('the date defaults to today; an unreal date -> 400 VALIDATION_ERROR', async () => {
    const s = await setup();
    await mkSku(s, 'D-1');
    const file = await xlsx([['D-1', 'd', 1, 1]]);
    expect((await previewFile(s, file, { date: null })).status).toBe(200);
    expect(rowsOf(s.ctx.database.conn, 'SELECT business_date FROM import_runs')[0]!.business_date).toBe(today());
    const bad = await previewFile(s, file, { date: '2026-02-30' });
    expect(bad.status).toBe(400);
    expect(err(bad).fields).toHaveProperty('businessDate');
  });
  it('file errors: wrong extension, not an xlsx, empty, oversize, missing file, not multipart', async () => {
    const s = await setup();
    const good = await xlsx([['A', 'a', 1, 1]]);
    const before = snap(s);
    let r = await previewFile(s, good, { name: 'stock.csv' });
    expect([r.status, err(r).code]).toEqual([400, 'INVALID_FILE_TYPE']);
    r = await previewFile(s, good, { name: 'stock.xls' });
    expect([r.status, err(r).code]).toEqual([400, 'INVALID_FILE_TYPE']);
    r = await previewFile(s, Buffer.from('sku,qty\nA,1\n'), { name: 'stock.xlsx' });
    expect([r.status, err(r).code]).toEqual([400, 'INVALID_FILE']);
    r = await previewFile(s, Buffer.alloc(0), { name: 'stock.xlsx' });
    expect([r.status, err(r).code]).toEqual([400, 'INVALID_FILE']);
    const big = Buffer.concat([good, Buffer.alloc(5 * 1024 * 1024)]); // just over 5 MB
    r = await previewFile(s, big);
    expect([r.status, err(r).code]).toEqual([413, 'FILE_TOO_LARGE']);
    r = await upload(s, 'preview', null, { businessDate: today() });
    expect([r.status, err(r).code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(r).fields).toHaveProperty('file');
    const json = await post(s.app, '/excel/opening-stock/preview', { a: 1 });
    expect(json.status).toBe(400);
    expect(snap(s)).toEqual(before); // none of these is recorded
  });
  it('a file of exactly 5 MB is accepted by the size check (then judged on its content)', async () => {
    const s = await setup();
    const good = await xlsx([['A', 'a', 1, 1]]);
    // Padding after the zip end-of-central-directory is ignored by readers that scan from the end; if the reader
    // rejects it, it must be as INVALID_FILE (content), never as FILE_TOO_LARGE (size).
    const edge = Buffer.concat([good, Buffer.alloc(5 * 1024 * 1024 - good.length)]);
    expect(edge.length).toBe(5 * 1024 * 1024);
    const r = await previewFile(s, edge);
    expect(r.status === 200 || err(r).code === 'INVALID_FILE').toBe(true);
  });
  it('missing sheet, missing headers and empty sheet are clear 422 errors', async () => {
    const s = await setup();
    let r = await previewFile(s, await xlsx([['A', 'a', 1, 1]], { sheet: 'Sheet1' }));
    expect([r.status, err(r).code]).toEqual([422, 'MISSING_SHEET']);
    r = await previewFile(s, await xlsx([['A', 1]], { headers: ['SKU', 'Quantity'] }));
    expect([r.status, err(r).code]).toEqual([422, 'MISSING_HEADERS']);
    expect(err(r).message).toContain('Unit cost (Rs)');
    r = await previewFile(s, await xlsx([]));
    expect([r.status, err(r).code]).toEqual([422, 'EMPTY_FILE']);
    expect(count(s.ctx, 'import_runs')).toBe(0);
  });
  it('flags alreadyCommitted once the same file has been imported', async () => {
    const s = await setup();
    await mkSku(s, 'AC-1');
    const file = await xlsx([['AC-1', 'a', 1, 100]]);
    expect((await previewFile(s, file)).body.alreadyCommitted).toBe(false);
    expect((await importFile(s, file)).status).toBe(201);
    expect((await previewFile(s, file)).body.alreadyCommitted).toBe(true);
  });
});

describe('POST /excel/opening-stock/import - success', () => {
  it('creates ONE excel batch with a movement per row, exact values, import run committed, audit, no cash', async () => {
    const s = await setup();
    const a = await mkSku(s, 'I-A');
    const b = await mkSku(s, 'I-B');
    const file = await xlsx([
      ['I-A', 'a', 10, 50, null, 'shelf 1'],
      ['i-b', 'b', 3, null, 100, null],
      [null, null, null, null, null, null], // a blank row is ignored
    ]);
    const clientRef = ref();
    const r = await importFile(s, file, { name: 'go-live.xlsx', date: daysAgo(2), clientRef });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['batch', 'importRunId', 'summary']);
    expect(r.body.summary).toEqual({ total: 2, ok: 2, failed: 0, totalValueCents: 60000 });
    expect(r.body.batch).toMatchObject({
      source: 'excel', fileName: 'go-live.xlsx', rowCount: 2, totalValueCents: 60000, status: 'posted', businessDate: daysAgo(2),
      backdated: true, clientRef,
    });
    expect(r.body.batch.items).toEqual([
      { productId: a.id, productCode: 'I-A', productName: a.name, qty: 10, valueCents: 50000, unitCostCents: 5000 },
      { productId: b.id, productCode: 'I-B', productName: b.name, qty: 3, valueCents: 10000, unitCostCents: 3333 },
    ]);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 50000 });
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 3, stockValueCents: 10000 }); // exact total, no rounding loss
    const moves = rowsOf(s.ctx.database.conn, 'SELECT * FROM stock_movements ORDER BY id');
    expect(moves.map((m) => [m.type, Number(m.qty_delta), Number(m.value_delta_cents), m.business_date, m.ref_table, Number(m.ref_id)]))
      .toEqual([['opening', 10, 50000, daysAgo(2), 'opening_stock_batches', r.body.batch.id], ['opening', 3, 10000, daysAgo(2), 'opening_stock_batches', r.body.batch.id]]);
    expect(moves[0]!.reason).toContain('shelf 1');
    expect(cashRows(s.ctx)).toEqual([]);
    expect(count(s.ctx, 'purchases')).toBe(0);
    expect(rowsOf(s.ctx.database.conn, 'SELECT * FROM import_runs')[0]).toMatchObject({
      id: r.body.importRunId, mode: 'commit', status: 'committed', rows_total: 2, rows_ok: 2, rows_failed: 0,
      batch_id: r.body.batch.id, file_sha256: sha(file), business_date: daysAgo(2),
    });
    const audit = rowsOf(s.ctx.database.conn, "SELECT * FROM audit_logs WHERE entity = 'opening_stock_batch'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'create', business_date: daysAgo(2), backdated: 1 });
    recon(s);
    expect((await get(s.app, `/opening-stock/${r.body.batch.id}`)).body.item.items).toHaveLength(2);
  });
  it('formula results and text numbers with commas are imported exactly', async () => {
    const s = await setup();
    const a = await mkSku(s, 'X-1');
    const r = await importFile(s, await xlsx([['X-1', 'x', { formula: '2*5', result: 10 }, '1,250.50', null]]));
    expect(r.status).toBe(201);
    expect(r.body.batch.totalValueCents).toBe(1250500 / 10 * 10); // 10 x Rs 1,250.50 = Rs 12,505.00 = 1,250,500 cents
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 10, stockValueCents: 1250500 });
  });
  it('adds to existing stock: purchase 10 @ Rs 70.00, then an import of 10 @ Rs 50.00 -> Rs 1,200.00 / 20 units (average Rs 60.00)', async () => {
    const s = await setup();
    const a = await mkSku(s, 'W-1');
    await buy(s, [{ productId: a.id, packs: 1, packSize: 10, lineTotalCents: 70000 }]);
    expect((await importFile(s, await xlsx([['W-1', 'w', 10, 50]]))).status).toBe(201);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 20, stockValueCents: 120000, avgUnitCostCents: 6000 });
    expect(cashRows(s.ctx).map((c) => Number(c.amount_cents))).toEqual([-70000]); // only the purchase moved cash
  });
  it('imports 50 good rows in one go (one batch, 50 movements)', async () => {
    const s = await setup();
    const rows: any[][] = [];
    let expected = 0;
    for (let i = 0; i < 50; i++) {
      await mkSku(s, `BULK-${i}`);
      rows.push([`BULK-${i}`, 'n', i + 1, 10 + i]);
      expected += (i + 1) * (10 + i) * 100;
    }
    const r = await importFile(s, await xlsx(rows));
    expect(r.status).toBe(201);
    expect(r.body.batch.rowCount).toBe(50);
    expect(r.body.batch.totalValueCents).toBe(expected);
    expect(count(s.ctx, 'opening_stock_batches')).toBe(1);
    expect(count(s.ctx, 'stock_movements')).toBe(50);
    recon(s);
  });
});

describe('POST /excel/opening-stock/import - all-or-nothing', () => {
  it('ONE bad row among 50 good ones: 422 IMPORT_HAS_ERRORS with the full row list, and NOTHING is saved to stock', async () => {
    const s = await setup();
    const rows: any[][] = [];
    for (let i = 0; i < 50; i++) {
      await mkSku(s, `AON-${i}`);
      rows.push([`AON-${i}`, 'n', 2, 10]);
    }
    rows.splice(25, 0, ['NOT-A-PRODUCT', 'bad', 1, 1]); // row 27 of the sheet
    const file = await xlsx(rows);
    const before = snap(s);
    const r = await importFile(s, file);
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('IMPORT_HAS_ERRORS');
    expect(err(r).rows).toHaveLength(51);
    expect(err(r).summary).toEqual({ total: 51, ok: 50, failed: 1, totalValueCents: 50 * 2000 });
    expect(err(r).fileSha256).toBe(sha(file));
    const bad = err(r).rows.filter((x: any) => x.status === 'error');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ rowNo: 27, sku: 'NOT-A-PRODUCT', issues: [{ code: 'UNKNOWN_SKU' }] });
    // Nothing saved to stock / cash / purchases / audit; only the append-only attempt record exists.
    const after = snap(s);
    expect(after).toEqual({ ...before, import_runs: before.import_runs! + 1, import_issues: before.import_issues! + 1 });
    expect(count(s.ctx, 'stock_movements')).toBe(0);
    expect(count(s.ctx, 'opening_stock_batches')).toBe(0);
    expect(count(s.ctx, 'audit_logs')).toBe(before.audit_logs);
    expect(await productOf(s, (await get(s.app, '/products?q=AON-0')).body.items[0].id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(rowsOf(s.ctx.database.conn, 'SELECT * FROM import_runs')[0]).toMatchObject({
      mode: 'commit', status: 'rejected', rows_total: 51, rows_ok: 50, rows_failed: 1, batch_id: null,
    });
    recon(s);
  });
  it('fixing the file and importing again works; the rejected attempt did not block it', async () => {
    const s = await setup();
    await mkSku(s, 'FIX-1');
    const bad = await xlsx([['FIX-1', 'a', 1, 1], ['FIX-2', 'b', 1, 1]]);
    expect((await importFile(s, bad)).status).toBe(422);
    expect((await importFile(s, bad)).status).toBe(422); // same file again: still refused for its content, not as "already committed"
    await mkSku(s, 'FIX-2');
    expect((await importFile(s, bad)).status).toBe(201); // the catalogue changed, so the very same bytes are now fine
    expect(count(s.ctx, 'opening_stock_batches')).toBe(1);
  });
  it('a duplicate SKU in the file rejects the whole file', async () => {
    const s = await setup();
    await mkSku(s, 'DD-1');
    await mkSku(s, 'DD-2');
    const r = await importFile(s, await xlsx([['DD-1', 'a', 1, 1], ['DD-2', 'b', 1, 1], ['dd-1', 'c', 1, 1]]));
    expect(r.status).toBe(422);
    expect(err(r).rows.filter((x: any) => x.issues.some((i: any) => i.code === 'DUPLICATE_SKU_IN_FILE')).map((x: any) => x.rowNo)).toEqual([2, 4]);
    expect(count(s.ctx, 'stock_movements')).toBe(0);
  });
  it('a stock-overflow in the middle (pool too large) rolls everything back (400, nothing saved)', async () => {
    const s = await setup();
    const a = await mkSku(s, 'OV-1');
    const b = await mkSku(s, 'OV-2');
    s.ctx.database.conn.prepare(
      "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'opening', 1, ?, 'test')",
    ).run(b.id, today(), Number.MAX_SAFE_INTEGER - 5);
    const before = snap(s);
    const r = await importFile(s, await xlsx([['OV-1', 'a', 1, 1], ['OV-2', 'b', 1, 999999999]]));
    expect(r.status).toBe(400);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
  });
  it('a failing audit write rolls the whole import back (batch, movements, run)', async () => {
    const s = await setup();
    await mkSku(s, 'AU-1');
    s.ctx.database.conn.exec("CREATE TRIGGER test_break_audit_i BEFORE INSERT ON audit_logs WHEN NEW.entity = 'opening_stock_batch' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const before = snap(s);
    const r = await importFile(s, await xlsx([['AU-1', 'a', 1, 1]]));
    expect(r.status).toBe(500);
    expect(snap(s)).toEqual(before);
  });
});

describe('POST /excel/opening-stock/import - same file, clientRef, date', () => {
  it('the same file bytes cannot be committed twice (409 IMPORT_ALREADY_COMMITTED) even with a new clientRef; nothing changes', async () => {
    const s = await setup();
    const a = await mkSku(s, 'SF-1');
    const file = await xlsx([['SF-1', 'a', 5, 100]]);
    const first = await importFile(s, file);
    expect(first.status).toBe(201);
    const before = snap(s);
    const again = await importFile(s, file, { clientRef: ref() });
    expect(again.status).toBe(409);
    expect(err(again)).toMatchObject({ code: 'IMPORT_ALREADY_COMMITTED', batchId: first.body.batch.id, importRunId: first.body.importRunId });
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 50000 });
    // A different file name with identical bytes is still the same file.
    expect((await importFile(s, file, { name: 'renamed.xlsx' })).status).toBe(409);
    // Other bytes (one more row) are a different file.
    expect((await importFile(s, await xlsx([['SF-1', 'a', 5, 100], ['SF-1', 'b', 1, 1]]))).status).toBe(422); // (duplicate sku) - judged on content, not blocked as "already committed"
  });
  it('after the first import is VOIDED the same file may be imported again', async () => {
    const s = await setup();
    const a = await mkSku(s, 'SV-1');
    const file = await xlsx([['SV-1', 'a', 5, 100]]);
    const first = await importFile(s, file);
    expect((await post(s.app, `/opening-stock/${first.body.batch.id}/void`, { reason: 'wrong date' })).status).toBe(200);
    const second = await importFile(s, file, { date: daysAgo(1) });
    expect(second.status).toBe(201);
    expect(second.body.batch.id).not.toBe(first.body.batch.id);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 50000 });
    expect((await importFile(s, file)).status).toBe(409); // and now the second import guards it again
    recon(s);
  });
  it('the same clientRef returns the saved batch (200, same importRunId) without writing anything', async () => {
    const s = await setup();
    const a = await mkSku(s, 'CR-1');
    const file = await xlsx([['CR-1', 'a', 5, 100]]);
    const clientRef = ref();
    const first = await importFile(s, file, { clientRef });
    const before = snap(s);
    const again = await importFile(s, file, { clientRef });
    expect(again.status).toBe(200);
    expect(again.body.batch).toEqual(first.body.batch);
    expect(again.body.importRunId).toBe(first.body.importRunId);
    expect(again.body.summary).toEqual(first.body.summary);
    // Even a different file / a now-future date with the same clientRef answers with the original (a retry).
    const other = await importFile(s, await xlsx([['CR-1', 'zzz', 1, 1]]), { clientRef, date: daysAhead(3) });
    expect(other.status).toBe(200);
    expect(other.body.batch.id).toBe(first.body.batch.id);
    expect(snap(s)).toEqual(before);
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 5 });
  });
  it('a clientRef already used by a manual batch -> 409 CLIENT_REF_CONFLICT', async () => {
    const s = await setup();
    const p = await mkSku(s, 'CC-1');
    const clientRef = ref();
    await openingOk(s, [unitLine(p.id, 1, 100)], { clientRef });
    const r = await importFile(s, await xlsx([['CC-1', 'a', 1, 1]]), { clientRef });
    expect([r.status, err(r).code]).toEqual([409, 'CLIENT_REF_CONFLICT']);
  });
  it('clientRef is required and must have the right shape', async () => {
    const s = await setup();
    const file = await xlsx([['A', 'a', 1, 1]]);
    for (const fields of [{ businessDate: today() } as Record<string, string>,{ businessDate: today(), clientRef: 'short' }, { businessDate: today(), clientRef: 'bad ref with spaces!' }]) {
      const r = await upload(s, 'import', { name: 'f.xlsx', content: file }, fields);
      expect(r.status).toBe(400);
      expect(err(r).fields).toHaveProperty('clientRef');
    }
  });
  it('R-FD: a future date -> 400 FUTURE_DATE_NOT_ALLOWED with the exact message, nothing recorded; today and the past are fine', async () => {
    const s = await setup();
    await mkSku(s, 'FD-1');
    const file = await xlsx([['FD-1', 'a', 1, 1]]);
    const before = snap(s);
    const r = await importFile(s, file, { date: daysAhead(1) });
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    expect(snap(s)).toEqual(before);
    expect((await importFile(s, file, { date: today() })).status).toBe(201);
  });
  it('the date defaults to today when the field is left out', async () => {
    const s = await setup();
    await mkSku(s, 'DT-1');
    const r = await importFile(s, await xlsx([['DT-1', 'a', 1, 1]]), { date: null });
    expect(r.status).toBe(201);
    expect(r.body.batch.businessDate).toBe(today());
  });
  it('file errors on import: wrong type, not an xlsx, missing headers, oversize -> clear errors, nothing saved', async () => {
    const s = await setup();
    const before = snap(s);
    expect((await importFile(s, await xlsx([['A', 'a', 1, 1]]), { name: 'a.csv' })).body.error.code).toBe('INVALID_FILE_TYPE');
    expect((await importFile(s, Buffer.from('hello'))).body.error.code).toBe('INVALID_FILE');
    expect((await importFile(s, await xlsx([['A', 1]], { headers: ['SKU', 'Quantity'] }))).body.error.code).toBe('MISSING_HEADERS');
    expect((await importFile(s, Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(413);
    expect(snap(s)).toEqual(before);
  });
});

describe('import audit trail is append-only through the API surface', () => {
  it('previews and imports accumulate runs; nothing is ever edited', async () => {
    const s = await setup();
    await mkSku(s, 'AT-1');
    const file = await xlsx([['AT-1', 'a', 1, 1]]);
    await previewFile(s, file);
    await previewFile(s, file);
    await importFile(s, file);
    const runs = rowsOf(s.ctx.database.conn, 'SELECT mode, status FROM import_runs ORDER BY id');
    expect(runs.map((r) => `${r.mode}/${r.status}`)).toEqual(['preview/previewed', 'preview/previewed', 'commit/committed']);
    expect(() => s.ctx.database.conn.exec("UPDATE import_runs SET status = 'rejected'")).toThrow(/append-only/);
  });
});
