/**
 * routes/report-common.ts - shared query handling and response sending for every report endpoint.
 *
 * Layer: route helper. All Phase 11 report routes use this so that `from`/`to` validation, the day/month
 * granularity switch and the JSON-or-Excel answer behave identically everywhere.
 *
 * Rules protected: report dates are business dates and are never rejected for being in the future (BUSINESS_RULES
 * 12: R-FD applies to writes only); `from > to` or a range over MAX_REPORT_DAYS is a 400.
 */
import type { FastifyReply } from 'fastify';
import { AppError } from '../lib/errors.ts';
import { isIsoDate } from '../lib/dates.ts';
import { MAX_REPORT_DAYS, daysInRange, reportTablesToXlsx } from '../lib/report-table.ts';
import type { Granularity, ReportTable } from '../lib/report-table.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Query-string schema parts shared by the period reports. */
export const reportQueryProps = {
  from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  granularity: { type: 'string', enum: ['day', 'month'] },
  format: { type: 'string', enum: ['json', 'xlsx'] },
} as const;

/** The validated period parameters of a report request. */
export interface ReportQuery { from: string; to: string; granularity: Granularity; format: 'json' | 'xlsx' }

/**
 * Validates the common query parameters.
 * @throws AppError 400 VALIDATION_ERROR for a missing/impossible date, from > to, or a range above MAX_REPORT_DAYS.
 */
export function parseReportQuery(raw: { from?: string; to?: string; granularity?: string; format?: string }): ReportQuery {
  const fields: Record<string, string> = {};
  if (raw.from === undefined) fields.from = 'Start date is required.';
  else if (!isIsoDate(raw.from)) fields.from = 'Not a real date (use YYYY-MM-DD).';
  if (raw.to === undefined) fields.to = 'End date is required.';
  else if (!isIsoDate(raw.to)) fields.to = 'Not a real date (use YYYY-MM-DD).';
  if (Object.keys(fields).length === 0 && raw.from! > raw.to!) fields.from = 'The start date cannot be after the end date.';
  if (Object.keys(fields).length === 0 && daysInRange(raw.from!, raw.to!) > MAX_REPORT_DAYS) {
    fields.to = `A report can cover at most ${MAX_REPORT_DAYS} days.`;
  }
  if (Object.keys(fields).length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the report dates.', fields);
  return {
    from: raw.from!, to: raw.to!,
    granularity: raw.granularity === 'month' ? 'month' : 'day',
    format: raw.format === 'xlsx' ? 'xlsx' : 'json',
  };
}

/**
 * Sends a report: the JSON body for the screen, or an .xlsx download built from the same figures.
 * @param tables the tables written to the workbook when `format = 'xlsx'`.
 * @param filename download name without extension.
 */
export async function sendReport(reply: FastifyReply, q: ReportQuery, json: unknown, tables: ReportTable[], filename: string): Promise<FastifyReply> {
  if (q.format === 'xlsx') {
    const buf = await reportTablesToXlsx(tables);
    return reply.header('content-type', XLSX_TYPE).header('content-disposition', `attachment; filename="${filename}-${q.from}_${q.to}.xlsx"`).send(buf);
  }
  return reply.send(json);
}
