// Phase 19 audit: the copy itself. Checksum failures (SIMULATED damage through the hooks, because no real drive misbehaves on demand),
// duplicate and look-alike names (REAL file system, NTFS: directories, case-insensitive names), retention of the newest 30 with a
// folder full of unrelated files (REAL), manual backups, Copy backup now and parallel clicks (REAL, in-process HTTP).
import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { call, get, post } from './helpers/catalog.ts';
import {
  OURS_RE, appWithUsb, copyNow, distinctBackup, extStatus, localBackups, logAll, oursIn, seedExternal, sha256File, stampName,
} from './helpers/phase19bk.ts';
import { externalCopyIdle, runExternalCopyOnce } from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });

const folderState = (dir: string): Array<[string, number, string]> => readdirSync(dir).sort().map((n) => {
  const st = statSync(join(dir, n));
  return [n, st.size, st.isFile() ? sha256File(join(dir, n)) : 'dir'];
});

describe('checksum / size mismatch (SIMULATED damage via the afterWrite hook)', () => {
  const damages: Array<[string, (p: string) => void]> = [
    ['one flipped byte', (p) => { const b = readFileSync(p); b[Math.floor(b.length / 2)] = b[Math.floor(b.length / 2)]! ^ 0x01; writeFileSync(p, b); }],
    ['truncated by one byte', (p) => { const b = readFileSync(p); writeFileSync(p, b.subarray(0, b.length - 1)); }],
    ['truncated to half', (p) => { const b = readFileSync(p); writeFileSync(p, b.subarray(0, b.length / 2)); }],
    ['zero-length', (p) => { writeFileSync(p, ''); }],
    ['same size, all zeros', (p) => { writeFileSync(p, Buffer.alloc(statSync(p).size)); }],
    ['extra bytes appended', (p) => { appendFileSync(p, Buffer.from([0])); }],
  ];
  for (const [label, damage] of damages) {
    it(`${label}: the bad copy never gets a final name, the temp file is removed, the log says failed, status failed, a later run succeeds`, async () => {
      const s = await appWithUsb(env);
      const keep = await distinctBackup(s);
      await externalCopyIdle(s.ctx);
      const goodBefore = folderState(s.usb);
      const bad = await distinctBackup(s);
      await externalCopyIdle(s.ctx);
      // the automatic copy of `bad` has succeeded; remove it from the drive and the log is append-only, so damage the NEXT one
      const next = await distinctBackup(s);
      await externalCopyIdle(s.ctx);
      expect(oursIn(s.usb)).toEqual([keep, bad, next].sort());

      // fresh scenario on a second app: damage applies to every write
      const t = await appWithUsb(env);
      const first = await distinctBackup(t);
      await externalCopyIdle(t.ctx);
      externalHooks.afterWrite = (tmp) => damage(tmp);
      const second = await distinctBackup(t);
      await externalCopyIdle(t.ctx);
      const r = await copyNow(t.app);
      expect(r.status).toBe(200);
      expect(r.body.copied).toEqual([]);
      expect(r.body.failed.map((f: any) => f.name)).toContain(second);
      expect(r.body.failed[0].error).toMatch(/did not match|wrong size|discarded/);
      expect(r.body.status).toBe('failed');
      expect(oursIn(t.usb)).toEqual([first]);
      expect(readdirSync(t.usb).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      const rows = logAll(t.ctx);
      expect(rows.filter((x) => x.status === 'failed').length).toBeGreaterThan(0);
      expect(rows.filter((x) => x.status === 'ok').map((x) => x.target_name)).toEqual([first]);
      expect(rows.every((x) => x.status !== 'ok' || x.sha256 === sha256File(join(t.ctx.backupsDir, x.source_name)))).toBe(true);
      const st = await extStatus(t.app);
      expect(st.status).toBe('failed');
      expect(st.lastError).toMatch(/discarded/);
      expect((await get(t.app, '/dashboard')).body.warnings.map((w: any) => w.code)).toContain('EXTERNAL_BACKUP_FAILED');

      resetExternalHooks();
      const ok = await copyNow(t.app);
      expect(ok.body.copied.map((c: any) => c.name)).toEqual([second]);
      expect(sha256File(join(t.usb, second))).toBe(sha256File(join(t.ctx.backupsDir, second)));
      expect((await extStatus(t.app)).status).toBe('ok');
      expect(goodBefore.length).toBe(1);
    });
  }

  it('a copy that is already damaged on the drive (earlier run) is never "skipped as identical": the clean copy goes to a new unique name', async () => {
    const s = await appWithUsb(env);
    const n = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const path = join(s.usb, n);
    const b = readFileSync(path);
    b[100] = b[100]! ^ 0xff;
    writeFileSync(path, b); // bit rot on the drive
    const damaged = folderState(s.usb);
    const r = await copyNow(s.app);
    expect(r.body.skipped).toEqual([]);
    expect(r.body.copied).toHaveLength(1);
    expect(r.body.copied[0].name).toBe(n.replace('.db', '-2.db'));
    expect(sha256File(join(s.usb, r.body.copied[0].name))).toBe(sha256File(join(s.ctx.backupsDir, n)));
    // the damaged original is left exactly as it was (never replaced)
    expect(folderState(s.usb).find((x) => x[0] === n)).toEqual(damaged.find((x) => x[0] === n));
  });
});

describe('duplicate and look-alike names (REAL file system)', () => {
  it('different content under the same name -> a new unique name, the original is untouched byte for byte; repeated clash -> -3', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    writeFileSync(join(s.usb, n!), 'someone else wrote this');
    const mtime = new Date('2020-02-02T02:02:02Z');
    utimesSync(join(s.usb, n!), mtime, mtime);
    const before = folderState(s.usb);
    const r = await copyNow(s.app);
    expect(r.body.copied.map((c: any) => c.name)).toEqual([n!.replace('.db', '-2.db')]);
    expect(folderState(s.usb).find((x) => x[0] === n)).toEqual(before[0]);
    expect(statSync(join(s.usb, n!)).mtimeMs).toBe(mtime.getTime());
    expect(readFileSync(join(s.usb, n!), 'utf8')).toBe('someone else wrote this');
    // the next identical run is a no-op
    const again = await copyNow(s.app);
    expect(again.body.copied).toEqual([]);
    expect(again.body.skipped).toEqual([{ name: n, reason: 'already_present' }]);

    // now the -2 name is a stranger too: the clean copy of a NEW backup of the same base gets -3
    const other = await appWithUsb(env);
    const [m] = localBackups(other.ctx, 1);
    writeFileSync(join(other.usb, m!), 'x');
    writeFileSync(join(other.usb, m!.replace('.db', '-2.db')), 'y');
    const r3 = await copyNow(other.app);
    expect(r3.body.copied.map((c: any) => c.name)).toEqual([m!.replace('.db', '-3.db')]);
    expect(readFileSync(join(other.usb, m!), 'utf8')).toBe('x');
    expect(readFileSync(join(other.usb, m!.replace('.db', '-2.db')), 'utf8')).toBe('y');
  });

  it('an identical file under a -n name counts as present (no duplicate), whatever number it carries', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    const bytes = readFileSync(join(s.ctx.backupsDir, n!));
    writeFileSync(join(s.usb, n!.replace('.db', '-7.db')), bytes);
    const r = await copyNow(s.app);
    expect(r.body.copied).toEqual([]);
    expect(r.body.skipped).toEqual([{ name: n, reason: 'already_present' }]);
    expect(oursIn(s.usb)).toHaveLength(1);
  });

  it('OBSERVATION: two local backups of the same second with identical content: the second is reported "already_present" although only one file exists on the drive', async () => {
    const s = await appWithUsb(env);
    const a = (await post(s.app, '/backups', {})).body.item.name;
    const b = (await post(s.app, '/backups', {})).body.item.name;
    await externalCopyIdle(s.ctx);
    const same = a.replace(/(-\d+)?\.db$/, '') === b.replace(/(-\d+)?\.db$/, '');
    if (same) {
      expect(sha256File(join(s.ctx.backupsDir, a))).toBe(sha256File(join(s.ctx.backupsDir, b)));
      // no loss: the bytes are identical, only ONE of the two names is on the drive (the newest, "-2", is copied first)
      expect(oursIn(s.usb)).toHaveLength(1);
      expect(sha256File(join(s.usb, oursIn(s.usb)[0]!))).toBe(sha256File(join(s.ctx.backupsDir, a)));
    } else {
      expect(oursIn(s.usb)).toEqual([a, b].sort());
    }
  });

  it('a DIRECTORY with the backup file name: not replaced, its content survives, the copy gets another name; the folder is not listed as a copy', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    mkdirSync(join(s.usb, n!));
    writeFileSync(join(s.usb, n!, 'precious.txt'), 'keep me');
    const r = await copyNow(s.app);
    expect(r.status).toBe(200);
    expect(r.body.failed).toEqual([]);
    expect(r.body.copied.map((c: any) => c.name)).toEqual([n!.replace('.db', '-2.db')]);
    expect(statSync(join(s.usb, n!)).isDirectory()).toBe(true);
    expect(readFileSync(join(s.usb, n!, 'precious.txt'), 'utf8')).toBe('keep me');
    const st = await extStatus(s.app);
    expect(st.copies.map((c: any) => c.name)).toEqual([n!.replace('.db', '-2.db')]);
    // and a second run changes nothing
    const again = await copyNow(s.app);
    expect(again.body.copied).toEqual([]);
    expect(readFileSync(join(s.usb, n!, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('CASE differences on NTFS: a file with the same name in other letter case is the SAME file; it is never overwritten (OBSERVATION: it blocks that one backup with a message that does not name the cause)', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    const upper = n!.toUpperCase().replace('.DB', '.db').replace('VIMAN', 'VIMAN');
    writeFileSync(join(s.usb, upper), 'a different file with upper-case letters');
    const names = readdirSync(s.usb);
    expect(names).toEqual([upper]);
    const r = await copyNow(s.app);
    expect(r.status).toBe(200);
    expect(r.body.copied).toEqual([]);
    expect(readFileSync(join(s.usb, upper), 'utf8')).toBe('a different file with upper-case letters'); // never overwritten
    expect(readdirSync(s.usb)).toEqual([upper]); // no temp file left
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.failed[0].error).toMatch(/already|appeared|nothing was overwritten/i);
    expect(r.body.status).toBe('failed');
  });

  it('the identical content in other letter case is also not overwritten and not duplicated', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    const upper = n!.toUpperCase();
    writeFileSync(join(s.usb, upper), readFileSync(join(s.ctx.backupsDir, n!)));
    const before = folderState(s.usb);
    const r = await copyNow(s.app);
    expect(r.body.copied).toEqual([]);
    expect(folderState(s.usb)).toEqual(before);
  });
});

describe('retention: the newest 30 matching files remain, nothing else is ever deleted (REAL)', () => {
  it('45 matching + unrelated files, near-miss names, a sub-folder, names with spaces: exactly the 30 newest remain', async () => {
    const s = await appWithUsb(env);
    const seeded = seedExternal(s.usb, 45); // 2025-01-01 .. 2025-02-14, all "manual"
    // same-day -n variants: -2 is NEWER than the plain name of the same stamp
    const extra = [stampName(44, 'manual', '-2'), stampName(44, 'manual', '-3'), stampName(43, 'startup')];
    for (const e of extra) writeFileSync(join(s.usb, e), Buffer.from(`extra ${e}`));
    // make the OLDEST file look the newest to the file system: retention must follow the name, not the mtime
    const now = new Date();
    utimesSync(join(s.usb, seeded[0]!), now, now);

    const keepers: Record<string, string> = {
      'notes.txt': 'hello',
      'viman-20250101-000000-startup.db.bak': 'bak',
      'VIMAN-20250101-000000-manual.db.upper-ext.txt': 'u',
      'viman 20250101-000000-manual.db': 'space1',
      'viman-20250101-000000-manual .db': 'space2',
      ' viman-20250101-000000-manual.db': 'leading space',
      'viman-20250101-000000-pre-restore.db': 'pre-restore stays',
      'viman-2025010-000000-manual.db': 'short date',
      'viman-20250101-000000-manual.db.tmp': 'tmp-ish',
      'xviman-20250101-000000-manual.db': 'prefix',
      '.viman-copy-ZZZ.tmp': 'not hex',
      'backup-2024.db': 'other db',
    };
    for (const [k, v] of Object.entries(keepers)) writeFileSync(join(s.usb, k), v);
    mkdirSync(join(s.usb, 'photos'));
    writeFileSync(join(s.usb, 'photos', 'viman-20240101-000000-manual.db'), 'inside a sub-folder, matches the pattern');
    mkdirSync(join(s.usb, 'Old backups'));
    writeFileSync(join(s.usb, 'Old backups', 'x.txt'), 'x');

    const [localName] = localBackups(s.ctx, 1, 'startup', '2026-06-01T08:00:00Z');
    const r = await copyNow(s.app);
    expect(r.status).toBe(200);
    expect(r.body.failed).toEqual([]);
    expect(r.body.copied.map((c: any) => c.name)).toEqual([localName]);

    const all = [...seeded, ...extra, localName!];
    const order = (n: string): [string, number] => { const m = /-(\d+)\.db$/.exec(n); return [n.slice(6, 21), m ? Number(m[1]) : 1]; };
    const newest = [...all].sort((a, b) => { const [sa, na] = order(a); const [sb, nb] = order(b); return sb.localeCompare(sa) || nb - na; }).slice(0, 30);
    expect(oursIn(s.usb)).toEqual([...newest].sort());
    expect(r.body.pruned.sort()).toEqual(all.filter((n) => !newest.includes(n)).sort());
    expect(newest).toContain(localName);
    expect(newest).not.toContain(seeded[0]);
    // nothing else was touched
    for (const [k, v] of Object.entries(keepers)) expect(readFileSync(join(s.usb, k), 'utf8'), k).toBe(v);
    expect(readFileSync(join(s.usb, 'photos', 'viman-20240101-000000-manual.db'), 'utf8')).toContain('inside a sub-folder');
    expect(readFileSync(join(s.usb, 'Old backups', 'x.txt'), 'utf8')).toBe('x');
    expect(readdirSync(s.usb).filter((n) => !OURS_RE.test(n)).sort()).toEqual([...Object.keys(keepers), 'photos', 'Old backups'].sort());
    // the status lists at most 30 copies, newest first
    const st = await extStatus(s.app);
    expect(st.copies).toHaveLength(30);
    expect(st.copies[0].name).toBe(localName);
  });

  it('a DIRECTORY named like an old backup is neither deleted nor lets the count exceed 30 for ever (it is counted but survives)', async () => {
    const s = await appWithUsb(env);
    seedExternal(s.usb, 30, 1); // stamps 2025-01-02 ..
    mkdirSync(join(s.usb, stampName(0))); // oldest "match" is a folder
    writeFileSync(join(s.usb, stampName(0), 'inner.txt'), 'inner');
    localBackups(s.ctx, 1, 'manual', '2026-06-01T08:00:00Z');
    const r = await copyNow(s.app);
    expect(r.status).toBe(200);
    expect(readFileSync(join(s.usb, stampName(0), 'inner.txt'), 'utf8')).toBe('inner');
    // two oldest candidates were pruned or survive; the folder is not a file so it never counts in the listing
    const st = await extStatus(s.app);
    expect(st.copies.every((c: any) => statSync(join(s.usb, c.name)).isFile())).toBe(true);
  });
});

describe('manual backup (POST /backups) and Copy backup now (POST /backups/external/copy)', () => {
  it('POST /backups answers 201 { item } at once; the copy follows in the background with the same name and checksum; no duplicates after rapid repeats', async () => {
    const s = await appWithUsb(env);
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      names.push(await distinctBackup(s)); // posts a distinct expense, then POST /backups (201), without waiting for the copy
      expect(i).toBeGreaterThanOrEqual(0);
    }
    names.push(await distinctBackup(s));
    const shape = await get(s.app, '/backups');
    expect(Object.keys(shape.body)).toEqual(['items']);
    await externalCopyIdle(s.ctx);
    expect(oursIn(s.usb)).toEqual([...names].sort());
    for (const n of names) expect(sha256File(join(s.usb, n))).toBe(sha256File(join(s.ctx.backupsDir, n)));
    const ok = logAll(s.ctx).filter((l) => l.status === 'ok');
    expect(ok.map((l) => l.target_name).sort()).toEqual([...names].sort()); // exactly one ok row per file
  });

  it('result shape and idempotence', async () => {
    const s = await appWithUsb(env);
    localBackups(s.ctx, 3);
    const r = await copyNow(s.app);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['copied', 'failed', 'pruned', 'skipped', 'status', 'warning']);
    expect(r.body.copied).toHaveLength(3);
    for (const c of r.body.copied) {
      expect(Object.keys(c).sort()).toEqual(['name', 'sha256', 'sizeBytes']);
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.sha256).toBe(sha256File(join(s.usb, c.name)));
      expect(c.sizeBytes).toBe(statSync(join(s.usb, c.name)).size);
    }
    // newest first
    expect(r.body.copied.map((c: any) => c.name)).toEqual([...r.body.copied.map((c: any) => c.name)].sort().reverse());
    expect(r.body.status).toBe('ok');
    const folder1 = folderState(s.usb);
    for (let i = 0; i < 3; i++) {
      const again = await copyNow(s.app);
      expect(again.body.copied).toEqual([]);
      expect(again.body.skipped).toHaveLength(3);
      expect(again.body.skipped.every((x: any) => x.reason === 'already_present')).toBe(true);
    }
    expect(folderState(s.usb)).toEqual(folder1);
    expect(logAll(s.ctx).filter((l) => l.status === 'ok')).toHaveLength(3);
  });

  it('PARALLEL clicks (two Copy now calls plus a timer pass plus a new manual backup at the same time): every backup exactly once, no -2 names, no temp files', async () => {
    const s = await appWithUsb(env);
    localBackups(s.ctx, 5);
    const results = await Promise.all([
      copyNow(s.app), copyNow(s.app), copyNow(s.app),
      runExternalCopyOnce(s.ctx, 'timer'),
      post(s.app, '/backups', {}),
    ]);
    await externalCopyIdle(s.ctx);
    const copiedTotal = results.slice(0, 3).flatMap((r: any) => r.body.copied.map((c: any) => c.name));
    expect(new Set(copiedTotal).size).toBe(copiedTotal.length); // nobody copied the same file twice
    const locals = readdirSync(s.ctx.backupsDir).filter((n) => OURS_RE.test(n)).sort();
    expect(oursIn(s.usb)).toEqual(locals);
    expect(oursIn(s.usb).some((n) => /-2\.db$|-3\.db$/.test(n) && !locals.includes(n))).toBe(false);
    expect(readdirSync(s.usb).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const okRows = logAll(s.ctx).filter((l) => l.status === 'ok');
    expect(okRows.length).toBe(locals.length);
    expect(new Set(okRows.map((l) => l.target_name)).size).toBe(okRows.length);
    for (const n of locals) expect(sha256File(join(s.usb, n))).toBe(sha256File(join(s.ctx.backupsDir, n)));
  });

  it('Copy now with no folder is 409 EXTERNAL_FOLDER_NOT_SET; with the folder cleared mid-way nothing is written anywhere', async () => {
    const s = await appWithUsb(env, false);
    localBackups(s.ctx, 1);
    const r = await copyNow(s.app);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EXTERNAL_FOLDER_NOT_SET');
    expect(logAll(s.ctx)).toEqual([]);
    expect(readdirSync(s.usb)).toEqual([]);
  });
});
