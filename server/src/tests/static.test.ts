import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

function webDir(): string {
  const d = env.newDir('viman-web-');
  mkdirSync(join(d, 'assets'));
  writeFileSync(join(d, 'index.html'), '<!doctype html><html><body><div id="root">SPA</div></body></html>');
  writeFileSync(join(d, 'assets', 'x.js'), 'console.log(1);');
  return d;
}

describe('static hosting', () => {
  it('serves index.html at / and SPA fallback for client routes', async () => {
    const { app } = await env.build({ webDistDir: webDir() });
    for (const url of ['/', '/settings/backups', '/some/deep/route']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('id="root"');
    }
  });

  it('serves real assets', async () => {
    const { app } = await env.build({ webDistDir: webDir() });
    const res = await app.inject({ method: 'GET', url: '/assets/x.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log(1);');
  });

  it('unknown /api paths are JSON 404, never HTML', async () => {
    const { app } = await env.build({ webDistDir: webDir() });
    for (const url of ['/api/v1/nope', '/api/nope', '/api']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    const post = await app.inject({ method: 'POST', url: '/api/v1/nope', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe('NOT_FOUND');
  });

  it('API routes still work with web enabled', async () => {
    const { app } = await env.build({ webDistDir: webDir() });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('serves an asset created after the server started', async () => {
    const dir = webDir();
    const { app } = await env.build({ webDistDir: dir });
    expect((await app.inject({ method: 'GET', url: '/assets/late.js' })).statusCode).toBe(404);
    writeFileSync(join(dir, 'assets', 'late.js'), 'console.log("late");');
    const res = await app.inject({ method: 'GET', url: '/assets/late.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log("late");');
  });

  it.each(['/assets/missing.js', '/assets/missing.css', '/logo.png', '/favicon.ico', '/assets/nodir/none'])(
    'missing file %s -> 404 JSON, never HTML', async (url) => {
      const { app } = await env.build({ webDistDir: webDir() });
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).not.toMatch(/text\/html/);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

  it('client routes (with and without query) still fall back to index.html', async () => {
    const { app } = await env.build({ webDistDir: webDir() });
    for (const url of ['/settings/backups', '/settings/backups?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('id="root"');
    }
  });

  it('HEAD / -> 200', async () => {
    const { app } = await env.build({ webDistDir: webDir() });
    const res = await app.inject({ method: 'HEAD', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('without webDistDir everything unknown is a JSON 404', async () => {
    const { app } = await env.build();
    const res = await app.inject({ method: 'GET', url: '/whatever' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });

  it('webDistDir without index.html is treated as no web', async () => {
    const empty = env.newDir('viman-web-empty-');
    const { app } = await env.build({ webDistDir: empty });
    const res = await app.inject({ method: 'GET', url: '/settings' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
