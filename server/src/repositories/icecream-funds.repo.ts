/**
 * repositories/icecream-funds.repo.ts - SQL for `icecream_fund_entries`, the append-only Ice Cream fund ledger.
 *
 * Layer: repository (SQL only, no business rules). BUSINESS_RULES section 10: the Ice Cream cash book is split
 * into the Cost, Electricity and Profit funds; a fund's balance is the sum of its rows. Rows are never edited or
 * deleted (R1, migration 012 triggers): a void adds a `reversal` row that points back at the original. Every
 * Ice Cream cash movement writes one cash entry AND one fund row of the same amount in one transaction; only a
 * fund move (A -x, B +x) writes fund rows without cash (it nets to zero, so the invariant still holds).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { IceFund } from './cash-entries.repo.ts';
import { numberOrNull } from './sql-helpers.ts';

/** The three funds in their display order. */
export const ICE_FUNDS: readonly IceFund[] = ['cost', 'electricity', 'profit'];

/** Why a fund row exists (migration 012 CHECK list). */
export type FundEntryKind = 'daily_allocation' | 'payment' | 'fund_move' | 'drawing' | 'transfer_out' | 'transfer_in'
  | 'opening_balance' | 'capital' | 'cash_over_short' | 'reversal';

/** One fund ledger row. */
export interface FundEntryRow {
  id: number; businessDate: string; postedAt: string; fund: IceFund; amountCents: number; kind: FundEntryKind;
  refTable: string | null; refId: number | null; reversesEntryId: number | null; note: string | null;
}

interface Raw {
  id: number | bigint; business_date: string; posted_at: string; fund: IceFund; amount_cents: number | bigint;
  kind: FundEntryKind; ref_table: string | null; ref_id: number | bigint | null; reverses_entry_id: number | bigint | null;
  note: string | null;
}

const SELECT = `SELECT id, business_date, posted_at, fund, amount_cents, kind, ref_table, ref_id, reverses_entry_id, note
  FROM icecream_fund_entries`;

function map(r: Raw): FundEntryRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, fund: r.fund, amountCents: Number(r.amount_cents),
    kind: r.kind, refTable: r.ref_table, refId: numberOrNull(r.ref_id), reversesEntryId: numberOrNull(r.reverses_entry_id),
    note: r.note,
  };
}

/** Appends a fund row (posted_at is the DB clock). @returns The new row id. */
export function insertFundEntry(conn: DatabaseSync, e: {
  businessDate: string; fund: IceFund; amountCents: number; kind: FundEntryKind; refTable: string | null; refId: number | null;
  reversesEntryId?: number | null; note?: string | null;
}): number {
  const res = conn.prepare(
    `INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind, ref_table, ref_id, reverses_entry_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.businessDate, e.fund, e.amountCents, e.kind, e.refTable, e.refId, e.reversesEntryId ?? null, e.note ?? null);
  return Number(res.lastInsertRowid);
}

/** Every fund row written for one source record (e.g. 'cash_counts', 7), oldest first. */
export function findFundEntriesByRef(conn: DatabaseSync, refTable: string, refId: number): FundEntryRow[] {
  const rows = conn.prepare(`${SELECT} WHERE ref_table = ? AND ref_id = ? ORDER BY id`).all(refTable, refId) as unknown as Raw[];
  return rows.map(map);
}

/** Balance of each fund in cents (sum of all its rows), all dates. */
export function fundBalances(conn: DatabaseSync): Record<IceFund, number> {
  const out: Record<IceFund, number> = { cost: 0, electricity: 0, profit: 0 };
  const rows = conn.prepare('SELECT fund, COALESCE(SUM(amount_cents), 0) AS total FROM icecream_fund_entries GROUP BY fund')
    .all() as unknown as Array<{ fund: IceFund; total: number | bigint }>;
  for (const r of rows) out[r.fund] = Number(r.total);
  return out;
}

/** Opening / in / out / closing of every fund for a period (`from`/`to` are business dates, either may be omitted). */
export function fundPeriodTotals(conn: DatabaseSync, from: string | undefined, to: string | undefined): Record<IceFund, {
  openingCents: number; inCents: number; outCents: number; closingCents: number;
}> {
  const out = {} as Record<IceFund, { openingCents: number; inCents: number; outCents: number; closingCents: number }>;
  for (const fund of ICE_FUNDS) {
    const opening = from === undefined ? 0 : Number((conn.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS t FROM icecream_fund_entries WHERE fund = ? AND business_date < ?',
    ).get(fund, from) as unknown as { t: number | bigint }).t);
    const where = ['fund = ?'];
    const params: Array<string> = [fund];
    if (from !== undefined) { where.push('business_date >= ?'); params.push(from); }
    if (to !== undefined) { where.push('business_date <= ?'); params.push(to); }
    const r = conn.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS i,
              COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS o
         FROM icecream_fund_entries WHERE ${where.join(' AND ')}`,
    ).get(...params) as unknown as { i: number | bigint; o: number | bigint };
    const inCents = Number(r.i);
    const outCents = Number(r.o);
    out[fund] = { openingCents: opening, inCents, outCents, closingCents: opening + inCents - outCents };
  }
  return out;
}

/** Sum of every fund row (all funds, all dates): one side of the Σ funds = Ice Cream cash book invariant. */
export function fundTotal(conn: DatabaseSync): number {
  const r = conn.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM icecream_fund_entries').get() as unknown as { t: number | bigint };
  return Number(r.t);
}
