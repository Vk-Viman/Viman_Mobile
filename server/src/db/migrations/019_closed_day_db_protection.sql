-- 019_closed_day_db_protection.sql - closed-day protection in the DATABASE for every business-date table (audit finding M1,
-- API_CONTRACTS "Hardening contract" part M1; BUSINESS_RULES section 8 and R9).
-- Runner wraps this file in a transaction. Forward-only: no earlier migration is edited and no earlier trigger is dropped
-- (cash_entries and the Ice Cream day / payment / fund-move triggers of 012/014/016 stay exactly as they are).
--
-- WHY: until now only cash_entries and three Ice Cream record tables refused a row dated on / before a closed day. Every
-- other table (stock movements, losses, stocktakes, drawings, opening stock, sales, purchases, returns, expenses, capital,
-- counts, reload / EZCash / top-up / print / supplies, transfers, fund entries) relied on the service layer alone, so a
-- direct SQL write could change the profit or the stock of a closed period without any cash trace.
--
-- THE ONE RULE (same SQL logic as trg_cash_entries_day_closed of 016), per BOOK the row touches:
--   a closed day of the book has business_date = the row's date   -> abort DAY_CLOSED
--   else a closed day of the book is LATER than the row's date    -> abort BACKDATE_BEFORE_CLOSED_DAY
-- "closed" means  reopened_at IS NULL OR closed_at > reopened_at  (a reopened day does not count); the lookup is the indexed
-- (book, business_date) probe of daily_closings, evaluated only when a closed day >= the row's date exists (WHEN clause).
-- A reversal row copies the original date and so follows the same rule; the services still check first and answer with the
-- friendly 409 (day-closing.ts mapCashAbort maps these aborts to the same codes).
--
-- BOOK per table: sales / purchases / expenses / capital_entries / owner_drawings / stock_losses / stocktakes / cash_counts have a
-- book column; stock_movements use the product's book; sales_returns the sale's book; purchase_returns the purchase's book;
-- cash_transfers BOTH books; icecream_* the icecream book; reload_sales, ezcash_sales, telecom_topups the telecom book;
-- print_sales and printing_supplies the shop book; icecream_sales (child lines) the icecream book on the day's date.
-- Exceptions to "same rule everywhere": a cash count that matches the books (difference 0) posts nothing, so only its exact
-- day is protected (BUSINESS_RULES section 8: closing without a cash entry stays allowed); a stocktake is judged when it is
-- COMPLETED (and when a completed one is voided), a draft posts nothing; opening_stock_batches are judged by their movements
-- (see below).
--
-- Intentionally NOT protected: import_runs / import_issues (audit of previews and refused imports, no money or stock),
-- audit_logs and external_backup_log (append-only logs), daily_closings (the closings themselves), the line tables
-- (sale_items, purchase_items, *_return_items, stocktake_items: no date of their own, protected through their header and
-- movements) and the catalog / settings tables.

-- ---------------------------------------------------------------------------------------------
-- Tables with their own book column: INSERT and void flip
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_sales_day_closed
BEFORE INSERT ON sales
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_sales_day_closed_void
BEFORE UPDATE OF status ON sales
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_purchases_day_closed
BEFORE INSERT ON purchases
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_purchases_day_closed_void
BEFORE UPDATE OF status ON purchases
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_expenses_day_closed
BEFORE INSERT ON expenses
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_expenses_day_closed_void
BEFORE UPDATE OF status ON expenses
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_capital_entries_day_closed
BEFORE INSERT ON capital_entries
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_capital_entries_day_closed_void
BEFORE UPDATE OF status ON capital_entries
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_owner_drawings_day_closed
BEFORE INSERT ON owner_drawings
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_owner_drawings_day_closed_void
BEFORE UPDATE OF status ON owner_drawings
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_stock_losses_day_closed
BEFORE INSERT ON stock_losses
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_stock_losses_day_closed_void
BEFORE UPDATE OF status ON stock_losses
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- stock_movements: the product's book (every movement type, so reversal rows and stock effects of every flow are judged)
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_stock_movements_day_closed
BEFORE INSERT ON stock_movements
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT p.book FROM products p WHERE p.id = NEW.product_id) AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT p.book FROM products p WHERE p.id = NEW.product_id) AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- Fixed-book tables: telecom (reload, EZCash, top-ups) and shop (printing)
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_reload_sales_day_closed
BEFORE INSERT ON reload_sales
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_reload_sales_day_closed_void
BEFORE UPDATE OF status ON reload_sales
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_ezcash_sales_day_closed
BEFORE INSERT ON ezcash_sales
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_ezcash_sales_day_closed_void
BEFORE UPDATE OF status ON ezcash_sales
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_telecom_topups_day_closed
BEFORE INSERT ON telecom_topups
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_telecom_topups_day_closed_void
BEFORE UPDATE OF status ON telecom_topups
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_print_sales_day_closed
BEFORE INSERT ON print_sales
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_print_sales_day_closed_void
BEFORE UPDATE OF status ON print_sales
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_printing_supplies_day_closed
BEFORE INSERT ON printing_supplies
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_printing_supplies_day_closed_void
BEFORE UPDATE OF status ON printing_supplies
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- Cash transfers: BOTH books (DAY_CLOSED of either beats BACKDATE_BEFORE_CLOSED_DAY)
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_cash_transfers_day_closed
BEFORE INSERT ON cash_transfers
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book IN (NEW.from_book, NEW.to_book) AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book IN (NEW.from_book, NEW.to_book) AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_cash_transfers_day_closed_void
BEFORE UPDATE OF status ON cash_transfers
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book IN (OLD.from_book, OLD.to_book) AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book IN (OLD.from_book, OLD.to_book) AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- Returns: the book of the original document
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_sales_returns_day_closed
BEFORE INSERT ON sales_returns
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT s.book FROM sales s WHERE s.id = NEW.sale_id) AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT s.book FROM sales s WHERE s.id = NEW.sale_id) AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_sales_returns_day_closed_void
BEFORE UPDATE OF status ON sales_returns
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT s.book FROM sales s WHERE s.id = OLD.sale_id) AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT s.book FROM sales s WHERE s.id = OLD.sale_id) AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_purchase_returns_day_closed
BEFORE INSERT ON purchase_returns
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT b.book FROM purchases b WHERE b.id = NEW.purchase_id) AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = (SELECT b.book FROM purchases b WHERE b.id = NEW.purchase_id) AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- Ice Cream: fund entries, daily-sale lines (judged on their day) and the payment void flip that 016 did not have
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_icecream_fund_entries_day_closed
BEFORE INSERT ON icecream_fund_entries
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_icecream_sales_day_closed
BEFORE INSERT ON icecream_sales
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= (SELECT x.business_date FROM icecream_days x WHERE x.id = NEW.icecream_day_id) AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = (SELECT x.business_date FROM icecream_days x WHERE x.id = NEW.icecream_day_id) AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_icecream_payments_day_closed_void
BEFORE UPDATE OF status ON icecream_payments
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'icecream' AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- cash_counts: a count with a difference posts a cash adjustment and follows the full rule; a matching count (difference 0)
-- posts nothing, so only its exact day is protected (section 8)
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_cash_counts_day_closed
BEFORE INSERT ON cash_counts
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date
               AND (NEW.difference_cents <> 0 OR d.business_date = NEW.business_date) AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_cash_counts_day_closed_void
BEFORE UPDATE OF status ON cash_counts
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date
               AND (OLD.difference_cents <> 0 OR d.business_date = OLD.business_date) AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- stocktakes: a draft posts nothing; the posting happens at completion (draft -> completed), and a completed one is voided
-- with reversal movements. Judged on the stocktake's book (its items are all stock products of that book, trigger of 005).
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_stocktakes_day_closed
BEFORE INSERT ON stocktakes
WHEN NEW.status = 'completed'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = NEW.book AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_stocktakes_day_closed_complete
BEFORE UPDATE OF status ON stocktakes
WHEN NEW.status = 'completed' AND OLD.status <> 'completed'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_stocktakes_day_closed_void
BEFORE UPDATE OF status ON stocktakes
WHEN OLD.status = 'completed' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = OLD.book AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

-- ---------------------------------------------------------------------------------------------
-- opening_stock_batches: a batch is a header whose lines are its stock_movements. Every line is judged by the movement trigger
-- (the product's book), which is exact. The header itself has no book at INSERT time (its lines do not exist yet), so it is refused
-- only when it could not carry a single line: when BOTH product books (shop and telecom) are blocked for its date. The void
-- flip is exact: the books of the batch's own movements.
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_opening_stock_batches_day_closed
BEFORE INSERT ON opening_stock_batches
WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
 AND EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date >= NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'shop' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
      OR EXISTS (SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.business_date = NEW.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;

CREATE TRIGGER trg_opening_stock_batches_day_closed_void
BEFORE UPDATE OF status ON opening_stock_batches
WHEN OLD.status = 'posted' AND NEW.status = 'void'
  AND EXISTS (SELECT 1 FROM daily_closings d
               WHERE d.book IN (SELECT p.book FROM stock_movements m JOIN products p ON p.id = m.product_id
                 WHERE m.ref_table = 'opening_stock_batches' AND m.ref_id = OLD.id) AND d.business_date >= OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM daily_closings d
                  WHERE d.book IN (SELECT p.book FROM stock_movements m JOIN products p ON p.id = m.product_id
                 WHERE m.ref_table = 'opening_stock_batches' AND m.ref_id = OLD.id) AND d.business_date = OLD.business_date AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at))
    THEN RAISE(ABORT, 'DAY_CLOSED')
    ELSE RAISE(ABORT, 'BACKDATE_BEFORE_CLOSED_DAY')
  END;
END;
