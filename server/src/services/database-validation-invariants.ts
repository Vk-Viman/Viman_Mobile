/**
 * services/database-validation-invariants.ts - business-consistency checks of the backup validation (finding M7).
 *
 * Each function is an independent, read-only check that takes an open connection (always a trial copy that has been
 * upgraded to the current version) and returns the failures it found (an empty list = the check passed). The SQL is
 * written independently of the reports and services: it reads the ledgers directly, like the audit's own reconcilers.
 * Money is integer cents. Messages are written for the shop owner; `detail` holds a few concrete examples.
 */
import type { DatabaseSync } from 'node:sqlite';
import { todayBusinessDate } from '../lib/dates.ts';

/** One failed check, in plain language. */
export interface ValidationFailure { code: string; message: string; detail?: string }

type Row = Record<string, unknown>;
const all = (conn: DatabaseSync, sql: string, ...p: (string | number)[]): Row[] => conn.prepare(sql).all(...p) as unknown as Row[];
const num = (v: unknown): number => Number(v ?? 0);
const one = (conn: DatabaseSync, sql: string, ...p: (string | number)[]): number => num(Object.values(all(conn, sql, ...p)[0] ?? {})[0]);
const plural = (n: number, one1: string, many: string): string => `${n} ${n === 1 ? one1 : many}`;
const sample = (items: string[], max = 3): string => items.slice(0, max).join('; ') + (items.length > max ? `; and ${items.length - max} more` : '');

/** Stock cache of every product equals the sum of its movements (quantity and value); nothing is negative. */
export function checkStock(conn: DatabaseSync): ValidationFailure[] {
  const bad: string[] = [];
  const neg: string[] = [];
  for (const r of all(conn, `SELECT p.id, p.name, p.qty_on_hand q, p.stock_value_cents v,
      COALESCE((SELECT SUM(qty_delta) FROM stock_movements m WHERE m.product_id = p.id), 0) mq,
      COALESCE((SELECT SUM(value_delta_cents) FROM stock_movements m WHERE m.product_id = p.id), 0) mv FROM products p ORDER BY p.id`)) {
    if (num(r.q) !== num(r.mq) || num(r.v) !== num(r.mv)) {
      bad.push(`${r.name}: stock shows ${num(r.q)} (value ${num(r.v)}) but its history adds up to ${num(r.mq)} (value ${num(r.mv)})`);
    }
    if (num(r.q) < 0 || num(r.v) < 0) neg.push(`${r.name}: ${num(r.q)} in stock, value ${num(r.v)}`);
  }
  const orphans = one(conn, 'SELECT COUNT(*) FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = m.product_id)');
  const out: ValidationFailure[] = [];
  if (bad.length) {
    out.push({ code: 'stock_reconciliation', message: `Stock quantities in the file do not match its stock history for ${plural(bad.length, 'product', 'products')}.`, detail: sample(bad) });
  }
  if (neg.length) {
    out.push({ code: 'stock_reconciliation', message: `The file shows negative stock for ${plural(neg.length, 'product', 'products')}.`, detail: sample(neg) });
  }
  if (orphans) {
    out.push({ code: 'stock_reconciliation', message: `The file has ${plural(orphans, 'stock movement', 'stock movements')} that belong to no product.` });
  }
  return out;
}

/** Reversal rows of the cash ledger and the Ice Cream fund ledger negate an existing original; none is reversed twice. */
export function checkCashLedger(conn: DatabaseSync): ValidationFailure[] {
  const bad: string[] = [];
  for (const r of all(conn, `SELECT c.id, c.amount_cents a, o.id oid, o.amount_cents oa, c.business_date d, o.business_date od, c.book, o.book ob,
      c.fund, o.fund ofund, c.ref_table rt, o.ref_table ort, c.ref_id ri, o.ref_id ori, c.type, o.type otype, o.reverses_entry_id oreverses
      FROM cash_entries c LEFT JOIN cash_entries o ON o.id = c.reverses_entry_id WHERE c.reverses_entry_id IS NOT NULL`)) {
    const id = `cash entry ${r.id}`;
    if (r.oid === null) { bad.push(`${id} reverses an entry that does not exist`); continue; }
    if (num(r.a) !== -num(r.oa)) bad.push(`${id} (${num(r.a)}) does not cancel its original (${num(r.oa)})`);
    if (r.d !== r.od) bad.push(`${id} is dated ${r.d} but its original is dated ${r.od}`);
    if (r.book !== r.ob) bad.push(`${id} is in another cash book than its original`);
    if ((r.fund ?? null) !== (r.ofund ?? null)) bad.push(`${id} is in another fund than its original`);
    if (r.rt !== r.ort || num(r.ri) !== num(r.ori)) bad.push(`${id} belongs to another record than its original`);
    if (r.type !== r.otype) bad.push(`${id} is of another type than its original`);
    if (r.oreverses !== null) bad.push(`${id} reverses another reversal`);
  }
  for (const r of all(conn, `SELECT c.id, c.amount_cents a, o.id oid, o.amount_cents oa, c.business_date d, o.business_date od, c.fund, o.fund ofund,
      c.ref_table rt, o.ref_table ort, c.ref_id ri, o.ref_id ori
      FROM icecream_fund_entries c LEFT JOIN icecream_fund_entries o ON o.id = c.reverses_entry_id WHERE c.reverses_entry_id IS NOT NULL`)) {
    const id = `Ice Cream fund entry ${r.id}`;
    if (r.oid === null) { bad.push(`${id} reverses an entry that does not exist`); continue; }
    if (num(r.a) !== -num(r.oa)) bad.push(`${id} (${num(r.a)}) does not cancel its original (${num(r.oa)})`);
    if (r.d !== r.od) bad.push(`${id} is dated ${r.d} but its original is dated ${r.od}`);
    if (r.fund !== r.ofund) bad.push(`${id} is in another fund than its original`);
    if (r.rt !== r.ort || num(r.ri) !== num(r.ori)) bad.push(`${id} belongs to another record than its original`);
  }
  for (const t of ['cash_entries', 'icecream_fund_entries']) {
    for (const r of all(conn, `SELECT reverses_entry_id id, COUNT(*) n FROM ${t} WHERE reverses_entry_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1`)) {
      bad.push(`${t === 'cash_entries' ? 'cash entry' : 'Ice Cream fund entry'} ${r.id} was reversed ${r.n} times`);
    }
  }
  if (!bad.length) return [];
  return [{ code: 'cash_ledger', message: `The cash records in the file are inconsistent: ${plural(bad.length, 'reversal entry does', 'reversal entries do')} not properly cancel the original entry.`, detail: sample(bad) }];
}

/** Cost + Electricity + Profit = Ice Cream cash book = sum of the fund ledger. */
export function checkIceCreamFunds(conn: DatabaseSync): ValidationFailure[] {
  const funds: Record<string, number> = { cost: 0, electricity: 0, profit: 0 };
  for (const r of all(conn, 'SELECT fund, COALESCE(SUM(amount_cents),0) s FROM icecream_fund_entries GROUP BY fund')) funds[String(r.fund)] = num(r.s);
  const fundTotal = Object.values(funds).reduce((a, b) => a + b, 0);
  const book = one(conn, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'icecream'");
  const ledgerTotal = one(conn, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries');
  if (fundTotal === book && ledgerTotal === book) return [];
  return [{
    code: 'icecream_funds',
    message: 'The Ice Cream funds in the file do not add up to the Ice Cream cash book.',
    detail: `Cost ${funds.cost} + Electricity ${funds.electricity} + Profit ${funds.profit} = ${fundTotal}; fund history ${ledgerTotal}; cash book ${book} (cents)`,
  }];
}

/** `sale_items.returned_qty` equals the quantity on posted return lines, and never exceeds the quantity sold. */
export function checkReturnedQuantities(conn: DatabaseSync): ValidationFailure[] {
  const bad = all(conn, `SELECT si.id, si.qty, si.returned_qty r, COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri
      JOIN sales_returns x ON x.id = ri.sales_return_id WHERE ri.sale_item_id = si.id AND x.status = 'posted'), 0) p FROM sale_items si`)
    .filter((r) => num(r.r) !== num(r.p) || num(r.r) > num(r.qty))
    .map((r) => `sale line ${r.id}: marked as returned ${num(r.r)}, return records show ${num(r.p)} (sold ${num(r.qty)})`);
  if (!bad.length) return [];
  return [{ code: 'returned_qty', message: `Returned quantities in the file do not match the return records for ${plural(bad.length, 'sale line', 'sale lines')}.`, detail: sample(bad) }];
}

/** Tables that can hold a voided record: an `id` and a `status` column whose definition mentions 'void'. */
export function voidableTables(conn: DatabaseSync): string[] {
  const out: string[] = [];
  for (const t of all(conn, "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const cols = all(conn, `PRAGMA table_info("${String(t.name).replaceAll('"', '""')}")`).map((c) => String(c.name));
    if (cols.includes('status') && cols.includes('id') && /void/.test(String(t.sql))) out.push(String(t.name));
  }
  return out;
}

/** Every voided record has its reversal rows: the cash, stock and fund rows that refer to it add up to zero. */
export function checkVoidReversals(conn: DatabaseSync): ValidationFailure[] {
  const bad: string[] = [];
  for (const t of voidableTables(conn)) {
    const q = (ledger: string, col: string): string =>
      `(SELECT COALESCE(SUM(${col}),0) FROM ${ledger} l WHERE l.ref_table = '${t}' AND l.ref_id = x.id)`;
    const sql = `SELECT x.id, ${q('cash_entries', 'amount_cents')} cash, ${q('stock_movements', 'qty_delta')} sq,
        ${q('stock_movements', 'value_delta_cents')} sv, ${q('icecream_fund_entries', 'amount_cents')} fund
      FROM "${t}" x WHERE x.status = 'void'`;
    for (const r of all(conn, sql)) {
      if (num(r.cash) !== 0) bad.push(`${t} #${r.id}: cash records do not cancel out (net ${num(r.cash)})`);
      if (num(r.sq) !== 0 || num(r.sv) !== 0) bad.push(`${t} #${r.id}: stock records do not cancel out`);
      if (num(r.fund) !== 0) bad.push(`${t} #${r.id}: Ice Cream fund records do not cancel out`);
    }
  }
  if (!bad.length) return [];
  return [{ code: 'void_reversals', message: `${plural(bad.length, 'cancelled record is', 'cancelled records are')} missing the entries that reverse its money or stock.`, detail: sample(bad) }];
}

/** No business date lies after today (Asia/Colombo). */
export function checkFutureDates(conn: DatabaseSync, now: Date = new Date()): ValidationFailure[] {
  const today = todayBusinessDate(now);
  const bad: string[] = [];
  for (const t of all(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    const name = String(t.name).replaceAll('"', '""');
    const cols = all(conn, `PRAGMA table_info("${name}")`).map((c) => String(c.name));
    for (const c of cols.filter((x) => x === 'business_date' || x === 'as_of')) {
      const n = one(conn, `SELECT COUNT(*) FROM "${name}" WHERE "${c}" > ?`, today);
      if (n) bad.push(`${t.name}: ${plural(n, 'record', 'records')} dated after today`);
    }
  }
  if (!bad.length) return [];
  return [{ code: 'future_dates', message: 'The file contains records dated in the future.', detail: sample(bad) }];
}

/** The data checks in the order they run (each is independent; a throw is reported by the runner). */
export const INVARIANT_CHECKS: { code: string; run: (conn: DatabaseSync, now: Date) => ValidationFailure[] }[] = [
  { code: 'stock_reconciliation', run: (c) => checkStock(c) },
  { code: 'cash_ledger', run: (c) => checkCashLedger(c) },
  { code: 'icecream_funds', run: (c) => checkIceCreamFunds(c) },
  { code: 'returned_qty', run: (c) => checkReturnedQuantities(c) },
  { code: 'void_reversals', run: (c) => checkVoidReversals(c) },
  { code: 'future_dates', run: (c, now) => checkFutureDates(c, now) },
];
