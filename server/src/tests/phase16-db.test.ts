// Migration 016 - the database backstop of the closed-day ordering protection (BUSINESS_RULES section 8), raw SQL on in-memory SQLite so the
// triggers are proven independent of the services:
//   cash_entries (all three books): a row dated ON a closed day aborts exactly `DAY_CLOSED`; dated EARLIER than the latest closed day of its
//     book aborts `BACKDATE_BEFORE_CLOSED_DAY`; later dates, other books, books without closed days are fine; a reopened day no longer counts;
//     a reversal row (it copies the original business date) follows the same rule; a refused insert leaves the ledger as it was.
//   Ice Cream records (days, payments, fund moves - they exist because a zero-sales day and a fund move write NO cash entry): the same
//     two aborts on insert, and on the posted -> void flip of days and moves (judged on the record's own date).
//   Closing a day posts nothing by itself: inserting the closing row is never refused; the service and the trigger agree on the error code.
// "Closed" = reopened_at IS NULL OR closed_at > reopened_at (R9).

import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { currentVersion, latestVersion, loadMigrations } from '../db/migrate.ts';
import { daysAgo, memDb, msgOf, scalar } from './helpers/inventory.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns) { try { c.close(); } catch { /* ignore */ } } conns.length = 0; });

let seq = 0;
const uniq = (): string => `db16-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
type Book = 'shop' | 'telecom' | 'icecream';
const E = (): string => daysAgo(6);
const M = (): string => daysAgo(4);
const C = (): string => daysAgo(3);
const L = (): string => daysAgo(1);

/** Raw ledger row: an expense (shop/telecom) or an Ice Cream "other cost" (fund required); returns the new id. */
function cash(c: DatabaseSync, book: Book, date: string, amount = -100, extra: Record<string, string | number | null> = {}): number {
  const row: Record<string, string | number | null> = {
    book, business_date: date, type: book === 'icecream' ? 'icecream_other_cost' : 'expense', amount_cents: amount,
    ...(book === 'icecream' ? { fund: 'cost' } : {}), ...extra,
  };
  const cols = Object.keys(row);
  return Number(c.prepare(`INSERT INTO cash_entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
const close = (c: DatabaseSync, book: Book, date: string): void => {
  c.prepare('INSERT INTO daily_closings (book, business_date, expected_cents) VALUES (?, ?, 0)').run(book, date);
};
const reopen = (c: DatabaseSync, book: Book, date: string): void => {
  c.prepare(`UPDATE daily_closings SET reopened_at = max(strftime('%Y-%m-%dT%H:%M:%fZ','now'), closed_at), reopen_reason = 'fix' WHERE book = ? AND business_date = ?`).run(book, date);
};
const reclose = (c: DatabaseSync, book: Book, date: string): void => {
  c.prepare(`UPDATE daily_closings SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE book = ? AND business_date = ?`).run(book, date);
};
const ledger = (c: DatabaseSync): number => scalar(c, 'SELECT COUNT(*) FROM cash_entries');

describe('migration 016', () => {
  it('is applied; the cash_entries trigger and the five Ice Cream record triggers exist under their old names', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(16);
    expect(currentVersion(c)).toBe(latestVersion());
    expect(loadMigrations().some((m) => m.name === '016_closed_day_ordering.sql')).toBe(true);
    const names = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as unknown as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'trg_cash_entries_day_closed', 'trg_icecream_days_day_closed', 'trg_icecream_days_day_closed_void', 'trg_icecream_payments_day_closed',
      'trg_icecream_fund_moves_day_closed', 'trg_icecream_fund_moves_day_closed_void',
    ]));
    // the stronger triggers mention BOTH aborts (the old ones only DAY_CLOSED)
    for (const t of ['trg_cash_entries_day_closed', 'trg_icecream_days_day_closed', 'trg_icecream_payments_day_closed', 'trg_icecream_fund_moves_day_closed']) {
      const sql = (c.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t) as unknown as { sql: string }).sql;
      expect(sql, t).toContain('BACKDATE_BEFORE_CLOSED_DAY');
      expect(sql, t).toContain('DAY_CLOSED');
    }
  });
});

describe('cash_entries trigger', () => {
  it.each(['shop', 'telecom', 'icecream'] as const)('%s: on the closed day DAY_CLOSED; before it BACKDATE_BEFORE_CLOSED_DAY; after it fine; other books unaffected', (book) => {
    const c = memDb(conns);
    close(c, book, C());
    expect(msgOf(() => cash(c, book, C()))).toBe('DAY_CLOSED');
    expect(msgOf(() => cash(c, book, daysAgo(4)))).toBe('BACKDATE_BEFORE_CLOSED_DAY'); // one day before
    expect(msgOf(() => cash(c, book, daysAgo(60)))).toBe('BACKDATE_BEFORE_CLOSED_DAY'); // long before
    expect(() => cash(c, book, daysAgo(2))).not.toThrow(); // one day after
    expect(() => cash(c, book, L())).not.toThrow();
    expect(() => cash(c, book, daysAgo(0))).not.toThrow();
    for (const other of (['shop', 'telecom', 'icecream'] as const).filter((b) => b !== book)) {
      expect(() => cash(c, other, E()), `${other} before`).not.toThrow();
      expect(() => cash(c, other, C()), `${other} on the day`).not.toThrow();
    }
  });

  it('a book with NO closed day takes any past date; a refused insert leaves the ledger unchanged', () => {
    const c = memDb(conns);
    expect(() => cash(c, 'shop', daysAgo(400))).not.toThrow();
    expect(ledger(c)).toBe(1);
    close(c, 'telecom', C());
    const before = ledger(c);
    expect(msgOf(() => cash(c, 'telecom', E()))).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(msgOf(() => cash(c, 'telecom', C()))).toBe('DAY_CLOSED');
    expect(ledger(c)).toBe(before);
  });

  it('latest closed day wins: with M < C closed, anything before C is a backdate, M itself and C itself are DAY_CLOSED, between them is a backdate', () => {
    const c = memDb(conns);
    close(c, 'shop', M());
    close(c, 'shop', C());
    expect(msgOf(() => cash(c, 'shop', E()))).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(msgOf(() => cash(c, 'shop', M()))).toBe('DAY_CLOSED');
    expect(msgOf(() => cash(c, 'shop', daysAgo(3.0)))).toBe('DAY_CLOSED');
    expect(() => cash(c, 'shop', L())).not.toThrow();
  });

  it('reopening: the reopened day no longer counts; the latest CLOSED day is what matters; a re-close protects again', () => {
    const c = memDb(conns);
    close(c, 'shop', M());
    close(c, 'shop', C());
    reopen(c, 'shop', C()); // M stays closed -> the latest closed day is M
    expect(msgOf(() => cash(c, 'shop', E()))).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(() => cash(c, 'shop', C())).not.toThrow(); // the reopened day takes entries (it is after M)
    expect(() => cash(c, 'shop', daysAgo(2))).not.toThrow();
    expect(msgOf(() => cash(c, 'shop', M()))).toBe('DAY_CLOSED');
    reopen(c, 'shop', M()); // nothing closed any more
    expect(() => cash(c, 'shop', E())).not.toThrow();
    expect(() => cash(c, 'shop', M())).not.toThrow();
    reclose(c, 'shop', C()); // C closed again -> everything up to C is protected
    expect(msgOf(() => cash(c, 'shop', E()))).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(msgOf(() => cash(c, 'shop', M()))).toBe('BACKDATE_BEFORE_CLOSED_DAY'); // M is reopened but earlier than the closed C
    expect(msgOf(() => cash(c, 'shop', C()))).toBe('DAY_CLOSED');
  });

  it('a reversal row copies the ORIGINAL business date and follows the same rule (this is how a void is blocked)', () => {
    const c = memDb(conns);
    const orig = cash(c, 'shop', E(), -500);
    const reversal = (date: string) => cash(c, 'shop', date, 500, { reverses_entry_id: orig, ref_table: 'expenses', ref_id: 1 });
    close(c, 'shop', C());
    expect(msgOf(() => reversal(E()))).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    reopen(c, 'shop', C());
    expect(() => reversal(E())).not.toThrow();
    expect(scalar(c, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'shop'")).toBe(0);
  });

  it('closing a day itself is never refused (it posts nothing); the closing\'s own adjustment is dated like the day and follows the rule', () => {
    const c = memDb(conns);
    cash(c, 'shop', E(), 1000);
    close(c, 'shop', C()); // closing row insert: fine, a later day
    expect(() => close(c, 'shop', E())).not.toThrow(); // closing an EARLIER day without a count is fine
    expect(() => close(c, 'shop', L())).not.toThrow();
    // an adjustment dated on the earlier closed day / before the latest closed day is what the service refuses; the trigger agrees
    expect(msgOf(() => cash(c, 'shop', E(), -50, { type: 'cash_adjustment' }))).toBe('DAY_CLOSED');
    expect(msgOf(() => cash(c, 'shop', daysAgo(5), -50, { type: 'cash_adjustment' }))).toBe('BACKDATE_BEFORE_CLOSED_DAY');
  });

  it('future dates are still R-FD first and impossible dates INVALID_BUSINESS_DATE (older triggers are untouched)', () => {
    const c = memDb(conns);
    close(c, 'shop', C());
    expect(msgOf(() => cash(c, 'shop', daysAgo(-2)))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    // a book with no closed day: the impossible date reaches its own trigger (with a closed day the order of the triggers is not part of the contract)
    expect(msgOf(() => cash(c, 'telecom', '2020-13-01'))).toMatch(/INVALID_BUSINESS_DATE/);
  });
});

// ---------------------------------------------------------------------------------------------
type Row = Record<string, string | number | null>;
function insert(c: DatabaseSync, table: string, defaults: Row, over: Row): number {
  const row = { ...defaults, ...over };
  const cols = Object.keys(row);
  return Number(c.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
const day = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_days', { business_date: daysAgo(0), sales_cents: 1000, cost_alloc_cents: 600, electricity_alloc_cents: 100, profit_share_cents: 300, client_ref: uniq() }, o);
const payment = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_payments', { business_date: daysAgo(0), kind: 'materials', fund: 'cost', amount_cents: 500, description: 'Milk', client_ref: uniq() }, o);
const move = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_fund_moves', { business_date: daysAgo(0), from_fund: 'cost', to_fund: 'profit', amount_cents: 500, profit_effect_cents: 500, charge_relabel_cents: 0, cash_only_cents: 0, client_ref: uniq() }, o);
const voidSql = (c: DatabaseSync, table: string, id: number) =>
  c.prepare(`UPDATE ${table} SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?`).run(id);

describe('Ice Cream record triggers', () => {
  const makers: Array<[string, (c: DatabaseSync, o: Row) => number]> = [['icecream_days', day], ['icecream_payments', payment], ['icecream_fund_moves', move]];

  it.each(makers)('%s insert: on the closed day DAY_CLOSED, before it BACKDATE_BEFORE_CLOSED_DAY, after it fine; a closed SHOP day is irrelevant', (_t, make) => {
    const c = memDb(conns);
    close(c, 'shop', daysAgo(1)); // irrelevant to Ice Cream
    expect(() => make(c, { business_date: daysAgo(8) })).not.toThrow();
    close(c, 'icecream', C());
    expect(msgOf(() => make(c, { business_date: C() }))).toMatch(/DAY_CLOSED/);
    expect(msgOf(() => make(c, { business_date: E() }))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(msgOf(() => make(c, { business_date: daysAgo(4) }))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(() => make(c, { business_date: daysAgo(2) })).not.toThrow();
    expect(() => make(c, { business_date: daysAgo(0) })).not.toThrow();
    reopen(c, 'icecream', C());
    expect(() => make(c, { business_date: E() })).not.toThrow(); // reopened: nothing closed
    expect(() => make(c, { business_date: C() })).not.toThrow();
  });

  it('the posted -> void flip of a day and of a move is judged on the record\'s own date', () => {
    const c = memDb(conns);
    const dayOld = day(c, { business_date: E() });
    const moveOld = move(c, { business_date: E() });
    const dayOn = day(c, { business_date: C() });
    const moveOn = move(c, { business_date: C() });
    const dayNew = day(c, { business_date: L() });
    const moveNew = move(c, { business_date: L() });
    close(c, 'icecream', C());
    expect(msgOf(() => voidSql(c, 'icecream_days', dayOld))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(msgOf(() => voidSql(c, 'icecream_fund_moves', moveOld))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(msgOf(() => voidSql(c, 'icecream_days', dayOn))).toMatch(/DAY_CLOSED/);
    expect(msgOf(() => voidSql(c, 'icecream_fund_moves', moveOn))).toMatch(/DAY_CLOSED/);
    expect(() => voidSql(c, 'icecream_days', dayNew)).not.toThrow();
    expect(() => voidSql(c, 'icecream_fund_moves', moveNew)).not.toThrow();
    expect(scalar(c, "SELECT COUNT(*) FROM icecream_days WHERE status = 'void'")).toBe(1); // the refused flips changed nothing
    reopen(c, 'icecream', C());
    expect(() => voidSql(c, 'icecream_days', dayOld)).not.toThrow();
    expect(() => voidSql(c, 'icecream_fund_moves', moveOld)).not.toThrow();
  });
});
