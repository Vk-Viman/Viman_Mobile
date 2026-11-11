import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { latestVersion, migrate } from '../db/migrate.ts';
import { AppDatabase } from '../db/db.ts';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const INDEX = resolve(import.meta.dirname, '../index.ts');
const SERVER_DIR = resolve(import.meta.dirname, '../..');

interface Proc { child: ChildProcess; out: () => string; exited: Promise<number | null> }
const procs: Proc[] = [];
const dirs: string[] = [];

function start(dataDir: string, port: number): Proc {
  const child = spawn(process.execPath, [INDEX], {
    cwd: SERVER_DIR,
    env: { ...process.env, VIMAN_DATA_DIR: dataDir, VIMAN_PORT: String(port), VIMAN_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => { buf += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { buf += d.toString(); });
  const exited = new Promise<number | null>((res) => {
    if (child.exitCode !== null) res(child.exitCode);
    else child.once('exit', (code) => res(code));
  });
  const p: Proc = { child, out: () => buf, exited };
  procs.push(p);
  return p;
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const ok = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port');
}

async function waitHealthy(port: number, proc: Proc, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) throw new Error(`server exited early (${proc.child.exitCode}): ${proc.out()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (r.ok) return;
      last = `status ${r.status}`;
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server not healthy within ${timeoutMs}ms (${last}): ${proc.out()}`);
}

async function stop(p: Proc): Promise<void> {
  if (p.child.exitCode === null) p.child.kill();
  await Promise.race([p.exited, new Promise((r) => setTimeout(r, 10000))]);
}

const startupBackups = (dir: string) =>
  readdirSync(join(dir, 'backups')).filter((f) => /^viman-\d{8}-\d{6}-startup(-\d+)?\.db$/.test(f));

async function waitForStartupBackups(dir: string, n: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && startupBackups(dir).length < n) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterAll(async () => {
  for (const p of procs) { try { await stop(p); } catch { /* ignore */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('index.ts startup', () => {
  it('starts, backs up, refuses a second instance on the same port, and persists data across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-startup-'));
    dirs.push(dir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/api/v1`;

    const first = start(dir, port);
    await waitHealthy(port, first);
    expect(existsSync(join(dir, 'viman.db'))).toBe(true);
    await waitForStartupBackups(dir, 1);
    expect(startupBackups(dir)).toHaveLength(1);
    expect(first.out()).toContain(`http://localhost:${port}`);

    const health = await (await fetch(`${base}/health`)).json() as { status: string; schemaVersion: number };
    expect(health).toMatchObject({ status: 'ok', schemaVersion: latestVersion() });

    // second instance on the same port must fail with a clear message
    const second = start(dir, port);
    const code = await Promise.race([
      second.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15000)),
    ]);
    expect(code).toBe(1);
    expect(second.out()).toContain('already in use');
    // a failed start must not take a startup backup
    expect(startupBackups(dir)).toHaveLength(1);
    // the first instance is unaffected
    expect((await fetch(`${base}/health`)).ok).toBe(true);

    // save settings, kill hard, restart
    const put = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rates: { reloadCommissionBp: 777, ezcashCommissionBp: 55 } }),
    });
    expect(put.status).toBe(200);
    const backupsBefore = startupBackups(dir).length;

    await stop(first);
    expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);

    const third = start(dir, port);
    await waitHealthy(port, third);
    const settings = await (await fetch(`${base}/settings`)).json() as { rates: unknown };
    expect(settings.rates).toEqual({ reloadCommissionBp: 777, ezcashCommissionBp: 55 });
    await waitForStartupBackups(dir, backupsBefore + 1);
    expect(backupsBefore).toBe(1);
    expect(startupBackups(dir)).toHaveLength(backupsBefore + 1);

    await stop(third);
  }, 90000);
});

async function exitCode(p: Proc, timeoutMs = 15000): Promise<number | null | 'timeout'> {
  return Promise.race([p.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))]);
}
const backupFiles = (dir: string) => readdirSync(join(dir, 'backups'));

describe('index.ts startup guards', () => {
  it('garbage viman.db: exits 1, says damaged, lists backups, changes nothing, never listens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-damaged-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'backups'));
    const older = 'viman-20260101-000000-startup.db';
    const newer = 'viman-20260201-000000-manual.db';
    writeFileSync(join(dir, 'backups', older), 'backup-a');
    writeFileSync(join(dir, 'backups', newer), 'backup-b');
    const garbage = Buffer.from('this is not a sqlite database at all. '.repeat(400));
    writeFileSync(join(dir, 'viman.db'), garbage);
    const before = backupFiles(dir).sort();

    const port = await freePort();
    const p = start(dir, port);
    expect(await exitCode(p)).toBe(1);
    const out = p.out();
    expect(out).toContain('damaged');
    expect(out).toContain('Nothing was changed or deleted');
    expect(out).toContain(older);
    expect(out).toContain(newer);
    expect(out.indexOf(newer)).toBeLessThan(out.indexOf(older));
    expect(readFileSync(join(dir, 'viman.db')).equals(garbage)).toBe(true);
    expect(backupFiles(dir).sort()).toEqual(before);
    await expect(fetch(`http://127.0.0.1:${port}/api/v1/health`)).rejects.toThrow();
  }, 40000);

  it('opens but fails quick_check: exits 1, "integrity check failed", no backup, never listens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-corrupt-'));
    dirs.push(dir);
    const dbPath = join(dir, 'viman.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      migrate(db);
      const ins = db.prepare("INSERT INTO audit_logs (entity, entity_id, action, note) VALUES ('bulk', ?, 'create', ?)");
      db.exec('BEGIN');
      for (let i = 0; i < 4000; i++) ins.run(String(i), 'padding-'.repeat(20) + i);
      db.exec('COMMIT');
    } finally { db.close(); }
    const bytes = readFileSync(dbPath);
    expect(bytes.length).toBeGreaterThan(200000);
    // Schema pages (migrations 001-003) sit at the START of the file; the padded audit_logs rows fill the
    // rest. Overwrite only the tail (data pages) so the DB still opens but quick_check finds damage.
    bytes.fill(0x41, Math.floor(bytes.length * 0.7), Math.floor(bytes.length * 0.95));
    writeFileSync(dbPath, bytes);
    const before = Buffer.from(bytes);

    const port = await freePort();
    const p = start(dir, port);
    expect(await exitCode(p)).toBe(1);
    const out = p.out();
    expect(out).toContain('integrity check failed');
    expect(out).toContain('damaged');
    expect(existsSync(join(dir, 'backups')) ? backupFiles(dir).filter((f) => f.endsWith('.db')) : []).toEqual([]);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/api/v1/health`)).rejects.toThrow();
  }, 40000);

  it('a healthy, cleanly closed (WAL) database starts normally; preflight does not false-alarm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-healthy-'));
    dirs.push(dir);
    const adb = new AppDatabase(join(dir, 'viman.db'));
    try {
      migrate(adb.conn);
      adb.tx((c) => c.exec("INSERT INTO audit_logs (entity, action) VALUES ('seed','x')"));
    } finally { adb.close(); }
    const port = await freePort();
    const p = start(dir, port);
    await waitHealthy(port, p);
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { schemaVersion: number }).schemaVersion).toBe(latestVersion());
    expect(p.out()).not.toContain('damaged');
    await waitForStartupBackups(dir, 1);
    await stop(p);
  }, 40000);

  it('healthy start removes planted stale temp files and keeps unrelated ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viman-stale-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'backups'));
    const stale = ['upload-1700000000000.tmp.db', 'restore-candidate.tmp.db', 'restore-candidate.tmp.db-wal', 'viman.db.rollback.tmp'];
    const keep = ['notes.txt', 'upload-abc.tmp.db'];
    for (const f of [...stale, ...keep]) writeFileSync(join(dir, f), 'x');
    const staleBackupTmp = 'viman-20260101-000000-manual.db.tmp';
    writeFileSync(join(dir, 'backups', staleBackupTmp), 'x');
    writeFileSync(join(dir, 'backups', 'keep.tmp'), 'x');

    const port = await freePort();
    const p = start(dir, port);
    await waitHealthy(port, p);
    await waitForStartupBackups(dir, 1);
    for (const f of stale) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(existsSync(join(dir, 'backups', staleBackupTmp))).toBe(false);
    for (const f of keep) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, 'backups', 'keep.tmp'))).toBe(true);
    expect(p.out()).toContain('Cleaned up 5 leftover');
    await stop(p);
  }, 40000);
});
