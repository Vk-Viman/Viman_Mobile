-- 007_no_hard_deletes.sql
--
-- BUSINESS_RULES section 12: "No hard deletes of completed transactions". A mistake is corrected by VOIDING the
-- record (status 'void' plus reversal rows, R1/C6), never by removing it, so the history stays complete and the
-- audit trail stays truthful.
--
-- Until now only the ledgers (stock_movements, cash_entries, audit_logs) and the return tables refused DELETE at
-- database level; the business documents below relied on the application never issuing a DELETE. This migration
-- adds the same protection to them, so even a bug or a hand-typed SQL statement cannot erase a posted transaction.
--
-- Deliberately NOT covered: stocktake_items. A DRAFT count sheet is replaced by deleting and re-inserting its
-- lines (completed/void stocktakes are already protected there by trigger STOCKTAKE_NOT_DRAFT in migration 005).
-- The catalogue tables (categories, products, suppliers) are master data, not transactions, and are retired with
-- active = 0 by the application.

CREATE TRIGGER trg_purchases_no_delete
BEFORE DELETE ON purchases
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_purchase_items_no_delete
BEFORE DELETE ON purchase_items
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_stocktakes_no_delete
BEFORE DELETE ON stocktakes
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_stock_losses_no_delete
BEFORE DELETE ON stock_losses
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_owner_drawings_no_delete
BEFORE DELETE ON owner_drawings
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_sales_no_delete
BEFORE DELETE ON sales
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_sale_items_no_delete
BEFORE DELETE ON sale_items
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;
