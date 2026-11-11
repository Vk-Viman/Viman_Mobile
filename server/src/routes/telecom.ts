/**
 * routes/telecom.ts - HTTP endpoints for mobile reloads, EZCash and top-ups (Phase 6).
 *
 * Layer: route (thin): JSON-schema validation -> `telecom.service.ts` -> response. The business rules (commission
 * maths, rate snapshot, cash entries, R-FD, R1 voids) live in the service.
 *
 *   GET  /reload-providers          list with effective rates      PUT /reload-providers/:id   edit rate / active
 *   POST /reload-sales              create (201; 200 on a repeated `clientRef`)
 *   GET  /reload-sales              list + totals                  GET /reload-sales/:id       POST /reload-sales/:id/void
 *   POST /ezcash-sales              create (provider = Dialog)     GET /ezcash-sales (+ /:id)  POST /ezcash-sales/:id/void
 *   POST /telecom/topups            create                         GET /telecom/topups (+ /:id) POST /telecom/topups/:id/void
 *   GET  /telecom/summary?from&to   per-provider and total figures (revenue = commission only)
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createEzCashSale, createReloadSale, createTopup, getEzCashSale, getReloadSale, getTopup, listEzCashSales, listProviders,
  listReloadSales, listTopups, telecomSummary, updateProvider, voidEzCashSale, voidReloadSale, voidTopup,
} from '../services/telecom.service.ts';
import type { EzCashSaleCreate, ReloadSaleCreate, TopupCreate } from '../services/telecom.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging, voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Largest amount (cents) one entry may carry; the same bound is a CHECK in migration 009. */
const MAX_CENTS = 1_000_000_000_000;

const statusQuery = { type: 'string', enum: ['posted', 'void'] } as const;
const kindEnum = { type: 'string', enum: ['provider_topup', 'wallet_topup'] } as const;
const idField = { type: 'integer', minimum: 1 } as const;

const providerBody = {
  type: 'object',
  additionalProperties: false,
  required: ['commissionBp', 'active'],
  // `null` = "use the shop default rate". Coercion is off app-wide, so only a real null / integer passes.
  properties: { commissionBp: { type: ['integer', 'null'], minimum: 0, maximum: 10000 }, active: { type: 'boolean' } },
} as const;

const reloadBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'providerId', 'salesCents', 'clientRef'],
  properties: {
    businessDate: dateField,
    providerId: idField,
    salesCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS },
    extraCents: { type: 'integer', minimum: 0, maximum: MAX_CENTS },
    notes: { type: 'string' },
    clientRef,
  },
} as const;

const ezcashBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'billTotalCents', 'clientRef'],
  properties: {
    businessDate: dateField,
    billTotalCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS },
    notes: { type: 'string' },
    clientRef,
  },
} as const;

// providerId is required/forbidden depending on `kind`; the service answers with a per-field message.
const topupBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'kind', 'amountCents', 'clientRef'],
  properties: {
    businessDate: dateField,
    kind: kindEnum,
    providerId: idField,
    amountCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS },
    notes: { type: 'string' },
    clientRef,
  },
} as const;

const reloadListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, providerId: intQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

const ezcashListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

const topupListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, kind: kindEnum, providerId: intQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

const summaryQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery },
} as const;

type Status = 'posted' | 'void';
interface RawList { from?: string; to?: string; providerId?: string; status?: Status; kind?: 'provider_topup' | 'wallet_topup'; limit?: string; offset?: string }

/** Registers the telecom endpoints under the `/api/v1` prefix. */
export function registerTelecomRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------- providers ----------
  app.get('/reload-providers', async () => listProviders(ctx));

  app.put('/reload-providers/:id', { schema: { params: idParamsSchema, body: providerBody } }, async (request) => ({
    item: updateProvider(ctx, parseId(request.params), request.body as { commissionBp: number | null; active: boolean }),
  }));

  // ---------- reload sales ----------
  app.post('/reload-sales', { schema: { body: reloadBody } }, async (request, reply) => {
    const { item, created } = createReloadSale(ctx, request.body as ReloadSaleCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/reload-sales', { schema: { querystring: reloadListQuery } }, async (request) => {
    const raw = request.query as RawList;
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listReloadSales>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.providerId !== undefined) q.providerId = Number(raw.providerId);
    if (raw.status !== undefined) q.status = raw.status;
    return listReloadSales(ctx, q);
  });

  app.get('/reload-sales/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getReloadSale(ctx, parseId(request.params)),
  }));

  app.post('/reload-sales/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidReloadSale(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  // ---------- EZCash ----------
  app.post('/ezcash-sales', { schema: { body: ezcashBody } }, async (request, reply) => {
    const { item, created } = createEzCashSale(ctx, request.body as EzCashSaleCreate);
    return reply.code(created ? 201 : 200).send({ item });
  });

  app.get('/ezcash-sales', { schema: { querystring: ezcashListQuery } }, async (request) => {
    const raw = request.query as RawList;
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listEzCashSales>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listEzCashSales(ctx, q);
  });

  app.get('/ezcash-sales/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getEzCashSale(ctx, parseId(request.params)),
  }));

  app.post('/ezcash-sales/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidEzCashSale(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  // ---------- top-ups ----------
  app.post('/telecom/topups', { schema: { body: topupBody } }, async (request, reply) => {
    const { item, warnings, created } = createTopup(ctx, request.body as TopupCreate);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/telecom/topups', { schema: { querystring: topupListQuery } }, async (request) => {
    const raw = request.query as RawList;
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listTopups>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.kind !== undefined) q.kind = raw.kind;
    if (raw.providerId !== undefined) q.providerId = Number(raw.providerId);
    if (raw.status !== undefined) q.status = raw.status;
    return listTopups(ctx, q);
  });

  app.get('/telecom/topups/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getTopup(ctx, parseId(request.params)),
  }));

  app.post('/telecom/topups/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidTopup(ctx, parseId(request.params), request.body as { reason: string }),
  }));

  // ---------- summary ----------
  app.get('/telecom/summary', { schema: { querystring: summaryQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string };
    checkQueryDates(raw);
    const q: { from?: string; to?: string } = {};
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    return telecomSummary(ctx, q);
  });
}
