/**
 * routes/icecream.ts - HTTP endpoints for the Ice Cream business: daily entries, payments, fund moves, funds (Phase 10).
 *
 * Layer: route (thin): JSON-schema validation -> service -> response. The rules (BUSINESS_RULES section 10: three funds,
 * E1-E5, D1-D4, R1, R9, R-FD, section 12) live in the services and the pure module `services/icecream-rules.ts`.
 *
 *   POST /icecream/days                    new daily entry (201; 200 on a repeated `clientRef`)  { day, funds, warnings }
 *   PUT  /icecream/days/:date              void-and-replace the posted entry of a date
 *   POST /icecream/days/:date/void         void it (D2 guard)          GET /icecream/days, GET /icecream/days/:date
 *   POST /icecream/payments                materials / electricity bill / other cost    POST /icecream/payments/:id/void
 *   GET  /icecream/payments                history
 *   POST /icecream/fund-moves/preview      what a move would do (no write)
 *   POST /icecream/fund-moves              post a move (D4: 409 SPLIT_CONFIRMATION_REQUIRED until confirmed)
 *   POST /icecream/fund-moves/:id/void     void (D2 guard)             GET /icecream/fund-moves   history
 *   GET  /icecream/funds?asOf=&from=       fund balances AND recognized profit, in separate blocks
 *   GET  /icecream/funds/entries           the complete fund ledger incl. reversals
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { isIsoDate } from '../lib/dates.ts';
import type { IceFund } from '../repositories/cash-entries.repo.ts';
import type { IceStatus } from '../repositories/icecream.repo.ts';
import { createDay, getDayByDate, listDays, replaceDay, voidDay } from '../services/icecream-days.service.ts';
import type { IceDayCreate, IceDayInput } from '../services/icecream-days.service.ts';
import { createMove, listIceMoves, previewMove, voidMove } from '../services/icecream-moves.service.ts';
import type { IceMoveCreate } from '../services/icecream-moves.service.ts';
import { createPayment, listIcePayments, voidPayment } from '../services/icecream-payments.service.ts';
import type { IcePaymentCreate } from '../services/icecream-payments.service.ts';
import type { PaymentKind } from '../services/icecream-rules.ts';
import { MAX_CENTS, getFundLedger, getFunds } from '../services/icecream.service.ts';
import {
  DATE_PATTERN, checkQueryDates, clientRef, dateField, dateQuery, fail, idParamsSchema, intQuery, parseId, parsePaging, voidBody,
} from './catalog-query.ts';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const fundEnum = { type: 'string', enum: ['cost', 'electricity', 'profit'] } as const;
const statusQuery = { type: 'string', enum: ['posted', 'void'] } as const;
/** A money amount in cents: integer >= 0 (no coercion: "5" or null is a 400). */
const cents = { type: 'integer', minimum: 0, maximum: MAX_CENTS } as const;
/** A strictly positive money amount (payments and moves). */
const positiveCents = { type: 'integer', minimum: 1, maximum: MAX_CENTS } as const;

const dateParams = {
  type: 'object', additionalProperties: false, required: ['date'], properties: { date: { type: 'string', pattern: DATE_PATTERN } },
} as const;

const itemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['itemName', 'qty', 'unitPriceCents'],
  properties: {
    itemName: { type: 'string' },
    qty: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    unitPriceCents: cents,
  },
} as const;

const dayFields = {
  salesCents: cents, costAllocCents: cents, electricityAllocCents: cents,
  items: { type: 'array', maxItems: 200, items: itemSchema },
  confirmNegativeProfit: { type: 'boolean' }, notes: { type: 'string' }, clientRef,
} as const;

const dayCreateBody = {
  type: 'object', additionalProperties: false,
  required: ['businessDate', 'salesCents', 'costAllocCents', 'electricityAllocCents', 'clientRef'],
  properties: { businessDate: dateField, ...dayFields },
} as const;

const dayReplaceBody = {
  type: 'object', additionalProperties: false,
  required: ['salesCents', 'costAllocCents', 'electricityAllocCents', 'clientRef'],
  properties: { ...dayFields, reason: { type: 'string' } },
} as const;

const dayListQuery = {
  type: 'object', additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

// `category` accepts any text ON PURPOSE: the service answers ELECTRICITY_NOT_ALLOWED with advice instead of a bare schema error.
const paymentBody = {
  type: 'object', additionalProperties: false,
  required: ['businessDate', 'kind', 'fund', 'amountCents', 'description', 'clientRef'],
  properties: {
    businessDate: dateField, kind: { type: 'string', enum: ['materials', 'electricity_bill', 'other_cost'] }, fund: fundEnum,
    amountCents: positiveCents, category: { type: 'string' }, description: { type: 'string' }, clientRef,
  },
} as const;

const paymentListQuery = {
  type: 'object', additionalProperties: false,
  properties: {
    from: dateQuery, to: dateQuery, kind: { type: 'string', enum: ['materials', 'electricity_bill', 'other_cost'] }, fund: fundEnum,
    status: statusQuery, limit: intQuery, offset: intQuery,
  },
} as const;

const previewBody = {
  type: 'object', additionalProperties: false, required: ['fromFund', 'toFund', 'amountCents'],
  properties: { fromFund: fundEnum, toFund: fundEnum, amountCents: positiveCents },
} as const;

const moveBody = {
  type: 'object', additionalProperties: false,
  required: ['businessDate', 'fromFund', 'toFund', 'amountCents', 'clientRef'],
  properties: {
    businessDate: dateField, fromFund: fundEnum, toFund: fundEnum, amountCents: positiveCents, confirmSplit: { type: 'boolean' },
    confirmedProfitEligibleCents: cents, note: { type: 'string' }, clientRef,
  },
} as const;

const moveListQuery = {
  type: 'object', additionalProperties: false,
  properties: { from: dateQuery, to: dateQuery, status: statusQuery, limit: intQuery, offset: intQuery },
} as const;

const fundsQuery = {
  type: 'object', additionalProperties: false, properties: { asOf: dateQuery, from: dateQuery },
} as const;

const ledgerQuery = {
  type: 'object', additionalProperties: false,
  properties: { fund: fundEnum, from: dateQuery, to: dateQuery, limit: intQuery, offset: intQuery },
} as const;

/** Registers the Ice Cream endpoints under the `/api/v1` prefix. */
export function registerIceCreamRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------- daily entries ----------
  app.post('/icecream/days', { schema: { body: dayCreateBody } }, async (request, reply) => {
    const { created, ...out } = createDay(ctx, request.body as IceDayCreate);
    return reply.code(created ? 201 : 200).send(out);
  });

  app.put('/icecream/days/:date', { schema: { params: dateParams, body: dayReplaceBody } }, async (request) => {
    const { created: _created, ...out } = replaceDay(ctx, (request.params as { date: string }).date, request.body as IceDayInput & { reason?: string });
    return out;
  });

  app.post('/icecream/days/:date/void', { schema: { params: dateParams, body: voidBody } }, async (request) =>
    voidDay(ctx, (request.params as { date: string }).date, request.body as { reason: string }));

  app.get('/icecream/days', { schema: { querystring: dayListQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; status?: IceStatus; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listDays>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listDays(ctx, q);
  });

  app.get('/icecream/days/:date', { schema: { params: dateParams } }, async (request) => {
    const { date } = request.params as { date: string };
    if (!isIsoDate(date)) fail({ date: 'must be a valid date (YYYY-MM-DD)' });
    return { day: getDayByDate(ctx, date) };
  });

  // ---------- payments ----------
  app.post('/icecream/payments', { schema: { body: paymentBody } }, async (request, reply) => {
    const { created, ...out } = createPayment(ctx, request.body as IcePaymentCreate);
    return reply.code(created ? 201 : 200).send(out);
  });

  app.post('/icecream/payments/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) =>
    voidPayment(ctx, parseId(request.params), request.body as { reason: string }));

  app.get('/icecream/payments', { schema: { querystring: paymentListQuery } }, async (request) => {
    const raw = request.query as {
      from?: string; to?: string; kind?: PaymentKind; fund?: IceFund; status?: IceStatus; limit?: string; offset?: string;
    };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listIcePayments>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.kind !== undefined) q.kind = raw.kind;
    if (raw.fund !== undefined) q.fund = raw.fund;
    if (raw.status !== undefined) q.status = raw.status;
    return listIcePayments(ctx, q);
  });

  // ---------- fund moves ----------
  app.post('/icecream/fund-moves/preview', { schema: { body: previewBody } }, async (request) =>
    previewMove(ctx, request.body as { fromFund: IceFund; toFund: IceFund; amountCents: number }));

  app.post('/icecream/fund-moves', { schema: { body: moveBody } }, async (request, reply) => {
    const { created, ...out } = createMove(ctx, request.body as IceMoveCreate);
    return reply.code(created ? 201 : 200).send(out);
  });

  app.post('/icecream/fund-moves/:id/void', { schema: { params: idParamsSchema, body: voidBody } }, async (request) =>
    voidMove(ctx, parseId(request.params), request.body as { reason: string }));

  app.get('/icecream/fund-moves', { schema: { querystring: moveListQuery } }, async (request) => {
    const raw = request.query as { from?: string; to?: string; status?: IceStatus; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof listIceMoves>[1] = { limit, offset };
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    if (raw.status !== undefined) q.status = raw.status;
    return listIceMoves(ctx, q);
  });

  // ---------- funds ----------
  app.get('/icecream/funds', { schema: { querystring: fundsQuery } }, async (request) => {
    const raw = request.query as { asOf?: string; from?: string };
    // `asOf` and `from` are report/query dates: calendar-checked, never rejected for being in the future (R-FD is for transactions)
    if (raw.asOf !== undefined && !isIsoDate(raw.asOf)) fail({ asOf: 'must be a valid date (YYYY-MM-DD)' });
    checkQueryDates(raw);
    const q: { asOf?: string; from?: string } = {};
    if (raw.asOf !== undefined) q.asOf = raw.asOf;
    if (raw.from !== undefined) q.from = raw.from;
    return getFunds(ctx, q);
  });

  app.get('/icecream/funds/entries', { schema: { querystring: ledgerQuery } }, async (request) => {
    const raw = request.query as { fund?: IceFund; from?: string; to?: string; limit?: string; offset?: string };
    checkQueryDates(raw);
    const { limit, offset } = parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const q: Parameters<typeof getFundLedger>[1] = { limit, offset };
    if (raw.fund !== undefined) q.fund = raw.fund;
    if (raw.from !== undefined) q.from = raw.from;
    if (raw.to !== undefined) q.to = raw.to;
    return getFundLedger(ctx, q);
  });
}
