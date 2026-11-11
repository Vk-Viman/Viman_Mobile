import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createProduct, getProductItem, listProductItems, updateProductItem,
} from '../services/catalog.service.ts';
import type { Book, ProductCreate, ProductListQuery, ProductUpdate } from '../services/catalog.service.ts';
import { bookQuery, boolQuery, fail, idParamsSchema, intQuery, parseBool, parseId } from './catalog-query.ts';

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    book: bookQuery,
    categoryId: intQuery,
    lowStock: boolQuery,
    active: boolQuery,
    limit: intQuery,
    offset: intQuery,
  },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'categoryId', 'kind', 'sellPriceCents', 'minPriceCents'],
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    categoryId: { type: 'integer', minimum: 1 },
    kind: { type: 'string', enum: ['stock', 'service'] },
    sellPriceCents: { type: 'integer' },
    minPriceCents: { type: 'integer' },
    reorderLevel: { type: 'integer' },
  },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    code: { type: ['string', 'null'] },
    name: { type: 'string' },
    description: { type: 'string' },
    categoryId: { type: 'integer', minimum: 1 },
    sellPriceCents: { type: 'integer' },
    minPriceCents: { type: 'integer' },
    reorderLevel: { type: 'integer' },
    active: { type: 'boolean' },
  },
} as const;

export function registerProductRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/products', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      q?: string; book?: Book; categoryId?: string; lowStock?: string; active?: string; limit?: string; offset?: string;
    };
    const limit = raw.limit === undefined ? 100 : Number(raw.limit);
    const offset = raw.offset === undefined ? 0 : Number(raw.offset);
    if (limit < 1 || limit > 500) fail({ limit: 'must be between 1 and 500' });
    const q: ProductListQuery = { limit, offset };
    const text = raw.q?.trim();
    if (text) q.q = text;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.categoryId !== undefined) q.categoryId = Number(raw.categoryId);
    const lowStock = parseBool(raw.lowStock);
    if (lowStock !== undefined) q.lowStock = lowStock;
    const active = parseBool(raw.active);
    if (active !== undefined) q.active = active;
    return listProductItems(ctx, q);
  });

  app.get('/products/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getProductItem(ctx, parseId(request.params)),
  }));

  app.post('/products', { schema: { body: createBody } }, async (request, reply) => {
    const item = createProduct(ctx, request.body as ProductCreate);
    return reply.code(201).send({ item });
  });

  app.put('/products/:id', { schema: { params: idParamsSchema, body: updateBody } }, async (request) => ({
    item: updateProductItem(ctx, parseId(request.params), request.body as ProductUpdate),
  }));
}
