// Phase 19 audit: which folders are accepted and which are refused (BUSINESS_RULES section 12: no cloud-synced folders, nothing inside the
// data folder). REAL file system on NTFS: junctions, deep paths, unicode names, folders created and renamed. Cloud detection is by NAME only,
// so this file records exactly what IS and IS NOT detected. Not performed: a mapped network drive and a real cloud client (none installed here).
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { call, get } from './helpers/catalog.ts';
import {
  appWithUsb, copyNow, distinctBackup, extStatus, logAll, makeJunction, oursIn, putFolder, sha256File, sqlAll,
} from './helpers/phase19bk.ts';
import { externalCopyIdle, runExternalCopyOnce } from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });

const code = (r: { status: number; body: any }): string => (r.status === 200 ? 'ACCEPTED' : r.body.error.code);

describe('paths: UNC, relative, odd syntax', () => {
  it('UNC and extended paths of every spelling answer EXTERNAL_FOLDER_CLOUD; a plain unreachable server name is refused before any network access', async () => {
    const s = await appWithUsb(env, false);
    const t0 = Date.now();
    for (const p of ['\\\\nas\\backups', '//nas/backups', '\\\\nas.example.com\\share\\sub', '\\\\?\\C:\\Windows', '\\\\.\\C:', '\\\\?\\UNC\\nas\\share', '  \\\\nas\\x  ']) {
      expect(code(await putFolder(s.app, p)), p).toBe('EXTERNAL_FOLDER_CLOUD');
    }
    expect(Date.now() - t0).toBeLessThan(3000); // no network round trip was attempted
  });

  it('relative, rooted-without-drive, drive-relative and junk paths are refused with EXTERNAL_FOLDER_INVALID', async () => {
    const s = await appWithUsb(env, false);
    for (const p of ['backups', '.', '..', '.\\usb', '..\\usb', '\\Users\\x', '/Users/x', 'E:usb', 'E:', '~', '%TEMP%', '$env:TEMP', 'file:///C:/x', 'C', 'null', 'a\u0000b']) {
      const r = await putFolder(s.app, p);
      expect(r.status, p).toBe(400);
      expect(r.body.error.code, p).toBe('EXTERNAL_FOLDER_INVALID');
    }
    expect((await extStatus(s.app)).configured).toBe(false);
  });

  it('forward slashes, doubled separators, a trailing separator, "." and ".." segments and surrounding spaces are normalised to one canonical path', async () => {
    const s = await appWithUsb(env, false);
    const usb = env.newDir('viman-usb19-');
    const canonical = usb;
    mkdirSync(join(usb, 'sub'));
    for (const typed of [usb.replace(/\\/g, '/'), `${usb}\\\\`, `  ${usb}  `, `${usb}\\sub\\..`, `${usb}\\.\\`]) {
      const r = await putFolder(s.app, typed);
      expect(r.status, typed).toBe(200);
      expect(r.body.folder, typed).toBe(canonical);
    }
    // five accepted saves of the same folder produce ONE audit row (a no-op is not audited)
    expect(sqlAll(s.ctx, "SELECT * FROM audit_logs WHERE entity = 'backup_settings'")).toHaveLength(1);
  });

  it('a file instead of a folder, a path below a file, the root of a missing drive: refused', async () => {
    const s = await appWithUsb(env, false);
    const dir = env.newDir();
    const f = join(dir, 'x.db');
    writeFileSync(f, 'x');
    expect(code(await putFolder(s.app, f))).toBe('EXTERNAL_FOLDER_INVALID');
    expect((await putFolder(s.app, f)).body.error.message).toMatch(/file, not a folder/);
    expect(code(await putFolder(s.app, `${f}\\`))).toBe('EXTERNAL_FOLDER_INVALID');
    expect(code(await putFolder(s.app, join(f, 'deeper')))).toBe('EXTERNAL_FOLDER_INVALID');
    expect(code(await putFolder(s.app, 'Z:\\'))).toBe('EXTERNAL_FOLDER_INVALID');
  });
});

describe('paths: cloud-synced folders (detection is by NAME only)', () => {
  it('refused: every spelling a real client uses, mixed case, nested at any depth, with trailing spaces or dots, and not-yet-existing folders', async () => {
    const s = await appWithUsb(env, false);
    const root = env.newDir();
    const bad = [
      'OneDrive', 'oNeDrIvE', 'ONEDRIVE', 'OneDrive - Personal', 'OneDrive for Business', 'OneDrive-Contoso',
      'Google Drive', 'google drive', 'GoogleDrive', 'GoogleDriveFS', 'Dropbox', 'Dropbox (Team)', 'iCloudDrive', 'iCloud', 'iCloud Photos',
      'Box', 'Box Sync', 'pCloud Drive', 'pCloudDrive', 'MEGA', 'MEGAsync', 'Mega',
      'OneDrive ', 'OneDrive.', 'OneDrive  ',
    ];
    for (const name of bad) {
      for (const typed of [`${root}\\${name}`, `${root}\\${name}\\a\\b\\c`, `${root}\\keep\\${name}\\x`, `${root.replace(/\\/g, '/')}/${name}/z`]) {
        expect(code(await putFolder(s.app, typed)), typed).toBe('EXTERNAL_FOLDER_CLOUD');
      }
    }
    expect(sqlAll(s.ctx, "SELECT * FROM audit_logs WHERE entity = 'backup_settings'")).toHaveLength(0);
  });

  it('NOT detected (accepted): look-alikes with a space or a different product name - recorded as limitations of name-based detection', async () => {
    const s = await appWithUsb(env, false);
    const root = env.newDir();
    const accepted: string[] = [];
    for (const name of ['One Drive', 'Drop box', 'Google  Drive', 'Goggle Drive', 'Nextcloud', 'Tresorit', 'Sync', 'Yandex.Disk', 'SharePoint', 'Creative Cloud Files', 'Resilio Sync', 'iDrive', 'Syncthing', 'OD']) {
      const d = join(root, name);
      mkdirSync(d);
      if (code(await putFolder(s.app, d)) === 'ACCEPTED') accepted.push(name);
    }
    expect(accepted.sort()).toEqual(['Creative Cloud Files', 'Drop box', 'Goggle Drive', 'Google  Drive', 'OD', 'One Drive', 'Nextcloud', 'Resilio Sync', 'SharePoint', 'Sync', 'Syncthing', 'Tresorit', 'Yandex.Disk', 'iDrive'].sort());
  });

  it('FALSE POSITIVES (refused as "cloud" although they are not): any folder whose name merely STARTS with box / mega / icloud ... e.g. "Boxes", "Megabytes", "Box of backups"', async () => {
    const s = await appWithUsb(env, false);
    const root = env.newDir();
    const refused: string[] = [];
    for (const name of ['Boxes', 'Boxing Day', 'Box of backups', 'Megabytes', 'Megastore', 'Megan', 'Dropbox2', 'Onedrive-old', 'boxer']) {
      const d = join(root, name);
      mkdirSync(d);
      if (code(await putFolder(s.app, d)) === 'EXTERNAL_FOLDER_CLOUD') refused.push(name);
    }
    expect(refused.sort()).toEqual(['Boxes', 'Boxing Day', 'Box of backups', 'Megabytes', 'Megastore', 'Megan', 'Dropbox2', 'Onedrive-old', 'boxer'].sort());
    // and the owner's own USB drive label is not part of the path, so "E:\\" itself is never refused by this rule
    expect((await putFolder(s.app, env.newDir('viman-usb19-'))).status).toBe(200);
  });

  it('REAL junction: a folder that is a junction INTO a cloud-named folder is refused (the real location is checked); a junction to a harmless folder is accepted', async () => {
    const s = await appWithUsb(env, false);
    const root = env.newDir();
    const cloudTarget = join(root, 'OneDrive', 'Backups');
    mkdirSync(cloudTarget, { recursive: true });
    const link = join(root, 'usb-link');
    makeJunction(link, cloudTarget);
    const r = await putFolder(s.app, link);
    expect(code(r)).toBe('EXTERNAL_FOLDER_CLOUD');
    expect(r.body.error.message).toMatch(/really located in a cloud-synced location/);
    // nested: a junction in the middle of the path
    mkdirSync(join(cloudTarget, 'deep'));
    expect(code(await putFolder(s.app, join(link, 'deep')))).toBe('EXTERNAL_FOLDER_CLOUD');
    // a harmless junction target
    const calm = join(root, 'calm');
    mkdirSync(calm);
    const link2 = join(root, 'calm-link');
    makeJunction(link2, calm);
    // OBSERVATION (found by this audit): on this Windows, creating a NEW file (open flag "wx") inside a junction fails with EEXIST,
    // so a folder reached through a junction / mount point cannot be used even when it is harmless: Save says "cannot write".
    const harmless = await putFolder(s.app, link2);
    expect(code(harmless)).toBe('EXTERNAL_FOLDER_INVALID');
    expect(harmless.body.error.message).toMatch(/cannot write to that folder/);
    expect(harmless.body.error.message).toMatch(/EEXIST/); // the raw Node text leaks into the owner's message (plainFsError has no EEXIST case)
    // junction pointing into the data folder is refused as "inside the data folder"
    const link3 = join(root, 'data-link');
    makeJunction(link3, s.ctx.backupsDir);
    const r3 = await putFolder(s.app, link3);
    expect(code(r3)).toBe('EXTERNAL_FOLDER_INVALID');
    expect(r3.body.error.message).toMatch(/inside the shop's data folder/);
  });

  it('symbolic link (needs a privilege on Windows): when it can be created it is judged by its real location too', async () => {
    const s = await appWithUsb(env, false);
    const root = env.newDir();
    const cloudTarget = join(root, 'Dropbox', 'x');
    mkdirSync(cloudTarget, { recursive: true });
    const link = join(root, 'sym');
    let created = true;
    try { symlinkSync(cloudTarget, link, 'dir'); } catch { created = false; }
    if (created) expect(code(await putFolder(s.app, link))).toBe('EXTERNAL_FOLDER_CLOUD');
    else console.log('symlink creation needs privileges here (EPERM): symbolic links NOT tested, junctions were');
    expect(typeof created).toBe('boolean');
  });

  it('OBSERVATION: a saved folder that later becomes a junction (to a cloud-named folder): nothing is copied into the cloud folder, but the owner sees the raw Node text "EEXIST ..." as the reason', async () => {
    const s = await appWithUsb(env);
    const root = env.newDir();
    const cloudTarget = join(root, 'OneDrive', 'Backups');
    mkdirSync(cloudTarget, { recursive: true });
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    makeJunction(s.usb, cloudTarget);
    const r = await copyNow(s.app);
    expect(r.body.copied).toEqual([]);
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.failed[0].name).toBe(name);
    expect(r.body.failed[0].error).toMatch(/EEXIST/); // not plain English (OBSERVATION, Low)
    expect(readdirSync(cloudTarget)).toEqual([]); // the wx-creation failed, so nothing reached the cloud-named folder
    rmSync(s.usb, { recursive: false, force: true }); // removes the junction only
    expect(existsSync(cloudTarget)).toBe(true);
  });

  it('SUBST drive letter (a real Windows mechanism that makes a folder look like a drive): a letter mapped onto a cloud-named folder', async () => {
    const root = env.newDir();
    const target = join(root, 'OneDrive', 'Backups');
    mkdirSync(target, { recursive: true });
    const letter = 'Y';
    if (existsSync(`${letter}:\\`)) { expect(true).toBe(true); return; }
    execFileSync('subst', [`${letter}:`, target]);
    let verdict = '';
    try {
      const s = await appWithUsb(env, false);
      verdict = code(await putFolder(s.app, `${letter}:\\`));
    } finally { execFileSync('subst', [`${letter}:`, '/D']); }
    expect(existsSync(`${letter}:\\`)).toBe(false);
    console.log(`SUBST drive onto a OneDrive-named folder: ${verdict}`);
    expect(['ACCEPTED', 'EXTERNAL_FOLDER_CLOUD']).toContain(verdict);
  });
});

describe('paths: data folder, long paths, unicode', () => {
  it('inside the data folder in every spelling: refused; a folder that CONTAINS the data folder or sits on the same disk is accepted (OBSERVATION)', async () => {
    const s = await appWithUsb(env, false);
    const d = s.dataDir;
    mkdirSync(join(d, 'ext'));
    const variants = [d, d.toUpperCase(), d.toLowerCase(), `${d}\\`, `${d}\\ext`, `${d}\\ext\\..\\backups`, `${d}\\backups`, d.replace(/\\/g, '/')];
    for (const v of variants) expect(code(await putFolder(s.app, v)), v).toBe('EXTERNAL_FOLDER_INVALID');
    // the parent of the data folder (shares the disk, contains the data) is accepted: no warning about the same physical disk
    expect(code(await putFolder(s.app, dirname(d)))).toBe('ACCEPTED');
  });

  it('inside the data folder through the 8.3 short name of a long folder name', async () => {
    const s = await appWithUsb(env, false);
    mkdirSync(join(s.dataDir, 'External Backups Long Name'));
    let short = '';
    try {
      short = execFileSync('cmd', ['/c', `for %I in ("${join(s.dataDir, 'External Backups Long Name')}") do @echo %~sI`], { encoding: 'utf8' }).trim();
    } catch { short = ''; }
    if (short && short !== join(s.dataDir, 'External Backups Long Name')) {
      expect(code(await putFolder(s.app, short)), short).toBe('EXTERNAL_FOLDER_INVALID');
    } else {
      console.log('8.3 short names are disabled on this volume: not testable');
      expect(true).toBe(true);
    }
  });

  it('very long paths: 280 characters work end to end (save, copy, list, status); more than 1000 characters is a 400 validation error', async () => {
    const s = await appWithUsb(env, false);
    let deep = env.newDir('viman-usb19-');
    while (deep.length < 280) deep = join(deep, 'segment-of-a-fairly-long-folder-name');
    mkdirSync(deep, { recursive: true });
    expect(deep.length).toBeGreaterThanOrEqual(280);
    const r = await putFolder(s.app, deep);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(oursIn(deep)).toEqual([name]);
    expect(sha256File(join(deep, name))).toBe(sha256File(join(s.ctx.backupsDir, name)));
    const st = await extStatus(s.app);
    expect(st.status).toBe('ok');
    expect(st.folder).toBe(deep);
    expect(st.copies.map((c: any) => c.name)).toEqual([name]);

    const huge = `C:\\${'a'.repeat(1001)}`;
    const bad = await call(s.app, 'PUT', '/backups/external', { folder: huge });
    expect(bad.status).toBe(400);
    expect((await extStatus(s.app)).folder).toBe(deep); // unchanged
    // a 990-character path that does not exist is a plain "does not exist"
    const r990 = await putFolder(s.app, `C:\\${'b'.repeat(985)}`);
    expect(r990.status).toBe(400);
  });

  it('unicode and unusual names (Sinhala, Tamil, Arabic, CJK, emoji, spaces, ampersand, parentheses, apostrophe): save, copy, restart-safe storage', async () => {
    const s = await appWithUsb(env, false);
    const root = env.newDir();
    const names = ['දත්ත උපස්ථ', 'காப்பு', 'نسخة احتياطية', '备份 データ', 'backup 😀 usb', "Bob's backups (2026) & more", '  lead', 'a b  c'];
    for (const n of names) {
      const dir = join(root, n.trim() === n ? n : n.trim());
      mkdirSync(dir, { recursive: true });
      const r = await putFolder(s.app, dir);
      expect(r.status, n).toBe(200);
      expect(r.body.folder, n).toBe(dir);
      const stored = sqlAll(s.ctx, 'SELECT external_dir FROM backup_settings WHERE id = 1')[0].external_dir;
      expect(stored, n).toBe(dir);
      const name = await distinctBackup(s);
      await externalCopyIdle(s.ctx);
      expect(oursIn(dir), n).toContain(name);
      expect(sha256File(join(dir, name)), n).toBe(sha256File(join(s.ctx.backupsDir, name)));
      expect((await extStatus(s.app)).status, n).toBe('ok');
    }
  });
});

describe('leftover temporary files and the audit trail', () => {
  it('a copy interrupted by a pulled drive (SIMULATED with the beforeRename hook) leaves a temp file; it is removed only after an hour, only our own pattern, and nothing else', async () => {
    const s = await appWithUsb(env);
    const first = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    externalHooks.beforeRename = (tmp) => { renameSync(dirname(tmp), `${dirname(tmp)}-pulled`); };
    const second = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    resetExternalHooks();
    expect(existsSync(s.usb)).toBe(false);
    expect((await extStatus(s.app)).status).toBe('drive_missing');
    renameSync(`${s.usb}-pulled`, s.usb); // plugged back in
    const leftovers = readdirSync(s.usb).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/^\.viman-copy-[0-9a-f]{12}\.tmp$/);
    expect(oursIn(s.usb)).toEqual([first]); // never a final name for the interrupted copy

    // bystanders that must survive the clean-up
    writeFileSync(join(s.usb, '.viman-copy-ZZ.tmp'), 'not hex');
    writeFileSync(join(s.usb, '.viman-write-test-aaaaaaaaaaaa.tmp'), 'probe');
    writeFileSync(join(s.usb, 'my.tmp'), 'user file');
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const n of ['.viman-copy-ZZ.tmp', '.viman-write-test-aaaaaaaaaaaa.tmp', 'my.tmp']) utimesSync(join(s.usb, n), old, old);

    // younger than an hour: kept
    let r = await runExternalCopyOnce(s.ctx, 'manual');
    expect(readdirSync(s.usb).filter((n) => /^\.viman-copy-[0-9a-f]+\.tmp$/.test(n))).toEqual(leftovers);
    expect(r.copied.map((c) => c.name)).toEqual([second]);
    // two hours later: removed
    const later = Date.now() + 2 * 3_600_000;
    externalHooks.now = () => new Date(later);
    r = await runExternalCopyOnce(s.ctx, 'manual');
    expect(readdirSync(s.usb).filter((n) => /^\.viman-copy-[0-9a-f]+\.tmp$/.test(n))).toEqual([]);
    expect(readdirSync(s.usb).filter((n) => !/^viman-/.test(n)).sort()).toEqual(['.viman-copy-ZZ.tmp', '.viman-write-test-aaaaaaaaaaaa.tmp', 'my.tmp']);
  });

  it('audit rows: set, change, clear and no-ops; invalid input is not audited; the row carries before/after folder', async () => {
    const s = await appWithUsb(env, false);
    const A = env.newDir('viman-usbA-');
    const B = env.newDir('viman-usbB-');
    await putFolder(s.app, A);
    await putFolder(s.app, A); // no-op
    await putFolder(s.app, 'relative'); // refused
    await putFolder(s.app, B);
    await call(s.app, 'PUT', '/backups/external', { folder: null });
    await call(s.app, 'PUT', '/backups/external', { folder: null }); // no-op
    const rows = sqlAll(s.ctx, "SELECT entity, entity_id, action, before_json, after_json FROM audit_logs WHERE entity = 'backup_settings' ORDER BY id");
    expect(rows.map((x) => [JSON.parse(x.before_json).folder, JSON.parse(x.after_json).folder])).toEqual([[null, A], [A, B], [B, null]]);
    expect(rows.every((x) => x.entity_id === '1' && x.action === 'update')).toBe(true);
    const api = (await get(s.app, '/audit-logs?limit=20')).body;
    if (api && Array.isArray(api.items)) expect(api.items.filter((i: any) => i.entity === 'backup_settings')).toHaveLength(3);
    expect(logAll(s.ctx)).toEqual([]); // changing the setting writes no copy-log row
  });
});
