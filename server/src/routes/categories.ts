import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { createCategory, listCategoryItems, updateCategoryItem } from '../services/catalog.service.ts';
import type { Book } from '../services/catalog.service.ts';
import { bookQuery, boolQuery, idParamsSchema, parseBool, parseId } from './catalog-query.ts';

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { active: boolQuery, book: bookQuery },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'book'],
  properties: {
    name: { type: 'string' },
    book: { type: 'string', enum: ['shop', 'telecom'] },
  },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string' },
    book: { type: 'string', enum: ['shop', 'telecom'] },
    active: { type: 'boolean' },
  },
} as const;

export function registerCategoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/categories', { schema: { querystring: listQuery } }, async (request) => {
    const q = request.query as { active?: string; book?: Book };
    const filter: { active?: boolean; book?: Book } = {};
    const active = parseBool(q.active);
    if (active !== undefined) filter.active = active;
    if (q.book !== undefined) filter.book = q.book;
    return listCategoryItems(ctx, filter);
  });

  app.post('/categories', { schema: { body: createBody } }, async (request, reply) => {
    const item = createCategory(ctx, request.body as { name: string; book: Book });
    return reply.code(201).send({ item });
  });

  app.put('/categories/:id', { schema: { params: idParamsSchema, body: updateBody } }, async (request) => ({
    item: updateCategoryItem(ctx, parseId(request.params),
      request.body as { name?: string; book?: Book; active?: boolean }),
  }));
}
