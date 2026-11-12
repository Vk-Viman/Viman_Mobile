/**
 * repositories/icecream.repo.ts - SQL for the Ice Cream business records (migration 014): daily entries and their item
 * lines, payments and fund moves, plus the read queries the rules need (posted facts, dated fund balances, fund ledger).
 *
 * Layer: repository (SQL only, no business rules). The records are never edited or deleted; a void marks
 * `status = 'void'` (R1) and the migration-014 triggers forbid every other change. `client_ref` is unique so a double
 * submit cannot create two rows. Every list is ordered by business date, then posting order (`posted_at`, `id`),
 * and totals count POSTED rows only (voided rows are shown, never summed).
 * The money itself lives in `cash_entries` and `icecream_fund_entries` (written through services/cash-posting.ts).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { IceFund } from './cash-entries.repo.ts';
import type { FundEntryRow } from './icecream-funds.repo.ts';
import { SQL_NOW_UTC, numberOrNull } from './sql-helpers.ts';
import type { IceFacts, PaymentKind } from '../services/icecream-rules.ts';

type N = number | bigint;
/** posted -> void only (R1). */
export type IceStatus = 'posted' | 'void';

// ---------------------------------------------------------------------------------------------
// daily entries
// ---------------------------------------------------------------------------------------------

/** One daily entry row. */
export interface DayRow {
  id: number; businessDate: string; postedAt: string; salesCents: number; costAllocCents: number; electricityAllocCents: number;
  profitShareCents: number; negativeConfirmed: boolean; notes: string; status: IceStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}
/** One item line of a daily entry. */
export interface DayItemRow { id: number; dayId: number; itemName: string; qty: number; unitPriceCents: number; lineTotalCents: number }

interface RawDay {
  id: N; business_date: string; posted_at: string; sales_cents: N; cost_alloc_cents: N; electricity_alloc_cents: N;
  profit_share_cents: N; negative_confirmed: N; notes: string; status: IceStatus; voided_at: string | null;
  void_reason: string | null; client_ref: string;
}
const DAY_SELECT = `SELECT id, business_date, posted_at, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents,
  negative_confirmed, notes, status, voided_at, void_reason, client_ref FROM icecream_days`;

function mapDay(r: RawDay): DayRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, salesCents: Number(r.sales_cents),
    costAllocCents: Number(r.cost_alloc_cents), electricityAllocCents: Number(r.electricity_alloc_cents),
    profitShareCents: Number(r.profit_share_cents), negativeConfirmed: Number(r.negative_confirmed) === 1, notes: r.notes,
    status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason, clientRef: r.client_ref,
  };
}

/** Adds a posted daily entry (the DB checks the sum, the date and one posted entry per date); returns its id. */
export function insertDay(conn: DatabaseSync, d: {
  businessDate: string; salesCents: number; costAllocCents: number; electricityAllocCents: number; profitShareCents: number;
  negativeConfirmed: boolean; notes: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO icecream_days (business_date, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents,
       negative_confirmed, notes, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(d.businessDate, d.salesCents, d.costAllocCents, d.electricityAllocCents, d.profitShareCents, d.negativeConfirmed ? 1 : 0,
    d.notes, d.clientRef);
  return Number(res.lastInsertRowid);
}

/** Adds the optional item lines of a daily entry. */
export function insertDayItems(conn: DatabaseSync, dayId: number,
  items: Array<{ itemName: string; qty: number; unitPriceCents: number; lineTotalCents: number }>): void {
  const st = conn.prepare(
    'INSERT INTO icecream_sales (icecream_day_id, item_name, qty, unit_price_cents, line_total_cents) VALUES (?, ?, ?, ?, ?)',
  );
  for (const i of items) st.run(dayId, i.itemName, i.qty, i.unitPriceCents, i.lineTotalCents);
}

/** The item lines of one daily entry, in entry order. */
export function listDayItems(conn: DatabaseSync, dayId: number): DayItemRow[] {
  const rows = conn.prepare(
    'SELECT id, icecream_day_id, item_name, qty, unit_price_cents, line_total_cents FROM icecream_sales WHERE icecream_day_id = ? ORDER BY id',
  ).all(dayId) as unknown as Array<{ id: N; icecream_day_id: N; item_name: string; qty: N; unit_price_cents: N; line_total_cents: N }>;
  return rows.map((r) => ({
    id: Number(r.id), dayId: Number(r.icecream_day_id), itemName: r.item_name, qty: Number(r.qty),
    unitPriceCents: Number(r.unit_price_cents), lineTotalCents: Number(r.line_total_cents),
  }));
}

/** One daily entry by id, or undefined. */
export function getDay(conn: DatabaseSync, id: number): DayRow | undefined {
  const r = conn.prepare(`${DAY_SELECT} WHERE id = ?`).get(id) as unknown as RawDay | undefined;
  return r ? mapDay(r) : undefined;
}

/** The daily entry saved under a `clientRef`, or undefined (duplicate-submission guard). */
export function getDayByClientRef(conn: DatabaseSync, clientRef: string): DayRow | undefined {
  const r = conn.prepare(`${DAY_SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as RawDay | undefined;
  return r ? mapDay(r) : undefined;
}

/** The POSTED daily entry of a business date (at most one, ux_icecream_days_posted), or undefined. */
export function getPostedDayByDate(conn: DatabaseSync, date: string): DayRow | undefined {
  const r = conn.prepare(`${DAY_SELECT} WHERE business_date = ? AND status = 'posted'`).get(date) as unknown as RawDay | undefined;
  return r ? mapDay(r) : undefined;
}

/** posted -> void; the DB triggers forbid anything else. voided_at is the DB clock. */
export function markDayVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE icecream_days SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/** Daily entries newest business date first; `totals` sum only POSTED rows that match the filters. */
export function listDays(conn: DatabaseSync, q: { from?: string; to?: string; status?: IceStatus; limit: number; offset: number }): {
  items: DayRow[]; total: number; totals: { salesCents: number; costAllocCents: number; electricityAllocCents: number; profitShareCents: number };
} {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN sales_cents END), 0) AS s,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN cost_alloc_cents END), 0) AS c,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN electricity_alloc_cents END), 0) AS e,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN profit_share_cents END), 0) AS p FROM icecream_days${w}`,
  ).get(...params) as unknown as { n: N; s: N; c: N; e: N; p: N };
  const rows = conn.prepare(`${DAY_SELECT}${w} ORDER BY business_date DESC, posted_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawDay[];
  return {
    items: rows.map(mapDay), total: Number(agg.n),
    totals: { salesCents: Number(agg.s), costAllocCents: Number(agg.c), electricityAllocCents: Number(agg.e), profitShareCents: Number(agg.p) },
  };
}

// ---------------------------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------------------------

/** One payment row. */
export interface PaymentRow {
  id: number; businessDate: string; postedAt: string; kind: PaymentKind; fund: IceFund; amountCents: number; category: string | null;
  description: string; status: IceStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}
interface RawPayment {
  id: N; business_date: string; posted_at: string; kind: PaymentKind; fund: IceFund; amount_cents: N; category: string | null;
  description: string; status: IceStatus; voided_at: string | null; void_reason: string | null; client_ref: string;
}
const PAY_SELECT = `SELECT id, business_date, posted_at, kind, fund, amount_cents, category, description, status, voided_at,
  void_reason, client_ref FROM icecream_payments`;

function mapPayment(r: RawPayment): PaymentRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, kind: r.kind, fund: r.fund,
    amountCents: Number(r.amount_cents), category: r.category, description: r.description, status: r.status,
    voidedAt: r.voided_at, voidReason: r.void_reason, clientRef: r.client_ref,
  };
}

/** Adds a posted payment; returns its id. */
export function insertPayment(conn: DatabaseSync, p: {
  businessDate: string; kind: PaymentKind; fund: IceFund; amountCents: number; category: string | null; description: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO icecream_payments (business_date, kind, fund, amount_cents, category, description, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.businessDate, p.kind, p.fund, p.amountCents, p.category, p.description, p.clientRef);
  return Number(res.lastInsertRowid);
}

/** One payment by id, or undefined. */
export function getPayment(conn: DatabaseSync, id: number): PaymentRow | undefined {
  const r = conn.prepare(`${PAY_SELECT} WHERE id = ?`).get(id) as unknown as RawPayment | undefined;
  return r ? mapPayment(r) : undefined;
}

/** The payment saved under a `clientRef`, or undefined. */
export function getPaymentByClientRef(conn: DatabaseSync, clientRef: string): PaymentRow | undefined {
  const r = conn.prepare(`${PAY_SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as RawPayment | undefined;
  return r ? mapPayment(r) : undefined;
}

/** posted -> void. */
export function markPaymentVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE icecream_payments SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/** Payments newest first; `totals.amountCents` sums only POSTED rows that match the filters. */
export function listPayments(conn: DatabaseSync, q: {
  from?: string; to?: string; kind?: PaymentKind; fund?: IceFund; status?: IceStatus; limit: number; offset: number;
}): { items: PaymentRow[]; total: number; amountCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.kind !== undefined) { where.push('kind = ?'); params.push(q.kind); }
  if (q.fund !== undefined) { where.push('fund = ?'); params.push(q.fund); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_cents END), 0) AS amt FROM icecream_payments${w}`,
  ).get(...params) as unknown as { n: N; amt: N };
  const rows = conn.prepare(`${PAY_SELECT}${w} ORDER BY business_date DESC, posted_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawPayment[];
  return { items: rows.map(mapPayment), total: Number(agg.n), amountCents: Number(agg.amt) };
}

// ---------------------------------------------------------------------------------------------
// fund moves
// ---------------------------------------------------------------------------------------------

/** One fund move row. */
export interface MoveRow {
  id: number; businessDate: string; postedAt: string; fromFund: IceFund; toFund: IceFund; amountCents: number;
  profitEffectCents: number; chargeRelabelCents: number; cashOnlyCents: number; note: string; status: IceStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}
interface RawMove {
  id: N; business_date: string; posted_at: string; from_fund: IceFund; to_fund: IceFund; amount_cents: N; profit_effect_cents: N;
  charge_relabel_cents: N; cash_only_cents: N; note: string; status: IceStatus; voided_at: string | null; void_reason: string | null;
  client_ref: string;
}
const MOVE_SELECT = `SELECT id, business_date, posted_at, from_fund, to_fund, amount_cents, profit_effect_cents, charge_relabel_cents,
  cash_only_cents, note, status, voided_at, void_reason, client_ref FROM icecream_fund_moves`;

function mapMove(r: RawMove): MoveRow {
  return {
    id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, fromFund: r.from_fund, toFund: r.to_fund,
    amountCents: Number(r.amount_cents), profitEffectCents: Number(r.profit_effect_cents),
    chargeRelabelCents: Number(r.charge_relabel_cents), cashOnlyCents: Number(r.cash_only_cents), note: r.note, status: r.status,
    voidedAt: r.voided_at, voidReason: r.void_reason, clientRef: r.client_ref,
  };
}

/** Adds a posted fund move (the DB checks the sign / split rules); returns its id. */
export function insertMove(conn: DatabaseSync, m: {
  businessDate: string; fromFund: IceFund; toFund: IceFund; amountCents: number; profitEffectCents: number;
  chargeRelabelCents: number; cashOnlyCents: number; note: string; clientRef: string;
}): number {
  const res = conn.prepare(
    `INSERT INTO icecream_fund_moves (business_date, from_fund, to_fund, amount_cents, profit_effect_cents, charge_relabel_cents,
       cash_only_cents, note, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.businessDate, m.fromFund, m.toFund, m.amountCents, m.profitEffectCents, m.chargeRelabelCents, m.cashOnlyCents, m.note, m.clientRef);
  return Number(res.lastInsertRowid);
}

/** One move by id, or undefined. */
export function getMove(conn: DatabaseSync, id: number): MoveRow | undefined {
  const r = conn.prepare(`${MOVE_SELECT} WHERE id = ?`).get(id) as unknown as RawMove | undefined;
  return r ? mapMove(r) : undefined;
}

/** The move saved under a `clientRef`, or undefined. */
export function getMoveByClientRef(conn: DatabaseSync, clientRef: string): MoveRow | undefined {
  const r = conn.prepare(`${MOVE_SELECT} WHERE client_ref = ?`).get(clientRef) as unknown as RawMove | undefined;
  return r ? mapMove(r) : undefined;
}

/** posted -> void. */
export function markMoveVoid(conn: DatabaseSync, id: number, reason: string): void {
  conn.prepare(`UPDATE icecream_fund_moves SET status = 'void', voided_at = ${SQL_NOW_UTC}, void_reason = ? WHERE id = ?`).run(reason, id);
}

/** Moves newest first; totals count only POSTED rows. */
export function listMoves(conn: DatabaseSync, q: {
  from?: string; to?: string; status?: IceStatus; limit: number; offset: number;
}): { items: MoveRow[]; total: number; totals: { amountCents: number; profitEffectCents: number; cashOnlyCents: number } } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  if (q.status !== undefined) { where.push('status = ?'); params.push(q.status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_cents END), 0) AS a,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN profit_effect_cents END), 0) AS p,
       COALESCE(SUM(CASE WHEN status = 'posted' THEN cash_only_cents END), 0) AS c FROM icecream_fund_moves${w}`,
  ).get(...params) as unknown as { n: N; a: N; p: N; c: N };
  const rows = conn.prepare(`${MOVE_SELECT}${w} ORDER BY business_date DESC, posted_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as RawMove[];
  return {
    items: rows.map(mapMove), total: Number(agg.n),
    totals: { amountCents: Number(agg.a), profitEffectCents: Number(agg.p), cashOnlyCents: Number(agg.c) },
  };
}

// ---------------------------------------------------------------------------------------------
// facts for the pure rules (icecream-rules.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Every POSTED record of the Ice Cream book as plain facts for the rules, ordered by posting order (`posted_at`, `id`)
 * - the order the limits, D4 splits and the D2 guard follow (10.6, section 12). Cash over/short comes from the fund
 * ledger (kind `cash_over_short` plus the reversal rows that cancel such a row), so a voided count nets to zero on its
 * own business date.
 */
export function loadFacts(conn: DatabaseSync): IceFacts {
  const days = conn.prepare(
    `SELECT id, business_date, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents FROM icecream_days
      WHERE status = 'posted' ORDER BY posted_at, id`,
  ).all() as unknown as Array<{ id: N; business_date: string; sales_cents: N; cost_alloc_cents: N; electricity_alloc_cents: N; profit_share_cents: N }>;
  const payments = conn.prepare(
    `SELECT id, business_date, kind, fund, amount_cents FROM icecream_payments WHERE status = 'posted' ORDER BY posted_at, id`,
  ).all() as unknown as Array<{ id: N; business_date: string; kind: PaymentKind; fund: IceFund; amount_cents: N }>;
  const moves = conn.prepare(
    `SELECT id, business_date, from_fund, to_fund, amount_cents, profit_effect_cents, charge_relabel_cents, cash_only_cents
       FROM icecream_fund_moves WHERE status = 'posted' ORDER BY posted_at, id`,
  ).all() as unknown as Array<{ id: N; business_date: string; from_fund: IceFund; to_fund: IceFund; amount_cents: N; profit_effect_cents: N;
    charge_relabel_cents: N; cash_only_cents: N }>;
  const overShort = conn.prepare(
    `SELECT business_date, SUM(amount_cents) AS t FROM icecream_fund_entries
      WHERE kind = 'cash_over_short'
         OR (kind = 'reversal' AND reverses_entry_id IN (SELECT id FROM icecream_fund_entries WHERE kind = 'cash_over_short'))
      GROUP BY business_date HAVING SUM(amount_cents) <> 0`,
  ).all() as unknown as Array<{ business_date: string; t: N }>;
  return {
    days: days.map((d) => ({
      id: Number(d.id), businessDate: d.business_date, salesCents: Number(d.sales_cents), costCents: Number(d.cost_alloc_cents),
      electricityCents: Number(d.electricity_alloc_cents), profitShareCents: Number(d.profit_share_cents),
    })),
    payments: payments.map((p) => ({
      id: Number(p.id), businessDate: p.business_date, kind: p.kind, fund: p.fund, amountCents: Number(p.amount_cents),
    })),
    moves: moves.map((m) => ({
      id: Number(m.id), businessDate: m.business_date, fromFund: m.from_fund, toFund: m.to_fund, amountCents: Number(m.amount_cents),
      profitEffectCents: Number(m.profit_effect_cents), chargeRelabelCents: Number(m.charge_relabel_cents), cashOnlyCents: Number(m.cash_only_cents),
    })),
    overShort: overShort.map((o) => ({ businessDate: o.business_date, amountCents: Number(o.t) })),
  };
}

// ---------------------------------------------------------------------------------------------
// fund ledger reads
// ---------------------------------------------------------------------------------------------

/** Fund balances of the rows dated on or before `asOf` (all rows when omitted). Business date decides (R7, 10.6). */
export function fundBalancesAsOf(conn: DatabaseSync, asOf?: string): Record<IceFund, number> {
  const out: Record<IceFund, number> = { cost: 0, electricity: 0, profit: 0 };
  const rows = (asOf === undefined
    ? conn.prepare('SELECT fund, COALESCE(SUM(amount_cents), 0) AS t FROM icecream_fund_entries GROUP BY fund').all()
    : conn.prepare('SELECT fund, COALESCE(SUM(amount_cents), 0) AS t FROM icecream_fund_entries WHERE business_date <= ? GROUP BY fund').all(asOf)
  ) as unknown as Array<{ fund: IceFund; t: N }>;
  for (const r of rows) out[r.fund] = Number(r.t);
  return out;
}

/** Ice Cream cash book balance of the entries dated on or before `asOf` (all when omitted). */
export function iceCashBalanceAsOf(conn: DatabaseSync, asOf?: string): number {
  const r = (asOf === undefined
    ? conn.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM cash_entries WHERE book = 'icecream'").get()
    : conn.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM cash_entries WHERE book = 'icecream' AND business_date <= ?").get(asOf)
  ) as unknown as { t: N };
  return Number(r.t);
}

/** The complete fund ledger (reversals included) for a filter, oldest first, paged; totals cover the whole filter. */
export function listFundEntries(conn: DatabaseSync, q: {
  fund?: IceFund; from?: string; to?: string; limit: number; offset: number;
}): { items: FundEntryRow[]; total: number; inCents: number; outCents: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.fund !== undefined) { where.push('fund = ?'); params.push(q.fund); }
  if (q.from !== undefined) { where.push('business_date >= ?'); params.push(q.from); }
  if (q.to !== undefined) { where.push('business_date <= ?'); params.push(q.to); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const agg = conn.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS i,
            COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS o FROM icecream_fund_entries${w}`,
  ).get(...params) as unknown as { n: N; i: N; o: N };
  const rows = conn.prepare(
    `SELECT id, business_date, posted_at, fund, amount_cents, kind, ref_table, ref_id, reverses_entry_id, note FROM icecream_fund_entries${w}
      ORDER BY business_date, posted_at, id LIMIT ? OFFSET ?`,
  ).all(...params, q.limit, q.offset) as unknown as Array<{
    id: N; business_date: string; posted_at: string; fund: IceFund; amount_cents: N; kind: FundEntryRow['kind'];
    ref_table: string | null; ref_id: N | null; reverses_entry_id: N | null; note: string | null;
  }>;
  return {
    items: rows.map((r) => ({
      id: Number(r.id), businessDate: r.business_date, postedAt: r.posted_at, fund: r.fund, amountCents: Number(r.amount_cents),
      kind: r.kind, refTable: r.ref_table, refId: numberOrNull(r.ref_id), reversesEntryId: numberOrNull(r.reverses_entry_id), note: r.note,
    })),
    total: Number(agg.n), inCents: Number(agg.i), outCents: Number(agg.o),
  };
}
