/**
 * routes/dashboard.ts - HTTP endpoints for the dashboard and the "export pack" workbook (Phase 12).
 *
 * Layer: route (thin): JSON-schema validation of the query -> service -> JSON or .xlsx. Both endpoints are READ-ONLY (no writes,
 * no audit rows) and every date is a business date that may be in the past or the future (R-FD applies to transactions only).
 *
 *   GET /dashboard?asOf=YYYY-MM-DD            tiles, series, cash, stock, Ice Cream, closings, backup, warnings (one call)
 *   GET /reports/export-pack?from&to          one .xlsx with the main reports for the range (<= 3,660 days)
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { reportTablesToXlsx } from '../lib/report-table.ts';
import { buildDashboard, resolveAsOf } from '../services/dashboard.service.ts';
import { exportPackTables } from '../services/dashboard-export.ts';
import { parseReportQuery } from './report-common.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const dashboardQuery = {
  type: 'object', additionalProperties: false, properties: { asOf: { type: 'string', pattern: DATE_PATTERN } },
} as const;
const packQuery = {
  type: 'object', additionalProperties: false,
  properties: { from: { type: 'string', pattern: DATE_PATTERN }, to: { type: 'string', pattern: DATE_PATTERN } },
} as const;

/** Registers the dashboard endpoints under the `/api/v1` prefix. */
export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/dashboard', { schema: { querystring: dashboardQuery } }, async (request) => {
    const asOf = resolveAsOf((request.query as { asOf?: string }).asOf);
    return buildDashboard(ctx, asOf);
  });

  app.get('/reports/export-pack', { schema: { querystring: packQuery } }, async (request, reply) => {
    const q = parseReportQuery(request.query as { from?: string; to?: string });
    // One transaction so every sheet describes the same instant (same reason as the dashboard).
    const tables = ctx.database.tx((conn) => exportPackTables(conn, q.from, q.to));
    const buf = await reportTablesToXlsx(tables);
    return reply.header('content-type', XLSX_TYPE)
      .header('content-disposition', `attachment; filename="viman-export-pack-${q.from}_${q.to}.xlsx"`).send(buf);
  });
}
