// Phase 19 audit: the REAL start-up path. `node server/src/index.ts` is launched as a separate operating-system process (the same
// command Start-Viman-Shop.bat runs) twice on the same data folder, with a real HTTP port and a real temp "USB" folder. Nothing is
// mocked; the only thing not exercised is the 10-minute timer firing by itself (it would need a 10 minute wait; its function
// runExternalCopyOnce('timer') is tested elsewhere) and a graceful Ctrl+C (Windows cannot deliver SIGINT to a child process).
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { OURS_RE, oursIn, sha256File, sleep } from './helpers/phase19bk.ts';

const env = new TestEnv();
const running: ChildProcess[] = [];
afterEach(async () => {
  for (const c of running.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const done = new Promise<void>((r) => c.once('exit', () => r()));
      c.kill();
      await done;
    }
  }
  await sleep(200); // Windows releases the database file lock a moment after the process exits
  await env.cleanup();
});

const INDEX = resolve(import.meta.dirname, '../index.ts');
const REPO = resolve(import.meta.dirname, '../../..');

const freePort = (): Promise<number> => new Promise((res, rej) => {
  const srv = createServer();
  srv.once('error', rej);
  srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => res(p)); });
});

interface Server { child: ChildProcess; port: number; output: () => string; api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }> }

/** Starts the real program and resolves once it printed its "running at" line. */
async function startServer(dataDir: string, port: number): Promise<Server> {
  const child = spawn(process.execPath, [INDEX], {
    cwd: REPO, env: { ...process.env, VIMAN_DATA_DIR: dataDir, VIMAN_PORT: String(port), VIMAN_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  running.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  child.stderr!.on('data', (d) => { out += String(d); });
  const t0 = Date.now();
  while (!out.includes('Startup backup') && Date.now() - t0 < 30_000) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited early (${child.exitCode}): ${out}`);
    await sleep(50);
  }
  if (!out.includes('Startup backup')) throw new Error(`server did not start: ${out}`);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body: parsed };
  };
  return { child, port, output: () => out, api };
}

const stop = async (s: Server): Promise<void> => {
  const done = new Promise<void>((r) => s.child.once('exit', () => r()));
  s.child.kill();
  await done;
};

async function waitFor(cond: () => boolean, ms = 20_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
  return cond();
}

describe('start-up copy through the real index.ts (two real process starts on one data folder)', () => {
  it('first start sets the folder; the SECOND start takes a start-up backup and copies it (and the earlier one) by itself, no request', async () => {
    const dataDir = env.newDir('viman-data19-');
    const usb = env.newDir('viman-usb19-');
    const port = await freePort();

    const one = await startServer(dataDir, port);
    expect(one.output()).toMatch(/Startup backup: viman-\d{8}-\d{6}-startup\.db/);
    const first = /Startup backup: (\S+)/.exec(one.output())![1]!;
    expect((await one.api('PUT', '/backups/external', { folder: usb })).status).toBe(200);
    expect((await one.api('GET', '/backups/external')).body.status).toBe('ok');
    await stop(one);
    expect(oursIn(usb)).toEqual([]); // nothing was copied by a request that never happened

    const two = await startServer(dataDir, port);
    const second = /Startup backup: (\S+)/.exec(two.output())![1]!;
    expect(second).not.toBe(first);
    // no request has been made to the second process: the copy must appear on its own
    expect(await waitFor(() => oursIn(usb).includes(second)), `external folder: ${readdirSync(usb)}\n${two.output()}`).toBe(true);
    expect(await waitFor(() => oursIn(usb).includes(first))).toBe(true);
    for (const n of [first, second]) expect(sha256File(join(usb, n))).toBe(sha256File(join(dataDir, 'backups', n)));
    expect(readdirSync(usb).filter((n) => !OURS_RE.test(n))).toEqual([]);
    const st = (await two.api('GET', '/backups/external')).body;
    expect(st.status).toBe('ok');
    expect(st.lastSuccessAt).not.toBeNull();
    expect(st.copies.map((c: any) => c.name).sort()).toEqual([first, second].sort());
    const dash = (await two.api('GET', '/dashboard')).body;
    expect(dash.backup.external.status).toBe('ok');
    expect(dash.warnings.map((w: any) => w.code)).not.toContain('EXTERNAL_BACKUP_FAILED');
  });

  it('a start with the drive missing: the program starts normally, prints its banner, serves requests, reports drive_missing; the next start with the drive back copies everything', async () => {
    const dataDir = env.newDir('viman-data19-');
    const usb = env.newDir('viman-usb19-');
    const port = await freePort();
    const one = await startServer(dataDir, port);
    expect((await one.api('PUT', '/backups/external', { folder: usb })).status).toBe(200);
    await stop(one);

    renameSync(usb, `${usb}-away`);
    const two = await startServer(dataDir, port);
    expect(two.output()).toMatch(/Startup backup: viman-/);
    expect(two.output()).not.toMatch(/error|exception|unhandled/i);
    await sleep(500);
    expect((await two.api('GET', '/health')).status).toBe(200);
    const st = (await two.api('GET', '/backups/external')).body;
    expect(st.status).toBe('drive_missing');
    expect((await two.api('POST', '/backups')).status).toBe(201);
    expect((await two.api('GET', '/dashboard')).body.warnings.map((w: any) => w.code)).toContain('EXTERNAL_BACKUP_DRIVE_MISSING');
    expect(two.child.exitCode === null && two.child.signalCode === null).toBe(true); // still running
    await stop(two);

    renameSync(`${usb}-away`, usb);
    const three = await startServer(dataDir, port);
    const locals = readdirSync(join(dataDir, 'backups')).filter((n) => OURS_RE.test(n));
    expect(await waitFor(() => oursIn(usb).length === locals.length)).toBe(true);
    for (const n of locals) expect(sha256File(join(usb, n))).toBe(sha256File(join(dataDir, 'backups', n)));
    expect((await three.api('GET', '/backups/external')).body.status).toBe('ok');
  });
});
