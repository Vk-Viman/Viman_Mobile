/**
 * routes/drawings.ts - HTTP endpoints for owner drawings (the owner taking goods for personal use).
 *
 * Layer: route (thin): JSON-schema validation -> `drawings.service.ts` -> response.
 * Business rules (section 9: stock removed at cost, no P&L; R-FD; R1 void by reversal) live in the service.
 *
 *   POST /drawings            create (201; 200 on a repeated `clientRef`)     GET /drawings   list
 *   GET  /drawings/:id        one drawing                                     POST /drawings/:id/void   void
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { createDrawing, getDrawing, listDrawings, voidDrawing } from '../services/drawings.service.ts';
import type { DrawingCreate } from '../services/drawings.service.ts';
import {
  bookQuery, checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const kindEnum = { type: 'string', enum: ['goods', 'cash'] } as const;

// productId / qty are required by the service for goods, so that kind "cash" is answered NOT_AVAILABLE_YET.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'businessDate', 'clientRef'],
  properties: {
    kind: kindEnum,
    businessDate: dateField,
    productId: { type: 'integer', minimum: 1 },
    qty: { type: 'integer', minimum: 1, maximum: 1000000000 },
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
    book: bookQuery,
    productId: intQuery,
    status: { type: 'string', enum: ['posted', 'void'] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

/** Registers the drawing endpoints under the `/api/v1` prefix. */
export function registerDrawingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/drawings', { schema: { body: createBody } }, async (request, reply) => {
    const { item, created } = createDrawing(ctx, request.body as DrawingCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/drawings', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      kind?: 'goods' | 'cash'; from?: string; to?: string; book?: 'shop' | 'telecom'; productId?: string;
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
