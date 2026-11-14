// PHASE 17 database rules (migration 017: void a sales return, BUSINESS_RULES R-VR) - raw SQL on in-memory / temp SQLite, no HTTP.
// Protects what must hold even if the application has a bug or someone types SQL by hand:
//   * sales_returns is still append-only: every column except the status transition posted -> void is frozen, a void return never changes,
//     DELETE is refused (R1); a void records when and why (CHECK);
//   * a return can only be voided when it is the NEWEST posted return of every line it touches (RETURN_NOT_NEWEST);
//   * the DATABASE lowers sale_items.returned_qty by exactly the returned quantity and voids the damaged-return loss rows when a return
//     becomes void (invariant returned_qty = sum of qty of POSTED return lines); a manual decrease is refused (SALE_ITEM_IMMUTABLE);
//   * a damaged-return loss cannot be voided on its own (DAMAGED_RETURN_LOSS);
//   * reversal rows (stock movements out, refund-reversal cash entry) exist only for a VOID return, cannot exceed what the return restocked,
//     must link to the original refund entry, and a refund entry is reversed at most once (unique link);
//   * the C13 extra-cost backstop and the RETURN_EXCEEDS_SOLD backstop count posted returns only;
//   * the append-only ledgers and delete guards are untouched; an older database upgrades without losing a row.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentVersion, latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { issueStock, receiveStock } from '../services/inventory.service.ts';
import { TestEnv } from './helpers/tmp.ts';
import { memDb, msgOf, pool, scalar, sqlProduct, today } from './helpers/inventory.ts';
import { sqlReturn, sqlReturnItem, sqlSale, sqlSaleItem } from './helpers/phase5.ts';

const env = new TestEnv();
const conns: DatabaseSync[] = [];
afterEach(async () => {
  for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
  conns.length = 0;
  await env.cleanup();
});

const VOIDED = '2026-01-01T00:00:00.000Z';
const upd = (c: DatabaseSync, table: string, col: string, val: unknown, id: number) =>
  c.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(val as any, id);
/**
 * Voids a return the way the service does since migration 020 (M2): the reversal rows (stock first, then cash) of every original that has none
 * yet are written FIRST, then the status flips; all inside one savepoint so a refusal (e.g. RETURN_NOT_NEWEST) leaves nothing behind.
 * (Before 020 a raw flip without reversal rows was accepted; that is exactly the gap the new VOID_WITHOUT_REVERSAL trigger closes.)
 */
const reverseReturn = (c: DatabaseSync, id: number) => {
  for (const o of c.prepare(`SELECT * FROM stock_movements o WHERE ref_table = 'sales_returns' AND ref_id = ? AND reverses_movement_id IS NULL AND qty_delta > 0
      AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)`).all(id) as any[]) {
    c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason, reverses_movement_id) VALUES (?, ?, 'sale_return', ?, ?, 'sales_returns', ?, 'r', ?)")
      .run(o.product_id, o.business_date, -o.qty_delta, -o.value_delta_cents, id, o.id);
  }
  for (const o of c.prepare(`SELECT * FROM cash_entries o WHERE ref_table = 'sales_returns' AND ref_id = ? AND reverses_entry_id IS NULL AND amount_cents <> 0
      AND NOT EXISTS (SELECT 1 FROM cash_entries r WHERE r.reverses_entry_id = o.id)`).all(id) as any[]) {
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, reverses_entry_id) VALUES (?, ?, ?, ?, ?, 'sales_returns', ?, ?)")
      .run(o.book, o.business_date, o.type, -o.amount_cents, o.fund, id, o.id);
  }
};
const voidRet = (c: DatabaseSync, id: number) => {
  c.exec('SAVEPOINT vr');
  try {
    reverseReturn(c, id);
    c.prepare("UPDATE sales_returns SET status = 'void', voided_at = ?, void_reason = 'r' WHERE id = ?").run(VOIDED, id);
    c.exec('RELEASE vr');
  } catch (e) { c.exec('ROLLBACK TO vr'); c.exec('RELEASE vr'); throw e; }
};
const retStatus = (c: DatabaseSync, id: number) => c.prepare('SELECT status FROM sales_returns WHERE id = ?').get(id) as { status: string };
const returned = (c: DatabaseSync, item: number) => scalar(c, 'SELECT returned_qty FROM sale_items WHERE id = ?', item);

/**
 * A shop with product pool 10 / 10,000 (a purchase), one sale of 3 units at 100,000 (line revenue 300,000, cogs 70,000, extra cost 50)
 * and a helper that records a return the way the service does (return, line, counter, refund entry, restock movement).
 */
function world(c: DatabaseSync, extra = 50) {
  const p = sqlProduct(c);
  receiveStock(c, { productId: p, businessDate: '2025-04-01', type: 'purchase', qty: 10, valueCents: 10000, refTable: null, refId: null, reason: 'seed' });
  const sale = sqlSale(c, { date: '2025-04-02', total: 300000 });
  const item = sqlSaleItem(c, sale, p, { qty: 3, price: 100000, cogs: 70000, extra });
  const ret = (qty: number, date = '2025-04-03', o: { extra?: number; damaged?: boolean } = {}) => {
    const id = sqlReturn(c, sale, { date, refund: 100000 * qty, cogs: 1000 * qty, extra: o.extra ?? 0 });
    sqlReturnItem(c, id, item, qty, { resalable: o.damaged ? 0 : 1, revenue: 100000 * qty, cogs: 1000 * qty, ...(o.extra === undefined ? {} : { extra: o.extra }) });
    c.prepare('UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ?').run(qty, item);
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', ?, 'sale_refund', ?, 'sales_returns', ?)").run(date, -100000 * qty, id);
    if (o.damaged) {
      c.prepare("INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, source, sales_return_id, client_ref) VALUES (?, ?, 'shop', ?, ?, 'damaged', 'damaged_return', ?, ?)")
        .run(date, p, qty, 1000 * qty, id, `loss-${id}`);
    } else {
      c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (?, ?, 'sale_return', ?, ?, 'sales_returns', ?, 'r')")
        .run(p, date, qty, 1000 * qty, id);
    }
    return id;
  };
  return { p, sale, item, ret };
}

describe('migration 017', () => {
  it('fresh DB: status columns, triggers and the unique reversal index exist', () => {
    const c = memDb(conns);
    expect(latestVersion()).toBeGreaterThanOrEqual(17);
    expect(currentVersion(c)).toBe(latestVersion());
    const cols = (c.prepare('PRAGMA table_info(sales_returns)').all() as { name: string }[]).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(['status', 'voided_at', 'void_reason']));
    const names = (type: string) => (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('trigger')).toEqual(expect.arrayContaining([
      'trg_sales_returns_no_update', 'trg_sales_returns_no_delete', 'trg_sales_returns_void_newest', 'trg_sales_returns_void_effects',
      'trg_sale_items_immutable', 'trg_sales_return_items_extra_exceeds', 'trg_stock_losses_damaged_return_void_guard',
      'trg_stock_movements_return_reversal_void', 'trg_stock_movements_return_reversal_cap', 'trg_cash_entries_return_reversal',
    ]));
    expect(names('index')).toContain('uq_cash_entries_return_reversal');
  });

  // An older database (everything below 017) upgrades without losing a row; its returns become 'posted'.
  it('upgrade from the previous version keeps sales, lines, returns, counters and ledgers; old returns are posted; a void works afterwards', () => {
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version < 17)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const c = new DatabaseSync(join(dir, 'old.db'));
    conns.push(c);
    c.exec('PRAGMA foreign_keys = ON');
    const before = migrate(c, mdir).version;
    expect(before).toBeLessThan(17);
    const w = world(c);
    const r1 = w.ret(1);
    const r2 = w.ret(2);
    const out = migrate(c);
    expect(out.applied[0]).toBe('017_void_sales_return.sql');
    expect(currentVersion(c)).toBe(latestVersion());
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns WHERE status = ?', 'posted')).toBe(2);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns WHERE voided_at IS NOT NULL OR void_reason IS NOT NULL')).toBe(0);
    expect(returned(c, w.item)).toBe(3);
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_entries')).toBe(2);
    expect(pool(c, w.p)).toEqual({ qty: 13, value: 13000 });
    voidRet(c, r2);
    expect(returned(c, w.item)).toBe(1);
    expect(retStatus(c, r1).status).toBe('posted');
    expect(migrate(c).applied).toEqual([]);
  });
});

describe('sales_returns: append-only except posted -> void', () => {
  it('status/voided_at/void_reason are consistent (CHECK): a void needs both, a posted return has neither', () => {
    const c = memDb(conns);
    const w = world(c);
    const ins = (status: string, at: string | null, reason: string | null, ref: string) => c.prepare(
      `INSERT INTO sales_returns (sale_id, business_date, refund_cents, cogs_reversed_cents, client_ref, status, voided_at, void_reason)
       VALUES (?, '2025-04-03', 1, 1, ?, ?, ?, ?)`).run(w.sale, ref, status, at, reason);
    expect(msgOf(() => ins('void', null, 'x', 'c1'))).toMatch(/CHECK constraint failed/);
    expect(msgOf(() => ins('void', VOIDED, null, 'c2'))).toMatch(/CHECK constraint failed/);
    expect(msgOf(() => ins('posted', VOIDED, null, 'c3'))).toMatch(/CHECK constraint failed/);
    expect(msgOf(() => ins('posted', null, 'x', 'c4'))).toMatch(/CHECK constraint failed/);
    expect(msgOf(() => ins('cancelled', null, null, 'c5'))).toMatch(/CHECK constraint failed/);
    ins('posted', null, null, 'c6');
    ins('void', VOIDED, 'because', 'c7');
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns')).toBe(2);
  });

  it('every column of a posted return is frozen (append-only); only the valid status transition passes', () => {
    const c = memDb(conns);
    const w = world(c);
    const id = w.ret(1);
    const cols: Array<[string, unknown]> = [
      ['sale_id', w.sale], ['business_date', today()], ['posted_at', VOIDED], ['refund_cents', 5], ['cogs_reversed_cents', 5],
      ['extra_cost_reversed_cents', 5], ['note', 'x'], ['client_ref', 'other-ref-1'], ['voided_at', VOIDED], ['void_reason', 'x'], ['status', 'posted'],
    ];
    for (const [col, val] of cols) expect(msgOf(() => upd(c, 'sales_returns', col, val, id)), col).toMatch(/append-only/);
    // void without when/why: refused (the transition must carry both)
    expect(msgOf(() => c.prepare("UPDATE sales_returns SET status = 'void' WHERE id = ?").run(id))).toMatch(/append-only|CHECK constraint failed/);
    // void while ALSO changing another column: refused
    expect(msgOf(() => c.prepare("UPDATE sales_returns SET status = 'void', voided_at = ?, void_reason = 'r', refund_cents = 1 WHERE id = ?").run(VOIDED, id))).toMatch(/append-only/);
    expect(retStatus(c, id).status).toBe('posted');
    voidRet(c, id);
    expect(retStatus(c, id).status).toBe('void');
  });

  it('a void return never changes again (not back to posted, no column, no second void data); DELETE is refused for posted and void', () => {
    const c = memDb(conns);
    const w = world(c);
    const a = w.ret(1);
    const b = w.ret(1);
    voidRet(c, b);
    for (const col of ['status', 'voided_at', 'void_reason', 'refund_cents', 'note']) {
      const val = col === 'status' ? 'posted' : col.endsWith('cents') ? 9 : 'zzz';
      expect(msgOf(() => upd(c, 'sales_returns', col, val, b)), col).toMatch(/append-only/);
    }
    expect(msgOf(() => voidRet(c, b))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM sales_returns WHERE id = ?').run(a))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM sales_returns WHERE id = ?').run(b))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM sales_return_items WHERE sales_return_id = ?').run(b))).toMatch(/append-only/);
    expect(scalar(c, 'SELECT COUNT(*) FROM sales_returns')).toBe(2);
  });
});

describe('newest first, counters and loss rows follow the status change inside the database', () => {
  it('only the newest posted return of a shared line can become void (RETURN_NOT_NEWEST); then the older one can', () => {
    const c = memDb(conns);
    const w = world(c);
    const r1 = w.ret(1);
    const r2 = w.ret(1);
    expect(msgOf(() => voidRet(c, r1))).toMatch(/RETURN_NOT_NEWEST/);
    expect(retStatus(c, r1).status).toBe('posted');
    expect(returned(c, w.item)).toBe(2);
    voidRet(c, r2);
    voidRet(c, r1);
    expect(returned(c, w.item)).toBe(0);
  });

  it('returns of different lines do not block each other', () => {
    const c = memDb(conns);
    const w = world(c);
    const item2 = sqlSaleItem(c, w.sale, w.p, { lineNo: 2, qty: 2, price: 100000, cogs: 50000 });
    const r1 = w.ret(1);
    const r2 = sqlReturn(c, w.sale, { date: '2025-04-04', refund: 100000, cogs: 1000 });
    sqlReturnItem(c, r2, item2, 1, { revenue: 100000, cogs: 1000 });
    c.prepare('UPDATE sale_items SET returned_qty = 1 WHERE id = ?').run(item2);
    voidRet(c, r1);                                      // r2 is newer but touches only the other line
    expect(returned(c, w.item)).toBe(0);
    expect(returned(c, item2)).toBe(1);
  });

  it('becoming void lowers returned_qty by exactly the returned quantity and voids the damaged-return loss of that return only', () => {
    const c = memDb(conns);
    const w = world(c);
    const resalable = w.ret(1);
    const damaged = w.ret(2, '2025-04-04', { damaged: true });
    expect(returned(c, w.item)).toBe(3);
    expect(msgOf(() => c.prepare("UPDATE stock_losses SET status = 'void', voided_at = ?, void_reason = 'x' WHERE sales_return_id = ?").run(VOIDED, damaged))).toMatch(/DAMAGED_RETURN_LOSS/);
    voidRet(c, damaged);
    expect(returned(c, w.item)).toBe(1);
    expect(c.prepare('SELECT status, voided_at, void_reason FROM stock_losses WHERE sales_return_id = ?').get(damaged)).toEqual({ status: 'void', voided_at: VOIDED, void_reason: 'r' });
    expect(scalar(c, 'SELECT COUNT(*) FROM stock_losses WHERE status = ?', 'posted')).toBe(0);
    voidRet(c, resalable);
    expect(returned(c, w.item)).toBe(0);
    // invariant returned_qty = sum of posted return lines, for every line
    expect(scalar(c, `SELECT COUNT(*) FROM sale_items si WHERE si.returned_qty <> COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri
      JOIN sales_returns r ON r.id = ri.sales_return_id WHERE ri.sale_item_id = si.id AND r.status = 'posted'), 0)`)).toBe(0);
  });

  it('a manual decrease of returned_qty is refused unless it lands exactly on the posted sum; frozen columns stay frozen', () => {
    const c = memDb(conns);
    const w = world(c);
    w.ret(1);
    w.ret(1);
    expect(msgOf(() => upd(c, 'sale_items', 'returned_qty', 0, w.item))).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(msgOf(() => upd(c, 'sale_items', 'returned_qty', 1, w.item))).toMatch(/SALE_ITEM_IMMUTABLE/);   // sum of posted is 2
    for (const [col, val] of [['qty', 9], ['revenue_cents', 5], ['cogs_cents', 5], ['unit_cost_cents', 5], ['unit_price_cents', 5], ['description', 'x'], ['extra_cost_cents', 1]] as const) {
      expect(msgOf(() => upd(c, 'sale_items', col, val, w.item)), col).toMatch(/SALE_ITEM_IMMUTABLE|CHECK constraint failed/);
    }
    expect(returned(c, w.item)).toBe(2);
  });

  it('after a void the backstops count posted returns only: units and C13 extra cost can be returned again, never more than sold / carried', () => {
    const c = memDb(conns);
    const w = world(c, 50);                                      // line: 3 units, extra cost 50
    const r1 = w.ret(2, '2025-04-03', { extra: 40 });
    const sale = w.sale;
    // a third unit with extra 11 would exceed 50 (40 + 11): refused while r1 is posted
    const tryRet = (qty: number, extra: number, ref: string) => {
      const id = sqlReturn(c, sale, { date: '2025-04-04', refund: 1, cogs: 1, extra, ref });
      sqlReturnItem(c, id, w.item, qty, { revenue: 1, cogs: 1, extra });
    };
    expect(msgOf(() => tryRet(1, 11, 'try-a'))).toMatch(/RETURN_EXCEEDS_EXTRA_COST/);
    expect(msgOf(() => tryRet(2, 1, 'try-b'))).toMatch(/RETURN_EXCEEDS_SOLD/);        // only 1 unit left (returned_qty 2 of 3)
    voidRet(c, r1);
    expect(returned(c, w.item)).toBe(0);
    c.exec('SAVEPOINT s');
    tryRet(3, 50, 'try-c');                                      // all 3 units and all 50 extra: allowed again
    c.exec('ROLLBACK TO s');
    expect(msgOf(() => tryRet(4, 1, 'try-d'))).toMatch(/RETURN_EXCEEDS_SOLD/);
  });
});

describe('reversal rows of a return void', () => {
  it('movements out and refund-reversal cash entries cannot exist for a POSTED return', () => {
    const c = memDb(conns);
    const w = world(c);
    const id = w.ret(1);
    const mv = (type: string, qty: number, value: number) => c.prepare(
      "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (?, '2025-04-03', ?, ?, ?, 'sales_returns', ?, 'x')").run(w.p, type, qty, value, id);
    expect(msgOf(() => mv('sale_return', -1, -1000))).toMatch(/RETURN_NOT_VOID/);
    expect(msgOf(() => mv('adjustment', 0, -10))).toMatch(/RETURN_NOT_VOID/);
    const cash = (amount: number, link: number | null) => c.prepare(
      "INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', '2025-04-03', 'sale_refund', ?, 'sales_returns', ?, ?)").run(amount, id, link);
    const orig = scalar(c, "SELECT id FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ?", id);
    expect(msgOf(() => cash(100000, orig))).toMatch(/RETURN_REVERSAL_INVALID/);
    expect(msgOf(() => cash(100000, null))).toMatch(/RETURN_REVERSAL_INVALID/);
    // the restock itself (positive qty) and the refund itself (negative cash) are of course fine - they are how a return is written
    expect(scalar(c, "SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'sales_returns'")).toBe(1);
  });

  it('reversal rows: one reversal up to the restocked quantity; a second one exceeds it; a refund entry is reversed once (unique link); the link must match; nothing is accepted after the void', () => {
    const c = memDb(conns);
    const w = world(c);
    const id = w.ret(1);
    issueStock(c, { productId: w.p, businessDate: '2025-04-03', type: 'sale', qty: 10, refTable: null, refId: null, reason: 'drain' }); // pool = the returned unit: 1 / 1,000
    const restock = scalar(c, "SELECT id FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = ? AND qty_delta > 0", id);
    const mv = (qty: number, value: number, type = 'sale_return', link: number | null = type === 'sale_return' ? restock : null) => c.prepare(
      "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason, reverses_movement_id) VALUES (?, '2025-04-03', ?, ?, ?, 'sales_returns', ?, 'x', ?)").run(w.p, type, qty, value, id, link);
    mv(0, -10, 'adjustment');                                    // the value-only sweep (the pool holds exactly the units about to leave)
    mv(-1, -990);                                                // takes the one restocked unit out
    expect(msgOf(() => mv(-1, -10))).toMatch(/RETURN_REVERSAL_EXCEEDS/);
    expect(pool(c, w.p)).toEqual({ qty: 0, value: 0 });          // 1/1,000 - sweep 10 - unit 990
    const orig = scalar(c, "SELECT id FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? AND amount_cents < 0", id);
    const cash = (amount: number, link: number | null, date = '2025-04-03') => c.prepare(
      "INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', ?, 'sale_refund', ?, 'sales_returns', ?, ?)").run(date, amount, id, link);
    expect(msgOf(() => cash(100000, null))).toMatch(/RETURN_REVERSAL_INVALID/);          // no link
    expect(msgOf(() => cash(99999, orig))).toMatch(/RETURN_REVERSAL_INVALID/);           // wrong amount
    expect(msgOf(() => cash(100000, orig, '2025-04-04'))).toMatch(/RETURN_REVERSAL_INVALID/); // not the return's date
    cash(100000, orig);
    expect(msgOf(() => cash(100000, orig))).toMatch(/UNIQUE constraint failed/);         // the same refund can be reversed only once
    expect(scalar(c, "SELECT COUNT(*) FROM cash_entries WHERE ref_table = 'sales_returns' AND amount_cents > 0")).toBe(1);
    voidRet(c, id);                                              // every reversal exists: the flip passes
    expect(msgOf(() => cash(100000, orig))).toMatch(/UNIQUE constraint failed|RETURN_REVERSAL_INVALID/);
    expect(msgOf(() => mv(-1, -10))).toMatch(/RETURN_REVERSAL_EXCEEDS/);
    expect(msgOf(() => mv(0, -3, 'adjustment'))).toMatch(/UNIQUE|RETURN_NOT_VOID/);
  });

  it('the append-only ledgers and the delete guards are untouched', () => {
    const c = memDb(conns);
    const w = world(c);
    const id = w.ret(1);
    const dmg = w.ret(1, '2025-04-04', { damaged: true });
    voidRet(c, dmg);
    voidRet(c, id);
    expect(msgOf(() => c.prepare('UPDATE cash_entries SET amount_cents = 1').run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM cash_entries').run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('UPDATE stock_movements SET qty_delta = 5').run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM stock_movements').run())).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM sale_items').run())).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(msgOf(() => c.prepare('DELETE FROM sales').run())).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(msgOf(() => c.prepare('DELETE FROM stock_losses').run())).toMatch(/RECORD_DELETE_FORBIDDEN/);
  });
});
