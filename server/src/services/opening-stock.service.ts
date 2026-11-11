/**
 * services/opening-stock.service.ts - go-live opening stock: manual batches, Excel preview/import, void.
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules implemented here:
 *  - Section 0 / 3: opening stock is an INFLOW through the inventory engine (`receiveStock`, type 'opening'): one
 *         movement per line adds the quantity and the EXACT value (the entered total, or quantity x unit cost) to the
 *         product's pool, and the database cache trigger keeps `qty_on_hand` / `stock_value_cents` in step. It creates
 *         NO cash entry, NO purchase and NO profit-and-loss effect, so it can never be used to hide a purchase's cash.
 *  - R1 / C6: a void never edits or deletes. The stock is removed by the engine's reversal path (`reverseMovements`,
 *         the exact negation of the original movements, same business date) and the batch is only marked `void`.
 *         It is refused with 409 OPENING_BATCH_IN_USE when some of that stock has already been sold or used.
 *  - R-FD: no future-dated batches (also enforced by the database trigger).
 *  - Section 12: `clientRef` makes a repeated submission return the saved batch instead of creating a second one;
 *         every write is audited with its business date and backdated flag, in the same transaction.
 *  - Excel import is ALL-OR-NOTHING: any row error rejects the whole file (422 IMPORT_HAS_ERRORS) and nothing is
 *         saved to stock; the same file (same SHA-256) cannot be committed twice (409 IMPORT_ALREADY_COMMITTED), and
 *         every preview/import attempt is recorded in the append-only `import_runs` / `import_issues` tables.
 * The Excel reading itself (exact money parsing, headers, row checks) is in `excel-opening-stock.ts`.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { isIsoDate, todayBusinessDate } from '../lib/dates.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import {
  findActiveCommittedRunBySha, getBatch, getBatchByClientRef, getCommittedRunForBatch, insertBatch, insertImportIssue,
  insertImportRun, listBatches, markBatchVoid,
} from '../repositories/opening-stock.repo.ts';
import type { BatchRow, BatchSource, BatchStatus } from '../repositories/opening-stock.repo.ts';
import { findProductByCode, getProduct, listProducts } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import { logAudit } from './audit.service.ts';
import {
  MAX_FILE_BYTES, MAX_LINE_VALUE_CENTS, buildTemplate, parseOpeningWorkbook, validateRows,
} from './excel-opening-stock.ts';
import type { PreviewRow, ProductRef } from './excel-opening-stock.ts';
import { getPool, receiveStock, reverseMovements } from './inventory.service.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** The ledger table name the batch's stock movements point at (`ref_table`). */
const REF_TABLE = 'opening_stock_batches';

/** One line of a batch as the API returns it; `unitCostCents` is the rounded value / qty (display only). */
export interface OpeningLine {
  productId: number; productCode: string | null; productName: string; qty: number; valueCents: number;
  unitCostCents: number;
}

/** A batch header as the API returns it. */
export interface OpeningBatch {
  id: number; businessDate: string; postedAt: string; backdated: boolean; source: BatchSource;
  fileName: string | null; rowCount: number; totalValueCents: number; status: BatchStatus; notes: string;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}

/** A batch with its lines. */
export interface OpeningBatchDetail extends OpeningBatch { items: OpeningLine[] }

// ---------- DTO assembly ----------

function toBatch(b: BatchRow): OpeningBatch {
  return {
    id: b.id, businessDate: b.businessDate, postedAt: b.postedAt, backdated: isBackdated(b.businessDate, b.postedAt),
    source: b.source, fileName: b.fileName, rowCount: b.rowCount, totalValueCents: b.totalValueCents,
    status: b.status, notes: b.notes, voidedAt: b.voidedAt, voidReason: b.voidReason, clientRef: b.clientRef,
  };
}

/**
 * The lines of a batch: its original (positive) `opening` movements. A void adds negative reversal movements with
 * the same reference, which are not lines, so a voided batch still shows what it contained.
 */
function loadLines(conn: DatabaseSync, batchId: number): Array<OpeningLine & { movementId: number }> {
  return listMovementsByRef(conn, REF_TABLE, batchId)
    .filter((m) => m.qtyDelta > 0)
    .map((m) => {
      const p = getProduct(conn, m.productId);
      return {
        movementId: m.id, productId: m.productId, productCode: p?.code ?? null, productName: p?.name ?? `#${m.productId}`,
        qty: m.qtyDelta, valueCents: m.valueDeltaCents, unitCostCents: mulDivRound(m.valueDeltaCents, 1, m.qtyDelta),
      };
    });
}

function toDetail(conn: DatabaseSync, b: BatchRow): OpeningBatchDetail {
  const items = loadLines(conn, b.id).map(({ movementId: _movementId, ...line }) => line);
  return { ...toBatch(b), items };
}

function loadDetail(conn: DatabaseSync, id: number): OpeningBatchDetail {
  const b = getBatch(conn, id);
  if (!b) throw notFound('Opening stock batch');
  return toDetail(conn, b);
}

// ---------- reads ----------

/** One batch with its lines. @throws AppError 404 NOT_FOUND. */
export function getOpeningBatch(ctx: AppContext, id: number): OpeningBatchDetail {
  return loadDetail(ctx.database.conn, id);
}

/** Lists batches (newest first); `totals` sums the POSTED batches that match the filters. */
export function listOpeningBatches(ctx: AppContext, q: {
  from?: string; to?: string; status?: BatchStatus; limit: number; offset: number;
}): { items: OpeningBatch[]; total: number; totals: { valueCents: number; lines: number } } {
  const r = listBatches(ctx.database.conn, q);
  return { items: r.items.map(toBatch), total: r.total, totals: { valueCents: r.totalValueCents, lines: r.lineCount } };
}

// ---------- posting a batch (shared by manual entry and Excel import) ----------

/** One line to post: the quantity and the exact value of the whole line. */
interface LineInput { productId: number; qty: number; valueCents: number; note?: string }

/**
 * Writes the batch header and one `opening` movement per line through the inventory engine, then audits it.
 * Must run inside the caller's transaction. Header first (the movements refer to its id).
 */
function postBatch(conn: DatabaseSync, p: {
  businessDate: string; source: BatchSource; fileName: string | null; notes: string; clientRef: string;
  lines: LineInput[];
}): OpeningBatchDetail {
  const totalValueCents = p.lines.reduce((sum, l) => sum + l.valueCents, 0);
  if (!Number.isSafeInteger(totalValueCents)) throw validationError({ items: 'The batch total is too large.' });
  const batchId = insertBatch(conn, {
    businessDate: p.businessDate, source: p.source, fileName: p.fileName, rowCount: p.lines.length, totalValueCents,
    notes: p.notes, clientRef: p.clientRef,
  });
  for (const l of p.lines) {
    receiveStock(conn, {
      productId: l.productId, businessDate: p.businessDate, type: 'opening', qty: l.qty, valueCents: l.valueCents,
      refTable: REF_TABLE, refId: batchId,
      reason: l.note ? `Opening stock #${batchId}: ${l.note}` : `Opening stock #${batchId}`,
    });
  }
  const item = loadDetail(conn, batchId);
  logAudit(conn, 'opening_stock_batch', String(batchId), 'create', null, item, undefined,
    { businessDate: item.businessDate, backdated: item.backdated });
  return item;
}

// ---------- manual entry ----------

export interface OpeningStockCreate {
  businessDate: string;
  items: Array<{ productId: number; qty: number; unitCostCents?: number; totalValueCents?: number }>;
  notes?: string; clientRef: string;
}

/**
 * Records a manual opening stock batch: one header and one `opening` movement per product line (section 3).
 * Line value = the exact `totalValueCents` entered, or `qty x unitCostCents` (exactly one of the two per line).
 * Idempotent by `clientRef`: a repeat returns the saved batch with `created: false` and writes nothing.
 *
 * @throws AppError 400 VALIDATION_ERROR (fields; both/neither of unit cost and total), 400 FUTURE_DATE_NOT_ALLOWED
 *   (R-FD), 422 INVALID_PRODUCT (unknown, inactive or service product; `fields["items.N.productId"]`),
 *   422 DUPLICATE_PRODUCT (a product on two lines).
 */
export function createOpeningStock(ctx: AppContext, body: OpeningStockCreate): { item: OpeningBatchDetail; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  // Exactly one of unit cost / total per line; compute the exact line value (no floating point).
  const values = body.items.map((line, i) => {
    const hasUnit = line.unitCostCents !== undefined;
    const hasTotal = line.totalValueCents !== undefined;
    if (hasUnit === hasTotal) {
      fields[`items.${i}.unitCostCents`] = 'Enter either a unit cost or a total value (not both, not neither).';
      return 0;
    }
    if (hasTotal) return line.totalValueCents as number;
    const v = BigInt(line.qty) * BigInt(line.unitCostCents as number);
    if (v > BigInt(MAX_LINE_VALUE_CENTS)) {
      fields[`items.${i}.unitCostCents`] = 'Quantity x unit cost is too large.';
      return 0;
    }
    return Number(v);
  });
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // real date, then R-FD

  return runWrite(ctx, (conn) => {
    // Idempotency first: a retry must succeed even if the data has changed since.
    const existing = getBatchByClientRef(conn, body.clientRef);
    if (existing) return { item: toDetail(conn, existing), created: false };

    const bad: Fields = {};
    body.items.forEach((line, i) => {
      const p = getProduct(conn, line.productId);
      if (!p) bad[`items.${i}.productId`] = 'Product not found.';
      else if (p.kind !== 'stock') bad[`items.${i}.productId`] = 'Only stock products can have opening stock.';
      else if (!p.active) bad[`items.${i}.productId`] = 'This product is inactive.';
    });
    if (Object.keys(bad).length > 0) {
      throw new AppError(422, 'INVALID_PRODUCT', 'Only active stock products can have opening stock.', bad);
    }
    const seen = new Set<number>();
    const dup: Fields = {};
    body.items.forEach((line, i) => {
      if (seen.has(line.productId)) dup[`items.${i}.productId`] = 'This product is already on another line. Use one line per product.';
      seen.add(line.productId);
    });
    if (Object.keys(dup).length > 0) {
      throw new AppError(422, 'DUPLICATE_PRODUCT', 'A product can appear only once in a batch.', dup);
    }
    const item = postBatch(conn, {
      businessDate: body.businessDate, source: 'manual', fileName: null, notes, clientRef: body.clientRef,
      lines: body.items.map((l, i) => ({ productId: l.productId, qty: l.qty, valueCents: values[i] as number })),
    });
    return { item, created: true };
  });
}

// ---------- void ----------

/**
 * Voids a whole batch (R1, C6): removes the opening units from the pools with the engine's reversal (the exact
 * negation of the original movements, dated as the batch) and marks the batch `void`. Nothing is edited or deleted.
 *
 * Refused with 409 OPENING_BATCH_IN_USE when any product no longer has the batch quantity on hand (it was sold or
 * used since), or when taking the batch back out would leave a negative or orphaned value; the user is told which
 * products are short. No cash is involved: opening stock never created any.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID / OPENING_BATCH_IN_USE.
 */
export function voidOpeningBatch(ctx: AppContext, id: number, body: { reason: string }): OpeningBatchDetail {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const header = getBatch(conn, id);
    if (!header) throw notFound('Opening stock batch');
    if (header.status === 'void') throw alreadyVoid('opening stock batch');
    const before = toDetail(conn, header);
    const lines = loadLines(conn, id);

    // Quantity check first, so the message can name the short products.
    const short: Fields = {};
    const shortLines: Array<{ productId: number; onHand: number; qty: number }> = [];
    lines.forEach((l, i) => {
      const onHand = getPool(conn, l.productId).qty;
      if (onHand < l.qty) {
        short[`items.${i}`] = `${l.productName}: only ${onHand} of ${l.qty} units are still on hand.`;
        shortLines.push({ productId: l.productId, onHand, qty: l.qty });
      }
    });
    if (shortLines.length > 0) throw inUse(short, shortLines);

    try {
      reverseMovements(conn, lines.map((l) => l.movementId), `Void of opening stock #${id}`);
    } catch (err) {
      // The quantity is there but the value does not fit (e.g. the average changed): same refusal, same advice.
      if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') throw inUse({}, []);
      throw err;
    }
    markBatchVoid(conn, id, reason);
    const after = loadDetail(conn, id);
    logAudit(conn, 'opening_stock_batch', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}

/** 409 OPENING_BATCH_IN_USE with the short products listed. */
function inUse(fields: Fields, lines: Array<{ productId: number; onHand: number; qty: number }>): AppError {
  return new AppError(409, 'OPENING_BATCH_IN_USE',
    'Some of this opening stock has already been sold or used, so it cannot be voided. Record a stocktake to correct the quantity instead.',
    Object.keys(fields).length > 0 ? fields : undefined, { lines });
}

// ---------- Excel template ----------

/**
 * The Excel template with a "Products" reference sheet of every active stock product (SKU, name, category, book).
 * @returns the .xlsx bytes
 */
export async function openingStockTemplate(ctx: AppContext): Promise<Buffer> {
  const products = listProducts(ctx.database.conn, { active: true, limit: Number.MAX_SAFE_INTEGER, offset: 0 }).items
    .filter((p) => p.kind === 'stock')
    .map((p) => ({ sku: p.code, name: p.name, categoryName: p.categoryName, book: p.book }));
  return buildTemplate(products);
}

// ---------- Excel preview / import ----------

/** An uploaded Excel file: its name and bytes (the route has already enforced the size limit). */
export interface UploadedFile { fileName: string; buffer: Buffer }

/** Counts shown above the preview table. `totalValueCents` sums the rows that are ok. */
export interface ImportSummary { total: number; ok: number; failed: number; totalValueCents: number }

/** Result of a preview. */
export interface PreviewResult {
  importRunId: number; rows: Array<Omit<PreviewRow, 'issueColumns' | 'notes'>>; summary: ImportSummary;
  fileSha256: string;
  /** True when this exact file was already imported (and not voided): the import would be refused (409). */
  alreadyCommitted: boolean;
}

/** SHA-256 of the file bytes, as lowercase hex (identifies "the same file" for the duplicate guard). */
function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Basic file checks shared by preview and import: a name ending in .xlsx and at most 5 MB. */
function checkUpload(file: UploadedFile): void {
  if (!/\.xlsx$/i.test(file.fileName)) {
    throw new AppError(400, 'INVALID_FILE_TYPE', 'Only Excel .xlsx files can be imported. Please use the template.',
      { file: 'Choose an .xlsx file.' });
  }
  if (file.buffer.length === 0) {
    throw new AppError(400, 'INVALID_FILE', 'The file is empty.', { file: 'The file is empty.' });
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'The file is too large (limit is 5 MB).');
  }
}

/** Reads a date field: missing -> today; otherwise it must be a real YYYY-MM-DD date. */
function importDate(date: string | undefined): string {
  const d = date ?? todayBusinessDate();
  if (!isIsoDate(d)) throw validationError({ businessDate: 'Enter a valid date (YYYY-MM-DD).' });
  return d;
}

/** Product lookup by SKU for the validator. */
function skuLookup(conn: DatabaseSync): (sku: string) => ProductRef | undefined {
  return (sku) => {
    const p = findProductByCode(conn, sku);
    return p ? { id: p.id, name: p.name, active: p.active, kind: p.kind } : undefined;
  };
}

function summarize(rows: PreviewRow[]): ImportSummary {
  const ok = rows.filter((r) => r.status === 'ok');
  return {
    total: rows.length, ok: ok.length, failed: rows.length - ok.length,
    totalValueCents: ok.reduce((sum, r) => sum + (r.totalValueCents ?? 0), 0),
  };
}

/** The API shape of a preview row (the stored column names and the notes stay internal). */
function publicRow({ issueColumns: _c, notes: _n, ...row }: PreviewRow): PreviewResult['rows'][number] {
  return row;
}

/** Appends the issues of every row to the audit of the run. */
function recordIssues(conn: DatabaseSync, runId: number, rows: PreviewRow[]): void {
  for (const r of rows) {
    r.issues.forEach((issue, i) => insertImportIssue(conn, {
      importRunId: runId, rowNo: r.rowNo, columnName: r.issueColumns[i] ?? '', code: issue.code, message: issue.message,
    }));
  }
}

/**
 * Preview of an Excel import: parses the file exactly and checks every row, but writes NOTHING to stock. The
 * attempt itself is recorded (an `import_runs` row with status 'previewed' plus one `import_issues` row per problem).
 * A future business date marks every row FUTURE_DATE_NOT_ALLOWED (R-FD) instead of failing the preview.
 *
 * @throws AppError 400 INVALID_FILE_TYPE / INVALID_FILE / VALIDATION_ERROR (date), 413 FILE_TOO_LARGE,
 *   422 MISSING_SHEET / MISSING_HEADERS / EMPTY_FILE / TOO_MANY_ROWS.
 */
export async function previewOpeningImport(
  ctx: AppContext, file: UploadedFile, businessDate: string | undefined,
): Promise<PreviewResult> {
  checkUpload(file);
  const date = importDate(businessDate);
  const parsed = await parseOpeningWorkbook(file.buffer); // may take a moment; the database work below is synchronous
  const sha = sha256Of(file.buffer);
  return runWrite(ctx, (conn) => {
    const rows = validateRows(parsed, skuLookup(conn), date > todayBusinessDate());
    const summary = summarize(rows);
    const runId = insertImportRun(conn, {
      fileName: file.fileName, fileSha256: sha, businessDate: date, mode: 'preview', status: 'previewed',
      rowsTotal: summary.total, rowsOk: summary.ok, rowsFailed: summary.failed, batchId: null,
    });
    recordIssues(conn, runId, rows);
    return {
      importRunId: runId, rows: rows.map(publicRow), summary, fileSha256: sha,
      alreadyCommitted: findActiveCommittedRunBySha(conn, sha) !== undefined,
    };
  });
}

/** What a successful (or repeated) import returns. */
export interface ImportResult {
  item: OpeningBatchDetail; importRunId: number; summary: ImportSummary; created: boolean;
}

/** The result for a clientRef that was already imported (idempotent retry); nothing is written. */
function repeatedImport(conn: DatabaseSync, existing: BatchRow): ImportResult {
  if (existing.source !== 'excel') {
    throw new AppError(409, 'CLIENT_REF_CONFLICT', 'This clientRef was already used for a different record.');
  }
  const run = getCommittedRunForBatch(conn, existing.id);
  return {
    item: toDetail(conn, existing), importRunId: run ? run.id : 0, created: false,
    summary: { total: existing.rowCount, ok: existing.rowCount, failed: 0, totalValueCents: existing.totalValueCents },
  };
}

/**
 * Imports an Excel file as ONE opening stock batch, all-or-nothing:
 *  - any row error -> nothing is saved to stock, the attempt is recorded as 'rejected', and the answer is
 *    422 IMPORT_HAS_ERRORS carrying the row list (so the screen can show what to fix);
 *  - otherwise the batch, its movements, the audit and the 'committed' run are saved in one transaction.
 * Idempotent by `clientRef` (a repeat returns the saved batch). The same file bytes cannot be committed twice while
 * the first import is still active (409 IMPORT_ALREADY_COMMITTED); after a void the corrected file may be imported.
 *
 * @throws AppError 400 INVALID_FILE_TYPE / INVALID_FILE / VALIDATION_ERROR / FUTURE_DATE_NOT_ALLOWED (R-FD),
 *   409 IMPORT_ALREADY_COMMITTED / CLIENT_REF_CONFLICT, 413 FILE_TOO_LARGE, 422 IMPORT_HAS_ERRORS /
 *   MISSING_SHEET / MISSING_HEADERS / EMPTY_FILE / TOO_MANY_ROWS.
 */
export async function importOpeningStock(
  ctx: AppContext, file: UploadedFile, businessDate: string | undefined, clientRef: string,
): Promise<ImportResult> {
  checkUpload(file);
  const date = importDate(businessDate);
  // A retry of an import that already succeeded must succeed again (even if the date has since become "the past").
  const first = getBatchByClientRef(ctx.database.conn, clientRef);
  if (first) return repeatedImport(ctx.database.conn, first);
  checkBusinessDate(date); // R-FD
  const sha = sha256Of(file.buffer);
  assertNotCommitted(ctx.database.conn, sha);

  const parsed = await parseOpeningWorkbook(file.buffer);
  const outcome = runWrite(ctx, (conn): { rejected: PreviewResult } | { done: ImportResult } => {
    // Everything is re-checked inside the transaction: the parse above was asynchronous.
    const again = getBatchByClientRef(conn, clientRef);
    if (again) return { done: repeatedImport(conn, again) };
    assertNotCommitted(conn, sha);
    const rows = validateRows(parsed, skuLookup(conn), false);
    const summary = summarize(rows);
    if (summary.failed > 0) {
      const runId = insertImportRun(conn, {
        fileName: file.fileName, fileSha256: sha, businessDate: date, mode: 'commit', status: 'rejected',
        rowsTotal: summary.total, rowsOk: summary.ok, rowsFailed: summary.failed, batchId: null,
      });
      recordIssues(conn, runId, rows);
      return { rejected: { importRunId: runId, rows: rows.map(publicRow), summary, fileSha256: sha, alreadyCommitted: false } };
    }
    const item = postBatch(conn, {
      businessDate: date, source: 'excel', fileName: file.fileName, notes: '', clientRef,
      lines: rows.map((r) => ({
        productId: r.productId as number, qty: r.qty as number, valueCents: r.totalValueCents as number, note: r.notes,
      })),
    });
    const runId = insertImportRun(conn, {
      fileName: file.fileName, fileSha256: sha, businessDate: date, mode: 'commit', status: 'committed',
      rowsTotal: summary.total, rowsOk: summary.ok, rowsFailed: 0, batchId: item.id,
    });
    return { done: { item, importRunId: runId, summary, created: true } };
  });
  if ('rejected' in outcome) {
    const r = outcome.rejected;
    throw new AppError(422, 'IMPORT_HAS_ERRORS',
      `${r.summary.failed} row(s) have problems. Nothing was imported. Fix the file and try again.`, undefined,
      { importRunId: r.importRunId, rows: r.rows, summary: r.summary, fileSha256: r.fileSha256 });
  }
  return outcome.done;
}

/** 409 IMPORT_ALREADY_COMMITTED when this exact file is already imported and its batch is still posted. */
function assertNotCommitted(conn: DatabaseSync, sha: string): void {
  const run = findActiveCommittedRunBySha(conn, sha);
  if (run) {
    throw new AppError(409, 'IMPORT_ALREADY_COMMITTED',
      'This exact file has already been imported. To import it again, void the earlier opening stock batch first.',
      undefined, { batchId: run.batchId, importRunId: run.id });
  }
}
