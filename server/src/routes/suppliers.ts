import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { createSupplier, listSupplierItems, updateSupplierItem } from '../services/catalog.service.ts';
import { boolQuery, idParamsSchema, parseBool, parseId } from './catalog-query.ts';

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { q: { type: 'string', maxLength: 200 }, active: boolQuery },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' } },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string' },
    phone: { type: 'string' },
    notes: { type: 'string' },
    active: { type: 'boolean' },
  },
} as const;

export function registerSupplierRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/suppliers', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as { q?: string; active?: string };
    const filter: { q?: string; active?: boolean } = {};
    const text = raw.q?.trim();
    if (text) filter.q = text;
    const active = parseBool(raw.active);
    if (active !== undefined) filter.active = active;
    return listSupplierItems(ctx, filter);
  });

  app.post('/suppliers', { schema: { body: createBody } }, async (request, reply) => {
    const item = createSupplier(ctx, request.body as { name: string; phone?: string; notes?: string });
    return reply.code(201).send({ item });
  });

  app.put('/suppliers/:id', { schema: { params: idParamsSchema, body: updateBody } }, async (request) => ({
    item: updateSupplierItem(ctx, parseId(request.params),
      request.body as { name?: string; phone?: string; notes?: string; active?: boolean }),
  }));
}
