/**
 * services/reports/ops-common.ts - small pieces shared by the operational reports (Phase 11, agent B).
 *
 * Layer: service helper (pure functions and SQL fragments; no database writes, no rules of its own).
 * Why it exists: every operational report groups business records by report period (a day or a calendar month)
 * and fills empty periods with zeros, so rows add up exactly to the total (BUSINESS_RULES 10.6 period rule).
 * One place builds the period key and the empty rows, so no report has its own copy of that logic.
 *
 * Rules protected here: reports follow the BUSINESS date, never the posting time (R7); money is integer cents and
 * rates are basis points (section 0); only `status = 'posted'` business rows are ever summed by the callers (R1).
 */
import { mulDivRound } from '../../lib/money.ts';
import { listPeriods } from '../../lib/report-table.ts';
import type { Granularity, Period } from '../../lib/report-table.ts';

/** The three cash books (section 0). Stock lives only in `shop` and `telecom`. */
export type Book = 'shop' | 'telecom' | 'icecream';
/** The two stock-holding books. */
export type StockBook = 'shop' | 'telecom';

/** One warning line shown above a report (same `{ code, message }` shape the rest of the app uses). */
export interface ReportWarning { code: string; message: string }

/**
 * SQL expression that turns a business-date column into the label of its report period: the date itself for a
 * day row, `YYYY-MM` for a month row (these are exactly the labels `listPeriods` produces).
 * The column name is a trusted constant from the calling report, never user input.
 */
export function periodKeySql(column: string, granularity: Granularity): string {
  return granularity === 'month' ? `substr(${column}, 1, 7)` : column;
}

/**
 * Builds one row per period of [from, to] (days or months, clipped to the range) from grouped SQL results.
 * Why: a period without any records must still appear, as zeros, so the table has no gaps and additivity holds.
 *
 * @param byLabel grouped figures keyed by period label (`YYYY-MM-DD` or `YYYY-MM`)
 * @param zero    makes the all-zero figures of an empty period
 */
export function fillPeriods<T extends object>(
  from: string, to: string, granularity: Granularity, byLabel: Map<string, T>, zero: () => T,
): Array<{ period: Period } & T> {
  return listPeriods(from, to, granularity).map((period) => ({ period, ...(byLabel.get(period.label) ?? zero()) }));
}

/** Adds every numeric figure of `row` into `acc` (used to build totals so rows sum to the total by construction). */
export function addInto(acc: object, row: object): void {
  const a = acc as Record<string, unknown>;
  const r = row as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (typeof a[k] === 'number') a[k] = (a[k] as number) + (typeof r[k] === 'number' ? (r[k] as number) : 0);
  }
}

/** Margin in basis points = round(profit x 10000 / revenue); null when revenue is 0 (a margin of nothing is not shown). */
export function marginBp(profitCents: number, revenueCents: number): number | null {
  return revenueCents > 0 ? mulDivRound(profitCents, 10000, revenueCents) : null;
}

/** `n` as a plain number from a node:sqlite value (integers can arrive as bigint). */
export function num(v: unknown): number {
  return Number(v ?? 0);
}

/** A grouped-SQL row as node:sqlite hands it back. */
export type SqlRow = Record<string, number | bigint | string | null>;

/** Keeps only the numeric figures of a report row (drops `period`, nested objects, labels) so it can fill a table row. */
export function numericOnly(o: object): Record<string, number> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
}
