// Phase 19 audit: the drive as the OWNER meets it. REAL mechanisms on this Windows machine: a folder renamed away (unplugged),
// a path on a drive letter that does not exist, an NTFS deny ACE (read-only drive) restored in finally blocks, a real
// reconnect (rename back). The full drive (ENOSPC) is SIMULATED with the test hook, because a disk cannot be filled here.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct } from './helpers/inventory.ts';
import { expNew } from './helpers/phase8.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { call, get, post } from './helpers/catalog.ts';
import {
  allowWrite, appWithUsb, copyNow, denyWrite, distinctBackup, errno, extStatus, logAll, oursIn, putFolder, sha256File,
} from './helpers/phase19bk.ts';
import { listBackups } from '../services/backup.service.ts';
import { externalCopyIdle, runExternalCopyOnce } from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';
import type { AppContext } from '../app.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });

/** Everything the shop does day to day must keep working whatever the drive is doing. */
async function shopCarriesOn(b: { app: any; ctx: AppContext }): Promise<{ manualName: string }> {
  const s = await apiBase(b);
  const p = await mkProduct(s);
  await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 100000 }]);
  expect((await sellOk(s, [cl(p.id, 1, 150000)])).sales).toHaveLength(1);
  const e = await expNew(s, { amountCents: 777 });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  const m = await post(b.app, '/backups', {});
  expect(m.status).toBe(201);
  expect((await get(b.app, '/dashboard')).status).toBe(200);
  expect((await get(b.app, '/backups')).status).toBe(200);
  return { manualName: m.body.item.name };
}

const logCount = (ctx: AppContext): number => logAll(ctx).length;

describe('missing drive', () => {
  it('REAL: the folder is renamed away (unplugged) - status drive_missing with the folder in the warning; sales, expenses, manual backup, restore, dashboard unaffected', async () => {
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-unplugged`);

    const st = await extStatus(s.app);
    expect(st.status).toBe('drive_missing');
    expect(st.folderAvailable).toBe(false);
    expect(st.writable).toBeNull();
    expect(st.copies).toEqual([]);
    expect(st.warning).toContain(s.usb);
    expect(st.warning).toMatch(/Plug the drive in/);
    expect(st.warning).toMatch(/Shop work is not affected/);

    const { manualName } = await shopCarriesOn(s);
    await externalCopyIdle(s.ctx);
    // restore by name while the drive is missing: must succeed, with the same configuration afterwards
    const r = await call(s.app, 'POST', '/backups/restore', { name: manualName, confirm: 'RESTORE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await extStatus(s.app)).configured).toBe(true);
    expect((await extStatus(s.app)).status).toBe('drive_missing');
    // the dashboard carries the warning but still answers
    const d = (await get(s.app, '/dashboard')).body;
    expect(d.backup.external.status).toBe('drive_missing');
    expect(d.warnings.map((w: any) => w.code)).toContain('EXTERNAL_BACKUP_DRIVE_MISSING');
  });

  it('REAL: a path on a drive letter that does not exist (Z:) behaves like an unplugged drive; Save refuses it; no crash, no hang', async () => {
    // Prove the premise on this machine first.
    const letters = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-PSDrive -PSProvider FileSystem).Name -join \',\''], { encoding: 'utf8' });
    expect(letters.split(',').map((x) => x.trim())).not.toContain('Z');

    const s = await appWithUsb(env);
    const refused = await putFolder(s.app, 'Z:\\Viman-Backups');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('EXTERNAL_FOLDER_INVALID');

    // A saved setting pointing at the vanished letter (the USB drive had been E: / Z: when it was saved).
    s.ctx.database.conn.prepare('UPDATE backup_settings SET external_dir = ? WHERE id = 1').run('Z:\\Viman-Backups');
    const t0 = Date.now();
    const st = await extStatus(s.app);
    const manual = await copyNow(s.app);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(st.status).toBe('drive_missing');
    expect(manual.status).toBe(200);
    expect(manual.body.failed).toHaveLength(1);
    expect(manual.body.failed[0].error).toMatch(/cannot be found/);
    expect(manual.body.status).toBe('drive_missing');
    await shopCarriesOn(s);
  });

  it('the 10-minute timer is quiet: ten passes with the drive away add no log rows and no files anywhere; one manual click adds exactly one row', async () => {
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    const rows0 = logCount(s.ctx);
    const localBefore = readdirSync(s.ctx.backupsDir).sort();
    for (let i = 0; i < 10; i++) {
      const r = await runExternalCopyOnce(s.ctx, 'timer');
      expect(r.copied).toEqual([]);
      expect(r.status).toBe('drive_missing');
    }
    expect(logCount(s.ctx)).toBe(rows0);
    expect(readdirSync(s.ctx.backupsDir).sort()).toEqual(localBefore);
    expect(existsSync(s.usb)).toBe(false); // nothing re-created the folder
    await copyNow(s.app);
    expect(logCount(s.ctx)).toBe(rows0 + 1);
  });
});

describe('reconnected drive', () => {
  it('backups made while the drive was away are copied by the timer function, exactly once, with the right names; Copy now then finds nothing to do', async () => {
    const s = await appWithUsb(env);
    const first = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    const second = await distinctBackup(s);
    const third = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect((await extStatus(s.app)).status).toBe('drive_missing');

    renameSync(`${s.usb}-away`, s.usb); // plugged back in
    expect(oursIn(s.usb)).toEqual([first]);
    const run = await runExternalCopyOnce(s.ctx, 'timer');
    expect(run.copied.map((c) => c.name).sort()).toEqual([second, third].sort());
    expect(run.skipped).toEqual([{ name: first, reason: 'already_present' }]);
    expect(run.failed).toEqual([]);
    expect(run.status).toBe('ok');
    expect(oursIn(s.usb)).toEqual([first, second, third].sort());
    for (const n of [first, second, third]) expect(sha256File(join(s.usb, n))).toBe(sha256File(join(s.ctx.backupsDir, n)));
    expect(readdirSync(s.usb).every((n) => !n.endsWith('.tmp'))).toBe(true);

    const again = await copyNow(s.app);
    expect(again.status).toBe(200);
    expect(again.body.copied).toEqual([]);
    expect(again.body.skipped).toHaveLength(3);
    expect(again.body.failed).toEqual([]);
    expect(oursIn(s.usb)).toHaveLength(3);
    expect((await extStatus(s.app)).status).toBe('ok');
    expect((await extStatus(s.app)).warning).toBeNull();
    // the dashboard warning went away with the drive coming back
    expect((await get(s.app, '/dashboard')).body.warnings.map((w: any) => w.code)).not.toContain('EXTERNAL_BACKUP_DRIVE_MISSING');
  });

  it('Copy now is enough on its own after reconnecting (no timer), and the very first run of a never-used folder copies every local backup', async () => {
    const s = await appWithUsb(env);
    const names = [await distinctBackup(s), await distinctBackup(s)];
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    const lost = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(`${s.usb}-away`, s.usb);
    const r = await copyNow(s.app);
    expect(r.body.copied.map((c: any) => c.name)).toEqual([lost]);
    expect(oursIn(s.usb)).toEqual([...names, lost].sort());
  });
});

describe('read-only drive (REAL NTFS deny ACE; always restored in finally)', () => {
  it('Save refuses a read-only folder with a plain message and leaves nothing behind; the setting stays unchanged', async () => {
    const s = await appWithUsb(env, false);
    const ro = env.newDir('viman-ro19-');
    denyWrite(ro);
    try {
      const r = await putFolder(s.app, ro);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('EXTERNAL_FOLDER_INVALID');
      expect(r.body.error.message).toMatch(/cannot write to that folder/i);
      expect(r.body.error.message).toMatch(/not allowed to write|read-only|protected/i);
      expect(r.body.error.message).not.toMatch(/EACCES|EPERM|\bat\b.*node:/);
    } finally { allowWrite(ro); }
    expect(readdirSync(ro)).toEqual([]);
    expect((await extStatus(s.app)).configured).toBe(false);
    expect(sqlRowCount(s.ctx, 'audit_logs', "entity = 'backup_settings'")).toBe(0);
  });

  it('a drive that turns read-only AFTER Save: Copy now answers 200 with a clear failure, status failed, writable false, nothing half-written; after the drive is writable again the same click succeeds', async () => {
    const s = await appWithUsb(env);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(oursIn(s.usb)).toEqual([name]);
    const second = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    // make the next copy necessary: take a third backup while writable, remove nothing, then lock the drive first
    denyWrite(s.usb);
    try {
      const third = await distinctBackup(s);
      await externalCopyIdle(s.ctx); // the automatic copy fails quietly
      const r = await copyNow(s.app);
      expect(r.status).toBe(200);
      expect(r.body.copied).toEqual([]);
      expect(r.body.failed.map((f: any) => f.name)).toContain(third);
      expect(r.body.failed[0].error).toMatch(/not allowed to write|read-only/i);
      expect(r.body.status).toBe('failed');
      expect(r.body.warning).toMatch(/last copy to the external backup folder failed/);
      const st = await extStatus(s.app);
      expect(st.status).toBe('failed');
      expect(st.writable).toBe(false);
      expect(st.lastError).toMatch(/not allowed to write|read-only/i);
      expect(readdirSync(s.usb).sort()).toEqual([name, second].sort()); // no tmp, no partial file
      await shopCarriesOn(s);
      // existing external copies are untouched
      expect(sha256File(join(s.usb, name))).toBe(sha256File(join(s.ctx.backupsDir, name)));
    } finally { allowWrite(s.usb); }
    const ok = await copyNow(s.app);
    expect(ok.body.failed).toEqual([]);
    expect(ok.body.status).toBe('ok');
    expect(oursIn(s.usb).length).toBeGreaterThanOrEqual(3);
    expect((await extStatus(s.app)).writable).toBe(true);
  });

  it('read-only drive and the retention step: an old backup cannot be pruned (delete denied) - nothing crashes and the files stay', async () => {
    const s = await appWithUsb(env);
    const a = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    denyWrite(s.usb);
    try {
      const r = await runExternalCopyOnce(s.ctx, 'manual');
      expect(r.pruned).toEqual([]);
    } finally { allowWrite(s.usb); }
    expect(oursIn(s.usb)).toEqual([a]);
  });
});

describe('full drive (SIMULATED with the ENOSPC hook - a disk cannot be filled here)', () => {
  it('ENOSPC: plain message, status failed, no temp file, shop unaffected; the next successful run clears the warning', async () => {
    const s = await appWithUsb(env);
    const first = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    externalHooks.writeTemp = async () => { throw errno('ENOSPC'); };
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const r = await copyNow(s.app);
    expect(r.body.failed.length).toBeGreaterThan(0);
    expect(r.body.failed[0].error).toBe('The external drive is full.');
    expect(r.body.status).toBe('failed');
    expect((await extStatus(s.app)).warning).toMatch(/drive is full/);
    expect(readdirSync(s.usb)).toEqual([first]);
    await shopCarriesOn(s);
    resetExternalHooks();
    const ok = await copyNow(s.app);
    expect(ok.body.status).toBe('ok');
    expect((await extStatus(s.app)).warning).toBeNull();
  });
});

function sqlRowCount(ctx: AppContext, table: string, where: string): number {
  return Number((ctx.database.conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n);
}
void listBackups;
