-- Phase 5: sales, sale lines, sales returns (+ lines) and the link from damaged-return stock losses.
-- Runner wraps this file in a transaction. Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).
--
-- WHY this file exists: the shop's biggest daily activity is selling things and taking some of them back.
-- Every rule below is enforced by the DATABASE itself (not only by the app), so that no bug, retry or manual
-- edit can quietly corrupt the sales history:
--   * a sale is never edited or deleted; the only change allowed is posted -> void (rule R1);
--   * the money and cost of each line are frozen when it is sold (C5: cost snapshot);
--   * a return cannot be dated before its sale (R-RD), nothing can be dated in the future (R-FD),
--     and a return can never bring back more than was sold;
--   * no stock movement or cash entry is written here: the inventory engine and the cash service do that.
-- NULL-in-CHECK: SQLite treats a CHECK that evaluates to NULL as "passed", so every CHECK that touches a
-- nullable column says IS NOT NULL explicitly.

-- ---------------------------------------------------------------------------------------------
-- sales: one row per receipt. A mixed cart is split by book, so one cart can create a shop sale and a
-- telecom sale that share a client_ref (hence UNIQUE (client_ref, book), not UNIQUE (client_ref)).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  book           TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  status         TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  notes          TEXT    NOT NULL DEFAULT '',
  client_ref     TEXT    NOT NULL,
  voided_at      TEXT,
  void_reason    TEXT,
  UNIQUE (client_ref, book),
  -- real calendar date only (GLOB checks the shape, date() rejects 31 February)
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  -- a void always records when and why
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_sales_business_date ON sales(business_date);
CREATE INDEX idx_sales_book_business_date ON sales(book, business_date);

-- R-FD: a sale cannot be dated after today (Colombo).
CREATE TRIGGER trg_sales_future_date
BEFORE INSERT ON sales
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

-- The owner-entered date is what reports use; changing it later would silently move profit between days.
CREATE TRIGGER trg_sales_business_date_immutable
BEFORE UPDATE OF business_date ON sales
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

-- The posting time is the server's clock at save; it proves when the record was really made.
CREATE TRIGGER trg_sales_posted_at_immutable
BEFORE UPDATE OF posted_at ON sales
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back (R1).
CREATE TRIGGER trg_sales_immutable
BEFORE UPDATE OF id, book, total_cents, notes, client_ref, status, voided_at, void_reason ON sales
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.total_cents IS NOT OLD.total_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'SALE_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------------------------
-- sale_items: the lines of a sale. cogs_cents is the stock value removed at the weighted average when
-- sold and never changes (C5), so profit of an old sale never shifts when later purchases change the cost.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sale_items (
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
  returned_qty      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sale_id, line_no),
  -- the line total is exactly quantity x price, no rounding anywhere
  CHECK (revenue_cents = qty * unit_price_cents),
  -- you cannot take back more than you sold
  CHECK (returned_qty BETWEEN 0 AND qty)
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- Only returned_qty may change, and only upwards (a return can never be "un-returned").
CREATE TRIGGER trg_sale_items_immutable
BEFORE UPDATE ON sale_items
WHEN NEW.id IS NOT OLD.id
  OR NEW.sale_id IS NOT OLD.sale_id
  OR NEW.line_no IS NOT OLD.line_no
  OR NEW.line_type IS NOT OLD.line_type
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.description IS NOT OLD.description
  OR NEW.qty IS NOT OLD.qty
  OR NEW.unit_price_cents IS NOT OLD.unit_price_cents
  OR NEW.unit_cost_cents IS NOT OLD.unit_cost_cents
  OR NEW.revenue_cents IS NOT OLD.revenue_cents
  OR NEW.cogs_cents IS NOT OLD.cogs_cents
  OR NEW.returned_qty < OLD.returned_qty
BEGIN
  SELECT RAISE(ABORT, 'SALE_ITEM_IMMUTABLE');
END;

-- Books never mix: goods lines belong to Shop sales, scratch-card lines to Telecom sales, and the
-- product must belong to the same book as the sale.
CREATE TRIGGER trg_sale_items_book_mismatch
BEFORE INSERT ON sale_items
WHEN NOT EXISTS (
  SELECT 1 FROM sales s JOIN products p ON p.id = NEW.product_id
   WHERE s.id = NEW.sale_id
     AND p.book = s.book
     AND ((NEW.line_type = 'goods' AND s.book = 'shop') OR (NEW.line_type = 'card' AND s.book = 'telecom')))
BEGIN
  SELECT RAISE(ABORT, 'SALE_ITEM_BOOK_MISMATCH');
END;

-- ---------------------------------------------------------------------------------------------
-- sales_returns: a customer brings goods back. Append-only: a return is never edited or deleted.
-- refund_cents = money handed back; cogs_reversed_cents = cost taken out of cost of goods sold.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales_returns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id             INTEGER NOT NULL REFERENCES sales(id),
  business_date       TEXT    NOT NULL,
  posted_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  refund_cents        INTEGER NOT NULL CHECK (refund_cents >= 0),
  cogs_reversed_cents INTEGER NOT NULL CHECK (cogs_reversed_cents >= 0),
  note                TEXT    NOT NULL DEFAULT '',
  client_ref          TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date)
);
CREATE INDEX idx_sales_returns_sale ON sales_returns(sale_id);
CREATE INDEX idx_sales_returns_business_date ON sales_returns(business_date);
CREATE INDEX idx_sales_returns_posted_at ON sales_returns(posted_at);

-- R-FD
CREATE TRIGGER trg_sales_returns_future_date
BEFORE INSERT ON sales_returns
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

-- R-RD: goods cannot come back before they were sold.
CREATE TRIGGER trg_sales_returns_before_original
BEFORE INSERT ON sales_returns
WHEN NEW.business_date < (SELECT business_date FROM sales WHERE id = NEW.sale_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_BEFORE_ORIGINAL_DATE');
END;

-- A voided sale is cancelled already; returning goods against it would count the refund twice.
CREATE TRIGGER trg_sales_returns_void
BEFORE INSERT ON sales_returns
WHEN (SELECT status FROM sales WHERE id = NEW.sale_id) = 'void'
BEGIN
  SELECT RAISE(ABORT, 'SALE_VOID');
END;

CREATE TRIGGER trg_sales_returns_no_update BEFORE UPDATE ON sales_returns
BEGIN
  SELECT RAISE(ABORT, 'sales_returns is append-only');
END;

CREATE TRIGGER trg_sales_returns_no_delete BEFORE DELETE ON sales_returns
BEGIN
  SELECT RAISE(ABORT, 'sales_returns is append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- sales_return_items: which sale line, how many, resalable or damaged, and the revenue/cost portions
-- reversed. Append-only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales_return_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_return_id  INTEGER NOT NULL REFERENCES sales_returns(id),
  sale_item_id     INTEGER NOT NULL REFERENCES sale_items(id),
  qty              INTEGER NOT NULL CHECK (qty >= 1),
  resalable        INTEGER NOT NULL CHECK (resalable IN (0,1)),
  revenue_cents    INTEGER NOT NULL CHECK (revenue_cents >= 0),
  cogs_cents       INTEGER NOT NULL CHECK (cogs_cents >= 0)
);
CREATE INDEX idx_sales_return_items_return ON sales_return_items(sales_return_id);
CREATE INDEX idx_sales_return_items_item ON sales_return_items(sale_item_id);

-- A return line must belong to the same sale as its return header.
CREATE TRIGGER trg_sales_return_items_mismatch
BEFORE INSERT ON sales_return_items
WHEN (SELECT sale_id FROM sale_items WHERE id = NEW.sale_item_id)
     IS NOT (SELECT sale_id FROM sales_returns WHERE id = NEW.sales_return_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_ITEM_MISMATCH');
END;

-- Backstop: the app checks quantities first, but the database refuses to take back more than was sold.
-- The service adds to sale_items.returned_qty AFTER inserting the return lines, so at insert time
-- "still returnable" = qty - returned_qty. (Lines of another sale are left to the mismatch trigger.)
CREATE TRIGGER trg_sales_return_items_exceeds
BEFORE INSERT ON sales_return_items
WHEN (SELECT sale_id FROM sale_items WHERE id = NEW.sale_item_id)
       IS (SELECT sale_id FROM sales_returns WHERE id = NEW.sales_return_id)
 AND NEW.qty > (SELECT qty - returned_qty FROM sale_items WHERE id = NEW.sale_item_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_EXCEEDS_SOLD');
END;

CREATE TRIGGER trg_sales_return_items_no_update BEFORE UPDATE ON sales_return_items
BEGIN
  SELECT RAISE(ABORT, 'sales_return_items is append-only');
END;

CREATE TRIGGER trg_sales_return_items_no_delete BEFORE DELETE ON sales_return_items
BEGIN
  SELECT RAISE(ABORT, 'sales_return_items is append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- stock_losses: a damaged return is written off as exactly one loss row per damaged line (counted once,
-- BUSINESS_RULES section 4 / R2). sales_return_id says which return caused it. Phase 4's
-- STOCK_LOSS_IMMUTABLE trigger is untouched.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE stock_losses ADD COLUMN sales_return_id INTEGER REFERENCES sales_returns(id);
CREATE INDEX idx_stock_losses_sales_return ON stock_losses(sales_return_id);

-- A loss has a return link if and only if it came from a damaged return.
CREATE TRIGGER trg_stock_losses_damaged_return_link
BEFORE INSERT ON stock_losses
WHEN (NEW.source = 'damaged_return') <> (NEW.sales_return_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'DAMAGED_RETURN_LINK');
END;

-- The write-off carries the return's own business date (so R-RD/R-FD hold by construction).
CREATE TRIGGER trg_stock_losses_damaged_return_date
BEFORE INSERT ON stock_losses
WHEN NEW.source = 'damaged_return' AND NEW.sales_return_id IS NOT NULL
 AND NEW.business_date IS NOT (SELECT business_date FROM sales_returns WHERE id = NEW.sales_return_id)
BEGIN
  SELECT RAISE(ABORT, 'DAMAGED_RETURN_DATE');
END;

-- A damaged return is, by definition, a "damaged" loss.
CREATE TRIGGER trg_stock_losses_damaged_return_reason
BEFORE INSERT ON stock_losses
WHEN NEW.source = 'damaged_return' AND NEW.reason <> 'damaged'
BEGIN
  SELECT RAISE(ABORT, 'DAMAGED_RETURN_REASON');
END;

-- The link to the return is frozen once written (the older immutability trigger predates this column).
CREATE TRIGGER trg_stock_losses_sales_return_immutable
BEFORE UPDATE OF sales_return_id ON stock_losses
WHEN NEW.sales_return_id IS NOT OLD.sales_return_id
BEGIN
  SELECT RAISE(ABORT, 'STOCK_LOSS_IMMUTABLE');
END;
