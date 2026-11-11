-- 008_sale_extra_cost.sql - extra cost on sales (BUSINESS_RULES C13, Phase 5 amendment).
--
-- The cashier may raise a sale line's cost above the automatic (weighted-average) cost, never lower it.
-- The part above the automatic cost is the line's "extra cost". It is kept in its own column; stock,
-- stock movements and cash are never touched by it. Additive only: no earlier migration is edited.
--
-- All money here is whole cents (INTEGER). Existing rows get 0, i.e. "no extra cost", so every old
-- sale and return keeps its meaning and its figures.

-- The extra cost of one sold line (cost charged = cogs_cents + extra_cost_cents). Never negative.
ALTER TABLE sale_items
  ADD COLUMN extra_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_cents >= 0);

-- The part of that extra cost reversed by one returned line (same exact-remainder split as revenue, C5).
ALTER TABLE sales_return_items
  ADD COLUMN extra_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_cents >= 0);

-- The total extra cost reversed by a whole return (sum of its lines).
ALTER TABLE sales_returns
  ADD COLUMN extra_cost_reversed_cents INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_reversed_cents >= 0);

-- A sold line is frozen (migration 006). That trigger was written before this column existed, so it does
-- not look at it; this one closes the gap: the extra cost of a saved line can never change.
CREATE TRIGGER trg_sale_items_extra_cost_immutable
BEFORE UPDATE OF extra_cost_cents ON sale_items
WHEN NEW.extra_cost_cents IS NOT OLD.extra_cost_cents
BEGIN
  SELECT RAISE(ABORT, 'SALE_ITEM_IMMUTABLE');
END;

-- Backstop: all returns of a line together may not take back more extra cost than the line carries.
-- Compared at insert time: earlier return lines of the same sale line + this new one <= the line's extra.
CREATE TRIGGER trg_sales_return_items_extra_exceeds
BEFORE INSERT ON sales_return_items
WHEN COALESCE((SELECT SUM(extra_cost_cents) FROM sales_return_items WHERE sale_item_id = NEW.sale_item_id), 0)
       + NEW.extra_cost_cents
     > COALESCE((SELECT extra_cost_cents FROM sale_items WHERE id = NEW.sale_item_id), 0)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_EXCEEDS_EXTRA_COST');
END;
