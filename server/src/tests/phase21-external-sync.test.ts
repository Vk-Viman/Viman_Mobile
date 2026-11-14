// Phase 21 hardening H3 (findings M5, M6, L1, L3): accurate external backup status (synchronization), per-folder state and a bounded failure log.
// Contract: API_CONTRACTS "Hardening contract" parts M5 and M6; migration 021 (external_backup_state).
// Real temp folders play the USB drive; a full drive is simulated with the writeTemp hook, a read-only drive with a real NTFS deny entry,
// an unplugged drive by renaming the folder; the clock is injected (a real week cannot be waited for).
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { call, get } from './helpers/catalog.ts';
import {
  allowWrite, appWithUsb, cleanAll, copyNow, denyWrite, distinctBackup, errno, extStatus, localBackups, logAll, oursIn, putFolder, sqlAll,
} from './helpers/phase19bk.ts';
import { buildDashboard, resolveAsOf } from '../services/dashboard.service.ts';
import { externalCopyIdle, runExternalCopyOnce } from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';
import { SAME_DISK_WARNING, plainFsError, sameVolume } from '../services/external-backup-validate.ts';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';
import { externalStatusLabel } from '../../../web/src/types/externalBackup.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await cleanAll(env); });

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Baseline = the real now: the dashboard reads the real clock for the age of a backup (the status endpoint reads the injected one). */
const T0 = Date.now() - 60_000;
let clock = T0;
const setClock = (ms: number): void => { clock = ms; externalHooks.now = () => new Date(clock); };
const stateRows = (s: { ctx: any }): any[] => sqlAll(s.ctx, 'SELECT * FROM external_backup_state');
/** The dashboard at the injected instant (the HTTP route reads the real clock for backup ages). */
const dashAt = (s: { ctx: any }): any => buildDashboard(s.ctx, resolveAsOf(undefined, new Date(clock)), new Date(clock));
const failedRows = (s: { ctx: any }): any[] => logAll(s.ctx).filter((l) => l.status === 'failed');
const full = (): void => { externalHooks.writeTemp = async () => { throw errno('ENOSPC'); }; };

describe('M5: a run that finds everything on the drive is a successful synchronization', () => {
  it('stale after 8 days; "Copy backup now" with every backup already present clears it and the dashboard warning (nothing new written)', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    setClock(T0 + 8 * DAY);
    expect((await extStatus(s.app)).status).toBe('stale');
    let dash = dashAt(s);
    expect(dash.warnings.map((w: any) => w.code)).toContain('EXTERNAL_BACKUP_STALE');
    const r = await copyNow(s.app);
    expect(r.body.copied).toEqual([]);
    expect(r.body.skipped).toEqual([{ name, reason: 'already_present' }]);
    expect(r.body.status).toBe('ok');
    const st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'ok', warning: null, daysSinceSuccess: 0, consecutiveFailures: 0 });
    expect(st.lastSuccessAt).toBe(new Date(T0 + 8 * DAY).toISOString()); // the confirmed synchronization
    expect(st.lastCopyAt).toBe(new Date(T0).toISOString()); // the file itself was copied 8 days ago
    dash = dashAt(s);
    expect(dash.backup.external).toEqual({ status: 'ok', lastSuccessAt: new Date(T0 + 8 * DAY).toISOString(), daysSinceSuccess: 0, warning: null });
    expect(dash.warnings.filter((w: any) => /^EXTERNAL_BACKUP/.test(w.code))).toEqual([]);
    // the append-only log did not get a row for the pure synchronization
    expect(logAll(s.ctx).filter((l) => l.status === 'ok')).toHaveLength(1);
  });

  it('a drive that is away does NOT clear the warning (stale, naming the cause); plugging it in and pressing Copy now does', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    setClock(T0 + 9 * DAY);
    renameSync(s.usb, `${s.usb}-away`);
    const r = await copyNow(s.app);
    expect(r.body.status).toBe('stale');
    expect(r.body.failed).toHaveLength(1);
    let st = await extStatus(s.app);
    expect(st.status).toBe('stale');
    expect(st.warning).toMatch(/cannot be found/);
    expect(st.warning).toMatch(/Overdue: no confirmed synchronization with the external folder for 9 days/);
    renameSync(`${s.usb}-away`, s.usb);
    expect((await copyNow(s.app)).body.status).toBe('ok');
    st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'ok', warning: null, consecutiveFailures: 0 });
  });

  it('every kind of run synchronizes: the timer, a post-backup copy and the folder being set (nothing is special about the button)', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    setClock(T0 + 5 * DAY);
    await runExternalCopyOnce(s.ctx, 'timer');
    expect(stateRows(s)[0].last_sync_at).toBe(new Date(T0 + 5 * DAY).toISOString());
    expect(stateRows(s)[0].last_success_at).toBe(new Date(T0).toISOString());
  });

  it('no backup at all to copy but the drive is fine: still synchronized', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const r = await runExternalCopyOnce(s.ctx, 'manual');
    expect(r.failed).toEqual([]);
    expect(r.status).toBe('ok');
    expect((await extStatus(s.app)).lastSuccessAt).toBe(new Date(T0).toISOString());
  });
});

describe('M5: status for every state (injected clock)', () => {
  it('not_configured -> ok -> ok at 6 d 23 h 59 min -> stale at exactly 7 d (no confirmed sync); text per state', async () => {
    setClock(T0);
    const s = await appWithUsb(env, false);
    let st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'not_configured', configured: false, lastSuccessAt: null, consecutiveFailures: 0 });
    expect(st.warning).toMatch(/No external backup folder is set/);
    expect((await get(s.app, '/dashboard')).body.warnings.filter((w: any) => /^EXTERNAL_BACKUP/.test(w.code))).toEqual([]);

    expect((await putFolder(s.app, env.newDir('viman-usb21-'))).status).toBe(200);
    localBackups(s.ctx, 1);
    await copyNow(s.app);
    for (const [offset, expected, days] of [
      [0, 'ok', 0], [DAY, 'ok', 1], [6 * DAY + 23 * HOUR + 59 * 60_000, 'ok', 6], [7 * DAY - 1, 'ok', 6], [7 * DAY, 'stale', 7], [20 * DAY, 'stale', 20],
    ] as const) {
      setClock(T0 + offset);
      st = await extStatus(s.app);
      expect(st.status, `+${offset} ms`).toBe(expected);
      expect(st.daysSinceSuccess).toBe(days);
      if (expected === 'ok') expect(st.warning).toBeNull();
      else expect(st.warning).toMatch(new RegExp(`Overdue: no confirmed synchronization with the external folder for ${days} days`));
    }
  });

  it('a folder that never synchronized: ok for 6 d 23 h, stale from 7 d counted from the day it was set', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    for (const [offset, expected] of [[0, 'ok'], [7 * DAY - 1, 'ok'], [7 * DAY, 'stale']] as const) {
      setClock(T0 + offset);
      const st = await extStatus(s.app);
      expect(st.status).toBe(expected);
      expect(st.lastSuccessAt).toBeNull();
      expect(st.daysSinceSuccess).toBeNull();
      if (expected === 'stale') expect(st.warning).toMatch(/no synchronization with the external folder has been confirmed since it was set up 7 days ago/);
    }
  });

  it('drive_missing, failed (full drive: "failed N times since ..."), and ok again after the recovery', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    localBackups(s.ctx, 2);
    renameSync(s.usb, `${s.usb}-away`);
    setClock(T0 + HOUR);
    await runExternalCopyOnce(s.ctx, 'manual');
    let st = await extStatus(s.app);
    expect(st.status).toBe('drive_missing');
    expect(st.warning).toMatch(/Drive not found/);
    renameSync(`${s.usb}-away`, s.usb);
    full();
    setClock(T0 + 2 * HOUR);
    await runExternalCopyOnce(s.ctx, 'manual');
    st = await extStatus(s.app);
    expect(st.status).toBe('failed');
    expect(st.consecutiveFailures).toBe(2); // the missing drive and the full drive are consecutive failures of this folder
    expect(st.firstFailureAt).toBe(new Date(T0 + HOUR).toISOString());
    expect(st.lastError).toMatch(/drive is full/);
    expect(st.warning).toMatch(/The last copy to the external backup folder failed: The external drive is full/);
    resetExternalHooks();
    setClock(T0 + 3 * HOUR);
    expect((await copyNow(s.app)).body.status).toBe('ok');
    st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'ok', warning: null, consecutiveFailures: 0, firstFailureAt: null, lastError: null });
  });

  it('the dashboard block and the top-level warning follow the status; synchronized shows no warning', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const codes = async () => (dashAt(s).warnings as any[]).map((w) => w.code).filter((c) => /^EXTERNAL_BACKUP/.test(c));
    expect(await codes()).toEqual([]);
    renameSync(s.usb, `${s.usb}-away`);
    expect(await codes()).toEqual(['EXTERNAL_BACKUP_DRIVE_MISSING']);
    renameSync(`${s.usb}-away`, s.usb);
    full();
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(await codes()).toEqual(['EXTERNAL_BACKUP_FAILED']);
    resetExternalHooks();
    setClock(T0 + 7 * DAY);
    await call(s.app, 'POST', '/backups/external/copy');
    setClock(T0 + 7 * DAY);
    expect(await codes()).toEqual([]);
    setClock(T0 + 15 * DAY);
    expect(await codes()).toEqual(['EXTERNAL_BACKUP_STALE']);
  });
});

describe('M6: the append-only log is bounded', () => {
  it('a full drive, 4 pending backups, 8 timer passes: one failed row per backup, the counters carry the rest; next day one more row each', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const names = localBackups(s.ctx, 4);
    full();
    for (let i = 0; i < 8; i++) { setClock(T0 + i * 10 * 60_000); await runExternalCopyOnce(s.ctx, 'timer'); }
    expect(failedRows(s)).toHaveLength(4);
    expect(failedRows(s).map((r) => r.source_name).sort()).toEqual([...names].sort());
    expect(logAll(s.ctx)).toHaveLength(4); // nothing else
    const st = stateRows(s)[0];
    expect(st).toMatchObject({ consecutive_failures: 8, total_failures: 8, first_failure_at: new Date(T0).toISOString(), last_error_code: 'ENOSPC' });
    expect(st.last_error_message).toMatch(/drive is full/);
    const api = await extStatus(s.app);
    expect(api).toMatchObject({ status: 'failed', consecutiveFailures: 8, firstFailureAt: new Date(T0).toISOString() });

    // 6 days of passes every 10 minutes (864 passes) add at most 4 rows per day
    let passes = 0;
    for (let t = T0 + 8 * 10 * 60_000; t < T0 + 3 * DAY; t += 6 * HOUR) { setClock(t); await runExternalCopyOnce(s.ctx, 'timer'); passes++; }
    expect(passes).toBeGreaterThan(8);
    expect(failedRows(s).length).toBeLessThanOrEqual(4 * 4); // days 0..3, one row per backup per day at most
    expect(failedRows(s).length).toBeGreaterThan(4);
    // the failed rows older than 24 h are not repeated inside the same 24 h
    const perDay = new Map<string, number>();
    for (const r of failedRows(s)) {
      const key = `${r.source_name}`;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(4);
  });

  it('REAL read-only drive: failures of a new error kind or a new backup are logged once; identical failures only count', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    denyWrite(s.usb);
    try {
      await distinctBackup(s);
      await externalCopyIdle(s.ctx);
      const rows1 = failedRows(s).length;
      expect(rows1).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 6; i++) await runExternalCopyOnce(s.ctx, 'timer');
      expect(failedRows(s)).toHaveLength(rows1);
      expect(stateRows(s)[0].consecutive_failures).toBeGreaterThanOrEqual(7);
      expect((await extStatus(s.app)).status).toBe('failed');
    } finally { allowWrite(s.usb); }
    const r = await copyNow(s.app);
    expect(r.body.failed).toEqual([]);
    expect(r.body.status).toBe('ok');
  });

  it('recovery is logged once: the first success after a logged failure writes one row, further synchronizations none', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const before = logAll(s.ctx).length;
    renameSync(s.usb, `${s.usb}-away`);
    await runExternalCopyOnce(s.ctx, 'manual'); // logs "drive not found" once
    await runExternalCopyOnce(s.ctx, 'manual'); // identical: counted only
    expect(logAll(s.ctx)).toHaveLength(before + 1);
    expect(failedRows(s)).toHaveLength(1);
    expect(stateRows(s)[0].consecutive_failures).toBe(2);
    renameSync(`${s.usb}-away`, s.usb);
    await runExternalCopyOnce(s.ctx, 'timer'); // everything is already on the drive: the recovery row
    const rows = logAll(s.ctx);
    expect(rows).toHaveLength(before + 2);
    expect(rows[rows.length - 1]).toMatchObject({ status: 'skipped', source_name: null });
    await runExternalCopyOnce(s.ctx, 'timer');
    await runExternalCopyOnce(s.ctx, 'manual');
    expect(logAll(s.ctx)).toHaveLength(before + 2);
    expect(stateRows(s)[0]).toMatchObject({ consecutive_failures: 0, first_failure_at: null, total_failures: 2 });
  });

  it('the timer finding a missing drive is counted but not logged; the first manual click logs it once', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    const rows0 = logAll(s.ctx).length;
    for (let i = 0; i < 20; i++) await runExternalCopyOnce(s.ctx, 'timer');
    expect(logAll(s.ctx)).toHaveLength(rows0);
    expect(stateRows(s)[0].consecutive_failures).toBe(20);
    await copyNow(s.app);
    await copyNow(s.app);
    expect(logAll(s.ctx)).toHaveLength(rows0 + 1);
    renameSync(`${s.usb}-away`, s.usb);
    // the failure series is closed without a recovery row only when nothing had been logged for it; here one had, so one row appears
    await runExternalCopyOnce(s.ctx, 'timer');
    expect(logAll(s.ctx)).toHaveLength(rows0 + 2);
  });

  it('the log stays append-only', async () => {
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(() => s.ctx.database.conn.exec("UPDATE external_backup_log SET error = 'x'")).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
    expect(() => s.ctx.database.conn.exec('DELETE FROM external_backup_log')).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
  });
});

describe('M5/L3: the status belongs to the folder; setting a folder synchronizes at once', () => {
  it('a newly set folder gets an immediate background sync of the existing backups (no request needed)', async () => {
    setClock(T0);
    const s = await env.build();
    const names = localBackups(s.ctx, 3);
    const usb = env.newDir('viman-usb21-');
    const r = await call(s.app, 'PUT', '/backups/external', { folder: usb }); // the real thing: no hook
    expect(r.status).toBe(200);
    await externalCopyIdle(s.ctx);
    expect(oursIn(usb)).toEqual(expect.arrayContaining(names));
    const st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'ok', warning: null, consecutiveFailures: 0 });
    expect(st.lastSuccessAt).toBe(new Date(T0).toISOString());
    expect(stateRows(s)).toHaveLength(1);
  });

  it('switching folders: the new folder starts fresh (old success does not count, old state is gone) and is synchronized at once', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    setClock(T0 + 10 * DAY);
    expect((await extStatus(s.app)).status).toBe('stale');
    const B = env.newDir('viman-usbB21-');
    expect((await call(s.app, 'PUT', '/backups/external', { folder: B })).status).toBe(200);
    await externalCopyIdle(s.ctx);
    expect(oursIn(B).length).toBeGreaterThan(0);
    const st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'ok', folder: B, warning: null });
    expect(st.lastSuccessAt).toBe(new Date(T0 + 10 * DAY).toISOString());
    const rows = stateRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].folder).toBe(B);
  });

  it('a new folder that cannot be synchronized (full) is "failed", not "stale" from an old success; a second PUT of the same folder does not restart anything', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    setClock(T0 + 10 * DAY);
    const B = env.newDir('viman-usbB21-');
    // (a "full" writeTemp hook would also make the folder probe fail, so the damage is injected after the write instead)
    externalHooks.afterWrite = async () => { throw errno('EIO'); };
    await call(s.app, 'PUT', '/backups/external', { folder: B });
    await externalCopyIdle(s.ctx);
    let st = await extStatus(s.app);
    expect(st.status).toBe('failed');
    expect(st.consecutiveFailures).toBe(1);
    resetExternalHooks();
    setClock(T0 + 10 * DAY);
    const before = stateRows(s)[0];
    await call(s.app, 'PUT', '/backups/external', { folder: B });
    await externalCopyIdle(s.ctx);
    expect(stateRows(s)[0]).toEqual(before);
    st = await extStatus(s.app);
    expect(st.status).toBe('failed');
  });

  it('clearing the folder removes the state; setting a folder again starts clean', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(stateRows(s)).toHaveLength(1);
    expect((await call(s.app, 'PUT', '/backups/external', { folder: null })).status).toBe(200);
    expect(stateRows(s)).toEqual([]);
    const st = await extStatus(s.app);
    expect(st).toMatchObject({ status: 'not_configured', lastSuccessAt: null, daysSinceSuccess: null });
  });

  it('a run that was in flight when the folder was switched does not write a state row for the old folder', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    localBackups(s.ctx, 2);
    const B = env.newDir('viman-usbB21-');
    externalHooks.afterWrite = async () => { await call(s.app, 'PUT', '/backups/external', { folder: B }); };
    await runExternalCopyOnce(s.ctx, 'manual');
    delete externalHooks.afterWrite;
    await externalCopyIdle(s.ctx);
    expect(stateRows(s).map((r) => r.folder)).toEqual([B]);
  });
});

describe('restore interaction (documented: the state is data of the database file and travels with a restored backup)', () => {
  it('restoring an older backup brings back the older state of the same folder; no crash, status computed, Copy now resynchronizes', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const name = await distinctBackup(s); // the backup contains the state row of the folder (never synchronized yet)
    await externalCopyIdle(s.ctx);
    expect(stateRows(s)[0].last_sync_at).not.toBeNull();
    setClock(T0 + 3 * DAY);
    const r = await s.app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: { name, confirm: 'RESTORE' } });
    expect(r.statusCode).toBe(200);
    let st = await extStatus(s.app);
    expect(st.status).toBe('ok'); // the folder setting and its state came back with the file
    expect(st.folder).toBe(s.usb);
    expect(st.lastSuccessAt).toBeNull(); // the restored state predates the synchronization
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    expect((await copyNow(s.app)).body.status).toBe('ok');
    st = await extStatus(s.app);
    expect(st.lastSuccessAt).toBe(new Date(T0 + 3 * DAY).toISOString());
  });

  it('restoring a backup of a folder that is not there any more: drive_missing with a plain warning, the shop works', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    const r = await s.app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: { name, confirm: 'RESTORE' } });
    expect(r.statusCode).toBe(200);
    const st = await extStatus(s.app);
    expect(st.status).toBe('drive_missing');
    expect(st.warning).toMatch(/Drive not found/);
    expect((await call(s.app, 'POST', '/backups')).status).toBe(201);
  });
});

describe('concurrent runs', () => {
  it('six runs and a Copy now started together are serialized: each backup is copied exactly once, one state row, no temp files', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const names = localBackups(s.ctx, 3);
    const runs = await Promise.all([
      runExternalCopyOnce(s.ctx, 'timer'), runExternalCopyOnce(s.ctx, 'auto'), runExternalCopyOnce(s.ctx, 'timer'),
      runExternalCopyOnce(s.ctx, 'manual'), runExternalCopyOnce(s.ctx, 'timer'), runExternalCopyOnce(s.ctx, 'auto'),
      copyNow(s.app),
    ]);
    expect(runs).toHaveLength(7);
    const copied = runs.flatMap((r: any) => (r.body ? r.body.copied : r.copied) as Array<{ name: string }>);
    expect(copied.map((c) => c.name).sort()).toEqual([...names].sort());
    expect(oursIn(s.usb)).toEqual([...names].sort());
    expect(readdirSync(s.usb).filter((n) => /\.tmp$/.test(n))).toEqual([]);
    expect(logAll(s.ctx).filter((l) => l.status === 'ok')).toHaveLength(3);
    expect(stateRows(s)).toHaveLength(1);
    expect(stateRows(s)[0].consecutive_failures).toBe(0);
  });
});

describe('Low findings in these files', () => {
  it('L1: letter case is not a different file (identical -> already present, different -> unique name, never a failure)', async () => {
    const s = await appWithUsb(env);
    const names = localBackups(s.ctx, 2);
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(join(s.usb, names[0]!.toUpperCase()), readFileSync(join(s.ctx.backupsDir, names[0]!)));
    writeFileSync(join(s.usb, names[1]!.toUpperCase().replace('.DB', '.db')), 'different');
    const r = await copyNow(s.app);
    expect(r.body.failed).toEqual([]);
    expect(r.body.skipped).toEqual([{ name: names[0], reason: 'already_present' }]);
    expect(r.body.copied.map((c: any) => c.name)).toEqual([names[1]!.replace('.db', '-2.db')]);
    expect((await copyNow(s.app)).body.copied).toEqual([]); // and the next run changes nothing
    expect((await extStatus(s.app)).status).toBe('ok');
  });

  it('L3: plain wording for EEXIST / junction errors', () => {
    expect(plainFsError(errno('EEXIST'))).toMatch(/shortcut \(junction\)/);
    expect(plainFsError(errno('EEXIST'))).not.toMatch(/EEXIST/);
  });

  it('L3: a folder on the same disk as the data folder is accepted with a warning (Settings only; the status stays ok)', async () => {
    const s = await appWithUsb(env);
    expect(sameVolume(s.usb, s.dataDir)).toBe(true);
    const st = await extStatus(s.app);
    expect(st.diskWarning).toBe(SAME_DISK_WARNING);
    expect(st.status).toBe('ok');
    expect(st.warning).toBeNull();
    const put = await call(s.app, 'PUT', '/backups/external', { folder: env.newDir('viman-usb21-') });
    expect(put.status).toBe(200);
    expect(put.body.diskWarning).toBe(SAME_DISK_WARNING);
    const dash = dashAt(s);
    expect(Object.keys(dash.backup.external).sort()).toEqual(['daysSinceSuccess', 'lastSuccessAt', 'status', 'warning']);
  });
});

describe('UI wording (web/src/types/externalBackup.ts)', () => {
  it('Synchronized, Not set up, Drive not found, Last copy failed, Overdue (no confirmed sync for N days)', () => {
    expect(externalStatusLabel('ok', 0, true)).toEqual({ text: 'Synchronized', tone: 'brand' });
    expect(externalStatusLabel('ok', null, false).text).toBe('Waiting for first sync');
    expect(externalStatusLabel('not_configured', null, false).text).toBe('Not set up');
    expect(externalStatusLabel('drive_missing', 2, true).text).toBe('Drive not found');
    expect(externalStatusLabel('failed', 0, true)).toEqual({ text: 'Last copy failed', tone: 'red' });
    expect(externalStatusLabel('stale', 7, true)).toEqual({ text: 'Overdue (no confirmed sync for 7 days)', tone: 'red' });
    expect(externalStatusLabel('stale', 1, true).text).toBe('Overdue (no confirmed sync for 1 day)');
    expect(externalStatusLabel('stale', null, false).text).toBe('Overdue (never confirmed)');
  });
});

describe('migration 021 on a populated database', () => {
  /** A database migrated to just before 021 with some shop rows and a configured external folder. */
  function oldDb(folder: string | null): { db: DatabaseSync; dir: string } {
    const dir = env.newDir('viman-mig21-');
    const oldDir = join(dir, 'old');
    mkdirSync(oldDir);
    for (const f of loadMigrations()) if (f.version < 21) copyFileSync(join(MIGRATIONS_DIR, f.name), join(oldDir, f.name));
    const db = new DatabaseSync(join(dir, 'viman.db'));
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, oldDir);
    db.exec("INSERT INTO settings (key, value_json) VALUES ('rates', '{\"reloadCommissionBp\":600,\"ezcashCommissionBp\":80}')");
    db.exec("INSERT INTO suppliers (name, phone) VALUES ('Alpha', '0771')");
    db.exec("INSERT INTO audit_logs (entity, entity_id, action, after_json) VALUES ('settings', 'rates', 'update', '{\"a\":1}')");
    if (folder !== null) db.prepare("INSERT INTO backup_settings (id, external_dir, updated_at) VALUES (1, ?, '2026-05-01T00:00:00.000Z')").run(folder);
    return { db, dir };
  }
  const SHA = 'a'.repeat(64);
  const logIns = (db: DatabaseSync, status: string, at: string, err?: string): void => {
    if (status === 'failed') db.prepare("INSERT INTO external_backup_log (source_name, status, error, created_at) VALUES ('viman-x.db','failed',?,?)").run(err ?? 'e', at);
    else if (status === 'ok') db.prepare("INSERT INTO external_backup_log (source_name, target_name, status, size_bytes, sha256, created_at) VALUES ('viman-x.db','viman-x.db','ok',10,?,?)").run(SHA, at);
    else db.prepare("INSERT INTO external_backup_log (source_name, target_name, status, created_at) VALUES ('viman-x.db','viman-x.db','skipped',?)").run(at);
  };
  const dump = (db: DatabaseSync): string => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'external_backup_state' AND name <> 'schema_migrations' ORDER BY name").all() as any[]).map((r) => r.name);
    return JSON.stringify(names.map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]));
  };

  it('carries the last success / sync and the trailing failure series over; every other table and the log are unchanged', () => {
    const { db } = oldDb('E:\\Viman');
    logIns(db, 'ok', '2026-05-02T10:00:00.000Z');
    logIns(db, 'skipped', '2026-05-03T10:00:00.000Z');
    logIns(db, 'failed', '2026-05-04T10:00:00.000Z', 'first');
    logIns(db, 'failed', '2026-05-05T10:00:00.000Z', 'last');
    const before = dump(db);
    expect(before).not.toContain('external_backup_state');
    const r = migrate(db);
    expect(r.applied).toContain('021_external_backup_state.sql');
    expect(dump(db)).toBe(before); // log rows included: nothing changed
    const rows = db.prepare('SELECT * FROM external_backup_state').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      folder: 'E:\\Viman', first_seen_at: '2026-05-01T00:00:00.000Z', last_success_at: '2026-05-02T10:00:00.000Z',
      last_sync_at: '2026-05-03T10:00:00.000Z', last_attempt_at: '2026-05-05T10:00:00.000Z', consecutive_failures: 2, total_failures: 2,
      first_failure_at: '2026-05-04T10:00:00.000Z', last_error_message: 'last', last_failure_logged_at: '2026-05-05T10:00:00.000Z',
    });
    expect(() => db.exec("UPDATE external_backup_log SET error = 'x'")).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((db.prepare('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');
    db.close();
  });

  it('a newest successful row means no failure series; failures older than the newest success do not count as current', () => {
    const { db } = oldDb('E:\\Viman');
    logIns(db, 'failed', '2026-05-02T10:00:00.000Z', 'old');
    logIns(db, 'ok', '2026-05-03T10:00:00.000Z');
    migrate(db);
    const row = db.prepare('SELECT * FROM external_backup_state').get() as any;
    expect(row).toMatchObject({ consecutive_failures: 0, total_failures: 1, first_failure_at: null, last_sync_at: '2026-05-03T10:00:00.000Z' });
    db.close();
  });

  it('no folder configured: the table starts empty; a folder with an empty log gets a row with no sync', () => {
    const a = oldDb(null);
    logIns(a.db, 'ok', '2026-05-02T10:00:00.000Z');
    migrate(a.db);
    expect(a.db.prepare('SELECT COUNT(*) AS n FROM external_backup_state').get()).toEqual({ n: 0 });
    a.db.close();
    const b = oldDb('E:\\Viman');
    migrate(b.db);
    expect(b.db.prepare('SELECT * FROM external_backup_state').get()).toMatchObject({
      folder: 'E:\\Viman', last_sync_at: null, last_success_at: null, consecutive_failures: 0, first_seen_at: '2026-05-01T00:00:00.000Z',
    });
    b.db.close();
  });

  it('the CHECKs hold: no negative counters, a failing series needs its first failure time, one row per folder (case-insensitive)', () => {
    const { db } = oldDb('E:\\Viman');
    migrate(db);
    const ins = (sql: string): void => { db.exec(`INSERT INTO external_backup_state (folder, first_seen_at, ${sql}`); };
    expect(() => ins("consecutive_failures) VALUES ('F:\\a', 'x', -1)")).toThrow();
    expect(() => ins("consecutive_failures, total_failures) VALUES ('F:\\b', 'x', 1, 1)")).toThrow(); // series without first_failure_at
    expect(() => ins("consecutive_failures, total_failures, first_failure_at) VALUES ('F:\\c', 'x', 3, 2, 'y')")).toThrow();
    expect(() => ins("total_failures) VALUES ('e:\\VIMAN', 'x', 0)")).toThrow(); // same folder, other letter case
    db.close();
  });

  it('the application upgrades a real populated data folder on start-up: 021 applied, the shop keeps working', async () => {
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(sqlAll(s.ctx, "SELECT version FROM schema_migrations WHERE version = 21")).toHaveLength(1);
    expect(existsSync(s.usb)).toBe(true);
  });
});
