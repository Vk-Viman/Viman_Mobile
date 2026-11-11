-- 010_printing.sql - Phase 7: printing service types, print sales and printing supplies (BUSINESS_RULES section 6, R12).
-- Runner wraps this file in a transaction. Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).
--
-- WHY this file exists: the shop sells prints and photocopies (revenue, with a standard cost per page) and buys
-- paper/toner (a cash-out that is NOT an expense). Every rule below is enforced by the DATABASE as well as by
-- the service, so no bug, retry or hand-typed SQL can quietly corrupt the printing history:
--   * a print sale snapshots its price and its standard cost, and revenue/cost always equal qty x unit amounts;
--   * a sale or supply is never edited or deleted; the only change allowed is posted -> void (R1);
--   * nothing can be dated in the future (R-FD); the business date and the posting time never change;
--   * the type CODE never changes and types are never deleted (deactivate instead).
-- All money is whole cents (INTEGER). NULL-in-CHECK: SQLite treats a CHECK that evaluates to NULL as "passed",
-- so every CHECK that touches a nullable column says IS NOT NULL explicitly.

-- ---------------------------------------------------------------------------------------------
-- print_service_types: the price list (editable: name, price, cost, active; the code is permanent)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE print_service_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  price_cents  INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 1000000000),
  cost_cents   INTEGER NOT NULL CHECK (cost_cents BETWEEN 0 AND 1000000000),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- GLOB is case-sensitive: only A-Z, 0-9 and underscore, 2 to 20 characters
  CHECK (length(code) BETWEEN 2 AND 20 AND code NOT GLOB '*[^A-Z0-9_]*'),
  CHECK (length(trim(name)) > 0)
);

-- Initial price list = the seven defaults of Settings > Printing defaults (settings.service.ts DEFAULTS).
-- From now on this table is the operational source of truth; the settings JSON is only the starting point.
INSERT INTO print_service_types (code, name, price_cents, cost_cents, sort_order) VALUES
  ('BW_1S',    'B/W print – one side',          1500, 650, 1),
  ('BW_2S',    'B/W print – double side',       2500, 900, 2),
  ('CLR_1S',   'Colour print – one side',       2000, 650, 3),
  ('CLR_2S',   'Colour print – double side',    3000, 900, 4),
  ('PC_BW_1S', 'Photocopy B/W – one side',      1000, 650, 5),
  ('PC_BW_2S', 'Photocopy B/W – double side',   1500, 900, 6),
  ('CUSTOM',   'Custom image print',            4000, 650, 7);

-- Past sales point at the type by id and copy its code/name/price/cost, so the code must never change.
CREATE TRIGGER trg_print_service_types_code_immutable
BEFORE UPDATE OF code ON print_service_types
WHEN NEW.code <> OLD.code
BEGIN
  SELECT RAISE(ABORT, 'PRINT_TYPE_CODE_IMMUTABLE');
END;

-- Types are retired with active = 0, never deleted (history keeps pointing at them).
CREATE TRIGGER trg_print_service_types_no_delete
BEFORE DELETE ON print_service_types
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- print_sales: one row per quick-entry sale (R12: standard cost is snapshotted at the time of sale)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE print_sales (
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
  -- real calendar date only (GLOB checks the shape, date() rejects 31 February; IS NOT NULL also rejects month 13, because date() answers NULL and a NULL CHECK would pass)
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK (length(trim(description)) > 0),
  -- the money of a sale is always exactly quantity x unit amount (no rounding exists here)
  CHECK (revenue_cents = qty * unit_price_cents AND cogs_cents = qty * unit_cost_cents),
  -- a void always records when and why; a posted sale never has them
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_print_sales_business_date ON print_sales(business_date);
CREATE INDEX idx_print_sales_type_date ON print_sales(service_type_id, business_date);
CREATE INDEX idx_print_sales_posted_at ON print_sales(posted_at);

-- R-FD: a print sale cannot be dated after today (Colombo).
CREATE TRIGGER trg_print_sales_future_date
BEFORE INSERT ON print_sales
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

-- Backstop for the service's check: a retired (inactive) service type cannot be sold.
CREATE TRIGGER trg_print_sales_type_active
BEFORE INSERT ON print_sales
WHEN (SELECT active FROM print_service_types WHERE id = NEW.service_type_id) = 0
BEGIN
  SELECT RAISE(ABORT, 'SERVICE_TYPE_INACTIVE');
END;

-- The owner-entered date drives reports; changing it later would silently move profit between days.
CREATE TRIGGER trg_print_sales_business_date_immutable
BEFORE UPDATE OF business_date ON print_sales
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

-- The posting time is the server's clock at save; it proves when the record was really made.
CREATE TRIGGER trg_print_sales_posted_at_immutable
BEFORE UPDATE OF posted_at ON print_sales
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back (R1).
CREATE TRIGGER trg_print_sales_immutable
BEFORE UPDATE OF id, service_type_id, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents,
                 notes, client_ref, status, voided_at, void_reason ON print_sales
WHEN NEW.id IS NOT OLD.id
  OR NEW.service_type_id IS NOT OLD.service_type_id
  OR NEW.description IS NOT OLD.description
  OR NEW.qty IS NOT OLD.qty
  OR NEW.unit_price_cents IS NOT OLD.unit_price_cents
  OR NEW.unit_cost_cents IS NOT OLD.unit_cost_cents
  OR NEW.revenue_cents IS NOT OLD.revenue_cents
  OR NEW.cogs_cents IS NOT OLD.cogs_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'PRINT_SALE_IMMUTABLE');
END;

CREATE TRIGGER trg_print_sales_no_delete
BEFORE DELETE ON print_sales
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- printing_supplies: paper / toner purchases. A cash-out with NO profit effect (R12); the later variance
-- report compares the standard cost charged on print sales with this actual spending.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE printing_supplies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  description    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at      TEXT,
  void_reason    TEXT,
  client_ref     TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK (length(trim(description)) > 0),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_printing_supplies_business_date ON printing_supplies(business_date);
CREATE INDEX idx_printing_supplies_posted_at ON printing_supplies(posted_at);

CREATE TRIGGER trg_printing_supplies_future_date
BEFORE INSERT ON printing_supplies
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_printing_supplies_business_date_immutable
BEFORE UPDATE OF business_date ON printing_supplies
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_printing_supplies_posted_at_immutable
BEFORE UPDATE OF posted_at ON printing_supplies
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_printing_supplies_immutable
BEFORE UPDATE OF id, amount_cents, description, client_ref, status, voided_at, void_reason ON printing_supplies
WHEN NEW.id IS NOT OLD.id
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.description IS NOT OLD.description
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'PRINTING_SUPPLY_IMMUTABLE');
END;

CREATE TRIGGER trg_printing_supplies_no_delete
BEFORE DELETE ON printing_supplies
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;
