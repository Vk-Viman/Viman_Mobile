import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { logAudit } from '../services/audit.service.ts';
import { insertAudit, listAudit } from '../repositories/audit.repo.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

async function seeded(n = 5) {
  const b = await env.build();
  b.ctx.database.tx((conn) => {
    for (let i = 1; i <= n; i++) {
      logAudit(conn, i % 2 === 0 ? 'even' : 'odd', String(i), 'create', { i }, { i: i * 10 }, `n${i}`);
    }
  });
  return b;
}
const get = (app: Awaited<ReturnType<typeof seeded>>['app'], q = '') =>
  app.inject({ method: 'GET', url: `/api/v1/audit-logs${q}` });

describe('audit append-only', () => {
  it('UPDATE and DELETE are refused by the database; insert/list still work', async () => {
    const { app, ctx } = await seeded(3);
    const conn = ctx.database.conn;
    expect(() => conn.exec("UPDATE audit_logs SET note = 'tampered'")).toThrow(/append-only/);
    expect(() => conn.exec('DELETE FROM audit_logs WHERE id = 1')).toThrow(/append-only/);
    expect(() => ctx.database.tx((c) => c.exec('DELETE FROM audit_logs'))).toThrow(/append-only/);
    const id = ctx.database.tx((c) => insertAudit(c, { entity: 'e', action: 'a', note: 'n' }));
    expect(id).toBe(4);
    const rows = listAudit(conn, { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([4, 3, 2, 1]);
    expect(rows.find((r) => r.id === 1)!.note).toBe('n1');
    expect((await get(app)).json().items).toHaveLength(4);
  });
});

describe('GET /audit-logs', () => {
  it('empty log', async () => {
    const { app } = await env.build();
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextBeforeId: null });
  });

  it('newest first, parsed before/after objects, full item shape', async () => {
    const { app } = await seeded(3);
    const b = (await get(app)).json();
    expect(b.items.map((i: { id: number }) => i.id)).toEqual([3, 2, 1]);
    expect(b.items[0]).toEqual({
      id: 3, at: expect.any(String), entity: 'odd', entityId: '3', action: 'create',
      before: { i: 3 }, after: { i: 30 }, note: 'n3',
    });
    expect(b.nextBeforeId).toBeNull();
  });

  it('null before/after stay null', async () => {
    const { app, ctx } = await env.build();
    ctx.database.tx((c) => logAudit(c, 'x', null, 'ping', undefined, undefined));
    const it0 = (await get(app)).json().items[0];
    expect(it0.before).toBeNull();
    expect(it0.after).toBeNull();
    expect(it0.entityId).toBeNull();
    expect(it0.note).toBeNull();
  });

  it('limit and nextBeforeId', async () => {
    const { app } = await seeded(5);
    const b = (await get(app, '?limit=2')).json();
    expect(b.items.map((i: { id: number }) => i.id)).toEqual([5, 4]);
    expect(b.nextBeforeId).toBe(4);
  });

  it('paging walks every row exactly once', async () => {
    const { app } = await seeded(7);
    const seen: number[] = [];
    let before: number | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const q: string = before === null ? '?limit=3' : `?limit=3&beforeId=${before}`;
      const b = (await get(app, q)).json();
      seen.push(...b.items.map((i: { id: number }) => i.id));
      before = b.nextBeforeId;
      if (before === null) break;
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('entity filter (exact match)', async () => {
    const { app } = await seeded(5);
    const b = (await get(app, '?entity=even')).json();
    expect(b.items.map((i: { id: number }) => i.id)).toEqual([4, 2]);
    expect((await get(app, '?entity=eve')).json().items).toEqual([]);
  });

  it('default limit is 50', async () => {
    const { app } = await seeded(55);
    const b = (await get(app)).json();
    expect(b.items).toHaveLength(50);
    expect(b.nextBeforeId).toBe(6);
  });

  it('limit=200 accepted', async () => {
    const { app } = await seeded(2);
    expect((await get(app, '?limit=200')).statusCode).toBe(200);
  });

  it.each([
    ['limit=0', '?limit=0', 'limit'],
    ['limit=201', '?limit=201', 'limit'],
    ['limit=abc', '?limit=abc', 'limit'],
    ['limit=-1', '?limit=-1', 'limit'],
    ['limit=1.5', '?limit=1.5', 'limit'],
    ['beforeId=abc', '?beforeId=abc', 'beforeId'],
    ['beforeId=0', '?beforeId=0', 'beforeId'],
    ['unknown param', '?bogus=1', 'bogus'],
  ])('400 VALIDATION_ERROR for %s', async (_l, q, field) => {
    const { app } = await seeded(2);
    const res = await get(app, q);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.json().error.fields)).toContain(field);
  });
});
