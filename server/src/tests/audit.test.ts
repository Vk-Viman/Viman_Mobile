// Audit log (BUSINESS_RULES section 12) - database level plus API level (GET /audit-logs).
// Protects: the audit trail can only grow (UPDATE and DELETE are refused by database triggers, so nobody can
// rewrite history), entries come back newest first with before/after as real objects, financial entries carry the
// business date and the "backdated" flag (confirmed rule of 2026-11-10), and paging walks every row exactly once.
// Organised as: append-only guarantee, then the read API (shape, filters, paging, validation).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { logAudit } from '../services/audit.service.ts';
import { insertAudit, listAudit } from '../repositories/audit.repo.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

// Builds an app and writes n audit rows (alternating entity 'odd'/'even', before {i}, after {i*10}) in one transaction.
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

// The audit table must be tamper-proof at database level, independent of any API.
describe('audit append-only', () => {
  // A trigger blocks edits and deletes, so an audit entry, once written, is permanent; inserting and listing still work.
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

// Reading the audit trail: ordering, shape, filters, paging, validation.
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
      postedAt: expect.any(String), businessDate: null, backdated: false,
    });
    expect(b.items[0].postedAt).toBe(b.items[0].at);
    expect(b.items[0].postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(b.nextBeforeId).toBeNull();
  });

  // Financial entries record both the business date (drives reports) and the posting time (postedAt = when the server saved it);
  // backdated = business date earlier than the posting day. Backdating is allowed but always visible (section 12).
  it('financial audit rows carry businessDate and backdated; postedAt mirrors at', async () => {
    const { app, ctx } = await env.build();
    ctx.database.tx((c) => {
      logAudit(c, 'purchase', '1', 'create', null, { x: 1 }, undefined, { businessDate: '2026-01-05', backdated: true });
      logAudit(c, 'purchase', '2', 'create', null, { x: 2 }, undefined, { businessDate: '2026-11-10', backdated: false });
    });
    const items = (await get(app)).json().items;
    expect(items[1]).toMatchObject({ entityId: '1', businessDate: '2026-01-05', backdated: true });
    expect(items[0]).toMatchObject({ entityId: '2', businessDate: '2026-11-10', backdated: false });
    for (const it of items) expect(it.postedAt).toBe(it.at);
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

  // Using nextBeforeId repeatedly must return every entry once, with no repeats and no gaps.
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

  // With more rows than the default page, one request returns 50 and tells the client how to fetch the rest.
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

  // Bad query values must give a clean 400 naming the field, never a database error.
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
