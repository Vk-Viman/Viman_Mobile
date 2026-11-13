-- 017_void_sales_return.sql - void a sales return (BUSINESS_RULES section 4, rule R-VR, approved 2026-11-13).
-- Runner wraps this file in a transaction. Additive: no earlier migration is edited; changed triggers are DROPped and
-- re-created under the SAME name with the same behaviour plus the new, narrowly defined exception.
--
-- WHY: a posted return can be taken back (a mistake in the return, the customer changed their mind). The operation never
-- edits or deletes anything that exists (R1): the return is only marked void, and new reversal rows are added to the stock
-- and cash ledgers by the service. The database itself guarantees the parts that must never go wrong:
--   * a return can only go posted -> void (never back, never any other column) - and only if it is the NEWEST posted return
--     of every sale line it touches (the last return of a line takes the exact remainder, C5);
--   * the moment a return becomes void the database itself lowers each line's returned_qty by exactly the returned quantity
--     (invariant: sale_items.returned_qty = sum of qty of POSTED return lines) and voids the damaged-return loss rows that
--     belong to it, so those can never be forgotten or done on their own;
--   * reversal rows (stock movements and the refund-reversal cash entry) can only exist for a VOID return, cannot undo more
--     than the return restocked/refunded, and a cash entry can be reversed at most once (unique link).

-- ---------------------------------------------------------------------------------------------
-- 1. Status columns on sales_returns (same shape as sales / purchases).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sales_returns ADD COLUMN status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void'));
ALTER TABLE sales_returns ADD COLUMN voided_at TEXT;
-- A void always records when and why; a posted return never carries void data.
ALTER TABLE sales_returns ADD COLUMN void_reason TEXT CHECK (
  (status = 'posted' AND voided_at IS NULL AND void_reason IS NULL)
  OR (status = 'void' AND voided_at IS NOT NULL AND void_reason IS NOT NULL));

CREATE INDEX idx_sales_returns_status ON sales_returns(status);

-- ---------------------------------------------------------------------------------------------
-- 2. Append-only stays, with ONE exception: the transition posted -> void (status, voided_at, void_reason).
--    Every other column is frozen, a void return can never change again. (Same trigger name and message as migration 006.)
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER trg_sales_returns_no_update;
CREATE TRIGGER trg_sales_returns_no_update BEFORE UPDATE ON sales_returns
WHEN NOT (
  OLD.status = 'posted' AND NEW.status = 'void'
  AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.sale_id IS OLD.sale_id AND NEW.business_date IS OLD.business_date
  AND NEW.posted_at IS OLD.posted_at AND NEW.refund_cents IS OLD.refund_cents
  AND NEW.cogs_reversed_cents IS OLD.cogs_reversed_cents AND NEW.extra_cost_reversed_cents IS OLD.extra_cost_reversed_cents
  AND NEW.note IS OLD.note AND NEW.client_ref IS OLD.client_ref)
BEGIN
  SELECT RAISE(ABORT, 'sales_returns is append-only');
END;

-- R-VR 1: only the newest posted return of every line it touches may be voided ("newest" = highest id = posting order).
CREATE TRIGGER trg_sales_returns_void_newest
BEFORE UPDATE OF status ON sales_returns
WHEN OLD.status = 'posted' AND NEW.status = 'void' AND EXISTS (
  SELECT 1
    FROM sales_return_items mine
    JOIN sales_return_items other ON other.sale_item_id = mine.sale_item_id AND other.sales_return_id > mine.sales_return_id
    JOIN sales_returns r2 ON r2.id = other.sales_return_id AND r2.status = 'posted'
   WHERE mine.sales_return_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_NOT_NEWEST');
END;

-- R-VR 6 and 7: once a return is void, the database (not the application) takes its quantities off the counters and voids
-- the damaged-return loss row(s) that came from it. The loss has no stock movement; nothing is taken out of stock for it.
CREATE TRIGGER trg_sales_returns_void_effects
AFTER UPDATE OF status ON sales_returns
WHEN OLD.status = 'posted' AND NEW.status = 'void'
BEGIN
  UPDATE sale_items
     SET returned_qty = returned_qty - (SELECT SUM(ri.qty) FROM sales_return_items ri
                                         WHERE ri.sales_return_id = NEW.id AND ri.sale_item_id = sale_items.id)
   WHERE id IN (SELECT sale_item_id FROM sales_return_items WHERE sales_return_id = NEW.id);
  UPDATE stock_losses
     SET status = 'void', voided_at = NEW.voided_at, void_reason = NEW.void_reason
   WHERE sales_return_id = NEW.id AND status = 'posted';
END;

-- ---------------------------------------------------------------------------------------------
-- 3. sale_items.returned_qty: it may go DOWN only to exactly the quantity of the lines of posted returns (i.e. as part of a
--    return void). Everything else is frozen exactly as in migration 006.
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER trg_sale_items_immutable;
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
  OR (NEW.returned_qty < OLD.returned_qty
      AND NEW.returned_qty IS NOT (
        SELECT COALESCE(SUM(ri.qty), 0)
          FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.sales_return_id
         WHERE ri.sale_item_id = OLD.id AND r.status = 'posted'))
BEGIN
  SELECT RAISE(ABORT, 'SALE_ITEM_IMMUTABLE');
END;

-- C13 backstop (migration 008) now counts the extra cost of POSTED returns only (a voided return no longer reduces cost).
DROP TRIGGER trg_sales_return_items_extra_exceeds;
CREATE TRIGGER trg_sales_return_items_extra_exceeds
BEFORE INSERT ON sales_return_items
WHEN COALESCE((SELECT SUM(ri.extra_cost_cents) FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.sales_return_id
                WHERE ri.sale_item_id = NEW.sale_item_id AND r.status = 'posted'), 0)
       + NEW.extra_cost_cents
     > COALESCE((SELECT extra_cost_cents FROM sale_items WHERE id = NEW.sale_item_id), 0)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_EXCEEDS_EXTRA_COST');
END;

-- ---------------------------------------------------------------------------------------------
-- 4. The damaged-return loss can be voided ONLY together with its return (the service keeps its own DAMAGED_RETURN_LOSS
--    guard for direct voids; this is the database backstop). The cascade in section 2 voids the return first, so it passes.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_stock_losses_damaged_return_void_guard
BEFORE UPDATE OF status ON stock_losses
WHEN OLD.source = 'damaged_return' AND OLD.status = 'posted' AND NEW.status = 'void'
 AND (SELECT status FROM sales_returns WHERE id = OLD.sales_return_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'DAMAGED_RETURN_LOSS');
END;

-- ---------------------------------------------------------------------------------------------
-- 5. Reversal rows of a return void. A reversal is a stock movement of the return (ref sales_returns) that takes units or
--    value OUT (qty_delta <= 0), or a cash entry of the return that brings money back (amount > 0).
--    * they can only be written when the return is void (so a posted return can never be "reversed" by accident);
--    * the units removed can never exceed the resalable units the return restocked, per product (no double reversal);
--    * a refund reversal must point at an original entry of the same return and book, and each original is reversed once.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_stock_movements_return_reversal_void
BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND NEW.type IN ('sale_return','adjustment') AND NEW.qty_delta <= 0
 AND (SELECT status FROM sales_returns WHERE id = NEW.ref_id) IS NOT 'void'
BEGIN
  SELECT RAISE(ABORT, 'RETURN_NOT_VOID');
END;

CREATE TRIGGER trg_stock_movements_return_reversal_cap
BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND NEW.type = 'sale_return' AND NEW.qty_delta < 0
 AND (-NEW.qty_delta + COALESCE((SELECT -SUM(m.qty_delta) FROM stock_movements m
                                  WHERE m.ref_table = 'sales_returns' AND m.ref_id = NEW.ref_id AND m.type = 'sale_return'
                                    AND m.product_id = NEW.product_id AND m.qty_delta < 0), 0))
     > COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id
                  WHERE ri.sales_return_id = NEW.ref_id AND ri.resalable = 1 AND si.product_id = NEW.product_id), 0)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_REVERSAL_EXCEEDS');
END;

CREATE TRIGGER trg_cash_entries_return_reversal
BEFORE INSERT ON cash_entries
WHEN NEW.ref_table = 'sales_returns' AND NEW.amount_cents > 0
 AND ((SELECT status FROM sales_returns WHERE id = NEW.ref_id) IS NOT 'void'
      OR NEW.reverses_entry_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM cash_entries o
                      WHERE o.id = NEW.reverses_entry_id AND o.ref_table = 'sales_returns' AND o.ref_id = NEW.ref_id
                        AND o.book = NEW.book AND o.type = NEW.type AND o.amount_cents = -NEW.amount_cents
                        AND o.business_date = NEW.business_date))
BEGIN
  SELECT RAISE(ABORT, 'RETURN_REVERSAL_INVALID');
END;

-- A refund entry of a return can be reversed at most once (unique link; a double void cannot post a second reversal).
CREATE UNIQUE INDEX uq_cash_entries_return_reversal ON cash_entries(reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL AND ref_table = 'sales_returns';
