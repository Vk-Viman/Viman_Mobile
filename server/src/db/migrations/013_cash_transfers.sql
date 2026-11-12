-- 013_cash_transfers.sql - Phase 9: cash transfers between the three books (+ guards for cash drawings and transfer legs)
-- (BUSINESS_RULES sections 8, 9, 10.2, 10.7; R1, R-FD, R9).
-- Runner wraps this file in a transaction. Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).
--
-- WHY this file exists: the owner moves cash from one book to another (for example Telecom -> Shop). That is ONE business
-- record (`cash_transfers`) and TWO cash ledger rows that share its id in `cash_entries.transfer_id`: `transfer_out` in the
-- source book and `transfer_in` in the destination book (section 8). A transfer is never revenue, cost or profit (section 9).
-- Every rule is enforced by the DATABASE as well as by the services, like Phase 8:
--   * a transfer always has two DIFFERENT books and names a fund exactly on its Ice Cream side(s) (section 10.2);
--   * a transfer is never edited or deleted; the only change allowed is posted -> void (R1);
--   * nothing is dated in the future (R-FD); business date and posting time never change;
--   * a transfer ledger row is only accepted when it matches its transfer (right book, right fund, right type);
--   * a cash drawing (owner_drawings.kind = 'cash', schema from migration 005) must be at least 1 cent.
-- NULL-in-CHECK: every CHECK that touches a nullable column says IS NOT NULL explicitly.

CREATE TABLE cash_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT    NOT NULL,
  posted_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  from_book     TEXT    NOT NULL CHECK (from_book IN ('shop','telecom','icecream')),
  to_book       TEXT    NOT NULL CHECK (to_book IN ('shop','telecom','icecream')),
  from_fund     TEXT    CHECK (from_fund IS NULL OR from_fund IN ('cost','electricity','profit')),
  to_fund       TEXT    CHECK (to_fund IS NULL OR to_fund IN ('cost','electricity','profit')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  note          TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at     TEXT,
  void_reason   TEXT,
  client_ref    TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) IS NOT NULL AND date(business_date) = business_date),
  -- section 8: money moves BETWEEN two different books
  CHECK (from_book <> to_book),
  -- section 10.2: the fund is named exactly on the Ice Cream side(s)
  CHECK ((from_book = 'icecream') = (from_fund IS NOT NULL)),
  CHECK ((to_book = 'icecream') = (to_fund IS NOT NULL)),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'void' OR (voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_cash_transfers_business_date ON cash_transfers(business_date);
CREATE INDEX idx_cash_transfers_from ON cash_transfers(from_book, business_date);
CREATE INDEX idx_cash_transfers_to ON cash_transfers(to_book, business_date);
CREATE INDEX idx_cash_transfers_posted_at ON cash_transfers(posted_at);

CREATE TRIGGER trg_cash_transfers_future_date
BEFORE INSERT ON cash_transfers
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_cash_transfers_business_date_immutable
BEFORE UPDATE OF business_date ON cash_transfers
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_cash_transfers_posted_at_immutable
BEFORE UPDATE OF posted_at ON cash_transfers
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back (R1).
CREATE TRIGGER trg_cash_transfers_immutable
BEFORE UPDATE OF id, from_book, to_book, from_fund, to_fund, amount_cents, note, client_ref, status, voided_at, void_reason ON cash_transfers
WHEN NEW.id IS NOT OLD.id
  OR NEW.from_book IS NOT OLD.from_book
  OR NEW.to_book IS NOT OLD.to_book
  OR NEW.from_fund IS NOT OLD.from_fund
  OR NEW.to_fund IS NOT OLD.to_fund
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.note IS NOT OLD.note
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'CASH_TRANSFER_IMMUTABLE');
END;

CREATE TRIGGER trg_cash_transfers_no_delete
BEFORE DELETE ON cash_transfers
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- The two ledger legs of a transfer. cash_entries is append-only (migration 004), so the link can only be checked when
-- the row is inserted: a transfer_out / transfer_in row must carry the id of an existing transfer, sit in the book
-- (and fund) that transfer names for that side, and no other kind of row may carry a transfer id.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_cash_entries_transfer_link
BEFORE INSERT ON cash_entries
WHEN NEW.type IN ('transfer_out','transfer_in') OR NEW.transfer_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_LEG_MISMATCH')
   WHERE NEW.transfer_id IS NULL
      OR NEW.type NOT IN ('transfer_out','transfer_in')
      OR NOT EXISTS (
        SELECT 1 FROM cash_transfers t
         WHERE t.id = NEW.transfer_id
           AND ((NEW.type = 'transfer_out' AND t.from_book = NEW.book AND t.from_fund IS NEW.fund)
             OR (NEW.type = 'transfer_in'  AND t.to_book   = NEW.book AND t.to_fund   IS NEW.fund))
      );
END;

-- ---------------------------------------------------------------------------------------------
-- Cash drawings: migration 005 allows amount 0 for goods drawings (a drawing of worthless stock) but a CASH drawing is
-- real money out of a book, so it must be at least 1 cent and within the same 10^12 cap as every other amount.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_owner_drawings_cash_amount
BEFORE INSERT ON owner_drawings
WHEN NEW.kind = 'cash' AND (NEW.amount_cents < 1 OR NEW.amount_cents > 1000000000000)
BEGIN
  SELECT RAISE(ABORT, 'CASH_DRAWING_AMOUNT');
END;
