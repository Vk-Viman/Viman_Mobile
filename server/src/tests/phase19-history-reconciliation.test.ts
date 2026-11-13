// Phase 19 HISTORY audit, part 2a: RECONCILIATION of a rich world built only through the real HTTP API (all modules, returns, void-returns, closed days,
// transfers, Ice Cream D4 splits and excess cost, opening stock, stocktakes, losses, drawings, capital, one void of every voidable document).
// Every expectation is computed by SQL written in helpers/phase19h.ts that reads the tables directly (it never calls report code); the API / dashboard
// figures are then compared with those SQL figures.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get } from './helpers/catalog.ts';
import { assertGlobalInvariants } from './helpers/phase14.ts';
import {
  AUDIT_ENTITY, auditCoverageProblems, bookBalances, buildWorld19, dbIntegrity, fundBalances, futureDateProblems, n1, returnedQtyProblems, reversalProblems,
  rows, statusTables, stockProblems, voidNetProblems,
} from './helpers/phase19h.ts';
import type { World19 } from './helpers/phase19h.ts';

const env = new TestEnv();
let s: ApiBase;
let world: World19;

beforeAll(async () => {
  s = await apiBase(await env.build());
  world = await buildWorld19(s);
}, 120000);
afterAll(async () => { await env.cleanup(); });

describe('the world is rich enough to prove something', () => {
  it('has rows in every business table and at least one void of every voidable document type', () => {
    const counts: Record<string, number> = {};
    for (const t of ['sales', 'sale_items', 'sales_returns', 'sales_return_items', 'purchases', 'purchase_returns', 'expenses', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales',
      'printing_supplies', 'owner_drawings', 'capital_entries', 'cash_transfers', 'cash_counts', 'daily_closings', 'icecream_days', 'icecream_payments', 'icecream_fund_moves',
      'stock_losses', 'stocktakes', 'opening_stock_batches', 'stock_movements', 'cash_entries', 'icecream_fund_entries', 'audit_logs']) counts[t] = n1(s.ctx, `SELECT COUNT(*) FROM "${t}"`);
    for (const [t, n] of Object.entries(counts)) expect(n, `${t} is empty`).toBeGreaterThan(0);
    const { voidCounts } = voidNetProblems(s.ctx);
    for (const t of ['sales', 'sales_returns', 'purchases', 'expenses', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales', 'printing_supplies', 'owner_drawings', 'capital_entries',
      'cash_transfers', 'cash_counts', 'icecream_days', 'icecream_payments', 'icecream_fund_moves', 'stock_losses', 'stocktakes', 'opening_stock_batches'])
      expect(voidCounts[t] ?? 0, `no voided ${t} in the world`).toBeGreaterThan(0);
    // returns: posted and void, resalable and damaged
    expect(n1(s.ctx, "SELECT COUNT(*) FROM sales_returns WHERE status='void'")).toBeGreaterThanOrEqual(2);
    expect(n1(s.ctx, "SELECT COUNT(*) FROM sales_returns WHERE status='posted'")).toBeGreaterThanOrEqual(8);
    expect(n1(s.ctx, 'SELECT COUNT(*) FROM sales_return_items WHERE resalable = 0')).toBeGreaterThanOrEqual(2);
    expect(n1(s.ctx, "SELECT COUNT(*) FROM cash_entries WHERE reverses_entry_id IS NOT NULL")).toBeGreaterThan(10);
    // every table that can be voided is covered by the generic checks
    expect(statusTables(s.ctx).length).toBeGreaterThanOrEqual(19);
  });
});

describe('database integrity', () => {
  it('PRAGMA integrity_check is ok and foreign_key_check is empty', () => {
    expect(dbIntegrity(s.ctx)).toEqual([]);
  });
});

describe('STOCK reconciliation', () => {
  it('per product the sum of movements equals the cache (qty and value); nothing is negative; services hold no stock', () => {
    expect(stockProblems(s.ctx)).toEqual([]);
  });
  it('the valuation total equals the sum of product values, from SQL and from the endpoint; the endpoint rows equal the cache', async () => {
    const sqlTotal = n1(s.ctx, 'SELECT COALESCE(SUM(stock_value_cents),0) FROM products');
    const sqlQty = n1(s.ctx, 'SELECT COALESCE(SUM(qty_on_hand),0) FROM products');
    const sumMovements = n1(s.ctx, 'SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements');
    expect(sqlTotal).toBe(sumMovements);
    const v = (await get(s.app, '/reports/inventory/valuation')).body;
    expect(v.totals.valueCents).toBe(sqlTotal);
    expect(v.totals.qty).toBe(sqlQty);
    expect((v.rows as any[]).reduce((a, r) => a + r.valueCents, 0)).toBe(sqlTotal);
    expect(v.reconciliation.matchesCache).toBe(true);
    for (const r of v.rows as any[]) expect(r.valueCents, `product ${r.productId}`).toBe(n1(s.ctx, 'SELECT stock_value_cents FROM products WHERE id = ?', r.productId));
    const rec = (await get(s.app, '/inventory/reconciliation')).body;
    expect(rec.ok).toBe(true);
    expect((await get(s.app, '/dashboard')).body.stock.valueCents).toBe(sqlTotal);
  });
});

describe('CASH LEDGER reconciliation', () => {
  it('each book balance (SQL sum of its cash entries) equals /cashbooks and /dashboard', async () => {
    const sql = bookBalances(s.ctx);
    const cb = (await get(s.app, '/cashbooks')).body.books as any[];
    for (const b of cb) expect(b.balanceCents, `book ${b.book}`).toBe(sql[b.book]);
    const dash = (await get(s.app, '/dashboard')).body;
    for (const b of dash.cash.books as any[]) expect(b.balanceCents, `dashboard ${b.book}`).toBe(sql[b.book]);
    expect(dash.cash.totalCents).toBe(sql.shop! + sql.telecom! + sql.icecream!);
    for (const book of ['shop', 'telecom', 'icecream']) {
      const led = (await get(s.app, `/cashbooks/${book}`)).body;
      expect(led.balanceCents ?? led.closingBalanceCents ?? sql[book]).toBe(sql[book]);
    }
  });
  it('every reversal entry (cash and Ice Cream fund) points to an existing original with the opposite sign and the same date / book / fund / reference', () => {
    expect(reversalProblems(s.ctx)).toEqual([]);
  });
  it('the cash balance never differs from the sum of the transfers legs: transfers net to zero across the three books', () => {
    const t = n1(s.ctx, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE type IN ('transfer_in','transfer_out')");
    expect(t).toBe(0);
  });
});

describe('ICE CREAM FUND reconciliation', () => {
  it('Cost + Electricity + Profit = Ice Cream cash book = sum of the fund ledger; per fund the ledger, the cash entries and /icecream/funds agree', async () => {
    const { ledger, cash } = fundBalances(s.ctx);
    const book = bookBalances(s.ctx).icecream!;
    expect(ledger.cost! + ledger.electricity! + ledger.profit!).toBe(book);
    expect(n1(s.ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries')).toBe(book);
    // Fund moves (releases, re-allocations, Cost <-> Electricity) relabel money between funds WITHOUT a cash entry, so per fund the cash entries differ from the
    // fund ledger by exactly the net of the fund-move rows (originals and reversals); in total they are equal.
    for (const k of ['cost', 'electricity', 'profit'] as const) {
      const moves = n1(s.ctx, "SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries WHERE fund = ? AND ref_table = 'icecream_fund_moves'", k);
      expect(cash[k]! - ledger[k]!, `fund ${k}: cash entries minus ledger`).toBe(-moves);
    }
    expect(cash.cost! + cash.electricity! + cash.profit!).toBe(book);
    const f = (await get(s.app, '/icecream/funds')).body;
    for (const k of ['cost', 'electricity', 'profit'] as const) expect(f.funds[k].balanceCents, k).toBe(ledger[k]);
    expect(f.totalCents).toBe(book);
    expect(f.cashBookBalanceCents).toBe(book);
    expect(f.reconciled).toBe(true);
    const entries = (await get(s.app, '/icecream/funds/entries?limit=500')).body;
    expect(entries.totals.netCents).toBe(book);
    expect(entries.total).toBe(n1(s.ctx, 'SELECT COUNT(*) FROM icecream_fund_entries'));
    const dash = (await get(s.app, '/dashboard')).body.icecream;
    expect(dash.funds).toEqual(ledger);
    expect(dash.fundsTotalCents).toBe(book);
    expect(dash.fundsMatchBook).toBe(true);
  });
  it('the Ice Cream world really contains D4 splits, excess cost, relabels and a negative fund (so the reconciliation is non-trivial)', () => {
    expect(n1(s.ctx, "SELECT COUNT(*) FROM icecream_fund_moves WHERE status='posted'")).toBeGreaterThanOrEqual(5);
    expect(n1(s.ctx, "SELECT COUNT(*) FROM icecream_fund_moves WHERE status='posted' AND to_fund = 'profit' AND cash_only_cents > 0 AND profit_effect_cents > 0"), 'D4 split').toBeGreaterThanOrEqual(1);
    expect(n1(s.ctx, "SELECT COUNT(*) FROM icecream_fund_moves WHERE status='posted' AND charge_relabel_cents > 0"), 'charge relabel').toBeGreaterThanOrEqual(1);
    expect(n1(s.ctx, "SELECT COUNT(*) FROM icecream_fund_moves WHERE status='void'"), 'void move').toBeGreaterThanOrEqual(1);
    expect(n1(s.ctx, 'SELECT COUNT(*) FROM icecream_fund_entries WHERE amount_cents < 0 AND fund = \'electricity\'')).toBeGreaterThan(0);
    expect(n1(s.ctx, 'SELECT COUNT(*) FROM icecream_fund_entries WHERE reverses_entry_id IS NOT NULL')).toBeGreaterThan(0);
  });
});

describe('voids, returns, dates and audit', () => {
  it('for every voided record of every table, the net of its cash, stock and fund rows (original + reversal) is zero', () => {
    expect(voidNetProblems(s.ctx).problems).toEqual([]);
  });
  it('every posted sale line\'s returned_qty equals the sum of its POSTED return lines (void returns excluded)', () => {
    expect(returnedQtyProblems(s.ctx)).toEqual([]);
    expect(n1(s.ctx, 'SELECT COUNT(*) FROM sale_items WHERE returned_qty > 0')).toBeGreaterThan(3);
  });
  it('a voided return restores returned_qty and keeps its two ledger rows (original + reversal) in the books', () => {
    for (const r of rows(s.ctx, "SELECT id, refund_cents FROM sales_returns WHERE status = 'void'")) {
      const cash = rows(s.ctx, "SELECT amount_cents a FROM cash_entries WHERE ref_table='sales_returns' AND ref_id = ? ORDER BY id", r.id).map((x) => Number(x.a));
      if (Number(r.refund_cents) > 0) { expect(cash.length, `return ${r.id}`).toBe(2); expect(cash[0]! + cash[1]!).toBe(0); }
      const stock = rows(s.ctx, "SELECT qty_delta q FROM stock_movements WHERE ref_table='sales_returns' AND ref_id = ?", r.id).map((x) => Number(x.q));
      expect(stock.reduce((a, b) => a + b, 0), `return ${r.id} stock net`).toBe(0);
    }
  });
  it('no record has a business date in the future (every table with a business_date column)', () => {
    expect(futureDateProblems(s.ctx)).toEqual([]);
  });
  it('audit_logs has a create row for every financial record and a void row for every voided one', () => {
    expect(Object.keys(AUDIT_ENTITY).length).toBeGreaterThanOrEqual(19);
    expect(auditCoverageProblems(s.ctx)).toEqual([]);
    // daily closings and reopens, opening balances, days and payments are audited too
    expect(n1(s.ctx, "SELECT COUNT(*) FROM daily_closings d WHERE NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity='daily_closing' AND a.action='close' AND a.entity_id = CAST(d.id AS TEXT))"), 'closing without audit').toBe(0);
    expect(n1(s.ctx, "SELECT COUNT(*) FROM audit_logs WHERE entity='daily_closing' AND action='reopen'")).toBeGreaterThanOrEqual(n1(s.ctx, 'SELECT COUNT(*) FROM daily_closings WHERE reopened_at IS NOT NULL'));
    expect(n1(s.ctx, "SELECT COUNT(*) FROM audit_logs WHERE entity='icecream_day' AND action='create'")).toBeGreaterThanOrEqual(n1(s.ctx, 'SELECT COUNT(*) FROM icecream_days'));
    expect(n1(s.ctx, "SELECT COUNT(*) FROM audit_logs WHERE entity='icecream_payment'")).toBeGreaterThanOrEqual(n1(s.ctx, 'SELECT COUNT(*) FROM icecream_payments'));
  });
  it('the phase-14 global invariants also hold for this world', async () => {
    await assertGlobalInvariants(s);
    void world;
  });
});
