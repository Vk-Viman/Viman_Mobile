-- 018_external_backups.sql - external backup folder (BUSINESS_RULES section 12 "External backups", decision 11).
-- Runner wraps this file in a transaction. Forward-only.
--
-- WHY this file exists: besides the local backups folder, the owner may name an external folder (for example a USB
-- drive). Two small tables hold that: the one-row setting, and an append-only log of every copy attempt, from which
-- the "last successful copy", "last attempt" and the seven-day warning are derived. No existing table is touched
-- (the `settings` table keys are CHECK-restricted and are not used).

-- ---------------------------------------------------------------------------------------------
-- backup_settings: exactly one row (id = 1). external_dir NULL = no external folder configured.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE backup_settings (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  external_dir TEXT CHECK (external_dir IS NULL OR length(external_dir) BETWEEN 1 AND 1000),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO backup_settings (id, external_dir) VALUES (1, NULL);

CREATE TRIGGER trg_backup_settings_no_delete
BEFORE DELETE ON backup_settings
BEGIN
  SELECT RAISE(ABORT, 'BACKUP_SETTINGS_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- external_backup_log: append-only record of copy attempts.
--   ok      : a verified copy exists (target_name, size_bytes and sha256 are set)
--   skipped : an identical copy was already present (target_name = the existing file)
--   failed  : the copy did not happen; `error` says why in plain words
-- ---------------------------------------------------------------------------------------------
CREATE TABLE external_backup_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT,
  target_name TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('ok','failed','skipped')),
  size_bytes  INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256      TEXT    CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  error       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'ok'      OR (target_name IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (status <> 'skipped' OR target_name IS NOT NULL),
  CHECK (status <> 'failed'  OR error IS NOT NULL)
);
CREATE INDEX idx_external_backup_log_status_created ON external_backup_log(status, created_at);

CREATE TRIGGER trg_external_backup_log_no_update
BEFORE UPDATE ON external_backup_log
BEGIN
  SELECT RAISE(ABORT, 'EXTERNAL_BACKUP_LOG_APPEND_ONLY');
END;

CREATE TRIGGER trg_external_backup_log_no_delete
BEFORE DELETE ON external_backup_log
BEGIN
  SELECT RAISE(ABORT, 'EXTERNAL_BACKUP_LOG_APPEND_ONLY');
END;
