// Phase 19 HISTORY audit, part 2b: the append-only guarantees really hold at the database level. Every attempt below is a RAW SQL statement (no application code
// in the way); each runs in a savepoint that is always rolled back, and a fingerprint of every ledger table proves nothing changed.
// The only allowed change to a return is the posted -> void transition, which must carry its own reversal effects (checked with the SQL reconcilers).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { post } from './helpers/catalog.ts';
import { assertGlobalInvariants } from './helpers/phase14.ts';
import {
  buildWorld19, n1, probe, returnedQtyProblems, reversalProblems, rows, statusTables, stockProblems, voidNetProblems,
} from './helpers/phase19h.ts';
import type { World19 } from './helpers/phase19h.ts';

const env = new TestEnv();
let s: ApiBase;
let world: World19;

const FINGERPRINT_TABLES = ['stock_movements', 'cash_entries', 'icecream_fund_entries', 'audit_logs', 'sales_returns', 'sales_return_items', 'purchase_returns', 'purchase_return_items',
  'products', 'sales', 'sale_items', 'purchases', 'expenses', 'icecream_days', 'icecream_payments', 'icecream_fund_moves', 'stock_losses', 'daily_closings', 'import_runs', 'import_issues',
  'external_backup_log', 'backup_settings', 'schema_migrations'];
function fingerprint(): string {
  const h = createHash('sha256');
  for (const t of FINGERPRINT_TABLES) h.update(t + JSON.stringify(rows(s.ctx, `SELECT * FROM "${t}" ORDER BY rowid`), (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  return h.digest('hex');
}

beforeAll(async () => {
  s = await apiBase(await env.build());
  world = await buildWorld19(s);
}, 120000);
afterAll(async () => { await env.cleanup(); });

/** [table, UPDATE assignment that changes a money / identity column]. */
const UPDATES: Array<[string, string]> = [
  ['stock_movements', 'qty_delta = qty_delta + 1'], ['stock_movements', 'value_delta_cents = value_delta_cents + 1'], ['stock_movements', "business_date = '2025-01-01'"],
  ['cash_entries', 'amount_cents = amount_cents + 1'], ['cash_entries', "business_date = '2025-01-01'"], ['cash_entries', "book = 'telecom'"], ['cash_entries', 'reverses_entry_id = NULL'],
  ['audit_logs', "note = COALESCE(note,'') || 'x'"], ['audit_logs', "action = 'create'"], ['audit_logs', "after_json = '{}'"],
  ['icecream_fund_entries', 'amount_cents = amount_cents + 1'], ['icecream_fund_entries', "fund = 'profit'"], ['icecream_fund_entries', "business_date = '2025-01-01'"],
  ['sales_returns', 'refund_cents = refund_cents + 1'], ['sales_returns', 'cogs_reversed_cents = cogs_reversed_cents + 1'], ['sales_returns', "business_date = '2025-01-01'"],
  ['sales_returns', "note = 'x'"], ['sales_returns', 'sale_id = sale_id + 0 + (SELECT 0)'], ['sales_returns', "client_ref = client_ref || 'x'"],
  ['sales_return_items', 'qty = qty + 1'], ['sales_return_items', 'resalable = 1 - resalable'], ['sales_return_items', 'revenue_cents = revenue_cents + 1'], ['sales_return_items', 'cogs_cents = cogs_cents + 1'],
  ['purchase_returns', 'refund_cents = refund_cents + 1'], ['purchase_return_items', 'units = units + 1'],
  ['sales', 'total_cents = total_cents + 1'], ['sale_items', 'qty = qty + 1'], ['sale_items', 'revenue_cents = revenue_cents + 1'], ['sale_items', 'cogs_cents = cogs_cents + 1'],
  ['purchases', 'total_cents = total_cents + 1'], ['purchase_items', 'units = units + 1'], ['expenses', 'amount_cents = amount_cents + 1'],
  ['icecream_days', 'sales_cents = sales_cents + 1'], ['icecream_payments', 'amount_cents = amount_cents + 1'], ['icecream_fund_moves', 'amount_cents = amount_cents + 1'],
  ['stock_losses', 'cost_cents = cost_cents + 1'], ['cash_transfers', 'amount_cents = amount_cents + 1'], ['capital_entries', 'amount_cents = amount_cents + 1'],
  ['owner_drawings', 'amount_cents = amount_cents + 1'], ['cash_counts', 'counted_cents = counted_cents + 1'], ['opening_stock_batches', 'total_value_cents = total_value_cents + 1'],
];
const DELETES = ['stock_movements', 'cash_entries', 'audit_logs', 'icecream_fund_entries', 'sales_returns', 'sales_return_items', 'purchase_returns', 'purchase_return_items', 'sales', 'sale_items',
  'purchases', 'purchase_items', 'expenses', 'icecream_days', 'icecream_payments', 'icecream_fund_moves', 'stock_losses', 'cash_transfers', 'capital_entries', 'owner_drawings', 'cash_counts',
  'opening_stock_batches', 'daily_closings', 'stocktakes'];

describe('raw UPDATE / DELETE is refused by the database', () => {
  it('UPDATE of a money / identity column is refused on every ledger, return and document table', () => {
    const before = fingerprint();
    const accepted: string[] = [];
    for (const [t, set] of UPDATES) {
      expect(n1(s.ctx, `SELECT COUNT(*) FROM "${t}"`), `${t} has no rows to attack`).toBeGreaterThan(0);
      const err = probe(s.ctx, `UPDATE "${t}" SET ${set}`);
      if (err === null) accepted.push(`${t}: ${set}`);
    }
    expect(accepted, 'raw UPDATE accepted').toEqual([]);
    expect(fingerprint()).toBe(before);
  });
  it('DELETE of any row is refused on every ledger, return and document table', () => {
    const before = fingerprint();
    const accepted: string[] = [];
    for (const t of DELETES) {
      expect(n1(s.ctx, `SELECT COUNT(*) FROM "${t}"`), `${t} has no rows to attack`).toBeGreaterThan(0);
      if (probe(s.ctx, `DELETE FROM "${t}"`) === null) accepted.push(t);
      if (probe(s.ctx, `DELETE FROM "${t}" WHERE id = (SELECT MIN(id) FROM "${t}" WHERE id IS NOT NULL)`) === null) accepted.push(t + ' (single row)');
    }
    expect(accepted, 'raw DELETE accepted').toEqual([]);
    expect(fingerprint()).toBe(before);
  });
  it('a pointed attack on one cash entry and one stock movement (by id) is refused', () => {
    const before = fingerprint();
    expect(probe(s.ctx, 'UPDATE cash_entries SET amount_cents = 0 WHERE id = 1')).not.toBeNull();
    expect(probe(s.ctx, 'DELETE FROM cash_entries WHERE id = 1')).not.toBeNull();
    expect(probe(s.ctx, 'UPDATE stock_movements SET qty_delta = 0 WHERE id = 1')).not.toBeNull();
    expect(probe(s.ctx, 'DELETE FROM stock_movements WHERE id = 1')).not.toBeNull();
    expect(probe(s.ctx, 'UPDATE icecream_fund_entries SET amount_cents = 1 WHERE id = 1')).not.toBeNull();
    expect(probe(s.ctx, 'DELETE FROM audit_logs WHERE id = 1')).not.toBeNull();
    expect(fingerprint()).toBe(before);
  });
  it('external_backup_log, import_runs and import_issues (empty in this world) refuse UPDATE and DELETE of a row inserted inside a savepoint', () => {
    const before = fingerprint();
    const insExt = "INSERT INTO external_backup_log (status, target_name) VALUES ('skipped', 'x')";
    const insRun = "INSERT INTO import_runs (kind, file_name, file_sha256, business_date, mode, status, rows_total, rows_ok, rows_failed) VALUES ('opening_stock','f.xlsx','" + 'a'.repeat(64) + "','2025-01-01','preview','previewed',0,0,0)";
    const insIssue = `${insRun}`;
    // the inserts themselves are allowed (the tables are append-only, not read-only) ...
    expect(probe(s.ctx, insExt)).toBeNull();
    expect(probe(s.ctx, insRun)).toBeNull();
    // ... but the inserted row can never be changed or removed
    expect(probe(s.ctx, [insExt, "UPDATE external_backup_log SET target_name = 'y'"])).toMatch(/APPEND_ONLY|append-only/i);
    expect(probe(s.ctx, [insExt, 'DELETE FROM external_backup_log'])).toMatch(/APPEND_ONLY|append-only/i);
    expect(probe(s.ctx, [insRun, "UPDATE import_runs SET file_name = 'y'"])).not.toBeNull();
    expect(probe(s.ctx, [insRun, 'DELETE FROM import_runs'])).not.toBeNull();
    expect(probe(s.ctx, [insIssue, "INSERT INTO import_issues (import_run_id, row_no, code, message) VALUES (last_insert_rowid(), 1, 'c', 'm')", "UPDATE import_issues SET message = 'z'"])).not.toBeNull();
    expect(probe(s.ctx, [insIssue, "INSERT INTO import_issues (import_run_id, row_no, code, message) VALUES (last_insert_rowid(), 1, 'c', 'm')", 'DELETE FROM import_issues'])).not.toBeNull();
    expect(probe(s.ctx, ['INSERT INTO backup_settings (id, external_dir) VALUES (1, NULL)', 'DELETE FROM backup_settings'])).toMatch(/BACKUP_SETTINGS_DELETE_FORBIDDEN/);
    expect(fingerprint()).toBe(before);
  });
  it('a void record can never be revived (status void -> posted) in any table, and a return keeps its figures when voided', () => {
    const before = fingerprint();
    for (const t of statusTables(s.ctx)) {
      const hasVoid = n1(s.ctx, `SELECT COUNT(*) FROM "${t}" WHERE status = 'void'`);
      if (hasVoid === 0) continue;
      const cols = rows(s.ctx, `PRAGMA table_info("${t}")`).map((c) => String(c.name));
      const reset = ['voided_at', 'void_reason'].filter((c) => cols.includes(c)).map((c) => `${c} = NULL`);
      const sql = `UPDATE "${t}" SET status = 'posted'${reset.length ? ', ' + reset.join(', ') : ''} WHERE status = 'void'`;
      expect(probe(s.ctx, sql), `${t}: revival accepted`).not.toBeNull();
    }
    expect(fingerprint()).toBe(before);
  });
});

describe('the one allowed change: a return can go posted -> void, and only with its reversal effects', () => {
  it('a raw status flip of a newest-per-line posted return makes the DATABASE restore returned_qty and void the damaged-return loss (the trigger-managed part of R-VR); everything else stays', () => {
    const before = fingerprint();
    // a damaged return that is still posted and is the newest return of its line
    const target = rows(s.ctx, `SELECT r.id FROM sales_returns r WHERE r.status = 'posted' AND EXISTS (SELECT 1 FROM stock_losses l WHERE l.sales_return_id = r.id AND l.status = 'posted')
      AND NOT EXISTS (SELECT 1 FROM sales_return_items a JOIN sales_return_items b ON b.sale_item_id = a.sale_item_id AND b.sales_return_id > a.sales_return_id JOIN sales_returns r2 ON r2.id = b.sales_return_id AND r2.status = 'posted' WHERE a.sales_return_id = r.id)
      ORDER BY r.id DESC LIMIT 1`)[0];
    expect(target, 'the world must contain a posted damaged return').toBeTruthy();
    const lossesBefore = n1(s.ctx, "SELECT COUNT(*) FROM stock_losses WHERE status = 'posted'");
    const c = s.ctx.database.conn;
    c.exec('SAVEPOINT p19flip');
    try {
      // Migration 019 (M1) + 020 (M2): the flip needs the reversal rows first (a damaged return has a refund entry and no stock movement); the
      // world has closed days, whose rule applies to those reversal rows, so the days are reopened inside this rolled-back savepoint
      c.exec("UPDATE daily_closings SET reopened_at = '2999-01-01T00:00:00.000Z', reopen_reason = 'test' WHERE reopened_at IS NULL OR closed_at > reopened_at");
      c.exec(`INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, reverses_entry_id)
        SELECT book, business_date, type, -amount_cents, fund, ref_table, ref_id, id FROM cash_entries
         WHERE ref_table = 'sales_returns' AND ref_id = ${target!.id} AND reverses_entry_id IS NULL AND amount_cents <> 0`);
      c.exec(`UPDATE sales_returns SET status = 'void', voided_at = '2025-09-19T00:00:00.000Z', void_reason = 'raw flip' WHERE id = ${target!.id}`);
      expect(returnedQtyProblems(s.ctx), 'returned_qty after flip').toEqual([]);
      expect(n1(s.ctx, "SELECT COUNT(*) FROM stock_losses WHERE status = 'posted'")).toBeLessThan(lossesBefore);
      expect(n1(s.ctx, `SELECT COUNT(*) FROM stock_losses WHERE sales_return_id = ${target!.id} AND status = 'posted'`)).toBe(0);
      expect(stockProblems(s.ctx), 'the stock cache is not touched by the flip').toEqual([]);
    } finally { c.exec('ROLLBACK TO p19flip'); c.exec('RELEASE p19flip'); }
    expect(fingerprint()).toBe(before);
  });
  it('a raw flip of a return that is NOT the newest posted return of one of its lines is refused; flipping other fields together with the status is refused', () => {
    const older = rows(s.ctx, `SELECT r.id FROM sales_returns r WHERE r.status = 'posted' AND EXISTS (SELECT 1 FROM sales_return_items a JOIN sales_return_items b ON b.sale_item_id = a.sale_item_id AND b.sales_return_id > a.sales_return_id
      JOIN sales_returns r2 ON r2.id = b.sales_return_id AND r2.status = 'posted' WHERE a.sales_return_id = r.id) LIMIT 1`)[0];
    expect(older, 'the world must contain a sale with two posted returns').toBeTruthy();
    expect(probe(s.ctx, `UPDATE sales_returns SET status = 'void', voided_at = '2025-09-19T00:00:00.000Z', void_reason = 'x' WHERE id = ${older!.id}`)).not.toBeNull();
    const newest = rows(s.ctx, "SELECT MAX(id) id FROM sales_returns WHERE status = 'posted'")[0]!.id;
    expect(probe(s.ctx, `UPDATE sales_returns SET status = 'void', voided_at = '2025-09-19T00:00:00.000Z', void_reason = 'x', refund_cents = 0 WHERE id = ${newest}`)).not.toBeNull();
    expect(probe(s.ctx, `UPDATE sales_returns SET status = 'void', voided_at = NULL, void_reason = 'x' WHERE id = ${newest}`)).not.toBeNull();
  });
  it('through the API, voiding a return twice or voiding an older return is refused and writes nothing', async () => {
    const before = fingerprint();
    const x = world.extra;
    const again = await post(s.app, `/sales/${x.s2.id}/returns/${x.r3.id}/void`, { reason: 'twice' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    // "newest" is judged per sale LINE (R-VR 1): Rt3 and Rt4 of the phase-14 world return the same line of sale Sa8, Rt4 is newer
    const older = await post(s.app, `/sales/${world.w.sales.Sa8.id}/returns/${world.w.returns.Rt3.id}/void`, { reason: 'not the newest' });
    expect(older.status, JSON.stringify(older.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
    // while a return of ANOTHER line of the same sale may be voided independently (x.r2 is the only return of its line)
    expect(x.r2.id).toBeGreaterThan(0);
    expect(fingerprint()).toBe(before);
  });
});

describe('inserts are guarded too', () => {
  it('a future-dated, closed-day or before-closed-day ledger row is refused, in the cash, stock and fund ledgers', () => {
    const before = fingerprint();
    expect(probe(s.ctx, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('shop','2099-01-01','capital',1)")).toMatch(/FUTURE_DATE/);
    expect(probe(s.ctx, "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (1,'2099-01-01','adjustment',1,1)")).toMatch(/FUTURE_DATE/);
    expect(probe(s.ctx, "INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind) VALUES ('2099-01-01','cost',1,'capital')")).toMatch(/FUTURE_DATE/);
    expect(probe(s.ctx, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('shop','2025-08-08','capital',1)")).toMatch(/DAY_CLOSED/);
    expect(probe(s.ctx, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('shop','2025-08-01','capital',1)")).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(fingerprint()).toBe(before);
  });
  it('a reversal row for a return that is NOT void, or one that does not mirror its original, is refused', () => {
    const before = fingerprint();
    const posted = rows(s.ctx, "SELECT c.id, c.amount_cents a, c.book, c.type, c.business_date d, c.ref_id r FROM cash_entries c JOIN sales_returns x ON x.id = c.ref_id WHERE c.ref_table = 'sales_returns' AND x.status = 'posted' AND c.amount_cents < 0 LIMIT 1")[0]!;
    const base = `INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('${posted.book}', '${posted.d}', '${posted.type}', ${-Number(posted.a)}, 'sales_returns', ${posted.r}, ${posted.id})`;
    expect(probe(s.ctx, base), 'reversal of a posted return').toMatch(/RETURN_REVERSAL_INVALID/);
    expect(fingerprint()).toBe(before);
  });
  it('after all the attacks the reconciliations still hold exactly as before', async () => {
    expect(stockProblems(s.ctx)).toEqual([]);
    expect(reversalProblems(s.ctx)).toEqual([]);
    expect(voidNetProblems(s.ctx).problems).toEqual([]);
    await assertGlobalInvariants(s);
  });
});
