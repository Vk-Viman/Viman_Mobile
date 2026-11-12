-- 014_icecream.sql - Phase 10: Ice Cream daily entries, payments and fund moves (BUSINESS_RULES section 10: D1-D4,
-- E1-E5, R1, R9, R-FD, section 12). Runner wraps this file in a transaction. Colombo date = date('now','+330 minutes').
--
-- WHY this file exists: the Ice Cream book is split into three funds (Cost, Electricity, Profit). The owner records
-- one daily entry (sales S, cost allocation C, electricity allocation E; the profit share S - C - E is derived),
-- payments (materials, the whole shop's electricity bill, other costs) and internal fund moves. The ledgers that
-- already exist (cash_entries, icecream_fund_entries, migrations 004 and 012) hold the money; these four tables hold
-- the business records. Charged / Settled / Unspent per line, the profit-eligible limit, D4 splits, D2 guards and
-- excess cost are DERIVED from the posted rows at write/report time - there are no stored running totals.
-- Every rule below is enforced by the database as well as by the service layer:
--   * one POSTED daily entry per business date; its three parts always add up to its sales (sum CHECK);
--   * the profit share may be negative only when the owner confirmed it;
--   * a payment's category can never be "electricity" (E4): the bill is its own kind, a settlement;
--   * a fund move's profit effect, cash-only part and re-label follow the sign rules of section 10.3 / 10.4;
--   * business rows are never edited or deleted - the only change is posted -> void (R1); no future dates (R-FD);
--   * a closed Ice Cream day refuses new records (R9 backstop, also for moves that write no cash entry).
-- NULL-in-CHECK: every CHECK that touches a nullable column says IS NOT NULL / IS NULL explicitly.

-- ---------------------------------------------------------------------------------------------
-- icecream_days: one daily entry (void-and-replace to edit, C9)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE icecream_days (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date           TEXT    NOT NULL,
  posted_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sales_cents             INTEGER NOT NULL CHECK (sales_cents BETWEEN 0 AND 1000000000000),
  cost_alloc_cents        INTEGER NOT NULL CHECK (cost_alloc_cents BETWEEN 0 AND 1000000000000),
  electricity_alloc_cents INTEGER NOT NULL CHECK (electricity_alloc_cents BETWEEN 0 AND 1000000000000),
  profit_share_cents      INTEGER NOT NULL,
  negative_confirmed      INTEGER NOT NULL DEFAULT 0 CHECK (negative_confirmed IN (0,1)),
  notes                   TEXT    NOT NULL DEFAULT '',
  status                  TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at               TEXT,
  void_reason             TEXT,
  client_ref              TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  -- 10.2: the three fund shares always add up to the day's sales
  CHECK (cost_alloc_cents + electricity_alloc_cents + profit_share_cents = sales_cents),
  -- 10.3: a negative profit share needs the owner's explicit confirmation
  CHECK (profit_share_cents >= 0 OR negative_confirmed = 1),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_icecream_days_business_date ON icecream_days(business_date);
CREATE INDEX idx_icecream_days_posted_at ON icecream_days(posted_at);
-- One posted entry per date; voided rows stay as history (void-and-replace).
CREATE UNIQUE INDEX ux_icecream_days_posted ON icecream_days(business_date) WHERE status = 'posted';

CREATE TRIGGER trg_icecream_days_future_date
BEFORE INSERT ON icecream_days
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_icecream_days_business_date_immutable
BEFORE UPDATE OF business_date ON icecream_days
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_days_posted_at_immutable
BEFORE UPDATE OF posted_at ON icecream_days
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back (R1).
CREATE TRIGGER trg_icecream_days_immutable
BEFORE UPDATE OF id, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents, negative_confirmed, notes,
  client_ref, status, voided_at, void_reason ON icecream_days
WHEN NEW.id IS NOT OLD.id
  OR NEW.sales_cents IS NOT OLD.sales_cents
  OR NEW.cost_alloc_cents IS NOT OLD.cost_alloc_cents
  OR NEW.electricity_alloc_cents IS NOT OLD.electricity_alloc_cents
  OR NEW.profit_share_cents IS NOT OLD.profit_share_cents
  OR NEW.negative_confirmed IS NOT OLD.negative_confirmed
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'ICECREAM_DAY_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_days_no_delete
BEFORE DELETE ON icecream_days
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- R9 backstop: a closed Ice Cream day takes no new daily entry and no void of one (a zero-sales entry writes no cash
-- entry, so the cash_entries trigger alone would not catch it).
CREATE TRIGGER trg_icecream_days_day_closed
BEFORE INSERT ON icecream_days
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT RAISE(ABORT, 'DAY_CLOSED');
END;

CREATE TRIGGER trg_icecream_days_day_closed_void
BEFORE UPDATE OF status ON icecream_days
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = OLD.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT RAISE(ABORT, 'DAY_CLOSED');
END;

-- ---------------------------------------------------------------------------------------------
-- icecream_sales: optional item lines of a daily entry (the service checks they add up to sales_cents)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE icecream_sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  icecream_day_id  INTEGER NOT NULL REFERENCES icecream_days(id),
  item_name        TEXT    NOT NULL CHECK (length(trim(item_name)) > 0),
  qty              INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 1000000),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 1000000000000),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents BETWEEN 0 AND 1000000000000),
  CHECK (line_total_cents = qty * unit_price_cents)
);
CREATE INDEX idx_icecream_sales_day ON icecream_sales(icecream_day_id);

CREATE TRIGGER trg_icecream_sales_no_update BEFORE UPDATE ON icecream_sales
BEGIN
  SELECT RAISE(ABORT, 'ICECREAM_ITEM_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_sales_no_delete BEFORE DELETE ON icecream_sales
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- icecream_payments: materials, the shop's electricity bill (E1), other ice-cream costs; the fund is chosen each time
-- ---------------------------------------------------------------------------------------------
CREATE TABLE icecream_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT    NOT NULL,
  posted_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind          TEXT    NOT NULL CHECK (kind IN ('materials','electricity_bill','other_cost')),
  fund          TEXT    NOT NULL CHECK (fund IN ('cost','electricity','profit')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  category      TEXT,
  description   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at     TEXT,
  void_reason   TEXT,
  client_ref    TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  -- E4: the electricity bill is only ever kind = 'electricity_bill'; no category may say "electricity" (any case)
  CHECK (category IS NULL OR lower(trim(category)) <> 'electricity'),
  CHECK (length(trim(description)) > 0),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_icecream_payments_business_date ON icecream_payments(business_date);
CREATE INDEX idx_icecream_payments_posted_at ON icecream_payments(posted_at);

CREATE TRIGGER trg_icecream_payments_future_date
BEFORE INSERT ON icecream_payments
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_icecream_payments_business_date_immutable
BEFORE UPDATE OF business_date ON icecream_payments
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_payments_posted_at_immutable
BEFORE UPDATE OF posted_at ON icecream_payments
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_payments_immutable
BEFORE UPDATE OF id, kind, fund, amount_cents, category, description, client_ref, status, voided_at, void_reason ON icecream_payments
WHEN NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.fund IS NOT OLD.fund
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.category IS NOT OLD.category
  OR NEW.description IS NOT OLD.description
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'ICECREAM_PAYMENT_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_payments_no_delete
BEFORE DELETE ON icecream_payments
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_icecream_payments_day_closed
BEFORE INSERT ON icecream_payments
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT RAISE(ABORT, 'DAY_CLOSED');
END;

-- ---------------------------------------------------------------------------------------------
-- icecream_fund_moves: A -> B inside the Ice Cream book; two fund rows, NO cash entry (10.2, 10.7)
-- profit_effect_cents  = effect on recognized profit (10.3): +eligible part (release), -amount (re-allocation), 0 (re-label)
-- charge_relabel_cents = part of a Cost <-> Electricity move that re-labels the charge between the lines (10.4)
-- cash_only_cents      = part of a move into Profit beyond the profit-eligible limit, posted only after confirmation (D4)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE icecream_fund_moves (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date        TEXT    NOT NULL,
  posted_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  from_fund            TEXT    NOT NULL CHECK (from_fund IN ('cost','electricity','profit')),
  to_fund              TEXT    NOT NULL CHECK (to_fund IN ('cost','electricity','profit')),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  profit_effect_cents  INTEGER NOT NULL,
  charge_relabel_cents INTEGER NOT NULL DEFAULT 0,
  cash_only_cents      INTEGER NOT NULL DEFAULT 0,
  note                 TEXT    NOT NULL DEFAULT '',
  status               TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at            TEXT,
  void_reason          TEXT,
  client_ref           TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK (from_fund <> to_fund),
  CHECK (
    -- release (into Profit): eligible part raises profit, the rest is cash-only (D4); no re-label
    (to_fund = 'profit' AND charge_relabel_cents = 0 AND cash_only_cents >= 0 AND profit_effect_cents >= 0
       AND profit_effect_cents + cash_only_cents = amount_cents)
    -- re-allocation (out of Profit): lowers recognized profit by the FULL amount (D1)
    OR (from_fund = 'profit' AND profit_effect_cents = -amount_cents AND charge_relabel_cents = 0 AND cash_only_cents = 0)
    -- Cost <-> Electricity: profit unchanged, the charge re-label is at most the amount
    OR (from_fund <> 'profit' AND to_fund <> 'profit' AND profit_effect_cents = 0 AND cash_only_cents = 0
       AND charge_relabel_cents BETWEEN 0 AND amount_cents)
  ),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_icecream_fund_moves_business_date ON icecream_fund_moves(business_date);
CREATE INDEX idx_icecream_fund_moves_posted_at ON icecream_fund_moves(posted_at);

CREATE TRIGGER trg_icecream_fund_moves_future_date
BEFORE INSERT ON icecream_fund_moves
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_icecream_fund_moves_business_date_immutable
BEFORE UPDATE OF business_date ON icecream_fund_moves
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_fund_moves_posted_at_immutable
BEFORE UPDATE OF posted_at ON icecream_fund_moves
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_fund_moves_immutable
BEFORE UPDATE OF id, from_fund, to_fund, amount_cents, profit_effect_cents, charge_relabel_cents, cash_only_cents, note,
  client_ref, status, voided_at, void_reason ON icecream_fund_moves
WHEN NEW.id IS NOT OLD.id
  OR NEW.from_fund IS NOT OLD.from_fund
  OR NEW.to_fund IS NOT OLD.to_fund
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.profit_effect_cents IS NOT OLD.profit_effect_cents
  OR NEW.charge_relabel_cents IS NOT OLD.charge_relabel_cents
  OR NEW.cash_only_cents IS NOT OLD.cash_only_cents
  OR NEW.note IS NOT OLD.note
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'ICECREAM_FUND_MOVE_IMMUTABLE');
END;

CREATE TRIGGER trg_icecream_fund_moves_no_delete
BEFORE DELETE ON icecream_fund_moves
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- A move writes no cash entry, so the cash_entries day-closed trigger cannot protect it: guard it here (R9).
CREATE TRIGGER trg_icecream_fund_moves_day_closed
BEFORE INSERT ON icecream_fund_moves
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT RAISE(ABORT, 'DAY_CLOSED');
END;

CREATE TRIGGER trg_icecream_fund_moves_day_closed_void
BEFORE UPDATE OF status ON icecream_fund_moves
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = OLD.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT RAISE(ABORT, 'DAY_CLOSED');
END;
