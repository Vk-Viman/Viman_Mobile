#!/usr/bin/env node
/**
 * verify-external-backup.mjs - READ-ONLY check of an external backup folder (for example a real USB drive).
 *
 * Usage:   node scripts/verify-external-backup.mjs <folder> [--data <dataDir>] [--port <port>]
 *   <folder>  the external backup folder, e.g. E:\Viman-Backups
 *   --data    the shop data folder whose "backups" sub-folder holds the local copies (default: VIMAN_DATA_DIR, else <project>/data)
 *   --port    the shop server port for the optional status check (default: VIMAN_PORT, else 4300)
 *
 * It NEVER writes, renames or deletes anything (not in the folder, not in the data folder, not in any database: every
 * database is opened read-only, the server is only asked with GET). Plain Node 24, no dependencies.
 *
 * Checks (FAIL makes the exit code 1; WARN and INFO never do):
 *   1. the folder exists and is a folder                                            FAIL
 *   2. at least one backup, and no more than 30 (the retention limit)               FAIL
 *   3. every viman-YYYYMMDD-HHmmss-(startup|manual)[-n].db file:
 *        - SHA-256 equals the same-named file in <dataDir>\backups                   match = ok, mismatch = FAIL,
 *                                                                                    missing locally = INFO (local copies rotate)
 *        - opens as a SQLite database READ-ONLY and PRAGMA integrity_check = ok      FAIL
 *   4. leftover ".viman-copy-*.tmp" / ".viman-write-test-*.tmp" files               FAIL (may be a copy still running: run again)
 *   5. any other file or sub-folder, and "viman-" names that do not match exactly   WARN (never touched by the system, except
 *                                                                                    that look-alike names are never pruned)
 *   6. if the server answers on the port: GET /api/v1/backups/external is printed;  status other than "ok" = FAIL,
 *      a server that is not running is only INFO                                    a different folder than <folder> = WARN
 *
 * Exit code: 0 = every check passed, 1 = at least one FAIL, 2 = wrong usage.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = 30;
const NAME_RE = /^viman-\d{8}-\d{6}-(startup|manual)(-\d+)?\.db$/;
const TEMP_RE = /^\.viman-(copy-[0-9a-f]+|write-test-[0-9a-f]+)\.tmp$/;

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: node scripts/verify-external-backup.mjs <folder> [--data <dataDir>] [--port <port>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let folder = null;
let dataDir = process.env.VIMAN_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
let port = Number(process.env.VIMAN_PORT ?? 4300);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--data') { dataDir = args[++i] ?? usage('--data needs a folder'); }
  else if (a === '--port') { port = Number(args[++i] ?? usage('--port needs a number')); }
  else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else if (folder === null) folder = a;
  else usage('only one folder may be given');
}
if (folder === null) usage('the external backup folder is required');
if (!Number.isInteger(port) || port < 1 || port > 65535) usage('--port must be 1-65535');
folder = resolve(folder);
const backupsDir = join(resolve(dataDir), 'backups');

let fails = 0;
let warns = 0;
const say = (tag, text) => console.log(`${tag.padEnd(5)} ${text}`);
const ok = (t) => say('ok', t);
const info = (t) => say('INFO', t);
const warn = (t) => { warns++; say('WARN', t); };
const fail = (t) => { fails++; say('FAIL', t); };

/** SHA-256 of a file, streamed (read-only). */
function sha256(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

/** PRAGMA integrity_check on a READ-ONLY connection. Returns 'ok' or the problem text. */
function integrity(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all();
    return rows.map((r) => String(Object.values(r)[0])).join('; ');
  } catch (err) {
    return `cannot be opened as a database (${err instanceof Error ? err.message : err})`;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

console.log(`External backup folder: ${folder}`);
console.log(`Local backups folder:   ${backupsDir}${existsSync(backupsDir) ? '' : '  (not found)'}`);
console.log('');

let entries = null;
try {
  if (!statSync(folder).isDirectory()) fail('the path is not a folder');
  else entries = readdirSync(folder);
} catch (err) {
  fail(`the folder cannot be read (${err instanceof Error ? err.message : err}); is the drive plugged in?`);
}

if (entries !== null) {
  ok('the folder exists and can be listed');
  const backups = entries.filter((n) => NAME_RE.test(n)).sort();
  if (backups.length === 0) fail('no backup files (viman-YYYYMMDD-HHmmss-startup|manual.db) found');
  else if (backups.length > KEEP) fail(`${backups.length} backup files found: more than the ${KEEP} the system keeps (retention did not run)`);
  else ok(`${backups.length} backup file(s) (limit ${KEEP})`);

  for (const name of backups) {
    const path = join(folder, name);
    let st;
    try { st = statSync(path); } catch (err) { fail(`${name}: cannot be read (${err instanceof Error ? err.message : err})`); continue; }
    if (!st.isFile()) { fail(`${name}: is a folder, not a file`); continue; }
    if (st.size === 0) { fail(`${name}: is empty (0 bytes)`); continue; }
    let sum;
    try { sum = await sha256(path); } catch (err) { fail(`${name}: cannot be read (${err instanceof Error ? err.message : err})`); continue; }
    const local = join(backupsDir, name);
    let compare;
    if (!existsSync(local)) compare = 'local copy missing (rotated away or not in this data folder)';
    else {
      try {
        const localSum = await sha256(local);
        compare = localSum === sum ? 'matches the local copy' : 'DIFFERS from the local copy of the same name';
      } catch (err) { compare = `local copy unreadable (${err instanceof Error ? err.message : err})`; }
    }
    const verdict = integrity(path);
    const line = `${name}  ${st.size} bytes  sha256 ${sum.slice(0, 16)}...  ${compare}  integrity: ${verdict}`;
    if (compare.startsWith('DIFFERS') || compare.startsWith('local copy unreadable') || verdict !== 'ok') fail(line);
    else if (compare.startsWith('local copy missing')) { ok(line); info(`${name}: ${compare}`); }
    else ok(line);
  }

  for (const n of entries.filter((x) => TEMP_RE.test(x)).sort()) {
    let age = 'unknown age';
    try { age = `${Math.round((Date.now() - statSync(join(folder, n)).mtimeMs) / 60000)} minute(s) old`; } catch { /* ignore */ }
    fail(`leftover temporary file ${n} (${age}); an interrupted copy. The system removes it after an hour; if a copy is running now, run this check again`);
  }
  for (const n of entries.filter((x) => !NAME_RE.test(x) && !TEMP_RE.test(x)).sort()) {
    let kind = 'file';
    try { if (statSync(join(folder, n)).isDirectory()) kind = 'folder'; } catch { /* ignore */ }
    if (/^viman/i.test(n)) warn(`${kind} "${n}" looks like a backup but does not match the naming pattern; the system ignores it and never prunes it`);
    else warn(`${kind} "${n}" is not one of the system's backup files (left alone)`);
  }
}

// Optional: ask the running server (GET only).
try {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/backups/external`, { signal: ctl.signal });
  clearTimeout(timer);
  if (!res.ok) info(`server on port ${port} answered ${res.status} for GET /backups/external (status check skipped)`);
  else {
    const s = await res.json();
    console.log('');
    console.log(`Server status: ${s.status}  folder: ${s.folder}  available: ${s.folderAvailable}  writable: ${s.writable}`);
    console.log(`  last success: ${s.lastSuccessAt}  last attempt: ${s.lastAttemptAt}  days since success: ${s.daysSinceSuccess}`);
    if (s.warning) console.log(`  warning: ${s.warning}`);
    if (s.status === 'ok') ok('the server reports the external backup status "ok"');
    else fail(`the server reports the external backup status "${s.status}"`);
    if (typeof s.folder === 'string' && s.folder.toLowerCase() !== folder.toLowerCase()) {
      warn(`the server is set to copy to "${s.folder}", not to the folder checked here`);
    }
  }
} catch {
  info(`the shop server is not reachable on port ${port}: server status not checked`);
}

console.log('');
console.log(fails === 0 ? `RESULT: all checks passed${warns ? ` (${warns} warning(s))` : ''}` : `RESULT: ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
