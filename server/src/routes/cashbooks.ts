/**
 * routes/cashbooks.ts - HTTP endpoints for cash books, opening balances, cash counts and daily closings (Phase 8).
 *
 * Layer: route (thin): JSON-schema validation -> the cash book services -> response. The business rules (ledger maths,
 * opening balance uniqueness, count expected/difference, closings, R9 DAY_CLOSED, R-FD, R13 warnings) live in the services.
 *
 *   GET  /cashbooks                          balances of the three books (+ Ice Cream fund balances, warnings)
 *   GET  /cashbooks/:book?from&to&limit&offset   ledger with running balance, opening/in/out/closing, closed dates
 *   POST /cashbooks/:book/opening            set the opening balance (Ice Cream: per fund)
 *   GET  /cashbooks/:book/opening            opening balances of the book
 *   POST /capital-entries/:id/void           void an opening balance / capital entry (reversal)
 *   POST /cash-counts                        count the drawer (over/short adjustment)
 *   GET  /cash-counts  GET /cash-counts/expected?book&businessDate  GET /cash-counts/:id  POST /cash-counts/:id/void
 *   POST /daily-closings                     close a day (optionally with a count)
 *   POST /daily-closings/:id/reopen          reopen a closed day (reason required, audited)
 *   GET  /daily-closings?book&from&to        closings   GET /daily-closings/status?book&businessDate -> { isClosed }
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { isIsoDate } from '../lib/dates.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';
import { getCashBookLedger, listCashBooks } from '../services/cashbooks.service.ts';
import {
  createCashCount, expectedCashAsOf, getCashCountById, listCashCounts, voidCashCount,
} from '../services/cash-counts.service.ts';
import { closeDay, dayStatus, listDailyClosings, reopenDay } from '../services/daily-closings.service.ts';
import type { DailyClosingCreate } from '../services/daily-closings.service.ts';
import { listOpeningBalances, setOpeningBalance, voidCapitalEntry } from '../services/opening-balance.service.ts';
import {
  checkQueryDates, clientRef, dateField, dateQuery, fail, idParamsSchema, intQuery, parseId, parsePaging, voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Largest amount (cents) one entry may carry; the same bound is a CHECK in migration 012. */
const MAX_CENTS = 1_000_000_000_000;

const bookEnum = { type: 'string', enum: ['shop', 'telecom', 'icecream'] } as const;
const fundEnum = { type: 'string', enum: ['cost', 'electricity', 'profit'] } as const;
const statusQuery = { type: 'string', enum: ['posted', 'void'] } as const;

const bookParams = {
  type: 'object', additionalProperties: false, required: ['book'], properties: { book: bookEnum },
} as const;

const ledgerQuery = {
  type: 'object', additionalProperties: false, properties: { from: dateQuery, to: dateQuery, limit: intQuery, offset: intQuery },
} as const;

const openingBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'amountCents', 'clientRef'],
  properties: {
    businessDate: dateField, amountCents: { type: 'integer', minimum: 1, maximum: MAX_CENTS }, fund: fundEnum,
    note: { type: 'string' }, clientRef,
  },
} as const;

const countBody = {
  type: 'object',
  additionalProperties: false,
  required: ['businessDate', 'book', 'countedCents', 'clientRef'],
  properties: {
    businessDate: dateField, book: bookEnum, countedCents: { type: 'integer', minimum: 0, maximum: MAX_CENTS }, fund: fundEnum,
    note: { type: 'string' }, clientRef,
  },
} as const;

const countListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { book: bookEnum, from: dateQuery, to: dateQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

const dayQuery = {
  type: 'object', additionalProperties: false, required: ['book', 'businessDate'], properties: { book: bookEnum, businessDate: dateQuery },
} as const;

const closingBody = {
  type: 'object',
  additionalProperties: false,
  required: ['book', 'businessDate', 'clientRef'],
  properties: {
    book: bookEnum, businessDate: dateField, countedCents: { type: 'integer', minimum: 0, maximum: MAX_CENTS }, fund: fundEnum,
    note: { type: 'string' }, clientRef,
  },
} as const;

const reopenBody = {
  type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string' } },
} as const;

const closingListQuery = {
  type: 'object', additionalProperties: false, properties: { book: bookEnum, from: dateQuery, to: dateQuery },
} as const;

/** A query date must be a real calendar day (R-FD never rejects query dates, only impossible ones). */
function checkDay(date: string): void {
  if (!isIsoDate(date)) fail({ businessDate: 'must be a valid date (YYYY-MM-DD)' });
}

/** Registers the cash book, opening balance, cash count and daily closing endpoints under the `/api/v1` prefix. */
export function registerCashbookRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------- books ----------
  app.get('/cashbooks', async () => listCashBooks(ctx));

  app.get('/cashbooks/:book', { schema: { params: bookParams, querystring: ledgerQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof getCashBookLedger>[2] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    return getCashBookLedger(ctx, (request.params as { book: CashBook }).book, q);
  });

  // ---------- opening balances ----------
  app.post('/cashbooks/:book/opening', { schema: { params: bookParams, body: openingBody } }, async (request, reply) => {
    const { item, warnings, created } = setOpeningBalance(
      ctx, (request.params as { book: CashBook }).book,
      request.body as { businessDate: string; amountCents: number; fund?: IceFund; note?: string; clientRef: string },
    );
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/cashbooks/:book/opening', { schema: { params: bookParams } }, async (request) =>
    listOpeningBalances(ctx, (request.params as { book: CashBook }).book));

  app.post('/capital-entries/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) =>
    voidCapitalEntry(ctx, parseId(request.params), request.body as { reason: string }));

  // ---------- cash counts ----------
  app.post('/cash-counts', { schema: { body: countBody } }, async (request, reply) => {
    const { item, warnings, created } = createCashCount(ctx, request.body as Parameters<typeof createCashCount>[1]);
    return reply.code(created ? 201 : 200).send({ item, warnings });
  });

  app.get('/cash-counts', { schema: { querystring: countListQuery } }, async (request) => {
    const raw = request.query as { book?: CashBook; from?: string; to?: string; status?: 'posted' | 'void'; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listCashCounts>[1] = { limit, offset };
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listCashCounts(ctx, q);
  });

  app.get('/cash-counts/expected', { schema: { querystring: dayQuery } }, async (request) => {
    const q = request.query as { book: CashBook; businessDate: string };
    checkDay(q.businessDate);
    return expectedCashAsOf(ctx, q.book, q.businessDate);
  });

  app.get('/cash-counts/:id', { schema: { params: idParamsSchema } }, async (request) => ({
    item: getCashCountById(ctx, parseId(request.params)),
  }));

  app.post('/cash-counts/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) =>
    voidCashCount(ctx, parseId(request.params), request.body as { reason: string }));

  // ---------- daily closings ----------
  app.post('/daily-closings', { schema: { body: closingBody } }, async (request, reply) => {
    const { item, count, warnings, created } = closeDay(ctx, request.body as DailyClosingCreate);
    return reply.code(created ? 201 : 200).send({ item, count, warnings });
  });

  app.get('/daily-closings', { schema: { querystring: closingListQuery } }, async (request) => {
    const raw = request.query as { book?: CashBook; from?: string; to?: string };
    checkQueryDates(raw);
    const q: Parameters<typeof listDailyClosings>[1] = {};
    if (raw.book !== undefined) q.book = raw.book;
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    return listDailyClosings(ctx, q);
  });

  app.get('/daily-closings/status', { schema: { querystring: dayQuery } }, async (request) => {
    const q = request.query as { book: CashBook; businessDate: string };
    checkDay(q.businessDate);
    return dayStatus(ctx, q.book, q.businessDate);
  });

  app.post('/daily-closings/:id/reopen', { schema: { params: idParamsSchema, body: reopenBody } }, async (request) => ({
    item: reopenDay(ctx, parseId(request.params), request.body as { reason: string }),
  }));
}
