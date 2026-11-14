-- 021_external_backup_state.sql - accurate external backup status and a bounded failure log
-- (hardening findings M5 and M6, API_CONTRACTS "Hardening contract"). Runner wraps this file in a transaction. Forward-only.
--
-- WHY: until now the status was derived only from the append-only `external_backup_log`: a run that found every backup already on the
-- drive wrote nothing, so "Copy backup now" could never clear the seven-day warning (M5), and every failed pass appended one row per
-- pending backup, so a read-only or full drive grew the log without bound (M6). The mutable table below holds the running facts per
-- external FOLDER; the log keeps only state changes.
--
-- Nothing in `external_backup_log` or `backup_settings` is changed (no row is read-modify-written, no trigger is touched).

CREATE TABLE external_backup_state (
  -- The folder this row describes (the value of backup_settings.external_dir). Case-insensitive: Windows paths are.
  folder               TEXT PRIMARY KEY COLLATE NOCASE CHECK (length(folder) BETWEEN 1 AND 1000),
  -- When this folder became the reference (the day it was set up). The seven-day clock of a never-synchronized folder starts here.
  first_seen_at        TEXT NOT NULL,
  -- Time of the newest run of any kind that reached the drive logic.
  last_attempt_at      TEXT,
  -- Newest run in which at least one file was really copied and verified.
  last_success_at      TEXT,
  -- Newest run that found the folder available and EVERY start-up/manual backup present and verified (even when nothing was written).
  last_sync_at         TEXT,
  -- Runs in a row that ended with a failure; 0 after the next fully successful run.
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- Failed runs since the folder was set (never reset by a recovery).
  total_failures       INTEGER NOT NULL DEFAULT 0 CHECK (total_failures >= 0),
  -- Kind (ENOSPC, EROFS, EACCES, DRIVE_MISSING, CHECKSUM, ...) and plain-language text of the newest failure; kept after a recovery as history.
  last_error_code      TEXT,
  last_error_message   TEXT,
  -- First failure of the current series of consecutive failures (NULL when consecutive_failures = 0).
  first_failure_at     TEXT,
  -- When the newest failed row was appended to the log (at most one per error kind and source file per 24 hours).
  last_failure_logged_at TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (consecutive_failures = 0 OR first_failure_at IS NOT NULL),
  CHECK (consecutive_failures <= total_failures)
);

-- ---------------------------------------------------------------------------------------------
-- Carry the existing information over (no data is invented): only for the folder currently configured.
--   last_success_at / last_sync_at = newest 'ok' or 'skipped' row (a verified copy or a verified identical file) of the log;
--   a trailing series of failed rows (newer than the newest non-failed row) becomes the current failure series.
-- ---------------------------------------------------------------------------------------------
INSERT INTO external_backup_state (
  folder, first_seen_at, last_attempt_at, last_success_at, last_sync_at,
  consecutive_failures, total_failures, last_error_code, last_error_message, first_failure_at, last_failure_logged_at, updated_at
)
SELECT
  s.external_dir,
  s.updated_at,
  (SELECT MAX(created_at) FROM external_backup_log),
  (SELECT MAX(created_at) FROM external_backup_log WHERE status = 'ok'),
  (SELECT MAX(created_at) FROM external_backup_log WHERE status IN ('ok','skipped')),
  (SELECT COUNT(*) FROM external_backup_log f
     WHERE f.status = 'failed' AND f.id > COALESCE((SELECT MAX(id) FROM external_backup_log WHERE status <> 'failed'), 0)),
  (SELECT COUNT(*) FROM external_backup_log WHERE status = 'failed'),
  (SELECT CASE WHEN COUNT(*) > 0 THEN 'EARLIER_FAILURE' END FROM external_backup_log WHERE status = 'failed'),
  (SELECT error FROM external_backup_log WHERE status = 'failed' ORDER BY id DESC LIMIT 1),
  (SELECT MIN(created_at) FROM external_backup_log f
     WHERE f.status = 'failed' AND f.id > COALESCE((SELECT MAX(id) FROM external_backup_log WHERE status <> 'failed'), 0)),
  (SELECT MAX(created_at) FROM external_backup_log WHERE status = 'failed'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM backup_settings s
WHERE s.id = 1 AND s.external_dir IS NOT NULL;
