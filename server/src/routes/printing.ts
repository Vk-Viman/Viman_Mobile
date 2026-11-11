/**
 * routes/printing.ts - HTTP endpoints for print service types, print sales and printing supplies (Phase 7).
 *
 * Layer: route (thin): JSON-schema validation -> `printing.service.ts` -> response. Business rules (R12 cost
 * snapshot, cash entries, R-FD, R1 void by reversal, R13 warnings) live in the service.
 *
 *   GET  /print-service-types   POST /print-service-types   PUT /print-service-types/:id
 *   POST /print-sales (201; 200 on a repeated clientRef)  GET /print-sales  GET /print-sales/:id  POST /print-sales/:id/void
 *   POST /printing-supplies     GET /printing-supplies    GET /printing-supplies/:id  POST /printing-supplies/:id/void
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createPrintSale, createServiceType, createSupply, getPrintSale, getSupply, listPrintSales, listServiceTypes,
  listSupplies, updateServiceType, voidPrintSale, voidSupply,
} from '../services/printing.service.ts';
import type { PrintSaleCreate } from '../services/printing.service.ts';
import {
  boolQuery, checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseBool, parseId,
  parsePaging, voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Largest price / standard cost per page: Rs 10,000,000.00 (so qty x price always stays an exact integer). */
const MAX_UNIT_CENTS = 1_000_000_000;
/** Largest single supplies purchase: Rs 10,000,000,000.00. */
const MAX_SUPPLY_CENTS = 1_000_000_000_000;

const statusQuery = { type: 'string', enum: ['posted', 'void'] } as const;
const unitCents = { type: 'integer', minimum: 0, maximum: MAX_UNIT_CENTS } as const;

const typeCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name', 'priceCents', 'costCents'],
  properties: {
    code: { type: 'string', pattern: '^[A-Z0-9_]{2,20}$' },
    name: { type: 'string' },
    priceCents: unitCents,
    costCents: unitCents,
  },
} as const;

const typeUpdateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'priceCents', 'costCents', 'active'],
  properties: { name: { type: 'string' }, priceCents: unitCents, costCents: unitCents, active: { type: 'boolean' } },
} as const;

const typeListQuery = { type: 'object', additionalProperties: false, properties: { active: boolQuery } } as const;

const saleCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'serviceTypeId', 'qty', 'clientRef'],
  properties: {
    businessDate: dateField,
    serviceTypeId: { type: 'integer', minimum: 1 },
    qty: { type: 'integer', minimum: 1, maximum: 1000000 },
    unitPriceCents: unitCents,
    notes: { type: 'string' },
    clientRef,
  },
} as const;

const saleListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, serviceTypeId: intQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

const supplyCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'amountCents', 'description', 'clientRef'],
  properties: {
    businessDate: dateField,
    amountCents: { type: 'integer', minimum: 1, maximum: MAX_SUPPLY_CENTS },
    description: { type: 'string' },
    clientRef,
  },
} as const;

const supplyListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

/** Registers the printing endpoints under the `/api/v1` prefix. */
export function registerPrintingRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- service types ----
  app.get('/print-service-types', { schema: { querystring: typeListQuery } }, async (request) => {
    const raw = request.query as { active?: 'true' | 'false' };
    return listServiceTypes(ctx, parseBool(raw.active));
  });

  app.post('/print-service-types', { schema: { body: typeCreateBody } }, async (request, reply) => {
    const item = createServiceType(ctx, request.body as { code: string; name: string; priceCents: number; costCents: number });
    return reply.code(201).send({ item });
  });

  app.put('/print-service-types/:id', { schema: { params: idParamsSchema, body: typeUpdateBody } }, async (request) => ({
    item: updateServiceType(ctx, parseId(request.params), request.body as { name: string; priceCents: number; costCents: number; active: boolean }),
  }));

  // ---- print sales ----
  app.post('/print-sales', { schema: { body: saleCreateBody } }, async (request, reply) => {
    const { item, warnings, created } = createPrintSale(ctx, request.body as PrintSaleCreate);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/print-sales', { schema: { querystring: saleListQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; serviceTypeId?: string; status?: 'posted' | 'void'; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listPrintSales>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.serviceTypeId !== undefined) q.serviceTypeId = Number(raw.serviceTypeId);
    if (raw.status !== undefined) q.status = raw.status;
    return listPrintSales(ctx, q);
  });

  app.get('/print-sales/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getPrintSale(ctx, parseId(request.params)),
  }));

  app.post('/print-sales/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidPrintSale(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  // ---- printing supplies ----
  app.post('/printing-supplies', { schema: { body: supplyCreateBody } }, async (request, reply) => {
    const { item, warnings, created } = createSupply(ctx, request.body as { businessDate: string; amountCents: number; description: string; clientRef: string });
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/printing-supplies', { schema: { querystring: supplyListQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; status?: 'posted' | 'void'; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listSupplies>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listSupplies(ctx, q);
  });

  app.get('/printing-supplies/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getSupply(ctx, parseId(request.params)),
  }));

  app.post('/printing-supplies/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidSupply(ctx, parseId(request.params), request.body as { reason: string }),
  }));
}
