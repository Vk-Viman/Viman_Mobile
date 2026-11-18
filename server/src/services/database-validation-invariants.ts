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
      c.fund, o.fund ofund, c.segment seg, o.segment oseg, c.ref_table rt, o.ref_table ort, c.ref_id ri, o.ref_id ori, c.type, o.type otype, o.reverses_entry_id oreverses
      FROM cash_entries c LEFT JOIN cash_entries o ON o.id = c.reverses_entry_id WHERE c.reverses_entry_id IS NOT NULL`)) {
    const id = `cash entry ${r.id}`;
    if (r.oid === null) { bad.push(`${id} reverses an entry that does not exist`); continue; }
    if (num(r.a) !== -num(r.oa)) bad.push(`${id} (${num(r.a)}) does not cancel its original (${num(r.oa)})`);
    if (r.d !== r.od) bad.push(`${id} is dated ${r.d} but its original is dated ${r.od}`);
    if (r.book !== r.ob) bad.push(`${id} is in another cash book than its original`);
    if ((r.fund ?? null) !== (r.ofund ?? null)) bad.push(`${id} is in another fund than its original`);
    if ((r.seg ?? null) !== (r.oseg ?? null)) bad.push(`${id} is in another Telecom segment than its original`);
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

const ALL_SEGMENTS = ['dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads', 'legacy'];
const CARD_SEGMENTS = ['dialog_cards', 'mobitel_cards', 'airtel_cards', 'hutch_cards', 'legacy'];
const RELOAD_SEGMENTS = ['dialog_reloads', 'mobitel_reloads', 'airtel_reloads', 'hutch_reloads', 'legacy'];
const quoted = (xs: string[]): string => xs.map((x) => `'${x}'`).join(', ');

/**
 * Telecom segments (BUSINESS_RULES 13D). Written directly against the tables, independent of the services and of the triggers
 * (a corrupted file may have had its triggers lifted). Rules: a Telecom row has a segment and a Shop / Ice Cream row has none; every
 * segment is of the kind its table allows; a reversal keeps the segment of its original (in `checkCashLedger`); a cash entry carries the
 * segment of the record that owns it (transfer legs: of their side of the transfer); sales, purchases, stocktakes, stock losses and
 * goods drawings carry the segment of every product on them; reload / EZCash / top-up rows carry the segment of their provider; one
 * opening balance per scope; the reload and EZCash collections of a segment equal its reload / EZCash records; a product never changed
 * segment after it had stock history; the Telecom total is the sum of its segments. `legacy` (rows from before segments existed) cannot
 * be told from a wrong value by its date, so only its structural rules are checked: it can only appear where its owner, original or
 * product is legacy too.
 */
export function checkSegments(conn: DatabaseSync): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const fail = (what: string, bad: string[]): void => {
    if (bad.length) out.push({ code: 'segments', message: `The Telecom segments in the file are inconsistent: ${what} (${plural(bad.length, 'record', 'records')}).`, detail: sample(bad) });
  };
  /** Rows of a query that selects `id` and optionally `info`, as "label id (info)". */
  const idsOf = (label: string, sql: string): string[] => all(conn, sql).map((r) => `${label} ${r.id}${r.info ? ` (${r.info})` : ''}`);

  // 1. a Telecom row has a segment, a Shop / Ice Cream row has none; the segment is of the kind the table allows
  const withBook: [string, string, string[]][] = [
    ['cash_entries', 'cash entry', ALL_SEGMENTS], ['cash_counts', 'cash count', ALL_SEGMENTS], ['capital_entries', 'capital entry', ALL_SEGMENTS],
    ['owner_drawings', 'drawing', ALL_SEGMENTS], ['expenses', 'expense', ALL_SEGMENTS], ['daily_closings', 'day closing', ALL_SEGMENTS],
    ['purchases', 'purchase', CARD_SEGMENTS], ['stock_losses', 'stock loss', CARD_SEGMENTS], ['stocktakes', 'stocktake', CARD_SEGMENTS],
    ['sales', 'sale', CARD_SEGMENTS],
  ];
  const noSeg: string[] = [];
  const extraSeg: string[] = [];
  const wrongKind: string[] = [];
  for (const [t, label, allowed] of withBook) {
    noSeg.push(...idsOf(label, `SELECT id FROM ${t} WHERE book = 'telecom' AND segment IS NULL ORDER BY id`));
    extraSeg.push(...idsOf(label, `SELECT id, book info FROM ${t} WHERE book <> 'telecom' AND segment IS NOT NULL ORDER BY id`));
    wrongKind.push(...idsOf(label, `SELECT id, segment info FROM ${t} WHERE segment IS NOT NULL AND segment NOT IN (${quoted(allowed)}) ORDER BY id`));
  }
  for (const [t, label] of [['reload_sales', 'reload sale'], ['ezcash_sales', 'EZCash sale'], ['telecom_topups', 'top-up']] as const) {
    noSeg.push(...idsOf(label, `SELECT id FROM ${t} WHERE segment IS NULL ORDER BY id`));
    wrongKind.push(...idsOf(label, `SELECT id, segment info FROM ${t} WHERE segment IS NOT NULL AND segment NOT IN (${quoted(RELOAD_SEGMENTS)}) ORDER BY id`));
  }
  for (const side of ['from', 'to']) {
    noSeg.push(...idsOf(`transfer (${side} side)`, `SELECT id FROM cash_transfers WHERE ${side}_book = 'telecom' AND ${side}_segment IS NULL ORDER BY id`));
    extraSeg.push(...idsOf(`transfer (${side} side)`, `SELECT id, ${side}_book info FROM cash_transfers WHERE ${side}_book <> 'telecom' AND ${side}_segment IS NOT NULL ORDER BY id`));
    wrongKind.push(...idsOf(`transfer (${side} side)`, `SELECT id, ${side}_segment info FROM cash_transfers WHERE ${side}_segment IS NOT NULL AND ${side}_segment NOT IN (${quoted(ALL_SEGMENTS)}) ORDER BY id`));
  }
  fail('Telecom records that name no segment', noSeg);
  fail('Shop or Ice Cream records that carry a Telecom segment', extraSeg);
  fail('records with a segment that does not belong to that kind of record', wrongKind);
  fail('transfers whose two sides are the same cash book and segment', idsOf('transfer', 'SELECT id FROM cash_transfers WHERE from_book = to_book AND from_segment IS to_segment ORDER BY id'));

  // 2. a cash entry carries the segment of the record that owns it (a reversal is also compared with its original by checkCashLedger)
  const owners: [string, string, string][] = [
    ['sales', 'sale', 'SELECT o.segment FROM sales o WHERE o.id = c.ref_id'],
    ['sales_returns', 'sales return', 'SELECT s.segment FROM sales_returns r JOIN sales s ON s.id = r.sale_id WHERE r.id = c.ref_id'],
    ['purchases', 'purchase', 'SELECT o.segment FROM purchases o WHERE o.id = c.ref_id'],
    ['purchase_returns', 'purchase return', 'SELECT p.segment FROM purchase_returns r JOIN purchases p ON p.id = r.purchase_id WHERE r.id = c.ref_id'],
    ['expenses', 'expense', 'SELECT o.segment FROM expenses o WHERE o.id = c.ref_id'],
    ['capital_entries', 'capital entry', 'SELECT o.segment FROM capital_entries o WHERE o.id = c.ref_id'],
    ['owner_drawings', 'drawing', 'SELECT o.segment FROM owner_drawings o WHERE o.id = c.ref_id'],
    ['cash_counts', 'cash count', 'SELECT o.segment FROM cash_counts o WHERE o.id = c.ref_id'],
    ['reload_sales', 'reload sale', 'SELECT o.segment FROM reload_sales o WHERE o.id = c.ref_id'],
    ['ezcash_sales', 'EZCash sale', 'SELECT o.segment FROM ezcash_sales o WHERE o.id = c.ref_id'],
    ['telecom_topups', 'top-up', 'SELECT o.segment FROM telecom_topups o WHERE o.id = c.ref_id'],
  ];
  const ownerBad: string[] = [];
  for (const [table, label, probe] of owners) {
    // the owner exists (a missing owner is not this check's business) and its segment differs
    ownerBad.push(...idsOf('cash entry', `SELECT c.id, '${label} ' || c.ref_id info FROM cash_entries c
      WHERE c.ref_table = '${table}' AND EXISTS (${probe}) AND c.segment IS NOT (${probe}) ORDER BY c.id`));
  }
  ownerBad.push(...idsOf('cash entry', `SELECT c.id, 'transfer ' || c.ref_id info FROM cash_entries c JOIN cash_transfers t ON t.id = c.ref_id
    WHERE c.ref_table = 'cash_transfers' AND ((c.type = 'transfer_out' AND c.segment IS NOT t.from_segment) OR (c.type = 'transfer_in' AND c.segment IS NOT t.to_segment)) ORDER BY c.id`));
  fail('cash entries whose segment differs from the record they belong to', ownerBad);

  // 3. sales, purchases, stocktakes, stock losses and goods drawings carry the segment of their products
  const lineBad: string[] = [];
  for (const [head, items, fk, label] of [['sales', 'sale_items', 'sale_id', 'sale'], ['purchases', 'purchase_items', 'purchase_id', 'purchase'], ['stocktakes', 'stocktake_items', 'stocktake_id', 'stocktake']] as const) {
    lineBad.push(...idsOf(label, `SELECT DISTINCT h.id, 'product ' || i.product_id info FROM ${head} h JOIN ${items} i ON i.${fk} = h.id JOIN v_product_segment v ON v.product_id = i.product_id
      WHERE v.book IS NOT h.book OR v.segment IS NOT h.segment ORDER BY h.id`));
  }
  lineBad.push(...idsOf('stock loss', `SELECT l.id, 'product ' || l.product_id info FROM stock_losses l JOIN v_product_segment v ON v.product_id = l.product_id
    WHERE v.book IS NOT l.book OR v.segment IS NOT l.segment ORDER BY l.id`));
  lineBad.push(...idsOf('drawing', `SELECT d.id, 'product ' || d.product_id info FROM owner_drawings d JOIN v_product_segment v ON v.product_id = d.product_id
    WHERE d.kind = 'goods' AND v.segment IS NOT d.segment ORDER BY d.id`));
  fail('records whose segment differs from the segment of the products on them', lineBad);

  // 4. reload / EZCash / top-up rows carry the segment of their provider (EZCash and wallet top-ups: Dialog Reloads); legacy rows are not judged
  const provBad: string[] = [];
  provBad.push(...idsOf('reload sale', `SELECT r.id, r.segment info FROM reload_sales r JOIN reload_providers p ON p.id = r.provider_id
    WHERE r.segment <> 'legacy' AND r.segment IS NOT lower(p.name) || '_reloads' ORDER BY r.id`));
  provBad.push(...idsOf('EZCash sale', "SELECT id, segment info FROM ezcash_sales WHERE segment <> 'legacy' AND segment IS NOT 'dialog_reloads' ORDER BY id"));
  provBad.push(...idsOf('top-up', `SELECT t.id, t.segment info FROM telecom_topups t LEFT JOIN reload_providers p ON p.id = t.provider_id
    WHERE t.segment <> 'legacy' AND t.segment IS NOT CASE WHEN t.provider_id IS NULL THEN 'dialog_reloads' ELSE lower(p.name) || '_reloads' END ORDER BY t.id`));
  fail('reload, EZCash or top-up records whose segment is not their provider\'s', provBad);

  // 5. one posted opening balance per scope
  fail('more than one opening balance for the same cash book and segment', all(conn, `SELECT book, segment, fund, COUNT(*) n FROM capital_entries
      WHERE kind = 'opening_balance' AND status = 'posted' GROUP BY book, COALESCE(segment, ''), COALESCE(fund, '') HAVING COUNT(*) > 1`)
    .map((r) => `${r.book}${r.segment ? ' / ' + r.segment : ''}${r.fund ? ' / ' + r.fund : ''}: ${r.n} opening balances`));

  // 6. the reload and EZCash collections of a segment equal its (not cancelled) reload / EZCash records
  const collBad: string[] = [];
  for (const [type, table, col] of [['reload_collection', 'reload_sales', 'sales_cents'], ['ezcash_collection', 'ezcash_sales', 'bill_total_cents']] as const) {
    for (const r of all(conn, `SELECT s.segment seg, COALESCE((SELECT SUM(amount_cents) FROM cash_entries c WHERE c.type = '${type}' AND c.segment IS s.segment), 0) cash,
        COALESCE((SELECT SUM(${col}) FROM ${table} x WHERE x.status = 'posted' AND x.segment IS s.segment), 0) rec
        FROM (SELECT segment FROM cash_entries WHERE type = '${type}' UNION SELECT segment FROM ${table}) s`)) {
      if (num(r.cash) !== num(r.rec)) collBad.push(`${r.seg ?? 'no segment'}: cash ${num(r.cash)} but ${table.replace('_', ' ')} total ${num(r.rec)}`);
    }
  }
  fail('the collections in a Telecom segment differ from its reload / EZCash records', collBad);

  // 7. a product has the same segment as all its stock history (its category's provider did not change afterwards)
  const histBad: string[] = [];
  for (const [table, probe] of [
    ['sales', 'SELECT o.segment FROM sales o WHERE o.id = m.ref_id'], ['purchases', 'SELECT o.segment FROM purchases o WHERE o.id = m.ref_id'],
    ['stocktakes', 'SELECT o.segment FROM stocktakes o WHERE o.id = m.ref_id'], ['stock_losses', 'SELECT o.segment FROM stock_losses o WHERE o.id = m.ref_id'],
    ['owner_drawings', 'SELECT o.segment FROM owner_drawings o WHERE o.id = m.ref_id'],
    ['sales_returns', 'SELECT s.segment FROM sales_returns r JOIN sales s ON s.id = r.sale_id WHERE r.id = m.ref_id'],
    ['purchase_returns', 'SELECT p.segment FROM purchase_returns r JOIN purchases p ON p.id = r.purchase_id WHERE r.id = m.ref_id'],
  ]) {
    histBad.push(...idsOf('product', `SELECT DISTINCT m.product_id id, '${table} ' || m.ref_id info FROM stock_movements m JOIN v_product_segment v ON v.product_id = m.product_id
      WHERE m.ref_table = '${table}' AND EXISTS (${probe}) AND v.segment IS NOT (${probe}) ORDER BY m.product_id`));
  }
  fail('products whose segment (their category\'s provider) differs from their stock history', histBad);

  // 8. the Telecom total is the sum of its segments
  const total = one(conn, "SELECT COALESCE(SUM(amount_cents), 0) FROM cash_entries WHERE book = 'telecom'");
  const parts = one(conn, "SELECT COALESCE(SUM(amount_cents), 0) FROM cash_entries WHERE book = 'telecom' AND segment IS NOT NULL");
  if (total !== parts) {
    out.push({ code: 'segments', message: 'The Telecom cash book in the file does not equal the sum of its segments.', detail: `Telecom ${total}; segments add up to ${parts} (cents)` });
  }
  return out;
}

/** The data checks in the order they run (each is independent; a throw is reported by the runner). */
export const INVARIANT_CHECKS: { code: string; run: (conn: DatabaseSync, now: Date) => ValidationFailure[] }[] = [
  { code: 'stock_reconciliation', run: (c) => checkStock(c) },
  { code: 'cash_ledger', run: (c) => checkCashLedger(c) },
  { code: 'icecream_funds', run: (c) => checkIceCreamFunds(c) },
  { code: 'returned_qty', run: (c) => checkReturnedQuantities(c) },
  { code: 'void_reversals', run: (c) => checkVoidReversals(c) },
  { code: 'segments', run: (c) => checkSegments(c) },
  { code: 'future_dates', run: (c, now) => checkFutureDates(c, now) },
];
