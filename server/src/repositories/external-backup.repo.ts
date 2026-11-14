/**
 * repositories/external-backup.repo.ts - SQL for `backup_settings`, `external_backup_log` (migration 018) and the mutable
 * `external_backup_state` (migration 021).
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

// ---------------------------------------------------------------------------------------------
// external_backup_state (migration 021): one mutable row per external folder.
// ---------------------------------------------------------------------------------------------

/** The running facts about one external folder. */
export interface ExternalState {
  folder: string;
  firstSeenAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  consecutiveFailures: number;
  totalFailures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  firstFailureAt: string | null;
  lastFailureLoggedAt: string | null;
}

interface RawState {
  folder: string; first_seen_at: string; last_attempt_at: string | null; last_success_at: string | null; last_sync_at: string | null;
  consecutive_failures: number | bigint; total_failures: number | bigint; last_error_code: string | null; last_error_message: string | null;
  first_failure_at: string | null; last_failure_logged_at: string | null;
}

/** The state of `folder`, or undefined when nothing was recorded for it yet (case-insensitive). */
export function getExternalState(conn: DatabaseSync, folder: string): ExternalState | undefined {
  const r = conn.prepare('SELECT * FROM external_backup_state WHERE folder = ?').get(folder) as unknown as RawState | undefined;
  if (!r) return undefined;
  return {
    folder: r.folder, firstSeenAt: r.first_seen_at, lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at,
    lastSyncAt: r.last_sync_at, consecutiveFailures: Number(r.consecutive_failures), totalFailures: Number(r.total_failures),
    lastErrorCode: r.last_error_code, lastErrorMessage: r.last_error_message, firstFailureAt: r.first_failure_at,
    lastFailureLoggedAt: r.last_failure_logged_at,
  };
}

/** Starts a clean state for a newly chosen folder and forgets the states of every other folder. */
export function resetExternalState(conn: DatabaseSync, folder: string | null, nowIso: string): void {
  conn.prepare('DELETE FROM external_backup_state').run();
  if (folder !== null) conn.prepare('INSERT INTO external_backup_state (folder, first_seen_at, updated_at) VALUES (?, ?, ?)').run(folder, nowIso, nowIso);
}

/** What one run found. */
export interface RunFacts {
  at: string;
  /** Every backup was present and verified and nothing failed. */
  synced: boolean;
  /** At least one file was copied and verified in this run. */
  copied: boolean;
  /** The failure that represents this run (the first one), when the run failed. */
  failure: { code: string; message: string } | null;
  /** Whether a failed row was appended to the log in this run. */
  failureLogged: boolean;
}

/** Applies one run to the state of `folder` (creating the row when missing). */
export function recordExternalRun(conn: DatabaseSync, folder: string, f: RunFacts): void {
  conn.prepare('INSERT OR IGNORE INTO external_backup_state (folder, first_seen_at, updated_at) VALUES (?, ?, ?)').run(folder, f.at, f.at);
  if (f.failure) {
    conn.prepare(
      `UPDATE external_backup_state SET
         last_attempt_at = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
         first_failure_at = CASE WHEN consecutive_failures = 0 THEN ? ELSE first_failure_at END,
         consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1,
         last_error_code = ?, last_error_message = ?,
         last_failure_logged_at = CASE WHEN ? THEN ? ELSE last_failure_logged_at END, updated_at = ?
       WHERE folder = ?`,
    ).run(f.at, f.copied ? 1 : 0, f.at, f.at, f.failure.code, f.failure.message, f.failureLogged ? 1 : 0, f.at, f.at, folder);
    return;
  }
  conn.prepare(
    `UPDATE external_backup_state SET
       last_attempt_at = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
       last_sync_at = CASE WHEN ? THEN ? ELSE last_sync_at END,
       consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures END,
       first_failure_at = CASE WHEN ? THEN NULL ELSE first_failure_at END, updated_at = ?
     WHERE folder = ?`,
  ).run(f.at, f.copied ? 1 : 0, f.at, f.synced ? 1 : 0, f.at, f.synced ? 1 : 0, f.synced ? 1 : 0, f.at, folder);
}

/** True when a failed row for this exact source and error text was logged at or after `sinceIso`. */
export function failureLoggedSince(conn: DatabaseSync, source: string | null, error: string, sinceIso: string): boolean {
  const r = conn.prepare(
    "SELECT 1 AS x FROM external_backup_log WHERE status = 'failed' AND source_name IS ? AND error = ? AND created_at >= ? LIMIT 1",
  ).get(source, error, sinceIso);
  return r !== undefined;
}
