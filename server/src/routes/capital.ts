/**
 * routes/capital.ts - HTTP endpoints for capital introduced into a book (Phase 9).
 *
 * Layer: route (thin): JSON-schema validation -> `capital.service.ts` -> response. The business rules (cash IN `capital`,
 * never revenue or profit, fund rules 10.2, R9, R-FD) live in the service. A capital entry (or an opening balance) is voided
 * with the Phase 8 endpoint `POST /capital-entries/:id/void`.
 *
 *   POST /capital        create (201 { item, warnings }; 200 on a repeated `clientRef`)
 *   GET  /capital        list + totals (filters kind = capital | opening_balance | all, book, from, to, status; paged)
 *   GET  /capital/:id    one entry
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import type { CashBook } from '../repositories/cash-entries.repo.ts';
import { createCapital, getCapitalEntry, listCapital } from '../services/capital.service.ts';
import type { CapitalCreate } from '../services/capital.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Largest amount (cents) one entry may carry; the same bound is a CHECK in migration 012. */
const MAX_CENTS = 1_000_000_000_000;

const bookEnum = { type: 'string', enum: ['shop', 'telecom', 'icecream'] } as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'book', 'amountCents', 'clientRef'],
  properties: {
    businessDate: dateField, book: bookEnum, fund: { type: 'string', enum: ['cost', 'electricity', 'profit'] },
    amountCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS }, note: { type: 'string' }, clientRef,
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['capital', 'opening_balance', 'all'] }, book: bookEnum, from: dateQuery, to: dateQuery,
    status: { type: 'string', enum: ['posted', 'void'] }, limit: intQuery, offset: intQuery,
  },
} as const;

/** Registers the capital endpoints under the `/api/v1` prefix. */
export function registerCapitalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/capital', { schema: { body: createBody } }, async (request, reply) => {
    const { item, warnings, created } = createCapital(ctx, request.body as CapitalCreate);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/capital', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as {
      kind?: 'capital' | 'opening_balance' | 'all'; book?: CashBook; from?: string; to?: string; status?: 'posted' | 'void';
      limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listCapital>[1] = { limit, offset };
    if (raw.kind !== undefined && raw.kind !== 'all') q.kind = raw.kind;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listCapital(ctx, q);
  });

  app.get('/capital/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getCapitalEntry(ctx, parseId(request.params)),
  }));
}
