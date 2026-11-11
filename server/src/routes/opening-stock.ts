/**
 * routes/opening-stock.ts - HTTP endpoints for opening stock and the Excel import.
 *
 * Layer: route (thin). Validates the request shape (JSON schema for JSON bodies, a small multipart reader for
 * uploads), calls `opening-stock.service.ts`, shapes the response. All business rules (exact value, R-FD, void
 * guard, all-or-nothing import, duplicate-file guard) are in the service.
 *
 *   POST /opening-stock                  create a manual batch (201; 200 when `clientRef` was already used)
 *   GET  /opening-stock                  list batches            GET /opening-stock/:id   one batch with its lines
 *   POST /opening-stock/:id/void         void (R1)
 *   GET  /excel/opening-stock-template   download the .xlsx template
 *   POST /excel/opening-stock/preview    upload (multipart: file, businessDate?) -> per-row check, nothing saved
 *   POST /excel/opening-stock/import     upload (multipart: file, businessDate?, clientRef) -> one batch, all-or-nothing
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import {
  MAX_FILE_BYTES, MAX_LINE_VALUE_CENTS, MAX_QTY,
} from '../services/excel-opening-stock.ts';
import {
  createOpeningStock, getOpeningBatch, importOpeningStock, listOpeningBatches, openingStockTemplate,
  previewOpeningImport, voidOpeningBatch,
} from '../services/opening-stock.service.ts';
import type { OpeningStockCreate, UploadedFile } from '../services/opening-stock.service.ts';
import { validationError } from '../services/validation.ts';
import {
  CLIENT_REF_PATTERN, checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    status: { type: 'string', enum: ['posted', 'void'] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

// The numeric maximums keep every later sum (line value, batch total, pool value) inside the safe-integer range.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'items', 'clientRef'],
  properties: {
    businessDate: dateField,
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['productId', 'qty'],
        properties: {
          productId: { type: 'integer', minimum: 1 },
          qty: { type: 'integer', minimum: 1, maximum: MAX_QTY },
          unitCostCents: { type: 'integer', minimum: 0, maximum: MAX_LINE_VALUE_CENTS },
          totalValueCents: { type: 'integer', minimum: 0, maximum: MAX_LINE_VALUE_CENTS },
        },
      },
    },
    notes: { type: 'string' },
    clientRef,
  },
} as const;

/** What the multipart reader found: the file (if any) and the text fields. */
interface Upload { file: UploadedFile | undefined; fields: Record<string, string> }

/**
 * Reads the multipart form of an Excel upload: the file part named "file" (at most 5 MB, counted while reading so
 * a huge upload is never held in memory) and the text fields `businessDate` and `clientRef`.
 *
 * @throws AppError 400 VALIDATION_ERROR (not multipart / no file), 413 FILE_TOO_LARGE (over 5 MB).
 */
async function readUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) {
    throw validationError({ file: 'Send the Excel file as a multipart form upload.' });
  }
  const fields: Record<string, string> = {};
  let file: UploadedFile | undefined;
  let tooLarge = false;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file' || file !== undefined || tooLarge) {
        part.file.resume(); // not the one we want: drain and ignore
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      // Keep reading to the end (so the request completes cleanly) but stop storing once the limit is passed.
      for await (const chunk of part.file) {
        size += (chunk as Buffer).length;
        if (size > MAX_FILE_BYTES) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(chunk as Buffer);
      }
      if (!tooLarge) file = { fileName: part.filename, buffer: Buffer.concat(chunks) };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  if (tooLarge) throw new AppError(413, 'FILE_TOO_LARGE', 'The file is too large (limit is 5 MB).');
  return { file, fields };
}

/** The date field of an upload: absent/blank -> undefined (the service defaults it to today). */
function dateOf(fields: Record<string, string>): string | undefined {
  const v = fields.businessDate?.trim();
  return v === undefined || v === '' ? undefined : v;
}

/** The uploaded file, or 400 VALIDATION_ERROR when none was sent. */
function requireFile(u: Upload): UploadedFile {
  if (!u.file) throw validationError({ file: 'Please choose an Excel file.' });
  return u.file;
}

/** Registers the opening stock and Excel import endpoints under the `/api/v1` prefix. */
export function registerOpeningStockRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/opening-stock', { schema: { body: createBody } }, async (request, reply) => {
    const { item, created } = createOpeningStock(ctx, request.body as OpeningStockCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/opening-stock', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; status?: 'posted' | 'void'; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listOpeningBatches>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listOpeningBatches(ctx, q);
  });

  app.get('/opening-stock/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getOpeningBatch(ctx, parseId(request.params)),
  }));

  app.post('/opening-stock/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidOpeningBatch(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  app.get('/excel/opening-stock-template', async (_request, reply) => {
    const buffer = await openingStockTemplate(ctx);
    return reply
      .header('content-type', XLSX_TYPE)
      .header('content-disposition', 'attachment; filename="opening-stock-template.xlsx"')
      .send(buffer);
  });

  app.post('/excel/opening-stock/preview', async (request) => {
    const upload = await readUpload(request);
    return previewOpeningImport(ctx, requireFile(upload), dateOf(upload.fields));
  });

  app.post('/excel/opening-stock/import', async (request, reply) => {
    const upload = await readUpload(request);
    const ref = upload.fields.clientRef?.trim();
    if (ref === undefined || !new RegExp(CLIENT_REF_PATTERN).test(ref)) {
      throw validationError({ clientRef: 'A client reference (8-64 letters, digits, _ or -) is required.' });
    }
    const r = await importOpeningStock(ctx, requireFile(upload), dateOf(upload.fields), ref);
    return reply.code(r.created ? 201 : 200).send({ batch: r.item, importRunId: r.importRunId, summary: r.summary });
  });
}
