// Phase 7 database rules (migration 010: print_service_types, print_sales, printing_supplies) - raw SQL on in-memory SQLite.
// Protects the schema-level guarantees behind printing so no bug, retry or manual edit can corrupt history:
//   R12   seven seeded types with the default prices/costs; revenue = qty x price and cogs = qty x cost (CHECK);
//   R1    a sale/supply is never edited: only posted -> void (PRINT_SALE_IMMUTABLE / PRINTING_SUPPLY_IMMUTABLE), never back;
//   R-FD  no future business dates (FUTURE_DATE_NOT_ALLOWED), malformed dates refused, backdating allowed;
//   Sec 12 business_date and posted_at never change; no hard deletes; client_ref unique; type code permanent.
// Organised by table: migration + seed, service types, print_sales, printing_supplies.

import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { currentVersion, latestVersion, loadMigrations } from '../db/migrate.ts';
import { daysAgo, daysAhead, memDb, msgOf, scalar } from './helpers/inventory.ts';
import { SEEDED, sqlPrintSale, sqlSupply, typeId } from './helpers/phase7.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns) { try { c.close(); } catch { /* ignore */ } } conns.length = 0; });

const upd = (c: DatabaseSync, table: string, col: string, val: unknown, id: number) =>
  c.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(val as any, id);
const names = (c: DatabaseSync, type: string) =>
  (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as unknown as { name: string }[]).map((r) => r.name);

describe('migration 010 and the seed', () => {
  it('fresh DB reaches latestVersion >= 10 with the three tables and their triggers', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(10);
    expect(currentVersion(c)).toBe(latestVersion());
    expect(loadMigrations().some((m) => m.name.startsWith('010_'))).toBe(true);
    expect(names(c, 'table')).toEqual(expect.arrayContaining(['print_service_types', 'print_sales', 'printing_supplies']));
    expect(names(c, 'trigger')).toEqual(expect.arrayContaining([
      'trg_print_sales_future_date', 'trg_print_sales_immutable', 'trg_print_sales_no_delete', 'trg_print_sales_business_date_immutable',
      'trg_print_sales_posted_at_immutable', 'trg_printing_supplies_future_date', 'trg_printing_supplies_immutable',
      'trg_printing_supplies_no_delete', 'trg_print_service_types_code_immutable', 'trg_print_service_types_no_delete',
    ]));
  });

  it('seeds exactly the seven default service types with the default price and standard cost, all active, in order', () => {
    const c = memDb(conns);
    const rows = c.prepare('SELECT code, price_cents, cost_cents, active, sort_order FROM print_service_types ORDER BY sort_order').all() as unknown as
      Array<{ code: string; price_cents: number; cost_cents: number; active: number }>;
    expect(rows.map((r) => r.code)).toEqual(['BW_1S', 'BW_2S', 'CLR_1S', 'CLR_2S', 'PC_BW_1S', 'PC_BW_2S', 'CUSTOM']);
    for (const r of rows) {
      expect([Number(r.price_cents), Number(r.cost_cents)]).toEqual(SEEDED[r.code]);
      expect(Number(r.active)).toBe(1);
    }
  });

  it('no print rows exist after the migration (fresh start)', () => {
    const c = memDb(conns);
    expect(scalar(c, 'SELECT COUNT(*) FROM print_sales')).toBe(0);
    expect(scalar(c, 'SELECT COUNT(*) FROM printing_supplies')).toBe(0);
  });
});

describe('print_service_types', () => {
  it('code is unique and shaped A-Z 0-9 _ (2-20 chars)', () => {
    const c = memDb(conns);
    const ins = (code: string) => c.prepare('INSERT INTO print_service_types (code, name, price_cents, cost_cents) VALUES (?, ?, 1, 1)').run(code, 'x');
    expect(msgOf(() => ins('BW_1S'))).toMatch(/UNIQUE/);
    expect(msgOf(() => ins('lower'))).toMatch(/CHECK/);
    expect(msgOf(() => ins('A'))).toMatch(/CHECK/);
    expect(msgOf(() => ins('A'.repeat(21)))).toMatch(/CHECK/);
    expect(msgOf(() => ins('BAD CODE'))).toMatch(/CHECK/);
    expect(() => ins('A3')).not.toThrow();
    expect(() => ins('A'.repeat(20))).not.toThrow();
  });

  it('price and cost may not be negative, name may not be blank, active is 0/1', () => {
    const c = memDb(conns);
    const id = typeId(c, 'BW_1S');
    expect(msgOf(() => upd(c, 'print_service_types', 'price_cents', -1, id))).toMatch(/CHECK/);
    expect(msgOf(() => upd(c, 'print_service_types', 'cost_cents', -1, id))).toMatch(/CHECK/);
    expect(msgOf(() => upd(c, 'print_service_types', 'name', '   ', id))).toMatch(/CHECK/);
    expect(msgOf(() => upd(c, 'print_service_types', 'active', 2, id))).toMatch(/CHECK/);
    expect(() => upd(c, 'print_service_types', 'price_cents', 0, id)).not.toThrow();
  });

  it('the code can never change (PRINT_TYPE_CODE_IMMUTABLE); name/price/cost/active can', () => {
    const c = memDb(conns);
    const id = typeId(c, 'BW_1S');
    expect(msgOf(() => upd(c, 'print_service_types', 'code', 'OTHER', id))).toMatch(/PRINT_TYPE_CODE_IMMUTABLE/);
    upd(c, 'print_service_types', 'price_cents', 1800, id);
    upd(c, 'print_service_types', 'active', 0, id);
    expect(scalar(c, 'SELECT price_cents FROM print_service_types WHERE id = ?', id)).toBe(1800);
  });

  it('a type can never be deleted (RECORD_DELETE_FORBIDDEN)', () => {
    const c = memDb(conns);
    expect(msgOf(() => c.prepare('DELETE FROM print_service_types WHERE code = ?').run('CUSTOM'))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(scalar(c, 'SELECT COUNT(*) FROM print_service_types')).toBe(7);
  });
});

describe('print_sales', () => {
  it('stores a valid sale: revenue 4500 = 3 x 1500, cogs 1950 = 3 x 650; posted by default with a posting time', () => {
    const c = memDb(conns);
    const id = sqlPrintSale(c);
    const r = c.prepare('SELECT * FROM print_sales WHERE id = ?').get(id) as any;
    expect([Number(r.revenue_cents), Number(r.cogs_cents), r.status, r.voided_at, r.notes]).toEqual([4500, 1950, 'posted', null, '']);
    expect(r.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('revenue must equal qty x unit price, cogs must equal qty x unit cost (CHECK)', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlPrintSale(c, { revenue: 4501 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { revenue: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { cogs: 1949 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { qty: 2, revenue: 4500 }))).toMatch(/CHECK/); // revenue of 3 pages on a 2-page row
    expect(scalar(c, 'SELECT COUNT(*) FROM print_sales')).toBe(0);
  });

  it('qty 1..1,000,000; unit amounts 0..1,000,000,000; description not blank', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlPrintSale(c, { qty: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { qty: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { qty: 1_000_001 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { price: -1, revenue: -3 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { cost: -1, cogs: -3 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { price: 1_000_000_001, revenue: 3_000_000_003 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { desc: '  ' }))).toMatch(/CHECK/);
    expect(() => sqlPrintSale(c, { qty: 1_000_000, price: 1_000_000_000, cost: 1_000_000_000 })).not.toThrow();
    expect(() => sqlPrintSale(c, { price: 0 })).not.toThrow(); // free print is legal (R13 warns in the app)
  });

  it('service type must exist (foreign key) and be active (SERVICE_TYPE_INACTIVE backstop)', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlPrintSale(c, { type: 9999 }))).toMatch(/FOREIGN KEY/);
    const id = typeId(c, 'BW_1S');
    upd(c, 'print_service_types', 'active', 0, id);
    expect(msgOf(() => sqlPrintSale(c))).toMatch(/SERVICE_TYPE_INACTIVE/);
    upd(c, 'print_service_types', 'active', 1, id);
    expect(() => sqlPrintSale(c)).not.toThrow();
  });

  it('R-FD: a future date is refused (tomorrow, far future); today and past dates are accepted; malformed dates refused', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlPrintSale(c, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => sqlPrintSale(c, { date: '2999-01-01' }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => sqlPrintSale(c, { date: daysAgo(0) })).not.toThrow();
    expect(() => sqlPrintSale(c, { date: daysAgo(40) })).not.toThrow();
    expect(msgOf(() => sqlPrintSale(c, { date: '2020-02-30' }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlPrintSale(c, { date: '1999-1-01' }))).toMatch(/CHECK/);
    expect(scalar(c, 'SELECT COUNT(*) FROM print_sales')).toBe(2);
  });

  it('client_ref is unique', () => {
    const c = memDb(conns);
    sqlPrintSale(c, { ref: 'dup-ref-0001' });
    expect(msgOf(() => sqlPrintSale(c, { ref: 'dup-ref-0001' }))).toMatch(/UNIQUE/);
  });

  it('business_date and posted_at never change', () => {
    const c = memDb(conns);
    const id = sqlPrintSale(c, { date: daysAgo(2) });
    expect(msgOf(() => upd(c, 'print_sales', 'business_date', daysAgo(3), id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'print_sales', 'posted_at', '2020-01-01T00:00:00.000Z', id))).toMatch(/POSTED_AT_IMMUTABLE/);
  });

  it('immutable columns: type, description, qty, prices, revenue, cogs, notes, client_ref, id (PRINT_SALE_IMMUTABLE)', () => {
    const c = memDb(conns);
    const id = sqlPrintSale(c);
    const cases: Array<[string, unknown]> = [
      ['service_type_id', typeId(c, 'BW_2S')], ['description', 'other'], ['qty', 4], ['unit_price_cents', 1600],
      ['unit_cost_cents', 700], ['revenue_cents', 5000], ['cogs_cents', 100], ['notes', 'x'], ['client_ref', 'new-ref-0001'],
    ];
    for (const [col, v] of cases) expect(msgOf(() => upd(c, 'print_sales', col, v, id)), col).toMatch(/PRINT_SALE_IMMUTABLE/);
    const r = c.prepare('SELECT qty, revenue_cents FROM print_sales WHERE id = ?').get(id) as any;
    expect([Number(r.qty), Number(r.revenue_cents)]).toEqual([3, 4500]);
  });

  it('only posted -> void is allowed, and the void needs both voided_at and a reason; a void never comes back', () => {
    const c = memDb(conns);
    const id = sqlPrintSale(c);
    // void without reason / time violates the CHECK
    expect(msgOf(() => c.prepare("UPDATE print_sales SET status = 'void' WHERE id = ?").run(id))).toMatch(/CHECK/);
    // a reason alone on a posted row is refused (CHECK posted rows have neither)
    expect(msgOf(() => upd(c, 'print_sales', 'void_reason', 'x', id))).toMatch(/PRINT_SALE_IMMUTABLE|CHECK/);
    c.prepare("UPDATE print_sales SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'mistake' WHERE id = ?").run(id);
    expect(msgOf(() => upd(c, 'print_sales', 'status', 'posted', id))).toMatch(/PRINT_SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'print_sales', 'void_reason', 'changed', id))).toMatch(/PRINT_SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'print_sales', 'voided_at', '2027-01-01T00:00:00.000Z', id))).toMatch(/PRINT_SALE_IMMUTABLE/);
    expect(scalar(c, "SELECT COUNT(*) FROM print_sales WHERE status = 'void'")).toBe(1);
  });

  it('a sale can never be deleted (RECORD_DELETE_FORBIDDEN)', () => {
    const c = memDb(conns);
    const id = sqlPrintSale(c);
    expect(msgOf(() => c.prepare('DELETE FROM print_sales WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(scalar(c, 'SELECT COUNT(*) FROM print_sales')).toBe(1);
  });
});

describe('printing_supplies', () => {
  it('stores a valid purchase; amount must be 1..10^12 and description not blank', () => {
    const c = memDb(conns);
    const id = sqlSupply(c, { amount: 250050 });
    expect(scalar(c, 'SELECT amount_cents FROM printing_supplies WHERE id = ?', id)).toBe(250050);
    expect(msgOf(() => sqlSupply(c, { amount: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSupply(c, { amount: -5 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSupply(c, { amount: 1_000_000_000_001 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSupply(c, { desc: '' }))).toMatch(/CHECK/);
  });

  it('R-FD, malformed dates, unique client_ref', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlSupply(c, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => sqlSupply(c, { date: '2020-13-01' }))).toMatch(/CHECK/);
    expect(() => sqlSupply(c, { date: daysAgo(10) })).not.toThrow();
    sqlSupply(c, { ref: 'sup-ref-0001' });
    expect(msgOf(() => sqlSupply(c, { ref: 'sup-ref-0001' }))).toMatch(/UNIQUE/);
  });

  it('business_date / posted_at immutable; amount, description, client_ref immutable; only posted -> void', () => {
    const c = memDb(conns);
    const id = sqlSupply(c, { date: daysAgo(1) });
    expect(msgOf(() => upd(c, 'printing_supplies', 'business_date', daysAgo(2), id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'printing_supplies', 'posted_at', '2020-01-01T00:00:00.000Z', id))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'printing_supplies', 'amount_cents', 5, id))).toMatch(/PRINTING_SUPPLY_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'printing_supplies', 'description', 'x', id))).toMatch(/PRINTING_SUPPLY_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'printing_supplies', 'client_ref', 'other-ref-01', id))).toMatch(/PRINTING_SUPPLY_IMMUTABLE/);
    c.prepare("UPDATE printing_supplies SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'oops' WHERE id = ?").run(id);
    expect(msgOf(() => upd(c, 'printing_supplies', 'status', 'posted', id))).toMatch(/PRINTING_SUPPLY_IMMUTABLE/);
  });

  it('a purchase can never be deleted (RECORD_DELETE_FORBIDDEN)', () => {
    const c = memDb(conns);
    const id = sqlSupply(c);
    expect(msgOf(() => c.prepare('DELETE FROM printing_supplies WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});
