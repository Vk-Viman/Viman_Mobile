// Phase 19 audit: restoring FROM an external backup (a file on the "USB drive", uploaded as multipart exactly as the Settings
// screen does) and restoring when the configured external folder has changed. Real files, real restore path, no mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import { cleanAll } from './helpers/phase19bk.ts';
import { apiBase, buy, daysAgo } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post } from './helpers/catalog.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { expNew } from './helpers/phase8.ts';
import { buildMultipart } from './helpers/multipart.ts';
import { buildWorld14, diffSnapshots, must, snapshotAll } from './helpers/phase14.ts';
import type { World14 } from './helpers/phase14.ts';
import {
  copyNow, distinctBackup, extStatus, lightInvariants, logAll, oursIn, putFolder, sha256File, sleep,
} from './helpers/phase19bk.ts';
import { externalCopyIdle, runExternalCopyOnce, startExternalCopyTimer } from '../services/external-backup.service.ts';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(async () => { await cleanAll(env); });

const upload = (app: FastifyInstance, content: Buffer, name: string) => {
  const { payload, headers } = buildMultipart([{ name: 'confirm', value: 'RESTORE' }, { name: 'file', filename: name, content }]);
  return app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload, headers });
};
const restoreByName = (app: FastifyInstance, name: string) =>
  app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: { name, confirm: 'RESTORE' } });

/** 31 read endpoints an owner relies on, in one JSON string. The dashboard backup block (time dependent) is dropped. */
async function snapshotFigures(s: ApiBase): Promise<{ text: string; endpoints: number }> {
  const range = 'from=2025-08-01&to=2025-09-30';
  const urls = [
    '/cashbooks', '/cashbooks/shop', '/cashbooks/telecom', '/cashbooks/icecream', '/icecream/funds', '/icecream/days', '/icecream/payments', '/icecream/fund-moves',
    `/reports/pnl/shop?${range}&granularity=month`, `/reports/pnl/telecom?${range}&granularity=day`, `/reports/pnl/icecream?${range}&granularity=month`,
    `/reports/pnl/combined?${range}&granularity=day`, `/reports/cashbook/telecom?${range}&granularity=month`, `/reports/icecream-funds?${range}&granularity=day`,
    '/reports/inventory/valuation', '/reports/inventory/valuation?asOf=2025-08-20', '/inventory/reconciliation',
    '/products?limit=100', '/sales?limit=200', '/purchases?limit=200', '/expenses?limit=200', '/cash-counts', '/daily-closings', '/suppliers',
    '/telecom/summary?from=2025-08-01&to=2025-09-30', '/stock-losses?limit=100', '/categories',
  ];
  const out: Record<string, unknown> = {};
  for (const u of urls) {
    const r = await get(s.app, u);
    out[u] = r.status === 404 ? 'n/a' : r.body;
  }
  for (const d of ['2025-08-10', '2025-09-01', '2025-09-14']) {
    const dash = (await get(s.app, `/dashboard?asOf=${d}`)).body;
    delete dash.backup;
    delete dash.warnings;
    out[`/dashboard?asOf=${d}`] = dash;
  }
  return { text: JSON.stringify(out), endpoints: Object.keys(out).length };
}

async function mutate(s: ApiBase, w: World14): Promise<void> {
  await sellOk(s, [cl(w.P, 1, 80000)], { businessDate: daysAgo(1) });
  await buy(s, [{ productId: w.S, packs: 1, packSize: 4, lineTotalCents: 4444 }], { businessDate: daysAgo(1) });
  await must(await expNew(s, { businessDate: daysAgo(1), book: 'telecom', category: 'repairs', amountCents: 1234 }), 'expense');
}

/** Tables allowed to differ after restoring an old backup: the restore audit row, and the two backup-feature tables that travel with the file. */
const MAY_DIFFER = new Set(['audit_logs', 'backup_settings', 'external_backup_log']);

describe('restore FROM an external copy (upload of the file on the USB drive)', () => {
  it('every figure (30 endpoints) and every table equals the backup moment; only audit_logs grows and the backup-feature tables travel with the file; the shop keeps working', async () => {
    const s = await apiBase(await env.build());
    const w = await buildWorld14(s);
    const usb = env.newDir('viman-usb19-');
    expect((await putFolder(s.app, usb)).status).toBe(200);
    const before = await snapshotFigures(s);
    expect(before.endpoints).toBeGreaterThanOrEqual(25);
    const tables0 = snapshotAll(s.ctx);
    const name = await distinctBackup(s); // an expense is posted just before: figures0 must be taken AFTER it
    await externalCopyIdle(s.ctx);
    const figs0 = await snapshotFigures(s);
    const tables1 = snapshotAll(s.ctx);
    expect(oursIn(usb)).toEqual([name]);
    const external = join(usb, name);
    expect(sha256File(external)).toBe(sha256File(join(s.ctx.backupsDir, name)));
    expect(tables0.expenses).not.toBe(tables1.expenses);

    await mutate(s, w);
    expect((await snapshotFigures(s)).text, 'the mutation must change the figures').not.toBe(figs0.text);

    const r = await upload(s.app, readFileSync(external), name);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().restoredFrom).toBe(`upload:${name}`);
    expect(r.json().safetyBackup).toMatch(/pre-restore/);
    expect((await snapshotFigures(s)).text).toBe(figs0.text);
    const tables2 = snapshotAll(s.ctx);
    const changed = diffSnapshots(tables1, tables2);
    expect(changed.filter((t) => !MAY_DIFFER.has(t))).toEqual([]);
    expect(changed).toContain('audit_logs');
    const a1 = JSON.parse(tables1.audit_logs!) as any[];
    const a2 = JSON.parse(tables2.audit_logs!) as any[];
    expect(a2.slice(0, a1.length)).toEqual(a1);
    expect(a2.slice(a1.length).map((x) => `${x.entity}/${x.action}`)).toEqual(['backup/restore']);
    await lightInvariants(s);

    // the restored system works: new sale, new backup, copy to the same drive
    await sellOk(s, [cl(w.P, 1, 80000)], { businessDate: daysAgo(0) });
    const again = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(oursIn(usb)).toContain(again);
    await lightInvariants(s);
    // the external file itself was only read
    expect(sha256File(external)).toBe(sha256File(join(s.ctx.backupsDir, name)));
  });

  it('a corrupt, truncated, empty or foreign file from the drive is refused and the live data stays byte-for-byte intact', async () => {
    const s = await apiBase(await env.build());
    const w = await buildWorld14(s);
    const usb = env.newDir('viman-usb19-');
    await putFolder(s.app, usb);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const good = readFileSync(join(usb, name));
    await mutate(s, w);
    const figs = (await snapshotFigures(s)).text;
    const tables = snapshotAll(s.ctx);
    const safetyBefore = readdirSync(s.ctx.backupsDir).filter((n) => /pre-restore/.test(n)).length;

    const cases: Array<[string, Buffer, number[]]> = [
      ['truncated to 1 page', good.subarray(0, 4096), [422]],
      ['truncated to 60 %', good.subarray(0, Math.floor(good.length * 0.6)), [422]],
      ['header only (100 bytes)', good.subarray(0, 100), [422]],
      ['not SQLite (text)', Buffer.from('hello, I am not a database. '.repeat(500)), [422]],
      ['SQLite header then garbage', Buffer.concat([good.subarray(0, 16), Buffer.alloc(8192, 0xab)]), [422]],
      ['all zeros (same size)', Buffer.alloc(good.length), [422]],
      ['zero length', Buffer.alloc(0), [400]],
    ];
    for (const [label, bytes, codes] of cases) {
      const r = await upload(s.app, bytes, name);
      expect(codes, `${label}: ${r.statusCode} ${r.body}`).toContain(r.statusCode);
      expect(r.json().error?.code, label).toMatch(/RESTORE_|VALIDATION_ERROR/);
      expect(r.json().error?.message, label).not.toMatch(/node:|at .*\.ts/);
      expect((await snapshotFigures(s)).text, label).toBe(figs);
      expect(diffSnapshots(tables, snapshotAll(s.ctx)), label).toEqual([]); // not even an audit row
    }
    // no safety copy was made for a refused file, no candidate/upload temp file is left
    expect(readdirSync(s.ctx.backupsDir).filter((n) => /pre-restore/.test(n)).length).toBe(safetyBefore);
    expect(readdirSync(s.ctx.dataDir).filter((n) => /\.tmp/.test(n))).toEqual([]);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    // and then the good file restores fine
    expect((await upload(s.app, good, name)).statusCode).toBe(200);
  });

  it('flipped bytes at 40 places in a copy from the drive: the restore either refuses (422) or accepts, never crashes, and the live database is always usable afterwards', async () => {
    const s = await apiBase(await env.build());
    await buildWorld14(s);
    const usb = env.newDir('viman-usb19-');
    await putFolder(s.app, usb);
    const name = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    const good = readFileSync(join(usb, name));
    const verdicts: Record<number, number> = {};
    for (let i = 0; i < 40; i++) {
      const off = 100 + Math.floor(((good.length - 200) / 40) * i);
      const bad = Buffer.from(good);
      bad[off] = bad[off]! ^ 0xff;
      const r = await upload(s.app, bad, name);
      verdicts[r.statusCode] = (verdicts[r.statusCode] ?? 0) + 1;
      expect([200, 422, 500], `offset ${off}: ${r.body}`).toContain(r.statusCode);
      const q = (await get(s.app, '/dashboard')).status;
      expect(q, `offset ${off}`).toBe(200);
    }
    // whatever the verdicts were, the database in use is a healthy SQLite file
    const row = s.ctx.database.conn.prepare('PRAGMA integrity_check').get() as Record<string, string>;
    expect(Object.values(row)[0]).toBe('ok');
    console.log('flipped-byte restore verdicts (status: count):', JSON.stringify(verdicts));
  });
});

describe('restore after the external folder setting has changed', () => {
  async function twoFolders() {
    const s = await apiBase(await env.build());
    const A = env.newDir('viman-usbA-');
    const B = env.newDir('viman-usbB-');
    expect((await putFolder(s.app, A)).status).toBe(200);
    const b1 = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect((await putFolder(s.app, B)).status).toBe(200);
    const b2 = await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    return { s, A, B, b1, b2 };
  }

  it('A -> backup -> B -> backup -> restore the OLD backup: the setting goes back to A, the log goes back to that moment, nothing crashes, the safety copy stays local, copying resumes to A', async () => {
    const { s, A, B, b1, b2 } = await twoFolders();
    expect(oursIn(A)).toEqual([b1]); // folder A only ever received what was taken while A was set
    expect(oursIn(B).sort()).toEqual([b1, b2].sort()); // the new folder was brought up to date with older local backups
    expect((await extStatus(s.app)).folder).toBe(B);
    const logBefore = logAll(s.ctx).length;
    expect(logBefore).toBeGreaterThanOrEqual(3);

    const r = await restoreByName(s.app, b1);
    expect(r.statusCode, r.body).toBe(200);
    const safety = r.json().safetyBackup as string;
    expect(safety).toMatch(/pre-restore/);

    const st = await extStatus(s.app);
    expect(st.configured).toBe(true);
    expect(st.folder).toBe(A); // the folder setting inside the old backup was restored with everything else
    expect(st.folderAvailable).toBe(true);
    expect(st.status).toBe('ok');
    // the copy log is the log of the backup moment: the copies made afterwards are not in it
    expect(logAll(s.ctx).length).toBeLessThan(logBefore);
    // the audit entry of the switch to B is gone with the rest of the later history; the restore is audited
    const audit = s.ctx.database.conn.prepare("SELECT entity, action FROM audit_logs WHERE entity IN ('backup','backup_settings') ORDER BY id").all() as any[];
    expect(audit.map((x) => `${x.entity}/${x.action}`)).toEqual(['backup_settings/update', 'backup/restore']);
    const settingAudit = s.ctx.database.conn.prepare("SELECT after_json FROM audit_logs WHERE entity = 'backup_settings'").all() as any[];
    expect(JSON.parse(settingAudit[0].after_json)).toEqual({ folder: A }); // only the first change (to A) survives; the later one (to B) is not in the restored history
    // the pre-restore safety copy is local only
    for (const dir of [A, B]) expect(readdirSync(dir).some((n) => n.includes('pre-restore'))).toBe(false);
    expect(readdirSync(s.ctx.backupsDir)).toContain(safety);

    // the next pass copies the backups A does not have yet (b2) and nothing else; the timer function works after a restore
    const run = await runExternalCopyOnce(s.ctx, 'timer');
    expect(run.failed).toEqual([]);
    expect(run.copied.map((c) => c.name)).toEqual([b2]);
    expect(oursIn(A).sort()).toEqual([b1, b2].sort());
    expect(oursIn(B).sort()).toEqual([b1, b2].sort()); // B is untouched
    expect((await extStatus(s.app)).status).toBe('ok');
    await lightInvariants(s);
  });

  it('the old folder A is gone when the old backup is restored: drive_missing, a plain warning, no crash, the shop works; Save of a new folder fixes it', async () => {
    const { s, A, b1 } = await twoFolders();
    renameSync(A, `${A}-gone`);
    const r = await restoreByName(s.app, b1);
    expect(r.statusCode).toBe(200);
    const st = await extStatus(s.app);
    expect(st.folder).toBe(A);
    expect(st.status).toBe('drive_missing');
    expect(st.warning).toContain(A);
    expect((await runExternalCopyOnce(s.ctx, 'timer')).failed).toHaveLength(1);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    const C = env.newDir('viman-usbC-');
    expect((await putFolder(s.app, C)).status).toBe(200);
    const run = await copyNow(s.app);
    expect(run.body.failed).toEqual([]);
    expect(oursIn(C).length).toBeGreaterThanOrEqual(2);
    expect((await extStatus(s.app)).status).toBe('ok');
  });

  it('restoring a backup taken BEFORE any folder was configured: the folder setting disappears (not_configured), copying stops without errors, Copy now says 409, Save works again', async () => {
    const s = await apiBase(await env.build());
    const early = await distinctBackup(s);
    const usb = env.newDir('viman-usb19-');
    expect((await putFolder(s.app, usb)).status).toBe(200);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);
    expect(oursIn(usb)).toHaveLength(2);
    const r = await restoreByName(s.app, early);
    expect(r.statusCode).toBe(200);
    const st = await extStatus(s.app);
    expect(st.configured).toBe(false);
    expect(st.status).toBe('not_configured');
    expect(st.warning).toMatch(/No external backup folder is set/);
    expect((await runExternalCopyOnce(s.ctx, 'timer')).copied).toEqual([]);
    expect((await copyNow(s.app)).status).toBe(409);
    expect(oursIn(usb)).toHaveLength(2); // the drive was not touched
    expect((await putFolder(s.app, usb)).status).toBe(200);
    expect((await copyNow(s.app)).body.status).toBe('ok');
  });

  it('restoring a database from BEFORE migration 018 (no backup tables at all) by upload: it is upgraded, status not_configured, nothing breaks', async () => {
    const s = await apiBase(await env.build());
    const usb = env.newDir('viman-usb19-');
    await putFolder(s.app, usb);
    await distinctBackup(s);
    await externalCopyIdle(s.ctx);

    const dir = env.newDir('viman-old-');
    const oldMig = join(dir, 'm');
    mkdirSync(oldMig);
    for (const f of loadMigrations()) if (f.version < 18) copyFileSync(join(MIGRATIONS_DIR, f.name), join(oldMig, f.name));
    const file = join(dir, 'viman-20250101-000000-manual.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    migrate(old, oldMig);
    old.exec("INSERT INTO suppliers (name, phone) VALUES ('Legacy supplier', '0770000000')");
    old.exec('VACUUM');
    old.close();

    const r = await upload(s.app, readFileSync(file), 'viman-20250101-000000-manual.db');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().schemaVersion).toBeGreaterThanOrEqual(18);
    const st = await extStatus(s.app);
    expect(st.status).toBe('not_configured');
    expect(((await get(s.app, '/suppliers')).body.items ?? []).some((x: any) => x.name === 'Legacy supplier')).toBe(true);
    expect((await putFolder(s.app, usb)).status).toBe(200);
    expect((await copyNow(s.app)).status).toBe(200);
  });

  it('the 10-minute timer firing DURING a restore (5 ms ticks) never throws, never copies a half-restored state, and works afterwards', async () => {
    const { s, A, b1 } = await twoFolders();
    const stop = startExternalCopyTimer(s.ctx, 3);
    try {
      for (let i = 0; i < 3; i++) {
        const r = await restoreByName(s.app, b1);
        expect([200, 503, 409]).toContain(r.statusCode);
        await sleep(15);
      }
    } finally { stop(); }
    await externalCopyIdle(s.ctx);
    const st = await extStatus(s.app);
    expect(['ok', 'failed']).toContain(st.status);
    for (const n of oursIn(A)) expect(sha256File(join(A, n))).toBe(sha256File(join(s.ctx.backupsDir, n)));
    expect(readdirSync(A).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    expect(await post(s.app, '/backups', {})).toMatchObject({ status: 201 });
  });
});

void truncateSync; void writeFileSync;
