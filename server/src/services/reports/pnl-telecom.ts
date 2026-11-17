/**
 * services/reports/pnl-telecom.ts - Telecom profit and loss per period (BUSINESS_RULES 1, 5, 7, 11, C4, R14).
 *
 * Layer: report service (pure function `(conn, query) => figures`, read-only).
 *
 *   Telecom net profit = reload commission (base + rounding extra) + EZCash commission + scratch-card gross profit
 *                        - telecom operating expenses - stock adjustments (net) +/- cash over/short.
 *
 * Why: Telecom revenue is COMMISSION ONLY (section 5). The full reload collections, EZCash bill collections and the
 * provider/wallet top-ups are cash movements, never revenue or cost (R14: the Telecom cash book will not reconcile to
 * Telecom profit - there is no float tracking, an owner decision). They are shown below as memo lines, not added.
 * Scratch cards are ordinary stock products (book `telecom`): revenue minus automatic and extra cost, net of returns.
 * There is never an electricity expense here (E2). The SQL and type mapping live in fin-queries.ts.
 *
 * Telecom segments (BUSINESS_RULES 13D): the report keeps its `rows` / `totals` / `table` (the whole Telecom book, unchanged) and ADDS
 * `telecomSegments[]`, one figures block per segment (the eight provider x kind segments, then `legacy` only when it has activity),
 * and `segmentTable` (lines x segments + Total). Every row is a plain filter of the same formulas, so a Reloads segment is
 * commission + extra - expenses +/- over/short and a Cards segment is card sales - cost (automatic + extra) - adjustments - expenses
 * +/- over/short without a second formula. `segmentsMatchTotal` proves that the Telecom total equals the sum of the blocks for
 * EVERY numeric field. An optional `segment` limits the whole report to that segment.
 */
import type { DatabaseSync } from 'node:sqlite';
import { listPeriods } from '../../lib/report-table.ts';
import type { Period, ReportCell, ReportColumn, ReportTable } from '../../lib/report-table.ts';
import { wholePeriod } from './fin-common.ts';
import type { PeriodRow, SegmentFilter } from './fin-common.ts';
import { SEGMENT_LABEL, TELECOM_SEGMENTS } from '../segments.ts';
import type { StoredSegment } from '../segments.ts';
import {
  adjustmentsByPeriod, commissionsByPeriod, expensesByPeriod, overShortByPeriod, salesByPeriod, topupsByPeriod,
} from './fin-queries.ts';
import type { AdjustmentFigures, CommissionFigures, ExpenseFigures, SalesFigures } from './fin-queries.ts';
import type { PeriodQuery } from './pnl-shop.ts';
import type { Granularity } from '../../lib/report-table.ts';

/** The figures of one Telecom report row. */
export interface TelecomFigures {
  commissions: CommissionFigures;
  /** Reload commission + EZCash commission. */
  commissionRevenueCents: number;
  /** Scratch-card sales, cost and gross profit (net of returns). */
  cards: SalesFigures;
  /** Commission revenue + card gross profit. */
  grossProfitCents: number;
  expenses: ExpenseFigures;
  adjustments: AdjustmentFigures;
  cashOverShortCents: number;
  netProfitCents: number;
  /** Cash-only memo (never added to profit, R14). */
  memo: { providerTopupsCents: number; walletTopupsCents: number };
}

/** The figures of ONE Telecom segment: its rows per period and its total over the range. */
export interface TelecomSegmentBlock {
  segment: StoredSegment; label: string; kind: 'cards' | 'reloads' | 'legacy';
  rows: Array<PeriodRow<TelecomFigures>>; totals: TelecomFigures;
}

/** The full answer of `GET /reports/pnl/telecom`. */
export interface TelecomPnlReport {
  /** The report family (kept): always `'telecom'`. The Telecom dimension is `telecomSegments` / `filterSegment`. */
  segment: 'telecom'; from: string; to: string; granularity: Granularity;
  rows: Array<PeriodRow<TelecomFigures>>; totals: TelecomFigures; table: ReportTable; warnings: never[];
  /** The segment the whole report is limited to, or null for the whole Telecom book. */
  filterSegment: StoredSegment | null;
  /** One block per segment (legacy last, only when it has activity); a segment filter leaves only that block. */
  telecomSegments: TelecomSegmentBlock[];
  /** Lines x segments + Total (the transposed table also written to the Excel file). */
  segmentTable: ReportTable;
  /** True when every numeric field of the total equals the sum of the segment blocks (always true; a false value is a bug). */
  segmentsMatchTotal: boolean;
}

/**
 * Figures for each of the given periods (constant number of grouped queries).
 * @param filter optional `{ segment }`: only the records of that Telecom segment (no filter = the whole Telecom book).
 */
export function telecomFigures(conn: DatabaseSync, periods: readonly Period[], filter?: SegmentFilter): TelecomFigures[] {
  const comm = commissionsByPeriod(conn, periods, filter);
  const cards = salesByPeriod(conn, periods, 'telecom', filter);
  const expenses = expensesByPeriod(conn, periods, 'telecom', filter);
  const adjustments = adjustmentsByPeriod(conn, periods, 'telecom', filter);
  const overShort = overShortByPeriod(conn, periods, 'telecom', filter);
  const topups = topupsByPeriod(conn, periods, filter);
  return periods.map((_, i) => {
    const commissionRevenue = comm[i]!.reloadCommissionCents + comm[i]!.ezcashCommissionCents;
    const gross = commissionRevenue + cards[i]!.grossProfitCents;
    return {
      commissions: comm[i]!, commissionRevenueCents: commissionRevenue, cards: cards[i]!, grossProfitCents: gross,
      expenses: expenses[i]!, adjustments: adjustments[i]!, cashOverShortCents: overShort[i]!,
      netProfitCents: gross - expenses[i]!.totalCents - adjustments[i]!.netCents + overShort[i]!, memo: topups[i]!,
    };
  });
}

const COLUMNS: ReportColumn[] = [
  { key: 'period', label: 'Period', kind: 'text' },
  { key: 'reloadBase', label: 'Reload commission', kind: 'money' },
  { key: 'reloadExtra', label: 'Reload rounding extra', kind: 'money' },
  { key: 'ezcash', label: 'EZCash commission', kind: 'money' },
  { key: 'cardRevenue', label: 'Scratch-card sales (net)', kind: 'money' },
  { key: 'cardCost', label: 'Card cost (auto + extra)', kind: 'money' },
  { key: 'cardProfit', label: 'Card gross profit', kind: 'money' },
  { key: 'expenses', label: 'Operating expenses', kind: 'money' },
  { key: 'adjustments', label: 'Stock adjustments (net)', kind: 'money' },
  { key: 'purchaseRefundGain', label: 'Purchase refund above stock value removed (R4)', kind: 'money' },
  { key: 'salesReturnVoidGain', label: 'Void-return stock value gain (R-VR)', kind: 'money' },
  { key: 'overShort', label: 'Cash over / short', kind: 'money' },
  { key: 'netProfit', label: 'Net profit', kind: 'money' },
  { key: 'reloadSales', label: 'Memo: reload collections', kind: 'money' },
  { key: 'ezcashBills', label: 'Memo: EZCash bills collected', kind: 'money' },
  { key: 'topups', label: 'Memo: provider + wallet top-ups', kind: 'money' },
];

function flat(label: string, f: TelecomFigures): Record<string, ReportCell> {
  return {
    period: label, reloadBase: f.commissions.reloadBaseCommissionCents, reloadExtra: f.commissions.reloadExtraCents,
    ezcash: f.commissions.ezcashCommissionCents, cardRevenue: f.cards.revenueCents, cardCost: f.cards.costOfSalesCents,
    cardProfit: f.cards.grossProfitCents, expenses: f.expenses.totalCents, adjustments: f.adjustments.netCents, purchaseRefundGain: f.adjustments.purchaseRefundGainCents,
    salesReturnVoidGain: f.adjustments.salesReturnVoidGainCents,
    overShort: f.cashOverShortCents, netProfit: f.netProfitCents, reloadSales: f.commissions.reloadSalesCents,
    ezcashBills: f.commissions.ezcashBillCents, topups: f.memo.providerTopupsCents + f.memo.walletTopupsCents,
  };
}

/** Plain-language notes printed under the table and in the Excel file. */
export const TELECOM_NOTES: string[] = [
  'Telecom income is commission only: reload commission (with any rounding extra) and EZCash commission.',
  'Full reload collections, EZCash bill collections and provider/wallet top-ups are cash movements, not income or cost (memo columns).',
  'The Telecom cash book does not reconcile to Telecom profit because reload float is not tracked (owner decision, R14).',
  'Stock adjustments (net) = losses + stocktake losses + residual sweeps - stocktake gains - purchase refund gain (R4: cash refunded above the stock value removed, shown on its own line) - void-return stock value gain (R-VR, shown on its own line).',
  'Scratch cards are stock products: sales minus automatic and extra cost, net of returns (a voided return is not counted).',
  'There is no electricity expense in Telecom: the whole shop electricity bill is carried by the Ice Cream book.',
];

/** Every numeric leaf of a figures record as `path -> value` (nested objects flattened), used to compare and add figures generically. */
function leaves(o: unknown, prefix = '', out: Map<string, number> = new Map()): Map<string, number> {
  if (typeof o === 'number') out.set(prefix, o);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** True when the figures contain any non-zero number (a segment without activity is not shown, legacy in particular). */
function hasActivity(f: TelecomFigures): boolean {
  for (const v of leaves(f).values()) if (v !== 0) return true;
  return false;
}

/** True when `total` equals the sum of `parts` for EVERY numeric field (the Telecom total = the sum of its segments). */
export function figuresEqualSum(total: TelecomFigures, parts: readonly TelecomFigures[]): boolean {
  const t = leaves(total);
  const sums = new Map<string, number>([...t.keys()].map((k) => [k, 0]));
  for (const part of parts) for (const [k, v] of leaves(part)) sums.set(k, (sums.get(k) ?? 0) + v);
  for (const [k, v] of sums) if ((t.get(k) ?? 0) !== v) return false;
  return true;
}

const SEGMENT_LINES: Array<{ key: string; label: string; pick: (f: TelecomFigures) => number }> = COLUMNS.filter((c) => c.key !== 'period').map((c) => ({
  key: c.key, label: c.label, pick: (f: TelecomFigures) => Number(flat('', f)[c.key]),
}));

/** The transposed table: one row per line, one column per segment, plus the Telecom Total. */
function segmentTableOf(blocks: readonly TelecomSegmentBlock[], total: TelecomFigures, filtered: boolean): ReportTable {
  const columns: ReportColumn[] = [
    { key: 'line', label: 'Line', kind: 'text' },
    ...blocks.map((b): ReportColumn => ({ key: b.segment, label: b.label, kind: 'money' })),
    { key: 'total', label: filtered ? 'Total (this segment)' : 'Telecom total', kind: 'money' },
  ];
  const rows = SEGMENT_LINES.map((l) => {
    const row: Record<string, ReportCell> = { line: l.label };
    for (const b of blocks) row[b.segment] = l.pick(b.totals);
    row.total = l.pick(total);
    return row;
  });
  return {
    title: 'Telecom P&L by segment', columns, rows,
    notes: [
      'Each column is one Telecom segment (provider and Reloads / Cards); the last column is the whole Telecom book and equals the sum of the segment columns for every line.',
      'Reloads segments: commission + rounding extra - expenses +/- cash over/short. Cards segments: card sales - cost (automatic + extra) - stock adjustments - expenses +/- cash over/short.',
      ...(blocks.some((b) => b.segment === 'legacy') ? ['"Telecom before segments" holds everything recorded before the segments existed (read-only).'] : []),
    ],
  };
}

/**
 * Telecom profit and loss for a date range (rows add up to the totals row; see `shopPnl`).
 *
 * @param segment optional: limit the whole report (rows, totals, table) to one Telecom segment (`legacy` is accepted).
 */
export function telecomPnl(conn: DatabaseSync, q: PeriodQuery, segment?: StoredSegment): TelecomPnlReport {
  const periods = listPeriods(q.from, q.to, q.granularity);
  const whole = wholePeriod(q.from, q.to);
  const filter: SegmentFilter = segment ? { segment } : {};
  const figs = telecomFigures(conn, periods, filter);
  const totals = telecomFigures(conn, [whole], filter)[0]!;
  const rows = periods.map((period, i) => ({ period, ...figs[i]! }));

  const wanted: StoredSegment[] = segment ? [segment] : [...TELECOM_SEGMENTS, 'legacy'];
  const blocks: TelecomSegmentBlock[] = [];
  for (const code of wanted) {
    const f = telecomFigures(conn, [...periods, whole], { segment: code });
    const blockTotals = f.pop()!;
    if (code === 'legacy' && !segment && !hasActivity(blockTotals)) continue; // legacy only when it has activity
    blocks.push({
      segment: code, label: SEGMENT_LABEL[code], kind: code === 'legacy' ? 'legacy' : code.endsWith('_cards') ? 'cards' : 'reloads',
      rows: periods.map((period, i) => ({ period, ...f[i]! })), totals: blockTotals,
    });
  }
  const segmentsMatchTotal = figuresEqualSum(totals, blocks.map((b) => b.totals))
    && rows.every((r, i) => figuresEqualSum(r, blocks.map((b) => b.rows[i]!)));
  const table: ReportTable = {
    title: 'Telecom profit and loss', columns: COLUMNS, rows: rows.map((r) => flat(r.period.label, r)),
    totals: flat('Total', totals), notes: TELECOM_NOTES,
  };
  return {
    segment: 'telecom', from: q.from, to: q.to, granularity: q.granularity, rows, totals, table, warnings: [],
    filterSegment: segment ?? null, telecomSegments: blocks, segmentTable: segmentTableOf(blocks, totals, segment !== undefined), segmentsMatchTotal,
  };
}
