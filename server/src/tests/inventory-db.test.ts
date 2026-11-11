// Inventory / purchasing database rules (migration 004) - database level, raw SQL on in-memory SQLite, no HTTP.
// Protects the schema-level guarantees that keep stock and cash trustworthy even if application code has a bug:
// - stock_movements is the append-only ledger and a trigger keeps the product cache (qty_on_hand, stock_value_cents)
//   equal to the sum of the movements (BUSINESS_RULES section 3); the cache can never go negative, and never keep value
//   with zero quantity (STOCK_VALUE_WITHOUT_QTY);
// - R-FD: no future business dates on stock, cash or purchases (FUTURE_DATE_NOT_ALLOWED); backdating is allowed;
// - R-RD: a purchase return may not be dated before its purchase (RETURN_BEFORE_ORIGINAL_DATE);
// - purchases are immutable except posted -> void (R1: history is reversed, never edited), clientRef is unique
//   (no double submission), pack arithmetic (units = packs x pack size) and returned_units only ever grow;
// - cash_entries and audit_logs are append-only; cash types/books/funds follow the allowed combinations (section 2).
// Organised by table, one describe per table. Small raw-SQL helpers (addMove, addPurchase, ...) build rows directly.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { TestEnv } from './helpers/tmp.ts';
import { daysAgo, daysAhead, memDb, movements, msgOf, pool, scalar, sqlProduct, today } from './helpers/inventory.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

// Counter for unique client references (the duplicate-submission guard needs a distinct value per row).
let seq = 0;
const uniq = () => `cref-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

// Raw-SQL helper: insert one stock movement (default type 'adjustment', dated today). Returns its id.
function addMove(c: DatabaseSync, productId: number, qty: number, value: number, o: { type?: string; date?: string } = {}): number {
  return Number(c.prepare(
    `INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(productId, o.date ?? today(), o.type ?? 'adjustment', qty, value).lastInsertRowid);
}
// Raw-SQL helper: insert a purchase header (shop book, Rs 10.00 total, today unless overridden).
function addPurchase(c: DatabaseSync, o: { date?: string; book?: string; total?: number } = {}): number {
  return Number(c.prepare(
    `INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, ?, ?, ?)`,
  ).run(o.date ?? today(), o.book ?? 'shop', o.total ?? 1000, uniq()).lastInsertRowid);
}
// Raw-SQL helper: insert a purchase line (default 1 pack of 10 = 10 units, Rs 10.00).
function addItem(c: DatabaseSync, purchaseId: number, productId: number, o: { packs?: number; packSize?: number; units?: number; total?: number; returned?: number } = {}): number {
  const packs = o.packs ?? 1; const packSize = o.packSize ?? 10;
  return Number(c.prepare(
    `INSERT INTO purchase_items (purchase_id, product_id, packs, pack_size, units, line_total_cents, returned_units)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(purchaseId, productId, packs, packSize, o.units ?? packs * packSize, o.total ?? 1000, o.returned ?? 0).lastInsertRowid);
}
// Raw-SQL helper: insert a purchase return header for a given business date.
function addReturn(c: DatabaseSync, purchaseId: number, date: string): number {
  return Number(c.prepare(
    `INSERT INTO purchase_returns (purchase_id, business_date, refund_cents, client_ref) VALUES (?, ?, 100, ?)`,
  ).run(purchaseId, date, uniq()).lastInsertRowid);
}
// Raw-SQL helper: insert a cash entry (default: shop purchase_payment of -Rs 1.00, today).
function addCash(c: DatabaseSync, o: { book?: string; type?: string; amount?: number; fund?: string | null; date?: string; reverses?: number | null }): number {
  return Number(c.prepare(
    `INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, reverses_entry_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(o.book ?? 'shop', o.date ?? today(), o.type ?? 'purchase_payment', o.amount ?? -100, o.fund ?? null, o.reverses ?? null).lastInsertRowid);
}

// Migration 004 adds the Phase 3 tables (stock ledger, cash, purchases) and guard triggers.
describe('migration 004', () => {
  // A new database has every Phase 3 table and every guard trigger, plus the audit columns business_date / backdated.
  it('fresh DB reaches latestVersion >= 4 with all Phase 3 tables, triggers and audit columns', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(4);
    expect(currentVersion(c)).toBe(latestVersion());
    const names = (type: string) =>
      (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining([
      'stock_movements', 'cash_entries', 'purchases', 'purchase_items', 'purchase_returns', 'purchase_return_items',
    ]));
    expect(names('trigger')).toEqual(expect.arrayContaining([
      'trg_stock_movements_cache', 'trg_stock_movements_no_update', 'trg_stock_movements_no_delete',
      'trg_products_value_without_qty', 'trg_cash_entries_no_update', 'trg_cash_entries_no_delete',
      'trg_purchases_immutable', 'trg_purchase_returns_before_original', 'trg_purchase_return_items_mismatch',
      'audit_logs_no_update', 'audit_logs_no_delete',
    ]));
    const cols = (c.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[]).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(['business_date', 'backdated']));
  });

  // Upgrading an older shop database keeps its stock (5 units / Rs 25.00) and audit rows; a new movement of +3 / Rs 3.00
  // then gives 8 units / Rs 28.00, proving the new cache trigger works on old data.
  it('v3 -> v4 upgrade preserves existing data and gives audit rows the defaults', () => {
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 3)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const c = new DatabaseSync(join(dir, 'v3.db'));
    conns.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    expect(migrate(c, mdir).version).toBe(3);
    const cat = scalar(c, "SELECT id FROM categories WHERE name = 'Other'");
    c.prepare(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents, qty_on_hand, stock_value_cents)
      VALUES ('Old', ?, 'stock', 'shop', 1000, 500, 5, 2500)`).run(cat);
    c.prepare("INSERT INTO suppliers (name) VALUES ('OldSup')").run();
    c.prepare("INSERT INTO audit_logs (entity, entity_id, action, note) VALUES ('product','1','create','legacy')").run();

    const r = migrate(c);
    expect(r.applied).toEqual(expect.arrayContaining(['004_purchases_inventory.sql']));
    expect(currentVersion(c)).toBe(latestVersion());
    const p = c.prepare("SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE name = 'Old'").get() as any;
    expect([Number(p.q), Number(p.v)]).toEqual([5, 2500]);
    expect(scalar(c, 'SELECT COUNT(*) FROM suppliers')).toBe(1);
    const a = c.prepare("SELECT note, business_date, backdated FROM audit_logs WHERE note = 'legacy'").get() as any;
    expect(a).toMatchObject({ note: 'legacy', business_date: null });
    expect(Number(a.backdated)).toBe(0);
    // new tables usable
    const pid = scalar(c, "SELECT id FROM products WHERE name = 'Old'");
    addMove(c, pid, 3, 300, { type: 'purchase' });
    expect(pool(c, pid)).toEqual({ qty: 8, value: 2800 });
    expect(migrate(c).applied).toEqual([]);
  });
});

// The stock ledger refuses bad dates, unknown types, empty movements and any edit or delete.
describe('stock_movements checks', () => {
  // R-FD: the database itself refuses a movement dated after today (Colombo); backdated ones are allowed.
  it('future business date rejected (trigger), today and backdated accepted', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    expect(msgOf(() => addMove(c, p, 1, 1, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => addMove(c, p, 1, 1, { date: '2999-01-01' }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    addMove(c, p, 1, 1, { date: today() });
    addMove(c, p, 1, 1, { date: '2020-01-01' });
    addMove(c, p, 1, 1, { date: daysAgo(1) });
    expect(pool(c, p)).toEqual({ qty: 3, value: 3 });
  });

  // Only real calendar dates (YYYY-MM-DD) are accepted; 2024-02-29 is a real leap day, 2025-02-29 is not.
  it('malformed / impossible dates rejected by CHECK', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    for (const d of ['2026-02-31', '2026-2-3', '20260203', '2026-13-01', 'abc', '2026-02-30', '2025-02-29']) {
      // BEFORE-INSERT triggers may fire ahead of the CHECK (string compare), either way the row is refused.
      // Migration 012 adds INVALID_BUSINESS_DATE for a well-shaped but impossible date such as 2026-13-01.
      expect(msgOf(() => addMove(c, p, 1, 1, { date: d })), d).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED|INVALID_BUSINESS_DATE/);
    }
    addMove(c, p, 1, 1, { date: '2024-02-29' }); // real leap day
    expect(movements(c, p)).toHaveLength(1);
  });

  // Only the 12 known movement types are allowed; a movement must change quantity or value; the product must exist.
  it('type enum, empty movement and unknown product are rejected', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    expect(msgOf(() => addMove(c, p, 1, 1, { type: 'bogus' }))).toMatch(/CHECK/);
    expect(msgOf(() => addMove(c, p, 0, 0))).toMatch(/CHECK/);
    expect(msgOf(() => addMove(c, 9999, 1, 1))).toMatch(/FOREIGN KEY/);
    for (const t of ['opening', 'purchase', 'purchase_return', 'purchase_void', 'sale', 'sale_return', 'sale_void',
      'personal_use', 'loss', 'stocktake_gain', 'stocktake_loss', 'adjustment']) {
      addMove(c, p, 1, 1, { type: t });
    }
    expect(pool(c, p)).toEqual({ qty: 12, value: 12 });
  });

  // The ledger is never edited or deleted; corrections are new reversal rows (R1, C6).
  it('append-only: UPDATE and DELETE refused', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const m = addMove(c, p, 5, 500);
    expect(msgOf(() => c.prepare('UPDATE stock_movements SET qty_delta = 9 WHERE id = ?').run(m))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare("UPDATE stock_movements SET reason = 'x'").run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM stock_movements WHERE id = ?').run(m))).toMatch(/append-only/);
    expect(movements(c, p)).toHaveLength(1);
    expect(pool(c, p)).toEqual({ qty: 5, value: 500 });
  });
});

// The product's qty_on_hand / stock_value_cents is a cache maintained by a trigger on every movement.
describe('stock cache trigger', () => {
  // +10 / 1,000 then -4 / -400 gives 6 / 600; a value-only movement (qty 0, -100) leaves 6 / 500.
  it('each movement adds its deltas to the product cache; other products untouched', () => {
    const c = memDb(conns);
    const a = sqlProduct(c); const b = sqlProduct(c);
    addMove(c, a, 10, 1000, { type: 'purchase' });
    addMove(c, a, -4, -400, { type: 'sale' });
    addMove(c, b, 2, 50, { type: 'purchase' });
    expect(pool(c, a)).toEqual({ qty: 6, value: 600 });
    expect(pool(c, b)).toEqual({ qty: 2, value: 50 });
    addMove(c, a, 0, -100, { type: 'adjustment' }); // value-only
    expect(pool(c, a)).toEqual({ qty: 6, value: 500 });
  });

  // An outflow bigger than the stock fails as a whole: the cache AND the ledger both stay unchanged.
  it('negative quantity aborts the insert and leaves the cache AND movements unchanged', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addMove(c, p, 3, 300);
    expect(msgOf(() => addMove(c, p, -4, -100))).toMatch(/CHECK/);
    expect(pool(c, p)).toEqual({ qty: 3, value: 300 });
    expect(movements(c, p)).toHaveLength(1);
  });

  it('negative value aborts and leaves everything unchanged', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addMove(c, p, 3, 300);
    expect(msgOf(() => addMove(c, p, -1, -301))).toMatch(/CHECK/);
    expect(msgOf(() => addMove(c, p, 0, -301))).toMatch(/CHECK/);
    expect(pool(c, p)).toEqual({ qty: 3, value: 300 });
    expect(movements(c, p)).toHaveLength(1);
  });

  it('services can never receive stock or value', () => {
    const c = memDb(conns);
    const s = sqlProduct(c, { kind: 'service' });
    expect(msgOf(() => addMove(c, s, 1, 0))).toMatch(/CHECK/);
    expect(msgOf(() => addMove(c, s, 0, 5))).toMatch(/CHECK|STOCK_VALUE_WITHOUT_QTY/);
    expect(pool(c, s)).toEqual({ qty: 0, value: 0 });
    expect(movements(c, s)).toHaveLength(0);
  });

  // Quantity 0 with value left would be "free money" stuck in an empty pool, so the database refuses it.
  it('STOCK_VALUE_WITHOUT_QTY: quantity reaching 0 while value remains is refused', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addMove(c, p, 3, 300);
    expect(msgOf(() => addMove(c, p, -3, -200))).toMatch(/STOCK_VALUE_WITHOUT_QTY/);
    expect(pool(c, p)).toEqual({ qty: 3, value: 300 });
    expect(msgOf(() => c.prepare('UPDATE products SET qty_on_hand = 0 WHERE id = ?').run(p))).toMatch(/STOCK_VALUE_WITHOUT_QTY/);
    expect(movements(c, p)).toHaveLength(1);
  });

  // R4: pool 3 / 7,500; sweep -2,500 first (value only) -> 3 / 5,000; then remove 3 units / 5,000 -> 0 / 0.
  it('sweep-then-removal is valid: value-only -X first, then qty/value removal to 0/0', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addMove(c, p, 3, 7500);
    addMove(c, p, 0, -2500);                 // sweep
    expect(pool(c, p)).toEqual({ qty: 3, value: 5000 });
    addMove(c, p, -3, -5000, { type: 'purchase_return' });
    expect(pool(c, p)).toEqual({ qty: 0, value: 0 });
  });

  // Free goods or fully written-down stock: units can exist with value 0.
  it('qty > 0 with value 0 is a legal state', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addMove(c, p, 3, 300);
    addMove(c, p, 0, -300);
    expect(pool(c, p)).toEqual({ qty: 3, value: 0 });
  });

  // One business action is all-or-nothing: if the second movement fails, the first (and its cache change) is undone.
  it('database transaction rollback: 2nd insert fails -> the 1st is rolled back (cache and movement)', async () => {
    const { ctx } = await env.build();
    const conn = ctx.database.conn;
    const p = sqlProduct(conn);
    addMove(conn, p, 2, 200);
    expect(() => ctx.database.tx((cn) => {
      addMove(cn, p, 5, 500);                // would succeed
      expect(pool(cn, p)).toEqual({ qty: 7, value: 700 });
      addMove(cn, p, -100, -1);              // CHECK failure
    })).toThrow(/CHECK/);
    expect(pool(conn, p)).toEqual({ qty: 2, value: 200 });
    expect(movements(conn, p)).toHaveLength(1);
    // the connection is healthy and usable afterwards
    addMove(conn, p, 1, 1);
    expect(pool(conn, p)).toEqual({ qty: 3, value: 201 });
  });
});

// Cash ledger rules: dates, allowed book/type/fund combinations, reversals, append-only (BUSINESS_RULES section 2).
describe('cash_entries checks', () => {
  it('future dates rejected, backdated and malformed handled', () => {
    const c = memDb(conns);
    expect(msgOf(() => addCash(c, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => addCash(c, { date: '2026-02-31' }))).toMatch(/CHECK/);
    expect(msgOf(() => addCash(c, { date: '2026-2-3' }))).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED/);
    addCash(c, { date: '2020-01-01' });
    addCash(c, { date: today() });
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_entries')).toBe(2);
  });

  // Inventory purchases are paid from the shop or telecom cash book, never from ice cream.
  it('purchase_payment / purchase_refund only in shop or telecom', () => {
    const c = memDb(conns);
    expect(msgOf(() => addCash(c, { book: 'icecream', fund: 'cost', type: 'purchase_payment' }))).toMatch(/CHECK/);
    expect(msgOf(() => addCash(c, { book: 'icecream', fund: 'cost', type: 'purchase_refund', amount: 5 }))).toMatch(/CHECK/);
    addCash(c, { book: 'telecom', type: 'purchase_payment' });
    addCash(c, { book: 'shop', type: 'purchase_refund', amount: 5 });
  });

  // Section 10.2: every ice cream cash entry names one fund; other books have no funds.
  it('icecream book needs a fund; fund only for icecream', () => {
    const c = memDb(conns);
    expect(msgOf(() => addCash(c, { book: 'icecream', type: 'icecream_sale', fund: null }))).toMatch(/CHECK/);
    expect(msgOf(() => addCash(c, { book: 'shop', type: 'expense', fund: 'cost' }))).toMatch(/CHECK/);
    expect(msgOf(() => addCash(c, { book: 'telecom', type: 'expense', fund: 'profit' }))).toMatch(/CHECK/);
    addCash(c, { book: 'icecream', type: 'icecream_sale', fund: 'cost', amount: 50 });
    addCash(c, { book: 'icecream', type: 'expense', fund: 'profit', amount: -5 });
  });

  // Ice cream cash types cannot appear in the shop or telecom books (segments are disjoint).
  it('icecream_* types only in the icecream book', () => {
    const c = memDb(conns);
    for (const t of ['icecream_sale', 'icecream_materials_payment', 'icecream_electricity_payment', 'icecream_other_cost']) {
      expect(msgOf(() => addCash(c, { book: 'shop', type: t })), t).toMatch(/CHECK/);
      expect(msgOf(() => addCash(c, { book: 'telecom', type: t })), t).toMatch(/CHECK/);
      addCash(c, { book: 'icecream', type: t, fund: 'electricity' });
    }
  });

  it('enums: unknown type, book and fund rejected', () => {
    const c = memDb(conns);
    expect(msgOf(() => addCash(c, { type: 'bogus' }))).toMatch(/CHECK/);
    expect(msgOf(() => addCash(c, { book: 'bank' }))).toMatch(/CHECK/);
    expect(msgOf(() => addCash(c, { book: 'icecream', fund: 'nope', type: 'icecream_sale' }))).toMatch(/CHECK/);
  });

  // R1: a void is a new row pointing at the original; here -500 and its +500 reversal sum to 0, and rows can never be edited.
  it('reverses_entry_id must reference a real entry; append-only', () => {
    const c = memDb(conns);
    expect(msgOf(() => addCash(c, { reverses: 9999 }))).toMatch(/FOREIGN KEY/);
    const a = addCash(c, { amount: -500 });
    const r = addCash(c, { amount: 500, reverses: a });
    expect(scalar(c, 'SELECT reverses_entry_id FROM cash_entries WHERE id = ?', r)).toBe(a);
    expect(msgOf(() => c.prepare('UPDATE cash_entries SET amount_cents = 1 WHERE id = ?').run(a))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM cash_entries WHERE id = ?').run(a))).toMatch(/append-only/);
    expect(scalar(c, 'SELECT SUM(amount_cents) FROM cash_entries')).toBe(0);
  });
});

// Purchase header rules: dates, immutability, voiding, duplicate protection.
describe('purchases', () => {
  it('future date, malformed date, bad enums, negative total, void without reason', () => {
    const c = memDb(conns);
    expect(msgOf(() => addPurchase(c, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => addPurchase(c, { date: '2026-02-31' }))).toMatch(/CHECK/);
    addPurchase(c, { date: '2020-05-05' }); // backdating fine
    expect(msgOf(() => addPurchase(c, { book: 'icecream' }))).toMatch(/CHECK/);
    expect(msgOf(() => addPurchase(c, { total: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref, status) VALUES (?, 'shop', 1, ?, 'void')")
      .run(today(), uniq()))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref, status) VALUES (?, 'shop', 1, ?, 'weird')")
      .run(today(), uniq()))).toMatch(/CHECK/);
  });

  // The same clientRef twice means a double submission; the database refuses the second purchase.
  it('client_ref is unique', () => {
    const c = memDb(conns);
    c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 1, 'same-ref-1')").run(today());
    expect(msgOf(() => c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 1, 'same-ref-1')").run(today())))
      .toMatch(/UNIQUE/);
  });

  // A posted purchase can never be edited (R1); mistakes are fixed by void or return.
  it('PURCHASE_IMMUTABLE for every financial/descriptive column', () => {
    const c = memDb(conns);
    const sup = Number(c.prepare("INSERT INTO suppliers (name) VALUES ('S')").run().lastInsertRowid);
    const id = addPurchase(c);
    for (const sql of [
      'UPDATE purchases SET total_cents = 1 WHERE id = ?',
      "UPDATE purchases SET bill_no = 'x' WHERE id = ?",
      "UPDATE purchases SET notes = 'x' WHERE id = ?",
      "UPDATE purchases SET book = 'telecom' WHERE id = ?",
      `UPDATE purchases SET supplier_id = ${sup} WHERE id = ?`,
      "UPDATE purchases SET client_ref = 'another-ref-9' WHERE id = ?",
      'UPDATE purchases SET id = 999 WHERE id = ?',
    ]) {
      expect(msgOf(() => c.prepare(sql).run(id)), sql).toMatch(/PURCHASE_IMMUTABLE/);
    }
    expect(scalar(c, 'SELECT total_cents FROM purchases WHERE id = ?', id)).toBe(1000);
  });

  // The only allowed change is posted -> void with a reason and time; it never goes back to posted and a void row is frozen.
  it('allowed: posted -> void; never void -> posted; void row frozen; posted cannot carry a reason', () => {
    const c = memDb(conns);
    const id = addPurchase(c);
    expect(msgOf(() => c.prepare("UPDATE purchases SET void_reason = 'x' WHERE id = ?").run(id))).toMatch(/PURCHASE_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE purchases SET voided_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(id))).toMatch(/PURCHASE_IMMUTABLE/);
    // status void without reason -> CHECK
    expect(msgOf(() => c.prepare("UPDATE purchases SET status = 'void' WHERE id = ?").run(id))).toMatch(/CHECK/);
    c.prepare("UPDATE purchases SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'oops' WHERE id = ?").run(id);
    expect(scalar(c, "SELECT COUNT(*) FROM purchases WHERE status = 'void'")).toBe(1);
    expect(msgOf(() => c.prepare("UPDATE purchases SET status = 'posted' WHERE id = ?").run(id))).toMatch(/PURCHASE_IMMUTABLE|CHECK/);
    expect(msgOf(() => c.prepare("UPDATE purchases SET status = 'posted', voided_at = NULL, void_reason = NULL WHERE id = ?").run(id)))
      .toMatch(/PURCHASE_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE purchases SET void_reason = 'changed' WHERE id = ?").run(id))).toMatch(/PURCHASE_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE purchases SET voided_at = '2027-01-01T00:00:00.000Z' WHERE id = ?").run(id))).toMatch(/PURCHASE_IMMUTABLE/);
    expect(scalar(c, "SELECT COUNT(*) FROM purchases WHERE status = 'void' AND void_reason = 'oops'")).toBe(1);
  });

  // Section 12: the business date and the posting timestamp are fixed when saved (writing the same value back is not a change).
  it('POSTED_AT_IMMUTABLE and BUSINESS_DATE_IMMUTABLE', () => {
    const c = memDb(conns);
    const id = addPurchase(c);
    expect(msgOf(() => c.prepare("UPDATE purchases SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE purchases SET business_date = '2020-01-01' WHERE id = ?").run(id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    // same-value writes are not a change
    c.prepare('UPDATE purchases SET business_date = business_date, posted_at = posted_at WHERE id = ?').run(id);
  });
});

// Purchase lines: pack arithmetic and the returned-units counter.
describe('purchase_items', () => {
  // Section 3 pack rule: 2 packs x 5 = 10 units; 11 units or zero packs are refused.
  it('units must equal packs x pack_size; packs/pack_size >= 1', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const pu = addPurchase(c);
    expect(msgOf(() => addItem(c, pu, p, { packs: 2, packSize: 5, units: 11 }))).toMatch(/CHECK/);
    expect(msgOf(() => addItem(c, pu, p, { packs: 0, packSize: 5, units: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => addItem(c, pu, p, { packs: 1, packSize: 0, units: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => addItem(c, pu, p, { total: -1 }))).toMatch(/CHECK/);
    const id = addItem(c, pu, p, { packs: 2, packSize: 5 });
    expect(scalar(c, 'SELECT units FROM purchase_items WHERE id = ?', id)).toBe(10);
  });

  // A line of 10 can have 0..10 units returned, the counter only grows (4 -> 10 ok, 10 -> 9 refused), nothing else on the line may change.
  it('returned_units bounded 0..units and never decreasing; other columns immutable', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const pu = addPurchase(c);
    const id = addItem(c, pu, p, { packs: 1, packSize: 10 });
    expect(msgOf(() => addItem(c, pu, p, { returned: 11 }))).toMatch(/CHECK/);
    expect(msgOf(() => addItem(c, pu, p, { returned: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare('UPDATE purchase_items SET returned_units = 11 WHERE id = ?').run(id))).toMatch(/CHECK/);
    c.prepare('UPDATE purchase_items SET returned_units = 4 WHERE id = ?').run(id);
    c.prepare('UPDATE purchase_items SET returned_units = 10 WHERE id = ?').run(id);
    expect(msgOf(() => c.prepare('UPDATE purchase_items SET returned_units = 9 WHERE id = ?').run(id))).toMatch(/PURCHASE_ITEM_IMMUTABLE/);
    expect(msgOf(() => c.prepare('UPDATE purchase_items SET line_total_cents = 1 WHERE id = ?').run(id))).toMatch(/PURCHASE_ITEM_IMMUTABLE/);
    expect(msgOf(() => c.prepare('UPDATE purchase_items SET units = 20, packs = 2 WHERE id = ?').run(id))).toMatch(/PURCHASE_ITEM_IMMUTABLE/);
    expect(msgOf(() => c.prepare('UPDATE purchase_items SET product_id = ? WHERE id = ?').run(sqlProduct(c), id))).toMatch(/PURCHASE_ITEM_IMMUTABLE/);
    expect(scalar(c, 'SELECT returned_units FROM purchase_items WHERE id = ?', id)).toBe(10);
  });
});

// Purchase return rules (R-RD, R4): dates, voided purchases, matching lines, append-only.
describe('purchase_returns', () => {
  // Purchase dated 5 days ago: a return 6 days ago is refused; same day, 2 days ago and today are allowed.
  it('R-RD: before the original date fails; same day and later pass', () => {
    const c = memDb(conns);
    const pu = addPurchase(c, { date: daysAgo(5) });
    expect(msgOf(() => addReturn(c, pu, daysAgo(6)))).toMatch(/RETURN_BEFORE_ORIGINAL_DATE/);
    expect(msgOf(() => addReturn(c, pu, '2000-01-01'))).toMatch(/RETURN_BEFORE_ORIGINAL_DATE/);
    addReturn(c, pu, daysAgo(5)); // same day
    addReturn(c, pu, daysAgo(2)); // after, still backdated
    addReturn(c, pu, today());
    expect(scalar(c, 'SELECT COUNT(*) FROM purchase_returns')).toBe(3);
  });

  it('future dated return rejected; malformed rejected', () => {
    const c = memDb(conns);
    const pu = addPurchase(c);
    expect(msgOf(() => addReturn(c, pu, daysAhead(1)))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => addReturn(c, pu, '2026-02-31'))).toMatch(/CHECK|RETURN_BEFORE_ORIGINAL_DATE/);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchase_returns')).toBe(0);
  });

  // A voided purchase has already been reversed; returning goods against it would double-count.
  it('return on a void purchase -> PURCHASE_VOID', () => {
    const c = memDb(conns);
    const pu = addPurchase(c);
    c.prepare("UPDATE purchases SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'r' WHERE id = ?").run(pu);
    expect(msgOf(() => addReturn(c, pu, today()))).toMatch(/PURCHASE_VOID/);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchase_returns')).toBe(0);
  });

  it('return of an unknown purchase fails the foreign key', () => {
    const c = memDb(conns);
    expect(msgOf(() => addReturn(c, 4242, today()))).toMatch(/FOREIGN KEY|NOT NULL|constraint/i);
  });

  // A return can only list lines of its own purchase, with at least 1 unit and a non-negative value.
  it('RETURN_ITEM_MISMATCH: item of another purchase', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const a = addPurchase(c); const b = addPurchase(c);
    const itemB = addItem(c, b, p);
    const itemA = addItem(c, a, p);
    const ret = addReturn(c, a, today());
    expect(msgOf(() => c.prepare('INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, units, value_cents) VALUES (?, ?, 1, 10)')
      .run(ret, itemB))).toMatch(/RETURN_ITEM_MISMATCH/);
    c.prepare('INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, units, value_cents) VALUES (?, ?, 1, 10)').run(ret, itemA);
    expect(msgOf(() => c.prepare('INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, units, value_cents) VALUES (?, ?, 0, 10)')
      .run(ret, itemA))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare('INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, units, value_cents) VALUES (?, ?, 1, -1)')
      .run(ret, itemA))).toMatch(/CHECK/);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchase_return_items')).toBe(1);
  });

  // Returns are history; they can never be edited or removed.
  it('append-only: purchase_returns and purchase_return_items', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const pu = addPurchase(c);
    const item = addItem(c, pu, p);
    const ret = addReturn(c, pu, today());
    const ri = Number(c.prepare('INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, units, value_cents) VALUES (?, ?, 1, 10)')
      .run(ret, item).lastInsertRowid);
    expect(msgOf(() => c.prepare('UPDATE purchase_returns SET refund_cents = 1 WHERE id = ?').run(ret))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM purchase_returns WHERE id = ?').run(ret))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('UPDATE purchase_return_items SET units = 2 WHERE id = ?').run(ri))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM purchase_return_items WHERE id = ?').run(ri))).toMatch(/append-only/);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchase_returns')).toBe(1);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchase_return_items')).toBe(1);
  });
});

// The audit table gained business_date and backdated columns without losing its append-only protection.
describe('audit_logs after migration 004', () => {
  it('new columns default correctly and the append-only triggers still hold', () => {
    const c = memDb(conns);
    c.prepare("INSERT INTO audit_logs (entity, action) VALUES ('e','a')").run();
    c.prepare("INSERT INTO audit_logs (entity, action, business_date, backdated) VALUES ('e','b','2026-01-01',1)").run();
    const rows = c.prepare('SELECT action, business_date, backdated FROM audit_logs ORDER BY id').all() as any[];
    expect(rows.map((r) => [r.action, r.business_date, Number(r.backdated)])).toEqual([['a', null, 0], ['b', '2026-01-01', 1]]);
    expect(msgOf(() => c.prepare("UPDATE audit_logs SET business_date = '2020-01-01'").run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('UPDATE audit_logs SET backdated = 0').run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM audit_logs').run())).toMatch(/append-only/);
  });
});
