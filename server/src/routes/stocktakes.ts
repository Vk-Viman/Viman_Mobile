/**
 * routes/stocktakes.ts - HTTP endpoints for physical stock counts.
 *
 * Layer: route (thin): JSON-schema validation -> `stocktake.service.ts` -> response. The life cycle
 * (draft -> completed -> void), the weighted-average gain/loss postings (section 3, C10) and R-FD live in the
 * service.
 *
 *   POST /stocktakes              create a draft (201; 200 on a repeated `clientRef`)
 *   PUT  /stocktakes/:id          edit a draft's lines / notes       GET /stocktakes, /stocktakes/:id   read
 *   POST /stocktakes/:id/complete post the differences as stock movements
 *   POST /stocktakes/:id/void     void (reverses the movements)
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  completeStocktake, createStocktake, getStocktake, listStocktakes, updateStocktake, voidStocktake,
} from '../services/stocktake.service.ts';
import type { StocktakeCreate, StocktakeItemInput } from '../services/stocktake.service.ts';
import {
  bookQuery, checkQueryDates, clientRef, dateField, dateQuery, fail, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const itemsSchema = {
  type: 'array',
  maxItems: 500,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['productId', 'countedQty'],
    properties: {
      productId: { type: 'integer', minimum: 1 },
      countedQty: { type: 'integer', minimum: 0, maximum: 1000000000 },
      gainUnitCostCents: { type: 'integer', minimum: 0, maximum: 99999999999 },
    },
  },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'book', 'clientRef'],
  properties: {
    businessDate: dateField,
    book: bookQuery,
    notes: { type: 'string' },
    items: itemsSchema,
    clientRef,
  },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: { notes: { type: 'string' }, items: itemsSchema },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    book: bookQuery,
    status: { type: 'string', enum: ['draft', 'completed', 'void'] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

/** True for `undefined`, `null` or an empty object `{}` - the only bodies `complete` accepts. */
function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
}

/** Registers the stocktake endpoints under the `/api/v1` prefix. */
export function registerStocktakeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/stocktakes', { schema: { body: createBody } }, async (request, reply) => {
    const { item, created } = createStocktake(ctx, request.body as StocktakeCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.put('/stocktakes/:id', { schema: { params: idParamsSchema, body: updateBody } }, async (request) => ({
    item: updateStocktake(ctx, parseId(request.params), request.body as { notes?: string; items?: StocktakeItemInput[] }),
  }));

  app.get('/stocktakes', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; book?: 'shop' | 'telecom'; status?: 'draft' | 'completed' | 'void';
      limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listStocktakes>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.status !== undefined) q.status = raw.status;
    return listStocktakes(ctx, q);
  });

  app.get('/stocktakes/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getStocktake(ctx, parseId(request.params)),
  }));

  app.post('/stocktakes/:id/complete', { schema: { params: idParamsSchema } }, async (request) => {
    // The body is `{}` or absent (no body schema: an absent body must be accepted); anything else is rejected.
    if (!isEmptyBody(request.body)) fail({ body: 'must be an empty object' });
    return { item: completeStocktake(ctx, parseId(request.params)) };
  });

  app.post('/stocktakes/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidStocktake(ctx, parseId(request.params), request.body as { reason: string }),
  }));
}
