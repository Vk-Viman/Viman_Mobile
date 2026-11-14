/**
 * Types of the external backup API (GET/PUT /backups/external, POST /backups/external/copy) and of the
 * dashboard's `backup.external` block. Mirrors API_CONTRACTS "Approved-decisions contract" part C.
 */

/** ok = synchronized (the drive is fine and every backup is on it, even if nothing new had to be copied);
 *  not_configured = no folder set; drive_missing = folder not found (USB not plugged in);
 *  failed = the last copy failed; stale = no confirmed synchronization for 7 days or more ("Overdue"). */
export type ExternalBackupStatusName = 'ok' | 'not_configured' | 'drive_missing' | 'failed' | 'stale';

/** One backup file found in the external folder. */
export interface ExternalCopy { name: string; sizeBytes: number; createdAt: string }

/** GET /backups/external (also the answer of PUT). */
export interface ExternalBackupStatus {
  configured: boolean;
  folder: string | null;
  folderAvailable: boolean;
  /** Result of a real write test; null when unknown (no folder, drive missing, not tested). */
  writable: boolean | null;
  /** Newest confirmed synchronization (also when nothing new was written). */
  lastSuccessAt: string | null;
  /** Newest run in which a file was really copied. */
  lastCopyAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Runs in a row that failed (0 when the latest run succeeded) and when that series began. */
  consecutiveFailures: number;
  firstFailureAt: string | null;
  daysSinceSuccess: number | null;
  status: ExternalBackupStatusName;
  warning: string | null;
  /** Warning (not an error): the folder is on the same disk as the shop data. */
  diskWarning: string | null;
  copies: ExternalCopy[];
}

/** POST /backups/external/copy. */
export interface ExternalCopyResult {
  copied: Array<{ name: string; sizeBytes: number; sha256: string }>;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
  pruned: string[];
  status: ExternalBackupStatusName;
  warning: string | null;
}

/** Dashboard `backup.external`. */
export interface ExternalBackupSummary {
  status: ExternalBackupStatusName;
  lastSuccessAt: string | null;
  daysSinceSuccess: number | null;
  warning: string | null;
}

/**
 * Badge text and colour per status (green = fine, amber = needs a look, red = backups are not getting out).
 * `days` is the number of days without a confirmed synchronization (null = never confirmed); `synced` tells whether a
 * synchronization has been confirmed at all (an "ok" folder that has not finished its first run says so).
 */
export function externalStatusLabel(
  status: ExternalBackupStatusName, days: number | null, synced: boolean,
): { text: string; tone: 'brand' | 'amber' | 'red' } {
  switch (status) {
    case 'ok': return { text: synced ? 'Synchronized' : 'Waiting for first sync', tone: 'brand' };
    case 'not_configured': return { text: 'Not set up', tone: 'amber' };
    case 'drive_missing': return { text: 'Drive not found', tone: 'amber' };
    case 'failed': return { text: 'Last copy failed', tone: 'red' };
    case 'stale': return {
      text: days === null ? 'Overdue (never confirmed)' : `Overdue (no confirmed sync for ${days} day${days === 1 ? '' : 's'})`, tone: 'red',
    };
  }
}
