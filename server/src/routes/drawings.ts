/**
 * routes/drawings.ts - HTTP endpoints for owner drawings (the owner taking goods for personal use).
 *
 * Layer: route (thin): JSON-schema validation -> `drawings.service.ts` -> response.
 * Business rules (section 9: goods removed at cost / cash out of a book, no P&L; 10.2 funds; R9, R13; R-FD; R1 void by
 * reversal) live in the service.
 *
 *   POST /drawings            create goods or cash (201 { item, warnings }; 200 on a repeated `clientRef`)
 *   GET  /drawings            list (both kinds; totals incl. goodsCents / cashCents)
 *   GET  /drawings/:id        one drawing                                     POST /drawings/:id/void   void
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { createDrawing, getDrawing, listDrawings, voidDrawing } from '../services/drawings.service.ts';
import type { DrawingCreate } from '../services/drawings.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Largest amount (cents) one cash drawing may carry; the same bound is a CHECK in migration 013. */
const MAX_CENTS = 1_000_000_000_000;

const kindEnum = { type: 'string', enum: ['goods', 'cash'] } as const;
const bookEnum = { type: 'string', enum: ['shop', 'telecom', 'icecream'] } as const;
const fundEnum = { type: 'string', enum: ['cost', 'electricity', 'profit'] } as const;

// The fields each kind needs (goods: productId + qty; cash: book + amountCents, fund iff icecream) are checked by the
// service, so every kind-specific field is optional in the schema and a missing one is named in `fields`.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'businessDate', 'clientRef'],
  properties: {
    kind: kindEnum,
    businessDate: dateField,
    productId: { type: 'integer', minimum: 1 },
    qty: { type: 'integer', minimum: 1, maximum: 1000000000 },
    book: bookEnum,
    fund: fundEnum,
    amountCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS },
    note: { type: 'string' },
    clientRef,
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: kindEnum,
    from: dateQuery,
    to: dateQuery,
    book: bookEnum,
    productId: intQuery,
    status: { type: 'string', enum: ['posted', 'void'] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

/** Registers the drawing endpoints under the `/api/v1` prefix. */
export function registerDrawingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/drawings', { schema: { body: createBody } }, async (request, reply) => {
    const { item, warnings, created } = createDrawing(ctx, request.body as DrawingCreate);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/drawings', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      kind?: 'goods' | 'cash'; from?: string; to?: string; book?: 'shop' | 'telecom' | 'icecream'; productId?: string;
      status?: 'posted' | 'void'; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listDrawings>[1] = { limit, offset };
    if (raw.kind !== undefined) q.kind = raw.kind;
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.productId !== undefined) q.productId = Number(raw.productId);
    if (raw.status !== undefined) q.status = raw.status;
    return listDrawings(ctx, q);
  });

  app.get('/drawings/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getDrawing(ctx, parseId(request.params)),
  }));

  app.post('/drawings/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidDrawing(ctx, parseId(request.params), request.body as { reason: string }),
  }));
}
