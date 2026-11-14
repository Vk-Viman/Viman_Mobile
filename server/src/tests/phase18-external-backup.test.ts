// Phase 18: EXTERNAL BACKUPS (BUSINESS_RULES section 12, API_CONTRACTS part C, migration 018).
// Real temp folders play the part of the "USB drive". Drives that cannot be created on demand are simulated through the
// test hooks of services/external-backup-hooks.ts: a full drive (ENOSPC), a read-only drive (EROFS), a damaged copy
// (a byte flipped after writing), a drive pulled out mid-copy (folder renamed before the final rename) and a fixed clock.
// Organised as: validation, copy (ok / never overwrite / retention / which sources), automatic triggers and the timer,
// statuses and the seven-day boundary, failures that must never block the shop, restore, dashboard, audit, database guards,
// migration 018 on a populated database.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import { call, get, post } from './helpers/catalog.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import type { AppContext } from '../app.ts';
import { createBackup, listBackups } from '../services/backup.service.ts';
import { buildDashboard } from '../services/dashboard.service.ts';
import {
  copyExternalNow, externalCopyIdle, runExternalCopyOnce, scheduleExternalCopy, startExternalCopyTimer,
} from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(async () => {
  resetExternalHooks();
  await env.cleanup();
});

const DAY = 86_400_000;
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
// Sets the folder without the immediate synchronization added by hardening M5 (covered in phase21-external-sync.test.ts):
// these tests set up a still-empty drive and then drive every copy themselves.
const putFolder = async (app: FastifyInstance, folder: unknown) => {
  externalHooks.noSyncOnSet = true;
  try { return await call(app, 'PUT', '/backups/external', { folder }); } finally { delete externalHooks.noSyncOnSet; }
};
const status = async (app: FastifyInstance) => (await get(app, '/backups/external')).body;
const sqlRows = (ctx: AppContext, q: string, ...p: any[]): any[] => ctx.database.conn.prepare(q).all(...p) as any[];
const logRows = (ctx: AppContext) => sqlRows(ctx, 'SELECT * FROM external_backup_log ORDER BY id');

/** App + an empty "USB drive" folder, configured as the external folder. */
async function setup(configure = true) {
  const b = await env.build();
  const usb = env.newDir('viman-usb-');
  if (configure) {
    const r = await putFolder(b.app, usb);
    if (r.status !== 200) throw new Error(`setup: ${JSON.stringify(r.body)}`);
  }
  return { ...b, usb };
}

/** The backup file names in a folder (matching our own pattern), sorted. */
const ours = (dir: string): string[] => readdirSync(dir).filter((n) => /^viman-\d{8}-\d{6}-(startup|manual)(-\d+)?\.db$/.test(n)).sort();

/** A deterministic manual backup at a given instant (the file name follows the instant). */
const backupAt = (ctx: AppContext, reason: 'startup' | 'manual' | 'pre-restore', iso: string) => createBackup(ctx, reason, new Date(iso));

const errnoError = (code: string): Error => Object.assign(new Error(code), { code });

describe('folder validation (PUT /backups/external)', () => {
  it('refuses relative, missing, file, inside-data-folder paths; accepts a real folder; null clears', async () => {
    const s = await setup(false);
    const bad = async (folder: unknown, code = 'EXTERNAL_FOLDER_INVALID') => {
      const r = await putFolder(s.app, folder);
      expect(r.status, JSON.stringify(folder)).toBe(400);
      expect(r.body.error.code).toBe(code);
      expect(typeof r.body.error.message).toBe('string');
    };
    await bad('usb-drive');
    await bad('.\\backups');
    await bad('../elsewhere');
    await bad('E:Viman'); // drive-relative, not absolute
    await bad('');
    await bad('   ');
    await bad(join(env.newDir(), 'does-not-exist'));
    // a file instead of a folder
    const file = join(env.newDir(), 'a-file.txt');
    writeFileSync(file, 'x');
    await bad(file);
    // "under a file" cannot exist either
    await bad(join(file, 'sub'));
    // inside the data folder (the data folder itself, its backups folder, a sub folder)
    await bad(s.dataDir);
    await bad(s.ctx.backupsDir);
    mkdirSync(join(s.dataDir, 'ext'));
    await bad(join(s.dataDir, 'ext'));
    expect((await status(s.app)).configured).toBe(false);

    const good = env.newDir('viman-usb-');
    const ok = await putFolder(s.app, good);
    expect(ok.status).toBe(200);
    expect(ok.body.configured).toBe(true);
    expect(ok.body.folder).toBe(good);
    expect(readdirSync(good)).toEqual([]); // the write probe left nothing behind
    expect((await status(s.app)).writable).toBe(true);

    const cleared = await putFolder(s.app, null);
    expect(cleared.status).toBe(200);
    expect(cleared.body.configured).toBe(false);
    expect(cleared.body.folder).toBeNull();
    expect(cleared.body.status).toBe('not_configured');
  });

  it('refuses every cloud-synced folder name (any path segment, any case) with EXTERNAL_FOLDER_CLOUD and a plain explanation', async () => {
    const s = await setup(false);
    const root = env.newDir();
    const names = [
      'OneDrive', 'OneDrive - Contoso Ltd', 'onedrive', 'Google Drive', 'GoogleDrive', 'GOOGLE DRIVE', 'Dropbox', 'DROPBOX (Personal)',
      'iCloud', 'iCloudDrive', 'Box', 'Box Sync', 'pCloud', 'pCloudDrive', 'MEGA', 'MEGAsync',
    ];
    for (const name of names) {
      const inner = join(root, name, 'backups');
      mkdirSync(inner, { recursive: true });
      for (const folder of [inner, join(root, name)]) {
        const r = await putFolder(s.app, folder);
        expect(r.status, folder).toBe(400);
        expect(r.body.error.code, folder).toBe('EXTERNAL_FOLDER_CLOUD');
        expect(r.body.error.message).toMatch(/not encrypted/i);
        expect(r.body.error.message).toMatch(/cloud/i);
      }
    }
    // not-yet-existing folders inside a cloud folder are refused as cloud too (before any existence check)
    expect((await putFolder(s.app, join(root, 'Dropbox', 'nope'))).body.error.code).toBe('EXTERNAL_FOLDER_CLOUD');
    // a name that merely contains the word later in the segment is fine
    const fine = join(root, 'My archive', 'usb');
    mkdirSync(fine, { recursive: true });
    expect((await putFolder(s.app, fine)).status).toBe(200);
    expect((await status(s.app)).configured).toBe(true);
  });

  it('refuses UNC / network paths', async () => {
    const s = await setup(false);
    for (const p of ['\\\\server\\share\\backups', '//server/share/backups', '\\\\?\\C:\\temp', '\\\\192.168.1.5\\usb']) {
      const r = await putFolder(s.app, p);
      expect(r.status, p).toBe(400);
      expect(r.body.error.code, p).toBe('EXTERNAL_FOLDER_CLOUD');
    }
  });

  it('refuses a folder that fails the real write probe (read-only drive) and leaves nothing behind', async () => {
    const s = await setup(false);
    const usb = env.newDir('viman-usb-');
    externalHooks.writeTemp = async () => { throw errnoError('EROFS'); };
    const r = await putFolder(s.app, usb);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EXTERNAL_FOLDER_INVALID');
    expect(r.body.error.message).toMatch(/read-only/i);
    resetExternalHooks();
    expect(readdirSync(usb)).toEqual([]);
    expect((await status(s.app)).configured).toBe(false);
  });

  it('rejects a malformed body', async () => {
    const s = await setup(false);
    expect((await call(s.app, 'PUT', '/backups/external', {})).status).toBe(400);
    expect((await call(s.app, 'PUT', '/backups/external', { folder: 5 })).status).toBe(400);
    expect((await call(s.app, 'PUT', '/backups/external', { folder: 'x', extra: 1 })).status).toBe(400);
  });
});

describe('copy (POST /backups/external/copy)', () => {
  it('copies a backup with identical size and SHA-256 under its own name, and logs it', async () => {
    const s = await setup();
    const b = backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(200);
    expect(r.body.failed).toEqual([]);
    expect(r.body.skipped).toEqual([]);
    expect(r.body.copied).toHaveLength(1);
    const local = join(s.ctx.backupsDir, b.name);
    const remote = join(s.usb, b.name);
    expect(r.body.copied[0]).toEqual({ name: b.name, sizeBytes: statSync(local).size, sha256: sha(local) });
    expect(statSync(remote).size).toBe(statSync(local).size);
    expect(sha(remote)).toBe(sha(local));
    expect(readdirSync(s.usb)).toEqual([b.name]); // no temp file left
    const log = logRows(s.ctx);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source_name: b.name, target_name: b.name, status: 'ok', size_bytes: statSync(local).size, sha256: sha(local), error: null });
    expect(r.body.status).toBe('ok');
    // the copy is a real, valid database
    const db = new DatabaseSync(remote, { readOnly: true });
    expect((db.prepare('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');
    db.close();
    // GET lists it
    const st = await status(s.app);
    expect(st.copies.map((c: any) => c.name)).toEqual([b.name]);
    expect(st.copies[0].sizeBytes).toBe(statSync(local).size);
    expect(st.status).toBe('ok');
    expect(st.lastSuccessAt).toBe(log[0].created_at);
    expect(st.lastError).toBeNull();
  });

  it('POST copy without a configured folder is a plain 409 and writes nothing', async () => {
    const s = await setup(false);
    backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EXTERNAL_FOLDER_NOT_SET');
    expect(logRows(s.ctx)).toEqual([]);
  });

  it('never overwrites: an identical file is skipped; a different file under the same name gets a new unique name', async () => {
    const s = await setup();
    const b = backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const local = join(s.ctx.backupsDir, b.name);
    // identical file already present
    copyFileSync(local, join(s.usb, b.name));
    const before = readFileSync(join(s.usb, b.name));
    const r1 = await post(s.app, '/backups/external/copy', {});
    expect(r1.body.copied).toEqual([]);
    expect(r1.body.skipped).toEqual([{ name: b.name, reason: 'already_present' }]);
    expect(readFileSync(join(s.usb, b.name)).equals(before)).toBe(true);
    expect(ours(s.usb)).toEqual([b.name]);

    // different content under the same name: the original stays byte for byte, the copy gets a new name
    const s2 = await setup();
    const b2 = backupAt(s2.ctx, 'manual', '2026-03-01T10:00:00Z');
    const foreign = Buffer.from('not the same content at all');
    writeFileSync(join(s2.usb, b2.name), foreign);
    const r2 = await post(s2.app, '/backups/external/copy', {});
    expect(r2.body.failed).toEqual([]);
    expect(r2.body.copied).toHaveLength(1);
    const newName = r2.body.copied[0].name as string;
    expect(newName).not.toBe(b2.name);
    expect(newName).toMatch(/^viman-\d{8}-\d{6}-manual-2\.db$/);
    expect(readFileSync(join(s2.usb, b2.name)).equals(foreign)).toBe(true);
    expect(sha(join(s2.usb, newName))).toBe(sha(join(s2.ctx.backupsDir, b2.name)));
    // running again does not create another copy (the "-2" file is recognised as identical)
    const r3 = await post(s2.app, '/backups/external/copy', {});
    expect(r3.body.copied).toEqual([]);
    expect(r3.body.skipped).toEqual([{ name: b2.name, reason: 'already_present' }]);
    expect(ours(s2.usb)).toEqual([b2.name, newName].sort());
    expect(readFileSync(join(s2.usb, b2.name)).equals(foreign)).toBe(true);
  });

  it('retention: keeps exactly the newest 30 of our backups and never touches other files or folders', async () => {
    const s = await setup();
    // 34 older backups of ours, plus files that are NOT ours
    const old: string[] = [];
    for (let i = 0; i < 34; i++) {
      const name = `viman-20200101-0000${String(i).padStart(2, '0')}-${i % 2 === 0 ? 'manual' : 'startup'}.db`;
      writeFileSync(join(s.usb, name), `old ${i}`);
      old.push(name);
    }
    const strangers: Record<string, string> = {
      'notes.txt': 'my notes', 'viman-20190101-000000-pre-restore.db': 'safety', 'viman-backup.db': 'x', 'viman-20200101-000000-manual.db.bak': 'y',
      'VIMAN-20200101-000001-manual.DB': 'z', 'photo.jpg': 'jpg',
    };
    for (const [n, c] of Object.entries(strangers)) writeFileSync(join(s.usb, n), c);
    mkdirSync(join(s.usb, 'old-backups'));
    writeFileSync(join(s.usb, 'old-backups', 'viman-20180101-000000-manual.db'), 'inside a subfolder');

    const b = backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.body.failed).toEqual([]);
    expect(r.body.copied.map((c: any) => c.name)).toEqual([b.name]);
    const kept = ours(s.usb);
    expect(kept).toHaveLength(30);
    expect(kept).toContain(b.name);
    // the 29 newest old ones survive, the 5 oldest are gone
    const expectedOld = [...old].sort().slice(5);
    expect(kept.filter((n) => n !== b.name)).toEqual(expectedOld);
    expect(r.body.pruned.sort()).toEqual([...old].sort().slice(0, 5));
    // everything else untouched
    for (const [n, c] of Object.entries(strangers)) expect(readFileSync(join(s.usb, n), 'utf8')).toBe(c);
    expect(readFileSync(join(s.usb, 'old-backups', 'viman-20180101-000000-manual.db'), 'utf8')).toBe('inside a subfolder');
    expect((await status(s.app)).copies).toHaveLength(30);
  });

  it('a source older than the newest 30 already on the drive is not copied (it would be pruned at once)', async () => {
    const s = await setup();
    for (let i = 0; i < 30; i++) writeFileSync(join(s.usb, `viman-20300101-0000${String(i).padStart(2, '0')}-manual.db`), `future ${i}`);
    const b = backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.body.copied).toEqual([]);
    expect(r.body.skipped).toEqual([{ name: b.name, reason: 'older_than_retention' }]);
    expect(ours(s.usb)).toHaveLength(30);
    expect(existsSync(join(s.usb, b.name))).toBe(false);
  });

  it('only start-up and manual backups are copied, never pre-restore safety copies', async () => {
    const s = await setup();
    const a = backupAt(s.ctx, 'startup', '2026-03-01T10:00:00Z');
    const m = backupAt(s.ctx, 'manual', '2026-03-01T11:00:00Z');
    const p = backupAt(s.ctx, 'pre-restore', '2026-03-01T12:00:00Z');
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.body.copied.map((c: any) => c.name).sort()).toEqual([a.name, m.name].sort());
    expect(readdirSync(s.usb)).not.toContain(p.name);
    expect(readdirSync(s.usb).some((n) => n.includes('pre-restore'))).toBe(false);
    // newest first
    expect(r.body.copied.map((c: any) => c.name)).toEqual([m.name, a.name]);
  });

  it('removes stale temporary copies of ours (older than an hour) and nothing else that is hidden', async () => {
    const s = await setup();
    const stale = join(s.usb, '.viman-copy-abcdef012345.tmp');
    const other = join(s.usb, '.something-else.tmp');
    writeFileSync(stale, 'x');
    writeFileSync(other, 'y');
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    await post(s.app, '/backups/external/copy', {});
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});


describe('automatic copies and the timer', () => {
  it('copies automatically after a start-up backup and after a manual backup (POST /backups), in the background', async () => {
    const s = await setup();
    const a = backupAt(s.ctx, 'startup', '2026-03-01T10:00:00Z');
    expect(scheduleExternalCopy(s.ctx)).toBeUndefined(); // fire and forget: returns at once
    await externalCopyIdle(s.ctx);
    expect(ours(s.usb)).toEqual([a.name]);

    const r = await post(s.app, '/backups', {});
    expect(r.status).toBe(201);
    await externalCopyIdle(s.ctx);
    expect(ours(s.usb)).toContain(r.body.item.name);
    expect(ours(s.usb)).toHaveLength(2);
    expect(sha(join(s.usb, r.body.item.name))).toBe(sha(join(s.ctx.backupsDir, r.body.item.name)));
    expect(logRows(s.ctx).filter((l) => l.status === 'ok')).toHaveLength(2);
  });

  it('runExternalCopyOnce (the timer function) picks up a drive that appears later, and stays quiet while it is away', async () => {
    const s = await setup();
    const gone = `${s.usb}-away`;
    renameSync(s.usb, gone); // the drive is unplugged
    const b = backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const miss = await runExternalCopyOnce(s.ctx, 'timer');
    expect(miss.copied).toEqual([]);
    expect(miss.status).toBe('drive_missing');
    expect(logRows(s.ctx)).toEqual([]); // the timer does not spam the log while the drive is away
    renameSync(gone, s.usb); // plugged back in
    const hit = await runExternalCopyOnce(s.ctx, 'timer');
    expect(hit.copied.map((c) => c.name)).toEqual([b.name]);
    expect(hit.status).toBe('ok');
    expect(ours(s.usb)).toEqual([b.name]);
    // nothing new: the next tick does nothing and logs nothing
    const again = await runExternalCopyOnce(s.ctx, 'timer');
    expect(again.copied).toEqual([]);
    expect(logRows(s.ctx)).toHaveLength(1);
  });

  it('startExternalCopyTimer ticks, copies when the drive appears, and stops', async () => {
    const s = await setup();
    const gone = `${s.usb}-away`;
    renameSync(s.usb, gone);
    const b = backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const stop = startExternalCopyTimer(s.ctx, 25);
    await new Promise((r) => setTimeout(r, 120));
    expect(existsSync(s.usb)).toBe(false);
    renameSync(gone, s.usb);
    const deadline = Date.now() + 5000;
    while (!existsSync(join(s.usb, b.name)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(join(s.usb, b.name))).toBe(true);
    stop();
    await externalCopyIdle(s.ctx);
    const b2 = backupAt(s.ctx, 'manual', '2026-03-02T10:00:00Z');
    await new Promise((r) => setTimeout(r, 150));
    await externalCopyIdle(s.ctx);
    expect(existsSync(join(s.usb, b2.name))).toBe(false); // stopped
  });

  it('a timer pass with no folder configured does nothing at all', async () => {
    const s = await setup(false);
    backupAt(s.ctx, 'manual', '2026-03-01T10:00:00Z');
    const r = await runExternalCopyOnce(s.ctx, 'timer');
    expect(r.status).toBe('not_configured');
    expect(logRows(s.ctx)).toEqual([]);
  });
});

describe('status (GET /backups/external) with an injected clock', () => {
  it('not_configured -> ok -> stale at exactly 7 days (6 days 23 hours is still ok)', async () => {
    const s = await setup(false);
    const t0 = new Date('2026-05-01T08:00:00Z').getTime();
    let clock = t0;
    externalHooks.now = () => new Date(clock);
    const nc = await status(s.app);
    expect(nc).toMatchObject({ configured: false, folder: null, status: 'not_configured', lastSuccessAt: null, daysSinceSuccess: null });
    expect(nc.warning).toMatch(/No external backup folder/);

    // configure: the clock for "never copied" starts now
    const usb = env.newDir('viman-usb-');
    expect((await putFolder(s.app, usb)).status).toBe(200);
    clock = t0 + 6 * DAY + 23 * 3_600_000;
    expect((await status(s.app)).status).toBe('ok');
    clock = t0 + 7 * DAY;
    const never = await status(s.app);
    expect(never.status).toBe('stale');
    expect(never.daysSinceSuccess).toBeNull();
    expect(never.warning).toMatch(/set up 7 days ago/);

    // a successful copy resets it
    clock = t0 + 8 * DAY;
    backupAt(s.ctx, 'manual', '2026-05-09T10:00:00Z');
    const copied = await post(s.app, '/backups/external/copy', {});
    expect(copied.body.status).toBe('ok');
    const t1 = clock;
    expect((await status(s.app)).lastSuccessAt).toBe(new Date(t1).toISOString());
    clock = t1 + 6 * DAY + 23 * 3_600_000 + 59 * 60_000;
    const almost = await status(s.app);
    expect(almost.status).toBe('ok');
    expect(almost.daysSinceSuccess).toBe(6);
    expect(almost.warning).toBeNull();
    clock = t1 + 7 * DAY;
    const stale = await status(s.app);
    expect(stale.status).toBe('stale');
    expect(stale.daysSinceSuccess).toBe(7);
    expect(stale.warning).toMatch(/7 days/);
    clock = t1 + 20 * DAY;
    expect((await status(s.app)).daysSinceSuccess).toBe(20);
  });

  it('drive_missing when the folder is gone, and ok again when it is back', async () => {
    const s = await setup();
    const t0 = new Date('2026-05-01T08:00:00Z').getTime();
    externalHooks.now = () => new Date(t0 + DAY);
    backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    await post(s.app, '/backups/external/copy', {});
    const gone = `${s.usb}-away`;
    renameSync(s.usb, gone);
    const missing = await status(s.app);
    expect(missing).toMatchObject({ configured: true, folderAvailable: false, status: 'drive_missing', writable: null, copies: [] });
    expect(missing.warning).toContain(s.usb);
    expect(missing.warning).toMatch(/Shop work is not affected/);
    renameSync(gone, s.usb);
    expect((await status(s.app)).status).toBe('ok');
  });

  it('a folder replaced by a FILE of the same name counts as missing', async () => {
    const s = await setup();
    rmSync(s.usb, { recursive: true });
    writeFileSync(s.usb, 'now a file');
    const st1 = await status(s.app);
    expect(st1.status).toBe('drive_missing');
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(200);
    expect(r.body.failed).toHaveLength(1);
  });

  it('failed after a full drive, clears after the next successful copy', async () => {
    const s = await setup();
    const b = backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    externalHooks.writeTemp = async () => { throw errnoError('ENOSPC'); };
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(200); // reported in the answer, never an HTTP error
    expect(r.body.copied).toEqual([]);
    expect(r.body.failed).toEqual([{ name: b.name, error: 'The external drive is full.' }]);
    expect(r.body.status).toBe('failed');
    expect(r.body.warning).toMatch(/full/);
    const stt = await status(s.app);
    expect(stt.status).toBe('failed');
    expect(stt.lastError).toBe('The external drive is full.');
    expect(stt.lastAttemptAt).not.toBeNull();
    expect(stt.lastSuccessAt).toBeNull();
    expect(readdirSync(s.usb)).toEqual([]);
    const log = logRows(s.ctx);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'failed', source_name: b.name, target_name: null, error: 'The external drive is full.' });
    // after the drive has room again
    resetExternalHooks();
    const ok = await post(s.app, '/backups/external/copy', {});
    expect(ok.body.status).toBe('ok');
    expect(ours(s.usb)).toEqual([b.name]);
    const after = await status(s.app);
    expect(after.status).toBe('ok');
    expect(after.lastError).toBeNull();
  });
});

describe('external failures never block the shop', () => {
  /** Runs a failing copy and checks the invariants every failure shares. */
  async function failureCase(inject: () => void, expectText: RegExp, afterFiles: (usb: string) => void = (usb) => expect(readdirSync(usb)).toEqual([])) {
    const s = await setup();
    const b = backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    inject();
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(200);
    expect(r.body.copied).toEqual([]);
    expect(r.body.failed.length).toBeGreaterThanOrEqual(1);
    expect(r.body.failed[0].error).toMatch(expectText);
    expect(['failed', 'drive_missing']).toContain(r.body.status);
    expect(r.body.warning).toEqual(expect.any(String));
    afterFiles(s.usb);
    const log = logRows(s.ctx);
    expect(log.some((l) => l.status === 'failed' && expectText.test(l.error))).toBe(true);
    expect(log.some((l) => l.status === 'ok')).toBe(false);
    // the local backup and the app are unharmed
    expect(listBackups(s.ctx).map((x) => x.name)).toContain(b.name);
    expect((await get(s.app, '/health')).status).toBe(200);
    return s;
  }

  it('read-only drive (EROFS)', async () => {
    await failureCase(() => { externalHooks.writeTemp = async () => { throw errnoError('EROFS'); }; }, /read-only/i);
  });
  it('permission denied (EACCES)', async () => {
    await failureCase(() => { externalHooks.writeTemp = async () => { throw errnoError('EACCES'); }; }, /not allowed to write/i);
  });
  it('full drive (ENOSPC) - the half-written temp file is removed', async () => {
    await failureCase(() => {
      externalHooks.writeTemp = async (path, data) => { writeFileSync(path, data.subarray(0, 10)); throw errnoError('ENOSPC'); };
    }, /full/i);
  });
  it('checksum mismatch: a corrupted copy is discarded, nothing under the final name, no temp left', async () => {
    await failureCase(() => {
      externalHooks.afterWrite = (tmp) => {
        const buf = readFileSync(tmp);
        buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
        writeFileSync(tmp, buf);
      };
    }, /checksum mismatch/i);
  });
  it('size mismatch (truncated copy) is discarded too', async () => {
    await failureCase(() => {
      externalHooks.afterWrite = (tmp) => { writeFileSync(tmp, readFileSync(tmp).subarray(0, 100)); };
    }, /wrong size/i);
  });
  it('folder removed mid-copy (drive pulled out before the final rename)', async () => {
    const s = await setup();
    const b = backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    const gone = `${s.usb}-pulled`;
    externalHooks.beforeRename = () => { renameSync(s.usb, gone); };
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(200);
    expect(r.body.copied).toEqual([]);
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.status).toBe('drive_missing');
    expect(logRows(s.ctx).some((l) => l.status === 'failed')).toBe(true);
    expect(existsSync(join(gone, b.name))).toBe(false);
    // plugged back in: the next copy works
    resetExternalHooks();
    renameSync(gone, s.usb);
    const ok = await post(s.app, '/backups/external/copy', {});
    expect(ok.body.copied.map((c: any) => c.name)).toEqual([b.name]);
  });

  it('drive missing: the manual copy answers 200 with a warning and logs one failed row', async () => {
    const s = await setup();
    backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    renameSync(s.usb, `${s.usb}-away`);
    const r = await post(s.app, '/backups/external/copy', {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('drive_missing');
    expect(r.body.failed[0].error).toMatch(/cannot be found/);
    expect(logRows(s.ctx)).toHaveLength(1);
  });

  it('with the drive missing the shop keeps working: sales, manual backups, dashboard, restart; the answer never depends on the drive', async () => {
    const s = await setup();
    const s2 = await apiBase(s);
    renameSync(s.usb, `${s.usb}-away`);
    const p = await mkProduct(s2);
    await buy(s2, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 100000 }]);
    const sale = await sellOk(s2, [cl(p.id, 2, 150000)]);
    expect(sale.sales).toHaveLength(1);
    const m = await post(s.app, '/backups', {});
    expect(m.status).toBe(201);
    expect(Object.keys(m.body)).toEqual(['item']); // same shape as before: nothing about the drive leaks into the answer
    await externalCopyIdle(s.ctx);
    expect(listBackups(s.ctx).map((x) => x.name)).toContain(m.body.item.name);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    expect(logRows(s.ctx).every((l) => l.status === 'failed')).toBe(true);
    // a restart on the same data is fine too
    await s.app.close();
    const again = await env.build({ dataDir: s.dataDir });
    expect((await get(again.app, '/health')).status).toBe(200);
    expect((await get(again.app, '/backups/external')).body.status).toBe('drive_missing');
    scheduleExternalCopy(again.ctx);
    await externalCopyIdle(again.ctx);
  });

  it('a drive that hangs forever does not block backups, sales or any request (copy runs in the background)', async () => {
    const s = await setup();
    const s2 = await apiBase(s);
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((res) => { release = res; });
    externalHooks.writeTemp = async (path) => {
      if (!path.includes('.viman-copy-')) return; // only the backup copy hangs (the folder probe is answered)
      await stuck;
      throw errnoError('EIO');
    };
    backupAt(s.ctx, 'startup', '2026-05-01T10:00:00Z');
    scheduleExternalCopy(s.ctx); // what index.ts does after the start-up backup
    const t0 = Date.now();
    const m = await post(s.app, '/backups', {});
    expect(m.status).toBe(201);
    const p = await mkProduct(s2);
    await buy(s2, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 100000 }]);
    await sellOk(s2, [cl(p.id, 1, 150000)]);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    expect((await get(s.app, '/backups/external')).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    release();
    await externalCopyIdle(s.ctx);
    expect(logRows(s.ctx).some((l) => l.status === 'failed')).toBe(true);
  });

  it('a copy that finishes after the server is closed does not throw into anything', async () => {
    const s = await setup();
    backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((res) => { release = res; });
    externalHooks.writeTemp = async () => { await stuck; throw errnoError('EIO'); };
    const pending = runExternalCopyOnce(s.ctx, 'auto');
    await s.app.close(); // closes the database while the copy is still waiting
    release();
    const r = await pending; // must resolve, not reject
    expect(r.copied).toEqual([]);
  });

  it('copyExternalNow and runExternalCopyOnce never reject even when the folder setting cannot be read', async () => {
    const s = await setup();
    s.ctx.database.conn.exec('DROP TRIGGER trg_backup_settings_no_delete');
    s.ctx.database.conn.exec('DROP TABLE backup_settings');
    const r = await runExternalCopyOnce(s.ctx, 'manual');
    expect(r.failed).toHaveLength(1);
    await expect(copyExternalNow(s.ctx)).rejects.toBeTruthy(); // the only thrown case: the setting itself is unreadable
  });
});

describe('restore stays local', () => {
  it('restoring works with an external folder set; the pre-restore safety backup stays local only', async () => {
    const s = await setup();
    await call(s.app, 'PUT', '/settings', { rates: { reloadCommissionBp: 111, ezcashCommissionBp: 11 } });
    const b = await post(s.app, '/backups', {});
    await externalCopyIdle(s.ctx);
    await call(s.app, 'PUT', '/settings', { rates: { reloadCommissionBp: 222, ezcashCommissionBp: 22 } });
    const r = await post(s.app, '/backups/restore', { name: b.body.item.name, confirm: 'RESTORE' });
    expect(r.status).toBe(200);
    expect(r.body.safetyBackup).toMatch(/pre-restore/);
    expect((await get(s.app, '/settings')).body.rates.reloadCommissionBp).toBe(111);
    await externalCopyIdle(s.ctx);
    expect(readdirSync(s.usb).some((n) => n.includes('pre-restore'))).toBe(false);
    expect(listBackups(s.ctx).some((x) => x.name === r.body.safetyBackup)).toBe(true);
    // the external setting and log survive (they were part of the restored database)
    expect((await status(s.app)).folder).toBe(s.usb);
  });
});

describe('dashboard backup block', () => {
  it('carries external { status, lastSuccessAt, daysSinceSuccess, warning } and top-level warnings only for stale / drive_missing / failed', async () => {
    const s = await setup(false);
    const t0 = new Date('2026-05-01T08:00:00Z').getTime();
    let clock = t0;
    externalHooks.now = () => new Date(clock);
    const warnCodes = (d: any) => d.warnings.map((w: any) => w.code).filter((c: string) => c.startsWith('EXTERNAL_BACKUP'));
    const dash = () => buildDashboard(s.ctx, '2026-05-01', new Date(clock));

    let d = dash();
    expect(d.backup.external).toEqual({ status: 'not_configured', lastSuccessAt: null, daysSinceSuccess: null, warning: expect.stringMatching(/No external backup folder/) });
    expect(warnCodes(d)).toEqual([]); // informational only

    const usb = env.newDir('viman-usb-');
    await putFolder(s.app, usb);
    d = dash();
    expect(d.backup.external.status).toBe('ok');
    expect(d.backup.external.warning).toBeNull();
    expect(warnCodes(d)).toEqual([]);

    backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    await post(s.app, '/backups/external/copy', {});
    d = dash();
    expect(d.backup.external).toEqual({ status: 'ok', lastSuccessAt: new Date(t0).toISOString(), daysSinceSuccess: 0, warning: null });

    renameSync(usb, `${usb}-away`);
    d = dash();
    expect(d.backup.external.status).toBe('drive_missing');
    expect(warnCodes(d)).toEqual(['EXTERNAL_BACKUP_DRIVE_MISSING']);
    expect(d.warnings.find((w: any) => w.code === 'EXTERNAL_BACKUP_DRIVE_MISSING')!.message).toBe(d.backup.external.warning);
    renameSync(`${usb}-away`, usb);

    externalHooks.writeTemp = async () => { throw errnoError('ENOSPC'); };
    backupAt(s.ctx, 'manual', '2026-05-01T11:00:00Z');
    await post(s.app, '/backups/external/copy', {});
    d = dash();
    expect(d.backup.external.status).toBe('failed');
    expect(warnCodes(d)).toEqual(['EXTERNAL_BACKUP_FAILED']);
    resetExternalHooks();
    externalHooks.now = () => new Date(clock);

    clock = t0 + 7 * DAY;
    d = dash();
    expect(d.backup.external.status).toBe('stale');
    expect(d.backup.external.daysSinceSuccess).toBe(7);
    expect(warnCodes(d)).toEqual(['EXTERNAL_BACKUP_STALE']);
    // the local-backup part is unchanged
    expect(d.backup).toMatchObject({ status: expect.stringMatching(/^(ok|stale|none)$/) });
  });

  it('GET /dashboard returns the external block over HTTP', async () => {
    const s = await setup();
    const d = (await get(s.app, '/dashboard')).body;
    expect(Object.keys(d.backup.external).sort()).toEqual(['daysSinceSuccess', 'lastSuccessAt', 'status', 'warning']);
    expect(d.backup.external.status).toBe('ok');
  });
});

describe('audit and database guards', () => {
  it('audits settings changes (entity backup_settings) and not no-ops', async () => {
    const s = await setup(false);
    const usb = env.newDir('viman-usb-');
    const usb2 = env.newDir('viman-usb-');
    await putFolder(s.app, usb);
    await putFolder(s.app, usb); // unchanged: no new row
    await putFolder(s.app, usb2);
    await putFolder(s.app, null);
    await putFolder(s.app, '\\\\server\\share'); // refused: no row
    const rowsA = sqlRows(s.ctx, "SELECT * FROM audit_logs WHERE entity = 'backup_settings' ORDER BY id");
    expect(rowsA).toHaveLength(3);
    expect(rowsA.map((r) => [r.action, JSON.parse(r.before_json), JSON.parse(r.after_json)])).toEqual([
      ['update', { folder: null }, { folder: usb }],
      ['update', { folder: usb }, { folder: usb2 }],
      ['update', { folder: usb2 }, { folder: null }],
    ]);
    expect(rowsA.every((r) => r.entity_id === '1' && r.business_date === null)).toBe(true);
    // copying is logged in the external log, not in the audit trail
    expect(sqlRows(s.ctx, "SELECT COUNT(*) n FROM audit_logs WHERE entity = 'backup_settings'")[0].n).toBe(3);
  });

  it('the copy log is append-only; the settings row cannot be deleted; CHECKs hold', async () => {
    const s = await setup();
    backupAt(s.ctx, 'manual', '2026-05-01T10:00:00Z');
    await post(s.app, '/backups/external/copy', {});
    const c = s.ctx.database.conn;
    expect(() => c.exec("UPDATE external_backup_log SET error = 'x'")).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
    expect(() => c.exec('DELETE FROM external_backup_log')).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
    expect(() => c.exec('DELETE FROM backup_settings')).toThrow(/BACKUP_SETTINGS_DELETE_FORBIDDEN/);
    expect(() => c.exec("INSERT INTO external_backup_log (status) VALUES ('ok')")).toThrow();
    expect(() => c.exec("INSERT INTO external_backup_log (status, target_name, size_bytes, sha256) VALUES ('ok','a',1,'XYZ')")).toThrow();
    expect(() => c.exec("INSERT INTO external_backup_log (status) VALUES ('failed')")).toThrow();
    expect(() => c.exec("INSERT INTO external_backup_log (status, error) VALUES ('weird','x')")).toThrow();
    expect(() => c.exec("INSERT INTO backup_settings (id, external_dir) VALUES (2, 'x')")).toThrow();
    expect(sqlRows(s.ctx, 'SELECT COUNT(*) n FROM external_backup_log')[0].n).toBe(1);
  });
});

describe('migration 018 on a populated database', () => {
  it('adds the two tables without changing any existing row', () => {
    const dir = env.newDir('viman-mig-');
    const oldDir = join(dir, 'old');
    mkdirSync(oldDir);
    for (const f of loadMigrations()) {
      if (f.version < 18) copyFileSync(join(MIGRATIONS_DIR, f.name), join(oldDir, f.name));
    }
    const file = join(dir, 'viman.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, oldDir);
    db.exec("INSERT INTO settings (key, value_json) VALUES ('rates', '{\"reloadCommissionBp\":600,\"ezcashCommissionBp\":80}')");
    db.exec("INSERT INTO suppliers (name, phone) VALUES ('Alpha', '0771'), ('Beta', '0772')");
    db.exec("INSERT INTO audit_logs (entity, entity_id, action, after_json) VALUES ('settings', 'rates', 'update', '{\"a\":1}')");
    const dump = (): string => {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('backup_settings','external_backup_log','external_backup_state','schema_migrations') ORDER BY name").all() as any[]).map((r) => r.name);
      return JSON.stringify(names.map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]));
    };
    const before = dump();
    expect(before.length).toBeGreaterThan(1000);
    const r = migrate(db);
    expect(r.applied).toContain('018_external_backups.sql');
    expect(dump()).toBe(before);
    expect((db.prepare('SELECT COUNT(*) n FROM backup_settings').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM external_backup_log').get() as any).n).toBe(0);
    expect((db.prepare('PRAGMA foreign_key_check').all() as any[])).toEqual([]);
    expect((db.prepare('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');
    db.close();
  });
});
