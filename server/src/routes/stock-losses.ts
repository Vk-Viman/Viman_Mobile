import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createStockLoss, getStockLoss, listStockLosses, voidStockLoss,
} from '../services/stock-losses.service.ts';
import type { StockLossCreate } from '../services/stock-losses.service.ts';
import { bookQuery, fail, idParamsSchema, intQuery, parseId } from './catalog-query.ts';
import { checkQueryDates, dateQuery } from './purchases.ts';

const clientRef = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' } as const;
const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
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

const voidBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    productId: intQuery,
    book: bookQuery,
    reason: reasonEnum,
    status: { type: 'string', enum: ['posted', 'void'] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

export function registerStockLossRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/stock-losses', { schema: { body: createBody } }, async (request, reply) => {
    const { item, created } = createStockLoss(ctx, request.body as StockLossCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/stock-losses', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; productId?: string; book?: 'shop' | 'telecom';
      reason?: 'damaged' | 'lost' | 'expired' | 'other'; status?: 'posted' | 'void'; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    const offset = raw.offset === undefined ? 0 : Number(raw.offset);
    if (limit < 1 || limit > 200) fail({ limit: 'must be between 1 and 200' });
    const q: Parameters<typeof listStockLosses>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.productId !== undefined) q.productId = Number(raw.productId);
    if (raw.book !== undefined) q.book = raw.book;
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
}
