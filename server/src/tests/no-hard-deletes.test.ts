/**
 * no-hard-deletes.test.ts - protects BUSINESS_RULES section 12: "No hard deletes of completed transactions".
 *
 * Migration 007 makes the database itself refuse DELETE on every business document (purchases, stock losses,
 * owner drawings, stocktakes, sales and their lines). Corrections are made by voiding, never by deleting.
 * The tests run on a throw-away in-memory database, bypassing the application, to prove the database - not just
 * the service code - is the last line of defence.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.ts';

/** A fresh, fully migrated in-memory database with foreign keys on, like the real application connection. */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Runs `fn` and returns the error message it threw ('' when it did not throw). */
function messageOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('migration 007: business documents can never be hard-deleted', () => {
  it('refuses DELETE on every protected table with RECORD_DELETE_FORBIDDEN', () => {
    const db = freshDb();
    // The triggers fire BEFORE DELETE for any row, so deleting with a WHERE that matches nothing would not fire
    // them. We insert minimal valid rows first (a product, a purchase with a line, a sale with a line, ...).
    db.exec(`
      INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents)
        VALUES ('Cover', 1, 'stock', 'shop', 1000, 900);
      INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES ('2026-11-01', 'shop', 1000, 'pur-ref-0001');
      INSERT INTO purchase_items (purchase_id, product_id, packs, pack_size, units, line_total_cents)
        VALUES (1, 1, 1, 10, 10, 1000);
      INSERT INTO stocktakes (business_date, book, client_ref) VALUES ('2026-11-01', 'shop', 'st-ref-00001');
      INSERT INTO sales (business_date, book, total_cents, client_ref) VALUES ('2026-11-01', 'shop', 2000, 'sale-ref-0001');
      INSERT INTO sale_items (sale_id, line_no, line_type, product_id, description, qty, unit_price_cents,
                              unit_cost_cents, revenue_cents, cogs_cents)
        VALUES (1, 1, 'goods', 1, 'Cover', 2, 1000, 100, 2000, 200);
    `);
    // A loss and a drawing need stock to exist first: put 10 units in through a movement (the cache trigger
    // updates the product).
    db.exec(`
      INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason)
        VALUES (1, '2026-11-01', 'purchase', 10, 1000, 'seed');
      INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, client_ref)
        VALUES ('2026-11-01', 1, 'shop', 1, 100, 'damaged', 'loss-ref-0001');
      INSERT INTO owner_drawings (business_date, book, kind, amount_cents, product_id, qty, client_ref)
        VALUES ('2026-11-01', 'shop', 'goods', 100, 1, 1, 'draw-ref-0001');
    `);

    for (const table of ['purchase_items', 'purchases', 'stocktakes', 'stock_losses', 'owner_drawings',
      'sale_items', 'sales']) {
      expect(messageOf(() => db.prepare(`DELETE FROM ${table}`).run()), table).toMatch(/RECORD_DELETE_FORBIDDEN/);
    }
    // Nothing was removed.
    for (const table of ['purchases', 'purchase_items', 'stocktakes', 'stock_losses', 'owner_drawings', 'sales',
      'sale_items']) {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint };
      expect(Number(row.n), table).toBe(1);
    }
    db.close();
  });

  it('still allows replacing the lines of a DRAFT stocktake (the count sheet is rewritten as a whole)', () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents)
        VALUES ('Cover', 1, 'stock', 'shop', 1000, 900);
      INSERT INTO stocktakes (business_date, book, client_ref) VALUES ('2026-11-01', 'shop', 'st-ref-00001');
      INSERT INTO stocktake_items (stocktake_id, product_id, counted_qty) VALUES (1, 1, 5);
    `);
    // A draft's lines may be deleted and re-inserted (migration 005 only freezes them once the stocktake is
    // completed or void); migration 007 must not have broken that.
    expect(messageOf(() => db.prepare('DELETE FROM stocktake_items WHERE stocktake_id = 1').run())).toBe('');
    db.close();
  });
});
