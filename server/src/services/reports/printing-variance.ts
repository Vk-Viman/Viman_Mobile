/**
 * services/reports/printing-variance.ts - Printing: standard cost charged vs actual supplies spent, plus revenue and profit by service type.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only.
 *
 * Rules protected (BUSINESS_RULES section 6, R12):
 *  - Standard cost charged = SUM(`print_sales.cogs_cents`) of posted print sales (the cost snapshot on each sale);
 *    revenue - standard cost = gross profit, and THAT is what the Shop P&L uses.
 *  - Actual supplies spent = SUM(`printing_supplies.amount_cents`) of posted supply purchases (paper, toner). Supplies are
 *    a cash-out and are NEVER a P&L item; this report is the only place they are compared with the standard cost.
 *  - Variance = actual supplies spent - standard cost charged, per period (positive = more was spent on supplies than the
 *    sales charged for; the opposite = supplies bought earlier are still being used up). Supplies are bought in lumps,
 *    so a single day can look odd; the range total is the meaningful figure.
 *  - Only `status = 'posted'` rows count (R1); each row uses only records dated inside its period (R7).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Granularity, ReportTable } from '../../lib/report-table.ts';
import { addInto, fillPeriods, marginBp, num, numericOnly, periodKeySql } from './ops-common.ts';
import type { ReportWarning, SqlRow } from './ops-common.ts';

/** Request: dates and granularity. */
export interface PrintingQuery { from: string; to: string; granularity: Granularity }

/** Figures of one period (cents; `pages` and counts are plain numbers). */
export interface PrintingFigures {
  salesCount: number; pages: number; revenueCents: number; standardCostChargedCents: number; grossProfitCents: number;
  suppliesSpentCents: number; supplyCount: number; varianceCents: number;
}

/** One service type over the whole range. */
export interface ServiceTypeLine {
  serviceTypeId: number; code: string; name: string; salesCount: number; pages: number;
  revenueCents: number; standardCostCents: number; grossProfitCents: number; marginBp: number | null;
}

/** Report body. */
export interface PrintingReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<{ period: { from: string; to: string; label: string } } & PrintingFigures>;
  totals: PrintingFigures;
  byServiceType: ServiceTypeLine[];
  table: ReportTable; extraTables: ReportTable[]; warnings: ReportWarning[];
}

const zero = (): PrintingFigures => ({
  salesCount: 0, pages: 0, revenueCents: 0, standardCostChargedCents: 0, grossProfitCents: 0, suppliesSpentCents: 0, supplyCount: 0, varianceCents: 0,
});

/** Printing variance report for [from, to]. */
export function printingVarianceReport(conn: DatabaseSync, q: PrintingQuery): PrintingReport {
  const byLabel = new Map<string, PrintingFigures>();
  const at = (k: string): PrintingFigures => { let x = byLabel.get(k); if (!x) { x = zero(); byLabel.set(k, x); } return x; };
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('business_date', q.granularity)} AS k, COUNT(*) AS n, SUM(qty) AS pages, SUM(revenue_cents) AS rev, SUM(cogs_cents) AS cogs
       FROM print_sales WHERE status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY k`,
  ).all(q.from, q.to) as unknown as SqlRow[]) {
    const x = at(String(r.k));
    x.salesCount = num(r.n); x.pages = num(r.pages); x.revenueCents = num(r.rev); x.standardCostChargedCents = num(r.cogs);
  }
  for (const r of conn.prepare(
    `SELECT ${periodKeySql('business_date', q.granularity)} AS k, COUNT(*) AS n, SUM(amount_cents) AS t
       FROM printing_supplies WHERE status = 'posted' AND business_date BETWEEN ? AND ? GROUP BY k`,
  ).all(q.from, q.to) as unknown as SqlRow[]) { const x = at(String(r.k)); x.supplyCount = num(r.n); x.suppliesSpentCents = num(r.t); }
  for (const x of byLabel.values()) {
    x.grossProfitCents = x.revenueCents - x.standardCostChargedCents;
    x.varianceCents = x.suppliesSpentCents - x.standardCostChargedCents;
  }
  const rows = fillPeriods(q.from, q.to, q.granularity, byLabel, zero);
  const totals = zero();
  for (const r of rows) addInto(totals, r);

  const byServiceType = (conn.prepare(
    `SELECT t.id, t.code, t.name, COUNT(*) AS n, SUM(ps.qty) AS pages, SUM(ps.revenue_cents) AS rev, SUM(ps.cogs_cents) AS cogs
       FROM print_sales ps JOIN print_service_types t ON t.id = ps.service_type_id
      WHERE ps.status = 'posted' AND ps.business_date BETWEEN ? AND ? GROUP BY t.id ORDER BY rev DESC, t.name`,
  ).all(q.from, q.to) as unknown as SqlRow[]).map((r): ServiceTypeLine => ({
    serviceTypeId: num(r.id), code: String(r.code), name: String(r.name), salesCount: num(r.n), pages: num(r.pages), revenueCents: num(r.rev),
    standardCostCents: num(r.cogs), grossProfitCents: num(r.rev) - num(r.cogs), marginBp: marginBp(num(r.rev) - num(r.cogs), num(r.rev)),
  }));

  const m = (key: string, label: string) => ({ key, label, kind: 'money' as const });
  const table: ReportTable = {
    title: 'Printing variance',
    columns: [
      { key: 'period', label: 'Period', kind: 'text' }, { key: 'salesCount', label: 'Print sales', kind: 'int' }, { key: 'pages', label: 'Pages', kind: 'int' },
      m('revenueCents', 'Revenue'), m('standardCostChargedCents', 'Standard cost charged'), m('grossProfitCents', 'Gross profit'),
      m('suppliesSpentCents', 'Supplies spent'), m('varianceCents', 'Variance (spent - charged)'),
    ],
    rows: rows.map((r) => ({ period: r.period.label, ...numericOnly(r) })),
    totals: { period: 'Total', ...numericOnly(totals) },
    notes: [
      'Gross profit uses the standard cost charged on each sale. Supplies (paper, toner) are cash spent and are NOT part of profit.',
      'Variance = supplies actually spent minus standard cost charged. Supplies are bought in lumps, so look at the whole period, not single days.',
    ],
  };
  const extraTables: ReportTable[] = [{
    title: 'By service type',
    columns: [{ key: 'name', label: 'Service', kind: 'text' }, { key: 'salesCount', label: 'Print sales', kind: 'int' }, { key: 'pages', label: 'Pages', kind: 'int' },
      m('revenueCents', 'Revenue'), m('standardCostCents', 'Standard cost'), m('grossProfitCents', 'Gross profit'), { key: 'marginBp', label: 'Margin', kind: 'percent' }],
    rows: byServiceType.map((s) => ({ name: s.name, salesCount: s.salesCount, pages: s.pages, revenueCents: s.revenueCents, standardCostCents: s.standardCostCents, grossProfitCents: s.grossProfitCents, marginBp: s.marginBp })),
  }];
  return { from: q.from, to: q.to, granularity: q.granularity, rows, totals, byServiceType, table, extraTables, warnings: [] };
}
