// Phase 8 database rules (migration 012: expenses, capital_entries, cash_counts, daily_closings, icecream_fund_entries, the DAY_CLOSED
// backstop and the INVALID_BUSINESS_DATE follow-up) - raw SQL on in-memory SQLite. Protects the schema-level guarantees:
//   E2     no 'electricity' expense category can be stored; expenses are Shop/Telecom only;
//   10.2   fund-iff-icecream CHECKs on capital entries and cash counts (and the existing one on cash_entries);
//   R1     business rows are never edited (only posted -> void) and never deleted; the fund ledger is append-only;
//   R9     a closed day refuses cash entries (DAY_CLOSED); a closing may only be REOPENED or RE-CLOSED (DAILY_CLOSING_IMMUTABLE);
//   R-FD   no future dates on any new table; strict real-date CHECKs; posted_at and business_date never change;
//   follow-up   INVALID_BUSINESS_DATE (2020-13-01) is refused on every business-date table of migrations 003-011.

import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { currentVersion, latestVersion, loadMigrations } from '../db/migrate.ts';
import { daysAgo, daysAhead, memDb, msgOf, scalar, sqlProduct } from './helpers/inventory.ts';
import { sqlSale } from './helpers/phase5.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns) { try { c.close(); } catch { /* ignore */ } } conns.length = 0; });

let seq = 0;
const uniq = (): string => `db8-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
const names = (c: DatabaseSync, type: string) =>
  (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as unknown as { name: string }[]).map((r) => r.name);
const upd = (c: DatabaseSync, table: string, set: string, id: number, ...p: Array<string | number | null>) =>
  c.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...p, id);
const today = (): string => daysAgo(0);

// ---------- row builders (raw SQL, every column overridable) ----------
type Row = Record<string, string | number | null>;
function insert(c: DatabaseSync, table: string, defaults: Row, over: Row): number {
  const row = { ...defaults, ...over };
  const cols = Object.keys(row);
  return Number(c.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
const expense = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'expenses', { business_date: today(), book: 'shop', category: 'rent', amount_cents: 1000, description: 'Rent', client_ref: uniq() }, o);
const capital = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'capital_entries', { business_date: today(), book: 'shop', fund: null, kind: 'opening_balance', amount_cents: 1000, client_ref: uniq() }, o);
const count = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'cash_counts', { book: 'shop', fund: null, business_date: today(), expected_cents: 1000, counted_cents: 1000, difference_cents: 0, note: '', client_ref: uniq() }, o);
const closing = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'daily_closings', { book: 'shop', business_date: today(), expected_cents: 1000 }, o);
const fundRow = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_fund_entries', { business_date: today(), fund: 'cost', amount_cents: 100, kind: 'opening_balance' }, o);
const cash = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'cash_entries', { book: 'shop', business_date: today(), type: 'expense', amount_cents: -100 }, o);

// =============================================================================================
describe('migration 012', () => {
  it('fresh DB reaches latestVersion >= 12 with the five tables and their triggers', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(12);
    expect(currentVersion(c)).toBe(latestVersion());
    expect(loadMigrations().some((m) => m.name === '012_cashbooks_expenses.sql')).toBe(true);
    expect(names(c, 'table')).toEqual(expect.arrayContaining(['expenses', 'capital_entries', 'cash_counts', 'daily_closings', 'icecream_fund_entries']));
    expect(names(c, 'trigger')).toEqual(expect.arrayContaining([
      'trg_expenses_future_date', 'trg_expenses_immutable', 'trg_expenses_no_delete', 'trg_capital_entries_immutable', 'trg_cash_counts_immutable',
      'trg_daily_closings_immutable', 'trg_daily_closings_no_delete', 'trg_daily_closings_future_date', 'trg_icecream_fund_entries_no_update',
      'trg_icecream_fund_entries_no_delete', 'trg_cash_entries_day_closed', 'trg_cash_entries_valid_date',
    ]));
  });

  it('starts empty: a fresh start has no expenses, openings, counts, closings or fund rows', () => {
    const c = memDb(conns);
    for (const t of ['expenses', 'capital_entries', 'cash_counts', 'daily_closings', 'icecream_fund_entries']) expect(scalar(c, `SELECT COUNT(*) FROM ${t}`), t).toBe(0);
  });
});

// =============================================================================================
describe('expenses - E2 and the usual record rules', () => {
  it('E2: category electricity (any case) cannot be stored; only the nine categories can; the book is shop or telecom only', () => {
    const c = memDb(conns);
    for (const bad of ['electricity', 'Electricity', 'ELECTRICITY', 'electric', 'snacks', '']) {
      expect(msgOf(() => expense(c, { category: bad })), bad).toMatch(/CHECK/);
    }
    for (const ok of ['water', 'rent', 'internet', 'transport', 'repairs', 'cleaning_supplies', 'packaging', 'stationery', 'other']) {
      expect(() => expense(c, { category: ok }), ok).not.toThrow();
    }
    expect(msgOf(() => expense(c, { book: 'icecream' }))).toMatch(/CHECK/);
    expect(msgOf(() => expense(c, { book: 'warehouse' }))).toMatch(/CHECK/);
    expect(() => expense(c, { book: 'telecom' })).not.toThrow();
  });

  it('amount 1..10^12, description not blank, client_ref unique, status posted|void with matching void fields', () => {
    const c = memDb(conns);
    for (const a of [0, -1, 1_000_000_000_001]) expect(msgOf(() => expense(c, { amount_cents: a })), String(a)).toMatch(/CHECK/);
    expect(() => expense(c, { amount_cents: 1 })).not.toThrow();
    expect(() => expense(c, { amount_cents: 1_000_000_000_000 })).not.toThrow();
    expect(msgOf(() => expense(c, { description: '   ' }))).toMatch(/CHECK/);
    const ref = uniq();
    expense(c, { client_ref: ref });
    expect(msgOf(() => expense(c, { client_ref: ref }))).toMatch(/UNIQUE/);
    expect(msgOf(() => expense(c, { status: 'void' }))).toMatch(/CHECK/); // void needs voided_at + reason
    expect(msgOf(() => expense(c, { status: 'gone' }))).toMatch(/CHECK/);
    expect(msgOf(() => expense(c, { voided_at: '2026-01-01T00:00:00.000Z', void_reason: 'x' }))).toMatch(/CHECK/); // posted must not have them
  });

  it('dates: real calendar days only (even 2020-13-01), future refused (R-FD), backdated accepted', () => {
    const c = memDb(conns);
    for (const d of ['2020-13-01', '2020-02-31', '2020-2-3', '']) expect(msgOf(() => expense(c, { business_date: d })), d).toMatch(/CHECK/);
    expect(msgOf(() => expense(c, { business_date: 'abc' }))).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED/); // 'abc' sorts after any date: either guard stops it
    expect(msgOf(() => expense(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => expense(c, { business_date: today() })).not.toThrow();
    expect(() => expense(c, { business_date: daysAgo(400) })).not.toThrow();
    expect(() => expense(c, { business_date: '2024-02-29' })).not.toThrow();
  });

  it('R1: only posted -> void may change, never back; business date and posting time never change; never deleted', () => {
    const c = memDb(conns);
    const id = expense(c);
    for (const [set, val] of [['amount_cents', 5], ['book', 'telecom'], ['category', 'water'], ['description', 'x'], ['notes', 'x'], ['client_ref', 'z']] as const) {
      expect(msgOf(() => upd(c, 'expenses', `${set} = ?`, id, val)), set).toMatch(/EXPENSE_IMMUTABLE/);
    }
    expect(msgOf(() => upd(c, 'expenses', 'business_date = ?', id, daysAgo(1)))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'expenses', 'posted_at = ?', id, '2020-01-01T00:00:00.000Z'))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'expenses', 'voided_at = ?', id, '2026-01-01T00:00:00.000Z'))).toMatch(/EXPENSE_IMMUTABLE/); // not while posted
    expect(() => c.prepare("UPDATE expenses SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(id)).not.toThrow();
    expect(msgOf(() => upd(c, 'expenses', "status = 'posted', voided_at = NULL, void_reason = NULL", id))).toMatch(/EXPENSE_IMMUTABLE|CHECK/);
    expect(msgOf(() => upd(c, 'expenses', 'void_reason = ?', id, 'other'))).toMatch(/EXPENSE_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM expenses WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});

// =============================================================================================
describe('capital_entries - opening balances', () => {
  it('10.2: fund is required for Ice Cream and forbidden for the other books (CHECK, both directions)', () => {
    const c = memDb(conns);
    expect(msgOf(() => capital(c, { book: 'icecream', fund: null }))).toMatch(/CHECK/);
    expect(msgOf(() => capital(c, { book: 'shop', fund: 'cost' }))).toMatch(/CHECK/);
    expect(msgOf(() => capital(c, { book: 'telecom', fund: 'profit' }))).toMatch(/CHECK/);
    expect(msgOf(() => capital(c, { book: 'icecream', fund: 'loans' }))).toMatch(/CHECK/);
    expect(() => capital(c, { book: 'icecream', fund: 'electricity' })).not.toThrow();
    expect(() => capital(c, { book: 'shop' })).not.toThrow();
    expect(() => capital(c, { book: 'telecom' })).not.toThrow();
  });

  it('at most one POSTED opening balance per book (per fund for Ice Cream); voiding frees the slot; capital entries are not limited', () => {
    const c = memDb(conns);
    const a = capital(c, { book: 'shop' });
    expect(msgOf(() => capital(c, { book: 'shop' }))).toMatch(/UNIQUE/);
    expect(() => capital(c, { book: 'telecom' })).not.toThrow();
    capital(c, { book: 'icecream', fund: 'cost' });
    capital(c, { book: 'icecream', fund: 'profit' });
    expect(msgOf(() => capital(c, { book: 'icecream', fund: 'cost' }))).toMatch(/UNIQUE/);
    expect(() => capital(c, { book: 'shop', kind: 'capital' })).not.toThrow();
    expect(() => capital(c, { book: 'shop', kind: 'capital' })).not.toThrow();
    c.prepare("UPDATE capital_entries SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(a);
    expect(() => capital(c, { book: 'shop' })).not.toThrow(); // re-entered after the void
    expect(msgOf(() => capital(c, { kind: 'dividend' }))).toMatch(/CHECK/);
  });

  it('amount, dates, immutability and no delete follow the record rules', () => {
    const c = memDb(conns);
    for (const a of [0, -5, 1_000_000_000_001]) expect(msgOf(() => capital(c, { amount_cents: a, book: 'telecom' })), String(a)).toMatch(/CHECK/);
    expect(msgOf(() => capital(c, { business_date: '2020-13-01', book: 'telecom' }))).toMatch(/CHECK/);
    expect(msgOf(() => capital(c, { business_date: daysAhead(2), book: 'telecom' }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    const id = capital(c, { book: 'telecom', business_date: daysAgo(30) }); // go-live date in the past is fine
    expect(msgOf(() => upd(c, 'capital_entries', 'amount_cents = ?', id, 7))).toMatch(/CAPITAL_ENTRY_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'capital_entries', 'fund = ?', id, 'cost'))).toMatch(/CAPITAL_ENTRY_IMMUTABLE|CHECK/);
    expect(msgOf(() => upd(c, 'capital_entries', 'business_date = ?', id, today()))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'capital_entries', 'posted_at = ?', id, '2020-01-01T00:00:00.000Z'))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM capital_entries WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});

// =============================================================================================
describe('cash_counts', () => {
  it('difference = counted - expected (CHECK); counted >= 0; expected may be negative', () => {
    const c = memDb(conns);
    expect(msgOf(() => count(c, { expected_cents: 1000, counted_cents: 900, difference_cents: 100, note: 'x' }))).toMatch(/CHECK/);
    expect(() => count(c, { expected_cents: 1000, counted_cents: 900, difference_cents: -100, note: 'short' })).not.toThrow();
    expect(msgOf(() => count(c, { counted_cents: -1, difference_cents: -1001, note: 'x' }))).toMatch(/CHECK/);
    expect(() => count(c, { expected_cents: -500, counted_cents: 0, difference_cents: 500, note: 'over' })).not.toThrow();
  });

  it('C4: a non-zero difference needs a note; a zero difference may have none', () => {
    const c = memDb(conns);
    expect(msgOf(() => count(c, { counted_cents: 900, difference_cents: -100, note: '' }))).toMatch(/CHECK/);
    expect(msgOf(() => count(c, { counted_cents: 900, difference_cents: -100, note: '   ' }))).toMatch(/CHECK/);
    expect(() => count(c, { counted_cents: 1000, difference_cents: 0, note: '' })).not.toThrow();
  });

  it('10.2 fund-iff-icecream: the fund is present exactly when the book is Ice Cream AND the difference is non-zero (all four combinations)', () => {
    const c = memDb(conns);
    const over = { counted_cents: 900, difference_cents: -100, note: 'short' };
    expect(() => count(c, { book: 'icecream', fund: 'profit', ...over })).not.toThrow(); // icecream, diff != 0, fund
    expect(msgOf(() => count(c, { book: 'icecream', fund: null, ...over }))).toMatch(/CHECK/); // icecream, diff != 0, no fund
    expect(msgOf(() => count(c, { book: 'icecream', fund: 'profit' }))).toMatch(/CHECK/); // icecream, diff = 0, fund
    expect(() => count(c, { book: 'icecream', fund: null })).not.toThrow(); // icecream, diff = 0, no fund
    expect(msgOf(() => count(c, { book: 'shop', fund: 'profit', ...over }))).toMatch(/CHECK/); // shop with fund
    expect(() => count(c, { book: 'shop', fund: null, ...over })).not.toThrow();
    expect(msgOf(() => count(c, { book: 'telecom', fund: 'cost', ...over }))).toMatch(/CHECK/);
  });

  it('immutable except posted -> void and a ONE-TIME link to the adjustment entry; dates strict; never deleted', () => {
    const c = memDb(conns);
    const id = count(c);
    const entry = cash(c, { type: 'cash_adjustment' });
    const entry2 = cash(c, { type: 'cash_adjustment' });
    expect(() => upd(c, 'cash_counts', 'cash_entry_id = ?', id, entry)).not.toThrow();
    expect(msgOf(() => upd(c, 'cash_counts', 'cash_entry_id = ?', id, entry2))).toMatch(/CASH_COUNT_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'cash_counts', 'counted_cents = ?', id, 5))).toMatch(/CASH_COUNT_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'cash_counts', 'note = ?', id, 'x'))).toMatch(/CASH_COUNT_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'cash_counts', 'business_date = ?', id, daysAgo(2)))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(() => c.prepare("UPDATE cash_counts SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(id)).not.toThrow();
    expect(msgOf(() => upd(c, 'cash_counts', 'void_reason = ?', id, 'z'))).toMatch(/CASH_COUNT_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM cash_counts WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(msgOf(() => count(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => count(c, { business_date: '2020-13-01' }))).toMatch(/CHECK/);
    const ref = uniq();
    count(c, { client_ref: ref });
    expect(msgOf(() => count(c, { client_ref: ref }))).toMatch(/UNIQUE/);
  });
});

// =============================================================================================
describe('daily_closings - closed / reopened / re-closed', () => {
  const stamp = (n: number) => `2026-11-1${n}T10:00:00.000Z`;

  it('one row per (book, date); amounts checked; a future day cannot be closed; no delete', () => {
    const c = memDb(conns);
    closing(c, { book: 'shop', business_date: daysAgo(1) });
    expect(msgOf(() => closing(c, { book: 'shop', business_date: daysAgo(1) }))).toMatch(/UNIQUE/);
    expect(() => closing(c, { book: 'telecom', business_date: daysAgo(1) })).not.toThrow();
    expect(msgOf(() => closing(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => closing(c, { business_date: '2020-13-01' }))).toMatch(/CHECK/);
    expect(msgOf(() => closing(c, { book: 'warehouse' }))).toMatch(/CHECK/);
    // over/short must equal counted - expected, and is 0 when nothing was counted
    expect(msgOf(() => closing(c, { business_date: daysAgo(5), expected_cents: 1000, counted_cents: 900, over_short_cents: 5 }))).toMatch(/CHECK/);
    expect(msgOf(() => closing(c, { business_date: daysAgo(5), counted_cents: null, over_short_cents: 5 }))).toMatch(/CHECK/);
    expect(() => closing(c, { business_date: daysAgo(5), expected_cents: 1000, counted_cents: 900, over_short_cents: -100 })).not.toThrow();
    const id = closing(c, { business_date: daysAgo(6) });
    expect(msgOf(() => c.prepare('DELETE FROM daily_closings WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });

  it('a closed row cannot change anything except being reopened; the reopen needs a reason of at least 3 characters', () => {
    const c = memDb(conns);
    const id = closing(c, { business_date: daysAgo(1), closed_at: stamp(0) });
    for (const [set, val] of [['expected_cents', 5], ['counted_cents', 7], ['over_short_cents', 3], ['closed_at', stamp(5)], ['book', 'telecom'],
      ['business_date', daysAgo(2)], ['posted_at', stamp(1)], ['cash_count_id', null]] as const) {
      expect(msgOf(() => upd(c, 'daily_closings', `${set} = ?`, id, val)), set).toMatch(/DAILY_CLOSING_IMMUTABLE|CHECK/);
    }
    expect(msgOf(() => upd(c, 'daily_closings', "reopened_at = ?, reopen_reason = ''", id, stamp(1)))).toMatch(/CHECK/);
    expect(msgOf(() => upd(c, 'daily_closings', "reopened_at = ?, reopen_reason = 'ab'", id, stamp(1)))).toMatch(/CHECK/);
    expect(msgOf(() => upd(c, 'daily_closings', 'reopened_at = ?, reopen_reason = NULL', id, stamp(1)))).toMatch(/CHECK/);
    // a reopen that is not later than the close would leave the day closed: refused (the trigger demands reopened_at >= closed_at)
    expect(msgOf(() => upd(c, 'daily_closings', "reopened_at = ?, reopen_reason = 'mistake'", id, stamp(0).replace('10:00', '09:00')))).toMatch(/DAILY_CLOSING_IMMUTABLE/);
    expect(() => upd(c, 'daily_closings', "reopened_at = ?, reopen_reason = 'mistake'", id, stamp(1))).not.toThrow();
    expect(scalar(c, 'SELECT COUNT(*) FROM daily_closings WHERE id = ? AND (reopened_at IS NULL OR closed_at > reopened_at)', id)).toBe(0); // open now
  });

  it('a reopened row may only be re-closed (closed_at after reopened_at, new figures); reopen/close history fields stay consistent', () => {
    const c = memDb(conns);
    const id = closing(c, { business_date: daysAgo(1), closed_at: stamp(0) });
    upd(c, 'daily_closings', "reopened_at = ?, reopen_reason = 'mistake'", id, stamp(2));
    // not a valid re-close: closed_at not after the reopen, or the reopen fields changed
    expect(msgOf(() => upd(c, 'daily_closings', 'closed_at = ?', id, stamp(2)))).toMatch(/DAILY_CLOSING_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'daily_closings', 'closed_at = ?', id, stamp(1)))).toMatch(/DAILY_CLOSING_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'daily_closings', "closed_at = ?, reopen_reason = 'changed'", id, stamp(3)))).toMatch(/DAILY_CLOSING_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'daily_closings', 'closed_at = ?, reopened_at = NULL', id, stamp(3)))).toMatch(/DAILY_CLOSING_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'daily_closings', 'closed_at = ?, business_date = ?', id, stamp(3), daysAgo(3)))).toMatch(/DAILY_CLOSING_IMMUTABLE/);
    expect(() => upd(c, 'daily_closings', 'closed_at = ?, expected_cents = 1500, counted_cents = 1400, over_short_cents = -100', id, stamp(3))).not.toThrow();
    expect(scalar(c, 'SELECT COUNT(*) FROM daily_closings WHERE id = ? AND (reopened_at IS NULL OR closed_at > reopened_at)', id)).toBe(1); // closed again
    // and it can be reopened again
    expect(() => upd(c, 'daily_closings', "reopened_at = ?, reopen_reason = 'again'", id, stamp(4))).not.toThrow();
  });
});

// =============================================================================================
describe('DAY_CLOSED backstop on cash_entries (R9)', () => {
  it('aborts a cash entry dated on a day that is closed for the SAME book; allows other books/days; reopen allows; re-close blocks again', () => {
    const c = memDb(conns);
    const d = daysAgo(3);
    const id = closing(c, { book: 'shop', business_date: d });
    expect(msgOf(() => cash(c, { book: 'shop', business_date: d }))).toBe('DAY_CLOSED');
    expect(() => cash(c, { book: 'telecom', business_date: d })).not.toThrow();
    expect(() => cash(c, { book: 'shop', business_date: daysAgo(2) })).not.toThrow();
    expect(() => cash(c, { book: 'icecream', business_date: d, type: 'icecream_other_cost', fund: 'cost' })).not.toThrow();
    upd(c, 'daily_closings', "reopened_at = '2099-01-01T00:00:00.000Z', reopen_reason = 'fix'", id);
    expect(() => cash(c, { book: 'shop', business_date: d })).not.toThrow();
    upd(c, 'daily_closings', "closed_at = '2099-01-01T00:00:00.001Z'", id);
    expect(msgOf(() => cash(c, { book: 'shop', business_date: d }))).toBe('DAY_CLOSED');
    expect(scalar(c, "SELECT COUNT(*) FROM cash_entries WHERE book = 'shop' AND business_date = ?", d)).toBe(1); // only the one written while open
  });

  it('a reversal row (void) dated like the original is refused on a closed day too - the day must be reopened first', () => {
    const c = memDb(conns);
    const d = daysAgo(3);
    const orig = cash(c, { book: 'shop', business_date: d });
    closing(c, { book: 'shop', business_date: d });
    expect(msgOf(() => cash(c, { book: 'shop', business_date: d, amount_cents: 100, reverses_entry_id: orig }))).toBe('DAY_CLOSED');
  });
});

// =============================================================================================
describe('icecream_fund_entries - append-only fund ledger', () => {
  it('fund and kind lists, signed non-zero amounts, reversal rows point at what they cancel, dates strict', () => {
    const c = memDb(conns);
    expect(msgOf(() => fundRow(c, { fund: 'loans' }))).toMatch(/CHECK/);
    expect(msgOf(() => fundRow(c, { kind: 'gift' }))).toMatch(/CHECK/);
    expect(msgOf(() => fundRow(c, { amount_cents: 0 }))).toMatch(/CHECK/);
    for (const kind of ['daily_allocation', 'payment', 'fund_move', 'drawing', 'transfer_out', 'transfer_in', 'opening_balance', 'capital', 'cash_over_short']) {
      expect(() => fundRow(c, { kind, amount_cents: kind === 'payment' ? -5 : 5 }), kind).not.toThrow();
    }
    const orig = fundRow(c, { amount_cents: 50 });
    expect(msgOf(() => fundRow(c, { kind: 'reversal', amount_cents: -50 }))).toMatch(/CHECK/); // reversal without target
    expect(msgOf(() => fundRow(c, { kind: 'payment', amount_cents: -50, reverses_entry_id: orig }))).toMatch(/CHECK/); // target without reversal kind
    expect(() => fundRow(c, { kind: 'reversal', amount_cents: -50, reverses_entry_id: orig })).not.toThrow();
    expect(msgOf(() => fundRow(c, { kind: 'reversal', amount_cents: -50, reverses_entry_id: 99999 }))).toMatch(/FOREIGN KEY/);
    expect(msgOf(() => fundRow(c, { business_date: '2020-13-01' }))).toMatch(/CHECK/);
    expect(msgOf(() => fundRow(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => fundRow(c, { business_date: daysAgo(10) })).not.toThrow();
  });

  it('rows are never edited or deleted', () => {
    const c = memDb(conns);
    const id = fundRow(c);
    expect(msgOf(() => upd(c, 'icecream_fund_entries', 'amount_cents = ?', id, 5))).toMatch(/append-only/);
    expect(msgOf(() => upd(c, 'icecream_fund_entries', 'note = ?', id, 'x'))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM icecream_fund_entries WHERE id = ?').run(id))).toMatch(/append-only/);
  });

  it('every Ice Cream cash entry names a fund and other books never do (existing CHECK, still true with the new writers)', () => {
    const c = memDb(conns);
    expect(msgOf(() => cash(c, { book: 'icecream', type: 'cash_adjustment', fund: null }))).toMatch(/CHECK/);
    expect(msgOf(() => cash(c, { book: 'shop', type: 'cash_adjustment', fund: 'cost' }))).toMatch(/CHECK/);
    expect(() => cash(c, { book: 'icecream', type: 'cash_adjustment', fund: 'profit' })).not.toThrow();
  });
});

// =============================================================================================
describe('follow-up: INVALID_BUSINESS_DATE on the business-date tables of migrations 003-011', () => {
  // A month-13 date has the right SHAPE (so the old GLOB check passes) and date() answers NULL (so the old `date(x) = x` check is NULL =
  // "passed"). The BEFORE INSERT trigger fires first, before any NOT NULL / CHECK, so even a bare `INSERT (business_date)` is refused.
  const TABLES = ['stock_movements', 'cash_entries', 'purchases', 'purchase_returns', 'stocktakes', 'stock_losses', 'owner_drawings', 'sales',
    'sales_returns', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'opening_stock_batches', 'import_runs'];

  it.each(TABLES)('%s: 2020-13-01 and 2020-00-10 are refused with INVALID_BUSINESS_DATE; a real date gets past the trigger', (table) => {
    const c = memDb(conns);
    for (const d of ['2020-13-01', '2020-00-10', '2020-12-00', '2020-01-32']) {
      expect(msgOf(() => c.prepare(`INSERT INTO ${table} (business_date) VALUES (?)`).run(d)), `${table} ${d}`).toBe('INVALID_BUSINESS_DATE');
    }
    // the same bare insert with a real date stops later, on a missing column - proof that the trigger (not a blanket failure) refused the bad date
    expect(msgOf(() => c.prepare(`INSERT INTO ${table} (business_date) VALUES (?)`).run('2020-12-31'))).not.toBe('INVALID_BUSINESS_DATE');
  });

  it('full rows: a sale and a cash entry dated 2020-13-01 are refused; 2020-12-31 is accepted', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlSale(c, { date: '2020-13-01' }))).toBe('INVALID_BUSINESS_DATE');
    expect(msgOf(() => cash(c, { business_date: '2020-13-01' }))).toBe('INVALID_BUSINESS_DATE');
    expect(() => cash(c, { business_date: '2020-12-31' })).not.toThrow();
    const p = sqlProduct(c);
    expect(msgOf(() => c.prepare(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, '2020-13-01', 'opening', 1, 100)`).run(p))).toBe('INVALID_BUSINESS_DATE');
  });

  it('already-strict tables keep their CHECK and the future-date trigger still works on the old ones', () => {
    const c = memDb(conns);
    expect(msgOf(() => c.prepare(`INSERT INTO printing_supplies (business_date, amount_cents, description, client_ref) VALUES ('2020-13-01', 1, 'x', ?)`).run(uniq()))).toMatch(/CHECK/);
    expect(msgOf(() => cash(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
  });
});
