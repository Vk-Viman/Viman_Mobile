/**
 * db/gen/telecom-segments-sql.ts - generator of migrations 024, 025 and 026 (Telecom segments).
 *
 * The three migrations contain a lot of repetitive trigger SQL (one rule per table). This script writes it so the repetition is exact.
 * The generated .sql files are COMMITTED and then never edited (migrations are checksummed); the test phase26-segment-migration.test.ts
 * proves that this script still produces exactly the committed text. Run from the repository root:
 *   node server/src/db/gen/telecom-segments-sql.ts            (rewrites 024, 025, 026 - only for a migration that is not released yet)
 * 025 re-creates the triggers and indexes of three rebuilt tables VERBATIM, so it reads them from the frozen schema-23 fixture database
 * (server/src/tests/fixtures/schema23-world.db), the only authoritative copy of the schema-23 text.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');
export const FIXTURE_DB = join(here, '..', '..', 'tests', 'fixtures', 'schema23-world.db');

export const TELECOM_SEGMENTS = [
  'dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads',
] as const;
const CARDS = TELECOM_SEGMENTS.filter((s) => s.endsWith('_cards'));
const RELOADS = TELECOM_SEGMENTS.filter((s) => s.endsWith('_reloads'));
const q = (a: readonly string[]): string => a.map((s) => `'${s}'`).join(', ');
const DOMAIN_ALL = `segment IS NULL OR segment IN (${q([...TELECOM_SEGMENTS, 'legacy'])})`;
const DOMAIN_CARDS = `segment IS NULL OR segment IN (${q([...CARDS, 'legacy'])})`;
const DOMAIN_RELOADS = `segment IS NULL OR segment IN (${q([...RELOADS, 'legacy'])})`;
export { DOMAIN_ALL, DOMAIN_CARDS, DOMAIN_RELOADS };

/** Tables that get a stored `segment` column by ADD COLUMN in 024: [table, has a `book` column, domain]. */
export const ADD_COLUMN_TABLES: Array<[string, boolean, string]> = [
  ['cash_entries', true, DOMAIN_ALL],
  ['cash_counts', true, DOMAIN_ALL],
  ['capital_entries', true, DOMAIN_ALL],
  ['owner_drawings', true, DOMAIN_ALL],
  ['expenses', true, DOMAIN_ALL],
  ['purchases', true, DOMAIN_CARDS],
  ['stock_losses', true, DOMAIN_CARDS],
  ['stocktakes', true, DOMAIN_CARDS],
  ['reload_sales', false, DOMAIN_RELOADS],
  ['ezcash_sales', false, DOMAIN_RELOADS],
  ['telecom_topups', false, DOMAIN_RELOADS],
];

const HEAD = (file: string, text: string): string => `-- ${file}\n${text.trim().split('\n').map((l) => (l ? `-- ${l}` : '--')).join('\n')}\n\n`;

function schema23(db: DatabaseSync, name: string): string {
  const r = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined;
  if (!r) throw new Error(`schema-23 object ${name} not found in the fixture`);
  return r.sql;
}

// ===================================================================================================================================
// 024
// ===================================================================================================================================

/** The CASE of an INSERT rule trigger. A table with a book column: telecom rows need a segment, other rows must not have one. */
function insertRule(table: string, hasBook: boolean): string {
  if (table === 'cash_entries') {
    // legacy is allowed only on a reversal of a legacy entry, or on the refund entry of a return of a legacy sale/purchase
    return `CREATE TRIGGER trg_cash_entries_segment_insert
BEFORE INSERT ON cash_entries
WHEN (NEW.book = 'telecom') <> (NEW.segment IS NOT NULL)
  OR (NEW.segment = 'legacy' AND NOT (
        (NEW.reverses_entry_id IS NOT NULL AND (SELECT o.segment FROM cash_entries o WHERE o.id = NEW.reverses_entry_id) IS 'legacy')
     OR (NEW.ref_table = 'sales_returns' AND EXISTS (SELECT 1 FROM sales_returns r JOIN sales s ON s.id = r.sale_id
                                                      WHERE r.id = NEW.ref_id AND s.segment IS 'legacy'))
     OR (NEW.ref_table = 'purchase_returns' AND EXISTS (SELECT 1 FROM purchase_returns r JOIN purchases p ON p.id = r.purchase_id
                                                         WHERE r.id = NEW.ref_id AND p.segment IS 'legacy'))))
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.segment = 'legacy' THEN 'SEGMENT_LEGACY_REFUSED'
                           WHEN NEW.segment IS NULL THEN 'SEGMENT_REQUIRED' ELSE 'SEGMENT_NOT_ALLOWED' END);
END;`;
  }
  if (table === 'stock_losses') {
    // the damaged-return loss of a return of a legacy sale is a follow-up of a legacy record, so it stays legacy
    return `CREATE TRIGGER trg_stock_losses_segment_insert
BEFORE INSERT ON stock_losses
WHEN (NEW.book = 'telecom') <> (NEW.segment IS NOT NULL)
  OR (NEW.segment = 'legacy' AND NOT (NEW.source = 'damaged_return' AND EXISTS (
        SELECT 1 FROM sales_returns r JOIN sales s ON s.id = r.sale_id WHERE r.id = NEW.sales_return_id AND s.segment IS 'legacy')))
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.segment = 'legacy' THEN 'SEGMENT_LEGACY_REFUSED'
                           WHEN NEW.segment IS NULL THEN 'SEGMENT_REQUIRED' ELSE 'SEGMENT_NOT_ALLOWED' END);
END;`;
  }
  if (hasBook) {
    return `CREATE TRIGGER trg_${table}_segment_insert
BEFORE INSERT ON ${table}
WHEN (NEW.book = 'telecom') <> (NEW.segment IS NOT NULL) OR NEW.segment = 'legacy'
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.segment = 'legacy' THEN 'SEGMENT_LEGACY_REFUSED'
                           WHEN NEW.segment IS NULL THEN 'SEGMENT_REQUIRED' ELSE 'SEGMENT_NOT_ALLOWED' END);
END;`;
  }
  return `CREATE TRIGGER trg_${table}_segment_insert
BEFORE INSERT ON ${table}
WHEN NEW.segment IS NULL OR NEW.segment = 'legacy'
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.segment IS NULL THEN 'SEGMENT_REQUIRED' ELSE 'SEGMENT_LEGACY_REFUSED' END);
END;`;
}

const immutableRule = (table: string): string => `CREATE TRIGGER trg_${table}_segment_immutable
BEFORE UPDATE OF segment ON ${table}
WHEN NEW.segment IS NOT OLD.segment
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_READ_ONLY');
END;`;

/** New objects of 024 (names), used by the in-migration guard and by the tests. */
export function names024(): { indexes: string[]; triggers: string[]; views: string[] } {
  const triggers: string[] = [];
  for (const [t] of ADD_COLUMN_TABLES) triggers.push(`trg_${t}_segment_insert`, `trg_${t}_segment_immutable`);
  triggers.push(
    'trg_categories_provider_insert', 'trg_categories_provider_update', 'trg_products_needs_provider', 'trg_products_segment_locked');
  return { indexes: ['idx_categories_provider', 'idx_cash_entries_book_segment_date'], triggers, views: ['v_product_segment'] };
}

export function generate024(): string {
  const db = new DatabaseSync(FIXTURE_DB, { readOnly: true });
  try {
    const noUpdate = schema23(db, 'trg_cash_entries_no_update');
    const mirror = schema23(db, 'trg_cash_entries_reversal_mirror');
    const mirror2 = mirror.replace('AND o.book = NEW.book AND o.fund IS NEW.fund AND o.business_date = NEW.business_date)',
      'AND o.book = NEW.book AND o.segment IS NEW.segment AND o.fund IS NEW.fund AND o.business_date = NEW.business_date)');
    if (mirror2 === mirror) throw new Error('mirror trigger text changed; update the generator');
    const n = names024();
    const tbls = ADD_COLUMN_TABLES.map(([t]) => t);
    let s = HEAD('024_telecom_segments_columns.sql', `
Telecom segments, part 1 of 3 (BUSINESS_RULES 13D, TELECOM_SEGMENTS_BUILD_PLAN.md). GENERATED by server/src/db/gen/telecom-segments-sql.ts; do not edit.
Telecom is split into 8 segments (dialog/mobitel/airtel/hutch x cards/reloads). This migration:
  1. adds a stored \`segment\` column (domain-checked) to the eleven tables that are not rebuilt, and categories.provider_id;
  2. creates the view v_product_segment(product_id, book, segment) (a product's segment comes from its category's provider);
  3. marks every existing Telecom row 'legacy' (Shop / Ice Cream rows stay NULL). Only the segment column is written; no money, date or
     status column is touched. cash_entries is append-only, so its no-update trigger is dropped around the backfill and re-created from
     its exact stored text (a test compares sqlite_master.sql before and after);
  4. makes the opening balance unique per scope (book + segment + fund);
  5. adds the INSERT-rule and immutability triggers, re-creates trg_cash_entries_reversal_mirror with the segment compared, and adds the
     category-provider / product triggers.
The rebuilt tables (daily_closings, cash_transfers, sales) are handled by 025; the closed-day triggers and the cross-table consistency
triggers by 026. The runner executes this file in one transaction with foreign_keys ON. Forward-only.
`);
    // ---- guard material taken BEFORE anything changes
    s += `CREATE TEMP TABLE _mig024_before (tbl TEXT NOT NULL, n INTEGER NOT NULL, ids INTEGER NOT NULL, money INTEGER NOT NULL);\n`;
    for (const t of tbls) {
      s += `INSERT INTO _mig024_before SELECT '${t}', COUNT(*), TOTAL(id), ${t === 'cash_entries' ? 'TOTAL(amount_cents)' : '0'} FROM ${t};\n`;
    }
    s += `CREATE TEMP TABLE _mig024_trg AS SELECT name, sql FROM sqlite_master WHERE name = 'trg_cash_entries_no_update';
CREATE TEMP TABLE _mig024_objs AS SELECT type, name FROM sqlite_master WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_autoindex%';

`;
    s += '-- 1. columns\n';
    for (const [t, , dom] of ADD_COLUMN_TABLES) s += `ALTER TABLE ${t} ADD COLUMN segment TEXT CHECK (${dom});\n`;
    s += `ALTER TABLE categories ADD COLUMN provider_id INTEGER REFERENCES reload_providers(id);\n\n`;
    s += `-- 2. the product -> segment view (Telecom: the category's provider + _cards, or 'legacy' while the category has no provider)
CREATE VIEW v_product_segment AS
SELECT p.id AS product_id,
       p.book AS book,
       CASE WHEN p.book <> 'telecom' THEN NULL
            WHEN rp.id IS NULL THEN 'legacy'
            ELSE lower(rp.name) || '_cards' END AS segment
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN reload_providers rp ON rp.id = c.provider_id;

CREATE INDEX idx_categories_provider ON categories(provider_id);
CREATE INDEX idx_cash_entries_book_segment_date ON cash_entries(book, segment, business_date);

`;
    s += '-- 3. backfill: every existing Telecom row is legacy; only the segment column is written\n';
    s += `DROP TRIGGER trg_cash_entries_no_update;\n`;
    for (const [t, hasBook] of ADD_COLUMN_TABLES) {
      s += `UPDATE ${t} SET segment = 'legacy'${hasBook ? " WHERE book = 'telecom'" : ''};\n`;
      if (t === 'cash_entries') s += `${noUpdate};\n`;
    }
    s += `
-- 4. one posted opening balance per scope (book + segment [+ fund]); the existing Telecom opening balance is the legacy one
DROP INDEX ux_capital_opening_balance;
CREATE UNIQUE INDEX ux_capital_opening_balance ON capital_entries(book, COALESCE(segment, ''), COALESCE(fund, ''))
  WHERE kind = 'opening_balance' AND status = 'posted';

-- 5. rules: telecom rows need a segment, other books forbid one, legacy is refused on INSERT; the segment never changes
`;
    for (const [t, hasBook] of ADD_COLUMN_TABLES) s += `${insertRule(t, hasBook)}\n\n${immutableRule(t)}\n\n`;
    s += `-- a reversal must carry the segment of the entry it reverses (same predicate as before plus the segment)
DROP TRIGGER trg_cash_entries_reversal_mirror;
${mirror2};

-- category provider: only a Telecom category, and only while it has no products (the segment of its products would change)
CREATE TRIGGER trg_categories_provider_insert
BEFORE INSERT ON categories
WHEN NEW.provider_id IS NOT NULL AND NEW.book <> 'telecom'
BEGIN
  SELECT RAISE(ABORT, 'CATEGORY_PROVIDER_NOT_ALLOWED');
END;

CREATE TRIGGER trg_categories_provider_update
BEFORE UPDATE OF provider_id, book ON categories
WHEN (NEW.provider_id IS NOT NULL AND NEW.book <> 'telecom')
  OR (NEW.provider_id IS NOT OLD.provider_id AND EXISTS (SELECT 1 FROM products WHERE category_id = OLD.id))
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.provider_id IS NOT NULL AND NEW.book <> 'telecom'
                           THEN 'CATEGORY_PROVIDER_NOT_ALLOWED' ELSE 'CATEGORY_PROVIDER_LOCKED' END);
END;

-- a NEW Telecom stock product needs a category that has a provider (existing provider-less products stay legacy)
CREATE TRIGGER trg_products_needs_provider
BEFORE INSERT ON products
WHEN NEW.book = 'telecom' AND NEW.kind = 'stock' AND (SELECT provider_id FROM categories WHERE id = NEW.category_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_NEEDS_PROVIDER');
END;

-- moving a Telecom product that already has stock movements to a category of another provider would change its segment
CREATE TRIGGER trg_products_segment_locked
BEFORE UPDATE OF category_id ON products
WHEN NEW.book = 'telecom' AND NEW.category_id <> OLD.category_id
 AND (SELECT provider_id FROM categories WHERE id = NEW.category_id) IS NOT (SELECT provider_id FROM categories WHERE id = OLD.category_id)
 AND EXISTS (SELECT 1 FROM stock_movements WHERE product_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_SEGMENT_LOCKED');
END;

`;
    // ---- guard
    s += `-- Abort (roll the whole migration back) if a row was lost or changed, a Telecom row has no segment, the append-only trigger text changed,
-- a foreign key is broken, or the set of indexes/triggers/views is not exactly the old set plus the new objects.
CREATE TEMP TABLE _mig024_new (type TEXT NOT NULL, name TEXT NOT NULL);
`;
    for (const x of n.indexes) s += `INSERT INTO _mig024_new VALUES ('index', '${x}');\n`;
    for (const x of n.triggers) s += `INSERT INTO _mig024_new VALUES ('trigger', '${x}');\n`;
    for (const x of n.views) s += `INSERT INTO _mig024_new VALUES ('view', '${x}');\n`;
    s += `CREATE TEMP TABLE _mig024_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig024_guard SELECT CASE WHEN
`;
    const conds: string[] = [];
    for (const [t, hasBook] of ADD_COLUMN_TABLES) {
      conds.push(`(SELECT COUNT(*) FROM ${t}) = (SELECT n FROM _mig024_before WHERE tbl = '${t}')`);
      conds.push(`(SELECT TOTAL(id) FROM ${t}) = (SELECT ids FROM _mig024_before WHERE tbl = '${t}')`);
      conds.push(hasBook
        ? `NOT EXISTS (SELECT 1 FROM ${t} WHERE (book = 'telecom') <> (segment IS NOT NULL) OR (book = 'telecom' AND segment <> 'legacy'))`
        : `NOT EXISTS (SELECT 1 FROM ${t} WHERE segment IS NOT 'legacy')`);
    }
    conds.push(`(SELECT TOTAL(amount_cents) FROM cash_entries) = (SELECT money FROM _mig024_before WHERE tbl = 'cash_entries')`);
    conds.push(`(SELECT sql FROM sqlite_master WHERE name = 'trg_cash_entries_no_update') IS (SELECT sql FROM _mig024_trg)`);
    conds.push(`NOT EXISTS (SELECT 1 FROM categories WHERE provider_id IS NOT NULL)`);
    conds.push(`NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)`);
    conds.push(`NOT EXISTS (SELECT 1 FROM _mig024_objs o WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = o.type AND m.name = o.name))`);
    conds.push(`NOT EXISTS (SELECT 1 FROM _mig024_new w WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = w.type AND m.name = w.name))`);
    conds.push(`(SELECT COUNT(*) FROM sqlite_master WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_autoindex%') = (SELECT COUNT(*) FROM _mig024_objs) + (SELECT COUNT(*) FROM _mig024_new)`);
    s += conds.map((c) => `  ${c}`).join('\n AND ');
    s += `\n  THEN 1 ELSE 0 END;

DROP TABLE _mig024_guard;
DROP TABLE _mig024_new;
DROP TABLE _mig024_objs;
DROP TABLE _mig024_trg;
DROP TABLE _mig024_before;
`;
    return s;
  } finally {
    db.close();
  }
}

// ===================================================================================================================================
// 025 (table rebuilds)
// ===================================================================================================================================

interface RebuildSpec {
  table: string;
  oldColumns: string[];
  create: string;
  /** SELECT expression for the new segment column(s), in the order of `newColumns`. */
  newColumns: string[];
  newExprs: string[];
  /** Names of the NEW indexes/triggers created for this table. */
  newObjects: string[];
  extra: string;
}

const SEG_COL = (dom: string): string => `TEXT CHECK (${dom})`;

function rebuildSpecs(): RebuildSpec[] {
  return [
    {
      table: 'daily_closings',
      oldColumns: ['id', 'book', 'business_date', 'posted_at', 'closed_at', 'reopened_at', 'reopen_reason', 'expected_cents', 'counted_cents', 'over_short_cents', 'cash_count_id'],
      newColumns: ['segment'],
      newExprs: ["CASE WHEN book = 'telecom' THEN 'legacy' END"],
      create: `CREATE TABLE daily_closings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  book            TEXT    NOT NULL CHECK (book IN ('shop','telecom','icecream')),
  segment         ${SEG_COL(DOMAIN_ALL)},
  business_date   TEXT    NOT NULL,
  -- first closing time (server clock, never changes); closed_at = the latest close after any reopen
  posted_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reopened_at     TEXT,
  reopen_reason   TEXT,
  expected_cents  INTEGER NOT NULL,
  counted_cents   INTEGER CHECK (counted_cents IS NULL OR counted_cents >= 0),
  over_short_cents INTEGER NOT NULL DEFAULT 0,
  cash_count_id   INTEGER REFERENCES cash_counts(id),
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK ((counted_cents IS NULL AND over_short_cents = 0)
      OR (counted_cents IS NOT NULL AND over_short_cents = counted_cents - expected_cents)),
  -- a reopen always records why (at least 3 characters)
  CHECK (reopened_at IS NULL OR (reopen_reason IS NOT NULL AND length(trim(reopen_reason)) >= 3)),
  -- the segment is named exactly for Telecom
  CHECK ((book = 'telecom') = (segment IS NOT NULL))
);`,
      newObjects: ['ux_daily_closings_scope_date', 'idx_daily_closings_book_date', 'idx_daily_closings_book_segment_date',
        'trg_daily_closings_segment_insert', 'trg_daily_closings_segment_immutable'],
      extra: `-- one closing per scope and day (replaces UNIQUE (book, business_date); Shop / Ice Cream have segment NULL)
CREATE UNIQUE INDEX ux_daily_closings_scope_date ON daily_closings(book, COALESCE(segment, ''), business_date);
CREATE INDEX idx_daily_closings_book_date ON daily_closings(book, business_date);
-- the closed-day probe of every closed-day trigger: book = ? AND segment IS ? AND business_date >= ?
CREATE INDEX idx_daily_closings_book_segment_date ON daily_closings(book, segment, business_date);

CREATE TRIGGER trg_daily_closings_segment_insert
BEFORE INSERT ON daily_closings
WHEN (NEW.book = 'telecom') <> (NEW.segment IS NOT NULL) OR NEW.segment = 'legacy'
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.segment = 'legacy' THEN 'SEGMENT_LEGACY_REFUSED'
                           WHEN NEW.segment IS NULL THEN 'SEGMENT_REQUIRED' ELSE 'SEGMENT_NOT_ALLOWED' END);
END;

${immutableRule('daily_closings')}
`,
    },
    {
      table: 'cash_transfers',
      oldColumns: ['id', 'business_date', 'posted_at', 'from_book', 'to_book', 'from_fund', 'to_fund', 'amount_cents', 'note', 'status', 'voided_at', 'void_reason', 'client_ref'],
      newColumns: ['from_segment', 'to_segment'],
      newExprs: ["CASE WHEN from_book = 'telecom' THEN 'legacy' END", "CASE WHEN to_book = 'telecom' THEN 'legacy' END"],
      create: `CREATE TABLE cash_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT    NOT NULL,
  posted_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  from_book     TEXT    NOT NULL CHECK (from_book IN ('shop','telecom','icecream')),
  to_book       TEXT    NOT NULL CHECK (to_book IN ('shop','telecom','icecream')),
  from_fund     TEXT    CHECK (from_fund IS NULL OR from_fund IN ('cost','electricity','profit')),
  to_fund       TEXT    CHECK (to_fund IS NULL OR to_fund IN ('cost','electricity','profit')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  note          TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at     TEXT,
  void_reason   TEXT,
  client_ref    TEXT    NOT NULL UNIQUE,
  from_segment  ${SEG_COL(DOMAIN_ALL.replaceAll('segment', 'from_segment'))},
  to_segment    ${SEG_COL(DOMAIN_ALL.replaceAll('segment', 'to_segment'))},
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  -- section 8: money moves BETWEEN two different books; section 13D: or between two different Telecom segments
  CHECK (from_book <> to_book OR (from_book = 'telecom' AND from_segment <> to_segment)),
  -- section 10.2: the fund is named exactly on the Ice Cream side(s)
  CHECK ((from_book = 'icecream') = (from_fund IS NOT NULL)),
  CHECK ((to_book = 'icecream') = (to_fund IS NOT NULL)),
  -- section 13D: the segment is named exactly on the Telecom side(s)
  CHECK ((from_book = 'telecom') = (from_segment IS NOT NULL)),
  CHECK ((to_book = 'telecom') = (to_segment IS NOT NULL)),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);`,
      newObjects: ['trg_cash_transfers_segment_insert', 'trg_cash_transfers_segment_immutable'],
      extra: `CREATE TRIGGER trg_cash_transfers_segment_insert
BEFORE INSERT ON cash_transfers
WHEN (NEW.from_book = 'telecom') <> (NEW.from_segment IS NOT NULL) OR (NEW.to_book = 'telecom') <> (NEW.to_segment IS NOT NULL)
  OR NEW.from_segment = 'legacy' OR NEW.to_segment = 'legacy'
BEGIN
  SELECT RAISE(ABORT, CASE WHEN NEW.from_segment = 'legacy' OR NEW.to_segment = 'legacy' THEN 'SEGMENT_LEGACY_REFUSED'
                           WHEN (NEW.from_book = 'telecom' AND NEW.from_segment IS NULL) OR (NEW.to_book = 'telecom' AND NEW.to_segment IS NULL)
                           THEN 'SEGMENT_REQUIRED' ELSE 'SEGMENT_NOT_ALLOWED' END);
END;

CREATE TRIGGER trg_cash_transfers_segment_immutable
BEFORE UPDATE OF from_segment, to_segment ON cash_transfers
WHEN NEW.from_segment IS NOT OLD.from_segment OR NEW.to_segment IS NOT OLD.to_segment
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_READ_ONLY');
END;

-- a transfer leg must carry the segment of its side of the transfer (same predicate as before plus the segment)
DROP TRIGGER trg_cash_entries_transfer_link;
CREATE TRIGGER trg_cash_entries_transfer_link
BEFORE INSERT ON cash_entries
WHEN NEW.type IN ('transfer_out','transfer_in') OR NEW.transfer_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_LEG_MISMATCH')
   WHERE NEW.transfer_id IS NULL
      OR NEW.type NOT IN ('transfer_out','transfer_in')
      OR NOT EXISTS (
        SELECT 1 FROM cash_transfers t
         WHERE t.id = NEW.transfer_id
           AND ((NEW.type = 'transfer_out' AND t.from_book = NEW.book AND t.from_fund IS NEW.fund AND t.from_segment IS NEW.segment)
             OR (NEW.type = 'transfer_in'  AND t.to_book   = NEW.book AND t.to_fund   IS NEW.fund AND t.to_segment   IS NEW.segment))
      );
END;
`,
    },
    {
      table: 'sales',
      oldColumns: ['id', 'business_date', 'posted_at', 'book', 'total_cents', 'status', 'notes', 'client_ref', 'voided_at', 'void_reason'],
      newColumns: ['segment'],
      newExprs: ["CASE WHEN book = 'telecom' THEN 'legacy' END"],
      create: `CREATE TABLE sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  book           TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  segment        ${SEG_COL(DOMAIN_CARDS)},
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  status         TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  notes          TEXT    NOT NULL DEFAULT '',
  client_ref     TEXT    NOT NULL,
  voided_at      TEXT,
  void_reason    TEXT,
  -- real calendar date only (GLOB checks the shape, date() rejects 31 February)
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  -- a void always records when and why
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  -- the segment is named exactly for Telecom
  CHECK ((book = 'telecom') = (segment IS NOT NULL))
);`,
      newObjects: ['ux_sales_client_ref_scope', 'trg_sales_segment_insert', 'trg_sales_segment_immutable'],
      extra: `-- the idempotency key is unique per scope (replaces UNIQUE (client_ref, book); one cart may make one sale per segment)
CREATE UNIQUE INDEX ux_sales_client_ref_scope ON sales(client_ref, book, COALESCE(segment, ''));

${insertRule('sales', true)}

${immutableRule('sales')}
`,
    },
  ];
}

export function names025(): { table: string; newObjects: string[] }[] {
  return rebuildSpecs().map((r) => ({ table: r.table, newObjects: r.newObjects }));
}

export function generate025(fixtureDb: string = FIXTURE_DB): string {
  const db = new DatabaseSync(fixtureDb, { readOnly: true });
  try {
    const specs = rebuildSpecs();
    const tables = specs.map((r) => r.table);
    const inList = tables.map((t) => `'${t}'`).join(',');
    let s = HEAD('025_telecom_segments_rebuilds.sql', `
Telecom segments, part 2 of 3. GENERATED by server/src/db/gen/telecom-segments-sql.ts; do not edit.
Rebuilds the three tables whose UNIQUE constraint or table-level CHECKs must change: daily_closings (segment; one closing per
book + segment + day), cash_transfers (from_segment / to_segment; a transfer may also be between two different Telecom segments) and
sales (segment; client_ref unique per book + segment). Existing Telecom rows become 'legacy'; every other column value, id and the
AUTOINCREMENT counter are preserved exactly.
Same technique as 015 / 023: the runner executes this file in a transaction with foreign_keys ON, so each table is NOT renamed: its rows
are parked in a TEMP table, the table is dropped and re-created under its own name, and the rows are re-inserted with their ids (dropping
the parent counts the child rows as deferred violations; re-inserting the same ids clears them). Dropping a table also drops its indexes and
triggers, so EVERY index and trigger of each table is re-created (the text below is copied verbatim from a schema-23 database; the
closed-day triggers are replaced by their segment-aware versions in 026). The migration aborts (rolls back) if any row differs, a foreign key
is broken, or the set of indexes/triggers is not exactly the old set plus the new objects listed in the guard.
`);
    s += 'PRAGMA defer_foreign_keys = ON;\n\n';
    s += `CREATE TEMP TABLE _mig025_objs AS
SELECT type, name, tbl_name FROM sqlite_master
 WHERE tbl_name IN (${inList}) AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex%';\n\n`;
    for (const r of specs) {
      const cols = r.oldColumns.join(', ');
      s += `-- ===== ${r.table} =====
CREATE TEMP TABLE _mig025_${r.table} AS SELECT ${cols} FROM ${r.table};
CREATE TEMP TABLE _mig025_seq_${r.table} AS SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${r.table}'), 0) AS seq;

DROP TABLE ${r.table};

${r.create}

-- the triggers are re-created only after the copy, so none of them fires while the rows are copied back
INSERT INTO ${r.table} (${cols}, ${r.newColumns.join(', ')})
SELECT ${cols}, ${r.newExprs.join(', ')} FROM _mig025_${r.table} ORDER BY id;

UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM _mig025_seq_${r.table})) WHERE name = '${r.table}';

`;
      // verbatim indexes and triggers of schema 23
      const objs = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name").all(r.table) as unknown as
        { type: string; name: string; sql: string }[];
      for (const o of objs) s += `${o.sql};\n\n`;
      s += `${r.extra}\n`;
    }
    s += `-- ===== guard =====
CREATE TEMP TABLE _mig025_new (name TEXT NOT NULL);
`;
    for (const r of specs) for (const n of r.newObjects) s += `INSERT INTO _mig025_new VALUES ('${n}');\n`;
    s += `CREATE TEMP TABLE _mig025_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig025_guard SELECT CASE WHEN
`;
    const conds: string[] = [];
    for (const r of specs) {
      const t = r.table;
      conds.push(`(SELECT COUNT(*) FROM ${t}) = (SELECT COUNT(*) FROM _mig025_${t})`);
      const diff = r.oldColumns.map((c) => `n.${c} IS NOT o.${c}`);
      for (let i = 0; i < r.newColumns.length; i++) diff.push(`n.${r.newColumns[i]} IS NOT (${r.newExprs[i]!.replace(/\b(from_book|to_book|book)\b/g, 'o.$1')})`);
      conds.push(`NOT EXISTS (SELECT 1 FROM _mig025_${t} o LEFT JOIN ${t} n ON n.id = o.id WHERE n.id IS NULL OR ${diff.join('\n                      OR ')})`);
    }
    conds.push('NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)');
    conds.push(`NOT EXISTS (SELECT 1 FROM _mig025_objs o WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = o.type AND m.name = o.name AND m.tbl_name = o.tbl_name))`);
    conds.push(`NOT EXISTS (SELECT 1 FROM _mig025_new w WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.name = w.name))`);
    conds.push(`(SELECT COUNT(*) FROM sqlite_master WHERE tbl_name IN (${inList}) AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex%') = (SELECT COUNT(*) FROM _mig025_objs) + (SELECT COUNT(*) FROM _mig025_new)`);
    s += conds.map((c) => `  ${c}`).join('\n AND ');
    s += `\n  THEN 1 ELSE 0 END;

DROP TABLE _mig025_guard;
DROP TABLE _mig025_new;
DROP TABLE _mig025_objs;
`;
    for (const r of specs) s += `DROP TABLE _mig025_seq_${r.table};\nDROP TABLE _mig025_${r.table};\n`;
    return s;
  } finally {
    db.close();
  }
}

// ===================================================================================================================================
// 026 (closed-day triggers + consistency)
// ===================================================================================================================================

interface Scope { book: string; seg: string }
const OPEN = '(d.reopened_at IS NULL OR d.closed_at > d.reopened_at)';

/** One closed-day probe: is there an open closing of this scope on or after (or exactly on) the date? */
function probe(sc: Scope, date: string, eq: boolean, extra = ''): string {
  return `EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = ${sc.book} AND d.segment IS ${sc.seg} AND d.business_date ${eq ? '=' : '>='} ${date}${extra} AND ${OPEN})`;
}
const anyOf = (xs: string[]): string => (xs.length === 1 ? xs[0]! : `(${xs.join('\n       OR ')})`);

function closedDayTrigger(name: string, event: string, table: string, prefix: string, scopes: Scope[], date: string, extra = ''): string {
  const wh = scopes.map((sc) => probe(sc, date, false, extra));
  const eq = scopes.map((sc) => probe(sc, date, true));
  return `CREATE TRIGGER ${name}
${event} ON ${table}
WHEN ${prefix ? `${prefix}\n  AND ` : ''}${anyOf(wh)}
BEGIN
  SELECT CASE
    WHEN ${anyOf(eq)}
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;`;
}

const direct = (r: string): Scope[] => [{ book: `${r}.book`, seg: `${r}.segment` }];
const telecomOnly = (r: string): Scope[] => [{ book: `'telecom'`, seg: `${r}.segment` }];
const viaSale = (r: string): Scope[] => [{ book: `(SELECT s.book FROM sales s WHERE s.id = ${r}.sale_id)`, seg: `(SELECT s.segment FROM sales s WHERE s.id = ${r}.sale_id)` }];
const viaPurchase = (r: string): Scope[] => [{ book: `(SELECT b.book FROM purchases b WHERE b.id = ${r}.purchase_id)`, seg: `(SELECT b.segment FROM purchases b WHERE b.id = ${r}.purchase_id)` }];
const viaProduct = (r: string): Scope[] => [{ book: `(SELECT v.book FROM v_product_segment v WHERE v.product_id = ${r}.product_id)`, seg: `(SELECT v.segment FROM v_product_segment v WHERE v.product_id = ${r}.product_id)` }];
const bothSides = (r: string): Scope[] => [{ book: `${r}.from_book`, seg: `${r}.from_segment` }, { book: `${r}.to_book`, seg: `${r}.to_segment` }];

interface ClosedDaySpec { table: string; scopes: (r: string) => Scope[]; ins?: string; insDate?: string; extraProbe?: (r: string) => string; void?: boolean }

const CLOSED_DAY_SPECS: ClosedDaySpec[] = [
  { table: 'capital_entries', scopes: direct, void: true },
  { table: 'cash_counts', scopes: direct, void: true, extraProbe: (r) => `\n               AND (${r}.difference_cents <> 0 OR d.business_date = ${r}.business_date)` },
  { table: 'cash_entries', scopes: direct },
  { table: 'cash_transfers', scopes: bothSides, void: true },
  { table: 'expenses', scopes: direct, void: true },
  { table: 'ezcash_sales', scopes: telecomOnly, void: true },
  { table: 'owner_drawings', scopes: direct, void: true },
  { table: 'purchase_returns', scopes: viaPurchase },
  { table: 'purchases', scopes: direct, void: true },
  { table: 'reload_sales', scopes: telecomOnly, void: true },
  { table: 'sales', scopes: direct, void: true },
  { table: 'sales_returns', scopes: viaSale, void: true },
  { table: 'stock_losses', scopes: direct, void: true },
  { table: 'stock_movements', scopes: viaProduct },
  { table: 'telecom_topups', scopes: telecomOnly, void: true },
];

const CARD_SCOPES: Scope[] = [{ book: `'shop'`, seg: 'NULL' }, ...CARDS.map((c): Scope => ({ book: `'telecom'`, seg: `'${c}'` }))];

/** All closed-day triggers of 016 / 019 with their exact old names. */
export function closedDayTriggers(): Array<{ name: string; sql: string }> {
  const out: Array<{ name: string; sql: string }> = [];
  for (const sp of CLOSED_DAY_SPECS) {
    const extraN = sp.extraProbe ? sp.extraProbe('NEW') : '';
    const extraO = sp.extraProbe ? sp.extraProbe('OLD') : '';
    out.push({ name: `trg_${sp.table}_day_closed`, sql: closedDayTrigger(`trg_${sp.table}_day_closed`, 'BEFORE INSERT', sp.table, '', sp.scopes('NEW'), 'NEW.business_date', extraN) });
    if (sp.void) {
      out.push({
        name: `trg_${sp.table}_day_closed_void`,
        sql: closedDayTrigger(`trg_${sp.table}_day_closed_void`, 'BEFORE UPDATE OF status', sp.table, `OLD.status = 'posted' AND NEW.status = 'void'`, sp.scopes('OLD'), 'OLD.business_date', extraO),
      });
    }
  }
  // stocktakes: insert as completed, draft -> completed, completed -> void
  out.push({ name: 'trg_stocktakes_day_closed', sql: closedDayTrigger('trg_stocktakes_day_closed', 'BEFORE INSERT', 'stocktakes', `NEW.status = 'completed'`, direct('NEW'), 'NEW.business_date') });
  out.push({ name: 'trg_stocktakes_day_closed_complete', sql: closedDayTrigger('trg_stocktakes_day_closed_complete', 'BEFORE UPDATE OF status', 'stocktakes', `NEW.status = 'completed' AND OLD.status <> 'completed'`, direct('OLD'), 'OLD.business_date') });
  out.push({ name: 'trg_stocktakes_day_closed_void', sql: closedDayTrigger('trg_stocktakes_day_closed_void', 'BEFORE UPDATE OF status', 'stocktakes', `OLD.status = 'completed' AND NEW.status = 'void'`, direct('OLD'), 'OLD.business_date') });
  // opening stock: the header is refused only when Shop and ALL FOUR Cards segments are blocked (the real judges are the stock movements)
  out.push({ name: 'trg_opening_stock_batches_day_closed', sql: openingStockHeader() });
  const mv = (eq: boolean): string => `EXISTS (SELECT 1 FROM stock_movements m
                JOIN v_product_segment v ON v.product_id = m.product_id
                JOIN daily_closings d ON d.book = v.book AND d.segment IS v.segment
               WHERE m.ref_table = 'opening_stock_batches' AND m.ref_id = OLD.id AND d.business_date ${eq ? '=' : '>='} OLD.business_date AND ${OPEN})`;
  out.push({
    name: 'trg_opening_stock_batches_day_closed_void',
    sql: `CREATE TRIGGER trg_opening_stock_batches_day_closed_void
BEFORE UPDATE OF status ON opening_stock_batches
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND ${mv(false)}
BEGIN
  SELECT CASE
    WHEN ${mv(true)}
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;`,
  });
  return out;
}

/** Opening stock header rule: ALL five scopes must be blocked; the eq branch is OR (a block on that exact day by any of them). */
function openingStockHeader(): string {
  const wh = CARD_SCOPES.map((sc) => probe(sc, 'NEW.business_date', false));
  const eq = CARD_SCOPES.map((sc) => probe(sc, 'NEW.business_date', true));
  return `CREATE TRIGGER trg_opening_stock_batches_day_closed
BEFORE INSERT ON opening_stock_batches
WHEN ${wh.join('\n AND ')}
BEGIN
  SELECT CASE
    WHEN ${eq.join('\n      OR ')}
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;`;
}

const REF_OWNERS: Array<[string, string]> = [
  ['sales', 'EXISTS (SELECT 1 FROM sales o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['sales_returns', 'EXISTS (SELECT 1 FROM sales_returns r JOIN sales o ON o.id = r.sale_id WHERE r.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['purchases', 'EXISTS (SELECT 1 FROM purchases o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['purchase_returns', 'EXISTS (SELECT 1 FROM purchase_returns r JOIN purchases o ON o.id = r.purchase_id WHERE r.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['expenses', 'EXISTS (SELECT 1 FROM expenses o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['capital_entries', 'EXISTS (SELECT 1 FROM capital_entries o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['owner_drawings', 'EXISTS (SELECT 1 FROM owner_drawings o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['cash_counts', 'EXISTS (SELECT 1 FROM cash_counts o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['reload_sales', 'EXISTS (SELECT 1 FROM reload_sales o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['ezcash_sales', 'EXISTS (SELECT 1 FROM ezcash_sales o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
  ['telecom_topups', 'EXISTS (SELECT 1 FROM telecom_topups o WHERE o.id = NEW.ref_id AND o.segment IS NOT NEW.segment)'],
];

export function names026(): string[] {
  return [
    'trg_cash_entries_segment_matches_ref', 'trg_reload_sales_segment_provider', 'trg_ezcash_sales_segment_provider',
    'trg_telecom_topups_segment_provider', 'trg_sale_items_segment_matches', 'trg_purchase_items_segment_matches',
    'trg_stocktake_items_segment_matches', 'trg_stock_losses_segment_matches', 'trg_owner_drawings_segment_matches_product',
  ];
}

export function generate026(): string {
  const trg = closedDayTriggers();
  const newNames = names026();
  let s = HEAD('026_telecom_segments_closed_day_and_consistency.sql', `
Telecom segments, part 3 of 3. GENERATED by server/src/db/gen/telecom-segments-sql.ts; do not edit.
(1) Closed-day protection per SEGMENT: every closed-day trigger of 016 / 019 is dropped and re-created with the SAME name, the same
    predicate and the same error codes (DAY_CLOSED, BACKDATE_BEFORE_CLOSED_DAY); the only change is the scope probe, which now also compares the
    segment (d.book = <book> AND d.segment IS <segment> ...), so a day closed for "Dialog Reloads" no longer blocks "Mobitel Cards". The probe is
    served by idx_daily_closings_book_segment_date. The scope of a record is: its own (book, segment) where it is stored; the sale's / purchase's
    scope for a sales or purchase return; the product's scope (view v_product_segment) for a stock movement; either side for a cash transfer;
    for opening stock the header is refused only when Shop and all four Cards segments are blocked, and the void flip is judged by the scopes
    of the movements it reverses. Untouched: print_sales, printing_supplies and the icecream_* tables (they never had segments).
(2) Consistency triggers: a non-reversal cash entry carries the segment of the record that owns it; reload / EZCash / top-up rows carry the
    segment derived from their provider; sale, purchase and stocktake lines, stock losses and goods drawings carry the segment of their product.
Forward-only; runs in the runner's transaction with foreign_keys ON.
`);
  s += `CREATE TEMP TABLE _mig026_objs AS SELECT type, name FROM sqlite_master WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_autoindex%';\n\n`;
  s += '-- ===== (1) closed-day triggers =====\n';
  for (const t of trg) s += `DROP TRIGGER ${t.name};\n${t.sql}\n\n`;
  s += `-- ===== (2) consistency =====
-- the cash entry of a record carries that record's segment (a reversal is judged by trg_cash_entries_reversal_mirror)
CREATE TRIGGER trg_cash_entries_segment_matches_ref
BEFORE INSERT ON cash_entries
WHEN NEW.reverses_entry_id IS NULL AND NEW.ref_table IS NOT NULL AND (
${REF_OWNERS.map(([t, e]) => `  (NEW.ref_table = '${t}' AND ${e})`).join('\n  OR ')})
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

-- reload / EZCash / top-up rows: the segment comes from the provider (EZCash and wallet top-ups are Dialog Reloads)
CREATE TRIGGER trg_reload_sales_segment_provider
BEFORE INSERT ON reload_sales
WHEN NEW.segment IS NOT (SELECT lower(p.name) || '_reloads' FROM reload_providers p WHERE p.id = NEW.provider_id)
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

CREATE TRIGGER trg_ezcash_sales_segment_provider
BEFORE INSERT ON ezcash_sales
WHEN NEW.segment IS NOT (SELECT lower(p.name) || '_reloads' FROM reload_providers p WHERE p.id = NEW.provider_id)
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

CREATE TRIGGER trg_telecom_topups_segment_provider
BEFORE INSERT ON telecom_topups
WHEN NEW.segment IS NOT CASE WHEN NEW.provider_id IS NULL THEN 'dialog_reloads'
                             ELSE (SELECT lower(p.name) || '_reloads' FROM reload_providers p WHERE p.id = NEW.provider_id) END
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

-- lines carry the segment of their product (the header is inserted first)
CREATE TRIGGER trg_sale_items_segment_matches
BEFORE INSERT ON sale_items
WHEN EXISTS (SELECT 1 FROM sales s JOIN v_product_segment v ON v.product_id = NEW.product_id
              WHERE s.id = NEW.sale_id AND (v.book IS NOT s.book OR v.segment IS NOT s.segment))
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

CREATE TRIGGER trg_purchase_items_segment_matches
BEFORE INSERT ON purchase_items
WHEN EXISTS (SELECT 1 FROM purchases h JOIN v_product_segment v ON v.product_id = NEW.product_id
              WHERE h.id = NEW.purchase_id AND (v.book IS NOT h.book OR v.segment IS NOT h.segment))
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

CREATE TRIGGER trg_stocktake_items_segment_matches
BEFORE INSERT ON stocktake_items
WHEN EXISTS (SELECT 1 FROM stocktakes h JOIN v_product_segment v ON v.product_id = NEW.product_id
              WHERE h.id = NEW.stocktake_id AND (v.book IS NOT h.book OR v.segment IS NOT h.segment))
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

CREATE TRIGGER trg_stock_losses_segment_matches
BEFORE INSERT ON stock_losses
WHEN EXISTS (SELECT 1 FROM v_product_segment v WHERE v.product_id = NEW.product_id AND (v.book IS NOT NEW.book OR v.segment IS NOT NEW.segment))
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

CREATE TRIGGER trg_owner_drawings_segment_matches_product
BEFORE INSERT ON owner_drawings
WHEN NEW.kind = 'goods' AND NEW.book = 'telecom'
 AND EXISTS (SELECT 1 FROM v_product_segment v WHERE v.product_id = NEW.product_id AND v.segment IS NOT NEW.segment)
BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_MISMATCH');
END;

-- ===== guard =====
-- every old trigger still exists (same names), exactly the new consistency triggers were added, nothing else.
CREATE TEMP TABLE _mig026_new (name TEXT NOT NULL);
${newNames.map((n) => `INSERT INTO _mig026_new VALUES ('${n}');`).join('\n')}
CREATE TEMP TABLE _mig026_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig026_guard SELECT CASE WHEN
      NOT EXISTS (SELECT 1 FROM _mig026_objs o WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = o.type AND m.name = o.name))
  AND NOT EXISTS (SELECT 1 FROM _mig026_new w WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'trigger' AND m.name = w.name))
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_autoindex%') = (SELECT COUNT(*) FROM _mig026_objs) + (SELECT COUNT(*) FROM _mig026_new)
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg\\_%\\_day\\_closed%' ESCAPE '\\' AND tbl_name NOT LIKE 'icecream%' AND tbl_name NOT LIKE 'print%'
        AND sql LIKE '%d.segment IS%') = ${trg.length}
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  THEN 1 ELSE 0 END;

DROP TABLE _mig026_guard;
DROP TABLE _mig026_new;
DROP TABLE _mig026_objs;
`;
  return s;
}

export const OUTPUTS = {
  '024_telecom_segments_columns.sql': generate024,
  '025_telecom_segments_rebuilds.sql': () => generate025(),
  '026_telecom_segments_closed_day_and_consistency.sql': generate026,
} as const;

if (import.meta.main) {
  for (const [file, gen] of Object.entries(OUTPUTS)) writeFileSync(join(MIGRATIONS_DIR, file), gen());
  console.log('written', Object.keys(OUTPUTS).join(', '));
}
