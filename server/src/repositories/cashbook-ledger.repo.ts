/**
 * repositories/cashbook-ledger.repo.ts - read-only SQL for the cash book screens (BUSINESS_RULES section 8).
 *
 * Layer: repository (SQL only, no business rules). The ledger is `cash_entries` ordered by BUSINESS DATE and then
 * id (posting order within a day); reports follow business dates (R7). The running balance of a row is
 * `opening + SUM(amount of every row of the period up to and including this row)`, computed with a window function
 * over the WHOLE period before paging, so every page continues exactly where the previous one stopped.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CashBook, CashEntryRow } from './cash-entries.repo.ts';
import { numberOrNull } from './sql-helpers.ts';

type N = number | bigint;

/** A ledger row plus the running balance after it. */
export interface LedgerRow extends CashEntryRow { runningBalanceCents: number }

/** Totals of a period: `openingCents` = ledger balance before `from`; in/out are positive numbers. */
export interface PeriodTotals { openingCents: number; inCents: number; outCents: number; closingCents: number; count: number }

function periodWhere(book: CashBook, from: string | undefined, to: string | undefined): { sql: string; params: SQLInputValue[] } {
  const where = ['book = ?'];
  const params: SQLInputValue[] = [book];
  if (from !== undefined) { where.push('business_date >= ?'); params.push(from); }
  if (to !== undefined) { where.push('business_date <= ?'); params.push(to); }
  return { sql: where.join(' AND '), params };
}

/** Opening balance (rows dated before `from`), money in, money out and closing balance of a book for a period. */
export function periodTotals(conn: DatabaseSync, book: CashBook, from: string | undefined, to: string | undefined): PeriodTotals {
  const opening = from === undefined ? 0 : Number((conn.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS t FROM cash_entries WHERE book = ? AND business_date < ?',
  ).get(book, from) as unknown as { t: N }).t);
  const w = periodWhere(book, from, to);
  const r = conn.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS i,
            COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS o
       FROM cash_entries WHERE ${w.sql}`,
  ).get(...w.params) as unknown as { n: N; i: N; o: N };
  const inCents = Number(r.i);
  const outCents = Number(r.o);
  return { openingCents: opening, inCents, outCents, closingCents: opening + inCents - outCents, count: Number(r.n) };
}

interface RawLedger {
  id: N; book: CashBook; business_date: string; posted_at: string; type: string; amount_cents: N;
  fund: 'cost' | 'electricity' | 'profit' | null; ref_table: string | null; ref_id: N | null; transfer_id: N | null;
  reverses_entry_id: N | null; note: string | null; running: N;
}

/**
 * One page of the ledger of a period with the running balance after each row (business date, then id).
 *
 * @param openingCents Balance before the period (from `periodTotals`), the start of the running sum.
 */
export function ledgerPage(
  conn: DatabaseSync, book: CashBook, from: string | undefined, to: string | undefined, openingCents: number,
  limit: number, offset: number,
): LedgerRow[] {
  const w = periodWhere(book, from, to);
  const rows = conn.prepare(
    `SELECT id, book, business_date, posted_at, type, amount_cents, fund, ref_table, ref_id, transfer_id, reverses_entry_id, note,
            ? + SUM(amount_cents) OVER (ORDER BY business_date, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
       FROM cash_entries WHERE ${w.sql}
      ORDER BY business_date, id LIMIT ? OFFSET ?`,
  ).all(openingCents, ...w.params, limit, offset) as unknown as RawLedger[];
  return rows.map((r) => ({
    id: Number(r.id), book: r.book, businessDate: r.business_date, postedAt: r.posted_at, type: r.type,
    amountCents: Number(r.amount_cents), fund: r.fund, refTable: r.ref_table, refId: numberOrNull(r.ref_id),
    transferId: numberOrNull(r.transfer_id), reversesEntryId: numberOrNull(r.reverses_entry_id), note: r.note,
    runningBalanceCents: Number(r.running),
  }));
}
