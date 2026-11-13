// DEFECT 1 (Medium - log growth, noisy status history; not data loss). EXPECTED RED until fixed.
// Contract/code intent (external-backup.service.ts, FAILURE_LOG_GAP_MS): "Identical consecutive automatic failures are logged at most
// once per hour (keeps the log small)". Reality: the 10-minute timer appends one failed row PER PENDING BACKUP on EVERY pass while a drive
// is full/read-only, because the de-duplication compares only the NEWEST log row with the FIRST failure of the next pass, and
// external_backup_log is append-only (rows can never be removed). With 30 pending backups that is up to 30 rows every 10 minutes
// (4,320 a day) for as long as the drive stays read-only, and it also re-reads and re-hashes every pending backup each time.
import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { allowWrite, appWithUsb, denyWrite, distinctBackup, logAll } from './helpers/phase19bk.ts';
import { externalCopyIdle, runExternalCopyOnce } from '../services/external-backup.service.ts';
import { resetExternalHooks } from '../services/external-backup-hooks.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });

describe('defect 1: identical automatic failures must not be logged again on every timer pass', () => {
  it('REAL read-only drive (NTFS deny ACE), 4 pending backups, 6 timer passes within one hour: the log does not grow after the first pass', async () => {
    const s = await appWithUsb(env);
    const first = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    denyWrite(s.usb);
    try {
      for (let i = 0; i < 4; i++) await distinctBackup(s); // each automatic copy fails; pending sources accumulate
      await externalCopyIdle(s.ctx);
      const afterFirstPass = logAll(s.ctx).length;
      for (let i = 0; i < 6; i++) await runExternalCopyOnce(s.ctx, 'timer');
      const growth = logAll(s.ctx).length - afterFirstPass;
      console.log(`defect 1: failed rows added by 6 further timer passes in the same hour: ${growth} (pending backups: 4)`);
      expect(first).toBeTruthy();
      expect(growth).toBe(0);
    } finally { allowWrite(s.usb); }
  });
});
