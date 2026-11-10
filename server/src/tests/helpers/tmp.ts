import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.ts';
import type { AppContext } from '../../app.ts';

/** Tracks temp dirs and apps so each test can clean up (apps are closed before dirs are removed). */
export class TestEnv {
  dirs: string[] = [];
  apps: FastifyInstance[] = [];

  newDir(prefix = 'viman-test-'): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  async build(opts: { dataDir?: string; webDistDir?: string | null } = {}): Promise<{ app: FastifyInstance; ctx: AppContext; dataDir: string }> {
    const dataDir = opts.dataDir ?? this.newDir();
    const built = await buildApp({ dataDir, webDistDir: opts.webDistDir ?? null, logger: false });
    this.apps.push(built.app);
    return { ...built, dataDir };
  }

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
