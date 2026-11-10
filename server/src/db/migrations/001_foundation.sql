-- 001_foundation: migration bookkeeping, settings, audit log (Phase 1)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,           -- NNN from the file name
  name        TEXT    NOT NULL,              -- file name, e.g. 001_foundation.sql
  checksum    TEXT    NOT NULL,              -- sha256 hex of LF-normalised file text
  applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY CHECK (key IN ('shop','rates','printDefaults')),
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  entity      TEXT    NOT NULL,              -- e.g. 'settings', 'backup', 'sale'
  entity_id   TEXT,                          -- id or key of the entity (text to allow keys)
  action      TEXT    NOT NULL,              -- e.g. 'update', 'create', 'void', 'restore', 'reopen'
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json  TEXT CHECK (after_json  IS NULL OR json_valid(after_json)),
  note        TEXT
);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_logs_at     ON audit_logs(at);
