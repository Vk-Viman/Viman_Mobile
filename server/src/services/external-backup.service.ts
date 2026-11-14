/**
 * services/external-backup.service.ts - copies local backups to an external folder (a USB drive) safely.
 *
 * Layer: service. BUSINESS_RULES section 12 "External backups". The one promise of this file: whatever goes wrong
 * with the external drive (missing, read-only, full, unplugged mid-copy, damaged copy) is caught, logged in
 * `external_backup_log` and shown as a warning - it NEVER throws into start-up, backups, sales or any request.
 *
 * Copy algorithm for one backup file:
 *   1. read the local backup, compute SHA-256;
 *   2. if an identical file (same size AND checksum) already exists under that name or a "-n" variant -> skipped;
 *   3. choose a final name that does not exist (a different file under the same name gets a new unique name, it is
 *      never replaced);
 *   4. write a temporary file (".viman-copy-*.tmp") in the folder, flush it, re-read it and verify size AND SHA-256;
 *   5. rename it to the final name (checked once more that the name is still free).
 * Afterwards only files named like our own backups are pruned, keeping the newest 30.
 * Runs are serialised per server, so the timer, a manual click and a post-backup copy never overlap.
 *
 * What a run records (migration 021, hardening M5 / M6):
 *   - `external_backup_state` (mutable, one row for the current folder) is updated by EVERY run: attempt time, failure counters,
 *     and - when the folder was available and every start-up/manual backup is present and verified - `last_sync_at`, even if
 *     nothing new was written ("synchronized"). The status is derived from it.
 *   - `external_backup_log` (append-only) gets a row only for a change: a file really copied, the first recovery after failures,
 *     and a failure at most once per (error text, source file) per 24 hours. Repeated identical failures only bump the counters.
 * Names are compared case-insensitively (Windows): a file present under another letter case is the same file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import {
  failureLoggedSince, getBackupSettings, getExternalState, insertExternalLog, recordExternalRun, resetExternalState, setBackupDir,
} from '../repositories/external-backup.repo.ts';
import { listBackups } from './backup.service.ts';
import type { BackupInfo } from './backup.service.ts';
import { logAudit } from './audit.service.ts';
import { externalHooks, externalNow } from './external-backup-hooks.ts';
import { computeExternalStatus } from './external-backup-status.ts';
import type { ExternalStatusCore, ExternalStatusName } from './external-backup-status.ts';
import { SAME_DISK_WARNING, isFolder, plainFsError, probeWritable, sameVolume, validateExternalFolder, writeNewFile } from './external-backup-validate.ts';

/** How many external backups are kept. */
export const KEEP_EXTERNAL = 30;
/** The only file names ever pruned in the external folder: our own start-up / manual backups. */
export const EXTERNAL_NAME_RE = /^viman-\d{8}-\d{6}-(startup|manual)(-\d+)?\.db$/;
/** Temporary copies we create; stale ones (older than an hour) are removed. */
const TEMP_RE = /^\.viman-copy-[0-9a-f]+\.tmp$/;
const STALE_TEMP_MS = 3_600_000;
/** The same failure (error text + source file) is appended to the log at most once per this long; further ones only count. */
const FAILURE_LOG_GAP_MS = 24 * 3_600_000;
/** How long the Settings screen waits for the folder write probe. */
export const PROBE_TIMEOUT_MS = 3000;
/** The timer period. */
export const EXTERNAL_TIMER_MS = 10 * 60 * 1000;

/** One external copy as listed. */
export interface ExternalCopyInfo { name: string; sizeBytes: number; createdAt: string }
/** GET /backups/external. */
export interface ExternalStatusResponse extends ExternalStatusCore {
  writable: boolean | null;
  /** Warning (not an error) when the folder is on the same disk as the shop data, else null. */
  diskWarning: string | null;
  copies: ExternalCopyInfo[];
}
/** POST /backups/external/copy. */
export interface ExternalCopyResult {
  copied: Array<{ name: string; sizeBytes: number; sha256: string }>;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
  pruned: string[];
  status: ExternalStatusName;
  warning: string | null;
}
/** Why a copy run was started. */
export type CopyTrigger = 'manual' | 'auto' | 'timer';

const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const nowIso = (): string => externalNow().toISOString();

/** `viman-STAMP-reason` without suffix and extension: files with the same base are "the same backup". */
function baseOf(name: string): string {
  return name.replace(/(-\d+)?\.db$/, '');
}
/** Sort key: stamp, then the "-n" number (none = 1). */
function orderKey(name: string): [string, number] {
  const m = /-(\d+)\.db$/.exec(name);
  return [name.slice(6, 21), m ? Number(m[1]) : 1];
}
/** Newest first. */
function byNewest(a: string, b: string): number {
  const [sa, na] = orderKey(a);
  const [sb, nb] = orderKey(b);
  return sb.localeCompare(sa) || nb - na || b.localeCompare(a);
}

/** Names in the folder that are ours (matching the backup pattern), newest first. Never throws. */
function ourNames(folder: string): string[] {
  try {
    return readdirSync(folder).filter((n) => EXTERNAL_NAME_RE.test(n)).sort(byNewest);
  } catch {
    return [];
  }
}

/** Lists the external copies, newest first, at most 30. Empty when the folder is unreadable. */
export function listExternalCopies(folder: string | null): ExternalCopyInfo[] {
  if (folder === null) return [];
  const out: ExternalCopyInfo[] = [];
  for (const name of ourNames(folder).slice(0, KEEP_EXTERNAL)) {
    try {
      const st = statSync(join(folder, name));
      if (st.isFile()) out.push({ name, sizeBytes: st.size, createdAt: st.mtime.toISOString() });
    } catch { /* vanished: skip */ }
  }
  return out;
}

/** The status plus the live details shown in Settings (a real write probe and the list of copies). */
export async function getExternalStatus(ctx: AppContext, probe = true): Promise<ExternalStatusResponse> {
  const core = computeExternalStatus(ctx.database.conn, externalNow());
  let writable: boolean | null = null;
  if (core.configured && core.folderAvailable && probe) {
    // A drive that hangs must not hang the Settings screen: give the probe a few seconds, then report "unknown".
    const verdict = await Promise.race([
      probeWritable(core.folder as string), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), PROBE_TIMEOUT_MS).unref()),
    ]);
    writable = verdict === 'timeout' ? null : verdict === null;
  }
  const diskWarning = core.folder !== null && core.folderAvailable && sameVolume(core.folder, ctx.dataDir) ? SAME_DISK_WARNING : null;
  return { ...core, writable, diskWarning, copies: core.folderAvailable ? listExternalCopies(core.folder) : [] };
}

/**
 * Saves (or clears with null) the external folder. Audited (entity `backup_settings`).
 * @throws AppError 400 EXTERNAL_FOLDER_INVALID / EXTERNAL_FOLDER_CLOUD.
 */
export async function setExternalFolder(ctx: AppContext, folder: string | null): Promise<ExternalStatusResponse> {
  const next = folder === null ? null : await validateExternalFolder(folder, ctx.dataDir);
  let changed = false;
  ctx.database.tx((conn) => {
    const before = getBackupSettings(conn).externalDir;
    if (before === next) return;
    changed = true;
    setBackupDir(conn, next, nowIso());
    // The status belongs to the folder: a new folder starts from scratch (the old folder's success must not count for it).
    resetExternalState(conn, next, nowIso());
    logAudit(conn, 'backup_settings', '1', 'update', { folder: before }, { folder: next });
  });
  // A newly set folder is synchronized at once, in the background (never awaited: the answer does not depend on the drive).
  if (changed && next !== null) void runExternalCopyOnce(ctx, 'auto');
  return getExternalStatus(ctx, false);
}

function logRow(ctx: AppContext, row: Parameters<typeof insertExternalLog>[1]): void {
  try { insertExternalLog(ctx.database.conn, row); } catch { /* the database may be closing; a log row is not worth failing for */ }
}

/** One failure of a run: which backup (null = the folder itself), a short kind and the plain-language text. */
interface RunFailure { source: string | null; code: string; message: string }

/** The kind of a failed copy, from the Node error code (or our own checks). */
function kindOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const msg = err instanceof Error ? err.message : '';
  if (/checksum/i.test(msg)) return 'CHECKSUM';
  if (/wrong size/i.test(msg)) return 'SIZE';
  if (/appeared while copying/i.test(msg)) return 'NAME_RACE';
  return 'OTHER';
}

/** Source backups eligible for copying: start-up and manual only (never pre-restore safety copies), newest first. */
function eligibleSources(ctx: AppContext): BackupInfo[] {
  return listBackups(ctx).filter((b) => b.reason !== 'pre-restore').slice(0, KEEP_EXTERNAL);
}

/** Removes leftover temporary copies of ours older than an hour. */
async function removeStaleTemps(folder: string): Promise<void> {
  let names: string[];
  try { names = await readdir(folder); } catch { return; }
  for (const n of names) {
    if (!TEMP_RE.test(n)) continue;
    try {
      const st = await stat(join(folder, n));
      if (externalNow().getTime() - st.mtimeMs > STALE_TEMP_MS) await rm(join(folder, n), { force: true });
    } catch { /* ignore */ }
  }
}

/** Next unused name for a backup base: `base-2.db`, `base-3.db` ... (`taken` holds lower-case names). */
function uniqueName(base: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}.db`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Writes `data` into the folder under `finalName` through a verified temporary file.
 * @throws Error with a plain-English message on any failure (the temp file is removed).
 */
async function writeVerified(folder: string, finalName: string, data: Buffer, sha: string): Promise<void> {
  const tmp = join(folder, `.viman-copy-${randomBytes(6).toString('hex')}.tmp`);
  const final = join(folder, finalName);
  try {
    await writeNewFile(tmp, data);
    if (externalHooks.afterWrite) await externalHooks.afterWrite(tmp);
    const back = await readFile(tmp);
    if (back.length !== data.length) {
      throw new Error(`The copy has the wrong size (${back.length} instead of ${data.length} bytes) and was discarded.`);
    }
    if (sha256Of(back) !== sha) {
      throw new Error('The copy did not match the original (checksum mismatch) and was discarded.');
    }
    if (externalHooks.beforeRename) await externalHooks.beforeRename(tmp, final);
    if (existsSync(final)) throw new Error('A file with that name appeared while copying; nothing was overwritten.');
    await rename(tmp, final);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    const plain = err instanceof Error && !(err as { code?: string }).code ? err.message : plainFsError(err);
    throw Object.assign(new Error(plain, { cause: err }), { kind: kindOf(err) });
  }
}

/** Our own backup names in the folder in ANY letter case (Windows treats names case-insensitively), newest first. */
function ourNamesAnyCase(folder: string): string[] {
  try {
    const re = new RegExp(EXTERNAL_NAME_RE.source, 'i');
    return readdirSync(folder).filter((n) => re.test(n)).sort(byNewest);
  } catch {
    return [];
  }
}

/** Every file name in the folder, lower-cased (a name is "taken" whatever its letter case). */
function takenNames(folder: string): Set<string> {
  try { return new Set(readdirSync(folder).map((n) => n.toLowerCase())); } catch { return new Set(); }
}

/**
 * Records one finished run: the state row of the folder and, only for changes, rows in the append-only log
 * (a failure once per error text and source file per 24 hours; the first success after failures). Never throws.
 */
function recordRun(ctx: AppContext, folder: string, runAt: string, failures: RunFailure[], result: ExternalCopyResult): void {
  try {
    ctx.database.tx((conn) => {
      // The folder was switched while this run was going on: its result belongs to nobody any more.
      if ((getBackupSettings(conn).externalDir ?? '').toLowerCase() !== folder.toLowerCase()) return;
      const since = new Date(new Date(runAt).getTime() - FAILURE_LOG_GAP_MS).toISOString();
      let failureLogged = false;
      for (const f of failures) {
        if (failureLoggedSince(conn, f.source, f.message, since)) continue;
        insertExternalLog(conn, { sourceName: f.source, targetName: null, status: 'failed', error: f.message, createdAt: runAt });
        failureLogged = true;
      }
      const wasFailing = (getExternalState(conn, folder)?.consecutiveFailures ?? 0) > 0;
      const synced = failures.length === 0;
      if (synced && wasFailing && result.copied.length === 0 && result.skipped.length > 0) {
        // Recovery with nothing new to copy: one row says the drive is fine again (copied files wrote their own rows).
        insertExternalLog(conn, { sourceName: null, targetName: result.skipped[0]!.name, status: 'skipped', createdAt: runAt });
      }
      recordExternalRun(conn, folder, {
        at: runAt, synced, copied: result.copied.length > 0,
        failure: failures[0] ? { code: failures[0].code, message: failures[0].message } : null, failureLogged,
      });
    });
  } catch { /* the database may be closing; the state is recomputed by the next run */ }
}

/** One copy run. Never throws. `_trigger` is only informational: every kind of run is recorded the same way. */
async function performCopy(ctx: AppContext, _trigger: CopyTrigger): Promise<ExternalCopyResult> {
  const runAt = nowIso();
  const result: ExternalCopyResult = { copied: [], skipped: [], failed: [], pruned: [], status: 'ok', warning: null };
  const failures: RunFailure[] = [];
  const fail = (source: string | null, code: string, message: string): void => {
    failures.push({ source, code, message });
    result.failed.push({ name: source ?? '(external folder)', error: message });
  };
  const finish = (): ExternalCopyResult => {
    try {
      const s = computeExternalStatus(ctx.database.conn, externalNow());
      result.status = s.status;
      result.warning = s.warning;
    } catch { /* database closed */ }
    return result;
  };
  let folder: string | null = null;
  try {
    if (ctx.isRestoring) return finish();
    folder = getBackupSettings(ctx.database.conn).externalDir;
    if (folder === null) return finish();

    if (!isFolder(folder)) {
      fail(null, 'DRIVE_MISSING', 'The external backup folder cannot be found (the drive may be unplugged).');
    } else {
      await removeStaleTemps(folder);
      const taken = takenNames(folder); // lower-case names of every file in the folder
      const present = ourNamesAnyCase(folder); // our own backups, any letter case
      for (const src of eligibleSources(ctx)) {
        let data: Buffer;
        try {
          data = await readFile(join(ctx.backupsDir, src.name));
        } catch {
          continue; // the local file was rotated away meanwhile: nothing to copy
        }
        const sha = sha256Of(data);
        try {
          // Identical copy already there (same base name in any letter case, same size and checksum)?
          const base = baseOf(src.name).toLowerCase();
          let identical: string | null = null;
          for (const name of present) {
            if (baseOf(name).toLowerCase() !== base) continue;
            const st = await stat(join(folder, name)).catch(() => null);
            if (!st || st.size !== data.length) continue;
            if (sha256Of(await readFile(join(folder, name))) === sha) { identical = name; break; }
          }
          if (identical !== null) {
            result.skipped.push({ name: src.name, reason: 'already_present' });
            continue;
          }
          const finalName = taken.has(src.name.toLowerCase()) ? uniqueName(baseOf(src.name), taken) : src.name;
          // Would the retention rule remove it straight away? Then do not copy it (it would be copied again forever).
          const ranked = [...present.filter((n) => EXTERNAL_NAME_RE.test(n)), finalName].sort(byNewest);
          if (ranked.indexOf(finalName) >= KEEP_EXTERNAL) {
            result.skipped.push({ name: src.name, reason: 'older_than_retention' });
            continue;
          }
          await writeVerified(folder, finalName, data, sha);
          taken.add(finalName.toLowerCase());
          present.push(finalName);
          result.copied.push({ name: finalName, sizeBytes: data.length, sha256: sha });
          logRow(ctx, { sourceName: src.name, targetName: finalName, status: 'ok', sizeBytes: data.length, sha256: sha, createdAt: runAt });
        } catch (err) {
          const kind = (err as { kind?: string }).kind ?? kindOf(err);
          fail(src.name, kind, err instanceof Error ? err.message : String(err));
          // A full, read-only or removed drive will fail every remaining file the same way: stop here when it vanished.
          if (!isFolder(folder)) break;
        }
      }

      // Retention: only our own backup names (exact pattern), only beyond the newest 30.
      for (const name of ourNames(folder).slice(KEEP_EXTERNAL)) {
        try {
          await rm(join(folder, name), { force: true });
          result.pruned.push(name);
        } catch { /* retried at the next run */ }
      }
    }
  } catch (err) {
    fail(null, kindOf(err), plainFsError(err));
  }
  if (folder !== null) recordRun(ctx, folder, runAt, failures, result);
  return finish();
}

// One chain of runs per server context, so two copies never run at once.
const chains = new WeakMap<AppContext, Promise<unknown>>();

/**
 * Runs one copy pass (queued behind any pass already running). NEVER rejects: every problem ends up in the result
 * and in the log. This is what the automatic triggers and the "Copy backup now" button call.
 */
export function runExternalCopyOnce(ctx: AppContext, trigger: CopyTrigger = 'timer'): Promise<ExternalCopyResult> {
  const prev = chains.get(ctx) ?? Promise.resolve();
  const next = prev.then(() => performCopy(ctx, trigger), () => performCopy(ctx, trigger));
  chains.set(ctx, next.catch(() => undefined));
  return next;
}

/** Waits until every queued copy pass of this server has finished (used by tests and by shutdown). */
export async function externalCopyIdle(ctx: AppContext): Promise<void> {
  await (chains.get(ctx) ?? Promise.resolve());
}

/**
 * Fire-and-forget copy after a start-up or manual backup. Returns immediately; the copy happens in the background.
 */
export function scheduleExternalCopy(ctx: AppContext): void {
  void runExternalCopyOnce(ctx, 'auto');
}

/**
 * The owner pressed "Copy backup now".
 * @throws AppError 409 EXTERNAL_FOLDER_NOT_SET when no folder is configured (the only error: drive problems are
 *   reported inside the result, with a normal 200).
 */
export async function copyExternalNow(ctx: AppContext): Promise<ExternalCopyResult> {
  if (getBackupSettings(ctx.database.conn).externalDir === null) {
    throw new AppError(409, 'EXTERNAL_FOLDER_NOT_SET', 'Please choose an external backup folder first.');
  }
  return runExternalCopyOnce(ctx, 'manual');
}

/**
 * Starts the low-frequency timer that copies when the folder becomes available (e.g. the USB drive is plugged in).
 * The timer is unref'd (it never keeps the program alive) and returns its stop function.
 */
export function startExternalCopyTimer(ctx: AppContext, everyMs: number = EXTERNAL_TIMER_MS): () => void {
  const t = setInterval(() => { void runExternalCopyOnce(ctx, 'timer'); }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
