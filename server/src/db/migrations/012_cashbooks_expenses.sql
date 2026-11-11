-- 012_cashbooks_expenses.sql - Phase 8: expenses, opening balances / capital, cash counts, daily closings and the
-- Ice Cream fund ledger (BUSINESS_RULES sections 1, 2, 7, 8, 9, 10, 12; R6, R9, R10, E1-E5, R-FD).
-- Runner wraps this file in a transaction. Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).
--
-- WHY this file exists: the owner records shop and telecom expenses, the cash each book started with, counts the
-- drawer, and closes each day per cash book. Every rule below is enforced by the DATABASE as well as by the
-- services, so no bug, retry or hand-typed SQL can quietly corrupt the cash history:
--   * an expense belongs to Shop or Telecom only and its category list has NO electricity value (E2);
--   * a business record is never edited or deleted; the only change allowed is posted -> void (R1);
--   * nothing is dated in the future (R-FD); business date and posting time never change;
--   * a closed day (R9) refuses new cash entries (DAY_CLOSED backstop) and closings can only be reopened/re-closed;
--   * the Ice Cream fund ledger is append-only and every Ice Cream money row names exactly one fund (section 10.2).
-- Part 2 of this file repairs a Phase 7 finding: migrations 003-011 compared date(x) = x without IS NOT NULL, so a
-- date such as 2020-13-01 (date() answers NULL, and a NULL CHECK counts as "passed") slipped through.
-- NULL-in-CHECK: every CHECK that touches a nullable column says IS NOT NULL explicitly.

-- =============================================================================================
-- PART 1 - new tables
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- expenses: Shop or Telecom operating expenses (Ice Cream costs use the ice-cream records instead, section 7)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT    NOT NULL,
  posted_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  book          TEXT    NOT NULL CHECK (book IN ('shop','telecom')),
  -- E2: there is deliberately no 'electricity' value; the whole shop's electricity is paid from the Ice Cream book.
  category      TEXT    NOT NULL CHECK (category IN ('water','rent','internet','transport','repairs','cleaning_supplies','packaging','stationery','other')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  description   TEXT    NOT NULL,
  notes         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at     TEXT,
  void_reason   TEXT,
  client_ref    TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK (length(trim(description)) > 0),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_expenses_business_date ON expenses(business_date);
CREATE INDEX idx_expenses_book_date ON expenses(book, business_date);
CREATE INDEX idx_expenses_posted_at ON expenses(posted_at);

CREATE TRIGGER trg_expenses_future_date
BEFORE INSERT ON expenses
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_expenses_business_date_immutable
BEFORE UPDATE OF business_date ON expenses
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_expenses_posted_at_immutable
BEFORE UPDATE OF posted_at ON expenses
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back (R1).
CREATE TRIGGER trg_expenses_immutable
BEFORE UPDATE OF id, book, category, amount_cents, description, notes, client_ref, status, voided_at, void_reason ON expenses
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.category IS NOT OLD.category
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.description IS NOT OLD.description
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'EXPENSE_IMMUTABLE');
END;

CREATE TRIGGER trg_expenses_no_delete
BEFORE DELETE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- capital_entries: opening balances (Phase 8) and capital (Phase 9) - cash IN, never revenue (section 9)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE capital_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT    NOT NULL,
  posted_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  book          TEXT    NOT NULL CHECK (book IN ('shop','telecom','icecream')),
  fund          TEXT    CHECK (fund IS NULL OR fund IN ('cost','electricity','profit')),
  kind          TEXT    NOT NULL CHECK (kind IN ('opening_balance','capital')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  note          TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at     TEXT,
  void_reason   TEXT,
  client_ref    TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  -- section 10.2: every Ice Cream money movement names its fund; the other books never do
  CHECK ((book = 'icecream') = (fund IS NOT NULL)),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_capital_entries_business_date ON capital_entries(business_date);
CREATE INDEX idx_capital_entries_book_date ON capital_entries(book, business_date);
CREATE INDEX idx_capital_entries_posted_at ON capital_entries(posted_at);
-- Design guard: at most ONE posted opening balance per book (per fund for Ice Cream). A wrong one is corrected by
-- voiding it and entering it again (R1), so the history shows both.
CREATE UNIQUE INDEX ux_capital_opening_balance ON capital_entries(book, COALESCE(fund, ''))
  WHERE kind = 'opening_balance' AND status = 'posted';

CREATE TRIGGER trg_capital_entries_future_date
BEFORE INSERT ON capital_entries
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_capital_entries_business_date_immutable
BEFORE UPDATE OF business_date ON capital_entries
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_capital_entries_posted_at_immutable
BEFORE UPDATE OF posted_at ON capital_entries
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_capital_entries_immutable
BEFORE UPDATE OF id, book, fund, kind, amount_cents, note, client_ref, status, voided_at, void_reason ON capital_entries
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.fund IS NOT OLD.fund
  OR NEW.kind IS NOT OLD.kind
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.note IS NOT OLD.note
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'CAPITAL_ENTRY_IMMUTABLE');
END;

CREATE TRIGGER trg_capital_entries_no_delete
BEFORE DELETE ON capital_entries
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- cash_counts: the owner counts the drawer; the difference is posted as `cash_adjustment` (C4, R6)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash_counts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  book             TEXT    NOT NULL CHECK (book IN ('shop','telecom','icecream')),
  fund             TEXT    CHECK (fund IS NULL OR fund IN ('cost','electricity','profit')),
  business_date    TEXT    NOT NULL,
  posted_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- expected = ledger balance of the book as of the END of business_date (may be negative); counted = what the owner counted
  expected_cents   INTEGER NOT NULL,
  counted_cents    INTEGER NOT NULL CHECK (counted_cents BETWEEN 0 AND 1000000000000),
  difference_cents INTEGER NOT NULL,
  note             TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at        TEXT,
  void_reason      TEXT,
  -- the `cash_adjustment` ledger row of a non-zero difference (NULL when the count matched)
  cash_entry_id    INTEGER REFERENCES cash_entries(id),
  client_ref       TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK (difference_cents = counted_cents - expected_cents),
  -- C4/R6: a non-zero over/short always carries an explanation
  CHECK (difference_cents = 0 OR length(trim(note)) > 0),
  -- section 10.2: the fund is named exactly when Ice Cream cash really moves (difference <> 0)
  CHECK ((book = 'icecream' AND difference_cents <> 0) = (fund IS NOT NULL)),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_cash_counts_business_date ON cash_counts(business_date);
CREATE INDEX idx_cash_counts_book_date ON cash_counts(book, business_date);
CREATE INDEX idx_cash_counts_posted_at ON cash_counts(posted_at);
CREATE INDEX idx_cash_counts_cash_entry ON cash_counts(cash_entry_id);

CREATE TRIGGER trg_cash_counts_future_date
BEFORE INSERT ON cash_counts
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_cash_counts_business_date_immutable
BEFORE UPDATE OF business_date ON cash_counts
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_cash_counts_posted_at_immutable
BEFORE UPDATE OF posted_at ON cash_counts
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void may change; the link to the adjustment entry may be filled in ONCE (NULL -> id) because the
-- adjustment row is written after the count row (it refers to the count's id).
CREATE TRIGGER trg_cash_counts_immutable
BEFORE UPDATE OF id, book, fund, expected_cents, counted_cents, difference_cents, note, client_ref, cash_entry_id,
                 status, voided_at, void_reason ON cash_counts
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.fund IS NOT OLD.fund
  OR NEW.expected_cents IS NOT OLD.expected_cents
  OR NEW.counted_cents IS NOT OLD.counted_cents
  OR NEW.difference_cents IS NOT OLD.difference_cents
  OR NEW.note IS NOT OLD.note
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (NEW.cash_entry_id IS NOT OLD.cash_entry_id AND OLD.cash_entry_id IS NOT NULL)
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'CASH_COUNT_IMMUTABLE');
END;

CREATE TRIGGER trg_cash_counts_no_delete
BEFORE DELETE ON cash_counts
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- daily_closings: one row per (book, date). A day is CLOSED while reopened_at IS NULL OR closed_at > reopened_at (R9).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE daily_closings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  book            TEXT    NOT NULL CHECK (book IN ('shop','telecom','icecream')),
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
  UNIQUE (book, business_date),
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  CHECK ((counted_cents IS NULL AND over_short_cents = 0)
      OR (counted_cents IS NOT NULL AND over_short_cents = counted_cents - expected_cents)),
  -- a reopen always records why (at least 3 characters)
  CHECK (reopened_at IS NULL OR (reopen_reason IS NOT NULL AND length(trim(reopen_reason)) >= 3))
);
CREATE INDEX idx_daily_closings_business_date ON daily_closings(business_date);
CREATE INDEX idx_daily_closings_cash_count ON daily_closings(cash_count_id);

-- R-FD: a future day cannot be closed.
CREATE TRIGGER trg_daily_closings_future_date
BEFORE INSERT ON daily_closings
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

-- Allowed UPDATEs: REOPEN (a closed day gets reopened_at + reason, reopened_at >= closed_at so the day is open) and
-- RE-CLOSE (an open day gets closed_at > reopened_at and its new figures). Everything else aborts.
CREATE TRIGGER trg_daily_closings_immutable
BEFORE UPDATE ON daily_closings
WHEN NEW.id IS NOT OLD.id
  OR NEW.book IS NOT OLD.book
  OR NEW.business_date IS NOT OLD.business_date
  OR NEW.posted_at IS NOT OLD.posted_at
  OR NOT (
    ( (OLD.reopened_at IS NULL OR OLD.closed_at > OLD.reopened_at)
      AND NEW.reopened_at IS NOT NULL
      AND NEW.reopened_at >= OLD.closed_at
      AND NEW.closed_at IS OLD.closed_at
      AND NEW.expected_cents IS OLD.expected_cents
      AND NEW.counted_cents IS OLD.counted_cents
      AND NEW.over_short_cents IS OLD.over_short_cents
      AND NEW.cash_count_id IS OLD.cash_count_id )
    OR
    ( OLD.reopened_at IS NOT NULL AND OLD.closed_at <= OLD.reopened_at
      AND NEW.closed_at > OLD.reopened_at
      AND NEW.reopened_at IS OLD.reopened_at
      AND NEW.reopen_reason IS OLD.reopen_reason )
  )
BEGIN
  SELECT RAISE(ABORT, 'DAILY_CLOSING_IMMUTABLE');
END;

CREATE TRIGGER trg_daily_closings_no_delete
BEFORE DELETE ON daily_closings
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- icecream_fund_entries: append-only fund ledger (sections 10.1, 10.2, 10.7). Fund balance = SUM per fund.
-- Invariant: SUM(all funds) = SUM(cash_entries.amount_cents WHERE book = 'icecream'). Only `fund_move` and
-- `daily_allocation` rows can exist without a matching cash entry of the same amount (a move nets to zero).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE icecream_fund_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date     TEXT    NOT NULL,
  posted_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fund              TEXT    NOT NULL CHECK (fund IN ('cost','electricity','profit')),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents <> 0),
  kind              TEXT    NOT NULL CHECK (kind IN ('daily_allocation','payment','fund_move','drawing','transfer_out',
                                                     'transfer_in','opening_balance','capital','cash_over_short','reversal')),
  ref_table         TEXT,
  ref_id            INTEGER,
  reverses_entry_id INTEGER REFERENCES icecream_fund_entries(id),
  note              TEXT,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  -- a reversal row points at the row it cancels and nothing else does
  CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX idx_icecream_fund_entries_date ON icecream_fund_entries(business_date);
CREATE INDEX idx_icecream_fund_entries_fund_date ON icecream_fund_entries(fund, business_date);
CREATE INDEX idx_icecream_fund_entries_ref ON icecream_fund_entries(ref_table, ref_id);
CREATE INDEX idx_icecream_fund_entries_posted_at ON icecream_fund_entries(posted_at);
CREATE INDEX idx_icecream_fund_entries_reverses ON icecream_fund_entries(reverses_entry_id);

CREATE TRIGGER trg_icecream_fund_entries_future_date
BEFORE INSERT ON icecream_fund_entries
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_icecream_fund_entries_no_update BEFORE UPDATE ON icecream_fund_entries
BEGIN
  SELECT RAISE(ABORT, 'icecream_fund_entries is append-only');
END;

CREATE TRIGGER trg_icecream_fund_entries_no_delete BEFORE DELETE ON icecream_fund_entries
BEGIN
  SELECT RAISE(ABORT, 'icecream_fund_entries is append-only');
END;

-- =============================================================================================
-- PART 2 - DAY_CLOSED backstop (R9)
-- =============================================================================================
-- The services check first (friendly message). This trigger is the safety net: no cash entry can be added to a book
-- on a day that is closed for it. A closing posts its own over/short adjustment BEFORE the closing row exists
-- (or while the day is reopened), so it is never blocked by its own closing.
CREATE TRIGGER trg_cash_entries_day_closed
BEFORE INSERT ON cash_entries
WHEN EXISTS (
  SELECT 1 FROM daily_closings d
   WHERE d.book = NEW.book AND d.business_date = NEW.business_date
     AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at)
)
BEGIN
  SELECT RAISE(ABORT, 'DAY_CLOSED');
END;

-- =============================================================================================
-- PART 3 - date-check follow-up (Phase 7 finding): INVALID_BUSINESS_DATE on the older business-date tables
-- =============================================================================================
-- Their CHECK says `date(business_date) = business_date`; for a month-13 date date() answers NULL and a NULL CHECK
-- counts as passed. For a correctly SHAPED date, date(x) IS NULL is exactly "not a real calendar day", so a BEFORE
-- INSERT trigger closes the gap (a wrongly shaped date such as 'abc' or '2026-1-1' is still refused by the old GLOB
-- CHECK, and 2026-02-31 by the old date(x) = x comparison; migrations 003-011 are never edited). Tables 010 and 012 already use the strict CHECK form. `categories`,
-- `suppliers`, `products`, the *_items tables and import_issues carry no business date.
CREATE TRIGGER trg_stock_movements_valid_date BEFORE INSERT ON stock_movements
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_cash_entries_valid_date BEFORE INSERT ON cash_entries
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_purchases_valid_date BEFORE INSERT ON purchases
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_purchase_returns_valid_date BEFORE INSERT ON purchase_returns
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_stocktakes_valid_date BEFORE INSERT ON stocktakes
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_stock_losses_valid_date BEFORE INSERT ON stock_losses
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_owner_drawings_valid_date BEFORE INSERT ON owner_drawings
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_sales_valid_date BEFORE INSERT ON sales
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_sales_returns_valid_date BEFORE INSERT ON sales_returns
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_reload_sales_valid_date BEFORE INSERT ON reload_sales
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_ezcash_sales_valid_date BEFORE INSERT ON ezcash_sales
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_telecom_topups_valid_date BEFORE INSERT ON telecom_topups
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_opening_stock_batches_valid_date BEFORE INSERT ON opening_stock_batches
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
CREATE TRIGGER trg_import_runs_valid_date BEFORE INSERT ON import_runs
WHEN NEW.business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(NEW.business_date) IS NULL
BEGIN SELECT RAISE(ABORT, 'INVALID_BUSINESS_DATE'); END;
