/**
 * routes/sales.ts - HTTP endpoints for POS sales, sales history, sale voids and sales returns.
 *
 * Layer: route (thin). Validates the request shape with JSON schema (no type coercion), calls
 * `sales.service.ts`, shapes the response. All business rules (cart split by book, weighted-average COGS,
 * C13 extra cost, R13 warnings, R1 void, C5 return values, R-FD, R-RD) are in the services.
 *
 *   POST /sales                  save a cart (201 { sales, warnings }; 200 when `clientRef` was already used)
 *   GET  /sales                  list with filters and totals     GET /sales/:id   one sale
 *   POST /sales/:id/void         void (R1)
 *   POST /sales/:id/returns      return goods (201 { item, sale }; 200 on a repeated `clientRef`)
 *   POST /sales/:id/returns/:returnId/void   void a return (R-VR; 200 { item, sale, warnings })
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createSaleReturn, createSales, getSale, listSales, voidSale, voidSaleReturn,
} from '../services/sales.service.ts';
import type { SaleCreate, SaleReturnCreate } from '../services/sales.service.ts';
import {
  bookQuery, checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging,
  voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Cart / return size limit and the numeric maximums that keep every later sum inside the safe-integer range. */
const MAX_LINES = 100;
const MAX_QTY = 1000000;
const MAX_UNIT_PRICE_CENTS = 999999999;
/** Same ceiling for the optional per-unit cost (C13). */
const MAX_UNIT_COST_CENTS = MAX_UNIT_PRICE_CENTS;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    book: bookQuery,
    status: { type: 'string', enum: ['posted', 'void'] },
    productId: intQuery,
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
    items: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['productId', 'qty', 'unitPriceCents'],
        properties: {
          productId: { type: 'integer', minimum: 1 },
          qty: { type: 'integer', minimum: 1, maximum: MAX_QTY },
          unitPriceCents: { type: 'integer', minimum: 0, maximum: MAX_UNIT_PRICE_CENTS },
          // C13: optional cost per unit to charge (never below the automatic cost; the service enforces that).
          unitCostCents: { type: 'integer', minimum: 0, maximum: MAX_UNIT_COST_CENTS },
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
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['saleItemId', 'qty', 'resalable'],
        properties: {
          saleItemId: { type: 'integer', minimum: 1 },
          qty: { type: 'integer', minimum: 1, maximum: MAX_QTY },
          resalable: { type: 'boolean' },
        },
      },
    },
    note: { type: 'string' },
    clientRef,
  },
} as const;

const returnVoidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'returnId'],
  properties: {
    id: { type: 'string', pattern: '^[0-9]{1,9}$' },
    returnId: { type: 'string', pattern: '^[0-9]{1,9}$' },
  },
} as const;

/** Registers the sales endpoints under the `/api/v1` prefix. */
export function registerSaleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/sales', { schema: { body: createBody } }, async (request, reply) => {
    const { sales, warnings, created } = createSales(ctx, request.body as SaleCreate);
    return reply.code(created ? 201 : 200).send({ sales, warnings });
  });

  app.get('/sales', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; book?: 'shop' | 'telecom'; status?: 'posted' | 'void'; productId?: string;
      limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listSales>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.status !== undefined) q.status = raw.status;
    if (raw.productId !== undefined) q.productId = Number(raw.productId);
    return listSales(ctx, q);
  });

  app.get('/sales/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getSale(ctx, parseId(request.params)),
  }));

  app.post('/sales/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => {
    const { item, warnings } = voidSale(ctx, parseId(request.params), request.body as { reason: string });
    return { item, warnings };
  });

  app.post('/sales/:id/returns', { schema: { params: idParamsSchema, body: returnBody } }, async (request, reply) => {
    const { item, sale, warnings, created } = createSaleReturn(ctx, parseId(request.params), request.body as SaleReturnCreate);
    return reply.code(created ? 201 : 200).send({ item, sale, warnings });
  });

  app.post('/sales/:id/returns/:returnId/void', { schema: { params: returnVoidParams, body: voidBody } }, async (request) => {
    const p = request.params as { id: string; returnId: string };
    return voidSaleReturn(ctx, Number(p.id), Number(p.returnId), request.body as { reason: string });
  });
}
