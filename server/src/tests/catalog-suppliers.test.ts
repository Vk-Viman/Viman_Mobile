// Supplier API (GET/POST/PUT /suppliers) - API level (Fastify inject, real temp database).
// Protects the supplier contract: unique names ignoring case, field length limits, no hard deletes (suppliers are
// deactivated instead, section 12), one audit row per real change and none for no-ops, and rollback when the audit
// write fails. Suppliers are referenced by purchases, so an accidental duplicate or deletion would corrupt history.
// Organised by endpoint: list/search, create, update, then persistence.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, count, get, post, put, raw, SUPPLIER_KEYS } from './helpers/catalog.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

// Listing and searching suppliers.
describe('GET /suppliers', () => {
  it('empty list', async () => {
    const { app } = await env.build();
    const r = await get(app, '/suppliers');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [] });
  });

  it('name order is case-insensitive; q matches name or phone (case-insensitive, wildcards literal); active filter', async () => {
    const { app } = await env.build();
    const mk = async (name: string, phone = '', notes = '') => (await post(app, '/suppliers', { name, phone, notes })).body.item;
    const b = await mk('banana traders', '0771234567');
    const a = await mk('Apple Co', '011-222');
    const c = await mk('cherry_ltd', '0%99');
    const d = await mk('CherryXltd', '555');
    expect((await get(app, '/suppliers')).body.items.map((i: any) => i.name))
      .toEqual(['Apple Co', 'banana traders', 'cherry_ltd', 'CherryXltd']);
    expect((await get(app, '/suppliers?q=APPLE')).body.items.map((i: any) => i.id)).toEqual([a.id]);
    expect((await get(app, '/suppliers?q=0771')).body.items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await get(app, '/suppliers?q=ana')).body.items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await get(app, '/suppliers?q=_')).body.items.map((i: any) => i.id)).toEqual([c.id]);
    expect((await get(app, '/suppliers?q=%25')).body.items.map((i: any) => i.id)).toEqual([c.id]);
    expect((await get(app, '/suppliers?q=cherry')).body.items.map((i: any) => i.id)).toEqual([c.id, d.id]);
    expect((await get(app, '/suppliers?q=%20%20')).body.items).toHaveLength(4);
    expect((await get(app, '/suppliers?q=nomatch')).body.items).toEqual([]);
    await put(app, `/suppliers/${a.id}`, { active: false });
    expect((await get(app, '/suppliers?active=false')).body.items.map((i: any) => i.id)).toEqual([a.id]);
    expect((await get(app, '/suppliers?active=true')).body.items).toHaveLength(3);
    expect((await get(app, '/suppliers?active=true&q=apple')).body.items).toEqual([]);
  });

  it('invalid query values and unknown params -> 400', async () => {
    const { app } = await env.build();
    for (const bad of ['?active=yes', '?active=1', '?active=True', '?limit=5', '?book=shop', '?foo=bar']) {
      const r = await get(app, `/suppliers${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get(app, `/suppliers?q=${'a'.repeat(201)}`)).status).toBe(400);
  });
});

// Creating suppliers: trimming, limits, duplicates and audit.
describe('POST /suppliers', () => {
  it('201 with exact shape, trimmed fields, defaults for phone/notes', async () => {
    const { app } = await env.build();
    let r = await post(app, '/suppliers', { name: '  Acme Ltd  ', phone: ' 0771234567 ', notes: '  net 30  ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(Object.keys(r.body.item).sort()).toEqual(SUPPLIER_KEYS);
    expect(r.body.item).toMatchObject({ name: 'Acme Ltd', phone: '0771234567', notes: 'net 30', active: true });
    expect(r.body.item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(r.body.item.updatedAt).toBe(r.body.item.createdAt);
    r = await post(app, '/suppliers', { name: 'Minimal' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ phone: '', notes: '' });
    expect((await get(app, '/suppliers')).body.items).toHaveLength(2);
  });

  it('validation: name 1-120, phone 0-30, notes 0-500 (trimmed), types, extra fields', async () => {
    const { app, ctx } = await env.build();
    let r = await post(app, '/suppliers', { name: '' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: { name: 'Name is required.' } });
    expect((await post(app, '/suppliers', { name: '   ' })).body.error.fields.name).toBe('Name is required.');
    expect((await post(app, '/suppliers', {})).body.error.fields.name).toBeDefined();
    r = await post(app, '/suppliers', { name: 'n'.repeat(121) });
    expect(r.body.error.fields.name).toBe('Name must be at most 120 characters.');
    expect((await post(app, '/suppliers', { name: 'n'.repeat(120) })).status).toBe(201);
    r = await post(app, '/suppliers', { name: 'P1', phone: '1'.repeat(31) });
    expect(r.body.error.fields.phone).toBe('Phone must be at most 30 characters.');
    expect((await post(app, '/suppliers', { name: 'P2', phone: '1'.repeat(30) })).status).toBe(201);
    expect((await post(app, '/suppliers', { name: 'P3', phone: ` ${'1'.repeat(30)} ` })).status).toBe(201);
    r = await post(app, '/suppliers', { name: 'N1', notes: 'x'.repeat(501) });
    expect(r.body.error.fields.notes).toBe('Notes must be at most 500 characters.');
    expect((await post(app, '/suppliers', { name: 'N2', notes: 'x'.repeat(500) })).status).toBe(201);
    r = await post(app, '/suppliers', { name: 'Multi', phone: '1'.repeat(31), notes: 'x'.repeat(501) });
    expect(Object.keys(r.body.error.fields).sort()).toEqual(['notes', 'phone']);
    expect((await post(app, '/suppliers', { name: 5 })).status).toBe(400);
    expect((await post(app, '/suppliers', { name: 'T', phone: 123 })).status).toBe(400);
    expect((await post(app, '/suppliers', { name: 'T', phone: null })).status).toBe(400);
    r = await post(app, '/suppliers', { name: 'T', active: false });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.active).toBe('Unknown field.');
    expect((await post(app, '/suppliers', { name: 'T', id: 4 })).status).toBe(400);
    expect((await raw(app, 'POST', '/suppliers', '{oops')).status).toBe(400);
    expect(count(ctx, 'suppliers')).toBe(4);
    expect(auditRows(ctx, 'supplier')).toHaveLength(4);
  });

  it('DUPLICATE_NAME: case-insensitive after trimming; nothing written', async () => {
    const { app, ctx } = await env.build();
    await post(app, '/suppliers', { name: 'Acme' });
    for (const name of ['acme', 'ACME', '  Acme  ']) {
      const r = await post(app, '/suppliers', { name });
      expect(r.status, name).toBe(409);
      expect(r.body.error.code).toBe('DUPLICATE_NAME');
      expect(r.body.error.fields.name).toBe('Another supplier already uses this name.');
    }
    expect(count(ctx, 'suppliers')).toBe(1);
    expect(auditRows(ctx)).toHaveLength(1);
  });

  it('writes one audit row (entity supplier, create, before null, after = item)', async () => {
    const { app, ctx } = await env.build();
    const r = await post(app, '/suppliers', { name: 'Acme', phone: '1' });
    const rows = auditRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'supplier', entityId: String(r.body.item.id), action: 'create', before: null });
    expect(rows[0]!.after).toEqual(r.body.item);
  });

  it('rolls back the row when its audit write fails', async () => {
    const { app, ctx } = await env.build();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    breakAudit(ctx, 'supplier');
    const r = await post(app, '/suppliers', { name: 'Doomed' });
    expect(r.status).toBe(500);
    expect(count(ctx, 'suppliers')).toBe(0);
    expect(auditRows(ctx)).toEqual([]);
  });
});

// Editing, activating/deactivating suppliers.
describe('PUT /suppliers/:id', () => {
  const mk = async (app: Parameters<typeof post>[0], name = 'Acme') =>
    (await post(app, '/suppliers', { name, phone: '111', notes: 'n' })).body.item;

  it('updates any subset, 200 { item }, full before/after audit, other fields untouched', async () => {
    const { app, ctx } = await env.build();
    const s = await mk(app);
    let r = await put(app, `/suppliers/${s.id}`, { phone: ' 222 ' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item']);
    expect(r.body.item).toMatchObject({ id: s.id, name: 'Acme', phone: '222', notes: 'n', active: true });
    r = await put(app, `/suppliers/${s.id}`, { name: ' Acme 2 ', notes: '', active: false });
    expect(r.body.item).toMatchObject({ name: 'Acme 2', phone: '222', notes: '', active: false });
    const rows = auditRows(ctx);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ entity: 'supplier', entityId: String(s.id), action: 'update' });
    expect(rows[1]!.before).toEqual(s);
    expect(rows[2]!.before).toEqual(rows[1]!.after);
    expect(rows[2]!.after).toEqual(r.body.item);
    expect(Object.keys(rows[2]!.after).sort()).toEqual(SUPPLIER_KEYS);
  });

  it('deactivate and reactivate', async () => {
    const { app } = await env.build();
    const s = await mk(app);
    expect((await put(app, `/suppliers/${s.id}`, { active: false })).body.item.active).toBe(false);
    expect((await get(app, '/suppliers?active=true')).body.items).toEqual([]);
    expect((await put(app, `/suppliers/${s.id}`, { active: true })).body.item.active).toBe(true);
  });

  it('no-op PUT returns the item with no audit row', async () => {
    const { app, ctx } = await env.build();
    const s = await mk(app);
    for (const body of [{ name: 'Acme' }, { name: '  Acme ' }, { phone: '111', notes: 'n' }, { active: true }]) {
      const r = await put(app, `/suppliers/${s.id}`, body);
      expect(r.status).toBe(200);
      expect(r.body.item).toEqual(s);
    }
    expect(auditRows(ctx)).toHaveLength(1);
  });

  it('DUPLICATE_NAME against another supplier; case-only rename of self is fine', async () => {
    const { app, ctx } = await env.build();
    const a = await mk(app, 'Acme');
    await mk(app, 'Beta');
    const r = await put(app, `/suppliers/${a.id}`, { name: 'beta' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_NAME');
    expect(r.body.error.fields.name).toBe('Another supplier already uses this name.');
    expect(auditRows(ctx)).toHaveLength(2);
    const ok = await put(app, `/suppliers/${a.id}`, { name: 'ACME' });
    expect(ok.status).toBe(200);
    expect(ok.body.item.name).toBe('ACME');
  });

  it('validation and id errors', async () => {
    const { app, ctx } = await env.build();
    const s = await mk(app);
    let r = await put(app, `/suppliers/${s.id}`, {});
    expect(r.status).toBe(400);
    r = await put(app, `/suppliers/${s.id}`, { name: '' });
    expect(r.body.error.fields.name).toBe('Name is required.');
    r = await put(app, `/suppliers/${s.id}`, { name: 'n'.repeat(121) });
    expect(r.body.error.fields.name).toBe('Name must be at most 120 characters.');
    r = await put(app, `/suppliers/${s.id}`, { phone: '1'.repeat(31) });
    expect(r.body.error.fields.phone).toBe('Phone must be at most 30 characters.');
    r = await put(app, `/suppliers/${s.id}`, { notes: 'x'.repeat(501) });
    expect(r.body.error.fields.notes).toBe('Notes must be at most 500 characters.');
    expect((await put(app, `/suppliers/${s.id}`, { active: 'no' })).status).toBe(400);
    expect((await put(app, `/suppliers/${s.id}`, { phone: null })).status).toBe(400);
    r = await put(app, `/suppliers/${s.id}`, { id: 2 });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.id).toBe('Unknown field.');
    expect((await raw(app, 'PUT', `/suppliers/${s.id}`, '')).status).toBe(400);
    for (const id of ['abc', '1.5', '-1', '1234567890']) {
      expect((await put(app, `/suppliers/${id}`, { active: true })).status, id).toBe(400);
    }
    r = await put(app, '/suppliers/99999', { active: false });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect(auditRows(ctx)).toHaveLength(1);
  });

  it('rolls back the update when its audit write fails', async () => {
    const { app, ctx } = await env.build();
    const s = await mk(app);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    breakAudit(ctx, 'supplier');
    const r = await put(app, `/suppliers/${s.id}`, { name: 'Changed' });
    expect(r.status).toBe(500);
    expect((await get(app, '/suppliers')).body.items[0].name).toBe('Acme');
  });
});

// Data must still be there after the app is stopped and started again on the same folder.
describe('persistence', () => {
  it('suppliers survive re-opening the same data directory', async () => {
    const first = await env.build();
    const s = (await post(first.app, '/suppliers', { name: 'Keep', phone: '9' })).body.item;
    await put(first.app, `/suppliers/${s.id}`, { notes: 'later' });
    await first.app.close();
    env.apps = env.apps.filter((a) => a !== first.app);
    const second = await env.build({ dataDir: first.dataDir });
    const items = (await get(second.app, '/suppliers')).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: s.id, name: 'Keep', phone: '9', notes: 'later', active: true });
    expect(auditRows(second.ctx, 'supplier')).toHaveLength(2);
  });
});
