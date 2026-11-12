/**
 * routes/cash-transfers.ts - HTTP endpoints for cash transfers between the three books (Phase 9).
 *
 * Layer: route (thin): JSON-schema validation -> `cash-transfers.service.ts` -> response. The business rules (two linked
 * ledger rows, SAME_BOOK, fund rules 10.2, R9 DAY_CLOSED on both books, R13 warnings, R-FD, R1 voids) live in the service.
 *
 *   POST /cash-transfers            create (201 { item, warnings }; 200 on a repeated `clientRef`)
 *   GET  /cash-transfers            list + totals (filters from, to, book = either side, status; paged)
 *   GET  /cash-transfers/:id        one transfer        POST /cash-transfers/:id/void   void by reversal of both legs
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import type { CashBook } from '../repositories/cash-entries.repo.ts';
import { createTransfer, getTransfer, listTransfers, voidTransfer } from '../services/cash-transfers.service.ts';
import type { TransferCreate } from '../services/cash-transfers.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, idParamsSchema, intQuery, parseId, parsePaging, voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Largest amount (cents) one transfer may carry; the same bound is a CHECK in migration 013. */
const MAX_CENTS = 1_000_000_000_000;

const bookEnum = { type: 'string', enum: ['shop', 'telecom', 'icecream'] } as const;
const fundEnum = { type: 'string', enum: ['cost', 'electricity', 'profit'] } as const;

// fromBook = toBook and the fund rules are answered by the service (SAME_BOOK / FUND_REQUIRED / FUND_NOT_ALLOWED) with advice.
const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'fromBook', 'toBook', 'amountCents', 'clientRef'],
  properties: {
    businessDate: dateField, fromBook: bookEnum, toBook: bookEnum, fromFund: fundEnum, toFund: fundEnum,
    amountCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS }, note: { type: 'string' }, clientRef,
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateQuery, to: dateQuery, book: bookEnum, status: { type: 'string', enum: ['posted', 'void'] }, limit: intQuery, offset: intQuery,
  },
} as const;

/** Registers the cash transfer endpoints under the `/api/v1` prefix. */
export function registerCashTransferRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/cash-transfers', { schema: { body: createBody } }, async (request, reply) => {
    const { item, warnings, created } = createTransfer(ctx, request.body as TransferCreate);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/cash-transfers', { schema: { querystring: listQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; book?: CashBook; status?: 'posted' | 'void'; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listTransfers>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.status !== undefined) q.status = raw.status;
    return listTransfers(ctx, q);
  });

  app.get('/cash-transfers/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getTransfer(ctx, parseId(request.params)),
  }));

  app.post('/cash-transfers/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) =>
    voidTransfer(ctx, parseId(request.params), request.body as { reason: string }));
}
