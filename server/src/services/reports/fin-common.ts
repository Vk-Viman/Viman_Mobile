/**
 * services/reports/fin-common.ts - shared building blocks of the Phase 11 financial reports.
 *
 * Layer: report helper (read-only; no writes, no audit rows). Every financial report needs the same three things:
 *  1. the list of report periods (day or calendar-month rows, BUSINESS_RULES 10.6 period rule),
 *  2. a way to add up database rows into those periods WITHOUT a query per period (grouped SQL by business date,
 *     then one pass in memory - a one-year day-by-day report is a handful of queries, never 365+),
 *  3. a few small figure helpers (period row type, table totals).
 *
 * Rules protected: every row is calculated ONLY from records whose business date lies inside the row's period
 * (10.6), so rows are additive; `status = 'posted'` filtering is done by the callers' SQL (R1: voided rows and
 * reversal rows never appear in profit figures).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Period } from '../../lib/report-table.ts';

/** One report row = its period plus the figures of that period. */
export type PeriodRow<F> = { period: Period } & F;

/**
 * Finds the index of the period that contains a business date. Periods are contiguous and sorted, so a binary
 * search on `from` is enough. Returns -1 for a date outside every period (callers' SQL already restricts the range,
 * so this only guards against programming errors).
 */
export function periodIndex(periods: readonly Period[], date: string): number {
  let lo = 0;
  let hi = periods.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = periods[mid]!;
    if (date < p.from) hi = mid - 1;
    else if (date > p.to) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Runs ONE grouped query and adds each result row into the period it belongs to.
 *
 * @param sql   a SELECT returning `d` (the business date, usually grouped) and numeric columns named in `keys`;
 *              it must already restrict to `from..to` of the whole report.
 * @param keys  the numeric result columns to add up.
 * @returns     one record per period (all keys present, zero when nothing happened) - same order as `periods`.
 */
export function sumByPeriod<K extends string>(
  conn: DatabaseSync, periods: readonly Period[], sql: string, params: SQLInputValue[], keys: readonly K[],
): Array<Record<K, number>> {
  const out = periods.map(() => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>);
  const rows = conn.prepare(sql).all(...params) as unknown as Array<Record<string, number | bigint | string | null>>;
  for (const r of rows) {
    const i = periodIndex(periods, r.d as string);
    if (i < 0) continue;
    const bucket = out[i]!;
    for (const k of keys) bucket[k] += Number(r[k] ?? 0);
  }
  return out;
}

/**
 * Like `sumByPeriod`, but the query also returns a text column `g` (a group such as an expense category or an
 * entry type); the result is a map group -> per-period values.
 */
export function sumByPeriodAndGroup<K extends string>(
  conn: DatabaseSync, periods: readonly Period[], sql: string, params: SQLInputValue[], keys: readonly K[],
): Map<string, Array<Record<K, number>>> {
  const out = new Map<string, Array<Record<K, number>>>();
  const rows = conn.prepare(sql).all(...params) as unknown as Array<Record<string, number | bigint | string | null>>;
  for (const r of rows) {
    const i = periodIndex(periods, r.d as string);
    if (i < 0) continue;
    const g = String(r.g);
    let arr = out.get(g);
    if (!arr) {
      arr = periods.map(() => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>);
      out.set(g, arr);
    }
    const bucket = arr[i]!;
    for (const k of keys) bucket[k] += Number(r[k] ?? 0);
  }
  return out;
}

/** The whole requested range as ONE period (used to compute the totals row exactly like a row). */
export function wholePeriod(from: string, to: string): Period {
  return { from, to, label: `${from} to ${to}` };
}

/** Sum of numeric field `pick(row)` over rows - for additivity helpers. */
export function sumOf<T>(rows: readonly T[], pick: (r: T) => number): number {
  let s = 0;
  for (const r of rows) s += pick(r);
  return s;
}

/** `0 - x` instead of `-x`, so a zero never becomes negative zero in JSON/Excel. */
export const neg = (x: number): number => 0 - x;
