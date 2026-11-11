// Phase 5 database rules (migration 006: sales, sale_items, sales_returns, sales_return_items, stock_losses link)
// - database level, raw SQL on in-memory / temp SQLite, no HTTP.
// Protects the schema-level guarantees behind POS sales and returns, so no app bug, retry or manual edit can corrupt history:
//   R1    a sale is never edited; the only change is posted -> void (SALE_IMMUTABLE), a voided sale never comes back;
//   C5    the money of a sale line is frozen (SALE_ITEM_IMMUTABLE: only returned_qty may change, never down), revenue = qty x price;
//   R-FD  no future business dates (FUTURE_DATE_NOT_ALLOWED), malformed dates refused, backdating allowed;
//   R-RD  a return cannot be dated before its sale (RETURN_BEFORE_ORIGINAL_DATE), nor on a void sale (SALE_VOID);
//   Sec 4 books never mix (SALE_ITEM_BOOK_MISMATCH); a return cannot take back more than was sold (RETURN_EXCEEDS_SOLD,
//         RETURN_ITEM_MISMATCH); return tables are append-only; (client_ref, book) is unique so one cart may make a shop and a
//         telecom sale;
//   Sec 12 business_date and posted_at never change; plus stock-cache interplay and all-or-nothing transactions.
// Organised by area: migration 006 and upgrade, sales, sale_items, sales_returns, sales_return_items, stock cache interplay, rollback.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase } from '../db/db.ts';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { issueStock, receiveStock } from '../services/inventory.service.ts';
import { TestEnv } from './helpers/tmp.ts';
import { daysAgo, daysAhead, memDb, msgOf, pool, scalar, sqlProduct, today } from './helpers/inventory.ts';
import { sqlReturn, sqlReturnItem, sqlSale, sqlSaleItem } from './helpers/phase5.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

const NOW = '2026-01-01T00:00:00.000Z';
/** Puts `units` units worth `value` cents into a product's pool (what a purchase does). */
const stock = (c: DatabaseSync, p: number, units: number, value: number) =>
  receiveStock(c, { productId: p, businessDate: today(), type: 'purchase', qty: units, valueCents: value, refTable: null, refId: null, reason: 'seed' });
/** Does what the service does after inserting return lines: raises sale_items.returned_qty. */
const bump = (c: DatabaseSync, item: number, q: number) => c.prepare('UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ?').run(q, item);
const upd = (c: DatabaseSync, table: string, col: string, val: unknown, id: number) =>
  c.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(val as any, id);

// =============================================================================================
// Migration 006: version, objects, and the upgrade from a version-5 database.
describe('migration 006', () => {
  it('fresh DB reaches latestVersion >= 6 with the Phase 5 tables, triggers and the stock_losses link column', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(6);
    expect(currentVersion(c)).toBe(latestVersion());
    const names = (type: string) => (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(['sales', 'sale_items', 'sales_returns', 'sales_return_items']));
    expect(names('trigger')).toEqual(expect.arrayContaining([
      'trg_sales_future_date', 'trg_sales_business_date_immutable', 'trg_sales_posted_at_immutable', 'trg_sales_immutable',
      'trg_sale_items_immutable', 'trg_sale_items_book_mismatch', 'trg_sales_returns_future_date', 'trg_sales_returns_before_original',
      'trg_sales_returns_void', 'trg_sales_returns_no_update', 'trg_sales_returns_no_delete', 'trg_sales_return_items_mismatch',
      'trg_sales_return_items_exceeds', 'trg_sales_return_items_no_update', 'trg_sales_return_items_no_delete',
      'trg_stock_losses_damaged_return_link', 'trg_stock_losses_damaged_return_date', 'trg_stock_losses_damaged_return_reason',
      'trg_stock_losses_sales_return_immutable',
    ]));
    const cols = (c.prepare('PRAGMA table_info(stock_losses)').all() as { name: string }[]).map((r) => r.name);
    expect(cols).toContain('sales_return_id');
  });

  // An older shop database upgrades without losing a row; its old manual stock loss simply has no return link.
  it('v5 -> v6 upgrade keeps products, movements, purchases, losses and audit; new tables work on it', () => {
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 5)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const c = new DatabaseSync(join(dir, 'v5.db'));
    conns.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    expect(migrate(c, mdir).version).toBe(5);
    const cat = scalar(c, "SELECT id FROM categories WHERE name = 'Other'");
    c.prepare(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Old', ?, 'stock', 'shop', 1000, 500)`).run(cat);
    const pid = scalar(c, "SELECT id FROM products WHERE name = 'Old'");
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'purchase', 7, 2100)").run(pid, today());
    c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 2100, 'oldpurchase-1')").run(today());
    c.prepare("INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, client_ref) VALUES (?, ?, 'shop', 1, 300, 'damaged', 'oldloss-0001')").run(today(), pid);
    c.prepare("INSERT INTO audit_logs (entity, entity_id, action, note) VALUES ('product','1','create','legacy')").run();

    const r = migrate(c);
    // Upgrading a v5 database applies 006 first; later migrations (e.g. 007, the delete guards) follow it.
    expect(r.applied[0]).toBe('006_sales_returns.sql');
    expect(currentVersion(c)).toBe(latestVersion());
    expect(pool(c, pid)).toEqual({ qty: 7, value: 2100 });
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_movements')).toBe(1);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchases')).toBe(1);
    expect(scalar(c, "SELECT COUNT(*) FROM audit_logs WHERE note = 'legacy'")).toBe(1);
    expect(c.prepare('SELECT source, sales_return_id AS r FROM stock_losses').get()).toMatchObject({ source: 'manual', r: null });
    // new tables usable on the upgraded database, including a linked damaged-return loss
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, pid);
    const ret = sqlReturn(c, sale);
    sqlReturnItem(c, ret, item, 1);
    c.prepare("INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, source, sales_return_id, client_ref) VALUES (?, ?, 'shop', 1, 23333, 'damaged', 'damaged_return', ?, 'newloss-0001')").run(today(), pid, ret);
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_losses')).toBe(2);
    expect(migrate(c).applied).toEqual([]);
  });
});

// =============================================================================================
// sales header: checks, dates, uniqueness, immutability (R1, R-FD, section 12).
describe('sales table', () => {
  it('valid insert with defaults (posted, empty notes, server posted_at); every CHECK', () => {
    const c = memDb(conns);
    const id = sqlSale(c);
    const r = c.prepare('SELECT status, notes, posted_at, voided_at, void_reason FROM sales WHERE id = ?').get(id) as any;
    expect(r).toMatchObject({ status: 'posted', notes: '', voided_at: null, void_reason: null });
    expect(r.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    sqlSale(c, { book: 'telecom' });
    sqlSale(c, { total: 0 }); // a free sale is allowed
    expect(msgOf(() => sqlSale(c, { book: 'icecream' }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSale(c, { total: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSale(c, { status: 'draft' }))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare('INSERT INTO sales (business_date, book, total_cents) VALUES (?, ?, ?)').run(today(), 'shop', 1))).toMatch(/NOT NULL/); // client_ref required
  });

  // R-FD at database level: tomorrow is refused, today and backdated are fine, malformed dates never get in.
  it('dates: future refused, malformed refused, backdated accepted', () => {
    const c = memDb(conns);
    expect(msgOf(() => sqlSale(c, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    for (const d of ['2026-02-31', 'abc', '2026-1-1', '2025-02-29', '']) {
      expect(msgOf(() => sqlSale(c, { date: d })), d).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED/);
    }
    sqlSale(c, { date: today() });
    sqlSale(c, { date: daysAgo(30) });
    expect(scalar(c, 'SELECT COUNT(*) FROM sales')).toBe(2);
  });

  // One cart can create a shop sale AND a telecom sale with the same reference; the same book twice is a duplicate.
  it('UNIQUE(client_ref, book): the same ref in two books is fine, in one book is refused', () => {
    const c = memDb(conns);
    sqlSale(c, { ref: 'cart-ref-0001', book: 'shop' });
    sqlSale(c, { ref: 'cart-ref-0001', book: 'telecom' });
    expect(msgOf(() => sqlSale(c, { ref: 'cart-ref-0001', book: 'shop' }))).toMatch(/UNIQUE/);
    expect(msgOf(() => sqlSale(c, { ref: 'cart-ref-0001', book: 'telecom' }))).toMatch(/UNIQUE/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales')).toBe(2);
  });

  // Moving the business date would silently move profit between days; posted_at proves when the record was really made.
  it('business_date and posted_at are immutable (BUSINESS_DATE_IMMUTABLE, POSTED_AT_IMMUTABLE)', () => {
    const c = memDb(conns);
    const id = sqlSale(c, { date: daysAgo(5) });
    expect(msgOf(() => upd(c, 'sales', 'business_date', today(), id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sales', 'posted_at', '2020-01-01T00:00:00.000Z', id))).toMatch(/POSTED_AT_IMMUTABLE/);
    // a no-op update of the same value is harmless
    upd(c, 'sales', 'business_date', daysAgo(5), id);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales WHERE business_date = ?', daysAgo(5))).toBe(1);
  });

  // R1: a posted sale can only become void (with time and reason); nothing else changes, and it never goes back.
  it('SALE_IMMUTABLE: only posted -> void; void needs voided_at and void_reason; no way back', () => {
    const c = memDb(conns);
    const id = sqlSale(c);
    for (const [col, val] of [['total_cents', 5], ['notes', 'x'], ['book', 'telecom'], ['client_ref', 'abcdefgh-9'], ['id', 9999]] as const) {
      expect(msgOf(() => upd(c, 'sales', col, val, id)), col).toMatch(/SALE_IMMUTABLE/);
    }
    // posted -> void without the void fields: refused by the CHECK
    expect(msgOf(() => c.prepare("UPDATE sales SET status = 'void' WHERE id = ?").run(id))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE sales SET status = 'void', voided_at = ? WHERE id = ?").run(NOW, id))).toMatch(/CHECK/);
    // void fields on a still-posted sale: refused by the trigger
    expect(msgOf(() => upd(c, 'sales', 'void_reason', 'r', id))).toMatch(/SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sales', 'voided_at', NOW, id))).toMatch(/SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sales', 'status', 'bogus', id))).toMatch(/CHECK/);
    // the real void
    c.prepare("UPDATE sales SET status = 'void', voided_at = ?, void_reason = 'why' WHERE id = ?").run(NOW, id);
    expect(c.prepare('SELECT status, voided_at, void_reason FROM sales WHERE id = ?').get(id)).toMatchObject({ status: 'void', voided_at: NOW, void_reason: 'why' });
    // void is final
    expect(msgOf(() => upd(c, 'sales', 'status', 'posted', id))).toMatch(/SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sales', 'void_reason', 'other', id))).toMatch(/SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sales', 'voided_at', '2031-01-01T00:00:00.000Z', id))).toMatch(/SALE_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sales', 'total_cents', 1, id))).toMatch(/SALE_IMMUTABLE/);
    // a void row cannot be inserted without its reason either
    expect(msgOf(() => sqlSale(c, { status: 'void' }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSale(c, { status: 'void', voidedAt: NOW }))).toMatch(/CHECK/);
    sqlSale(c, { status: 'void', voidedAt: NOW, voidReason: 'imported' });
  });
});

// =============================================================================================
// sale_items: frozen money (C5), exact revenue, unique line numbers, book separation (section 4).
describe('sale_items table', () => {
  it('valid insert; every CHECK and foreign key', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const id = sqlSaleItem(c, sale, p);
    expect(c.prepare('SELECT line_type, returned_qty, revenue_cents FROM sale_items WHERE id = ?').get(id)).toMatchObject({ line_type: 'goods', returned_qty: 0, revenue_cents: 300000 });
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, type: 'print' }))).toMatch(/CHECK|SALE_ITEM_BOOK_MISMATCH/); // BEFORE-INSERT trigger may fire first
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, qty: 0, revenue: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, price: -1, revenue: -3 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, cost: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, cogs: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, returned: 4 }))).toMatch(/CHECK/);  // returned > qty
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 2, returned: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, 9999, p, { lineNo: 2 }))).toMatch(/FOREIGN KEY|SALE_ITEM_BOOK_MISMATCH/);
    expect(msgOf(() => sqlSaleItem(c, sale, 9999, { lineNo: 2 }))).toMatch(/FOREIGN KEY|SALE_ITEM_BOOK_MISMATCH/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sale_items')).toBe(1);
  });

  // revenue = qty x unit price exactly: no rounding anywhere in a sale line (section 4).
  // Hand calculation: 3 x 100,000 = 300,000 OK; 299,999 or 300,001 is refused.
  it('revenue_cents must equal qty x unit_price_cents', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { revenue: 299999 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlSaleItem(c, sale, p, { revenue: 300001 }))).toMatch(/CHECK/);
    sqlSaleItem(c, sale, p, { revenue: 300000 });
    // zero price: revenue 0 is exact
    sqlSaleItem(c, sale, p, { lineNo: 2, price: 0, revenue: 0, cogs: 0, cost: 0 });
    expect(msgOf(() => sqlSaleItem(c, sale, p, { lineNo: 3, price: 0, revenue: 1 }))).toMatch(/CHECK/);
  });

  it('UNIQUE(sale_id, line_no): a line number repeats only in another sale', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const a = sqlSale(c);
    const b = sqlSale(c);
    sqlSaleItem(c, a, p, { lineNo: 1 });
    sqlSaleItem(c, a, p, { lineNo: 2 });
    expect(msgOf(() => sqlSaleItem(c, a, p, { lineNo: 2 }))).toMatch(/UNIQUE/);
    sqlSaleItem(c, b, p, { lineNo: 1 });
    expect(scalar(c, 'SELECT COUNT(*) FROM sale_items')).toBe(3);
  });

  // Section 4: goods lines belong to shop sales and shop products; card lines to telecom sales and telecom products.
  it('SALE_ITEM_BOOK_MISMATCH: line type, sale book and product book must agree', () => {
    const c = memDb(conns);
    const shopP = sqlProduct(c);
    const telP = sqlProduct(c, { book: 'telecom' });
    const shopSale = sqlSale(c, { book: 'shop' });
    const telSale = sqlSale(c, { book: 'telecom' });
    sqlSaleItem(c, shopSale, shopP);                       // goods / shop / shop product: fine
    sqlSaleItem(c, telSale, telP);                         // card / telecom / telecom product: fine
    expect(msgOf(() => sqlSaleItem(c, telSale, telP, { lineNo: 2, type: 'goods' }))).toMatch(/SALE_ITEM_BOOK_MISMATCH/);   // goods line in telecom sale
    expect(msgOf(() => sqlSaleItem(c, shopSale, shopP, { lineNo: 2, type: 'card' }))).toMatch(/SALE_ITEM_BOOK_MISMATCH/);  // card line in shop sale
    expect(msgOf(() => sqlSaleItem(c, shopSale, telP, { lineNo: 2 }))).toMatch(/SALE_ITEM_BOOK_MISMATCH/);                 // telecom product in shop sale
    expect(msgOf(() => sqlSaleItem(c, telSale, shopP, { lineNo: 2 }))).toMatch(/SALE_ITEM_BOOK_MISMATCH/);                 // shop product in telecom sale
    expect(scalar(c, 'SELECT COUNT(*) FROM sale_items')).toBe(2);
  });

  // C5: the cost snapshot never moves. Only returned_qty may change and only upwards.
  it('SALE_ITEM_IMMUTABLE: every money/identity column frozen; returned_qty may only grow (up to qty)', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const q = sqlProduct(c);
    const sale = sqlSale(c);
    const other = sqlSale(c);
    const id = sqlSaleItem(c, sale, p);
    for (const [col, val] of [['sale_id', other], ['line_no', 2], ['line_type', 'card'], ['product_id', q], ['description', 'x'],
      ['qty', 4], ['unit_price_cents', 1], ['unit_cost_cents', 1], ['revenue_cents', 1], ['cogs_cents', 1]] as const) {
      expect(msgOf(() => upd(c, 'sale_items', col, val, id)), col).toMatch(/SALE_ITEM_IMMUTABLE/);
    }
    upd(c, 'sale_items', 'returned_qty', 1, id);
    upd(c, 'sale_items', 'returned_qty', 3, id);
    expect(msgOf(() => upd(c, 'sale_items', 'returned_qty', 2, id))).toMatch(/SALE_ITEM_IMMUTABLE/);   // never decreases
    expect(msgOf(() => upd(c, 'sale_items', 'returned_qty', 0, id))).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(scalar(c, 'SELECT returned_qty FROM sale_items WHERE id = ?', id)).toBe(3);
    const id2 = sqlSaleItem(c, sale, p, { lineNo: 2 });
    expect(msgOf(() => upd(c, 'sale_items', 'returned_qty', 4, id2))).toMatch(/CHECK/);                // cannot exceed qty
    expect(scalar(c, 'SELECT cogs_cents FROM sale_items WHERE id = ?', id)).toBe(70000);
  });
});

// =============================================================================================
// sales_returns header: R-RD, R-FD, void sale, append-only.
describe('sales_returns table', () => {
  // R-RD hand cases for a sale dated 3 days ago: 4 days ago fails; 3 days ago (same day), 1 day ago and today are fine.
  it('R-RD: return before the sale date -> RETURN_BEFORE_ORIGINAL_DATE; same day and later are accepted', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c, { date: daysAgo(3) });
    sqlSaleItem(c, sale, p);
    expect(msgOf(() => sqlReturn(c, sale, { date: daysAgo(4) }))).toMatch(/RETURN_BEFORE_ORIGINAL_DATE/);
    expect(msgOf(() => sqlReturn(c, sale, { date: '2000-01-01' }))).toMatch(/RETURN_BEFORE_ORIGINAL_DATE/);
    sqlReturn(c, sale, { date: daysAgo(3) });
    sqlReturn(c, sale, { date: daysAgo(1) });
    sqlReturn(c, sale, { date: today() });
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns')).toBe(3);
  });

  it('R-FD: a future-dated return is refused; malformed dates are refused', () => {
    const c = memDb(conns);
    const sale = sqlSale(c);
    expect(msgOf(() => sqlReturn(c, sale, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    // The BEFORE-INSERT date triggers may fire before the CHECK, so any of the three guards is an acceptable refusal;
    // what matters is that nothing malformed gets in (count below).
    for (const d of ['2026-02-31', 'abc', '2026-1-1', '']) {
      expect(msgOf(() => sqlReturn(c, sale, { date: d })), d).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED|RETURN_BEFORE_ORIGINAL_DATE/);
    }
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns')).toBe(0);
  });

  it('SALE_VOID: a return against a void sale is refused', () => {
    const c = memDb(conns);
    const sale = sqlSale(c);
    c.prepare("UPDATE sales SET status = 'void', voided_at = ?, void_reason = 'r' WHERE id = ?").run(NOW, sale);
    expect(msgOf(() => sqlReturn(c, sale))).toMatch(/SALE_VOID/);
    expect(msgOf(() => sqlReturn(c, 9999))).toMatch(/FOREIGN KEY/);
  });

  it('checks: refund and cogs >= 0, client_ref unique and required, defaults', () => {
    const c = memDb(conns);
    const sale = sqlSale(c);
    const id = sqlReturn(c, sale, { ref: 'ret-ref-0001' });
    expect(c.prepare('SELECT note, posted_at FROM sales_returns WHERE id = ?').get(id)).toMatchObject({ note: '' });
    expect(msgOf(() => sqlReturn(c, sale, { ref: 'ret-ref-0001' }))).toMatch(/UNIQUE/);
    expect(msgOf(() => sqlReturn(c, sale, { refund: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlReturn(c, sale, { cogs: -1 }))).toMatch(/CHECK/);
    sqlReturn(c, sale, { refund: 0, cogs: 0 }); // a free item came back
  });

  // R1: a return is never edited or deleted.
  it('append-only: UPDATE and DELETE are refused', () => {
    const c = memDb(conns);
    const sale = sqlSale(c);
    const id = sqlReturn(c, sale);
    for (const col of ['refund_cents', 'note', 'business_date', 'posted_at', 'sale_id', 'client_ref']) {
      expect(msgOf(() => upd(c, 'sales_returns', col, col === 'sale_id' ? sale : (col.endsWith('cents') ? 5 : col === 'business_date' ? today() : 'abcdefgh-3'), id)), col).toMatch(/append-only/);
    }
    expect(msgOf(() => c.prepare('DELETE FROM sales_returns WHERE id = ?').run(id))).toMatch(/append-only/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns')).toBe(1);
  });
});

// =============================================================================================
// sales_return_items: same-sale rule, cumulative quantity limit, append-only.
describe('sales_return_items table', () => {
  it('valid insert; every CHECK and foreign key', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p);
    const ret = sqlReturn(c, sale);
    const id = sqlReturnItem(c, ret, item, 1);
    expect(c.prepare('SELECT qty, resalable FROM sales_return_items WHERE id = ?').get(id)).toMatchObject({ qty: 1, resalable: 1 });
    sqlReturnItem(c, ret, item, 1, { resalable: 0 });
    expect(msgOf(() => sqlReturnItem(c, ret, item, 0))).toMatch(/CHECK/);
    expect(msgOf(() => sqlReturnItem(c, ret, item, -1))).toMatch(/CHECK/);
    expect(msgOf(() => sqlReturnItem(c, ret, item, 1, { resalable: 2 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlReturnItem(c, ret, item, 1, { revenue: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlReturnItem(c, ret, item, 1, { cogs: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => sqlReturnItem(c, 9999, item, 1))).toMatch(/FOREIGN KEY|RETURN_ITEM_MISMATCH/);
    expect(msgOf(() => sqlReturnItem(c, ret, 9999, 1))).toMatch(/FOREIGN KEY|RETURN_ITEM_MISMATCH/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_return_items')).toBe(2);
  });

  it('RETURN_ITEM_MISMATCH: a line of ANOTHER sale cannot be returned on this return', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const saleA = sqlSale(c);
    const saleB = sqlSale(c);
    const itemA = sqlSaleItem(c, saleA, p);
    const itemB = sqlSaleItem(c, saleB, p);
    const retA = sqlReturn(c, saleA);
    sqlReturnItem(c, retA, itemA, 1);
    expect(msgOf(() => sqlReturnItem(c, retA, itemB, 1))).toMatch(/RETURN_ITEM_MISMATCH/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_return_items')).toBe(1);
  });

  // Hand calculation: line sold 5. Return A takes 3 (remaining 2 after the counter moves). Return B asks 3 > 2 -> refused;
  // 2 is accepted; afterwards nothing is left, so even 1 more is refused. Quantities are compared with qty - returned_qty.
  it('RETURN_EXCEEDS_SOLD across two returns (cumulative)', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p, { qty: 5, price: 20000, revenue: 100000 });
    const a = sqlReturn(c, sale);
    expect(msgOf(() => sqlReturnItem(c, a, item, 6))).toMatch(/RETURN_EXCEEDS_SOLD/);   // more than sold in one go
    sqlReturnItem(c, a, item, 3);
    bump(c, item, 3);
    const b = sqlReturn(c, sale);
    expect(msgOf(() => sqlReturnItem(c, b, item, 3))).toMatch(/RETURN_EXCEEDS_SOLD/);   // 3 > 5 - 3
    sqlReturnItem(c, b, item, 2);
    bump(c, item, 2);
    const d = sqlReturn(c, sale);
    expect(msgOf(() => sqlReturnItem(c, d, item, 1))).toMatch(/RETURN_EXCEEDS_SOLD/);   // nothing left
    expect(scalar(c, 'SELECT SUM(qty) FROM sales_return_items')).toBe(5);
    expect(scalar(c, 'SELECT returned_qty FROM sale_items WHERE id = ?', item)).toBe(5);
  });

  it('append-only: UPDATE and DELETE are refused', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const sale = sqlSale(c);
    const item = sqlSaleItem(c, sale, p);
    const ret = sqlReturn(c, sale);
    const id = sqlReturnItem(c, ret, item, 1);
    for (const [col, val] of [['qty', 2], ['resalable', 0], ['revenue_cents', 1], ['cogs_cents', 1]] as const) {
      expect(msgOf(() => upd(c, 'sales_return_items', col, val, id)), col).toMatch(/append-only/);
    }
    expect(msgOf(() => c.prepare('DELETE FROM sales_return_items WHERE id = ?').run(id))).toMatch(/append-only/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_return_items')).toBe(1);
  });
});

// =============================================================================================
// The stock cache and the sales tables: sale rows alone move no stock; movements of type sale / sale_return / sale_void
// reference the sale and are kept in step with the products cache by the existing trigger.
describe('stock cache interplay', () => {
  // Hand calculation: pool 10 / 5,000. Sale rows change nothing. Issue 4 at the average: 5,000 x 4 / 10 = 2,000 -> pool 6 / 3,000.
  it('inserting sale rows does not touch the pool; a sale movement does (and is linked by ref_table sales)', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    stock(c, p, 10, 5000);
    const sale = sqlSale(c);
    sqlSaleItem(c, sale, p, { qty: 4, price: 25000, revenue: 100000, cogs: 2000 });
    expect(pool(c, p)).toEqual({ qty: 10, value: 5000 });
    const r = issueStock(c, { productId: p, businessDate: today(), type: 'sale', qty: 4, refTable: 'sales', refId: sale, reason: 'sale' });
    expect(r.valueRemovedCents).toBe(2000);
    expect(pool(c, p)).toEqual({ qty: 6, value: 3000 });
    expect(c.prepare("SELECT type, ref_table, ref_id, qty_delta, value_delta_cents FROM stock_movements WHERE type = 'sale'").get())
      .toMatchObject({ type: 'sale', ref_table: 'sales', ref_id: sale, qty_delta: -4, value_delta_cents: -2000 });
    // return and void movement types exist (Phase 1 CHECK list) and add stock back
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (?, ?, 'sale_return', 1, 500, 'sales_returns', 1, 'r')").run(p, today());
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (?, ?, 'sale_void', 1, 500, 'sales', ?, 'r')").run(p, today(), sale);
    expect(pool(c, p)).toEqual({ qty: 8, value: 4000 });
  });

  it('the cache refuses a sale that would drive quantity or value below zero, or leave value in an empty pool', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    stock(c, p, 2, 1000);
    const ins = (qty: number, value: number) => c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'sale', ?, ?, 's')").run(p, today(), qty, value);
    expect(msgOf(() => ins(-3, -1500))).toMatch(/CHECK|STOCK_VALUE_WITHOUT_QTY/);   // quantity below 0
    expect(msgOf(() => ins(-1, -2000))).toMatch(/CHECK|STOCK_VALUE_WITHOUT_QTY/);   // value below 0
    expect(msgOf(() => ins(-2, -900))).toMatch(/STOCK_VALUE_WITHOUT_QTY|CHECK/);    // emptied but 100 value left
    expect(pool(c, p)).toEqual({ qty: 2, value: 1000 });
  });
});

// =============================================================================================
// All-or-nothing: a real database transaction that writes a sale, its movement and its cash entry and then fails leaves nothing.
describe('database transaction rollback (sale + movement + cash entry)', () => {
  it('a tx that inserts a sale, its line, the stock movement and the cash entry and then throws leaves nothing behind', () => {
    const dir = env.newDir();
    const db = new AppDatabase(join(dir, 'tx.db'));
    try {
      migrate(db.conn);
      const p = sqlProduct(db.conn);
      db.tx((c) => stock(c, p, 10, 5000));
      const before = { sales: 0, items: 0, mov: 1, cash: 0 };

      const writeSale = (c: DatabaseSync) => {
        const sale = sqlSale(c, { total: 100000 });
        sqlSaleItem(c, sale, p, { qty: 4, price: 25000, revenue: 100000, cogs: 2000 });
        issueStock(c, { productId: p, businessDate: today(), type: 'sale', qty: 4, refTable: 'sales', refId: sale, reason: 'x' });
        c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', ?, 'sale_goods', 100000, 'sales', ?)").run(today(), sale);
        return sale;
      };
      const counts = () => ({
        sales: scalar(db.conn, 'SELECT COUNT(*) FROM sales'), items: scalar(db.conn, 'SELECT COUNT(*) FROM sale_items'),
        mov: scalar(db.conn, 'SELECT COUNT(*) FROM stock_movements'), cash: scalar(db.conn, 'SELECT COUNT(*) FROM cash_entries'),
      });

      expect(() => db.tx((c) => {
        writeSale(c);
        expect(pool(c, p)).toEqual({ qty: 6, value: 3000 }); // visible inside the transaction
        throw new Error('boom after cash entry');
      })).toThrow(/boom after cash entry/);
      expect(counts()).toEqual(before);
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      // a failing constraint late in the tx (future-dated cash entry) rolls the earlier statements back too
      expect(() => db.tx((c) => {
        const sale = writeSale(c);
        c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', ?, 'sale_goods', 1, 'sales', ?)").run(daysAhead(1), sale);
      })).toThrow(/FUTURE_DATE_NOT_ALLOWED/);
      expect(counts()).toEqual(before);
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      // success path commits everything together
      db.tx((c) => writeSale(c));
      expect(counts()).toEqual({ sales: 1, items: 1, mov: 2, cash: 1 });
      expect(pool(db.conn, p)).toEqual({ qty: 6, value: 3000 });
    } finally { db.close(); }
  });
});
