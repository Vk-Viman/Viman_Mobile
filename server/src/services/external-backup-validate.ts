/**
 * services/external-backup-validate.ts - is this a folder we are willing to copy backups into?
 *
 * Layer: service support. BUSINESS_RULES section 12 "External backups": the folder must be an absolute LOCAL path
 * that exists, is a folder, can really be written to, is not inside the data folder, and is not a cloud-synced or
 * network location (backups are not encrypted). Cloud detection is by folder NAME only (see CLOUD_NAMES): it cannot
 * know about a cloud client installed under an unrelated name or a drive mapped to a cloud service.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../lib/errors.ts';
import { externalHooks } from './external-backup-hooks.ts';

/** Folder-name prefixes (lower case) of cloud-synced folders. A path segment equal to or starting with one is refused. */
export const CLOUD_NAMES = ['onedrive', 'google drive', 'googledrive', 'dropbox', 'icloud', 'box', 'pcloud', 'mega'] as const;

/** Name prefix of the throw-away file used to test that a folder is writable. */
export const PROBE_PREFIX = '.viman-write-test-';

/** The recommended-practice sentence shown wherever a folder is refused or chosen. */
export const CLOUD_EXPLANATION =
  'Backups are not encrypted, so they must not be copied to cloud storage. Please choose a USB drive or another local drive.';

const invalid = (message: string): AppError =>
  new AppError(400, 'EXTERNAL_FOLDER_INVALID', message, { folder: message });
const cloud = (message: string): AppError =>
  new AppError(400, 'EXTERNAL_FOLDER_CLOUD', message, { folder: message });

/** Path segments of a path written with either kind of slash. */
function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '');
}

/** The first path segment that names a cloud-synced folder, or null. */
export function cloudSegment(p: string): string | null {
  for (const seg of segmentsOf(p)) {
    const low = seg.toLowerCase();
    if (CLOUD_NAMES.some((c) => low === c || low.startsWith(c))) return seg;
  }
  return null;
}

/** True when `child` is `parent` itself or lies inside it (case-insensitive on Windows, via path.relative). */
export function isInsideFolder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True for `\\server\share` and `//server/share` style paths (and Windows extended `\\?\` paths). */
const UNC_RE = /^(\\\\|\/\/)/;

/** Absolute local path: a drive letter + slash on Windows, a leading slash elsewhere. */
function isAbsoluteLocal(p: string): boolean {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return isAbsolute(p);
}

/** Plain-English text for a file-system error (never shows the raw Node message to the owner as the only text). */
export function plainFsError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'ENOSPC': return 'The external drive is full.';
    case 'EROFS': return 'The external drive is read-only.';
    case 'EACCES': case 'EPERM': return 'The shop is not allowed to write to the external folder (it may be read-only or protected).';
    case 'ENOENT': case 'ENOTDIR': return 'The external folder could not be found (the drive may have been unplugged).';
    case 'EIO': case 'ENXIO': case 'ENODEV': return 'The external drive could not be read or written (it may have been unplugged or is failing).';
    case 'EBUSY': return 'The external drive or file is busy.';
    case 'EEXIST': return 'The shop cannot create files in that folder. It may be a shortcut (junction) or a mount point; please choose the real folder on the drive instead.';
    case 'EISDIR': return 'A folder is in the way where a backup file should be written.';
    default: return err instanceof Error ? err.message : String(err);
  }
}

/** Writes `data` to a NEW file (fails if it exists), flushes it to disk and closes it. Uses the test hook when set. */
export async function writeNewFile(path: string, data: Buffer): Promise<void> {
  if (externalHooks.writeTemp) { await externalHooks.writeTemp(path, data); return; }
  const fh = await open(path, 'wx');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Real write probe: creates a small file in the folder, then removes it. Leaves nothing behind.
 * @returns null when the folder is writable, otherwise a plain-English reason.
 */
export async function probeWritable(folder: string): Promise<string | null> {
  const path = join(folder, `${PROBE_PREFIX}${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeNewFile(path, Buffer.from('viman write test'));
  } catch (err) {
    await rm(path, { force: true }).catch(() => undefined);
    return plainFsError(err);
  }
  try {
    await rm(path, { force: true });
  } catch (err) {
    return `A test file could not be removed again: ${plainFsError(err)}`;
  }
  return existsSync(path) ? 'A test file could not be removed again.' : null;
}

/** True when `p` exists and is a folder (never throws). */
export function isFolder(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Validates a folder the owner typed and returns the normalised path to store.
 *
 * @param raw     The text the owner entered.
 * @param dataDir The shop's data folder (the external folder may not be inside it).
 * @throws AppError 400 EXTERNAL_FOLDER_INVALID (not absolute, missing, a file, inside the data folder, not writable),
 *   400 EXTERNAL_FOLDER_CLOUD (cloud-synced folder name, or a UNC/network path).
 */
export async function validateExternalFolder(raw: string, dataDir: string): Promise<string> {
  const text = raw.trim();
  if (text === '' || text.includes('\0')) throw invalid('Please enter the full path of a folder, for example E:\\Viman-Backups.');
  if (UNC_RE.test(text)) {
    throw cloud(`Network (UNC) paths such as \\\\server\\share are not allowed. ${CLOUD_EXPLANATION}`);
  }
  if (!isAbsoluteLocal(text)) {
    throw invalid('Please enter the full path of a folder on this computer or a USB drive, for example E:\\Viman-Backups (not a relative path).');
  }
  const full = resolve(text);
  const bad = cloudSegment(full);
  if (bad) {
    throw cloud(`That folder is in a cloud-synced location ("${bad}"). ${CLOUD_EXPLANATION}`);
  }
  if (!existsSync(full)) throw invalid('That folder does not exist. Plug in the drive and create the folder first.');
  if (!isFolder(full)) throw invalid('That path is a file, not a folder. Please choose a folder.');

  // A shortcut (symlink / junction) into a cloud folder is caught by checking the real location too.
  let real = full;
  try { real = realpathSync.native(full); } catch { /* keep the typed path */ }
  const realBad = cloudSegment(real);
  if (realBad) throw cloud(`That folder is really located in a cloud-synced location ("${realBad}"). ${CLOUD_EXPLANATION}`);
  let realData = dataDir;
  try { realData = realpathSync.native(dataDir); } catch { /* keep */ }
  if (isInsideFolder(real, realData) || isInsideFolder(full, dataDir)) {
    throw invalid('The external folder cannot be inside the shop\'s data folder: a copy there would not survive a failure of this computer\'s disk.');
  }
  const why = await probeWritable(full);
  if (why !== null) throw invalid(`The shop cannot write to that folder. ${why}`);
  return full;
}

/** Warning shown when the external folder is on the same disk (volume) as the shop's data folder, or null. */
export const SAME_DISK_WARNING =
  'This folder is on the same disk as the shop data, so a failure of that disk would also destroy these copies. Use a separate USB drive or another physical disk.';

/**
 * Same-disk check: true when both paths are on the same volume (same device number, or the same drive letter on Windows).
 * It sees volumes, not physical disks: two partitions of one physical disk are not recognised.
 */
export function sameVolume(folder: string, dataDir: string): boolean {
  try {
    const a = statSync(folder);
    const b = statSync(dataDir);
    if (a.dev !== 0 && b.dev !== 0) return a.dev === b.dev;
  } catch { return false; }
  const root = (p: string): string => resolve(p).slice(0, 3).toLowerCase();
  return root(folder) === root(dataDir);
}
