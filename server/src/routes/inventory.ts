/**
 * routes/inventory.ts - HTTP endpoints for stock reports.
 *
 *   GET /inventory/valuation?book=&categoryId=&asOf=&includeZero=&includeInactive=   stock on hand and value
 *   GET /products/:id/movements?from=&to=&type=&limit=&offset=                        one product's stock history
 *   GET /inventory/reconciliation                                                     cache vs movements check
 *
 * Layer: route (thin) -> `inventory.service.ts`, which holds the weighted-average rules (BUSINESS_RULES
 * section 3). These are READ-only endpoints: stock only changes through the write services.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { isIsoDate } from '../lib/dates.ts';
import { listProductMovements, MOVEMENT_TYPES, reconciliation, valuation } from '../services/inventory.service.ts';
import type { MovementType } from '../services/inventory.service.ts';
import {
  boolQuery, bookQuery, checkQueryDates, dateQuery, fail, idParamsSchema, intQuery, parseBool, parseId,
  parsePaging,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const movementsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery,
    to: dateQuery,
    type: { type: 'string', enum: [...MOVEMENT_TYPES] },
    limit: intQuery,
    offset: intQuery,
  },
} as const;

const valuationQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    book: bookQuery,
    categoryId: intQuery,
    asOf: dateQuery,
    includeZero: boolQuery,
    includeInactive: boolQuery,
  },
} as const;

/** Registers the inventory endpoints under the `/api/v1` prefix. */
export function registerInventoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/inventory/valuation', { schema: { querystring: valuationQuery } }, async (request) => {
    const raw = request.query as {
      book?: 'shop' | 'telecom'; categoryId?: string; asOf?: string; includeZero?: string; includeInactive?: string;
    };
    // asOf is a report date: any real date is accepted (a future one shows the live figures).
    if (raw.asOf !== undefined && !isIsoDate(raw.asOf)) fail({ asOf: 'must be a valid date (YYYY-MM-DD)' });
    const q: Parameters<typeof valuation>[1] = {};
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.categoryId !== undefined) q.categoryId = Number(raw.categoryId);
    if (raw.asOf !== undefined) q.asOf = raw.asOf;
    const includeZero = parseBool(raw.includeZero);
    const includeInactive = parseBool(raw.includeInactive);
    if (includeZero !== undefined) q.includeZero = includeZero;
    if (includeInactive !== undefined) q.includeInactive = includeInactive;
    return valuation(ctx, q);
  });

  app.get('/products/:id/movements', { schema: { params: idParamsSchema, querystring: movementsQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; type?: MovementType; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: { from?: string; to?: string; type?: MovementType; limit: number; offset: number } = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.type !== undefined) q.type = raw.type;
    return listProductMovements(ctx, parseId(request.params), q);
  });

  app.get('/inventory/reconciliation', async () => reconciliation(ctx));
}
