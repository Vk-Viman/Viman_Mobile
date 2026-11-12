// Phase 10 database rules (migration 014: icecream_days, icecream_sales, icecream_payments, icecream_fund_moves) - raw SQL on in-memory
// SQLite, so the schema itself is proven independent of the services. Protects:
//   10.2  CHECK cost + electricity + profit share = sales for every day; shares and sales are bounded; profit share negative ONLY when confirmed;
//   C9    ONE posted day per date (partial unique index); voided rows stay and free the date;
//   E4    payments: the category can never be "electricity" (any case / padding), kind and fund are enums, amount 1..10^12, description not blank;
//   10.3  fund moves: from <> to; release split (eligible + cash-only = amount, eligible >= 0, no re-label); re-allocation = minus the full amount;
//         Cost <-> Electricity: profit effect 0, cash-only 0, re-label 0..amount;
//   R1    only posted -> void may change, never back; business date and posting time never change; nothing is deleted; items are append-only;
//   R-FD / dates  future dates refused, impossible dates refused (incl. 2020-13-01), backdating accepted;
//   R9    the day-closed backstop on the three record tables (a move writes no cash entry, so it needs its own guard).

import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { currentVersion, latestVersion, loadMigrations } from '../db/migrate.ts';
import { daysAgo, daysAhead, memDb, msgOf, scalar } from './helpers/inventory.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns) { try { c.close(); } catch { /* ignore */ } } conns.length = 0; });

let seq = 0;
const uniq = (): string => `db10-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
const names = (c: DatabaseSync, type: string) =>
  (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as unknown as { name: string }[]).map((r) => r.name);
const upd = (c: DatabaseSync, table: string, set: string, id: number, ...p: Array<string | number | null>) =>
  c.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...p, id);
const today = (): string => daysAgo(0);

type Row = Record<string, string | number | null>;
function insert(c: DatabaseSync, table: string, defaults: Row, over: Row): number {
  const row = { ...defaults, ...over };
  const cols = Object.keys(row);
  return Number(c.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
/** A valid day: sales 1,000 = cost 600 + electricity 100 + profit 300 (cents are used as given; only the sum matters). */
const day = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_days', { business_date: today(), sales_cents: 1000, cost_alloc_cents: 600, electricity_alloc_cents: 100, profit_share_cents: 300, client_ref: uniq() }, o);
const item = (c: DatabaseSync, dayId: number, o: Row = {}) =>
  insert(c, 'icecream_sales', { icecream_day_id: dayId, item_name: 'Cone', qty: 2, unit_price_cents: 50, line_total_cents: 100 }, o);
const payment = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_payments', { business_date: today(), kind: 'materials', fund: 'cost', amount_cents: 500, description: 'Milk', client_ref: uniq() }, o);
const move = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'icecream_fund_moves', { business_date: today(), from_fund: 'cost', to_fund: 'profit', amount_cents: 500, profit_effect_cents: 500, charge_relabel_cents: 0, cash_only_cents: 0, client_ref: uniq() }, o);
const closeIce = (c: DatabaseSync, date: string) =>
  insert(c, 'daily_closings', { book: 'icecream', business_date: date, expected_cents: 0 }, {});

describe('migration 014', () => {
  it('fresh DB reaches latestVersion >= 14 with the four tables, the unique-day index and the triggers', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(14);
    expect(currentVersion(c)).toBe(latestVersion());
    expect(loadMigrations().some((m) => m.name === '014_icecream.sql')).toBe(true);
    expect(names(c, 'table')).toEqual(expect.arrayContaining(['icecream_days', 'icecream_sales', 'icecream_payments', 'icecream_fund_moves']));
    expect(names(c, 'index')).toContain('ux_icecream_days_posted');
    expect(names(c, 'trigger')).toEqual(expect.arrayContaining([
      'trg_icecream_days_future_date', 'trg_icecream_days_immutable', 'trg_icecream_days_no_delete', 'trg_icecream_days_day_closed',
      'trg_icecream_payments_future_date', 'trg_icecream_payments_immutable', 'trg_icecream_payments_no_delete', 'trg_icecream_payments_day_closed',
      'trg_icecream_fund_moves_future_date', 'trg_icecream_fund_moves_immutable', 'trg_icecream_fund_moves_no_delete', 'trg_icecream_fund_moves_day_closed',
      'trg_icecream_sales_no_update', 'trg_icecream_sales_no_delete',
    ]));
  });
  it('starts empty', () => {
    const c = memDb(conns);
    for (const t of ['icecream_days', 'icecream_sales', 'icecream_payments', 'icecream_fund_moves']) expect(scalar(c, `SELECT COUNT(*) FROM ${t}`), t).toBe(0);
  });
});

describe('icecream_days', () => {
  it('10.2 sum CHECK: cost + electricity + profit share must equal sales, in every combination', () => {
    const c = memDb(conns);
    expect(() => day(c, { business_date: daysAgo(1) })).not.toThrow();
    for (const bad of [{ profit_share_cents: 301 }, { profit_share_cents: 299 }, { cost_alloc_cents: 601 }, { electricity_alloc_cents: 99 }, { sales_cents: 1001 }]) {
      expect(msgOf(() => day(c, { business_date: daysAgo(2), ...bad })), JSON.stringify(bad)).toMatch(/CHECK/);
    }
    expect(() => day(c, { business_date: daysAgo(3), sales_cents: 0, cost_alloc_cents: 0, electricity_alloc_cents: 0, profit_share_cents: 0 })).not.toThrow();
  });

  it('allocations and sales are non-negative and bounded by 10^12', () => {
    const c = memDb(conns);
    expect(msgOf(() => day(c, { sales_cents: -100, cost_alloc_cents: 0, electricity_alloc_cents: 0, profit_share_cents: -100, negative_confirmed: 1 }))).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { cost_alloc_cents: -1, profit_share_cents: 401 }))).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { electricity_alloc_cents: -1, profit_share_cents: 401 }))).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { sales_cents: 1_000_000_000_001, cost_alloc_cents: 1, electricity_alloc_cents: 1, profit_share_cents: 999_999_999_999 }))).toMatch(/CHECK/);
    expect(() => day(c, { business_date: daysAgo(1), sales_cents: 1_000_000_000_000, cost_alloc_cents: 1, electricity_alloc_cents: 1, profit_share_cents: 999_999_999_998 })).not.toThrow();
  });

  it('10.3: a negative profit share is stored ONLY when negative_confirmed = 1; the flag is 0/1', () => {
    const c = memDb(conns);
    const neg = { sales_cents: 1000, cost_alloc_cents: 900, electricity_alloc_cents: 200, profit_share_cents: -100 };
    expect(msgOf(() => day(c, neg))).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { ...neg, negative_confirmed: 0 }))).toMatch(/CHECK/);
    expect(() => day(c, { ...neg, negative_confirmed: 1 })).not.toThrow();
    expect(msgOf(() => day(c, { business_date: daysAgo(1), negative_confirmed: 2 }))).toMatch(/CHECK/);
  });

  it('ONE posted day per business date; a void frees the date; voided rows are kept; different dates are independent', () => {
    const c = memDb(conns);
    const a = day(c);
    expect(msgOf(() => day(c))).toMatch(/UNIQUE/);
    expect(() => day(c, { business_date: daysAgo(1) })).not.toThrow();
    c.prepare("UPDATE icecream_days SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(a);
    expect(() => day(c)).not.toThrow(); // replacement for the same date
    expect(scalar(c, 'SELECT COUNT(*) FROM icecream_days WHERE business_date = ?', today())).toBe(2);
    expect(scalar(c, "SELECT COUNT(*) FROM icecream_days WHERE business_date = ? AND status = 'posted'", today())).toBe(1);
  });

  it('client_ref is unique; status posted|void with matching void fields', () => {
    const c = memDb(conns);
    const ref = uniq();
    day(c, { client_ref: ref });
    expect(msgOf(() => day(c, { business_date: daysAgo(1), client_ref: ref }))).toMatch(/UNIQUE/);
    expect(msgOf(() => day(c, { business_date: daysAgo(2), status: 'void' }))).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { business_date: daysAgo(2), status: 'gone' }))).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { business_date: daysAgo(2), voided_at: '2026-01-01T00:00:00.000Z', void_reason: 'x' }))).toMatch(/CHECK/);
  });

  it('dates: real calendar days only (even 2020-13-01), future refused (R-FD), backdated accepted', () => {
    const c = memDb(conns);
    for (const d of ['2020-13-01', '2020-02-31', '2020-2-3', '']) expect(msgOf(() => day(c, { business_date: d })), d).toMatch(/CHECK/);
    expect(msgOf(() => day(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => day(c, { business_date: today() })).not.toThrow();
    expect(() => day(c, { business_date: daysAgo(400) })).not.toThrow();
  });

  it('R1: only posted -> void may change, never back; business date and posting time never change; never deleted', () => {
    const c = memDb(conns);
    const id = day(c);
    for (const [set, val] of [['sales_cents', 5], ['cost_alloc_cents', 5], ['electricity_alloc_cents', 5], ['profit_share_cents', 5], ['negative_confirmed', 1], ['notes', 'x'], ['client_ref', 'z']] as const) {
      expect(msgOf(() => upd(c, 'icecream_days', `${set} = ?`, id, val)), set).toMatch(/ICECREAM_DAY_IMMUTABLE|CHECK/);
    }
    expect(msgOf(() => upd(c, 'icecream_days', 'business_date = ?', id, daysAgo(1)))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'icecream_days', 'posted_at = ?', id, '2020-01-01T00:00:00.000Z'))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'icecream_days', 'voided_at = ?', id, '2026-01-01T00:00:00.000Z'))).toMatch(/ICECREAM_DAY_IMMUTABLE/);
    expect(() => c.prepare("UPDATE icecream_days SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(id)).not.toThrow();
    expect(msgOf(() => upd(c, 'icecream_days', "status = 'posted', voided_at = NULL, void_reason = NULL", id))).toMatch(/ICECREAM_DAY_IMMUTABLE|CHECK|UNIQUE/);
    expect(msgOf(() => upd(c, 'icecream_days', 'void_reason = ?', id, 'other'))).toMatch(/ICECREAM_DAY_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM icecream_days WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});

describe('icecream_sales (item lines)', () => {
  it('line total = qty x unit price; qty 1..10^6; name not blank; day must exist (FK); lines are append-only', () => {
    const c = memDb(conns);
    const d = day(c);
    const id = item(c, d);
    expect(msgOf(() => item(c, d, { line_total_cents: 101 }))).toMatch(/CHECK/);
    expect(msgOf(() => item(c, d, { qty: 0, line_total_cents: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => item(c, d, { qty: 1_000_001, unit_price_cents: 0, line_total_cents: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => item(c, d, { item_name: '  ' }))).toMatch(/CHECK/);
    expect(msgOf(() => item(c, 99999))).toMatch(/FOREIGN KEY/);
    expect(msgOf(() => upd(c, 'icecream_sales', 'qty = 3', id))).toMatch(/ICECREAM_ITEM_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM icecream_sales WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});

describe('icecream_payments', () => {
  it('E4: the category can never be "electricity" in any case or padding; NULL and other text are fine', () => {
    const c = memDb(conns);
    for (const bad of ['electricity', 'Electricity', 'ELECTRICITY', ' electricity ', '  EleCtricity  ']) {
      expect(msgOf(() => payment(c, { category: bad })), JSON.stringify(bad)).toMatch(/CHECK/);
    }
    for (const kind of ['materials', 'electricity_bill', 'other_cost']) expect(msgOf(() => payment(c, { kind, category: 'electricity' }))).toMatch(/CHECK/);
    for (const ok of [null, 'Cups', 'electrical', 'electricity bill', 'Repairs']) expect(() => payment(c, { category: ok }), String(ok)).not.toThrow();
  });

  it('kind and fund are enums; amount 1..10^12; description not blank; client_ref unique; void fields match', () => {
    const c = memDb(conns);
    expect(msgOf(() => payment(c, { kind: 'wages' }))).toMatch(/CHECK/);
    expect(msgOf(() => payment(c, { fund: 'bank' }))).toMatch(/CHECK/);
    for (const a of [0, -1, 1_000_000_000_001]) expect(msgOf(() => payment(c, { amount_cents: a })), String(a)).toMatch(/CHECK/);
    expect(() => payment(c, { amount_cents: 1_000_000_000_000 })).not.toThrow();
    expect(msgOf(() => payment(c, { description: '  ' }))).toMatch(/CHECK/);
    const ref = uniq();
    payment(c, { client_ref: ref });
    expect(msgOf(() => payment(c, { client_ref: ref }))).toMatch(/UNIQUE/);
    expect(msgOf(() => payment(c, { status: 'void' }))).toMatch(/CHECK/);
    expect(msgOf(() => payment(c, { voided_at: '2026-01-01T00:00:00.000Z', void_reason: 'x' }))).toMatch(/CHECK/);
    for (const kind of ['materials', 'electricity_bill', 'other_cost']) for (const fund of ['cost', 'electricity', 'profit']) expect(() => payment(c, { kind, fund })).not.toThrow();
  });

  it('dates, R-FD and the R1 rules', () => {
    const c = memDb(conns);
    for (const d of ['2020-13-01', '2020-02-31', '']) expect(msgOf(() => payment(c, { business_date: d })), d).toMatch(/CHECK/);
    expect(msgOf(() => payment(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => payment(c, { business_date: daysAgo(30) })).not.toThrow();
    const id = payment(c);
    for (const [set, val] of [['kind', 'other_cost'], ['fund', 'profit'], ['amount_cents', 5], ['category', 'x'], ['description', 'x'], ['client_ref', 'z']] as const) {
      expect(msgOf(() => upd(c, 'icecream_payments', `${set} = ?`, id, val)), set).toMatch(/ICECREAM_PAYMENT_IMMUTABLE/);
    }
    expect(msgOf(() => upd(c, 'icecream_payments', 'business_date = ?', id, daysAgo(1)))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'icecream_payments', 'posted_at = ?', id, '2020-01-01T00:00:00.000Z'))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(() => c.prepare("UPDATE icecream_payments SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(id)).not.toThrow();
    expect(msgOf(() => upd(c, 'icecream_payments', 'void_reason = ?', id, 'other'))).toMatch(/ICECREAM_PAYMENT_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM icecream_payments WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});

describe('icecream_fund_moves - sign and split CHECKs (10.3, 10.4, D1, D4)', () => {
  it('from <> to, funds are enums, amount 1..10^12', () => {
    const c = memDb(conns);
    for (const f of ['cost', 'electricity', 'profit']) {
      expect(msgOf(() => move(c, { from_fund: f, to_fund: f, profit_effect_cents: 0, cash_only_cents: 0 })), f).toMatch(/CHECK/);
    }
    expect(msgOf(() => move(c, { from_fund: 'bank' }))).toMatch(/CHECK/);
    expect(msgOf(() => move(c, { to_fund: 'bank' }))).toMatch(/CHECK/);
    for (const a of [0, -5, 1_000_000_000_001]) expect(msgOf(() => move(c, { amount_cents: a, profit_effect_cents: a, cash_only_cents: 0 })), String(a)).toMatch(/CHECK/);
  });

  it('release (into Profit): eligible + cash-only = amount, eligible >= 0, cash-only >= 0, no re-label', () => {
    const c = memDb(conns);
    for (const from of ['cost', 'electricity']) {
      expect(() => move(c, { from_fund: from, to_fund: 'profit', amount_cents: 500, profit_effect_cents: 500, cash_only_cents: 0 })).not.toThrow(); // all eligible
      expect(() => move(c, { from_fund: from, to_fund: 'profit', amount_cents: 500, profit_effect_cents: 200, cash_only_cents: 300 })).not.toThrow(); // D4 split
      expect(() => move(c, { from_fund: from, to_fund: 'profit', amount_cents: 500, profit_effect_cents: 0, cash_only_cents: 500 })).not.toThrow(); // all cash-only
    }
    const bad: Row[] = [
      { profit_effect_cents: 200, cash_only_cents: 200 }, // does not add up
      { profit_effect_cents: 600, cash_only_cents: -100 }, // negative cash-only
      { profit_effect_cents: -500, cash_only_cents: 1000 }, // negative profit effect on a release
      { profit_effect_cents: 500, cash_only_cents: 0, charge_relabel_cents: 100 }, // a release never re-labels
      { profit_effect_cents: 0, cash_only_cents: 0 },
    ];
    for (const b of bad) expect(msgOf(() => move(c, { from_fund: 'cost', to_fund: 'profit', amount_cents: 500, ...b })), JSON.stringify(b)).toMatch(/CHECK/);
  });

  it('D1 re-allocation (out of Profit): profit effect = minus the FULL amount; no cash-only part, no re-label', () => {
    const c = memDb(conns);
    for (const to of ['cost', 'electricity']) {
      expect(() => move(c, { from_fund: 'profit', to_fund: to, amount_cents: 500, profit_effect_cents: -500, cash_only_cents: 0 })).not.toThrow();
      for (const b of [{ profit_effect_cents: 0 }, { profit_effect_cents: 500 }, { profit_effect_cents: -400 }, { profit_effect_cents: -500, cash_only_cents: 100 }, { profit_effect_cents: -500, charge_relabel_cents: 100 }]) {
        expect(msgOf(() => move(c, { from_fund: 'profit', to_fund: to, amount_cents: 500, cash_only_cents: 0, ...b })), JSON.stringify(b)).toMatch(/CHECK/);
      }
    }
  });

  it('Cost <-> Electricity: profit effect 0, cash-only 0, re-label between 0 and the amount', () => {
    const c = memDb(conns);
    for (const [from, to] of [['cost', 'electricity'], ['electricity', 'cost']]) {
      for (const relabel of [0, 200, 500]) expect(() => move(c, { from_fund: from, to_fund: to, amount_cents: 500, profit_effect_cents: 0, cash_only_cents: 0, charge_relabel_cents: relabel })).not.toThrow();
      for (const b of [{ charge_relabel_cents: 501 }, { charge_relabel_cents: -1 }, { profit_effect_cents: 100 }, { profit_effect_cents: -100 }, { cash_only_cents: 100 }]) {
        expect(msgOf(() => move(c, { from_fund: from, to_fund: to, amount_cents: 500, profit_effect_cents: 0, cash_only_cents: 0, charge_relabel_cents: 0, ...b })), JSON.stringify(b)).toMatch(/CHECK/);
      }
    }
  });

  it('client_ref unique; status posted|void with matching void fields; dates and R-FD', () => {
    const c = memDb(conns);
    const ref = uniq();
    move(c, { client_ref: ref });
    expect(msgOf(() => move(c, { client_ref: ref }))).toMatch(/UNIQUE/);
    expect(msgOf(() => move(c, { status: 'void' }))).toMatch(/CHECK/);
    expect(msgOf(() => move(c, { voided_at: '2026-01-01T00:00:00.000Z', void_reason: 'x' }))).toMatch(/CHECK/);
    for (const d of ['2020-13-01', '2020-02-31', '']) expect(msgOf(() => move(c, { business_date: d })), d).toMatch(/CHECK/);
    expect(msgOf(() => move(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => move(c, { business_date: daysAgo(90) })).not.toThrow();
  });

  it('R1: immutable except posted -> void; business date / posting time fixed; never deleted', () => {
    const c = memDb(conns);
    const id = move(c);
    for (const [set, val] of [['from_fund', 'electricity'], ['to_fund', 'electricity'], ['amount_cents', 600], ['profit_effect_cents', 0], ['charge_relabel_cents', 5], ['cash_only_cents', 5], ['note', 'x'], ['client_ref', 'z']] as const) {
      expect(msgOf(() => upd(c, 'icecream_fund_moves', `${set} = ?`, id, val)), set).toMatch(/ICECREAM_FUND_MOVE_IMMUTABLE|CHECK/);
    }
    expect(msgOf(() => upd(c, 'icecream_fund_moves', 'business_date = ?', id, daysAgo(1)))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'icecream_fund_moves', 'posted_at = ?', id, '2020-01-01T00:00:00.000Z'))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(() => c.prepare("UPDATE icecream_fund_moves SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(id)).not.toThrow();
    expect(msgOf(() => upd(c, 'icecream_fund_moves', 'void_reason = ?', id, 'other'))).toMatch(/ICECREAM_FUND_MOVE_IMMUTABLE/);
    expect(msgOf(() => c.prepare('DELETE FROM icecream_fund_moves WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});

describe('R9 backstop - a closed Ice Cream day refuses the records (and their voids)', () => {
  it('insert on a closed day is DAY_CLOSED for days, payments and moves (a move has no cash entry, so it needs this guard); other days and a reopen are fine', () => {
    const c = memDb(conns);
    const d = daysAgo(3);
    closeIce(c, d);
    expect(msgOf(() => day(c, { business_date: d }))).toMatch(/DAY_CLOSED/);
    expect(msgOf(() => payment(c, { business_date: d }))).toMatch(/DAY_CLOSED/);
    expect(msgOf(() => move(c, { business_date: d }))).toMatch(/DAY_CLOSED/);
    expect(() => day(c, { business_date: daysAgo(2) })).not.toThrow();
    expect(() => payment(c, { business_date: daysAgo(2) })).not.toThrow();
    expect(() => move(c, { business_date: daysAgo(2) })).not.toThrow();
    c.prepare("UPDATE daily_closings SET reopened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reopen_reason = 'fix' WHERE book = 'icecream' AND business_date = ?").run(d);
    expect(() => day(c, { business_date: d })).not.toThrow();
    expect(() => move(c, { business_date: d })).not.toThrow();
  });

  it('voiding a day or a move dated on a closed day is DAY_CLOSED; a closed SHOP day does not matter', () => {
    const c = memDb(conns);
    const d = daysAgo(4);
    const dayId = day(c, { business_date: d });
    const moveId = move(c, { business_date: d });
    const payId = payment(c, { business_date: d });
    insert(c, 'daily_closings', { book: 'shop', business_date: d, expected_cents: 0 }, {});
    const voidSql = (t: string, id: number) => c.prepare(`UPDATE ${t} SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?`).run(id);
    expect(() => voidSql('icecream_days', dayId)).not.toThrow();
    const dayId2 = day(c, { business_date: d });
    closeIce(c, d);
    expect(msgOf(() => voidSql('icecream_days', dayId2))).toMatch(/DAY_CLOSED/);
    expect(msgOf(() => voidSql('icecream_fund_moves', moveId))).toMatch(/DAY_CLOSED/);
    // a payment void writes its reversal cash entry, which the cash_entries trigger refuses; the status flip alone is a service concern
    expect(payId).toBeGreaterThan(0);
  });
});
