import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { isIsoDate } from '../lib/dates.ts';
import { listProductMovements, MOVEMENT_TYPES, reconciliation, valuation } from '../services/inventory.service.ts';
import type { MovementType } from '../services/inventory.service.ts';
import { boolQuery, bookQuery, fail, idParamsSchema, intQuery, parseBool, parseId } from './catalog-query.ts';
import { checkQueryDates, dateQuery } from './purchases.ts';

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
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    const offset = raw.offset === undefined ? 0 : Number(raw.offset);
    if (limit < 1 || limit > 200) fail({ limit: 'must be between 1 and 200' });
    const q: { from?: string; to?: string; type?: MovementType; limit: number; offset: number } = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.type !== undefined) q.type = raw.type;
    return listProductMovements(ctx, parseId(request.params), q);
  });

  app.get('/inventory/reconciliation', async () => reconciliation(ctx));
}
