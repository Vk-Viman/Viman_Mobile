-- 015_category_per_book.sql
-- Category management: a category name is unique PER BOOK (case-insensitive) instead of globally, and a category
-- can never be deleted (it is retired with active = 0). Ids, is_default, active, timestamps and every
-- products.category_id link are preserved exactly. Forward-only. See migrations/README.md.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE categories_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL COLLATE NOCASE,
  book        TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(trim(name)) > 0)
);

INSERT INTO categories_new (id, name, book, is_default, active, created_at, updated_at)
SELECT id, name, book, is_default, active, created_at, updated_at FROM categories ORDER BY id;

-- Keep the AUTOINCREMENT counter where it was, so an id is never reused.
UPDATE sqlite_sequence SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'categories'), 0))
WHERE name = 'categories_new';

-- Abort (and roll the whole migration back) if the copy lost or changed any row.
CREATE TEMP TABLE _mig015_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig015_guard SELECT CASE
  WHEN (SELECT COUNT(*) FROM categories) = (SELECT COUNT(*) FROM categories_new)
   AND NOT EXISTS (SELECT 1 FROM categories o LEFT JOIN categories_new n ON n.id = o.id
                   WHERE n.id IS NULL OR n.name IS NOT o.name OR n.book IS NOT o.book OR n.is_default IS NOT o.is_default
                      OR n.active IS NOT o.active OR n.created_at IS NOT o.created_at OR n.updated_at IS NOT o.updated_at)
  THEN 1 ELSE 0 END;

DROP TABLE categories;
ALTER TABLE categories_new RENAME TO categories;

CREATE UNIQUE INDEX ux_categories_book_name ON categories(book, name COLLATE NOCASE);

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

CREATE TRIGGER trg_categories_no_delete
BEFORE DELETE ON categories
BEGIN
  SELECT RAISE(ABORT, 'CATEGORY_DELETE_FORBIDDEN');
END;

-- Every product must still point at an existing category: abort the migration otherwise.
INSERT INTO _mig015_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DROP TABLE _mig015_guard;
