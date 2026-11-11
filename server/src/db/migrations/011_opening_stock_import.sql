-- Phase 13: opening stock batches and the Excel import audit (migration 011).
-- Runner wraps this file in a transaction. Colombo date = date('now','+330 minutes') (UTC+5:30, no DST).
--
-- Rules implemented here (BUSINESS_RULES):
--   section 3   opening stock is an INFLOW through the inventory engine: one `opening` stock movement per line,
--               NO cash entry, NO purchase, NO profit-and-loss effect (nothing is created in any cash table).
--   R-FD        a batch cannot be dated later than today in Asia/Colombo (database backstop of the server check).
--   R1          a batch is never edited or deleted; a mistake is voided (status 'void', the stock is reversed by
--               new movements written by the server). Only the move posted -> void is allowed.
--   section 12  `client_ref` makes a repeated submission return the saved batch; the import audit tables are
--               append-only so the history of every preview / import attempt can never be rewritten.
-- The lines of a batch are NOT a separate table: they are the stock_movements rows with
-- ref_table = 'opening_stock_batches' and ref_id = the batch id (the movement ledger is the single source of truth).

-- ---------------------------------------------------------------------------------------------
-- opening_stock_batches: one row per manual entry or per committed Excel import
-- ---------------------------------------------------------------------------------------------
CREATE TABLE opening_stock_batches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date     TEXT    NOT NULL,
  posted_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source            TEXT    NOT NULL CHECK (source IN ('manual','excel')),
  file_name         TEXT,
  row_count         INTEGER NOT NULL CHECK (row_count >= 0),
  total_value_cents INTEGER NOT NULL CHECK (total_value_cents >= 0),
  status            TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at         TEXT,
  void_reason       TEXT,
  notes             TEXT    NOT NULL DEFAULT '',
  client_ref        TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  -- Only an Excel import has a file name.
  CHECK ((source = 'excel' AND file_name IS NOT NULL) OR (source = 'manual' AND file_name IS NULL)),
  -- A void carries both its time and its reason; a posted batch carries neither.
  CHECK ((status = 'void' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
      OR (status = 'posted' AND voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX idx_opening_stock_batches_business_date ON opening_stock_batches(business_date);
CREATE INDEX idx_opening_stock_batches_posted_at ON opening_stock_batches(posted_at);

CREATE TRIGGER trg_opening_stock_batches_future_date
BEFORE INSERT ON opening_stock_batches
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_opening_stock_batches_business_date_immutable
BEFORE UPDATE OF business_date ON opening_stock_batches
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_opening_stock_batches_posted_at_immutable
BEFORE UPDATE OF posted_at ON opening_stock_batches
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, never back.
CREATE TRIGGER trg_opening_stock_batches_immutable
BEFORE UPDATE OF id, source, file_name, row_count, total_value_cents, notes, client_ref, status, voided_at, void_reason
ON opening_stock_batches
WHEN NEW.id IS NOT OLD.id
  OR NEW.source IS NOT OLD.source
  OR NEW.file_name IS NOT OLD.file_name
  OR NEW.row_count IS NOT OLD.row_count
  OR NEW.total_value_cents IS NOT OLD.total_value_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'OPENING_STOCK_BATCHES_IMMUTABLE');
END;

CREATE TRIGGER trg_opening_stock_batches_no_delete
BEFORE DELETE ON opening_stock_batches
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- import_runs / import_issues: append-only audit of Excel previews and imports
-- ---------------------------------------------------------------------------------------------
CREATE TABLE import_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('opening_stock')),
  file_name     TEXT    NOT NULL,
  file_sha256   TEXT    NOT NULL CHECK (length(file_sha256) = 64),
  business_date TEXT    NOT NULL,
  mode          TEXT    NOT NULL CHECK (mode IN ('preview','commit')),
  status        TEXT    NOT NULL CHECK (status IN ('previewed','committed','rejected')),
  rows_total    INTEGER NOT NULL CHECK (rows_total >= 0),
  rows_ok       INTEGER NOT NULL CHECK (rows_ok >= 0),
  rows_failed   INTEGER NOT NULL CHECK (rows_failed >= 0),
  batch_id      INTEGER REFERENCES opening_stock_batches(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (rows_ok + rows_failed = rows_total),
  -- A preview is always 'previewed'; an import is either 'committed' (with its batch) or 'rejected' (nothing saved).
  CHECK ((mode = 'preview' AND status = 'previewed' AND batch_id IS NULL)
      OR (mode = 'commit' AND status = 'committed' AND batch_id IS NOT NULL AND rows_failed = 0)
      OR (mode = 'commit' AND status = 'rejected' AND batch_id IS NULL))
);
CREATE INDEX idx_import_runs_sha ON import_runs(file_sha256, status);
CREATE INDEX idx_import_runs_batch ON import_runs(batch_id);

CREATE TABLE import_issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  import_run_id INTEGER NOT NULL REFERENCES import_runs(id),
  row_no        INTEGER NOT NULL CHECK (row_no >= 0),
  column_name   TEXT    NOT NULL DEFAULT '',
  code          TEXT    NOT NULL,
  message       TEXT    NOT NULL
);
CREATE INDEX idx_import_issues_run ON import_issues(import_run_id);

CREATE TRIGGER trg_import_runs_no_update BEFORE UPDATE ON import_runs
BEGIN
  SELECT RAISE(ABORT, 'import_runs is append-only');
END;

CREATE TRIGGER trg_import_runs_no_delete BEFORE DELETE ON import_runs
BEGIN
  SELECT RAISE(ABORT, 'import_runs is append-only');
END;

CREATE TRIGGER trg_import_issues_no_update BEFORE UPDATE ON import_issues
BEGIN
  SELECT RAISE(ABORT, 'import_issues is append-only');
END;

CREATE TRIGGER trg_import_issues_no_delete BEFORE DELETE ON import_issues
BEGIN
  SELECT RAISE(ABORT, 'import_issues is append-only');
END;
