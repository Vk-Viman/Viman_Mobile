// PHASE 23 - migration 022: the append-only `corrections` link table. Raw-SQL attempts must not be able to write a false link, change or
// delete a link, or replace one (INSERT OR REPLACE). Per-type behaviour is tested in the phase23-correct-*.test.ts files.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { expNew, expVoid, openNew } from './helpers/phase8.ts';
import { probe } from './helpers/phase19h.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const link = (o: number, r: number, ref = 'c-ref-1', entity = 'expenses') =>
  `INSERT INTO corrections (entity, original_id, replacement_id, reason, client_ref) VALUES ('${entity}', ${o}, ${r}, 'typo', '${ref}')`;

async function world() {
  const s = await apiBase(await env.build());
  await openNew(s, 'shop', { businessDate: '2025-05-01', amountCents: 1_000_000 });
  const a = (await expNew(s, { businessDate: '2025-05-02', book: 'shop', category: 'rent', amountCents: 5000 })).body.item;
  const b = (await expNew(s, { businessDate: '2025-05-02', book: 'shop', category: 'rent', amountCents: 6000 })).body.item;
  return { s, a, b };
}

describe('corrections table (migration 022)', () => {
  it('refuses a link whose original is still posted, a missing record, a replacement that is not newer, and a void replacement', async () => {
    const { s, a, b } = await world();
    expect(probe(s.ctx, link(a.id, b.id))).toMatch(/CORRECTION_ORIGINAL_NOT_VOID/);
    await expVoid(s, a.id);
    expect(probe(s.ctx, link(a.id, 9999))).toMatch(/CORRECTION_REPLACEMENT_NOT_POSTED/);
    expect(probe(s.ctx, link(b.id, a.id))).toMatch(/CORRECTION_ORIGINAL_NOT_VOID/);
    expect(probe(s.ctx, link(a.id, a.id))).toBeTruthy();
    await expVoid(s, b.id);
    expect(probe(s.ctx, link(a.id, b.id))).toMatch(/CORRECTION_REPLACEMENT_NOT_POSTED/);
  });

  it('a true link is accepted once; a second link for the same original, replacement or client reference is refused (also via INSERT OR REPLACE)', async () => {
    const { s, a, b } = await world();
    const c = (await expNew(s, { businessDate: '2025-05-02', book: 'shop', category: 'rent', amountCents: 7000 })).body.item;
    await expVoid(s, a.id);
    expect(probe(s.ctx, link(a.id, b.id))).toBeNull();
    s.ctx.database.conn.exec(link(a.id, b.id));
    expect(probe(s.ctx, link(a.id, c.id, 'c-ref-2'))).toMatch(/append-only|UNIQUE|already/);
    expect(probe(s.ctx, link(a.id, b.id, 'c-ref-3'))).toMatch(/append-only|UNIQUE|already/);
    expect(probe(s.ctx, link(a.id, c.id).replace('INSERT', 'INSERT OR REPLACE'))).toMatch(/append-only/);
    expect(probe(s.ctx, `INSERT OR REPLACE INTO corrections (id, entity, original_id, replacement_id, reason, client_ref) VALUES (1, 'expenses', ${a.id}, ${c.id}, 'x', 'c-ref-9')`)).toMatch(/append-only/);
  });

  it('is append-only: no update, no delete', async () => {
    const { s, a, b } = await world();
    await expVoid(s, a.id);
    s.ctx.database.conn.exec(link(a.id, b.id));
    expect(probe(s.ctx, "UPDATE corrections SET reason = 'other'")).toMatch(/append-only/);
    expect(probe(s.ctx, 'DELETE FROM corrections')).toMatch(/append-only/);
  });

  it('the entity list and the reason are checked', async () => {
    const { s, a, b } = await world();
    await expVoid(s, a.id);
    expect(probe(s.ctx, link(a.id, b.id, 'c-x', 'products'))).toBeTruthy();
    expect(probe(s.ctx, link(a.id, b.id).replace("'typo'", "'   '"))).toBeTruthy();
  });
});
