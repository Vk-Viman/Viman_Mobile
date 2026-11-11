-- Phase 4: stocktakes (+ items), stock losses, owner drawings. Runner wraps this file in a transaction.
-- Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).
-- No stock cache or ledger changes here: movements are written by the Phase 3 inventory engine.

-- ---------------------------------------------------------------------------------------------
-- stocktakes
-- ---------------------------------------------------------------------------------------------
CREATE TABLE stocktakes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  book           TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  status         TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed','void')),
  notes          TEXT    NOT NULL DEFAULT '',
  client_ref     TEXT    NOT NULL UNIQUE,
  completed_at   TEXT,
  voided_at      TEXT,
  void_reason    TEXT,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX idx_stocktakes_business_date ON stocktakes(business_date);
CREATE INDEX idx_stocktakes_book_status ON stocktakes(book, status);

CREATE TRIGGER trg_stocktakes_future_date
BEFORE INSERT ON stocktakes
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_stocktakes_business_date_immutable
BEFORE UPDATE OF business_date ON stocktakes
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_stocktakes_posted_at_immutable
BEFORE UPDATE OF posted_at ON stocktakes
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Allowed: draft -> completed | void, completed -> void. notes only while draft.
-- id, book, client_ref never change; completed_at never changes once set; void data never changes once void.
CREATE TRIGGER trg_stocktakes_transition
BEFORE UPDATE ON stocktakes
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status <> 'draft' AND NEW.notes IS NOT OLD.notes)
  OR NOT (
       (OLD.status = 'draft'     AND NEW.status IN ('draft','completed','void'))
    OR (OLD.status = 'completed' AND NEW.status IN ('completed','void'))
    OR (OLD.status = 'void'      AND NEW.status = 'void')
  )
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
  OR (OLD.status = 'void' AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (NEW.status <> 'void' AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'STOCKTAKE_TRANSITION');
END;

-- ---------------------------------------------------------------------------------------------
-- stocktake_items
-- ---------------------------------------------------------------------------------------------
CREATE TABLE stocktake_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id          INTEGER NOT NULL REFERENCES stocktakes(id),
  product_id            INTEGER NOT NULL REFERENCES products(id),
  counted_qty           INTEGER NOT NULL CHECK (counted_qty >= 0),
  expected_qty          INTEGER,
  difference_qty        INTEGER,
  value_delta_cents     INTEGER,
  gain_unit_cost_cents  INTEGER CHECK (gain_unit_cost_cents IS NULL OR gain_unit_cost_cents >= 0),
  UNIQUE (stocktake_id, product_id)
);
CREATE INDEX idx_stocktake_items_product ON stocktake_items(product_id);

CREATE TRIGGER trg_stocktake_items_insert_draft
BEFORE INSERT ON stocktake_items
WHEN (SELECT status FROM stocktakes WHERE id = NEW.stocktake_id) IS NOT 'draft'
BEGIN
  SELECT RAISE(ABORT, 'STOCKTAKE_NOT_DRAFT');
END;

CREATE TRIGGER trg_stocktake_items_delete_draft
BEFORE DELETE ON stocktake_items
WHEN (SELECT status FROM stocktakes WHERE id = OLD.stocktake_id) IS NOT 'draft'
BEGIN
  SELECT RAISE(ABORT, 'STOCKTAKE_NOT_DRAFT');
END;

CREATE TRIGGER trg_stocktake_items_update_draft
BEFORE UPDATE OF stocktake_id, product_id, counted_qty, gain_unit_cost_cents, expected_qty, difference_qty, value_delta_cents
ON stocktake_items
WHEN (SELECT status FROM stocktakes WHERE id = OLD.stocktake_id) IS NOT 'draft'
  OR (SELECT status FROM stocktakes WHERE id = NEW.stocktake_id) IS NOT 'draft'
BEGIN
  SELECT RAISE(ABORT, 'STOCKTAKE_NOT_DRAFT');
END;

CREATE TRIGGER trg_stocktake_items_product_insert
BEFORE INSERT ON stocktake_items
WHEN NOT EXISTS (
  SELECT 1 FROM products p JOIN stocktakes s ON s.id = NEW.stocktake_id
   WHERE p.id = NEW.product_id AND p.kind = 'stock' AND p.book = s.book)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_NOT_IN_BOOK');
END;

CREATE TRIGGER trg_stocktake_items_product_update
BEFORE UPDATE OF product_id, stocktake_id ON stocktake_items
WHEN NOT EXISTS (
  SELECT 1 FROM products p JOIN stocktakes s ON s.id = NEW.stocktake_id
   WHERE p.id = NEW.product_id AND p.kind = 'stock' AND p.book = s.book)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_NOT_IN_BOOK');
END;

-- ---------------------------------------------------------------------------------------------
-- stock_losses
-- ---------------------------------------------------------------------------------------------
CREATE TABLE stock_losses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  book           TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  qty            INTEGER NOT NULL CHECK (qty >= 1),
  cost_cents     INTEGER NOT NULL CHECK (cost_cents >= 0),
  reason         TEXT    NOT NULL CHECK (reason IN ('damaged','lost','expired','other')),
  note           TEXT    NOT NULL DEFAULT '',
  source         TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','damaged_return')),
  status         TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  client_ref     TEXT    NOT NULL UNIQUE,
  voided_at      TEXT,
  void_reason    TEXT,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_stock_losses_business_date ON stock_losses(business_date);
CREATE INDEX idx_stock_losses_product ON stock_losses(product_id);
CREATE INDEX idx_stock_losses_book_reason ON stock_losses(book, reason);

CREATE TRIGGER trg_stock_losses_future_date
BEFORE INSERT ON stock_losses
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_stock_losses_business_date_immutable
BEFORE UPDATE OF business_date ON stock_losses
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_stock_losses_posted_at_immutable
BEFORE UPDATE OF posted_at ON stock_losses
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back.
CREATE TRIGGER trg_stock_losses_immutable
BEFORE UPDATE OF id, product_id, book, qty, cost_cents, reason, note, source, client_ref, status, voided_at, void_reason ON stock_losses
WHEN NEW.id IS NOT OLD.id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.book IS NOT OLD.book
  OR NEW.qty IS NOT OLD.qty
  OR NEW.cost_cents IS NOT OLD.cost_cents
  OR NEW.reason IS NOT OLD.reason
  OR NEW.note IS NOT OLD.note
  OR NEW.source IS NOT OLD.source
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'STOCK_LOSS_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------------------------
-- owner_drawings (Phase 4 writes only kind = 'goods'; cash drawings arrive in Phases 8/9)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE owner_drawings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  book           TEXT    NOT NULL CHECK (book IN ('shop','telecom','icecream')),
  fund           TEXT    CHECK (fund IS NULL OR fund IN ('cost','electricity','profit')),
  kind           TEXT    NOT NULL CHECK (kind IN ('cash','goods')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  product_id     INTEGER REFERENCES products(id),
  qty            INTEGER,
  note           TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  client_ref     TEXT    NOT NULL UNIQUE,
  voided_at      TEXT,
  void_reason    TEXT,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK ((book = 'icecream') = (fund IS NOT NULL)),
  CHECK (NOT (kind = 'goods' AND book = 'icecream')),
  CHECK (kind <> 'goods' OR (product_id IS NOT NULL AND qty IS NOT NULL AND qty >= 1)),
  CHECK (kind <> 'cash' OR (product_id IS NULL AND qty IS NULL)),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_owner_drawings_business_date ON owner_drawings(business_date);
CREATE INDEX idx_owner_drawings_kind_status ON owner_drawings(kind, status);
CREATE INDEX idx_owner_drawings_product ON owner_drawings(product_id);

CREATE TRIGGER trg_owner_drawings_future_date
BEFORE INSERT ON owner_drawings
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_owner_drawings_business_date_immutable
BEFORE UPDATE OF business_date ON owner_drawings
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_owner_drawings_posted_at_immutable
BEFORE UPDATE OF posted_at ON owner_drawings
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_owner_drawings_immutable
BEFORE UPDATE OF id, book, fund, kind, amount_cents, product_id, qty, note, client_ref, status, voided_at, void_reason ON owner_drawings
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.fund IS NOT OLD.fund
  OR NEW.kind IS NOT OLD.kind
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.qty IS NOT OLD.qty
  OR NEW.note IS NOT OLD.note
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'OWNER_DRAWING_IMMUTABLE');
END;
