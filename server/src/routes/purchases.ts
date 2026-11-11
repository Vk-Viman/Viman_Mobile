/**
 * routes/purchases.ts - HTTP endpoints for supplier purchases and purchase returns.
 *
 * Layer: route (thin). Validates the request shape with JSON schema, calls `purchases.service.ts`, shapes the
 * response. All business rules (R4 return value, R11 one book per bill, R-FD, R-RD, C7) are in the service.
 *
 *   POST /purchases              create (201; 200 when `clientRef` was already used - idempotent retry)
 *   GET  /purchases              list with filters       GET /purchases/:id   one purchase
 *   POST /purchases/:id/void     void (R1)               POST /purchases/:id/returns   return goods
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createPurchase, createPurchaseReturn, getPurchase, listPurchases, voidPurchase,
} from '../services/purchases.service.ts';
import type { PurchaseCreate, PurchaseReturnCreate } from '../services/purchases.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, bookQuery, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

// Re-exported: other route files historically import these two from here.
export { checkQueryDates, dateQuery };

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    book: bookQuery,
    supplierId: intQuery,
    status: { type: 'string', enum: ['posted', 'void'] },
    q: { type: 'string', maxLength: 200 },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

// The numeric maximums keep every later sum (bill total, pool value) inside JavaScript's safe-integer range.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'items', 'clientRef'],
  properties: {
    businessDate: dateField,
    supplierId: { type: 'integer', minimum: 1 },
    billNo: { type: 'string' },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['productId', 'packs', 'packSize', 'lineTotalCents'],
        properties: {
          productId: { type: 'integer', minimum: 1 },
          packs: { type: 'integer', minimum: 1, maximum: 1000000 },
          packSize: { type: 'integer', minimum: 1, maximum: 1000000 },
          lineTotalCents: { type: 'integer', minimum: 0, maximum: 99999999999 },
        },
      },
    },
    notes: { type: 'string' },
    clientRef,
  },
} as const;

const returnBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'items', 'clientRef'],
  properties: {
    businessDate: dateField,
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['purchaseItemId', 'units'],
        properties: {
          purchaseItemId: { type: 'integer', minimum: 1 },
          units: { type: 'integer', minimum: 1, maximum: 1000000000000 },
        },
      },
    },
    note: { type: 'string' },
    clientRef,
  },
} as const;

/** Registers the purchase endpoints under the `/api/v1` prefix. */
export function registerPurchaseRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/purchases', { schema: { body: createBody } }, async (request, reply) => {
    const { item, created } = createPurchase(ctx, request.body as PurchaseCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/purchases', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; book?: 'shop' | 'telecom'; supplierId?: string; status?: 'posted' | 'void';
      q?: string; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listPurchases>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.supplierId !== undefined) q.supplierId = Number(raw.supplierId);
    if (raw.status !== undefined) q.status = raw.status;
    const text = raw.q?.trim();
    if (text) q.q = text;
    return listPurchases(ctx, q);
  });

  app.get('/purchases/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getPurchase(ctx, parseId(request.params)),
  }));

  app.post('/purchases/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidPurchase(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  app.post('/purchases/:id/returns', { schema: { params: idParamsSchema, body: returnBody } }, async (request, reply) => {
    const { item, purchase, created } = createPurchaseReturn(
      ctx, parseId(request.params), request.body as PurchaseReturnCreate,
    );
    return reply.code(created ? 201 : 200).send({ item, purchase });
  });
}
