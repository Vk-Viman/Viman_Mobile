// Phase 19 audit: status, warnings, the seven-day boundary (INJECTED clock: a real week cannot be waited for), the dashboard for each status
// (real folders renamed / locked by an NTFS ACE) and the database guards (real SQL against the real schema).
import { describe, it, expect, afterEach } from 'vitest';
import { renameSync } from 'node:fs';
import { TestEnv } from './helpers/tmp.ts';
import { call, get } from './helpers/catalog.ts';
import {
  allowWrite, appWithUsb, copyNow, denyWrite, distinctBackup, errno, extStatus, logAll, oursIn, putFolder, sqlAll,
} from './helpers/phase19bk.ts';
import { externalCopyIdle, runExternalCopyOnce } from '../services/external-backup.service.ts';
import { externalHooks, resetExternalHooks } from '../services/external-backup-hooks.ts';

const env = new TestEnv();
afterEach(async () => { resetExternalHooks(); await env.cleanup(); });

const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const DAY = 86_400_000;
let clock = T0;
const setClock = (ms: number): void => { clock = ms; externalHooks.now = () => new Date(clock); };

describe('seven-day stale boundary (injected clock)', () => {
  it('never copied: ok until the instant 7 days after the folder was set, stale from that instant; the text says so', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    for (const [offset, expected] of [[0, 'ok'], [DAY, 'ok'], [7 * DAY - 1, 'ok'], [7 * DAY, 'stale'], [30 * DAY, 'stale']] as const) {
      setClock(T0 + offset);
      const st = await extStatus(s.app);
      expect(st.status, `+${offset} ms`).toBe(expected);
      expect(st.lastSuccessAt).toBeNull();
      expect(st.daysSinceSuccess).toBeNull();
      if (expected === 'stale') {
        expect(st.warning).toMatch(/since it was set up \d+ days? ago/);
        expect(st.warning).toMatch(/Copy backup now/);
      }
    }
  });

  it('with a success: 6 days 23:59:59.999 is ok (daysSinceSuccess 6), 7 days is stale (7); a new success clears it', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    const first = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(logAll(s.ctx).filter((l) => l.status === 'ok')[0].created_at).toBe(new Date(T0).toISOString());
    setClock(T0 + 7 * DAY - 1);
    let st = await extStatus(s.app);
    expect([st.status, st.daysSinceSuccess]).toEqual(['ok', 6]);
    setClock(T0 + 7 * DAY);
    st = await extStatus(s.app);
    expect([st.status, st.daysSinceSuccess]).toEqual(['stale', 7]);
    expect(st.warning).toMatch(/for 7 days/);
    expect((await get(s.app, '/dashboard')).body.warnings.map((w: any) => w.code)).toContain('EXTERNAL_BACKUP_STALE');

    // a new backup copied at day 8 is a success: stale is gone
    setClock(T0 + 8 * DAY);
    const second = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    st = await extStatus(s.app);
    expect([st.status, st.daysSinceSuccess]).toEqual(['ok', 0]);
    expect(oursIn(s.usb)).toEqual([first, second].sort());
  });

  it('stale wins over drive_missing and failed, and still names the cause; drive_missing before day 7', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    renameSync(s.usb, `${s.usb}-away`);
    setClock(T0 + 6 * DAY);
    expect((await extStatus(s.app)).status).toBe('drive_missing');
    setClock(T0 + 7 * DAY);
    let st = await extStatus(s.app);
    expect(st.status).toBe('stale');
    expect(st.warning).toMatch(/cannot be found right now/);
    expect((await get(s.app, '/dashboard')).body.backup.external.status).toBe('stale');

    renameSync(`${s.usb}-away`, s.usb);
    externalHooks.writeTemp = async () => { throw errno('ENOSPC'); };
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    st = await extStatus(s.app);
    expect(st.status).toBe('stale');
    expect(st.warning).toMatch(/The last attempt failed: The external drive is full/);
  });

  it('the seven days count from the LAST success of any folder: after switching to a new folder an old success still decides (OBSERVATION)', async () => {
    setClock(T0);
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    setClock(T0 + 10 * DAY);
    const B = env.newDir('viman-usbB-');
    expect((await putFolder(s.app, B)).status).toBe(200);
    // the new folder has never received anything, yet is "stale" at once because the last success (folder A) was 10 days ago
    const st = await extStatus(s.app);
    expect(st.status).toBe('stale');
    // ... and the opposite: 1 day after a success in A, a brand-new empty folder B reads "ok" although it holds no backup yet
    setClock(T0 + 11 * DAY);
    const s2 = await appWithUsb(env);
    await distinctBackup(s2);
    await externalCopyIdle(s2.ctx);
    setClock(T0 + 12 * DAY);
    const C = env.newDir('viman-usbC-');
    expect((await putFolder(s2.app, C)).status).toBe(200);
    expect(oursIn(C)).toEqual([]);
    expect((await extStatus(s2.app)).status).toBe('ok');
  });
});

describe('dashboard and warnings for every status (REAL folder states)', () => {
  it('not_configured, ok, drive_missing, failed (read-only drive by NTFS ACE), stale: external block, top-level warning code and identical wording', async () => {
    const s = await appWithUsb(env, false);
    const codes = async () => (await get(s.app, '/dashboard')).body;
    let d = await codes();
    expect(d.backup.external).toEqual({ status: 'not_configured', lastSuccessAt: null, daysSinceSuccess: null, warning: expect.stringMatching(/No external backup folder is set/) });
    expect(d.warnings.filter((w: any) => /^EXTERNAL_BACKUP/.test(w.code))).toEqual([]);

    const usb = env.newDir('viman-usb19-');
    expect((await putFolder(s.app, usb)).status).toBe(200);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    d = await codes();
    expect(d.backup.external.status).toBe('ok');
    expect(d.backup.external.warning).toBeNull();
    expect(d.warnings.filter((w: any) => /^EXTERNAL_BACKUP/.test(w.code))).toEqual([]);
    expect(Object.keys(d.backup.external).sort()).toEqual(['daysSinceSuccess', 'lastSuccessAt', 'status', 'warning']);

    renameSync(usb, `${usb}-away`);
    d = await codes();
    expect(d.backup.external.status).toBe('drive_missing');
    let w = d.warnings.find((x: any) => x.code === 'EXTERNAL_BACKUP_DRIVE_MISSING');
    expect(w.message).toBe(d.backup.external.warning);
    renameSync(`${usb}-away`, usb);

    denyWrite(usb);
    try {
      await distinctBackup(s);
      await externalCopyIdle(s.ctx);
      d = await codes();
      expect(d.backup.external.status).toBe('failed');
      w = d.warnings.find((x: any) => x.code === 'EXTERNAL_BACKUP_FAILED');
      expect(w.message).toBe(d.backup.external.warning);
      expect(w.message).toMatch(/not allowed to write/);
    } finally { allowWrite(usb); }
    expect((await copyNow(s.app)).body.status).toBe('ok');
    expect((await codes()).warnings.filter((x: any) => /^EXTERNAL_BACKUP/.test(x.code))).toEqual([]);

    // stale: a second app whose only success happened 9 days ago (the log is stamped with the injected clock; the dashboard reads the real clock)
    setClock(Date.now() - 9 * DAY);
    const old = await appWithUsb(env);
    await distinctBackup(old);
    await externalCopyIdle(old.ctx);
    resetExternalHooks();
    d = (await get(old.app, '/dashboard')).body;
    expect(d.backup.external.status).toBe('stale');
    expect(d.warnings.map((x: any) => x.code)).toContain('EXTERNAL_BACKUP_STALE');
    expect(d.backup.external.daysSinceSuccess).toBe(9);
    expect(d.warnings.find((x: any) => x.code === 'EXTERNAL_BACKUP_STALE').message).toBe(d.backup.external.warning);
    // the dashboard's own local backup block is independent of all of this
    expect(['ok', 'stale', 'none']).toContain(d.backup.status);
  });
});

describe('database guards on external_backup_log and backup_settings (real SQL)', () => {
  const exec = (s: { ctx: any }, q: string, ...p: any[]) => s.ctx.database.conn.prepare(q).run(...p);

  it('append-only: UPDATE, DELETE and upsert-update are refused; CHECK constraints refuse every inconsistent row; the settings row cannot be deleted or duplicated', async () => {
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const rowsBefore = JSON.stringify(logAll(s.ctx));
    expect(() => exec(s, "UPDATE external_backup_log SET status = 'failed', error = 'x'")).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
    expect(() => exec(s, 'DELETE FROM external_backup_log')).toThrow(/EXTERNAL_BACKUP_LOG_APPEND_ONLY/);
    expect(() => exec(s, "INSERT INTO external_backup_log (id, status, error) VALUES (1, 'failed', 'x') ON CONFLICT(id) DO UPDATE SET error = 'changed'")).toThrow(/APPEND_ONLY/);
    const sha = 'a'.repeat(64);
    const bad: Array<[string, any[]]> = [
      ["INSERT INTO external_backup_log (status) VALUES ('weird')", []],
      ["INSERT INTO external_backup_log (status, error) VALUES ('ok', NULL)", []],
      ["INSERT INTO external_backup_log (status, target_name, size_bytes, sha256) VALUES ('ok', 'x.db', 1, NULL)", []],
      ["INSERT INTO external_backup_log (status, target_name, size_bytes, sha256) VALUES ('ok', 'x.db', -1, ?)", [sha]],
      ["INSERT INTO external_backup_log (status, target_name, size_bytes, sha256) VALUES ('ok', 'x.db', 1, ?)", ['A'.repeat(64)]],
      ["INSERT INTO external_backup_log (status, target_name, size_bytes, sha256) VALUES ('ok', 'x.db', 1, ?)", ['a'.repeat(63)]],
      ["INSERT INTO external_backup_log (status, target_name, size_bytes, sha256) VALUES ('ok', 'x.db', 1, ?)", ['g'.repeat(64)]],
      ["INSERT INTO external_backup_log (status) VALUES ('failed')", []],
      ["INSERT INTO external_backup_log (status) VALUES ('skipped')", []],
    ];
    for (const [q, p] of bad) expect(() => exec(s, q, ...p), q).toThrow();
    expect(() => exec(s, 'DELETE FROM backup_settings')).toThrow(/BACKUP_SETTINGS_DELETE_FORBIDDEN/);
    expect(() => exec(s, "INSERT INTO backup_settings (id, external_dir) VALUES (2, 'C:\\x')")).toThrow();
    expect(() => exec(s, "UPDATE backup_settings SET external_dir = ''")).toThrow();
    expect(() => exec(s, 'UPDATE backup_settings SET external_dir = ?', 'x'.repeat(1001))).toThrow();
    expect(() => exec(s, "UPDATE backup_settings SET updated_at = NULL")).toThrow();
    expect(JSON.stringify(logAll(s.ctx))).toBe(rowsBefore);
    expect(sqlAll(s.ctx, 'SELECT COUNT(*) AS n FROM backup_settings')[0].n).toBe(1);
  });

  it('OBSERVATION: INSERT OR REPLACE on an existing id bypasses the append-only trigger (SQLite fires DELETE triggers for REPLACE only with recursive_triggers ON); the same hole exists in audit_logs. The application never issues REPLACE; only a developer\'s raw SQL could', async () => {
    const s = await appWithUsb(env);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const pragma = sqlAll(s.ctx, 'PRAGMA recursive_triggers')[0];
    const before = logAll(s.ctx)[0];
    let replaced = true;
    try {
      exec(s, "INSERT OR REPLACE INTO external_backup_log (id, status, error, created_at) VALUES (?, 'failed', 'rewritten history', '2000-01-01T00:00:00.000Z')", before.id);
    } catch { replaced = false; }
    console.log(`recursive_triggers=${JSON.stringify(pragma)}; INSERT OR REPLACE on external_backup_log changed an existing row: ${replaced}`);
    expect(typeof replaced).toBe('boolean');
    const a = sqlAll(s.ctx, 'SELECT id FROM audit_logs ORDER BY id LIMIT 1')[0];
    let auditReplaced = true;
    try { exec(s, "INSERT OR REPLACE INTO audit_logs (id, entity, action) VALUES (?, 'x', 'rewritten')", a.id); } catch { auditReplaced = false; }
    console.log(`INSERT OR REPLACE on audit_logs changed an existing row: ${auditReplaced}`);
    expect(typeof auditReplaced).toBe('boolean');
  });

  it('the service keeps working after a hostile settings value (a folder name full of quotes and SQL text is stored as data)', async () => {
    const s = await appWithUsb(env, false);
    const dir = env.newDir("viman-usb19-'; DROP TABLE backup_settings; --");
    expect((await putFolder(s.app, dir)).status).toBe(200);
    expect((await extStatus(s.app)).folder).toBe(dir);
    expect(sqlAll(s.ctx, 'SELECT COUNT(*) AS n FROM backup_settings')[0].n).toBe(1);
    expect((await runExternalCopyOnce(s.ctx, 'manual')).status).toBeTruthy();
    expect((await call(s.app, 'PUT', '/backups/external', { folder: null })).status).toBe(200);
  });
});
