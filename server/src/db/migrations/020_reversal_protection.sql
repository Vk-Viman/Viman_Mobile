-- 020_reversal_protection.sql - hardening findings M2, M3, M4 (audit 2026-11-13): the DATABASE guards void status, stock
-- reversals and duplicate return effects. Runner wraps this file in a transaction. Forward-only: no earlier migration is edited,
-- no existing row is touched or rewritten (only sqlite_master changes; the new column is NULL on every old row).
-- Changed triggers are DROPped and re-created under the SAME name; messages/codes stay the same wherever a test or the API relies on them.
--
-- M2  VOID_WITHOUT_REVERSAL: a posted -> void flip of any document table with cash / stock / Ice Cream fund effects is refused unless
--     the reversal rows already exist. Rows are linked exactly:
--       cash entries      reverses_entry_id            (existing column) - opposite amount, same book / fund / date / type / reference
--       fund entries      reverses_entry_id            (existing column) - opposite amount, same fund / date / reference
--       stock movements   reverses_movement_id         (NEW nullable column, new rows only) - see "Linkage design" below
--     Linkage design for stock reversals (chosen: explicit forward-only link column + unique index): stock_movements carries no link
--     and the original and its reversal have the same type, ref and opposite sign, so a "ref + type + sign" rule cannot tell WHICH
--     original a row cancels (two lines of the same product, partial caps of R4, sweeps), cannot make a second reversal impossible
--     and is not enforceable by an index under concurrency. A nullable `reverses_movement_id` with a partial UNIQUE index makes
--     "reversed exactly once" a key constraint and lets a trigger check the mirror (same product / ref / date, opposite quantity,
--     value no larger than the original: R4 removals may be capped by the pool value). Old rows keep NULL and are never rewritten;
--     void flips of OLD records (posted before this migration) work because their originals simply have no link yet.
-- M3  a return reversal row (sale_return) must remove units (qty < 0), is linked to the restock row of its return line, removes at
--     most the value restored, and at most ONE residual sweep (adjustment) exists per return and product (unique index).
-- M4  one refund cash entry per return (partial unique index), restock quantity per return and product bounded by the returned lines.
-- L2  INSERT OR REPLACE cannot bypass the append-only ledgers (recursive_triggers is off, so a REPLACE never fires the DELETE trigger):
--     BEFORE INSERT triggers refuse an id that already exists and a second link; schema_migrations is guarded against UPDATE / DELETE / REPLACE.

-- ---------------------------------------------------------------------------------------------
-- 1. Link column and unique keys.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE stock_movements ADD COLUMN reverses_movement_id INTEGER REFERENCES stock_movements(id);

CREATE UNIQUE INDEX uq_stock_movements_reverses ON stock_movements(reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cash_entries_reverses ON cash_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX uq_icecream_fund_entries_reverses ON icecream_fund_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
-- M4: one refund entry per return (the only non-reversal cash entry a return ever has).
CREATE UNIQUE INDEX uq_cash_entries_return_refund ON cash_entries(ref_id) WHERE ref_table = 'sales_returns' AND reverses_entry_id IS NULL;
-- M3: at most one residual sweep (value-only adjustment) per return and product.
CREATE UNIQUE INDEX uq_stock_movements_return_sweep ON stock_movements(ref_id, product_id) WHERE ref_table = 'sales_returns' AND type = 'adjustment';
CREATE INDEX idx_stock_movements_reverses ON stock_movements(reverses_movement_id);

-- ---------------------------------------------------------------------------------------------
-- 2. A reversal row must mirror the row it cancels (every type, every table), exist once, and never be written for a void record.
--    A "pre-check" trigger repeats each unique key so that INSERT OR REPLACE (which would delete the older row WITHOUT firing the
--    DELETE trigger) is refused with the same message a plain duplicate gets.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_cash_entries_no_replace BEFORE INSERT ON cash_entries
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM cash_entries WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'cash_entries is append-only');
END;

CREATE TRIGGER trg_cash_entries_reversal_unique BEFORE INSERT ON cash_entries
WHEN NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM cash_entries WHERE reverses_entry_id = NEW.reverses_entry_id)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: cash_entries.reverses_entry_id');
END;

CREATE TRIGGER trg_cash_entries_return_refund_unique BEFORE INSERT ON cash_entries
WHEN NEW.ref_table = 'sales_returns' AND NEW.reverses_entry_id IS NULL
 AND EXISTS (SELECT 1 FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = NEW.ref_id AND reverses_entry_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: cash_entries.ref_id');
END;

-- A cash entry that claims to reverse another must mirror it exactly (all types, not only return reversals).
CREATE TRIGGER trg_cash_entries_reversal_mirror BEFORE INSERT ON cash_entries
WHEN NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM cash_entries o
   WHERE o.id = NEW.reverses_entry_id AND o.reverses_entry_id IS NULL AND o.amount_cents = -NEW.amount_cents
     AND o.book = NEW.book AND o.fund IS NEW.fund AND o.business_date = NEW.business_date AND o.type = NEW.type
     AND o.ref_table IS NEW.ref_table AND o.ref_id IS NEW.ref_id AND o.transfer_id IS NEW.transfer_id)
BEGIN
  SELECT RAISE(ABORT, 'REVERSAL_MISMATCH');
END;

-- No new (non-reversal) cash entry can be attached to a record that is already void.
CREATE TRIGGER trg_cash_entries_record_void BEFORE INSERT ON cash_entries
WHEN NEW.reverses_entry_id IS NULL AND NEW.ref_table IS NOT NULL AND (
    (NEW.ref_table = 'sales' AND (SELECT status FROM sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'sales_returns' AND (SELECT status FROM sales_returns WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'purchases' AND (SELECT status FROM purchases WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'owner_drawings' AND (SELECT status FROM owner_drawings WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'expenses' AND (SELECT status FROM expenses WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'capital_entries' AND (SELECT status FROM capital_entries WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'cash_counts' AND (SELECT status FROM cash_counts WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'reload_sales' AND (SELECT status FROM reload_sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'ezcash_sales' AND (SELECT status FROM ezcash_sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'telecom_topups' AND (SELECT status FROM telecom_topups WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'print_sales' AND (SELECT status FROM print_sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'printing_supplies' AND (SELECT status FROM printing_supplies WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'cash_transfers' AND (SELECT status FROM cash_transfers WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'icecream_days' AND (SELECT status FROM icecream_days WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'icecream_payments' AND (SELECT status FROM icecream_payments WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'icecream_fund_moves' AND (SELECT status FROM icecream_fund_moves WHERE id = NEW.ref_id) = 'void'))
BEGIN
  SELECT RAISE(ABORT, 'RECORD_VOID');
END;

CREATE TRIGGER trg_icecream_fund_entries_no_replace BEFORE INSERT ON icecream_fund_entries
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM icecream_fund_entries WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'icecream_fund_entries is append-only');
END;

CREATE TRIGGER trg_icecream_fund_entries_reversal_unique BEFORE INSERT ON icecream_fund_entries
WHEN NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM icecream_fund_entries WHERE reverses_entry_id = NEW.reverses_entry_id)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: icecream_fund_entries.reverses_entry_id');
END;

CREATE TRIGGER trg_icecream_fund_entries_reversal_mirror BEFORE INSERT ON icecream_fund_entries
WHEN NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM icecream_fund_entries o
   WHERE o.id = NEW.reverses_entry_id AND o.reverses_entry_id IS NULL AND o.amount_cents = -NEW.amount_cents
     AND o.fund = NEW.fund AND o.business_date = NEW.business_date
     AND o.ref_table IS NEW.ref_table AND o.ref_id IS NEW.ref_id)
BEGIN
  SELECT RAISE(ABORT, 'REVERSAL_MISMATCH');
END;

CREATE TRIGGER trg_icecream_fund_entries_record_void BEFORE INSERT ON icecream_fund_entries
WHEN NEW.reverses_entry_id IS NULL AND NEW.ref_table IS NOT NULL AND (
    (NEW.ref_table = 'sales' AND (SELECT status FROM sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'sales_returns' AND (SELECT status FROM sales_returns WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'purchases' AND (SELECT status FROM purchases WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'owner_drawings' AND (SELECT status FROM owner_drawings WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'expenses' AND (SELECT status FROM expenses WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'capital_entries' AND (SELECT status FROM capital_entries WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'cash_counts' AND (SELECT status FROM cash_counts WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'reload_sales' AND (SELECT status FROM reload_sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'ezcash_sales' AND (SELECT status FROM ezcash_sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'telecom_topups' AND (SELECT status FROM telecom_topups WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'print_sales' AND (SELECT status FROM print_sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'printing_supplies' AND (SELECT status FROM printing_supplies WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'cash_transfers' AND (SELECT status FROM cash_transfers WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'icecream_days' AND (SELECT status FROM icecream_days WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'icecream_payments' AND (SELECT status FROM icecream_payments WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'icecream_fund_moves' AND (SELECT status FROM icecream_fund_moves WHERE id = NEW.ref_id) = 'void'))
BEGIN
  SELECT RAISE(ABORT, 'RECORD_VOID');
END;

CREATE TRIGGER trg_stock_movements_no_replace BEFORE INSERT ON stock_movements
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM stock_movements WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER trg_stock_movements_reversal_unique BEFORE INSERT ON stock_movements
WHEN NEW.reverses_movement_id IS NOT NULL AND EXISTS (SELECT 1 FROM stock_movements WHERE reverses_movement_id = NEW.reverses_movement_id)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: stock_movements.reverses_movement_id');
END;

CREATE TRIGGER trg_stock_movements_sweep_unique BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND NEW.type = 'adjustment'
 AND EXISTS (SELECT 1 FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = NEW.ref_id AND product_id = NEW.product_id AND type = 'adjustment')
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: stock_movements.ref_id, stock_movements.product_id');
END;

-- A reversal movement cancels exactly one original of the SAME record and product: same date, opposite quantity, value of the
-- opposite sign and not larger (R4 may cap a removal at the pool value), same type (a purchase is undone as 'purchase_void').
CREATE TRIGGER trg_stock_movements_reversal_mirror BEFORE INSERT ON stock_movements
WHEN NEW.reverses_movement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM stock_movements o
   WHERE o.id = NEW.reverses_movement_id AND o.reverses_movement_id IS NULL AND o.product_id = NEW.product_id
     AND o.ref_table IS NEW.ref_table AND o.ref_id IS NEW.ref_id AND o.business_date = NEW.business_date
     AND o.qty_delta = -NEW.qty_delta
     AND (o.type = NEW.type OR (o.type = 'purchase' AND NEW.type = 'purchase_void'))
     AND ((o.value_delta_cents >= 0 AND NEW.value_delta_cents <= 0 AND -NEW.value_delta_cents <= o.value_delta_cents)
       OR (o.value_delta_cents <= 0 AND NEW.value_delta_cents >= 0 AND NEW.value_delta_cents <= -o.value_delta_cents)))
BEGIN
  SELECT RAISE(ABORT, 'REVERSAL_MISMATCH');
END;

-- No stock movement of any kind can be attached to a record that is already void.
CREATE TRIGGER trg_stock_movements_record_void BEFORE INSERT ON stock_movements
WHEN NEW.ref_table IS NOT NULL AND (
    (NEW.ref_table = 'sales' AND (SELECT status FROM sales WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'sales_returns' AND (SELECT status FROM sales_returns WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'purchases' AND (SELECT status FROM purchases WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'stock_losses' AND (SELECT status FROM stock_losses WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'stocktakes' AND (SELECT status FROM stocktakes WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'owner_drawings' AND (SELECT status FROM owner_drawings WHERE id = NEW.ref_id) = 'void')
    OR (NEW.ref_table = 'opening_stock_batches' AND (SELECT status FROM opening_stock_batches WHERE id = NEW.ref_id) = 'void'))
BEGIN
  SELECT RAISE(ABORT, 'RECORD_VOID');
END;

-- ---------------------------------------------------------------------------------------------
-- 3. Sales return: the migration-017 triggers re-created for reversal-FIRST order (the return is still 'posted' while its
--    reversal rows are written; trg_*_void_requires_reversal below then lets the flip pass).
--    * a reversal / sweep row is accepted only for a POSTED return that is the NEWEST posted return of every line it touches
--      (RETURN_NOT_NEWEST, so no orphan reversal can be written for a return that can never become void);
--    * a stock reversal is a sale_return row with qty < 0 linked to a restock row of that return (RETURN_NOT_VOID otherwise,
--      also for value-only sale_return rows); the only unlinked row allowed is ONE residual sweep: a value-only negative
--      adjustment written exactly when the product pool equals the units about to leave (the service's R-VR 3 sweep);
--    * value removed per return and product <= value restored; units removed <= units restocked (existing cap, unchanged);
--    * a refund reversal must mirror its refund entry of the same return (RETURN_REVERSAL_INVALID, as before).
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER trg_stock_movements_return_reversal_void;
CREATE TRIGGER trg_stock_movements_return_reversal_void
BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND NEW.type IN ('sale_return','adjustment') AND NEW.qty_delta <= 0
 AND NOT (
   (SELECT status FROM sales_returns WHERE id = NEW.ref_id) = 'posted'
   AND ((NEW.type = 'sale_return' AND NEW.qty_delta < 0 AND NEW.reverses_movement_id IS NOT NULL)
     OR (NEW.type = 'adjustment' AND NEW.qty_delta = 0 AND NEW.value_delta_cents < 0 AND NEW.reverses_movement_id IS NULL
         AND EXISTS (SELECT 1 FROM stock_movements o
                      WHERE o.ref_table = 'sales_returns' AND o.ref_id = NEW.ref_id AND o.product_id = NEW.product_id
                        AND o.type = 'sale_return' AND o.qty_delta > 0
                        AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                        AND o.qty_delta = (SELECT qty_on_hand FROM products WHERE id = NEW.product_id)))))
BEGIN
  SELECT RAISE(ABORT, 'RETURN_NOT_VOID');
END;

CREATE TRIGGER trg_stock_movements_return_reversal_newest
BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND NEW.type IN ('sale_return','adjustment') AND NEW.qty_delta <= 0
 AND EXISTS (SELECT 1
                FROM sales_return_items mine
                JOIN sales_return_items other ON other.sale_item_id = mine.sale_item_id AND other.sales_return_id > mine.sales_return_id
                JOIN sales_returns r2 ON r2.id = other.sales_return_id AND r2.status = 'posted'
               WHERE mine.sales_return_id = NEW.ref_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_NOT_NEWEST');
END;

CREATE TRIGGER trg_stock_movements_return_reversal_value
BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND NEW.type = 'sale_return' AND NEW.qty_delta < 0
 AND (-NEW.value_delta_cents + COALESCE((SELECT -SUM(m.value_delta_cents) FROM stock_movements m
                                          WHERE m.ref_table = 'sales_returns' AND m.ref_id = NEW.ref_id AND m.type = 'sale_return'
                                            AND m.product_id = NEW.product_id AND m.qty_delta < 0), 0))
     > COALESCE((SELECT SUM(m.value_delta_cents) FROM stock_movements m
                  WHERE m.ref_table = 'sales_returns' AND m.ref_id = NEW.ref_id AND m.type = 'sale_return'
                    AND m.product_id = NEW.product_id AND m.qty_delta > 0), 0)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_REVERSAL_EXCEEDS');
END;

-- M4: a return only ever writes sale_return restocks (qty > 0) and its void writes removals / one sweep; the restocked
-- quantity per product can never exceed the resalable quantity of the return's own lines.
CREATE TRIGGER trg_stock_movements_return_restock
BEFORE INSERT ON stock_movements
WHEN NEW.ref_table = 'sales_returns' AND (
     NEW.type NOT IN ('sale_return','adjustment')
  OR (NEW.qty_delta > 0 AND (NEW.type <> 'sale_return'
        OR NEW.qty_delta + COALESCE((SELECT SUM(m.qty_delta) FROM stock_movements m
                                      WHERE m.ref_table = 'sales_returns' AND m.ref_id = NEW.ref_id AND m.type = 'sale_return'
                                        AND m.product_id = NEW.product_id AND m.qty_delta > 0), 0)
           > COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id
                        WHERE ri.sales_return_id = NEW.ref_id AND ri.resalable = 1 AND si.product_id = NEW.product_id), 0))))
BEGIN
  SELECT RAISE(ABORT, 'RETURN_RESTOCK_EXCEEDS');
END;

DROP TRIGGER trg_cash_entries_return_reversal;
CREATE TRIGGER trg_cash_entries_return_reversal
BEFORE INSERT ON cash_entries
WHEN NEW.ref_table = 'sales_returns' AND NEW.amount_cents > 0
 AND (NEW.reverses_entry_id IS NULL
      OR (SELECT status FROM sales_returns WHERE id = NEW.ref_id) IS NOT 'posted'
      OR NOT EXISTS (SELECT 1 FROM cash_entries o
                      WHERE o.id = NEW.reverses_entry_id AND o.ref_table = 'sales_returns' AND o.ref_id = NEW.ref_id
                        AND o.book = NEW.book AND o.type = NEW.type AND o.amount_cents = -NEW.amount_cents
                        AND o.business_date = NEW.business_date))
BEGIN
  SELECT RAISE(ABORT, 'RETURN_REVERSAL_INVALID');
END;

CREATE TRIGGER trg_cash_entries_return_reversal_newest
BEFORE INSERT ON cash_entries
WHEN NEW.ref_table = 'sales_returns' AND NEW.amount_cents > 0 AND NEW.reverses_entry_id IS NOT NULL
 AND EXISTS (SELECT 1
                FROM sales_return_items mine
                JOIN sales_return_items other ON other.sale_item_id = mine.sale_item_id AND other.sales_return_id > mine.sales_return_id
                JOIN sales_returns r2 ON r2.id = other.sales_return_id AND r2.status = 'posted'
               WHERE mine.sales_return_id = NEW.ref_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_NOT_NEWEST');
END;

-- ---------------------------------------------------------------------------------------------
-- 4. M2: the status flip. posted -> void (completed -> void for a stocktake; a draft has no rows and passes) is refused with
--    VOID_WITHOUT_REVERSAL unless EVERY original cash entry (non-zero), stock movement and Ice Cream fund row of the record
--    already has its reversal row. A residual sweep (value-only adjustment) needs no reversal of its own but must be followed by
--    a linked reversal of the same product. Records without ledger rows (zero-total sale, draft stocktake, zero-difference cash
--    count, damaged-return loss) are exempt automatically. Every table keeps posted -> void as its only transition (the
--    *_immutable triggers of 004-014 make 'void' terminal; verified for all tables by the migration-020 tests).
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_sales_void_requires_reversal
BEFORE UPDATE OF status ON sales
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'sales' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_sales_returns_void_requires_reversal
BEFORE UPDATE OF status ON sales_returns
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'sales_returns' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'sales_returns' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'sales_returns' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_purchases_void_requires_reversal
BEFORE UPDATE OF status ON purchases
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'purchases' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'purchases' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'purchases' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_stock_losses_void_requires_reversal
BEFORE UPDATE OF status ON stock_losses
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'stock_losses' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'stock_losses' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'stock_losses' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_stocktakes_void_requires_reversal
BEFORE UPDATE OF status ON stocktakes
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'stocktakes' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'stocktakes' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'stocktakes' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_owner_drawings_void_requires_reversal
BEFORE UPDATE OF status ON owner_drawings
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'owner_drawings' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'owner_drawings' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'owner_drawings' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_opening_stock_batches_void_requires_reversal
BEFORE UPDATE OF status ON opening_stock_batches
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'opening_stock_batches' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'opening_stock_batches' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'opening_stock_batches' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_expenses_void_requires_reversal
BEFORE UPDATE OF status ON expenses
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'expenses' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'expenses' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'expenses' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_capital_entries_void_requires_reversal
BEFORE UPDATE OF status ON capital_entries
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'capital_entries' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'capital_entries' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'capital_entries' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_cash_counts_void_requires_reversal
BEFORE UPDATE OF status ON cash_counts
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'cash_counts' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'cash_counts' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'cash_counts' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_reload_sales_void_requires_reversal
BEFORE UPDATE OF status ON reload_sales
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'reload_sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'reload_sales' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'reload_sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_ezcash_sales_void_requires_reversal
BEFORE UPDATE OF status ON ezcash_sales
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'ezcash_sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'ezcash_sales' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'ezcash_sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_telecom_topups_void_requires_reversal
BEFORE UPDATE OF status ON telecom_topups
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'telecom_topups' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'telecom_topups' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'telecom_topups' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_print_sales_void_requires_reversal
BEFORE UPDATE OF status ON print_sales
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'print_sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'print_sales' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'print_sales' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_printing_supplies_void_requires_reversal
BEFORE UPDATE OF status ON printing_supplies
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'printing_supplies' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'printing_supplies' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'printing_supplies' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_cash_transfers_void_requires_reversal
BEFORE UPDATE OF status ON cash_transfers
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'cash_transfers' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'cash_transfers' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'cash_transfers' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_icecream_days_void_requires_reversal
BEFORE UPDATE OF status ON icecream_days
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'icecream_days' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'icecream_days' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'icecream_days' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_icecream_payments_void_requires_reversal
BEFORE UPDATE OF status ON icecream_payments
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'icecream_payments' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'icecream_payments' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'icecream_payments' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

CREATE TRIGGER trg_icecream_fund_moves_void_requires_reversal
BEFORE UPDATE OF status ON icecream_fund_moves
WHEN OLD.status <> 'void' AND NEW.status = 'void' AND NEW.voided_at IS NOT NULL AND NEW.void_reason IS NOT NULL
 AND (
    EXISTS (SELECT 1 FROM cash_entries o
             WHERE o.ref_table = 'icecream_fund_moves' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL AND o.amount_cents <> 0
               AND NOT EXISTS (SELECT 1 FROM cash_entries r
                                WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.book = o.book
                                  AND r.fund IS o.fund AND r.business_date = o.business_date))
    OR EXISTS (SELECT 1 FROM stock_movements o
                WHERE o.ref_table = 'icecream_fund_moves' AND o.ref_id = OLD.id AND o.reverses_movement_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
                  AND NOT (o.type = 'adjustment' AND o.qty_delta = 0 AND o.value_delta_cents < 0
                           AND EXISTS (SELECT 1 FROM stock_movements c
                                        WHERE c.ref_table = o.ref_table AND c.ref_id = o.ref_id AND c.product_id = o.product_id
                                          AND c.reverses_movement_id IS NOT NULL AND c.id > o.id)))
    OR EXISTS (SELECT 1 FROM icecream_fund_entries o
                WHERE o.ref_table = 'icecream_fund_moves' AND o.ref_id = OLD.id AND o.reverses_entry_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r
                                   WHERE r.reverses_entry_id = o.id AND r.amount_cents = -o.amount_cents AND r.fund = o.fund
                                     AND r.business_date = o.business_date))
 )
BEGIN
  SELECT RAISE(ABORT, 'VOID_WITHOUT_REVERSAL');
END;

-- ---------------------------------------------------------------------------------------------
-- 5. schema_migrations: the migration history cannot be rewritten, deleted or replaced.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_schema_migrations_no_update BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

CREATE TRIGGER trg_schema_migrations_no_delete BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

CREATE TRIGGER trg_schema_migrations_no_replace BEFORE INSERT ON schema_migrations
WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- 6. Audit log: INSERT OR REPLACE with an existing id would overwrite a row without firing the DELETE trigger.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_audit_logs_no_replace BEFORE INSERT ON audit_logs
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_logs WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER trg_external_backup_log_no_replace BEFORE INSERT ON external_backup_log
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM external_backup_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'external_backup_log is append-only');
END;
