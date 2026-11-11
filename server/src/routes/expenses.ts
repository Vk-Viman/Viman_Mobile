/**
 * routes/expenses.ts - HTTP endpoints for expenses (Shop/Telecom, Phase 8).
 *
 * Layer: route (thin): JSON-schema validation -> `expenses.service.ts` -> response. The business rules (E2 no
 * electricity, Shop/Telecom only, cash entry, R9 closed days, R13 warnings, R-FD, R1 voids) live in the service.
 *
 *   GET  /expenses/categories      the nine categories with labels (no electricity, E2)
 *   POST /expenses                 create (201 { item, warnings }; 200 on a repeated `clientRef`)
 *   GET  /expenses                 list + totals (filters from, to, book, category, status; paged)
 *   GET  /expenses/:id             one expense          POST /expenses/:id/void   void by reversal
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import {
  createExpense, getExpense, listExpenseCategories, listExpenses, voidExpense,
} from '../services/expenses.service.ts';
import type { ExpenseCreate } from '../services/expenses.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging, voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Largest amount (cents) one expense may carry; the same bound is a CHECK in migration 012. */
const MAX_CENTS = 1_000_000_000_000;

const statusQuery = { type: 'string', enum: ['posted', 'void'] } as const;

// `book` accepts 'icecream' and `category` any text ON PURPOSE: the service answers USE_ICECREAM_PAYMENTS and
// ELECTRICITY_NOT_ALLOWED with advice instead of a bare schema error.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'book', 'category', 'amountCents', 'description', 'clientRef'],
  properties: {
    businessDate: dateField,
    book: { type: 'string', enum: ['shop', 'telecom', 'icecream'] },
    category: { type: 'string', minLength: 1, maxLength: 60 },
    amountCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS },
    description: { type: 'string' },
    notes: { type: 'string' },
    clientRef,
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery, to: dateQuery, book: { type: 'string', enum: ['shop', 'telecom'] }, category: { type: 'string', maxLength: 60 },
    status: statusQuery, limit: intQuery, offset: intQuery,
  },
} as const;

/** Registers the expenses (Shop/Telecom) endpoints under the `/api/v1` prefix. */
export function registerExpenseRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/expenses/categories', async () => listExpenseCategories());

  app.post('/expenses', { schema: { body: createBody } }, async (request, reply) => {
    const { item, warnings, created } = createExpense(ctx, request.body as ExpenseCreate);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/expenses', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; book?: 'shop' | 'telecom'; category?: string; status?: 'posted' | 'void'; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listExpenses>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.category !== undefined) q.category = raw.category;
    if (raw.status !== undefined) q.status = raw.status;
    return listExpenses(ctx, q);
  });

  app.get('/expenses/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getExpense(ctx, parseId(request.params)),
  }));

  app.post('/expenses/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) => ({
    item: voidExpense(ctx, parseId(request.params), request.body as { reason: string }),
  }));
}
