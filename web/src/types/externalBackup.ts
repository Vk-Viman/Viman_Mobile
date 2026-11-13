/**
 * Types of the external backup API (GET/PUT /backups/external, POST /backups/external/copy) and of the
 * dashboard's `backup.external` block. Mirrors API_CONTRACTS "Approved-decisions contract" part C.
 */

/** ok = healthy; not_configured = no folder set; drive_missing = folder not found (USB not plugged in);
 *  failed = the last copy failed; stale = no successful copy for 7 days or more. */
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
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  daysSinceSuccess: number | null;
  status: ExternalBackupStatusName;
  warning: string | null;
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

/** Badge text and colour per status (green = fine, amber = needs a look, red = backups are not getting out). */
export const EXTERNAL_STATUS_LABEL: Record<ExternalBackupStatusName, { text: string; tone: 'brand' | 'amber' | 'red' }> = {
  ok: { text: 'Working', tone: 'brand' },
  not_configured: { text: 'Not set up', tone: 'amber' },
  drive_missing: { text: 'Drive not found', tone: 'amber' },
  failed: { text: 'Last copy failed', tone: 'red' },
  stale: { text: 'No recent copy', tone: 'red' },
};
