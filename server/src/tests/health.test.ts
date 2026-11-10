import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { todayBusinessDate } from '../lib/dates.ts';
import { latestVersion } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

describe('GET /api/v1/health', () => {
  it('returns the contract shape', async () => {
    const { app } = await env.build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(Object.keys(b).sort()).toEqual(['appVersion', 'schemaVersion', 'status', 'time', 'today']);
    expect(b.status).toBe('ok');
    expect(b.appVersion).toBe('0.1.0');
    expect(b.schemaVersion).toBe(latestVersion());
    expect(new Date(b.time).toISOString()).toBe(b.time);
    expect(b.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(b.today).toBe(todayBusinessDate(new Date(b.time)));
  });
});
