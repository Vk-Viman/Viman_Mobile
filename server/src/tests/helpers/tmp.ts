// Per-test environment helper: temp folders and app instances that are always cleaned up.
// Why it matters: each test gets its own data folder and database, so tests never share state or touch real shop data.
// Windows cannot delete a folder while SQLite still has the database file open, so every app is closed BEFORE the
// folders are removed (see cleanup).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.ts';
import type { AppContext } from '../../app.ts';

/**
 * Tracks temp dirs and apps so each test can clean up (apps are closed before dirs are removed).
 * Typical use: `const env = new TestEnv(); afterEach(() => env.cleanup());` then `await env.build()` per test.
 */
export class TestEnv {
  dirs: string[] = [];
  apps: FastifyInstance[] = [];

  /**
   * Creates a new empty temp directory (and remembers it for cleanup). Returns its path.
   */
  newDir(prefix = 'viman-test-'): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  /**
   * Starts a real app (database, migrations, routes) inside a temp data folder, without a web build.
   * @param opts.dataDir reuse an existing folder (e.g. to test a restart on the same data); default a new temp folder
   * @param opts.webDistDir folder of built web files to serve; null (default) means API only
   * @returns { app, ctx, dataDir } - the Fastify app, its context (database access) and the folder used
   */
  async build(opts: { dataDir?: string; webDistDir?: string | null } = {}): Promise<{ app: FastifyInstance; ctx: AppContext; dataDir: string }> {
    const dataDir = opts.dataDir ?? this.newDir();
    const built = await buildApp({ dataDir, webDistDir: opts.webDistDir ?? null, logger: false });
    this.apps.push(built.app);
    return { ...built, dataDir };
  }

  /**
   * Closes all apps first, then deletes all temp folders (with retries; Windows may release file locks slowly).
   * Call it from afterEach.
   */
  async cleanup(): Promise<void> {
    for (const a of this.apps) {
      try { await a.close(); } catch { /* ignore */ }
    }
    this.apps = [];
    for (const d of this.dirs) {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    this.dirs = [];
  }
}
