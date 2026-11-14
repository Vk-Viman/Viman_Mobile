// Test helper: simulate a backup file whose migration records were tampered with. Migration 020 guards `schema_migrations` against UPDATE, so
// the test lifts that guard on ITS OWN COPY, applies the change and puts the identical trigger back: the file then differs from a good one only
// in the tampered migration record (the restore validator must report exactly that, not "a trigger is missing").
import type { DatabaseSync } from 'node:sqlite';

/** Runs `updateSql` against `schema_migrations` of `db` with the 020 guard lifted and restored afterwards. */
export function tamperMigrationRecords(db: DatabaseSync, updateSql: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_schema_migrations_no_update'").get() as unknown as { sql: string } | undefined;
  if (row) db.exec('DROP TRIGGER trg_schema_migrations_no_update');
  db.exec(updateSql);
  if (row) db.exec(row.sql);
}
