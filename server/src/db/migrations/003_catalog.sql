-- Phase 2: catalog (categories, products, suppliers). Runner wraps this file in a transaction.

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  book        TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(trim(name)) > 0)
);

INSERT INTO categories (name, book, is_default) VALUES
  ('Phone Accessories', 'shop', 1),
  ('Tempered Glass',    'shop', 1),
  ('Phone Covers',      'shop', 1),
  ('Electronics',       'shop', 1),
  ('Stationery',        'shop', 1),
  ('Snacks and Drinks', 'shop', 1),
  ('Party Items',       'shop', 1),
  ('Perfume',           'shop', 1),
  ('Pooja Items',       'shop', 1),
  ('SIM',               'shop', 1),
  ('Other',             'shop', 1),
  ('Scratch Cards',     'telecom', 1);

CREATE TRIGGER trg_categories_default_locked
BEFORE UPDATE OF name, book ON categories
WHEN OLD.is_default = 1 AND (NEW.name <> OLD.name COLLATE BINARY OR NEW.book IS NOT OLD.book)
BEGIN
  SELECT RAISE(ABORT, 'DEFAULT_CATEGORY_LOCKED');
END;

CREATE TRIGGER trg_categories_book_has_products
BEFORE UPDATE OF book ON categories
WHEN NEW.book <> OLD.book AND EXISTS (SELECT 1 FROM products WHERE category_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'CATEGORY_HAS_PRODUCTS');
END;

CREATE TABLE suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  phone       TEXT    NOT NULL DEFAULT '',
  notes       TEXT    NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(trim(name)) > 0)
);

CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    COLLATE NOCASE UNIQUE,
  name              TEXT    NOT NULL COLLATE NOCASE UNIQUE,
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
  CHECK (length(trim(name)) > 0),
  CHECK (code IS NULL OR length(code) > 0),
  CHECK (qty_on_hand >= 0 AND stock_value_cents >= 0),
  CHECK (kind = 'stock' OR (qty_on_hand = 0 AND stock_value_cents = 0)),
  CHECK (sell_price_cents >= 0 AND min_price_cents >= 0 AND min_price_cents <= sell_price_cents AND reorder_level >= 0)
);

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
