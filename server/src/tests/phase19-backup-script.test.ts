// Phase 19 audit: the read-only verification script scripts/verify-external-backup.mjs, run as a REAL child process against
// real temp folders (real SQLite backups made by the app, real file corruption, a real HTTP server for the status check).
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { SCRIPT, allowWrite, appWithUsb, copyNow, denyWrite, localBackups, oursIn, runScript, stampName } from './helpers/phase19bk.ts';
import { externalCopyIdle } from '../services/external-backup.service.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

/** Everything observable about a folder: names, sizes, modification times. Used to prove the script changed nothing. */
const fingerprint = (dir: string): string => JSON.stringify(readdirSync(dir).sort().map((n) => {
  const st = statSync(join(dir, n));
  return [n, st.size, st.mtimeMs, st.isDirectory()];
}));

/** An app whose 3 local backups were really copied to the "USB" folder. */
async function goodDrive() {
  const s = await appWithUsb(env);
  const names = localBackups(s.ctx, 3);
  const r = await copyNow(s.app);
  expect(r.body.copied.map((c: any) => c.name).sort()).toEqual([...names].sort());
  return { ...s, names };
}
const verify = (s: { usb: string; dataDir: string }, extra: string[] = []) => runScript([s.usb, '--data', s.dataDir, '--port', '1', ...extra]);

describe('verify-external-backup.mjs', () => {
  it('passes on a healthy drive, prints per-file checksum/integrity and changes nothing (also when the folder is write-protected by an ACL)', async () => {
    const s = await goodDrive();
    const before = fingerprint(s.usb);
    const r = verify(s);
    expect(r.out).toContain('RESULT: all checks passed');
    expect(r.code).toBe(0);
    for (const n of s.names) expect(r.out).toMatch(new RegExp(`${n}.*matches the local copy.*integrity: ok`));
    expect(r.out).toMatch(/3 backup file\(s\)/);
    expect(r.out).toMatch(/server is not reachable/);
    expect(fingerprint(s.usb)).toBe(before);

    // REAL read-only folder (NTFS deny ACE): a read-only tool must still work and still leave the folder untouched.
    denyWrite(s.usb);
    try {
      const r2 = verify(s);
      expect(r2.code, r2.out).toBe(0);
    } finally { allowWrite(s.usb); }
    expect(fingerprint(s.usb)).toBe(before);
    expect(fingerprint(join(s.dataDir, 'backups'))).toBeTruthy();
  });

  it('exit 1 for a checksum mismatch (flipped byte) and names the file', async () => {
    const s = await goodDrive();
    const victim = join(s.usb, s.names[1]!);
    const bytes = readFileSync(victim);
    bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 0xff;
    writeFileSync(victim, bytes);
    const r = verify(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`FAIL.*${s.names[1]}.*DIFFERS from the local copy`));
    expect(r.out).toContain('FAILED');
  });

  it('exit 1 for a truncated file, a zero-length file and a file that is not a database', async () => {
    const s = await goodDrive();
    truncateSync(join(s.usb, s.names[0]!), 1500);
    writeFileSync(join(s.usb, s.names[1]!), '');
    writeFileSync(join(s.usb, s.names[2]!), 'this is not sqlite '.repeat(200));
    const r = verify(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`FAIL.*${s.names[1]}.*empty`));
    expect(r.out).toMatch(new RegExp(`FAIL.*${s.names[2]}.*(cannot be opened|integrity)`));
    expect(r.out).toMatch(new RegExp(`FAIL.*${s.names[0]}`));
  });

  it('a local copy that is missing is only informational; a file with the right content but no local twin passes', async () => {
    const s = await goodDrive();
    const r0 = join(s.dataDir, 'backups', s.names[0]!);
    // remove the local twin through the file system (the audit owns this temp dir)
    const { rmSync } = await import('node:fs');
    rmSync(r0);
    const r = verify(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`INFO.*${s.names[0]}.*local copy missing`));
  });

  it('leftover temp files fail; foreign files, sub-folders and look-alike names only warn, and are reported', async () => {
    const s = await goodDrive();
    writeFileSync(join(s.usb, '.viman-copy-abc123.tmp'), 'partial');
    let r = verify(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL.*leftover temporary file \.viman-copy-abc123\.tmp/);
    const { rmSync } = await import('node:fs');
    rmSync(join(s.usb, '.viman-copy-abc123.tmp'));

    writeFileSync(join(s.usb, 'notes.txt'), 'hello');
    mkdirSync(join(s.usb, 'photos'));
    writeFileSync(join(s.usb, 'viman-20260101-000000-startup.db.bak'), 'x');
    writeFileSync(join(s.usb, 'VIMAN-20260101-000000-startup.db'), 'x');
    writeFileSync(join(s.usb, 'viman 20260101-000000-manual.db'), 'x');
    writeFileSync(join(s.usb, 'viman-20260101-000000-pre-restore.db'), 'x');
    r = verify(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/WARN.*"notes.txt" is not one of the system's backup files/);
    expect(r.out).toMatch(/WARN.*folder "photos"/);
    for (const n of ['viman-20260101-000000-startup.db.bak', 'VIMAN-20260101-000000-startup.db', 'viman 20260101-000000-manual.db', 'viman-20260101-000000-pre-restore.db']) {
      expect(r.out, n).toContain(`"${n}" looks like a backup but does not match the naming pattern`);
    }
  });

  it('retention: 30 files pass, 31 fail; an empty folder fails', async () => {
    const s = await appWithUsb(env);
    const real = localBackups(s.ctx, 1)[0]!;
    const bytes = readFileSync(join(s.dataDir, 'backups', real));
    for (let i = 0; i < 30; i++) writeFileSync(join(s.usb, stampName(i)), bytes);
    let r = verify(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/30 backup file\(s\) \(limit 30\)/);
    writeFileSync(join(s.usb, stampName(30)), bytes);
    r = verify(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/31 backup files found: more than the 30/);
    const empty = env.newDir('viman-usb19-');
    r = runScript([empty, '--data', s.dataDir, '--port', '1']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no backup files/);
  });

  it('missing folder, a file instead of a folder and bad usage', async () => {
    const s = await goodDrive();
    let r = runScript([join(s.usb, 'nope'), '--data', s.dataDir, '--port', '1']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL.*cannot be read.*plugged in/);
    const f = join(s.usb, 'afile.txt');
    writeFileSync(f, 'x');
    r = runScript([f, '--data', s.dataDir, '--port', '1']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a folder/);
    expect(runScript([]).code).toBe(2);
    expect(runScript([s.usb, '--bogus']).code).toBe(2);
    expect(runScript([s.usb, '--port', 'abc']).code).toBe(2);
    expect(runScript([s.usb, 'second-folder']).code).toBe(2);
  });

  it('with the server running it prints GET /backups/external; status ok passes, a failed status fails the check', async () => {
    const s = await goodDrive();
    await externalCopyIdle(s.ctx);
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (s.app.server.address() as { port: number }).port;
    const run = (): Promise<{ code: number; out: string }> => new Promise((resolveRun) => {
      execFile(process.execPath, [SCRIPT, s.usb, '--data', s.dataDir, '--port', String(port)], { encoding: 'utf8' }, (err, stdout, stderr) => {
        resolveRun({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: `${stdout}${stderr}` });
      });
    });
    let r = await run();
    expect(r.out).toMatch(/Server status: ok/);
    expect(r.out).toMatch(/server reports the external backup status "ok"/);
    expect(r.code, r.out).toBe(0);

    // a real failure the owner would care about: the server is configured with another folder that does not exist
    s.ctx.database.conn.prepare('UPDATE backup_settings SET external_dir = ? WHERE id = 1').run(join(s.usb, 'gone'));
    r = await run();
    expect(r.out).toMatch(/Server status: drive_missing/);
    expect(r.out).toMatch(/not to the folder checked here/);
    expect(r.code).toBe(1);
  });

  it('a file that is only an older copy (duplicate name with -2 suffix and different bytes) is checked like any other', async () => {
    const s = await goodDrive();
    const base = s.names[0]!;
    const dup = base.replace('.db', '-2.db');
    copyFileSync(join(s.usb, base), join(s.usb, dup));
    appendFileSync(join(s.usb, dup), Buffer.alloc(16)); // different bytes, a different size: no local twin by that name
    const r = verify(s);
    expect(r.out).toContain(dup);
    expect(r.code === 0 || r.code === 1).toBe(true);
    expect(r.out).toMatch(new RegExp(`${dup}.*local copy missing`));
  });
});
