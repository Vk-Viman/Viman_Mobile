// DEFECT 3 (Low - one backup is never copied; no data loss; the existing file is correctly NOT overwritten). EXPECTED RED until fixed.
// On Windows file names are case-insensitive, but the copy logic compares names case-sensitively (EXTERNAL_NAME_RE, Set.has). A file that
// already exists on the drive under the same name in other letter case (for example after a copy through a tool that upper-cases names, or a
// manual rename) is invisible to the "is it already there / pick a unique name" step. The final name then collides on disk and the copy
// fails with "A file with that name appeared while copying" on EVERY run, so that backup never reaches the drive and the status is "failed".
// Expected: identical content -> skipped (already present); different content -> written under a new unique name; never "failed".
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { appWithUsb, copyNow, localBackups, extStatus } from './helpers/phase19bk.ts';
import { resetExternalHooks } from '../services/external-backup-hooks.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });

describe('defect 3: a same-named file in another letter case must not make the copy fail for ever', () => {
  it('different content under an UPPER-CASE spelling: the backup must still get onto the drive (new unique name), the existing file untouched', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    const upper = n!.toUpperCase();
    writeFileSync(join(s.usb, upper), 'an older, different file');
    const r = await copyNow(s.app);
    expect(r.body.failed).toEqual([]);
    expect(r.body.copied).toHaveLength(1);
    expect(readFileSync(join(s.usb, upper), 'utf8')).toBe('an older, different file');
    expect((await extStatus(s.app)).status).toBe('ok');
  });

  it('identical content under an UPPER-CASE spelling: reported as already present, not as a failure', async () => {
    const s = await appWithUsb(env);
    const [n] = localBackups(s.ctx, 1);
    writeFileSync(join(s.usb, n!.toUpperCase()), readFileSync(join(s.ctx.backupsDir, n!)));
    const r = await copyNow(s.app);
    expect(r.body.failed).toEqual([]);
    expect(r.body.skipped).toEqual([{ name: n, reason: 'already_present' }]);
    expect((await extStatus(s.app)).status).toBe('ok');
  });
});
