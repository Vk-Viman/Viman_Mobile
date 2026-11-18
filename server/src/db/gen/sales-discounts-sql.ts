/**
 * db/gen/sales-discounts-sql.ts - generator of migrations 027 (sale_items) and 028 (print_sales), the sales-discount rebuilds.
 *
 * Both migrations rebuild a table whose revenue arithmetic is a table CHECK (`revenue_cents = qty * unit_price_cents`), which SQLite cannot
 * alter in place, and re-create EVERY index and trigger of the table. The old indexes and triggers are copied VERBATIM from the FROZEN
 * schema-26 fixture database (server/src/tests/fixtures/schema26-world.db, the only authoritative copy of the schema-26 text), except the two
 * `*_immutable` triggers, which are the verbatim old text plus the new columns. The generated .sql files are COMMITTED and then never edited
 * (migrations are checksummed); phase27-migration.test.ts proves that this script still produces exactly the committed text. From the root:
 *   node server/src/db/gen/sales-discounts-sql.ts     (rewrites 027 and 028 - only while they are not released yet)
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');
export const FIXTURE_DB_26 = join(here, '..', '..', 'tests', 'fixtures', 'schema26-world.db');

/** The sentinel meaning "list price not supplied": the AFTER INSERT trigger replaces it with unit_price_cents (see README 027). */
const NEW_COLS_SQL = (): string => `  list_unit_price_cents INTEGER NOT NULL DEFAULT -1 CHECK (list_unit_price_cents >= -1),
  unit_discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK (unit_discount_cents >= 0),
  line_discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_cents >= 0),
  price_reduction_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_reduction_cents >= 0),
  bill_discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount_cents >= 0),`;

const DISCOUNT_CHECKS = (): string => `  -- section 13C: the amount paid is the gross line minus the per-unit discounts minus the line's share of the whole-bill discount
  CHECK (revenue_cents = qty * unit_price_cents - line_discount_cents - bill_discount_cents),
  CHECK (unit_discount_cents <= unit_price_cents),
  CHECK (line_discount_cents = unit_discount_cents * qty),
  -- the automatic price reduction: typed price below the list price (a higher typed price is an ordinary price, no reduction)
  CHECK (price_reduction_cents = qty * CASE WHEN list_unit_price_cents > unit_price_cents THEN list_unit_price_cents - unit_price_cents ELSE 0 END)`;

const HEAD = (file: string, text: string): string => `-- ${file}\n${text.trim().split('\n').map((l) => (l ? `-- ${l}` : '--')).join('\n')}\n\n`;

/** All indexes and triggers of a table in the frozen schema-26 database (verbatim text), by name. */
function objectsOf(db: DatabaseSync, table: string): Array<{ type: string; name: string; sql: string }> {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name")
    .all(table) as unknown as Array<{ type: string; name: string; sql: string }>;
  if (rows.length === 0) throw new Error(`no schema-26 objects found for ${table} in the fixture`);
  // the text stored in a database carries whatever line endings the checkout had when it was built: normalise to LF so the output is the same everywhere
  return rows.map((r) => ({ ...r, sql: r.sql.replaceAll('\r\n', '\n') }));
}

function replaceOnce(text: string, from: string, to: string, what: string): string {
  if (text.split(from).length !== 2) throw new Error(`${what}: expected exactly one occurrence of the anchor text`);
  return text.replace(from, to);
}

/** The shared guard / commentary part is built per table by `rebuild`. */
interface Spec {
  file: string;
  n: string;                 // '027' | '028'
  table: string;
  oldColumns: string[];
  head: string;
  create: string;
  patch: (name: string, sql: string) => string;   // extends the immutable trigger, identity for the others
  newTriggers: Array<{ name: string; sql: string }>;
  tail: string;              // extra guard conditions
}

function rebuild(spec: Spec, db: DatabaseSync): string {
  const { n, table } = spec;
  const cols = spec.oldColumns.join(', ');
  const objs = objectsOf(db, table);
  const newNames = spec.newTriggers.map((t) => t.name);
  let s = HEAD(spec.file, spec.head);
  s += 'PRAGMA defer_foreign_keys = ON;\n\n';
  s += `-- everything the migration must leave alone, and every object of the table that must come back
CREATE TEMP TABLE _mig${n}_other AS
SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> '${table}' AND name NOT LIKE 'sqlite_%';
CREATE TEMP TABLE _mig${n}_objs AS
SELECT type, name, tbl_name FROM sqlite_master
 WHERE tbl_name = '${table}' AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex%';

CREATE TEMP TABLE _mig${n}_rows AS SELECT ${cols} FROM ${table};
CREATE TEMP TABLE _mig${n}_seq AS SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${table}'), 0) AS seq;

DROP TABLE ${table};

${spec.create}

-- the triggers are re-created only after the copy, so none of them fires while the rows are copied back
INSERT INTO ${table} (${cols}, list_unit_price_cents, unit_discount_cents, line_discount_cents, price_reduction_cents, bill_discount_cents)
SELECT ${cols}, unit_price_cents, 0, 0, 0, 0 FROM _mig${n}_rows ORDER BY id;

UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM _mig${n}_seq)) WHERE name = '${table}';

-- ===== indexes and triggers of schema 26 (verbatim; only the immutable trigger is extended) =====
`;
  for (const o of objs) s += `${spec.patch(o.name, o.sql)};\n\n`;
  s += '-- ===== new objects =====\n';
  for (const t of spec.newTriggers) s += `${t.sql}\n\n`;
  s += `-- ===== guard: any difference aborts (and so rolls back) the whole migration =====
CREATE TEMP TABLE _mig${n}_new (name TEXT NOT NULL);
${newNames.map((x) => `INSERT INTO _mig${n}_new VALUES ('${x}');`).join('\n')}
CREATE TEMP TABLE _mig${n}_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig${n}_guard SELECT CASE WHEN
`;
  const diff = spec.oldColumns.map((c) => `n.${c} IS NOT o.${c}`);
  diff.push('n.list_unit_price_cents IS NOT o.unit_price_cents', 'n.unit_discount_cents IS NOT 0', 'n.line_discount_cents IS NOT 0',
    'n.price_reduction_cents IS NOT 0', 'n.bill_discount_cents IS NOT 0');
  const conds = [
    `(SELECT COUNT(*) FROM ${table}) = (SELECT COUNT(*) FROM _mig${n}_rows)`,
    `NOT EXISTS (SELECT 1 FROM _mig${n}_rows o LEFT JOIN ${table} n ON n.id = o.id WHERE n.id IS NULL\n                      OR ${diff.join('\n                      OR ')})`,
    `(SELECT seq FROM sqlite_sequence WHERE name = '${table}') >= (SELECT seq FROM _mig${n}_seq)`,
    'NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)',
    // every old object is back, and the set is exactly old + new
    `NOT EXISTS (SELECT 1 FROM _mig${n}_objs o WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = o.type AND m.name = o.name AND m.tbl_name = o.tbl_name))`,
    `NOT EXISTS (SELECT 1 FROM _mig${n}_new w WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'trigger' AND m.name = w.name AND m.tbl_name = '${table}'))`,
    `(SELECT COUNT(*) FROM sqlite_master WHERE tbl_name = '${table}' AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex%') = (SELECT COUNT(*) FROM _mig${n}_objs) + (SELECT COUNT(*) FROM _mig${n}_new)`,
    // nothing outside the table changed: every other table, index, trigger and view has exactly its old text (the return triggers that read the table included)
    `(SELECT COUNT(*) FROM sqlite_master WHERE tbl_name <> '${table}' AND name NOT LIKE 'sqlite_%') = (SELECT COUNT(*) FROM _mig${n}_other)`,
    `NOT EXISTS (SELECT 1 FROM _mig${n}_other o LEFT JOIN sqlite_master m ON m.type = o.type AND m.name = o.name WHERE m.name IS NULL OR m.tbl_name IS NOT o.tbl_name OR m.sql IS NOT o.sql)`,
    ...(spec.tail ? [spec.tail] : []),
  ];
  s += conds.map((c) => `  ${c}`).join('\n AND ');
  s += `
  THEN 1 ELSE 0 END;

DROP TABLE _mig${n}_guard;
DROP TABLE _mig${n}_new;
DROP TABLE _mig${n}_other;
DROP TABLE _mig${n}_objs;
DROP TABLE _mig${n}_seq;
DROP TABLE _mig${n}_rows;
`;
  return s;
}

// ===================================================================================================================================
// 027 - sale_items
// ===================================================================================================================================
export function generate027(fixtureDb: string = FIXTURE_DB_26): string {
  const db = new DatabaseSync(fixtureDb, { readOnly: true });
  try {
    const spec: Spec = {
      file: '027_sale_items_discounts.sql',
      n: '027',
      table: 'sale_items',
      oldColumns: ['id', 'sale_id', 'line_no', 'line_type', 'product_id', 'description', 'qty', 'unit_price_cents', 'unit_cost_cents', 'revenue_cents', 'cogs_cents', 'returned_qty', 'extra_cost_cents'],
      head: `
Sales discounts (BUSINESS_RULES 13C), part 1 of 2: POS goods lines. GENERATED by server/src/db/gen/sales-discounts-sql.ts; do not edit.
Rebuilds sale_items because its table CHECK (revenue_cents = qty * unit_price_cents) must become
  revenue = qty x unit_price - line_discount - bill_discount
and SQLite cannot alter a table CHECK. Adds five NOT NULL columns: list_unit_price_cents (existing rows: = unit_price_cents),
unit_discount_cents, line_discount_cents, price_reduction_cents, bill_discount_cents (existing rows: 0), with the CHECKs listed in the
table definition. Every other column value, id and the AUTOINCREMENT counter are preserved exactly.
Same technique as 015 / 023 / 025: the runner executes the file in a transaction with foreign_keys ON, so the table is parked in a TEMP
table, dropped, re-created under its own name and re-filled with the same ids (dropping the parent counts the sales_return_items rows as
deferred violations; re-inserting the same ids clears them). Dropping a table drops its indexes and triggers, so EVERY index and trigger is
re-created (text copied verbatim from a schema-26 database; trg_sale_items_immutable also covers the new columns).
New triggers: trg_sale_items_telecom_no_discount (a Telecom sale line, every segment, refuses any discount and any list price other than
its price) and trg_sale_items_list_price_default (compatibility: an INSERT that does not name list_unit_price_cents gets the DEFAULT -1,
the "not supplied" marker, and this AFTER INSERT trigger sets it to unit_price_cents, so code written before discounts keeps working;
-1 can never remain stored). The migration aborts (rolls back) if any row differs, a foreign key is broken, the set of indexes and triggers
is not exactly the old set plus the two new triggers, or ANY object outside sale_items (the return triggers that read it included) changed.
`,
      create: `CREATE TABLE sale_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id           INTEGER NOT NULL REFERENCES sales(id),
  line_no           INTEGER NOT NULL CHECK (line_no >= 1),
  line_type         TEXT    NOT NULL CHECK (line_type IN ('goods','card')),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  description       TEXT    NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty >= 1),
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  unit_cost_cents   INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  revenue_cents     INTEGER NOT NULL CHECK (revenue_cents >= 0),
  cogs_cents        INTEGER NOT NULL CHECK (cogs_cents >= 0),
  returned_qty      INTEGER NOT NULL DEFAULT 0, extra_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_cents >= 0),
${NEW_COLS_SQL()}
  UNIQUE (sale_id, line_no),
${DISCOUNT_CHECKS()},
  -- you cannot take back more than you sold
  CHECK (returned_qty BETWEEN 0 AND qty)
);`,
      patch: (name, sql) => {
        if (name !== 'trg_sale_items_immutable') return sql;
        return replaceOnce(sql, '  OR NEW.cogs_cents IS NOT OLD.cogs_cents\n', `  OR NEW.cogs_cents IS NOT OLD.cogs_cents
  OR NEW.unit_discount_cents IS NOT OLD.unit_discount_cents
  OR NEW.line_discount_cents IS NOT OLD.line_discount_cents
  OR NEW.price_reduction_cents IS NOT OLD.price_reduction_cents
  OR NEW.bill_discount_cents IS NOT OLD.bill_discount_cents
  OR (NEW.list_unit_price_cents IS NOT OLD.list_unit_price_cents
      AND NOT (OLD.list_unit_price_cents = -1 AND NEW.list_unit_price_cents = OLD.unit_price_cents))
`, 'trg_sale_items_immutable');
      },
      newTriggers: [
        {
          name: 'trg_sale_items_telecom_no_discount',
          sql: `-- Telecom sale lines (every segment) are never discounted and are always sold at the list price
CREATE TRIGGER trg_sale_items_telecom_no_discount
BEFORE INSERT ON sale_items
WHEN (NEW.unit_discount_cents <> 0 OR NEW.line_discount_cents <> 0 OR NEW.price_reduction_cents <> 0 OR NEW.bill_discount_cents <> 0
      OR (NEW.list_unit_price_cents <> -1 AND NEW.list_unit_price_cents <> NEW.unit_price_cents))
  AND EXISTS (SELECT 1 FROM sales s WHERE s.id = NEW.sale_id AND s.book = 'telecom')
BEGIN
  SELECT RAISE(ABORT, 'DISCOUNT_NOT_ALLOWED');
END;`,
        },
        {
          name: 'trg_sale_items_list_price_default',
          sql: `-- compatibility: a line inserted without a list price (the -1 default) is sold at its own price
CREATE TRIGGER trg_sale_items_list_price_default
AFTER INSERT ON sale_items
WHEN NEW.list_unit_price_cents = -1
BEGIN
  UPDATE sale_items SET list_unit_price_cents = NEW.unit_price_cents WHERE id = NEW.id;
END;`,
        },
      ],
      tail: '',
    };
    return rebuild(spec, db);
  } finally {
    db.close();
  }
}

// ===================================================================================================================================
// 028 - print_sales
// ===================================================================================================================================
export function generate028(fixtureDb: string = FIXTURE_DB_26): string {
  const db = new DatabaseSync(fixtureDb, { readOnly: true });
  try {
    const spec: Spec = {
      file: '028_print_sales_discounts.sql',
      n: '028',
      table: 'print_sales',
      oldColumns: ['id', 'business_date', 'posted_at', 'service_type_id', 'description', 'qty', 'unit_price_cents', 'unit_cost_cents', 'revenue_cents', 'cogs_cents', 'status', 'voided_at', 'void_reason', 'notes', 'client_ref'],
      head: `
Sales discounts (BUSINESS_RULES 13C), part 2 of 2: printing, photocopying and other Shop services. GENERATED by
server/src/db/gen/sales-discounts-sql.ts; do not edit.
Rebuilds print_sales because its table CHECK (revenue_cents = qty * unit_price_cents AND cogs_cents = qty * unit_cost_cents) must become
  revenue = qty x unit_price - line_discount - bill_discount, and still cogs = qty x unit_cost
and SQLite cannot alter a table CHECK. Adds the same five NOT NULL columns as 027 (list_unit_price_cents = unit_price_cents and the four
discount columns 0 for every existing row), with the same CHECKs (plus revenue_cents >= 0). Every other column value, id and the
AUTOINCREMENT counter are preserved exactly. print_sales is Shop-only by construction (no Telecom form), so it needs no Telecom trigger.
Same technique and guards as 027: TEMP copy, DROP, CREATE, re-insert with the same ids, EVERY index and trigger re-created verbatim from a
schema-26 database (trg_print_sales_immutable also covers the new columns), plus the compatibility trigger
trg_print_sales_list_price_default (see 027). The migration aborts (rolls back) if any row differs, a foreign key is broken, the set of
indexes and triggers is not exactly the old set plus the new trigger, or ANY object outside print_sales (the cash-entry triggers keyed on
ref_table = 'print_sales', the corrections link ...) changed. print_sales has no foreign-key children; its parent print_service_types is untouched.
`,
      create: `CREATE TABLE print_sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date    TEXT    NOT NULL,
  posted_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  service_type_id  INTEGER NOT NULL REFERENCES print_service_types(id),
  description      TEXT    NOT NULL,
  qty              INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 1000000),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 1000000000),
  unit_cost_cents  INTEGER NOT NULL CHECK (unit_cost_cents BETWEEN 0 AND 1000000000),
  revenue_cents    INTEGER NOT NULL,
  cogs_cents       INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at        TEXT,
  void_reason      TEXT,
  notes            TEXT    NOT NULL DEFAULT '',
  client_ref       TEXT    NOT NULL UNIQUE,
${NEW_COLS_SQL()}
  -- real calendar date only (GLOB checks the shape, date() rejects 31 February; IS NOT NULL also rejects month 13, because date() answers NULL and a NULL CHECK would pass)
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK (length(trim(description)) > 0),
  -- the cost of a sale is exactly quantity x unit cost (no rounding exists here); what was paid is the gross amount minus the discounts
  CHECK (cogs_cents = qty * unit_cost_cents),
  CHECK (revenue_cents >= 0),
${DISCOUNT_CHECKS()},
  -- a void always records when and why; a posted sale never has them
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);`,
      patch: (name, sql) => {
        if (name !== 'trg_print_sales_immutable') return sql;
        let t = replaceOnce(sql, 'unit_cost_cents, revenue_cents, cogs_cents,\n                 notes,', `unit_cost_cents, revenue_cents, cogs_cents,
                 list_unit_price_cents, unit_discount_cents, line_discount_cents, price_reduction_cents, bill_discount_cents,
                 notes,`, 'trg_print_sales_immutable columns');
        t = replaceOnce(t, '  OR NEW.cogs_cents IS NOT OLD.cogs_cents\n', `  OR NEW.cogs_cents IS NOT OLD.cogs_cents
  OR NEW.unit_discount_cents IS NOT OLD.unit_discount_cents
  OR NEW.line_discount_cents IS NOT OLD.line_discount_cents
  OR NEW.price_reduction_cents IS NOT OLD.price_reduction_cents
  OR NEW.bill_discount_cents IS NOT OLD.bill_discount_cents
  OR (NEW.list_unit_price_cents IS NOT OLD.list_unit_price_cents
      AND NOT (OLD.list_unit_price_cents = -1 AND NEW.list_unit_price_cents = OLD.unit_price_cents))
`, 'trg_print_sales_immutable conditions');
        return t;
      },
      newTriggers: [
        {
          name: 'trg_print_sales_list_price_default',
          sql: `-- compatibility: a sale inserted without a list price (the -1 default) is sold at its own price
CREATE TRIGGER trg_print_sales_list_price_default
AFTER INSERT ON print_sales
WHEN NEW.list_unit_price_cents = -1
BEGIN
  UPDATE print_sales SET list_unit_price_cents = NEW.unit_price_cents WHERE id = NEW.id;
END;`,
        },
      ],
      tail: '',
    };
    return rebuild(spec, db);
  } finally {
    db.close();
  }
}

export const OUTPUTS = {
  '027_sale_items_discounts.sql': () => generate027(),
  '028_print_sales_discounts.sql': () => generate028(),
} as const;

if (import.meta.main) {
  for (const [file, gen] of Object.entries(OUTPUTS)) writeFileSync(join(MIGRATIONS_DIR, file), gen());
  console.log('written', Object.keys(OUTPUTS).join(', '));
}
