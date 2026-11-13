/**
 * repositories/external-backup.repo.ts - SQL for `backup_settings` and `external_backup_log` (migration 018).
 *
 * Layer: repository. No rules live here: the service decides what the rows mean (status, warnings, dedupe).
 * `external_backup_log` is append-only (the database refuses UPDATE and DELETE), so there is only an insert.
 */
import type { DatabaseSync } from 'node:sqlite';

export type LogStatus = 'ok' | 'failed' | 'skipped';

/** One copy attempt as stored. */
export interface ExternalLogRow {
  id: number;
  sourceName: string | null;
  targetName: string | null;
  status: LogStatus;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  createdAt: string;
}

interface RawLog {
  id: number | bigint; source_name: string | null; target_name: string | null; status: LogStatus;
  size_bytes: number | bigint | null; sha256: string | null; error: string | null; created_at: string;
}

function mapLog(r: RawLog): ExternalLogRow {
  return {
    id: Number(r.id), sourceName: r.source_name, targetName: r.target_name, status: r.status,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), sha256: r.sha256, error: r.error, createdAt: r.created_at,
  };
}

/** The single settings row: the configured folder (null = none) and when it was last changed. */
export function getBackupSettings(conn: DatabaseSync): { externalDir: string | null; updatedAt: string } {
  const r = conn.prepare('SELECT external_dir, updated_at FROM backup_settings WHERE id = 1').get() as
    { external_dir: string | null; updated_at: string } | undefined;
  return { externalDir: r?.external_dir ?? null, updatedAt: r?.updated_at ?? new Date(0).toISOString() };
}

/** Sets (or clears with null) the external folder and stamps `updated_at`. */
export function setBackupDir(conn: DatabaseSync, dir: string | null, nowIso: string): void {
  conn.prepare(
    `INSERT INTO backup_settings (id, external_dir, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET external_dir = excluded.external_dir, updated_at = excluded.updated_at`,
  ).run(dir, nowIso);
}

/** Appends one log row. */
export function insertExternalLog(
  conn: DatabaseSync,
  row: {
    sourceName: string | null; targetName: string | null; status: LogStatus;
    sizeBytes?: number | null; sha256?: string | null; error?: string | null; createdAt: string;
  },
): void {
  conn.prepare(
    `INSERT INTO external_backup_log (source_name, target_name, status, size_bytes, sha256, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.sourceName, row.targetName, row.status, row.sizeBytes ?? null, row.sha256 ?? null, row.error ?? null, row.createdAt);
}

/** The newest attempt of any kind, or undefined when nothing was ever attempted. */
export function newestExternalLog(conn: DatabaseSync): ExternalLogRow | undefined {
  const r = conn.prepare('SELECT * FROM external_backup_log ORDER BY id DESC LIMIT 1').get() as unknown as RawLog | undefined;
  return r ? mapLog(r) : undefined;
}

/** Time of the newest successful copy, or null. */
export function lastExternalSuccessAt(conn: DatabaseSync): string | null {
  const r = conn.prepare("SELECT MAX(created_at) AS t FROM external_backup_log WHERE status = 'ok'").get() as { t: string | null };
  return r.t;
}

/** Time of the newest attempt (any status), or null. */
export function lastExternalAttemptAt(conn: DatabaseSync): string | null {
  const r = conn.prepare('SELECT MAX(created_at) AS t FROM external_backup_log').get() as { t: string | null };
  return r.t;
}
