/**
 * routes/reports-operational.ts - HTTP endpoints for the operational reports (stock, sales, purchases, losses, drawings, printing, backdated).
 *
 *   GET /reports/inventory/valuation?asOf=&book=&categoryId=&includeZero=&includeInactive=&format=
 *   GET /reports/stock-movements?from=&to=&productId=&type=&book=&limit=&offset=&format=
 *   GET /reports/stock-losses?from&to&granularity&book=&format=
 *   GET /reports/product-profitability?from&to&book=&categoryId=&format=
 *   GET /reports/low-stock?book=&categoryId=&includeInactive=&format=
 *   GET /reports/purchases?from&to&granularity&book=&supplierId=&format=
 *   GET /reports/sales?from&to&granularity&book=&topN=&format=
 *   GET /reports/drawings?from&to&granularity&book=&format=
 *   GET /reports/printing-variance?from&to&granularity&format=
 *   GET /reports/backdated?from&to&book=&limit=&offset=&format=
 *
 * Layer: route (thin): JSON-schema validation -> report service -> JSON body (with `table` and `warnings`) or an .xlsx workbook.
 * Every endpoint is READ-ONLY (no writes, no audit rows). Dates are business dates and are never rejected for being in the
 * future (R-FD applies to transactions only); the shared `parseReportQuery` answers 400 for impossible dates, `from > to` or
 * a range above 3,660 days. The report logic lives in `services/reports/*.ts` (pure `(conn, query) => figures`) so the
 * Phase 12 dashboard can call it directly.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { isIsoDate, todayBusinessDate } from '../lib/dates.ts';
import type { ReportTable } from '../lib/report-table.ts';
import { backdatedReport } from '../services/reports/backdated-report.ts';
import { drawingsReport } from '../services/reports/drawings-report.ts';
import { inventoryValuation } from '../services/reports/inventory-valuation.ts';
import { lowStockReport } from '../services/reports/low-stock.ts';
import { printingVarianceReport } from '../services/reports/printing-variance.ts';
import { productProfitability } from '../services/reports/product-profitability.ts';
import { purchasesReport } from '../services/reports/purchases-report.ts';
import { salesReport } from '../services/reports/sales-report.ts';
import { LOSS_REASONS, stockLossesReport } from '../services/reports/stock-losses-report.ts';
import { MOVEMENT_REPORT_TYPES, MOVEMENTS_EXPORT_LIMIT, stockMovementsReport } from '../services/reports/stock-movements-report.ts';
import type { MovementReportType } from '../services/reports/stock-movements-report.ts';
import type { Book, StockBook } from '../services/reports/ops-common.ts';
import { boolQuery, bookQuery, dateQuery, fail, intQuery, parseBool, parsePaging } from './catalog-query.ts';
import { parseReportQuery, reportQueryProps, sendReport } from './report-common.ts';
import type { ReportQuery } from './report-common.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const allBooksQuery = { type: 'string', enum: ['shop', 'telecom', 'icecream'] } as const;
const formatQuery = reportQueryProps.format;

/** Shapes a querystring schema. */
const schema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties });
const periodSchema = (extra: Record<string, unknown> = {}) => schema({
  from: reportQueryProps.from, to: reportQueryProps.to, granularity: reportQueryProps.granularity, format: formatQuery, ...extra,
});

/** The workbook tables of a report: the main table and any breakdown tables. */
const tablesOf = (r: { table: ReportTable; extraTables?: ReportTable[] }): ReportTable[] => [r.table, ...(r.extraTables ?? [])];

/** A `ReportQuery` for reports that are not period based (the file name carries the single date). */
const singleDate = (date: string, format: unknown): ReportQuery => ({ from: date, to: date, granularity: 'day', format: format === 'xlsx' ? 'xlsx' : 'json' });

/** Checks an optional report date (calendar-valid; never rejected for being in the future). */
function checkDate(name: string, v: string | undefined): void {
  if (v !== undefined && !isIsoDate(v)) fail({ [name]: 'must be a valid date (YYYY-MM-DD)' });
}

/** Registers the operational reports (stock, sales, purchases, losses, drawings, printing, backdated) endpoints under the `/api/v1` prefix. */
export function registerOperationalReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const conn = () => ctx.database.conn;

  app.get('/reports/inventory/valuation', {
    schema: { querystring: schema({ asOf: dateQuery, book: bookQuery, categoryId: intQuery, includeZero: boolQuery, includeInactive: boolQuery, format: formatQuery }) },
  }, async (request, reply) => {
    const raw = request.query as { asOf?: string; book?: StockBook; categoryId?: string; includeZero?: string; includeInactive?: string; format?: string };
    checkDate('asOf', raw.asOf);
    const asOf = raw.asOf ?? todayBusinessDate();
    const out = inventoryValuation(conn(), {
      asOf, ...(raw.book !== undefined ? { book: raw.book } : {}), ...(raw.categoryId !== undefined ? { categoryId: Number(raw.categoryId) } : {}),
      includeZero: parseBool(raw.includeZero) === true, includeInactive: parseBool(raw.includeInactive) !== false,
    });
    return sendReport(reply, singleDate(asOf, raw.format), out, tablesOf(out), 'inventory-valuation');
  });

  app.get('/reports/stock-movements', {
    schema: { querystring: schema({ from: dateQuery, to: dateQuery, productId: intQuery, type: { type: 'string', enum: [...MOVEMENT_REPORT_TYPES] }, book: bookQuery, limit: intQuery, offset: intQuery, format: formatQuery }) },
  }, async (request, reply) => {
    const raw = request.query as { from?: string; to?: string; productId?: string; type?: MovementReportType; book?: StockBook; limit?: string; offset?: string; format?: string };
    checkDate('from', raw.from); checkDate('to', raw.to);
    if (raw.from !== undefined && raw.to !== undefined && raw.from > raw.to) fail({ from: 'The start date cannot be after the end date.' });
    const xlsx = raw.format === 'xlsx';
    const { limit, offset } = xlsx ? { limit: MOVEMENTS_EXPORT_LIMIT, offset: 0 } : parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const out = stockMovementsReport(conn(), {
      ...(raw.from !== undefined ? { from: raw.from } : {}), ...(raw.to !== undefined ? { to: raw.to } : {}),
      ...(raw.productId !== undefined ? { productId: Number(raw.productId) } : {}), ...(raw.type !== undefined ? { type: raw.type } : {}),
      ...(raw.book !== undefined ? { book: raw.book } : {}), limit, offset,
    });
    return sendReport(reply, singleDate(raw.to ?? todayBusinessDate(), raw.format), out, tablesOf(out), 'stock-movements');
  });

  app.get('/reports/stock-losses', { schema: { querystring: periodSchema({ book: bookQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: StockBook };
    const q = parseReportQuery(request.query as Record<string, string>);
    const out = stockLossesReport(conn(), { from: q.from, to: q.to, granularity: q.granularity, ...(raw.book !== undefined ? { book: raw.book } : {}) });
    return sendReport(reply, q, out, tablesOf(out), 'stock-losses');
  });

  app.get('/reports/product-profitability', { schema: { querystring: periodSchema({ book: bookQuery, categoryId: intQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: StockBook; categoryId?: string };
    const q = parseReportQuery(request.query as Record<string, string>);
    const out = productProfitability(conn(), {
      from: q.from, to: q.to, ...(raw.book !== undefined ? { book: raw.book } : {}), ...(raw.categoryId !== undefined ? { categoryId: Number(raw.categoryId) } : {}),
    });
    return sendReport(reply, q, out, [out.table], 'product-profitability');
  });

  app.get('/reports/low-stock', { schema: { querystring: schema({ book: bookQuery, categoryId: intQuery, includeInactive: boolQuery, format: formatQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: StockBook; categoryId?: string; includeInactive?: string; format?: string };
    const out = lowStockReport(conn(), {
      ...(raw.book !== undefined ? { book: raw.book } : {}), ...(raw.categoryId !== undefined ? { categoryId: Number(raw.categoryId) } : {}),
      includeInactive: parseBool(raw.includeInactive) === true,
    });
    return sendReport(reply, singleDate(todayBusinessDate(), raw.format), out, [out.table], 'low-stock');
  });

  app.get('/reports/purchases', { schema: { querystring: periodSchema({ book: bookQuery, supplierId: intQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: StockBook; supplierId?: string };
    const q = parseReportQuery(request.query as Record<string, string>);
    const out = purchasesReport(conn(), {
      from: q.from, to: q.to, granularity: q.granularity, ...(raw.book !== undefined ? { book: raw.book } : {}),
      ...(raw.supplierId !== undefined ? { supplierId: Number(raw.supplierId) } : {}),
    });
    return sendReport(reply, q, out, tablesOf(out), 'purchases');
  });

  app.get('/reports/sales', { schema: { querystring: periodSchema({ book: bookQuery, topN: intQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: StockBook; topN?: string };
    const q = parseReportQuery(request.query as Record<string, string>);
    const topN = raw.topN !== undefined ? Number(raw.topN) : 10;
    if (topN < 1 || topN > 100) fail({ topN: 'must be between 1 and 100' });
    const out = salesReport(conn(), { from: q.from, to: q.to, granularity: q.granularity, topN, ...(raw.book !== undefined ? { book: raw.book } : {}) });
    return sendReport(reply, q, out, tablesOf(out), 'sales');
  });

  app.get('/reports/drawings', { schema: { querystring: periodSchema({ book: allBooksQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: Book };
    const q = parseReportQuery(request.query as Record<string, string>);
    const out = drawingsReport(conn(), { from: q.from, to: q.to, granularity: q.granularity, ...(raw.book !== undefined ? { book: raw.book } : {}) });
    return sendReport(reply, q, out, tablesOf(out), 'drawings');
  });

  app.get('/reports/printing-variance', { schema: { querystring: periodSchema() } }, async (request, reply) => {
    const q = parseReportQuery(request.query as Record<string, string>);
    const out = printingVarianceReport(conn(), { from: q.from, to: q.to, granularity: q.granularity });
    return sendReport(reply, q, out, tablesOf(out), 'printing-variance');
  });

  app.get('/reports/backdated', { schema: { querystring: periodSchema({ book: allBooksQuery, limit: intQuery, offset: intQuery }) } }, async (request, reply) => {
    const raw = request.query as { book?: Book; limit?: string; offset?: string };
    const q = parseReportQuery(request.query as Record<string, string>);
    const { limit, offset } = q.format === 'xlsx' ? { limit: MOVEMENTS_EXPORT_LIMIT, offset: 0 } : parsePaging(raw, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const out = backdatedReport(conn(), { from: q.from, to: q.to, limit, offset, ...(raw.book !== undefined ? { book: raw.book } : {}) });
    return sendReport(reply, q, out, [out.table], 'backdated-entries');
  });
}
