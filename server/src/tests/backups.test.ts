import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import {
  BACKUP_NAME_RE, KEEP_PRE_RESTORE, KEEP_REGULAR, cleanupStaleTempFiles, createBackup, listBackups, newestBackupNames, rotateBackups,
} from '../services/backup.service.ts';
import { backupStamp } from '../lib/dates.ts';
import { latestVersion } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

const BASE = Date.parse('2026-03-01T00:00:00Z');
const at = (i: number) => new Date(BASE + i * 1000);

describe('backups', () => {
  it('startup backup: pattern, listed by GET', async () => {
    const { app, ctx, backupsDir } = await build();
    const info = createBackup(ctx, 'startup');
    expect(info.name).toMatch(BACKUP_NAME_RE);
    expect(info.name).toMatch(/-startup\.db$/);
    expect(info.reason).toBe('startup');
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(backupsDir, info.name))).toBe(true);

    const res = await app.inject({ method: 'GET', url: '/api/v1/backups' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(info);
    expect(new Date(items[0].createdAt).toISOString()).toBe(items[0].createdAt);
  });

  it('name uses the Colombo stamp of the supplied now', async () => {
    const { ctx } = await build();
    const now = new Date('2026-11-10T06:00:00Z');
    const info = createBackup(ctx, 'manual', now);
    expect(info.name).toBe(`viman-${backupStamp(now)}-manual.db`);
    expect(info.name).toBe('viman-20261110-113000-manual.db');
  });

  it('POST /backups -> 201 manual backup', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/backups' });
    expect(res.statusCode).toBe(201);
    const item = res.json().item;
    expect(item.reason).toBe('manual');
    expect(item.name).toMatch(BACKUP_NAME_RE);
    const res2 = await app.inject({ method: 'POST', url: '/api/v1/backups', payload: {} });
    expect(res2.statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json().items;
    expect(list).toHaveLength(2);
    expect(new Set(list.map((i: { name: string }) => i.name)).size).toBe(2);
  });

  it('same-second backups get -2, -3 suffixes', async () => {
    const { ctx } = await build();
    const now = at(0);
    const a = createBackup(ctx, 'manual', now);
    const b = createBackup(ctx, 'manual', now);
    const c = createBackup(ctx, 'manual', now);
    const stem = `viman-${backupStamp(now)}-manual`;
    expect(a.name).toBe(`${stem}.db`);
    expect(b.name).toBe(`${stem}-2.db`);
    expect(c.name).toBe(`${stem}-3.db`);
    for (const n of [a.name, b.name, c.name]) expect(n).toMatch(BACKUP_NAME_RE);
  });

  it('a backup opens read-only, integrity ok, and contains current settings', async () => {
    const { app, ctx, backupsDir } = await build();
    await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { rates: { reloadCommissionBp: 321, ezcashCommissionBp: 12 } } });
    const info = createBackup(ctx, 'manual');
    const db = new DatabaseSync(join(backupsDir, info.name), { readOnly: true });
    try {
      const ic = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      expect(ic).toEqual([{ integrity_check: 'ok' }]);
      const row = db.prepare("SELECT value_json FROM settings WHERE key='rates'").get() as { value_json: string };
      expect(JSON.parse(row.value_json)).toEqual({ reloadCommissionBp: 321, ezcashCommissionBp: 12 });
      const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity='settings'").get() as { c: number };
      expect(Number(audit.c)).toBe(1);
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
      expect(Number(v.v)).toBe(latestVersion());
    } finally {
      db.close();
    }
    // no leftover temp file
    expect(readdirSync(backupsDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rotation: 31 regular backups -> 30 remain, oldest deleted', async () => {
    const { ctx } = await build();
    const names: string[] = [];
    for (let i = 0; i < KEEP_REGULAR + 1; i++) names.push(createBackup(ctx, i % 2 ? 'manual' : 'startup', at(i)).name);
    const remaining = listBackups(ctx).map((b) => b.name);
    expect(remaining).toHaveLength(30);
    expect(remaining).not.toContain(names[0]);
    expect(remaining).toContain(names[1]);
    expect(remaining[0]).toBe(names[30]); // newest first
  });

  it('rotation: 11 pre-restore -> 10 remain, oldest deleted', async () => {
    const { ctx } = await build();
    const names: string[] = [];
    for (let i = 0; i < KEEP_PRE_RESTORE + 1; i++) names.push(createBackup(ctx, 'pre-restore', at(i)).name);
    const remaining = listBackups(ctx).map((b) => b.name);
    expect(remaining).toHaveLength(10);
    expect(remaining).not.toContain(names[0]);
    expect(remaining).toContain(names[1]);
  });

  it('regular and pre-restore rotate independently', async () => {
    const { ctx } = await build();
    const pre: string[] = [];
    for (let i = 0; i < 10; i++) pre.push(createBackup(ctx, 'pre-restore', at(i)).name);
    // 30 regular backups, all NEWER than the pre-restore ones: pre-restore must survive
    for (let i = 0; i < 30; i++) createBackup(ctx, 'manual', at(100 + i));
    expect(listBackups(ctx)).toHaveLength(40);
    // one more regular drops only the oldest regular
    createBackup(ctx, 'manual', at(200));
    const all = listBackups(ctx);
    expect(all.filter((b) => b.reason === 'pre-restore').map((b) => b.name).sort()).toEqual([...pre].sort());
    expect(all.filter((b) => b.reason !== 'pre-restore')).toHaveLength(30);
    // and one more pre-restore drops only the oldest pre-restore
    createBackup(ctx, 'pre-restore', at(300));
    const all2 = listBackups(ctx);
    expect(all2.filter((b) => b.reason === 'pre-restore')).toHaveLength(10);
    expect(all2.filter((b) => b.reason !== 'pre-restore')).toHaveLength(30);
    expect(all2.map((b) => b.name)).not.toContain(pre[0]);
  });

  it('non-matching files are ignored and never deleted', async () => {
    const { app, ctx, backupsDir } = await build();
    const strays = ['notes.txt', 'viman-bad.db', 'viman-20260101-000000-weird.db', 'viman-20260101-000000-manual.db.tmp', 'old-backup.db'];
    for (const s of strays) writeFileSync(join(backupsDir, s), 'x');
    for (let i = 0; i < KEEP_REGULAR + 3; i++) createBackup(ctx, 'manual', at(i));
    rotateBackups(ctx);
    for (const s of strays) expect(existsSync(join(backupsDir, s))).toBe(true);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json().items;
    expect(list).toHaveLength(30);
    for (const it of list) expect(it.name).toMatch(BACKUP_NAME_RE);
  });
});

describe('cleanupStaleTempFiles / newestBackupNames', () => {
  it('removes exactly the stale temp patterns and leaves everything else', async () => {
    const { ctx, dataDir, backupsDir } = await build();
    const real = createBackup(ctx, 'manual', at(0)).name;
    const stale = ['upload-123.tmp.db', 'upload-1699999999999.tmp.db', 'restore-candidate.tmp.db',
      'restore-candidate.tmp.db-wal', 'restore-candidate.tmp.db-shm', 'viman.db.rollback.tmp'];
    const keepData = ['notes.txt', 'upload-abc.tmp.db', 'upload-.tmp.db', 'restore-candidate.tmp.db.bak',
      'viman.db.rollback', 'viman.db.rollback.tmp2', 'other.tmp'];
    for (const f of [...stale, ...keepData]) writeFileSync(join(dataDir, f), 'x');
    const staleBackupTmp = 'viman-20260101-000000-manual.db.tmp';
    const keepBackups = ['notes.txt', 'foo.db.tmp', 'viman-bad.db.tmp', 'viman-20260101-000000-weird.db.tmp'];
    writeFileSync(join(backupsDir, staleBackupTmp), 'x');
    for (const f of keepBackups) writeFileSync(join(backupsDir, f), 'x');

    const removed = cleanupStaleTempFiles(ctx);
    expect([...removed].sort()).toEqual([...stale, staleBackupTmp].sort());
    for (const f of stale) expect(existsSync(join(dataDir, f)), f).toBe(false);
    expect(existsSync(join(backupsDir, staleBackupTmp))).toBe(false);
    for (const f of keepData) expect(existsSync(join(dataDir, f)), f).toBe(true);
    for (const f of keepBackups) expect(existsSync(join(backupsDir, f)), f).toBe(true);
    expect(existsSync(join(dataDir, 'viman.db'))).toBe(true);
    expect(existsSync(join(backupsDir, real))).toBe(true);
    // idempotent
    expect(cleanupStaleTempFiles(ctx)).toEqual([]);
  });

  it('does not remove directories', async () => {
    const { ctx, dataDir } = await build();
    mkdirSync(join(dataDir, 'upload-1.tmp.db.d'));
    expect(cleanupStaleTempFiles(ctx)).toEqual([]);
  });

  it('newestBackupNames: valid names only, newest first, limited', async () => {
    const { backupsDir } = await build();
    const names = ['viman-20260101-000000-startup.db', 'viman-20260301-120000-manual.db',
      'viman-20260201-000000-pre-restore.db', 'viman-20260215-000000-manual.db'];
    for (const n of names) writeFileSync(join(backupsDir, n), 'x');
    for (const n of ['notes.txt', 'viman-bad.db', 'viman-20260401-000000-manual.db.tmp']) writeFileSync(join(backupsDir, n), 'x');
    const all = newestBackupNames(backupsDir, 10);
    expect(all).toEqual(['viman-20260301-120000-manual.db', 'viman-20260215-000000-manual.db',
      'viman-20260201-000000-pre-restore.db', 'viman-20260101-000000-startup.db']);
    expect(newestBackupNames(backupsDir, 2)).toEqual(all.slice(0, 2));
    expect(newestBackupNames(backupsDir, 0)).toEqual([]);
    expect(newestBackupNames(join(backupsDir, 'nope'), 3)).toEqual([]);
  });
});

async function build() {
  const b = await env.build();
  return { ...b, backupsDir: join(b.dataDir, 'backups') };
}
