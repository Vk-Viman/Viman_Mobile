-- 022_corrections.sql - "correct this entry" = void the original + enter a replacement, linked in one append-only table.
-- Runner wraps this file in a transaction. Forward-only: no earlier migration is edited and NO existing row of any table is touched
-- (the original keeps its normal posted -> void flip made by the existing void service; the link lives only here).
--
-- WHY a separate table and not a column on every record table: the originals must never be modified beyond the guarded status flip, the
-- ten supported tables stay exactly as they are (no rebuild, no new nullable column), and one trigger set protects all links.
--
-- One row = one correction: `original_id` (now void) was replaced by `replacement_id` (a normal posted record of the same table).
-- The reason is stored here and ALSO on the original as its void reason (written by the existing void service).

CREATE TABLE corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The table of the corrected record (the same table holds the replacement). Phase 1 and Phase 2 types are listed now so that
  -- Phase 2 needs no schema change; each service decides which types it actually offers.
  entity         TEXT    NOT NULL CHECK (entity IN (
                   'sales', 'expenses', 'cash_transfers', 'capital_entries', 'owner_drawings', 'telecom_topups',
                   'printing_supplies', 'icecream_payments', 'icecream_fund_moves', 'stock_losses',
                   'purchases', 'print_sales', 'reload_sales', 'ezcash_sales')),
  original_id    INTEGER NOT NULL CHECK (original_id >= 1),
  replacement_id INTEGER NOT NULL CHECK (replacement_id >= 1),
  reason         TEXT    NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  -- The client reference of the replacement record: a repeated request (double click) finds the same correction.
  client_ref     TEXT    NOT NULL CHECK (length(client_ref) >= 1),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (original_id <> replacement_id),
  -- An original is corrected once; a replacement replaces exactly one original (it can itself be corrected later: new chain link).
  UNIQUE (entity, original_id),
  UNIQUE (entity, replacement_id),
  UNIQUE (entity, client_ref)
);
CREATE INDEX idx_corrections_entity_replacement ON corrections(entity, replacement_id);

-- ---------------------------------------------------------------------------------------------
-- The link must be true when written: the original is void, the replacement is a posted record, both exist in `entity`'s table, and the
-- replacement is a different (newer) record. A link to a posted original, or to a record that does not exist, is refused.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_corrections_valid BEFORE INSERT ON corrections
BEGIN
  SELECT RAISE(ABORT, 'CORRECTION_ORIGINAL_NOT_VOID')
  WHERE NOT COALESCE(CASE NEW.entity
    WHEN 'sales'               THEN (SELECT status = 'void' FROM sales               WHERE id = NEW.original_id)
    WHEN 'expenses'            THEN (SELECT status = 'void' FROM expenses            WHERE id = NEW.original_id)
    WHEN 'cash_transfers'      THEN (SELECT status = 'void' FROM cash_transfers      WHERE id = NEW.original_id)
    WHEN 'capital_entries'     THEN (SELECT status = 'void' FROM capital_entries     WHERE id = NEW.original_id)
    WHEN 'owner_drawings'      THEN (SELECT status = 'void' FROM owner_drawings      WHERE id = NEW.original_id)
    WHEN 'telecom_topups'      THEN (SELECT status = 'void' FROM telecom_topups      WHERE id = NEW.original_id)
    WHEN 'printing_supplies'   THEN (SELECT status = 'void' FROM printing_supplies   WHERE id = NEW.original_id)
    WHEN 'icecream_payments'   THEN (SELECT status = 'void' FROM icecream_payments   WHERE id = NEW.original_id)
    WHEN 'icecream_fund_moves' THEN (SELECT status = 'void' FROM icecream_fund_moves WHERE id = NEW.original_id)
    WHEN 'stock_losses'        THEN (SELECT status = 'void' FROM stock_losses        WHERE id = NEW.original_id)
    WHEN 'purchases'           THEN (SELECT status = 'void' FROM purchases           WHERE id = NEW.original_id)
    WHEN 'print_sales'         THEN (SELECT status = 'void' FROM print_sales         WHERE id = NEW.original_id)
    WHEN 'reload_sales'        THEN (SELECT status = 'void' FROM reload_sales        WHERE id = NEW.original_id)
    WHEN 'ezcash_sales'        THEN (SELECT status = 'void' FROM ezcash_sales        WHERE id = NEW.original_id)
  END, 0);

  SELECT RAISE(ABORT, 'CORRECTION_REPLACEMENT_NOT_POSTED')
  WHERE NOT COALESCE(CASE NEW.entity
    WHEN 'sales'               THEN (SELECT status = 'posted' FROM sales               WHERE id = NEW.replacement_id)
    WHEN 'expenses'            THEN (SELECT status = 'posted' FROM expenses            WHERE id = NEW.replacement_id)
    WHEN 'cash_transfers'      THEN (SELECT status = 'posted' FROM cash_transfers      WHERE id = NEW.replacement_id)
    WHEN 'capital_entries'     THEN (SELECT status = 'posted' FROM capital_entries     WHERE id = NEW.replacement_id)
    WHEN 'owner_drawings'      THEN (SELECT status = 'posted' FROM owner_drawings      WHERE id = NEW.replacement_id)
    WHEN 'telecom_topups'      THEN (SELECT status = 'posted' FROM telecom_topups      WHERE id = NEW.replacement_id)
    WHEN 'printing_supplies'   THEN (SELECT status = 'posted' FROM printing_supplies   WHERE id = NEW.replacement_id)
    WHEN 'icecream_payments'   THEN (SELECT status = 'posted' FROM icecream_payments   WHERE id = NEW.replacement_id)
    WHEN 'icecream_fund_moves' THEN (SELECT status = 'posted' FROM icecream_fund_moves WHERE id = NEW.replacement_id)
    WHEN 'stock_losses'        THEN (SELECT status = 'posted' FROM stock_losses        WHERE id = NEW.replacement_id)
    WHEN 'purchases'           THEN (SELECT status = 'posted' FROM purchases           WHERE id = NEW.replacement_id)
    WHEN 'print_sales'         THEN (SELECT status = 'posted' FROM print_sales         WHERE id = NEW.replacement_id)
    WHEN 'reload_sales'        THEN (SELECT status = 'posted' FROM reload_sales        WHERE id = NEW.replacement_id)
    WHEN 'ezcash_sales'        THEN (SELECT status = 'posted' FROM ezcash_sales        WHERE id = NEW.replacement_id)
  END, 0);

  -- The replacement is entered after the original, so it always has the higher id.
  SELECT RAISE(ABORT, 'CORRECTION_REPLACEMENT_NOT_NEWER') WHERE NEW.replacement_id <= NEW.original_id;
END;

-- INSERT OR REPLACE would delete an older link without firing the DELETE trigger (recursive_triggers is off): refuse every clash first.
CREATE TRIGGER trg_corrections_no_replace BEFORE INSERT ON corrections
WHEN (NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM corrections WHERE id = NEW.id))
  OR EXISTS (SELECT 1 FROM corrections WHERE entity = NEW.entity AND original_id = NEW.original_id)
  OR EXISTS (SELECT 1 FROM corrections WHERE entity = NEW.entity AND replacement_id = NEW.replacement_id)
  OR EXISTS (SELECT 1 FROM corrections WHERE entity = NEW.entity AND client_ref = NEW.client_ref)
BEGIN
  SELECT RAISE(ABORT, 'corrections is append-only: this record already has a correction link');
END;

CREATE TRIGGER trg_corrections_no_update BEFORE UPDATE ON corrections
BEGIN
  SELECT RAISE(ABORT, 'corrections is append-only');
END;

CREATE TRIGGER trg_corrections_no_delete BEFORE DELETE ON corrections
BEGIN
  SELECT RAISE(ABORT, 'corrections is append-only');
END;
