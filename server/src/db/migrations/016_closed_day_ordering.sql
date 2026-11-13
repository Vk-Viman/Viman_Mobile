-- 016_closed_day_ordering.sql - closed-day ordering protection (BUSINESS_RULES section 8, approved 2026-11-13;
-- API_CONTRACTS "Approved-decisions contract" part A).
-- Runner wraps this file in a transaction.
--
-- WHY: a daily closing freezes a book's balance for that day. Migration 012 already refuses a NEW entry dated ON a
-- closed day (DAY_CLOSED), but an entry dated EARLIER than a closed day still changed the running balance, so the
-- closed day's stored snapshot (expected_cents) could drift. From now on a database write dated earlier than the
-- LATEST currently-closed day of its book aborts BACKDATE_BEFORE_CLOSED_DAY. The owner reopens the later closed
-- day(s) first (reopen is audited); a reopened day no longer counts as closed.
--
-- A day is closed while  reopened_at IS NULL OR closed_at > reopened_at  (R9).
-- "Earlier than the latest closed day" is the same as "some closed day of the book has a business_date greater than
-- the entry's", answered by the (book, business_date) unique index of daily_closings.
-- Older migrations are never edited: the triggers below are DROPPED and CREATED again, stronger.
--
-- Services check first (friendly message with the dates: services/day-closing.ts assertDayOpen); these triggers are the
-- backstop and map to the same error codes. Closing a day WITHOUT a count posts no cash entry and stays allowed; a
-- closing whose count posts an adjustment dated D is refused when a later day is already closed, exactly like any
-- other cash entry. A reversal row (a void) copies the original business date and follows the same rule.

-- ---------------------------------------------------------------------------------------------
-- cash_entries (the ledger of all three books): DAY_CLOSED on a closed day, BACKDATE_BEFORE_CLOSED_DAY before one.
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER trg_cash_entries_day_closed;
CREATE TRIGGER trg_cash_entries_day_closed
BEFORE INSERT ON cash_entries
WHEN EXISTS (
  SELECT 1 FROM daily_closings d
   WHERE d.book = NEW.book AND d.business_date >= NEW.business_date
     AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at)
)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM daily_closings d
       WHERE d.book = NEW.book AND d.business_date = NEW.business_date
         AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- Ice Cream record triggers of migration 014 (they exist because a zero-sales day and a fund move write no cash entry)
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER trg_icecream_days_day_closed;
CREATE TRIGGER trg_icecream_days_day_closed
BEFORE INSERT ON icecream_days
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= NEW.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date
                   AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

DROP TRIGGER trg_icecream_days_day_closed_void;
CREATE TRIGGER trg_icecream_days_day_closed_void
BEFORE UPDATE OF status ON icecream_days
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= OLD.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = OLD.business_date
                   AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

DROP TRIGGER trg_icecream_payments_day_closed;
CREATE TRIGGER trg_icecream_payments_day_closed
BEFORE INSERT ON icecream_payments
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= NEW.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date
                   AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

DROP TRIGGER trg_icecream_fund_moves_day_closed;
CREATE TRIGGER trg_icecream_fund_moves_day_closed
BEFORE INSERT ON icecream_fund_moves
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= NEW.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date
                   AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

DROP TRIGGER trg_icecream_fund_moves_day_closed_void;
CREATE TRIGGER trg_icecream_fund_moves_day_closed_void
BEFORE UPDATE OF status ON icecream_fund_moves
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= OLD.business_date
               AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = OLD.business_date
                   AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;
