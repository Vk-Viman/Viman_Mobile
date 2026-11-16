-- 023_product_name_per_category.sql
-- A product name is unique PER CATEGORY (case-insensitive) instead of across the whole shop, so the same name
-- (for example "100/-") can exist under "Dialog Crds" and under "Airtel Crds". Product CODE stays globally unique.
-- Ids, every column value and every historical reference (stock movements, sale items, purchase items, ...) are
-- preserved exactly. Forward-only. See migrations/README.md.
--
-- Same technique as 015: the runner executes this file inside a transaction with foreign_keys ON, where that
-- setting cannot be switched off. So the table is NOT renamed: the rows are parked in a TEMP table, `products`
-- is dropped and re-created under its own name, and the rows are re-inserted with their ids. Dropping the
-- parent counts the child rows as deferred violations; re-inserting the same ids clears them again, and the
-- migration aborts (rolls back) if anything is left over. Dropping the table also drops its indexes and
-- triggers, so every one of them is re-created below (003: idx_products_category, idx_products_active_name,
-- trg_products_book_insert, trg_products_book_update, trg_products_kind_immutable; 004:
-- trg_products_value_without_qty).

PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE _mig023_products AS
SELECT id, code, name, description, category_id, kind, book, sell_price_cents, min_price_cents, reorder_level,
       active, qty_on_hand, stock_value_cents, created_at, updated_at FROM products;

-- Keep the AUTOINCREMENT counter where it was, so an id is never reused.
CREATE TEMP TABLE _mig023_seq AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'products'), 0) AS seq;

DROP TABLE products;

CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    COLLATE NOCASE UNIQUE,
  name              TEXT    NOT NULL COLLATE NOCASE,
  description       TEXT    NOT NULL DEFAULT '',
  category_id       INTEGER NOT NULL REFERENCES categories(id),
  kind              TEXT    NOT NULL CHECK (kind IN ('stock','service')),
  book              TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  sell_price_cents  INTEGER NOT NULL,
  min_price_cents   INTEGER NOT NULL,
  reorder_level     INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  qty_on_hand       INTEGER NOT NULL DEFAULT 0,
  stock_value_cents INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (category_id, name),
  CHECK (length(trim(name)) > 0),
  CHECK (code IS NULL OR length(code) > 0),
  CHECK (qty_on_hand >= 0 AND stock_value_cents >= 0),
  CHECK (kind = 'stock' OR (qty_on_hand = 0 AND stock_value_cents = 0)),
  CHECK (sell_price_cents >= 0 AND min_price_cents >= 0 AND min_price_cents <= sell_price_cents AND reorder_level >= 0)
);

-- The triggers are re-created only after the copy, so none of them fires while the rows are copied back.
INSERT INTO products (id, code, name, description, category_id, kind, book, sell_price_cents, min_price_cents,
                      reorder_level, active, qty_on_hand, stock_value_cents, created_at, updated_at)
SELECT id, code, name, description, category_id, kind, book, sell_price_cents, min_price_cents,
       reorder_level, active, qty_on_hand, stock_value_cents, created_at, updated_at
  FROM _mig023_products ORDER BY id;

UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM _mig023_seq)) WHERE name = 'products';

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_active_name ON products(active, name);

CREATE TRIGGER trg_products_book_insert
BEFORE INSERT ON products
WHEN NEW.book IS NOT (SELECT book FROM categories WHERE id = NEW.category_id)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_BOOK_MISMATCH');
END;

CREATE TRIGGER trg_products_book_update
BEFORE UPDATE OF category_id, book ON products
WHEN NEW.book IS NOT (SELECT book FROM categories WHERE id = NEW.category_id)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_BOOK_MISMATCH');
END;

CREATE TRIGGER trg_products_kind_immutable
BEFORE UPDATE OF kind, book ON products
WHEN NEW.kind IS NOT OLD.kind OR NEW.book IS NOT OLD.book
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_KIND_IMMUTABLE');
END;

CREATE TRIGGER trg_products_value_without_qty
BEFORE UPDATE OF qty_on_hand, stock_value_cents ON products
WHEN NEW.qty_on_hand = 0 AND NEW.stock_value_cents <> 0
BEGIN
  SELECT RAISE(ABORT, 'STOCK_VALUE_WITHOUT_QTY');
END;

-- Abort (roll the whole migration back) if the copy lost or changed any row, or any child row lost its product.
CREATE TEMP TABLE _mig023_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig023_guard SELECT CASE
  WHEN (SELECT COUNT(*) FROM products) = (SELECT COUNT(*) FROM _mig023_products)
   AND NOT EXISTS (SELECT 1 FROM _mig023_products o LEFT JOIN products n ON n.id = o.id
                   WHERE n.id IS NULL OR n.code IS NOT o.code OR n.name IS NOT o.name OR n.description IS NOT o.description
                      OR n.category_id IS NOT o.category_id OR n.kind IS NOT o.kind OR n.book IS NOT o.book
                      OR n.sell_price_cents IS NOT o.sell_price_cents OR n.min_price_cents IS NOT o.min_price_cents
                      OR n.reorder_level IS NOT o.reorder_level OR n.active IS NOT o.active
                      OR n.qty_on_hand IS NOT o.qty_on_hand OR n.stock_value_cents IS NOT o.stock_value_cents
                      OR n.created_at IS NOT o.created_at OR n.updated_at IS NOT o.updated_at)
   AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  THEN 1 ELSE 0 END;

DROP TABLE _mig023_guard;
DROP TABLE _mig023_seq;
DROP TABLE _mig023_products;
