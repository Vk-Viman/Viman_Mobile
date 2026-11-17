/**
 * routes/categories.ts - HTTP endpoints for product categories.
 *
 *   GET /categories?active=&book=   list       POST /categories   create (201)       PUT /categories/:id   edit
 *
 * Layer: route (thin) -> `catalog.service.ts`. The rules (default categories locked, a category's book fixed
 * once it has products, unique names, Telecom provider link locked once it has products) live in the service and the
 * migration 003/024 triggers. Each category in the list carries `providerId` and `providerName` (null when none).
 */
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
    book: bookQuery,
    // 13D: Telecom categories only (a Shop category with a provider is 400 CATEGORY_PROVIDER_NOT_ALLOWED); null = no provider.
    providerId: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string' },
    book: bookQuery,
    active: { type: 'boolean' },
    // Locked (409 CATEGORY_PROVIDER_LOCKED) once the category has products; null clears the provider.
    providerId: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

/** Registers the category endpoints under the `/api/v1` prefix. */
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
    const item = createCategory(ctx, request.body as { name: string; book: Book; providerId?: number | null });
    return reply.code(201).send({ item });
  });

  app.put('/categories/:id', { schema: { params: idParamsSchema, body: updateBody } }, async (request) => ({
    item: updateCategoryItem(ctx, parseId(request.params),
      request.body as { name?: string; book?: Book; active?: boolean; providerId?: number | null }),
  }));
}
