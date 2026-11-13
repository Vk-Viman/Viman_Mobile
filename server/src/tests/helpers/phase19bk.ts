// Helpers for the Phase 19 INDEPENDENT AUDIT of the external backup (BUSINESS_RULES section 12, API_CONTRACTS part C).
// Kept separate from the phase 18 tests on purpose: nothing here is copied from them.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { TestEnv } from './tmp.ts';
import { call, get } from './catalog.ts';
import { createBackup } from '../../services/backup.service.ts';

/** SHA-256 of a file. */
export const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The strict pattern of our own external backups (same as the contract). */
export const OURS_RE = /^viman-\d{8}-\d{6}-(startup|manual)(-\d+)?\.db$/;
/** Names in a folder that match the pattern, sorted ascending. */
export const oursIn = (dir: string): string[] => readdirSync(dir).filter((n) => OURS_RE.test(n)).sort();

export const putFolder = (app: FastifyInstance, folder: unknown) => call(app, 'PUT', '/backups/external', { folder });
export const extStatus = async (app: FastifyInstance): Promise<any> => (await get(app, '/backups/external')).body;
export const copyNow = (app: FastifyInstance) => call(app, 'POST', '/backups/external/copy');
export const sqlAll = (ctx: AppContext, q: string, ...p: any[]): any[] => ctx.database.conn.prepare(q).all(...p) as any[];
export const logAll = (ctx: AppContext): any[] => sqlAll(ctx, 'SELECT * FROM external_backup_log ORDER BY id');
export const errno = (code: string): Error => Object.assign(new Error(code), { code });
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An app plus an empty "USB" folder, configured as the external folder unless `configure` is false. */
export async function appWithUsb(env: TestEnv, configure = true) {
  const b = await env.build();
  const usb = env.newDir('viman-usb19-');
  if (configure) {
    const r = await putFolder(b.app, usb);
    if (r.status !== 200) throw new Error(`appWithUsb: ${JSON.stringify(r.body)}`);
  }
  return { ...b, usb };
}

/** `viman-YYYYMMDD-120000-<reason>[-n].db` for day number `i` after 2025-01-01. */
export function stampName(i: number, reason: 'startup' | 'manual' = 'manual', suffix = ''): string {
  const d = new Date(Date.UTC(2025, 0, 1 + i));
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `viman-${ymd}-120000-${reason}${suffix}.db`;
}

/** Writes `count` distinct files (own bytes each) named like our backups into a folder; returns the names. */
export function seedExternal(dir: string, count: number, from = 0): string[] {
  const names: string[] = [];
  for (let i = from; i < from + count; i++) {
    const n = stampName(i);
    writeFileSync(join(dir, n), Buffer.from(`seeded external backup ${i}`));
    names.push(n);
  }
  return names;
}

/** `n` real local backups with distinct, increasing names (the instant is the file name). */
export function localBackups(ctx: AppContext, n: number, reason: 'startup' | 'manual' = 'manual', baseIso = '2026-03-01T10:00:00Z'): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(createBackup(ctx, reason, new Date(Date.parse(baseIso) + i * 61_000)).name);
  return out;
}

/** REAL Windows mechanism: deny the current user the right to create files and sub-folders in `folder`. */
export function denyWrite(folder: string): void {
  execFileSync('icacls', [folder, '/deny', `${process.env.USERNAME}:(OI)(CI)(WD,AD)`], { stdio: 'pipe' });
}
/** Removes the deny entry again (always call in a finally block). */
export function allowWrite(folder: string): void {
  execFileSync('icacls', [folder, '/remove:d', `${process.env.USERNAME}`], { stdio: 'pipe' });
}
/** Creates a junction `link` -> `target` (no administrator rights needed). */
export function makeJunction(link: string, target: string): void {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
}

/** The verification script (repository scripts folder). */
export const SCRIPT = resolve(import.meta.dirname, '../../../../scripts/verify-external-backup.mjs');
/** Runs the script and returns its exit code and output. */
export function runScript(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
