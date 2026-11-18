// Telecom segments: migrations 024 / 025 / 026 on the FROZEN populated schema-23 database (fixtures/schema23-world.db, built from the Phase 14 world
// plus extra Telecom activity by fixtures/make-schema23-fixture.ts BEFORE any of these migrations existed).
// Proves: every pre-existing row of every table is identical except the new columns; all Telecom rows 'legacy', Shop / Ice Cream rows NULL; the trigger /
// index / view set is exactly the old set plus the documented new objects (and only the documented ones changed text); foreign_key_check and
// integrity_check are clean; the Telecom balance and every figure of the old Telecom book are unchanged; the guards abort a corrupted copy; the
// append-only trigger of cash_entries is re-created byte-identically; the generator still produces exactly the committed migration files.

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { MIGRATIONS_DIR, loadMigrations, migrate as migrateAll } from '../db/migrate.ts';
import { generate024, generate025, generate026 } from '../db/gen/telecom-segments-sql.ts';
import { all, one } from './helpers/phase26db.ts';

const env = new TestEnv();
// Migrations 027/028 (sales discounts) came later: this file proves 024-026 on the schema-23 fixture, so it migrates only up to 026
// (phase27-migration.test.ts covers 027/028).
function upTo26(): string {
  const dir = env.newDir();
  for (const f of loadMigrations().filter((m) => m.version <= 26)) writeFileSync(join(dir, f.name), f.sql);
  return dir;
}
const migrate = (c: DatabaseSync, dir: string = upTo26()) => migrateAll(c, dir);
const open: DatabaseSync[] = [];
// every connection is closed BEFORE the temp folders are removed (Windows cannot delete an open database file)
afterEach(async () => { for (const c of open.splice(0)) { try { c.close(); } catch { /* already closed */ } } await env.cleanup(); });
const FIXTURE = join(import.meta.dirname, 'fixtures', 'schema23-world.db');
const FIGURES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.figures.json'), 'utf8'));

type Master = { type: string; name: string; tbl_name: string; sql: string | null };
const master = (c: DatabaseSync): Master[] =>
  all(c, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name") as unknown as Master[];
const tablesOf = (c: DatabaseSync): string[] => all(c, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
const cols = (c: DatabaseSync, t: string): string[] => all(c, `PRAGMA table_info("${t}")`).map((r) => String(r.name));
const dump = (c: DatabaseSync, t: string): Array<Record<string, unknown>> => all(c, `SELECT * FROM "${t}" ORDER BY rowid`);
const seq = (c: DatabaseSync): Record<string, number> => Object.fromEntries(all(c, 'SELECT name, seq FROM sqlite_sequence').map((r) => [String(r.name), Number(r.seq)]));

function openCopy(): DatabaseSync {
  const file = join(env.newDir(), 'world.db');
  copyFileSync(FIXTURE, file);
  const c = new DatabaseSync(file);
  open.push(c);
  c.exec('PRAGMA foreign_keys = ON');
  return c;
}

// ---- what the three migrations add / change (written out by hand, NOT read from the generator) -------------------------------------------------
const STORED_TABLES = ['cash_entries', 'cash_counts', 'capital_entries', 'owner_drawings', 'expenses', 'purchases', 'stock_losses', 'stocktakes', 'reload_sales', 'ezcash_sales', 'telecom_topups'];
const NEW_TRIGGERS = [
  ...STORED_TABLES.flatMap((t) => [`trg_${t}_segment_insert`, `trg_${t}_segment_immutable`]),
  'trg_categories_provider_insert', 'trg_categories_provider_update', 'trg_products_needs_provider', 'trg_products_segment_locked',
  'trg_daily_closings_segment_insert', 'trg_daily_closings_segment_immutable', 'trg_cash_transfers_segment_insert', 'trg_cash_transfers_segment_immutable',
  'trg_sales_segment_insert', 'trg_sales_segment_immutable',
  'trg_cash_entries_segment_matches_ref', 'trg_reload_sales_segment_provider', 'trg_ezcash_sales_segment_provider', 'trg_telecom_topups_segment_provider',
  'trg_sale_items_segment_matches', 'trg_purchase_items_segment_matches', 'trg_stocktake_items_segment_matches', 'trg_stock_losses_segment_matches',
  'trg_owner_drawings_segment_matches_product',
].sort();
const NEW_INDEXES = ['idx_categories_provider', 'idx_cash_entries_book_segment_date', 'ux_daily_closings_scope_date', 'idx_daily_closings_book_date',
  'idx_daily_closings_book_segment_date', 'ux_sales_client_ref_scope'].sort();
const NEW_VIEWS = ['v_product_segment'];
/** The 32 closed-day triggers of 016 / 019 that 026 re-creates (same names), plus the two cash_entries triggers and the opening-balance index that gain a segment. */
const CLOSED_DAY = [
  'capital_entries', 'cash_counts', 'cash_transfers', 'expenses', 'ezcash_sales', 'owner_drawings', 'purchases', 'reload_sales', 'sales', 'sales_returns',
  'stock_losses', 'telecom_topups',
].flatMap((t) => [`trg_${t}_day_closed`, `trg_${t}_day_closed_void`]).concat([
  'trg_cash_entries_day_closed', 'trg_purchase_returns_day_closed', 'trg_stock_movements_day_closed',
  'trg_stocktakes_day_closed', 'trg_stocktakes_day_closed_complete', 'trg_stocktakes_day_closed_void',
  'trg_opening_stock_batches_day_closed', 'trg_opening_stock_batches_day_closed_void']);
const ALTERED = [...CLOSED_DAY, 'trg_cash_entries_reversal_mirror', 'trg_cash_entries_transfer_link', 'ux_capital_opening_balance'].sort();

/** The new columns of every table (name -> expected value rule). */
const NEW_COLUMNS: Record<string, string[]> = {
  cash_entries: ['segment'], cash_counts: ['segment'], capital_entries: ['segment'], owner_drawings: ['segment'], expenses: ['segment'], purchases: ['segment'],
  stock_losses: ['segment'], stocktakes: ['segment'], reload_sales: ['segment'], ezcash_sales: ['segment'], telecom_topups: ['segment'],
  daily_closings: ['segment'], sales: ['segment'], cash_transfers: ['from_segment', 'to_segment'], categories: ['provider_id'],
};

describe('migrations 024-026 on the frozen schema-23 world', () => {
  it('the fixture is a rich schema-23 database (it really has Telecom activity of every kind)', () => {
    const c = openCopy();
    expect(one(c, 'SELECT MAX(version) FROM schema_migrations')).toBe(23);
    const n = (sql: string) => Number(one(c, sql));
    expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'telecom'")).toBeGreaterThan(40);
    expect(n('SELECT COUNT(*) FROM reload_sales')).toBeGreaterThan(5);
    expect(n('SELECT COUNT(*) FROM ezcash_sales')).toBeGreaterThan(2);
    expect(n("SELECT COUNT(*) FROM telecom_topups WHERE kind = 'provider_topup'")).toBeGreaterThan(1);
    expect(n("SELECT COUNT(*) FROM telecom_topups WHERE kind = 'wallet_topup'")).toBeGreaterThan(1);
    expect(n("SELECT COUNT(*) FROM sales WHERE book = 'telecom' AND status = 'posted'")).toBeGreaterThan(3);
    expect(n("SELECT COUNT(*) FROM sales WHERE book = 'telecom' AND status = 'void'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM sales_returns r JOIN sales s ON s.id = r.sale_id WHERE s.book = 'telecom'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM purchases WHERE book = 'telecom'")).toBeGreaterThan(1);
    expect(n("SELECT COUNT(*) FROM purchases WHERE book = 'telecom' AND status = 'void'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM expenses WHERE book = 'telecom'")).toBeGreaterThan(3);
    expect(n("SELECT COUNT(*) FROM capital_entries WHERE book = 'telecom'")).toBeGreaterThan(1);
    expect(n("SELECT COUNT(*) FROM owner_drawings WHERE book = 'telecom'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM cash_transfers WHERE from_book = 'telecom' OR to_book = 'telecom'")).toBeGreaterThan(3);
    expect(n("SELECT COUNT(*) FROM cash_counts WHERE book = 'telecom'")).toBeGreaterThan(2);
    expect(n("SELECT COUNT(*) FROM daily_closings WHERE book = 'telecom'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM stocktakes WHERE book = 'telecom'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'shop'")).toBeGreaterThan(20);
    expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'icecream'")).toBeGreaterThan(5);
    c.close();
  });

  it('every pre-existing row of every table is identical except the new columns; Telecom rows are legacy, Shop / Ice Cream rows NULL; sequences, integrity and foreign keys intact', () => {
    const c = openCopy();
    const tables = tablesOf(c);
    const before = Object.fromEntries(tables.map((t) => [t, dump(c, t)]));
    const colsBefore = Object.fromEntries(tables.map((t) => [t, cols(c, t)]));
    const seqBefore = seq(c);
    const res = migrate(c);
    expect(res.applied).toEqual(['024_telecom_segments_columns.sql', '025_telecom_segments_rebuilds.sql', '026_telecom_segments_closed_day_and_consistency.sql']);
    expect(res.version).toBe(26);

    expect(tablesOf(c)).toEqual(tables);                                // no table added or removed
    for (const t of tables) {
      const add = NEW_COLUMNS[t] ?? [];
      const now = cols(c, t);
      expect([...now].sort(), `${t}: columns`).toEqual([...colsBefore[t]!, ...add].sort());
      let after = dump(c, t);
      if (t === 'schema_migrations') after = after.filter((r) => Number(r.version) <= 23);
      expect(after.length, `${t}: row count`).toBe(before[t]!.length);
      const projected = after.map((r) => Object.fromEntries(colsBefore[t]!.map((k) => [k, r[k]])));
      expect(projected, `${t}: every pre-existing value`).toEqual(before[t]);
      // the new columns
      for (let i = 0; i < after.length; i++) {
        const row = after[i]!;
        for (const k of add) {
          let want: unknown = null;
          if (k === 'segment') {
            if (['reload_sales', 'ezcash_sales', 'telecom_topups'].includes(t)) want = 'legacy';
            else want = row.book === 'telecom' ? 'legacy' : null;
          } else if (k === 'from_segment') want = row.from_book === 'telecom' ? 'legacy' : null;
          else if (k === 'to_segment') want = row.to_book === 'telecom' ? 'legacy' : null;
          expect(row[k], `${t} #${row.id} ${k}`).toBe(want);
        }
      }
    }
    // AUTOINCREMENT counters are exactly where they were (nothing else wrote); migration bookkeeping rows are the only addition
    expect(seq(c)).toEqual(seqBefore);
    expect(all(c, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version)).slice(-4)).toEqual([23, 24, 25, 26]);
    expect(all(c, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(c, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    // no leftover temp tables of the migrations
    expect(all(c, "SELECT name FROM sqlite_temp_master WHERE name LIKE '\\_mig02%' ESCAPE '\\'")).toEqual([]);
    c.close();
  });

  it('the trigger / index / view set is exactly the old set plus the documented new objects; only the documented objects changed text', () => {
    const c = openCopy();
    const pre = master(c);
    migrate(c);
    const post = master(c);
    const key = (m: Master) => `${m.type}:${m.name}`;
    const preBy = new Map(pre.map((m) => [key(m), m]));
    const postBy = new Map(post.map((m) => [key(m), m]));
    // nothing removed
    for (const m of pre) expect(postBy.has(key(m)), `${key(m)} must survive`).toBe(true);
    // added: exactly the documented set
    const added = post.filter((m) => !preBy.has(key(m)));
    expect(added.filter((m) => m.type === 'trigger').map((m) => m.name).sort()).toEqual(NEW_TRIGGERS);
    expect(added.filter((m) => m.type === 'index').map((m) => m.name).sort()).toEqual(NEW_INDEXES);
    expect(added.filter((m) => m.type === 'view').map((m) => m.name)).toEqual(NEW_VIEWS);
    expect(added.filter((m) => m.type === 'table')).toEqual([]);
    expect(NEW_TRIGGERS.length).toBe(41);
    // changed: exactly the documented set (rebuilt tables carry new DDL; everything else is byte-identical)
    const rebuilt = new Set(['daily_closings', 'cash_transfers', 'sales']);
    const touchedTables = new Set([...STORED_TABLES, 'categories', ...rebuilt]);
    const changed = pre.filter((m) => postBy.get(key(m))!.sql !== m.sql);
    expect(changed.filter((m) => m.type !== 'table').map((m) => m.name).sort(), 'changed triggers / indexes').toEqual(ALTERED);
    expect(changed.filter((m) => m.type === 'table').map((m) => m.name).sort(), 'changed tables').toEqual([...touchedTables].sort());
    // the objects of rebuilt tables are all there with the old text (except the altered ones)
    for (const m of pre.filter((x) => x.type !== 'table' && rebuilt.has(x.tbl_name) && !ALTERED.includes(x.name))) expect(postBy.get(key(m))!.sql, m.name).toBe(m.sql);
    // the untouched families keep their text: print, ice cream, audit, backups, imports ...
    for (const m of pre.filter((x) => /^(print|icecream|audit|external_backup|import_|backup)/.test(x.tbl_name))) expect(postBy.get(key(m))!.sql, m.name).toBe(m.sql);
    c.close();
  });

  it('trg_cash_entries_no_update is re-created byte-identically (sqlite_master.sql before == after) and still blocks every UPDATE', () => {
    const c = openCopy();
    const sql = (): string => String(one(c, "SELECT sql FROM sqlite_master WHERE name = 'trg_cash_entries_no_update'"));
    const before = sql();
    expect(before).toContain('cash_entries is append-only');
    migrate(c);
    expect(sql()).toBe(before);
    expect(() => c.prepare('UPDATE cash_entries SET note = ? WHERE id = (SELECT MIN(id) FROM cash_entries)').run('x')).toThrow(/append-only/);
    expect(() => c.prepare('UPDATE cash_entries SET amount_cents = amount_cents + 1 WHERE book = ?').run('telecom')).toThrow(/append-only/);
    c.close();
  });

  it('the Telecom legacy balance equals the old Telecom balance; Shop and Ice Cream balances and every figure the old system reported are unchanged', () => {
    const c = openCopy();
    migrate(c);
    const books = Object.fromEntries((FIGURES.cashbooks.books as Array<{ book: string; balanceCents: number }>).map((b) => [b.book, b.balanceCents]));
    const bal = (where: string): number => Number(one(c, `SELECT COALESCE(SUM(amount_cents), 0) FROM cash_entries WHERE ${where}`));
    expect(bal("book = 'telecom' AND segment = 'legacy'")).toBe(books.telecom);
    expect(bal("book = 'telecom'")).toBe(books.telecom);
    expect(bal("book = 'shop' AND segment IS NULL")).toBe(books.shop);
    expect(bal("book = 'icecream' AND segment IS NULL")).toBe(books.icecream);
    expect(bal('1 = 1')).toBe(FIGURES.dashboard.cash.totalCents);
    // the Telecom P&L inputs, recomputed by SQL on the legacy rows, equal what the old report returned
    const t = FIGURES.pnlTelecom.totals;
    expect(Number(one(c, "SELECT SUM(sales_cents) FROM reload_sales WHERE status = 'posted' AND segment = 'legacy'"))).toBe(t.commissions.reloadSalesCents);
    expect(Number(one(c, "SELECT SUM(commission_cents) FROM reload_sales WHERE status = 'posted' AND segment = 'legacy'"))).toBe(t.commissions.reloadCommissionCents);
    expect(Number(one(c, "SELECT SUM(bill_total_cents) FROM ezcash_sales WHERE status = 'posted' AND segment = 'legacy'"))).toBe(t.commissions.ezcashBillCents);
    expect(Number(one(c, "SELECT SUM(commission_cents) FROM ezcash_sales WHERE status = 'posted' AND segment = 'legacy'"))).toBe(t.commissions.ezcashCommissionCents);
    expect(Number(one(c, "SELECT SUM(amount_cents) FROM expenses WHERE status = 'posted' AND book = 'telecom' AND segment = 'legacy'"))).toBe(t.expenses.totalCents);
    expect(Number(one(c, "SELECT SUM(amount_cents) FROM telecom_topups WHERE status = 'posted' AND kind = 'provider_topup' AND segment = 'legacy'"))).toBe(t.memo.providerTopupsCents);
    expect(Number(one(c, "SELECT SUM(amount_cents) FROM telecom_topups WHERE status = 'posted' AND kind = 'wallet_topup' AND segment = 'legacy'"))).toBe(t.memo.walletTopupsCents);
    expect(Number(one(c, "SELECT SUM(total_cents) FROM sales WHERE status = 'posted' AND book = 'telecom' AND segment = 'legacy'"))).toBe(t.cards.salesCents);
    // valuation / dashboard stock: untouched by construction, re-checked from the product table
    expect(Number(one(c, 'SELECT SUM(stock_value_cents) FROM products'))).toBe(FIGURES.valuation.totals.valueCents);
    expect(Number(one(c, 'SELECT SUM(qty_on_hand) FROM products'))).toBe(FIGURES.valuation.totals.qty);
    expect(FIGURES.dashboard.stock.valueCents).toBe(FIGURES.valuation.totals.valueCents);
    c.close();
  });

  it('the upgraded database accepts new segment rows and keeps the legacy history readable through the view', () => {
    const c = openCopy();
    migrate(c);
    expect(all(c, "SELECT DISTINCT segment FROM v_product_segment WHERE book = 'telecom'").map((r) => r.segment)).toEqual(['legacy']);
    expect(all(c, "SELECT DISTINCT segment FROM v_product_segment WHERE book = 'shop'").map((r) => r.segment)).toEqual([null]);
    expect(Number(one(c, 'SELECT COUNT(*) FROM v_product_segment'))).toBe(Number(one(c, 'SELECT COUNT(*) FROM products')));
    // a fresh Telecom row is accepted in a real segment on a date after the legacy closing
    c.prepare("INSERT INTO expenses (business_date, book, segment, category, amount_cents, description, client_ref) VALUES ('2025-09-14', 'telecom', 'dialog_reloads', 'other', 1, 'x', 'new-1')").run();
    c.prepare("INSERT INTO daily_closings (book, segment, business_date, expected_cents) VALUES ('telecom', 'dialog_reloads', '2025-09-14', 0)").run();
    // the legacy closing of 2025-09-13 still blocks legacy records but no longer a real segment
    expect(() => c.prepare("INSERT INTO expenses (business_date, book, segment, category, amount_cents, description, client_ref) VALUES ('2025-09-13', 'telecom', 'dialog_reloads', 'other', 1, 'x', 'new-2')").run()).toThrow(/BACKDATE_BEFORE_CLOSED_DAY/); // the NEW closing of 09-14
    c.close();
  });

  it('running the migrations again applies nothing', () => {
    const c = openCopy();
    migrate(c);
    expect(migrate(c).applied).toEqual([]);
    c.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the in-migration guards abort the whole migration (nothing half-applied) on a corrupted copy or a sabotaged file', () => {
  /** A temp copy of the migrations folder with one file's text changed. */
  function patchedDir(file: string, patch: (sql: string) => string): string {
    const dir = env.newDir();
    for (const f of loadMigrations().filter((m) => m.version <= 26)) writeFileSync(join(dir, f.name), f.name === file ? patch(f.sql) : f.sql);
    expect(readFileSync(join(dir, file), 'utf8')).not.toBe(loadMigrations().find((f) => f.name === file)!.sql); // the patch really changed something
    return dir;
  }
  const versionOf = (c: DatabaseSync): number => Number(one(c, 'SELECT MAX(version) FROM schema_migrations'));

  it('024: a pre-existing broken foreign key (orphan) aborts it; the database stays at version 23, byte-for-byte the same schema', () => {
    const c = openCopy();
    c.exec('PRAGMA foreign_keys = OFF');
    c.exec("INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, note, cash_entry_id, client_ref, status) VALUES ('shop', '2025-12-30', 0, 1, 1, 'x', 999999, 'orphan', 'posted')");
    c.exec('PRAGMA foreign_keys = ON');
    expect(all(c, 'PRAGMA foreign_key_check').length).toBe(1);
    const pre = master(c);
    expect(() => migrate(c)).toThrow(/Migration 024_telecom_segments_columns.sql failed/);
    expect(versionOf(c)).toBe(23);
    expect(master(c)).toEqual(pre);
    expect(cols(c, 'cash_entries')).not.toContain('segment');
    expect(all(c, "SELECT name FROM sqlite_temp_master WHERE name LIKE '\\_mig02%' ESCAPE '\\'")).toEqual([]);
    c.close();
  });

  it('024: a backfill that misses a Telecom table is caught by the guard', () => {
    const dir = patchedDir('024_telecom_segments_columns.sql', (s) => s.replace("UPDATE reload_sales SET segment = 'legacy';\n", ''));
    const c = openCopy();
    expect(() => migrate(c, dir)).toThrow(/Migration 024.* failed: .*ok = 1/);
    expect(versionOf(c)).toBe(23);
    expect(cols(c, 'reload_sales')).not.toContain('segment');
    expect(String(one(c, "SELECT sql FROM sqlite_master WHERE name = 'trg_cash_entries_no_update'"))).toContain('append-only'); // the dropped trigger came back with the rollback
    c.close();
  });

  it('024: a no_update trigger that is re-created with different text is caught by the guard', () => {
    const dir = patchedDir('024_telecom_segments_columns.sql', (s) => s.replace("RAISE(ABORT, 'cash_entries is append-only')", "RAISE(ABORT, 'cash_entries is append-only!')"));
    const c = openCopy();
    expect(() => migrate(c, dir)).toThrow(/Migration 024.* failed: .*ok = 1/);
    expect(versionOf(c)).toBe(23);
    c.close();
  });

  it('025: a row lost in the copy aborts it (guard), leaving version 24 and the old daily_closings table', () => {
    const dir = patchedDir('025_telecom_segments_rebuilds.sql', (s) => s.replace('FROM _mig025_daily_closings ORDER BY id;', 'FROM _mig025_daily_closings WHERE id > 1 ORDER BY id;'));
    const c = openCopy();
    const before = dump(c, 'daily_closings');
    expect(() => migrate(c, dir)).toThrow(/Migration 025.* failed: .*ok = 1/);
    expect(versionOf(c)).toBe(24);
    expect(cols(c, 'daily_closings')).not.toContain('segment');
    expect(dump(c, 'daily_closings')).toEqual(before);
    expect(all(c, 'PRAGMA foreign_key_check')).toEqual([]);
    c.close();
  });

  it('025: a changed value in the copy (wrong legacy marker) aborts it', () => {
    const dir = patchedDir('025_telecom_segments_rebuilds.sql', (s) => s.replace("cash_count_id, CASE WHEN book = 'telecom' THEN 'legacy' END FROM _mig025_daily_closings", "cash_count_id, CASE WHEN book = 'telecom' THEN 'dialog_cards' END FROM _mig025_daily_closings"));
    const c = openCopy();
    expect(() => migrate(c, dir)).toThrow(/Migration 025.* failed: .*ok = 1/);
    expect(versionOf(c)).toBe(24);
    c.close();
  });

  it('025: a table copied back with its ids changed breaks foreign keys and aborts it', () => {
    const dir = patchedDir('025_telecom_segments_rebuilds.sql', (s) => s.replace('INSERT INTO sales (id, business_date,', 'INSERT INTO sales (id, business_date,').replace('SELECT id, business_date, posted_at, book, total_cents, status, notes, client_ref, voided_at, void_reason, CASE WHEN book', 'SELECT id + 1000, business_date, posted_at, book, total_cents, status, notes, client_ref, voided_at, void_reason, CASE WHEN book'));
    const c = openCopy();
    expect(() => migrate(c, dir)).toThrow(/Migration 025.* failed/);
    expect(versionOf(c)).toBe(24);
    expect(cols(c, 'sales')).not.toContain('segment');
    c.close();
  });

  it('025: a trigger that is not re-created is caught by the set check', () => {
    const dir = patchedDir('025_telecom_segments_rebuilds.sql', (s) => s.replace(/CREATE TRIGGER trg_sales_no_delete[\s\S]*?\nEND;\n/, ''));
    const c = openCopy();
    expect(() => migrate(c, dir)).toThrow(/Migration 025.* failed: .*ok = 1/);
    expect(versionOf(c)).toBe(24);
    c.close();
  });

  it('026: a closed-day trigger that is not re-created is caught by the set check', () => {
    const dir = patchedDir('026_telecom_segments_closed_day_and_consistency.sql', (s) => s.replace(/CREATE TRIGGER trg_expenses_day_closed_void[\s\S]*?\nEND;\n/, ''));
    const c = openCopy();
    expect(() => migrate(c, dir)).toThrow(/Migration 026.* failed: .*ok = 1/);
    expect(versionOf(c)).toBe(25);
    expect(String(one(c, "SELECT sql FROM sqlite_master WHERE name = 'trg_expenses_day_closed_void'"))).not.toContain('d.segment'); // rolled back: still the 019 text
    c.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the migration files are exactly what the generator writes (committed once, checksummed, never hand-edited)', () => {
  const norm = (s: string): string => s.replaceAll('\r\n', '\n');
  const onDisk = (name: string): string => norm(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  it('024', () => { expect(onDisk('024_telecom_segments_columns.sql')).toBe(norm(generate024())); });
  it('025 (verbatim re-creation of the schema-23 triggers and indexes of the rebuilt tables, read from the frozen fixture)', () => { expect(onDisk('025_telecom_segments_rebuilds.sql')).toBe(norm(generate025())); });
  it('026', () => { expect(onDisk('026_telecom_segments_closed_day_and_consistency.sql')).toBe(norm(generate026())); });
  it('the generator is deterministic (two runs, identical text)', () => {
    expect(generate024()).toBe(generate024());
    expect(generate026()).toBe(generate026());
  });
  it('025: the old trigger texts are really the schema-23 texts (compare with the fixture, character by character)', () => {
    const c = openCopy();
    const sql025 = onDisk('025_telecom_segments_rebuilds.sql');
    const keep = master(c).filter((m) => m.type !== 'table' && ['daily_closings', 'cash_transfers', 'sales'].includes(m.tbl_name) && m.sql !== null);
    expect(keep.length).toBeGreaterThan(25);
    for (const m of keep) expect(sql025.includes(norm(m.sql!)), `${m.name} is copied verbatim`).toBe(true);
    c.close();
  });
});
