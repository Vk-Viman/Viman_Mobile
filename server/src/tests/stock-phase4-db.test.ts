// Phase 4 database rules (migration 005: stocktakes, stocktake_items, stock_losses, owner_drawings) - database level,
// raw SQL on in-memory SQLite, no HTTP.
// Protects the schema-level guarantees behind stocktakes (R2/R3), stock losses and owner drawings (BUSINESS_RULES sections 9
// and 11): documents move only along allowed status paths (draft -> completed -> void, never back, R1), a voided record keeps
// its void reason and timestamp, the business date and posting time never change (section 12), no future dates (R-FD), a
// stocktake can only list products of its own book, completed stocktakes are frozen, goods drawings need a product and a
// quantity, and ice cream drawings must name a fund (section 10.2).
// Organised by table: migration, stocktakes, stocktake_items, stock_losses, owner_drawings, then a rollback test.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase } from '../db/db.ts';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { receiveStock, issueStock } from '../services/inventory.service.ts';
import { TestEnv } from './helpers/tmp.ts';
import { daysAgo, daysAhead, memDb, msgOf, pool, scalar, sqlProduct, today } from './helpers/inventory.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

let seq = 0;
const uniq = () => `cref-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

// Raw-SQL helper: insert a stocktake header with the given status/dates (defaults to a draft for today in the shop book).
function addST(c: DatabaseSync, o: { date?: string; book?: string; status?: string; completedAt?: string | null; voidedAt?: string | null; voidReason?: string | null; ref?: string } = {}): number {
  return Number(c.prepare(
    `INSERT INTO stocktakes (business_date, book, status, completed_at, voided_at, void_reason, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.date ?? today(), o.book ?? 'shop', o.status ?? 'draft', o.completedAt ?? null, o.voidedAt ?? null, o.voidReason ?? null, o.ref ?? uniq()).lastInsertRowid);
}
// Raw-SQL helper: add a counted line (default counted quantity 5) to a stocktake.
const addItem = (c: DatabaseSync, st: number, product: number, counted = 5): number =>
  Number(c.prepare('INSERT INTO stocktake_items (stocktake_id, product_id, counted_qty) VALUES (?, ?, ?)').run(st, product, counted).lastInsertRowid);
// Raw-SQL helper: move a stocktake to 'completed' directly in SQL (the real flow does this via the API).
const complete = (c: DatabaseSync, st: number) =>
  c.prepare("UPDATE stocktakes SET status = 'completed', completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(st);
const NOW = '2026-01-01T00:00:00.000Z';

// Raw-SQL helper: insert a stock loss row with sensible defaults (1 unit, cost 100, 'damaged').
function addLoss(c: DatabaseSync, product: number, o: Record<string, any> = {}): number {
  return Number(c.prepare(
    `INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, source, status, client_ref, voided_at, void_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.date ?? today(), product, o.book ?? 'shop', o.qty ?? 1, o.cost ?? 100, o.reason ?? 'damaged', o.source ?? 'manual',
    o.status ?? 'posted', o.ref ?? uniq(), o.voidedAt ?? null, o.voidReason ?? null).lastInsertRowid);
}
// Raw-SQL helper: insert an owner drawing row (goods by default, shop book, amount 100).
function addDrawing(c: DatabaseSync, o: Record<string, any> = {}): number {
  return Number(c.prepare(
    `INSERT INTO owner_drawings (business_date, book, fund, kind, amount_cents, product_id, qty, status, client_ref, voided_at, void_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.date ?? today(), o.book ?? 'shop', o.fund ?? null, o.kind ?? 'goods', o.amount ?? 100, o.product ?? null, o.qty ?? null,
    o.status ?? 'posted', o.ref ?? uniq(), o.voidedAt ?? null, o.voidReason ?? null).lastInsertRowid);
}

// =============================================================================================
// Migration 005 adds the Phase 4 tables and their guard triggers.
describe('migration 005', () => {
  it('fresh DB reaches latestVersion >= 5 with all Phase 4 tables and triggers', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(5);
    expect(currentVersion(c)).toBe(latestVersion());
    const names = (type: string) =>
      (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(['stocktakes', 'stocktake_items', 'stock_losses', 'owner_drawings']));
    expect(names('trigger')).toEqual(expect.arrayContaining([
      'trg_stocktakes_future_date', 'trg_stocktakes_business_date_immutable', 'trg_stocktakes_posted_at_immutable',
      'trg_stocktakes_transition', 'trg_stocktake_items_insert_draft', 'trg_stocktake_items_delete_draft',
      'trg_stocktake_items_update_draft', 'trg_stocktake_items_product_insert', 'trg_stocktake_items_product_update',
      'trg_stock_losses_future_date', 'trg_stock_losses_immutable', 'trg_owner_drawings_future_date', 'trg_owner_drawings_immutable',
    ]));
  });

  // An older shop database (products, movements, purchases, audit) upgrades without losing rows, and the new tables work on it.
  it('v4 -> v5 upgrade preserves existing data (products, movements, purchases, audit) and the new tables work', () => {
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 4)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const c = new DatabaseSync(join(dir, 'v4.db'));
    conns.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    expect(migrate(c, mdir).version).toBe(4);
    const cat = scalar(c, "SELECT id FROM categories WHERE name = 'Other'");
    c.prepare(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Old', ?, 'stock', 'shop', 1000, 500)`).run(cat);
    const pid = scalar(c, "SELECT id FROM products WHERE name = 'Old'");
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'purchase', 7, 2100)").run(pid, today());
    c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 2100, 'oldpurchase-1')").run(today());
    c.prepare("INSERT INTO audit_logs (entity, entity_id, action, note) VALUES ('product','1','create','legacy')").run();

    const r = migrate(c);
    expect(r.applied).toEqual(expect.arrayContaining(['005_stocktake_losses_drawings.sql']));
    expect(currentVersion(c)).toBe(latestVersion());
    expect(pool(c, pid)).toEqual({ qty: 7, value: 2100 });
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_movements')).toBe(1);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchases')).toBe(1);
    expect(scalar(c, "SELECT COUNT(*) FROM audit_logs WHERE note = 'legacy'")).toBe(1);
    // new tables usable on the upgraded database
    const st = addST(c);
    addItem(c, st, pid, 3);
    addLoss(c, pid, { qty: 1, cost: 300 });
    expect(scalar(c, 'SELECT COUNT(*) FROM stocktake_items')).toBe(1);
    expect(migrate(c).applied).toEqual([]);
  });
});

// =============================================================================================
// Stocktake header rules: defaults, dates, immutability, allowed status transitions.
describe('stocktakes table', () => {
  // A new stocktake starts as a draft with a server-set posting time; unknown statuses or books are refused.
  it('defaults: draft, empty notes, posted_at server timestamp; enums enforced', () => {
    const c = memDb(conns);
    const id = addST(c);
    const r = c.prepare('SELECT status, notes, posted_at, completed_at FROM stocktakes WHERE id = ?').get(id) as any;
    expect(r.status).toBe('draft');
    expect(r.notes).toBe('');
    expect(r.completed_at).toBeNull();
    expect(r.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(msgOf(() => addST(c, { book: 'icecream' }))).toMatch(/CHECK/);
    expect(msgOf(() => addST(c, { status: 'bogus' }))).toMatch(/CHECK/);
    const dupRef = uniq();
    addST(c, { ref: dupRef });
    expect(msgOf(() => addST(c, { ref: dupRef }))).toMatch(/UNIQUE/);
  });

  // R-FD at database level: tomorrow's date is refused, backdating is allowed.
  it('future business date rejected (trigger); today and backdated accepted; malformed dates refused', () => {
    const c = memDb(conns);
    expect(msgOf(() => addST(c, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    expect(msgOf(() => addST(c, { date: '2999-01-01' }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    addST(c, { date: today() });
    addST(c, { date: daysAgo(40) });
    for (const d of ['2026-02-31', '2026-2-3', '20260203', '2026-13-01', 'abc', '2025-02-29', '']) {
      expect(msgOf(() => addST(c, { date: d })), d).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED/);
    }
    addST(c, { date: '2024-02-29' });
  });

  // Section 12: reports and costing order depend on these two fields, so they can never be changed after saving.
  it('business_date and posted_at are immutable', () => {
    const c = memDb(conns);
    const id = addST(c);
    expect(msgOf(() => c.prepare('UPDATE stocktakes SET business_date = ? WHERE id = ?').run(daysAgo(1), id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id))).toMatch(/POSTED_AT_IMMUTABLE/);
    // same value is not a change
    c.prepare('UPDATE stocktakes SET business_date = business_date WHERE id = ?').run(id);
  });

  // The only legal life cycle: draft -> completed, draft -> void, completed -> void.
  it('allowed transitions: draft->completed, draft->void, completed->void', () => {
    const c = memDb(conns);
    const a = addST(c);
    complete(c, a);
    expect(scalar(c, 'SELECT COUNT(*) FROM stocktakes WHERE id = ? AND status = ?', a, 'completed')).toBe(1);
    c.prepare("UPDATE stocktakes SET status = 'void', voided_at = ?, void_reason = 'why' WHERE id = ?").run(NOW, a);
    expect(scalar(c, "SELECT COUNT(*) FROM stocktakes WHERE id = ? AND status = 'void'", a)).toBe(1);
    const b = addST(c);
    c.prepare("UPDATE stocktakes SET status = 'void', voided_at = ?, void_reason = 'cancel' WHERE id = ?").run(NOW, b);
    expect(scalar(c, "SELECT COUNT(*) FROM stocktakes WHERE id = ? AND status = 'void'", b)).toBe(1);
  });

  // History moves forward only: nothing can be reopened or un-voided (R1: corrections are new records).
  it('forbidden transitions: completed->draft, void->draft, void->completed, and un-voiding', () => {
    const c = memDb(conns);
    const a = addST(c);
    complete(c, a);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'draft' WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
    const v = addST(c);
    c.prepare("UPDATE stocktakes SET status = 'void', voided_at = ?, void_reason = 'x' WHERE id = ?").run(NOW, v);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'draft' WHERE id = ?").run(v))).toMatch(/STOCKTAKE_TRANSITION|CHECK/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'completed', completed_at = ? WHERE id = ?").run(NOW, v))).toMatch(/STOCKTAKE_TRANSITION/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET void_reason = 'changed' WHERE id = ?").run(v))).toMatch(/STOCKTAKE_TRANSITION/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET voided_at = ? WHERE id = ?").run('2030-01-01T00:00:00.000Z', v))).toMatch(/STOCKTAKE_TRANSITION/);
  });

  // A void must say when and why (audit trail), and a completed stocktake must record completed_at.
  it('void requires voided_at and void_reason; completed requires completed_at', () => {
    const c = memDb(conns);
    const a = addST(c);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'void' WHERE id = ?").run(a))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'void', voided_at = ? WHERE id = ?").run(NOW, a))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'void', void_reason = 'r' WHERE id = ?").run(a))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET status = 'completed' WHERE id = ?").run(a))).toMatch(/CHECK/);
    expect(msgOf(() => addST(c, { status: 'void' }))).toMatch(/CHECK/);
    expect(msgOf(() => addST(c, { status: 'completed' }))).toMatch(/CHECK/);
    expect(scalar(c, "SELECT COUNT(*) FROM stocktakes WHERE status = 'draft'")).toBe(1);
  });

  it('a draft cannot carry void data; completed_at / book / client_ref never change', () => {
    const c = memDb(conns);
    const a = addST(c);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET voided_at = ? WHERE id = ?").run(NOW, a))).toMatch(/STOCKTAKE_TRANSITION/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET book = 'telecom' WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET client_ref = 'zzzzzzzz-9' WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET id = 999 WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
    complete(c, a);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET completed_at = '2027-01-01T00:00:00.000Z' WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
  });

  // Once completed, even the notes are frozen.
  it('notes may change only while draft', () => {
    const c = memDb(conns);
    const a = addST(c);
    c.prepare("UPDATE stocktakes SET notes = 'first' WHERE id = ?").run(a);
    c.prepare("UPDATE stocktakes SET notes = 'second' WHERE id = ?").run(a);
    complete(c, a);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET notes = 'third' WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
    c.prepare("UPDATE stocktakes SET status = 'void', voided_at = ?, void_reason = 'r' WHERE id = ?").run(NOW, a);
    expect(msgOf(() => c.prepare("UPDATE stocktakes SET notes = 'fourth' WHERE id = ?").run(a))).toMatch(/STOCKTAKE_TRANSITION/);
    expect((c.prepare('SELECT notes FROM stocktakes WHERE id = ?').get(a) as any).notes).toBe('second');
  });
});

// =============================================================================================
// Counted lines: only valid counts, one per product, only products of the stocktake's book, only while draft.
describe('stocktake_items table', () => {
  it('inserts in a draft; counted_qty >= 0; gain cost >= 0 or null; one row per (stocktake, product)', () => {
    const c = memDb(conns);
    const st = addST(c);
    const p = sqlProduct(c);
    addItem(c, st, p, 0);
    expect(msgOf(() => addItem(c, st, p, 3))).toMatch(/UNIQUE/);
    const q = sqlProduct(c);
    expect(msgOf(() => addItem(c, st, q, -1))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare('INSERT INTO stocktake_items (stocktake_id, product_id, counted_qty, gain_unit_cost_cents) VALUES (?, ?, 1, -5)').run(st, q))).toMatch(/CHECK/);
    c.prepare('INSERT INTO stocktake_items (stocktake_id, product_id, counted_qty, gain_unit_cost_cents) VALUES (?, ?, 1, 0)').run(st, q);
    // same product in a different stocktake is fine
    const st2 = addST(c);
    addItem(c, st2, p, 9);
    expect(msgOf(() => addItem(c, 9999, p))).toMatch(/FOREIGN KEY|STOCKTAKE_NOT_DRAFT|PRODUCT_NOT_IN_BOOK/);
    expect(msgOf(() => addItem(c, st, 9999))).toMatch(/FOREIGN KEY|PRODUCT_NOT_IN_BOOK/);
  });

  // A shop stocktake cannot list telecom products (segments are disjoint) or services (no stock).
  it('product of another book, or a service product, is refused with PRODUCT_NOT_IN_BOOK', () => {
    const c = memDb(conns);
    const shopSt = addST(c, { book: 'shop' });
    const telSt = addST(c, { book: 'telecom' });
    const shopP = sqlProduct(c, { book: 'shop' });
    const telP = sqlProduct(c, { book: 'telecom' });
    const svc = sqlProduct(c, { kind: 'service' });
    expect(msgOf(() => addItem(c, shopSt, telP))).toMatch(/PRODUCT_NOT_IN_BOOK/);
    expect(msgOf(() => addItem(c, telSt, shopP))).toMatch(/PRODUCT_NOT_IN_BOOK/);
    expect(msgOf(() => addItem(c, shopSt, svc))).toMatch(/PRODUCT_NOT_IN_BOOK/);
    addItem(c, shopSt, shopP);
    addItem(c, telSt, telP);
    // moving an item to a product of the wrong book is refused too
    const id = addItem(c, shopSt, sqlProduct(c));
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET product_id = ? WHERE id = ?').run(telP, id))).toMatch(/PRODUCT_NOT_IN_BOOK/);
  });

  // Drafts are working copies: lines and their completion figures may still change; completed/void ones may not.
  it('draft items may be updated and deleted, including the completion figures', () => {
    const c = memDb(conns);
    const st = addST(c);
    const p = sqlProduct(c);
    const id = addItem(c, st, p, 4);
    c.prepare('UPDATE stocktake_items SET counted_qty = 6, gain_unit_cost_cents = 50 WHERE id = ?').run(id);
    c.prepare('UPDATE stocktake_items SET expected_qty = 2, difference_qty = 4, value_delta_cents = 200 WHERE id = ?').run(id);
    expect(scalar(c, 'SELECT counted_qty FROM stocktake_items WHERE id = ?', id)).toBe(6);
    c.prepare('DELETE FROM stocktake_items WHERE id = ?').run(id);
    expect(scalar(c, 'SELECT COUNT(*) FROM stocktake_items')).toBe(0);
  });

  it.each(['completed', 'void'] as const)('after the stocktake is %s: insert, update and delete are STOCKTAKE_NOT_DRAFT', (state) => {
    const c = memDb(conns);
    const st = addST(c);
    const p = sqlProduct(c);
    const q = sqlProduct(c);
    const id = addItem(c, st, p, 4);
    complete(c, st);
    if (state === 'void') c.prepare("UPDATE stocktakes SET status = 'void', voided_at = ?, void_reason = 'r' WHERE id = ?").run(NOW, st);
    expect(msgOf(() => addItem(c, st, q))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET counted_qty = 9 WHERE id = ?').run(id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET gain_unit_cost_cents = 9 WHERE id = ?').run(id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET expected_qty = 9 WHERE id = ?').run(id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET difference_qty = 9 WHERE id = ?').run(id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET value_delta_cents = 9 WHERE id = ?').run(id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('UPDATE stocktake_items SET product_id = ? WHERE id = ?').run(q, id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(msgOf(() => c.prepare('DELETE FROM stocktake_items WHERE id = ?').run(id))).toMatch(/STOCKTAKE_NOT_DRAFT/);
    expect(scalar(c, 'SELECT counted_qty FROM stocktake_items WHERE id = ?', id)).toBe(4);
  });
});

// =============================================================================================
// Stock loss rows: checks, dates and the posted -> void lifecycle.
describe('stock_losses table', () => {
  it('valid insert, defaults, and every CHECK', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const id = addLoss(c, p);
    const r = c.prepare('SELECT status, source, note, posted_at FROM stock_losses WHERE id = ?').get(id) as any;
    expect(r).toMatchObject({ status: 'posted', source: 'manual', note: '' });
    expect(r.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const reason of ['damaged', 'lost', 'expired', 'other']) addLoss(c, p, { reason });
    addLoss(c, p, { source: 'damaged_return' });
    addLoss(c, p, { book: 'telecom' });
    addLoss(c, p, { cost: 0 });
    expect(msgOf(() => addLoss(c, p, { reason: 'stolen' }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, p, { source: 'x' }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, p, { status: 'draft' }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, p, { book: 'icecream' }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, p, { qty: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, p, { qty: -2 }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, p, { cost: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => addLoss(c, 9999))).toMatch(/FOREIGN KEY/);
    const dup = uniq();
    addLoss(c, p, { ref: dup });
    expect(msgOf(() => addLoss(c, p, { ref: dup }))).toMatch(/UNIQUE/);
  });

  it('dates: future refused, malformed refused, backdated accepted; business_date / posted_at immutable', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    expect(msgOf(() => addLoss(c, p, { date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    for (const d of ['2026-02-31', 'abc', '2026-1-1', '2025-02-29']) expect(msgOf(() => addLoss(c, p, { date: d })), d).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED/);
    const id = addLoss(c, p, { date: daysAgo(5) });
    expect(msgOf(() => c.prepare('UPDATE stock_losses SET business_date = ? WHERE id = ?').run(today(), id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id))).toMatch(/POSTED_AT_IMMUTABLE/);
  });

  // A posted loss can only be voided (with time and reason) and never goes back (R1).
  it('immutable except posted -> void; void needs voided_at and void_reason; no way back', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const id = addLoss(c, p);
    for (const [col, val] of [['qty', 2], ['cost_cents', 5], ['reason', 'lost'], ['note', 'x'], ['source', 'damaged_return'],
      ['book', 'telecom'], ['product_id', sqlProduct(c)], ['client_ref', 'abcdefgh-1']] as const) {
      expect(msgOf(() => c.prepare(`UPDATE stock_losses SET ${col} = ? WHERE id = ?`).run(val, id)), col).toMatch(/STOCK_LOSS_IMMUTABLE|CHECK/);
    }
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET status = 'void' WHERE id = ?").run(id))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET status = 'void', voided_at = ? WHERE id = ?").run(NOW, id))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET void_reason = 'r' WHERE id = ?").run(id))).toMatch(/STOCK_LOSS_IMMUTABLE/);
    c.prepare("UPDATE stock_losses SET status = 'void', voided_at = ?, void_reason = 'why' WHERE id = ?").run(NOW, id);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET status = 'posted' WHERE id = ?").run(id))).toMatch(/STOCK_LOSS_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET void_reason = 'other' WHERE id = ?").run(id))).toMatch(/STOCK_LOSS_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET voided_at = '2031-01-01T00:00:00.000Z' WHERE id = ?").run(id))).toMatch(/STOCK_LOSS_IMMUTABLE/);
    expect(msgOf(() => c.prepare('UPDATE stock_losses SET qty = 9 WHERE id = ?').run(id))).toMatch(/STOCK_LOSS_IMMUTABLE/);
    expect(scalar(c, "SELECT COUNT(*) FROM stock_losses WHERE id = ? AND status = 'void' AND qty = 1", id)).toBe(1);
    expect(msgOf(() => addLoss(c, p, { status: 'void' }))).toMatch(/CHECK/);
  });
});

// =============================================================================================
// Owner drawings (below the P&L line, section 9): goods need a product + quantity; ice cream drawings name a fund.
describe('owner_drawings table', () => {
  it('goods drawing needs a product and qty >= 1', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    const id = addDrawing(c, { product: p, qty: 2 });
    expect(c.prepare('SELECT status, note, kind FROM owner_drawings WHERE id = ?').get(id)).toMatchObject({ status: 'posted', note: '', kind: 'goods' });
    addDrawing(c, { product: p, qty: 1, book: 'telecom' });
    expect(msgOf(() => addDrawing(c, { kind: 'goods' }))).toMatch(/CHECK/);                       // no product, no qty
    expect(msgOf(() => addDrawing(c, { qty: 2 }))).toMatch(/CHECK/);                              // no product
    expect(msgOf(() => addDrawing(c, { product: p, qty: 0 }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { product: p, qty: -1 }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { product: 9999, qty: 1 }))).toMatch(/FOREIGN KEY/);
    expect(msgOf(() => addDrawing(c, { product: p, qty: 1, amount: -1 }))).toMatch(/CHECK/);
  });

  // NULL >= 1 is not true in SQL, so a missing quantity must be caught explicitly or it would slip through the CHECK.
  it('goods drawing with a product but NULL qty is refused (NULL >= 1 must not pass the CHECK)', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    expect(msgOf(() => addDrawing(c, { product: p }))).toMatch(/CHECK/);
    expect(scalar(c, 'SELECT COUNT(*) FROM owner_drawings')).toBe(0);
  });

  it('cash drawing: no product / qty allowed; enum checks', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addDrawing(c, { kind: 'cash', amount: 5000 });
    expect(msgOf(() => addDrawing(c, { kind: 'cash', product: p }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', qty: 1 }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', product: p, qty: 1 }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'other', amount: 1 }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', book: 'bogus' }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', status: 'draft' }))).toMatch(/CHECK/);
  });

  // Section 10.2: ice cream drawings must name exactly one fund; other books must not have one; goods drawings are not allowed in ice cream.
  it('(book = icecream) = (fund IS NOT NULL); fund enum; no goods in icecream', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addDrawing(c, { kind: 'cash', book: 'icecream', fund: 'profit' });
    addDrawing(c, { kind: 'cash', book: 'icecream', fund: 'cost' });
    addDrawing(c, { kind: 'cash', book: 'icecream', fund: 'electricity' });
    expect(msgOf(() => addDrawing(c, { kind: 'cash', book: 'icecream' }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', book: 'shop', fund: 'cost' }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', book: 'telecom', fund: 'profit' }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'cash', book: 'icecream', fund: 'bogus' }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'goods', book: 'icecream', fund: 'cost', product: p, qty: 1 }))).toMatch(/CHECK/);
    expect(msgOf(() => addDrawing(c, { kind: 'goods', book: 'icecream', product: p, qty: 1 }))).toMatch(/CHECK/);
  });

  it('dates, immutability, void rules', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    expect(msgOf(() => addDrawing(c, { product: p, qty: 1, date: daysAhead(2) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    for (const d of ['2026-02-31', 'abc', '2025-02-29']) expect(msgOf(() => addDrawing(c, { product: p, qty: 1, date: d })), d).toMatch(/CHECK|FUTURE_DATE_NOT_ALLOWED/);
    const id = addDrawing(c, { product: p, qty: 1, date: daysAgo(3) });
    expect(msgOf(() => c.prepare('UPDATE owner_drawings SET business_date = ? WHERE id = ?').run(today(), id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE owner_drawings SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id))).toMatch(/POSTED_AT_IMMUTABLE/);
    for (const [col, val] of [['amount_cents', 1], ['qty', 5], ['note', 'x'], ['book', 'telecom'], ['kind', 'cash'], ['product_id', sqlProduct(c)], ['client_ref', 'abcdefgh-2']] as const) {
      expect(msgOf(() => c.prepare(`UPDATE owner_drawings SET ${col} = ? WHERE id = ?`).run(val, id)), col).toMatch(/OWNER_DRAWING_IMMUTABLE|CHECK/);
    }
    expect(msgOf(() => c.prepare("UPDATE owner_drawings SET status = 'void' WHERE id = ?").run(id))).toMatch(/CHECK/);
    expect(msgOf(() => c.prepare("UPDATE owner_drawings SET void_reason = 'r' WHERE id = ?").run(id))).toMatch(/OWNER_DRAWING_IMMUTABLE/);
    c.prepare("UPDATE owner_drawings SET status = 'void', voided_at = ?, void_reason = 'why' WHERE id = ?").run(NOW, id);
    expect(msgOf(() => c.prepare("UPDATE owner_drawings SET status = 'posted' WHERE id = ?").run(id))).toMatch(/OWNER_DRAWING_IMMUTABLE/);
    expect(msgOf(() => c.prepare("UPDATE owner_drawings SET void_reason = 'again' WHERE id = ?").run(id))).toMatch(/OWNER_DRAWING_IMMUTABLE/);
    expect(msgOf(() => addDrawing(c, { product: p, qty: 1, status: 'void' }))).toMatch(/CHECK/);
  });

  // Inserting a drawing row creates nothing else: stock and cash effects are written by the service, not hidden in triggers.
  it('a drawing never touches stock, cash or loss tables by itself', () => {
    const c = memDb(conns);
    const p = sqlProduct(c);
    addDrawing(c, { product: p, qty: 1 });
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_movements')).toBe(0);
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_entries')).toBe(0);
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
  });
});

// =============================================================================================
// A loss row and its stock movement are saved together or not at all.
describe('database transaction rollback (loss row + movement)', () => {
  it('a tx that inserts a loss row and its movement and then fails leaves nothing behind and the cache unchanged', () => {
    const dir = env.newDir();
    const db = new AppDatabase(join(dir, 'tx.db'));
    try {
      migrate(db.conn);
      const p = sqlProduct(db.conn);
      db.tx((c) => receiveStock(c, { productId: p, businessDate: today(), type: 'purchase', qty: 10, valueCents: 5000, refTable: null, refId: null, reason: 'seed' }));
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      expect(() => db.tx((c) => {
        const lossId = addLoss(c, p, { qty: 4, cost: 2000 });
        issueStock(c, { productId: p, businessDate: today(), type: 'loss', qty: 4, refTable: 'stock_losses', refId: lossId, reason: 'x' });
        expect(pool(c, p)).toEqual({ qty: 6, value: 3000 }); // visible inside the transaction
        throw new Error('boom after movement');
      })).toThrow(/boom after movement/);

      expect(scalar(db.conn, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
      expect(scalar(db.conn, 'SELECT COUNT(*) FROM stock_movements')).toBe(1);
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      // a failing DB constraint inside the tx rolls back the earlier statements as well
      expect(() => db.tx((c) => {
        const lossId = addLoss(c, p, { qty: 2, cost: 1000 });
        issueStock(c, { productId: p, businessDate: today(), type: 'loss', qty: 2, refTable: 'stock_losses', refId: lossId, reason: 'x' });
        issueStock(c, { productId: p, businessDate: today(), type: 'loss', qty: 99, refTable: null, refId: null, reason: 'too many' });
      })).toThrow(/Not enough stock/);
      expect(scalar(db.conn, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
      expect(pool(db.conn, p)).toEqual({ qty: 10, value: 5000 });

      // nested tx: inner failure caught by the outer one rolls back only the inner part
      db.tx((c) => {
        addLoss(c, p, { qty: 1, cost: 500 });
        try {
          db.tx((c2) => { addLoss(c2, p, { qty: 1, cost: 500 }); throw new Error('inner'); });
        } catch { /* expected */ }
      });
      expect(scalar(db.conn, 'SELECT COUNT(*) FROM stock_losses')).toBe(1);
    } finally { db.close(); }
  });
});
