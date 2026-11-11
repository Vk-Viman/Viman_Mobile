-- Phase 3: stock movements (+ stock cache trigger), cash ledger, purchases, purchase returns,
-- audit_logs business-date columns. Runner wraps this file in a transaction.
-- Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).

-- ---------------------------------------------------------------------------------------------
-- stock_movements: append-only inventory ledger
-- ---------------------------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  business_date     TEXT    NOT NULL,
  posted_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type              TEXT    NOT NULL CHECK (type IN (
    'opening','purchase','purchase_return','purchase_void','sale','sale_return','sale_void',
    'personal_use','loss','stocktake_gain','stocktake_loss','adjustment')),
  qty_delta         INTEGER NOT NULL,
  value_delta_cents INTEGER NOT NULL,
  unit_cost_cents   INTEGER,
  ref_table         TEXT,
  ref_id            INTEGER,
  reason            TEXT    NOT NULL DEFAULT '',
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (qty_delta <> 0 OR value_delta_cents <> 0)
);
CREATE INDEX idx_stock_movements_product_posted ON stock_movements(product_id, posted_at);
CREATE INDEX idx_stock_movements_business_date ON stock_movements(business_date);
CREATE INDEX idx_stock_movements_ref ON stock_movements(ref_table, ref_id);

CREATE TRIGGER trg_stock_movements_future_date
BEFORE INSERT ON stock_movements
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- Stock cache: maintained only by the database. The products CHECKs (qty >= 0, value >= 0,
-- services hold no stock) abort any movement that would break them. Only the two cache columns
-- are written, so the Phase 2 BEFORE UPDATE OF kind/book/category triggers do not fire.
CREATE TRIGGER trg_stock_movements_cache
AFTER INSERT ON stock_movements
BEGIN
  UPDATE products
     SET qty_on_hand = qty_on_hand + NEW.qty_delta,
         stock_value_cents = stock_value_cents + NEW.value_delta_cents
   WHERE id = NEW.product_id;
END;

-- Backstop: quantity reaching 0 while value remains is refused (sweep the value first).
CREATE TRIGGER trg_products_value_without_qty
BEFORE UPDATE OF qty_on_hand, stock_value_cents ON products
WHEN NEW.qty_on_hand = 0 AND NEW.stock_value_cents <> 0
BEGIN
  SELECT RAISE(ABORT, 'STOCK_VALUE_WITHOUT_QTY');
END;

-- ---------------------------------------------------------------------------------------------
-- cash_entries: append-only cash ledger (signed amounts)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash_entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  book                TEXT    NOT NULL CHECK (book IN ('shop','telecom','icecream')),
  business_date       TEXT    NOT NULL,
  posted_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type                TEXT    NOT NULL CHECK (type IN (
    'sale_goods','sale_service','sale_refund','card_sale','card_refund','reload_collection',
    'ezcash_collection','provider_topup','wallet_topup','purchase_payment','purchase_refund',
    'expense','expense_refund','icecream_sale','icecream_materials_payment',
    'icecream_electricity_payment','icecream_other_cost','printing_supplies','cash_adjustment',
    'opening_balance','capital','drawing_cash','transfer_out','transfer_in')),
  amount_cents        INTEGER NOT NULL,
  fund                TEXT    CHECK (fund IS NULL OR fund IN ('cost','electricity','profit')),
  ref_table           TEXT,
  ref_id              INTEGER,
  transfer_id         INTEGER,
  reverses_entry_id   INTEGER REFERENCES cash_entries(id),
  note                TEXT,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK ((book = 'icecream') = (fund IS NOT NULL)),
  CHECK (type NOT LIKE 'icecream_%' OR book = 'icecream'),
  CHECK (type NOT IN ('purchase_payment','purchase_refund') OR book IN ('shop','telecom'))
);
CREATE INDEX idx_cash_entries_book_date ON cash_entries(book, business_date);
CREATE INDEX idx_cash_entries_ref ON cash_entries(ref_table, ref_id);
CREATE INDEX idx_cash_entries_posted_at ON cash_entries(posted_at);
CREATE INDEX idx_cash_entries_reverses ON cash_entries(reverses_entry_id);
CREATE INDEX idx_cash_entries_transfer ON cash_entries(transfer_id);

CREATE TRIGGER trg_cash_entries_future_date
BEFORE INSERT ON cash_entries
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_cash_entries_no_update BEFORE UPDATE ON cash_entries
BEGIN
  SELECT RAISE(ABORT, 'cash_entries is append-only');
END;

CREATE TRIGGER trg_cash_entries_no_delete BEFORE DELETE ON cash_entries
BEGIN
  SELECT RAISE(ABORT, 'cash_entries is append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- purchases
-- ---------------------------------------------------------------------------------------------
CREATE TABLE purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  supplier_id    INTEGER REFERENCES suppliers(id),
  bill_no        TEXT    NOT NULL DEFAULT '',
  book           TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  status         TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  client_ref     TEXT    NOT NULL UNIQUE,
  notes          TEXT    NOT NULL DEFAULT '',
  voided_at      TEXT,
  void_reason    TEXT,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_purchases_business_date ON purchases(business_date);
CREATE INDEX idx_purchases_posted_at ON purchases(posted_at);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_book_date ON purchases(book, business_date);

CREATE TRIGGER trg_purchases_future_date
BEFORE INSERT ON purchases
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_purchases_business_date_immutable
BEFORE UPDATE OF business_date ON purchases
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_purchases_posted_at_immutable
BEFORE UPDATE OF posted_at ON purchases
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back.
CREATE TRIGGER trg_purchases_immutable
BEFORE UPDATE OF id, supplier_id, bill_no, book, total_cents, notes, client_ref, status, voided_at, void_reason ON purchases
WHEN NEW.id IS NOT OLD.id
  OR NEW.supplier_id IS NOT OLD.supplier_id
  OR NEW.bill_no IS NOT OLD.bill_no
  OR NEW.book IS NOT OLD.book
  OR NEW.total_cents IS NOT OLD.total_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------------------------
-- purchase_items
-- ---------------------------------------------------------------------------------------------
CREATE TABLE purchase_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id       INTEGER NOT NULL REFERENCES purchases(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  packs             INTEGER NOT NULL CHECK (packs >= 1),
  pack_size         INTEGER NOT NULL CHECK (pack_size >= 1),
  units             INTEGER NOT NULL,
  line_total_cents  INTEGER NOT NULL CHECK (line_total_cents >= 0),
  returned_units    INTEGER NOT NULL DEFAULT 0,
  CHECK (units = packs * pack_size),
  CHECK (returned_units BETWEEN 0 AND units)
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_product ON purchase_items(product_id);

CREATE TRIGGER trg_purchase_items_immutable
BEFORE UPDATE ON purchase_items
WHEN NEW.id IS NOT OLD.id
  OR NEW.purchase_id IS NOT OLD.purchase_id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.packs IS NOT OLD.packs
  OR NEW.pack_size IS NOT OLD.pack_size
  OR NEW.units IS NOT OLD.units
  OR NEW.line_total_cents IS NOT OLD.line_total_cents
  OR NEW.returned_units < OLD.returned_units
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_ITEM_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------------------------
-- purchase_returns (+ items): append-only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE purchase_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id    INTEGER NOT NULL REFERENCES purchases(id),
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  refund_cents   INTEGER NOT NULL CHECK (refund_cents >= 0),
  note           TEXT    NOT NULL DEFAULT '',
  client_ref     TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date)
);
CREATE INDEX idx_purchase_returns_purchase ON purchase_returns(purchase_id);
CREATE INDEX idx_purchase_returns_business_date ON purchase_returns(business_date);
CREATE INDEX idx_purchase_returns_posted_at ON purchase_returns(posted_at);

CREATE TRIGGER trg_purchase_returns_future_date
BEFORE INSERT ON purchase_returns
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_purchase_returns_before_original
BEFORE INSERT ON purchase_returns
WHEN NEW.business_date < (SELECT business_date FROM purchases WHERE id = NEW.purchase_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_BEFORE_ORIGINAL_DATE');
END;

CREATE TRIGGER trg_purchase_returns_void
BEFORE INSERT ON purchase_returns
WHEN (SELECT status FROM purchases WHERE id = NEW.purchase_id) = 'void'
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_VOID');
END;

CREATE TRIGGER trg_purchase_returns_no_update BEFORE UPDATE ON purchase_returns
BEGIN
  SELECT RAISE(ABORT, 'purchase_returns is append-only');
END;

CREATE TRIGGER trg_purchase_returns_no_delete BEFORE DELETE ON purchase_returns
BEGIN
  SELECT RAISE(ABORT, 'purchase_returns is append-only');
END;

CREATE TABLE purchase_return_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_return_id  INTEGER NOT NULL REFERENCES purchase_returns(id),
  purchase_item_id    INTEGER NOT NULL REFERENCES purchase_items(id),
  units               INTEGER NOT NULL CHECK (units >= 1),
  value_cents         INTEGER NOT NULL CHECK (value_cents >= 0)
);
CREATE INDEX idx_purchase_return_items_return ON purchase_return_items(purchase_return_id);
CREATE INDEX idx_purchase_return_items_item ON purchase_return_items(purchase_item_id);

CREATE TRIGGER trg_purchase_return_items_mismatch
BEFORE INSERT ON purchase_return_items
WHEN (SELECT purchase_id FROM purchase_items WHERE id = NEW.purchase_item_id)
     IS NOT (SELECT purchase_id FROM purchase_returns WHERE id = NEW.purchase_return_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_ITEM_MISMATCH');
END;

CREATE TRIGGER trg_purchase_return_items_no_update BEFORE UPDATE ON purchase_return_items
BEGIN
  SELECT RAISE(ABORT, 'purchase_return_items is append-only');
END;

CREATE TRIGGER trg_purchase_return_items_no_delete BEFORE DELETE ON purchase_return_items
BEGIN
  SELECT RAISE(ABORT, 'purchase_return_items is append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- audit_logs: business date + backdated flag (append-only triggers from 002 stay untouched)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE audit_logs ADD COLUMN business_date TEXT;
ALTER TABLE audit_logs ADD COLUMN backdated INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_audit_logs_business_date ON audit_logs(business_date);
