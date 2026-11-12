/**
 * services/reports/pnl-icecream.ts - Ice Cream profit and loss per period (BUSINESS_RULES 10.3, 10.5, 10.6, E3, E4, C4).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only).
 *
 * This file does NOT calculate any Ice Cream rule. It loads the posted records once (`loadFacts`) and asks the pure
 * Phase 10 module (`periodReport` in services/icecream-rules.ts) for every row, so the reports can never drift from the
 * Funds screen and the write rules:
 *   Sales - Materials (allocated) - Electricity (allocated, whole shop) - other costs paid from the Profit Fund
 *   +/- cash over/short = RECOGNIZED PROFIT (the official figure), plus the period's "excess cost not yet charged"
 *   (a flow, 10.6) and "profit after excess cost". Balances (unspent allocation, outstanding excess) are as of the
 *   period end and are never summed. The actual bills paid are a memo only (E4); electricity is charged once (E3).
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import { loadFacts } from '../../repositories/icecream.repo.ts';
import { excessCostWarning } from '../icecream.service.ts';
import type { ExcessCostWarning } from '../icecream.service.ts';
import { periodReport } from '../icecream-rules.ts';
import type { IceFacts, PeriodReport } from '../icecream-rules.ts';
import type { PeriodRow } from './fin-common.ts';
import type { PeriodQuery } from './pnl-shop.ts';

/** The figures of one Ice Cream report row: exactly the rules module's `PeriodReport` (API_CONTRACTS `/reports/pnl/icecream`). */
export type IceFigures = PeriodReport;

/** The full answer of `GET /reports/pnl/icecream`. */
export interface IceCreamPnlReport {
  segment: 'icecream'; from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<IceFigures>>;
  /** The report over the whole range; its `balancesAsOfPeriodEnd` are the balances at `to`. */
  totals: IceFigures; table: ReportTable; warnings: ExcessCostWarning[];
}

/**
 * The D3 warning (10.5) for a report that ends at `to`: present only when outstanding excess cost at `to` is above zero.
 * The "after this excess cost it would be ..." amount is the recognized profit up to `to` minus the outstanding excess,
 * the same wording the Funds summary uses.
 */
export function excessWarnings(facts: IceFacts, to: string): ExcessCostWarning[] {
  const upToEnd = periodReport(facts, undefined, to);
  const outstanding = upToEnd.balancesAsOfPeriodEnd.outstandingExcessCostCents;
  return outstanding > 0 ? [excessCostWarning(outstanding, to, upToEnd.recognizedProfitCents - outstanding)] : [];
}

/** One report row per period from already-loaded facts (also used by the Combined report and the funds report). */
export function iceRows(facts: IceFacts, periods: readonly Period[]): Array<PeriodRow<IceFigures>> {
  return periods.map((period) => ({ period, ...periodReport(facts, period.from, period.to) }));
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'sales', label: 'Sales', kind: 'money' },
  { key: 'materials', label: 'Materials (allocated)', kind: 'money' },
  { key: 'electricity', label: 'Electricity (allocated)', kind: 'money' },
  { key: 'other', label: 'Other ice-cream expenses', kind: 'money' },
  { key: 'overShort', label: 'Cash over / short', kind: 'money' },
  { key: 'recognized', label: 'Recognized profit', kind: 'money' },
  { key: 'excess', label: 'Excess cost not yet charged', kind: 'money' },
  { key: 'afterExcess', label: 'Profit after excess cost', kind: 'money' },
  { key: 'actualMaterials', label: 'Memo: materials paid', kind: 'money' },
  { key: 'actualElectricity', label: 'Memo: electricity bills paid', kind: 'money' },
  { key: 'otherFromCostElec', label: 'Memo: other costs from Cost/Electricity funds', kind: 'money' },
  { key: 'unspent', label: 'Unspent allocation at period end', kind: 'money' },
  { key: 'outstanding', label: 'Outstanding excess cost at period end', kind: 'money' },
];

function flat(label: string, f: IceFigures): Record<string, ReportCell> {
  return {
    period: label, sales: f.salesCents, materials: f.materialsChargeCents, electricity: f.electricityChargeCents,
    other: f.otherExpensesCents, overShort: f.cashOverShortCents, recognized: f.recognizedProfitCents,
    excess: f.excessCostNotChargedCents, afterExcess: f.profitAfterExcessCostCents,
    actualMaterials: f.memo.actualMaterialsPaidCents, actualElectricity: f.memo.actualElectricityPaidCents,
    otherFromCostElec: f.memo.otherCostsFromCostElecFundsCents, unspent: f.balancesAsOfPeriodEnd.unspentCents,
    outstanding: f.balancesAsOfPeriodEnd.outstandingExcessCostCents,
  };
}

/** Notes shared by the Ice Cream P&L and the Combined P&L tables (10.5, 10.6, E3, E4). */
export const ICECREAM_NOTES: string[] = [
  'Recognized profit is the official Ice Cream profit: sales - materials allocated - electricity allocated - other costs paid from the Profit Fund +/- cash over/short.',
  'Materials and electricity are the daily ALLOCATIONS (movements dated in the period). Paying a supplier or the electricity bill settles them and is never a second expense.',
  'Excess cost not yet charged is the change in uncovered excess during the period; a negative figure means earlier excess is now covered. Official profit is never reduced automatically.',
  'Unspent allocation and outstanding excess cost are balances at the period end and are not added up across rows (the total row shows the balance at the end date).',
];

/**
 * Ice Cream profit and loss for a date range: one row per period plus the whole-range total, all from `periodReport`.
 * Warns (`EXCESS_COST_OUTSTANDING`) when excess cost is outstanding at the end date.
 */
export function icecreamPnl(conn: DatabaseSync, q: PeriodQuery): IceCreamPnlReport {
  const facts = loadFacts(conn);
  const periods = listPeriods(q.from, q.to, q.granularity);
  const rows = iceRows(facts, periods);
  const totals = periodReport(facts, q.from, q.to);
  const table: ReportTable = {
    title: 'Ice Cream profit and loss', columns: COLUMNS, rows: rows.map((r) => flat(r.period.label, r)),
    totals: flat('Total', totals), notes: ICECREAM_NOTES,
  };
  return { segment: 'icecream', from: q.from, to: q.to, granularity: q.granularity, rows, totals, table, warnings: excessWarnings(facts, q.to) };
}
