/**
 * services/external-backup-status.ts - "is the external backup healthy?", derived from the settings row, the copy
 * log and a live look at the folder. Nothing is stored: the status is recomputed on every call.
 *
 * Statuses (BUSINESS_RULES section 12, API_CONTRACTS part C):
 *   not_configured  no external folder is set (informational)
 *   stale           configured, but no successful copy for 7 days or more (a folder that never had a successful copy
 *                   counts from the day the folder was set). Stale wins over drive_missing / failed because it is
 *                   the owner's real risk; the warning text still says why.
 *   drive_missing   configured, but the folder cannot be found (the USB drive is not plugged in)
 *   failed          the newest attempt failed (full drive, read-only, damaged copy ...) and nothing succeeded since
 *   ok              everything fine
 */
import type { DatabaseSync } from 'node:sqlite';
import { getBackupSettings, lastExternalAttemptAt, lastExternalSuccessAt, newestExternalLog } from '../repositories/external-backup.repo.ts';
import { isFolder } from './external-backup-validate.ts';

export type ExternalStatusName = 'ok' | 'not_configured' | 'drive_missing' | 'failed' | 'stale';

/** Days without a successful copy at which the status becomes `stale`. */
export const EXTERNAL_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

/** What the dashboard shows. */
export interface ExternalSummary {
  status: ExternalStatusName;
  lastSuccessAt: string | null;
  daysSinceSuccess: number | null;
  warning: string | null;
}

/** The status fields shared by GET /backups/external and the dashboard. */
export interface ExternalStatusCore extends ExternalSummary {
  configured: boolean;
  folder: string | null;
  folderAvailable: boolean;
  lastAttemptAt: string | null;
  lastError: string | null;
}

/** Warning text per status (plain English, no jargon). */
function warningFor(
  status: ExternalStatusName, folder: string | null, days: number | null, lastError: string | null,
  sinceSetDays: number, neverSucceeded: boolean,
): string | null {
  switch (status) {
    case 'ok': return null;
    case 'not_configured':
      return 'No external backup folder is set, so backups exist only on this computer. Choose a USB drive or another local drive in Settings > Backups.';
    case 'drive_missing':
      return `The external backup drive or folder (${folder}) cannot be found. Plug the drive in; backups are then copied automatically. Shop work is not affected.`;
    case 'failed':
      return `The last copy to the external backup folder failed: ${lastError ?? 'unknown problem'}. Your local backups are safe and shop work is not affected.`;
    case 'stale': {
      const how = neverSucceeded
        ? `No backup has been copied to the external folder since it was set up ${sinceSetDays} day${sinceSetDays === 1 ? '' : 's'} ago`
        : `No backup has been copied to the external folder for ${days} day${days === 1 ? '' : 's'}`;
      return `${how}. Check that the drive is connected, then use "Copy backup now" in Settings > Backups. Shop work is not affected.`;
    }
  }
}

/**
 * Computes the status.
 * @param now The clock (tests inject one).
 */
export function computeExternalStatus(conn: DatabaseSync, now: Date): ExternalStatusCore {
  const { externalDir, updatedAt } = getBackupSettings(conn);
  const lastSuccessAt = lastExternalSuccessAt(conn);
  const lastAttemptAt = lastExternalAttemptAt(conn);
  const newest = newestExternalLog(conn);
  const lastError = newest && newest.status === 'failed' ? newest.error : null;
  if (externalDir === null) {
    return {
      configured: false, folder: null, folderAvailable: false, status: 'not_configured', lastSuccessAt, lastAttemptAt,
      lastError: null, daysSinceSuccess: null, warning: warningFor('not_configured', null, null, null, 0, true),
    };
  }
  const folderAvailable = isFolder(externalDir);
  // A success logged BEFORE the folder was (re)set belongs to an earlier folder, but "never copied" is judged on the
  // log as a whole: the clock starts at the later of the last success and nothing, falling back to the setting time.
  const refMs = new Date(lastSuccessAt ?? updatedAt).getTime();
  const elapsedDays = (now.getTime() - refMs) / DAY_MS;
  const daysSinceSuccess = lastSuccessAt === null ? null : Math.max(0, Math.floor(elapsedDays));
  let status: ExternalStatusName;
  if (elapsedDays >= EXTERNAL_STALE_DAYS) status = 'stale';
  else if (!folderAvailable) status = 'drive_missing';
  else if (newest && newest.status === 'failed') status = 'failed';
  else status = 'ok';
  const warning = warningFor(
    status, externalDir, daysSinceSuccess, lastError, Math.max(0, Math.floor(elapsedDays)), lastSuccessAt === null,
  );
  // A stale status caused by an unplugged drive or a failing copy also names the cause.
  const cause = status !== 'stale' || warning === null ? '' : !folderAvailable
    ? ' (The drive or folder cannot be found right now.)'
    : lastError ? ` (The last attempt failed: ${lastError})` : '';
  return {
    configured: true, folder: externalDir, folderAvailable, status, lastSuccessAt, lastAttemptAt, lastError,
    daysSinceSuccess, warning: warning === null ? null : warning + cause,
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
