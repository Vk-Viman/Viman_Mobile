-- audit_logs is append-only (BUSINESS_RULES §12, R1). The application never edits or deletes
-- audit rows; these triggers make the database itself refuse it too.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
