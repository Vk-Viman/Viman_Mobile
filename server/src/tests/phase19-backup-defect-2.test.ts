// DEFECT 2 (Medium - misleading status; the owner cannot clear the warning the system tells them to clear). EXPECTED RED until fixed.
// The stale warning says: 'Check that the drive is connected, then use "Copy backup now"'. But "successful copy" is only recorded when a
// NEW file is written. If the shop PC has run for 7+ days without a new start-up/manual backup, every backup is already on the drive
// and verified; "Copy backup now" then answers skipped/already_present for everything and the status STAYS stale ("no backup copied for
// N days") although the drive is complete and healthy. Same effect right after restoring an older backup (its log is old, nothing new to copy).
// Expected (owner's view): a pass that finds every eligible backup verified on the drive counts as a successful check.
import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { appWithUsb, copyNow, distinctBackup, extStatus, oursIn } from './helpers/phase19bk.ts';
import { externalCopyIdle } from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';
import { post } from './helpers/catalog.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });
const DAY = 86_400_000;

describe('defect 2: "Copy backup now" with everything already on the drive must clear a stale warning', () => {
  it('8 days after the last new copy, with a healthy drive holding every backup: Copy now leaves the status stale', async () => {
    const t0 = Date.now() - 8 * DAY;
    externalHooks.now = () => new Date(t0);
    const s = await appWithUsb(env);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    externalHooks.now = () => new Date(t0 + 8 * DAY); // eight days later, the PC ran all the time and no new backup was made
    expect((await extStatus(s.app)).status).toBe('stale');
    const r = await copyNow(s.app);
    expect(r.body.failed).toEqual([]);
    expect(r.body.skipped).toEqual([{ name, reason: 'already_present' }]); // everything is present and verified
    expect(oursIn(s.usb)).toEqual([name]);
    expect((await extStatus(s.app)).status).toBe('ok'); // EXPECTED; currently still "stale"
  });

  it('a manual backup + copy is the only way out today: the same stale state disappears only after a NEW file is written', async () => {
    const t0 = Date.now() - 8 * DAY;
    externalHooks.now = () => new Date(t0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    externalHooks.now = () => new Date(t0 + 8 * DAY);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect((await extStatus(s.app)).status).toBe('ok'); // documents the workaround (passes)
    expect((await post(s.app, '/backups', {})).status).toBe(201);
  });
});
