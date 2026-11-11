import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { isIsoDate } from '../lib/dates.ts';
import {
  createPurchase, createPurchaseReturn, getPurchase, listPurchases, voidPurchase,
} from '../services/purchases.service.ts';
import type { PurchaseCreate, PurchaseReturnCreate } from '../services/purchases.service.ts';
import { fail, idParamsSchema, intQuery, parseId } from './catalog-query.ts';

export const dateQuery = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/** Digit-pattern dates must also be real calendar dates (400 VALIDATION_ERROR). */
export function checkQueryDates(raw: { from?: string; to?: string }): void {
  const bad: Record<string, string> = {};
  if (raw.from !== undefined && !isIsoDate(raw.from)) bad.from = 'must be a valid date (YYYY-MM-DD)';
  if (raw.to !== undefined && !isIsoDate(raw.to)) bad.to = 'must be a valid date (YYYY-MM-DD)';
  if (Object.keys(bad).length > 0) fail(bad);
}

const clientRef = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' } as const;
const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    book: { type: 'string', enum: ['shop', 'telecom'] },
    supplierId: intQuery,
    status: { type: 'string', enum: ['posted', 'void'] },
    q: { type: 'string', maxLength: 200 },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

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

const voidBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string' } },
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
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    const offset = raw.offset === undefined ? 0 : Number(raw.offset);
    if (limit < 1 || limit > 200) fail({ limit: 'must be between 1 and 200' });
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
