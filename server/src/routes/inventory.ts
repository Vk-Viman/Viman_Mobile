import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { listProductMovements, MOVEMENT_TYPES, reconciliation } from '../services/inventory.service.ts';
import type { MovementType } from '../services/inventory.service.ts';
import { fail, idParamsSchema, intQuery, parseId } from './catalog-query.ts';
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

export function registerInventoryRoutes(app: FastifyInstance, ctx: AppContext): void {
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
