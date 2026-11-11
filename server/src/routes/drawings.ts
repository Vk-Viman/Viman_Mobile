import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { createDrawing, getDrawing, listDrawings, voidDrawing } from '../services/drawings.service.ts';
import type { DrawingCreate } from '../services/drawings.service.ts';
import { bookQuery, fail, idParamsSchema, intQuery, parseId } from './catalog-query.ts';
import { checkQueryDates, dateQuery } from './purchases.ts';

const clientRef = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' } as const;
const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
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
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    const offset = raw.offset === undefined ? 0 : Number(raw.offset);
    if (limit < 1 || limit > 200) fail({ limit: 'must be between 1 and 200' });
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
