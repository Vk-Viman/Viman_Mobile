/**
 * routes/products.ts - HTTP endpoints for products.
 *
 *   GET /products?q=&book=&categoryId=&kind=&lowStock=&active=&limit=&offset=   list (default 100, max 500)
 *   GET /products/:id    one product        POST /products   create (201)        PUT /products/:id   edit
 *
 * Layer: route (thin) -> `catalog.service.ts`. Rules (book comes from the category, kind/book never change,
 * C12 selling price is owner-entered, unique names/codes) live in the service and migration 003 triggers.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createProduct, getProductItem, listProductItems, updateProductItem,
} from '../services/catalog.service.ts';
import type { Book, Kind, ProductCreate, ProductListQuery, ProductUpdate } from '../services/catalog.service.ts';
import {
  bookQuery, boolQuery, idParamsSchema, intQuery, parseBool, parseId, parsePaging,
} from './catalog-query.ts';

// Product lists are larger than other lists: the POS and stock screens load the whole catalog.
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    book: bookQuery,
    categoryId: intQuery,
    kind: { type: 'string', enum: ['stock', 'service'] },
    lowStock: boolQuery,
    active: boolQuery,
    limit: intQuery,
    offset: intQuery,
  },
} as const;

// Money fields are plain integers here; the service applies the exact range (0..MAX_CENTS) and C12 rules.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'kind', 'sellPriceCents', 'minPriceCents'],
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    categoryId: { type: 'integer', minimum: 1 },
    // Exactly one of categoryId / newCategory (checked by the service: neither or both -> 400 on categoryId).
    newCategory: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'book'],
      properties: { name: { type: 'string' }, book: bookQuery },
    },
    kind: { type: 'string', enum: ['stock', 'service'] },
    sellPriceCents: { type: 'integer' },
    minPriceCents: { type: 'integer' },
    reorderLevel: { type: 'integer' },
  },
} as const;

// No `kind` or `book` here: a product's kind and book can never be changed.
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

/** Registers the product endpoints under the `/api/v1` prefix. */
export function registerProductRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/products', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      q?: string; book?: Book; categoryId?: string; kind?: Kind; lowStock?: string; active?: string; limit?: string; offset?: string;
    };
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: ProductListQuery = { limit, offset };
    const text = raw.q?.trim();
    if (text) q.q = text;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.categoryId !== undefined) q.categoryId = Number(raw.categoryId);
    if (raw.kind !== undefined) q.kind = raw.kind;
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
