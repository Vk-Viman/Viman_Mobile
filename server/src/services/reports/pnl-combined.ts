/**
 * services/reports/pnl-combined.ts - Combined profit and loss = Shop + Telecom + Ice Cream recognized (BUSINESS_RULES 0, 1, 7 E5, 10.5, 10.6, C3).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only). Segments are disjoint (section 0), so the
 * combined official profit is simply the sum of the three segment profits, each taken from its own report function:
 *   Shop net profit + Telecom net profit + Ice Cream RECOGNIZED profit  (never the profit-after-excess figure).
 *
 * Informational lines that are NEVER added to or deducted from any profit (E5, C3):
 *  - electricity charged in the period (the Ice Cream electricity allocation: the whole shop's bill is carried there),
 *  - electricity bills actually paid in the period (memo; a settlement, E4).
 * Excess cost (D3, 10.5): the Ice Cream period flow `excessCostNotChargedCents` and `combinedProfitAfterExcessCostCents`
 * (= combined recognized profit - that flow) are shown beside the official figure; `outstandingExcessCostCents` is the
 * balance at the period end and is never summed.
 *
 * JSON shape per row: `recognizedProfitCents` (combined, official) and `segments.{shop,telecom,icecream}.recognizedProfitCents`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import { loadFacts } from '../../repositories/icecream.repo.ts';
import type { ExcessCostWarning } from '../icecream.service.ts';
import { periodReport } from '../icecream-rules.ts';
import type { IceFacts } from '../icecream-rules.ts';
import { wholePeriod } from './fin-common.ts';
import type { PeriodRow } from './fin-common.ts';
import { ICECREAM_NOTES, excessWarnings } from './pnl-icecream.ts';
import { shopFigures } from './pnl-shop.ts';
import type { PeriodQuery } from './pnl-shop.ts';
import { telecomFigures } from './pnl-telecom.ts';

/** The figures of one Combined report row. */
export interface CombinedFigures {
  segments: {
    shop: { recognizedProfitCents: number };
    telecom: { recognizedProfitCents: number };
    icecream: { recognizedProfitCents: number };
  };
  /** Combined OFFICIAL profit = Shop + Telecom + Ice Cream recognized. */
  recognizedProfitCents: number;
  /** E5 informational line: Ice Cream electricity charged in the period (never added or deducted). */
  electricityChargedCents: number;
  /** E5 memo: electricity bills actually paid in the period. */
  electricityBillsPaidCents: number;
  /** Ice Cream excess cost not yet charged: the period change (10.6, may be negative). */
  icecreamExcessCostNotChargedCents: number;
  /** Combined recognized profit - the excess-cost flow. */
  combinedProfitAfterExcessCostCents: number;
  /** Balance at the period end (never summed). */
  outstandingExcessCostCents: number;
}

/** The full answer of `GET /reports/pnl/combined`. */
export interface CombinedPnlReport {
  segment: 'combined'; from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<CombinedFigures>>; totals: CombinedFigures; table: ReportTable; warnings: ExcessCostWarning[];
}

/** Combined figures for each period from already-loaded Ice Cream facts. */
export function combinedFigures(conn: DatabaseSync, facts: IceFacts, periods: readonly Period[]): CombinedFigures[] {
  const shop = shopFigures(conn, periods);
  const telecom = telecomFigures(conn, periods);
  return periods.map((p, i) => {
    const ice = periodReport(facts, p.from, p.to);
    const recognized = shop[i]!.netProfitCents + telecom[i]!.netProfitCents + ice.recognizedProfitCents;
    return {
      segments: {
        shop: { recognizedProfitCents: shop[i]!.netProfitCents },
        telecom: { recognizedProfitCents: telecom[i]!.netProfitCents },
        icecream: { recognizedProfitCents: ice.recognizedProfitCents },
      },
      recognizedProfitCents: recognized,
      electricityChargedCents: ice.electricityChargeCents,
      electricityBillsPaidCents: ice.memo.actualElectricityPaidCents,
      icecreamExcessCostNotChargedCents: ice.excessCostNotChargedCents,
      combinedProfitAfterExcessCostCents: recognized - ice.excessCostNotChargedCents,
      outstandingExcessCostCents: ice.balancesAsOfPeriodEnd.outstandingExcessCostCents,
    };
  });
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'shop', label: 'Shop profit', kind: 'money' },
  { key: 'telecom', label: 'Telecom profit', kind: 'money' },
  { key: 'icecream', label: 'Ice Cream recognized profit', kind: 'money' },
  { key: 'combined', label: 'Combined recognized profit (official)', kind: 'money' },
  { key: 'excess', label: 'Ice Cream excess cost not yet charged', kind: 'money' },
  { key: 'afterExcess', label: 'Combined profit after excess cost', kind: 'money' },
  { key: 'electricityCharged', label: 'Info: electricity charged (not added)', kind: 'money' },
  { key: 'electricityPaid', label: 'Info: electricity bills paid (memo)', kind: 'money' },
  { key: 'outstanding', label: 'Outstanding excess cost at period end', kind: 'money' },
];

function flat(label: string, f: CombinedFigures): Record<string, ReportCell> {
  return {
    period: label, shop: f.segments.shop.recognizedProfitCents, telecom: f.segments.telecom.recognizedProfitCents,
    icecream: f.segments.icecream.recognizedProfitCents, combined: f.recognizedProfitCents,
    excess: f.icecreamExcessCostNotChargedCents, afterExcess: f.combinedProfitAfterExcessCostCents,
    electricityCharged: f.electricityChargedCents, electricityPaid: f.electricityBillsPaidCents, outstanding: f.outstandingExcessCostCents,
  };
}

const COMBINED_NOTES: string[] = [
  'Combined profit = Shop profit + Telecom profit + Ice Cream recognized profit. The three segments never overlap.',
  'The electricity lines are information only: the whole shop electricity bill is carried by the Ice Cream book and is never added to or deducted from any profit here (E5).',
  ...ICECREAM_NOTES.slice(2),
];

/**
 * Combined profit and loss for a date range (rows add up to the totals row; balances such as outstanding excess cost are
 * as of the period end). Warns when Ice Cream excess cost is outstanding at the end date (10.5).
 */
export function combinedPnl(conn: DatabaseSync, q: PeriodQuery): CombinedPnlReport {
  const facts = loadFacts(conn);
  const periods = listPeriods(q.from, q.to, q.granularity);
  const figs = combinedFigures(conn, facts, periods);
  const totals = combinedFigures(conn, facts, [wholePeriod(q.from, q.to)])[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));
  const table: ReportTable = {
    title: 'Combined profit and loss', columns: COLUMNS, rows: rows.map((r) => flat(r.period.label, r)),
    totals: flat('Total', totals), notes: COMBINED_NOTES,
  };
  return { segment: 'combined', from: q.from, to: q.to, granularity: q.granularity, rows, totals, table, warnings: excessWarnings(facts, q.to) };
}
