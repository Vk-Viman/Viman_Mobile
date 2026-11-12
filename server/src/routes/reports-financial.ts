/**
 * routes/reports-financial.ts - HTTP endpoints for the financial reports (profit and loss, cash books, transfers, Ice Cream funds).
 *
 * Layer: route (thin): JSON-schema validation of the query -> `parseReportQuery` -> the report service -> JSON or .xlsx.
 * Reports are READ-ONLY (no writes, no audit rows) and every date is a business date that may be in the future
 * (R-FD applies to transactions only). The figures and rules live in `services/reports/*`.
 *
 *   GET /reports/pnl/shop | telecom | icecream | combined   ?from&to&granularity=day|month&format=json|xlsx
 *   GET /reports/cashbook/:book                              per period opening / in / out / closing, by type, Ice Cream by fund
 *   GET /reports/transfers                                   posted transfers with totals by direction
 *   GET /reports/icecream-funds                              fund statement + recognized profit block (kept apart)
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import type { ReportTable } from '../lib/report-table.ts';
import type { CashBook } from '../repositories/cash-entries.repo.ts';
import { cashbookReport } from '../services/reports/cashbook-report.ts';
import { icecreamFundsReport } from '../services/reports/icecream-funds-report.ts';
import { combinedPnl } from '../services/reports/pnl-combined.ts';
import { icecreamPnl } from '../services/reports/pnl-icecream.ts';
import { shopPnl } from '../services/reports/pnl-shop.ts';
import type { PeriodQuery } from '../services/reports/pnl-shop.ts';
import { telecomPnl } from '../services/reports/pnl-telecom.ts';
import { transfersReport } from '../services/reports/transfers-report.ts';
import { parseReportQuery, reportQueryProps, sendReport } from './report-common.ts';
import type { ReportQuery } from './report-common.ts';

const periodQuerySchema = { type: 'object', additionalProperties: false, properties: reportQueryProps } as const;
const bookParams = {
  type: 'object', additionalProperties: false, required: ['book'],
  properties: { book: { type: 'string', enum: ['shop', 'telecom', 'icecream'] } },
} as const;

type RawQuery = { from?: string; to?: string; granularity?: string; format?: string };

/** The service-level request from a validated report query. */
const toPeriodQuery = (q: ReportQuery): PeriodQuery => ({ from: q.from, to: q.to, granularity: q.granularity });

/** Registers the financial report endpoints under the `/api/v1` prefix. */
export function registerFinancialReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** One P&L endpoint: validate, compute, answer JSON or Excel (the workbook carries the same table plus its notes). */
  const pnl = (path: string, filename: string, run: (q: PeriodQuery) => { table: ReportTable }) => {
    app.get(path, { schema: { querystring: periodQuerySchema } }, async (request, reply) => {
      const q = parseReportQuery(request.query as RawQuery);
      const report = run(toPeriodQuery(q));
      return sendReport(reply, q, report, [report.table], filename);
    });
  };
  const conn = () => ctx.database.conn;
  pnl('/reports/pnl/shop', 'shop-profit-and-loss', (q) => shopPnl(conn(), q));
  pnl('/reports/pnl/telecom', 'telecom-profit-and-loss', (q) => telecomPnl(conn(), q));
  pnl('/reports/pnl/icecream', 'icecream-profit-and-loss', (q) => icecreamPnl(conn(), q));
  pnl('/reports/pnl/combined', 'combined-profit-and-loss', (q) => combinedPnl(conn(), q));

  app.get('/reports/cashbook/:book', { schema: { querystring: periodQuerySchema, params: bookParams } }, async (request, reply) => {
    const q = parseReportQuery(request.query as RawQuery);
    const book = (request.params as { book: CashBook }).book;
    const report = cashbookReport(conn(), book, toPeriodQuery(q));
    const tables = [report.table, report.typeTable, ...(report.fundTable ? [report.fundTable] : [])];
    return sendReport(reply, q, report, tables, `${book}-cash-book`);
  });

  app.get('/reports/transfers', { schema: { querystring: periodQuerySchema } }, async (request, reply) => {
    const q = parseReportQuery(request.query as RawQuery);
    const report = transfersReport(conn(), toPeriodQuery(q));
    return sendReport(reply, q, report, [report.table, report.itemsTable], 'cash-transfers');
  });

  app.get('/reports/icecream-funds', { schema: { querystring: periodQuerySchema } }, async (request, reply) => {
    const q = parseReportQuery(request.query as RawQuery);
    const report = icecreamFundsReport(conn(), toPeriodQuery(q));
    return sendReport(reply, q, report, [report.table, report.profitTable], 'icecream-funds');
  });
}
