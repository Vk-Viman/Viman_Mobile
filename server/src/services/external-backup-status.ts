/**
 * services/external-backup-status.ts - "is the external backup healthy?", derived from the per-folder state row
 * (`external_backup_state`, migration 021), the settings row and a live look at the folder.
 *
 * Statuses (BUSINESS_RULES section 12, API_CONTRACTS hardening contract M5):
 *   not_configured  no external folder is set (informational)
 *   stale           configured, but no CONFIRMED SYNCHRONIZATION for 7 days or more (a folder that never synchronized counts
 *                   from the day it was set). A synchronization is a run that found the folder available and every
 *                   start-up/manual backup present and verified, even when nothing new had to be written. Stale wins over
 *                   drive_missing / failed because it is the owner's real risk; the warning text still says why.
 *   drive_missing   configured, but the folder cannot be found (the USB drive is not plugged in)
 *   failed          the latest run failed to copy (full drive, read-only, damaged copy ...) and nothing succeeded since
 *   ok              synchronized: no warning
 * The state belongs to ONE folder: choosing another folder starts from scratch.
 */
import type { DatabaseSync } from 'node:sqlite';
import { getBackupSettings, getExternalState } from '../repositories/external-backup.repo.ts';
import type { ExternalState } from '../repositories/external-backup.repo.ts';
import { isFolder } from './external-backup-validate.ts';

export type ExternalStatusName = 'ok' | 'not_configured' | 'drive_missing' | 'failed' | 'stale';

/** Days without a confirmed synchronization at which the status becomes `stale`. */
export const EXTERNAL_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

/** What the dashboard shows. */
export interface ExternalSummary {
  status: ExternalStatusName;
  /** The newest confirmed synchronization (the drive was fine and every backup was on it), not only the newest file written. */
  lastSuccessAt: string | null;
  /** Whole days since `lastSuccessAt`. */
  daysSinceSuccess: number | null;
  warning: string | null;
}

/** The status fields shared by GET /backups/external and the dashboard. */
export interface ExternalStatusCore extends ExternalSummary {
  configured: boolean;
  folder: string | null;
  folderAvailable: boolean;
  lastAttemptAt: string | null;
  /** The newest failure message while the latest run is failing, else null. */
  lastError: string | null;
  /** Newest run in which a file was really copied. */
  lastCopyAt: string | null;
  /** Runs in a row that failed (0 when the latest run succeeded) and the first failure of that series. */
  consecutiveFailures: number;
  firstFailureAt: string | null;
}

/** Warning text per status (plain English, no jargon). */
function warningFor(
  status: ExternalStatusName, folder: string | null, days: number, lastError: string | null, neverSynced: boolean,
): string | null {
  switch (status) {
    case 'ok': return null;
    case 'not_configured':
      return 'No external backup folder is set, so backups exist only on this computer. Choose a USB drive or another local drive in Settings > Backups.';
    case 'drive_missing':
      return `Drive not found: the external backup drive or folder (${folder}) cannot be found. Plug the drive in; backups are then copied automatically. Shop work is not affected.`;
    case 'failed':
      return `The last copy to the external backup folder failed: ${lastError ?? 'unknown problem'}. Your local backups are safe and shop work is not affected.`;
    case 'stale': {
      const how = neverSynced
        ? `Overdue: the external folder was set up ${days} day${days === 1 ? '' : 's'} ago and no synchronization has been confirmed yet`
        : `Overdue: no confirmed synchronization with the external folder for ${days} day${days === 1 ? '' : 's'}`;
      return `${how}. Check that the drive is connected, then use "Copy backup now" in Settings > Backups. Shop work is not affected.`;
    }
  }
}

/**
 * Computes the status of the CURRENT folder.
 * @param now The clock (tests inject one).
 */
export function computeExternalStatus(conn: DatabaseSync, now: Date): ExternalStatusCore {
  const { externalDir, updatedAt } = getBackupSettings(conn);
  if (externalDir === null) {
    return {
      configured: false, folder: null, folderAvailable: false, status: 'not_configured', lastSuccessAt: null, lastAttemptAt: null,
      lastError: null, daysSinceSuccess: null, warning: warningFor('not_configured', null, 0, null, true),
      lastCopyAt: null, consecutiveFailures: 0, firstFailureAt: null,
    };
  }
  const state: ExternalState | undefined = getExternalState(conn, externalDir);
  const folderAvailable = isFolder(externalDir);
  const lastSyncAt = state?.lastSyncAt ?? null;
  const failing = (state?.consecutiveFailures ?? 0) > 0
    // A failure "drive not found" is history once the drive is back: the next pass synchronizes.
    && !(folderAvailable && state?.lastErrorCode === 'DRIVE_MISSING');
  const lastError = failing ? (state?.lastErrorMessage ?? 'unknown problem') : null;
  const refMs = new Date(lastSyncAt ?? state?.firstSeenAt ?? updatedAt).getTime();
  const elapsedDays = Math.max(0, (now.getTime() - refMs) / DAY_MS);
  const wholeDays = Math.floor(elapsedDays);
  let status: ExternalStatusName;
  if (elapsedDays >= EXTERNAL_STALE_DAYS) status = 'stale';
  else if (!folderAvailable) status = 'drive_missing';
  else if (failing) status = 'failed';
  else status = 'ok';
  const warning = warningFor(status, externalDir, wholeDays, lastError, lastSyncAt === null);
  // A stale status caused by an unplugged drive or a failing copy also names the cause.
  const cause = status !== 'stale' || warning === null ? '' : !folderAvailable
    ? ' (The drive or folder cannot be found right now.)'
    : lastError ? ` (The last attempt failed: ${lastError})` : '';
  return {
    configured: true, folder: externalDir, folderAvailable, status, lastSuccessAt: lastSyncAt, lastAttemptAt: state?.lastAttemptAt ?? null,
    lastError, daysSinceSuccess: lastSyncAt === null ? null : wholeDays, warning: warning === null ? null : warning + cause,
    lastCopyAt: state?.lastSuccessAt ?? null, consecutiveFailures: failing ? state?.consecutiveFailures ?? 0 : 0,
    firstFailureAt: failing ? state?.firstFailureAt ?? null : null,
  };
}

/** The dashboard block `backup.external`. */
export function externalSummary(conn: DatabaseSync, now: Date): ExternalSummary {
  const s = computeExternalStatus(conn, now);
  return { status: s.status, lastSuccessAt: s.lastSuccessAt, daysSinceSuccess: s.daysSinceSuccess, warning: s.warning };
}

/** A dashboard warning for statuses that need attention, or null (not_configured is only a note on the card). */
export function externalDashboardWarning(s: ExternalSummary): { code: string; message: string } | null {
  if (s.status === 'stale' || s.status === 'drive_missing' || s.status === 'failed') {
    return { code: `EXTERNAL_BACKUP_${s.status.toUpperCase()}`, message: s.warning ?? 'The external backup needs attention.' };
  }
  return null;
}
