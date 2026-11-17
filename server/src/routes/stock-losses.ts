/**
 * routes/stock-losses.ts - HTTP endpoints for stock losses (damaged / lost / expired / other).
 *
 * Layer: route (thin): JSON-schema validation -> `stock-losses.service.ts` -> response.
 * Business rules (R2/R3 removal at average cost, section 11; R-FD; R1 void by reversal) live in the service.
 *
 *   POST /stock-losses          create (201; 200 on a repeated `clientRef`)   GET /stock-losses   list
 *   GET  /stock-losses/:id      one loss                                      POST /stock-losses/:id/void   void
 * Items carry `source` ('manual' | 'damaged_return') and `salesReturnId`; voiding a damaged-return loss is
 * refused by the service (409 DAMAGED_RETURN_LOSS).
 */
import { STORED_SEGMENT_SCHEMA } from '../services/segments.ts';
import type { StoredSegment } from '../services/segments.ts';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { checkStockLossCorrection, correctStockLoss, optionalDate, previewStockLossCorrection } from '../services/correction-other.ts';
import type { CorrectionRequest } from '../services/correction-other.ts';
import { correctionBodySchema } from './corrections.ts';
import {
  createStockLoss, getStockLoss, listStockLosses, voidStockLoss,
} from '../services/stock-losses.service.ts';
import type { StockLossCreate } from '../services/stock-losses.service.ts';
import {
  bookQuery, checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const reasonEnum = { type: 'string', enum: ['damaged', 'lost', 'expired', 'other'] } as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'productId', 'qty', 'reason', 'clientRef'],
  properties: {
    businessDate: dateField,
    productId: { type: 'integer', minimum: 1 },
    qty: { type: 'integer', minimum: 1, maximum: 1000000000 },
    reason: reasonEnum,
    note: { type: 'string' },
    clientRef,
  },
} as const;

const correctionBody = correctionBodySchema(optionalDate(createBody));

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    productId: intQuery,
    book: bookQuery,
    segment: STORED_SEGMENT_SCHEMA,
    reason: reasonEnum,
    status: { type: 'string', enum: ['posted', 'void'] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

/** Registers the stock-loss endpoints under the `/api/v1` prefix. */
export function registerStockLossRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/stock-losses', { schema: { body: createBody } }, async (request, reply) => {
    const { item, created } = createStockLoss(ctx, request.body as StockLossCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/stock-losses', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; productId?: string; book?: 'shop' | 'telecom'; segment?: StoredSegment;
      reason?: 'damaged' | 'lost' | 'expired' | 'other'; status?: 'posted' | 'void'; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listStockLosses>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.productId !== undefined) q.productId = Number(raw.productId);
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.segment !== undefined) q.segment = raw.segment;
    if (raw.reason !== undefined) q.reason = raw.reason;
    if (raw.status !== undefined) q.status = raw.status;
    return listStockLosses(ctx, q);
  });

  app.get('/stock-losses/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getStockLoss(ctx, parseId(request.params)),
  }));

  app.post('/stock-losses/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidStockLoss(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  // corrections: void the original + enter the replacement, one transaction (a loss from a damaged return is refused 409 CORRECTION_NOT_SUPPORTED)
  app.get('/stock-losses/:id/correct-check', { schema: { params: idParamsSchema } }, async (request) =>
    checkStockLossCorrection(ctx, parseId(request.params)));

  app.post('/stock-losses/:id/correct-preview', { schema: { params: idParamsSchema, body: correctionBody } }, async (request) =>
    previewStockLossCorrection(ctx, parseId(request.params), request.body as CorrectionRequest<StockLossCreate>));

  app.post('/stock-losses/:id/correct', { schema: { params: idParamsSchema, body: correctionBody } }, async (request, reply) => {
    const { status, body } = correctStockLoss(ctx, parseId(request.params), request.body as CorrectionRequest<StockLossCreate>);
    return reply.code(status).send(body);
  });
}
