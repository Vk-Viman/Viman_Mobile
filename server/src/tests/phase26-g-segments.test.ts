// Phase 26, package G: entry-chosen flows (expenses, cash drawings, transfers, corrections) with the Telecom segments (BUSINESS_RULES 13D).
//   - segment REQUIRED for a Telecom expense / cash drawing / transfer side, FORBIDDEN for the other books;
//   - per-segment balances after expenses and drawings; the Telecom total always equals the sum of its segments;
//   - Telecom-to-Telecom transfers between two different segments: both legs, net 0 for the Telecom total, same segment refused;
//   - void reverses in the same segments; corrections keep the segment by default or take the one supplied; legacy needs a real one;
//   - a closed day of one segment blocks only that segment (both sides of a transfer are judged);
//   - negative-cash warnings are given per scope (the source scope of a transfer).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, sql } from './helpers/phase4.ts';
import { expNew, expVoid } from './helpers/phase8.ts';
import { drawCash, legsOf, tr, trVoid } from './helpers/phase9.ts';
import { seg } from './helpers/seg.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

const fixExp = (s: ApiBase, id: number, replacement: Record<string, unknown>) =>
  post(s.app, `/expenses/${id}/correct`, { reason: 'fix', replacement: { clientRef: ref(), category: 'other', description: 'E', amountCents: 1000, book: 'telecom', ...replacement } });
const fixTr = (s: ApiBase, id: number, replacement: Record<string, unknown>) =>
  post(s.app, `/cash-transfers/${id}/correct`, { reason: 'fix', replacement: { clientRef: ref(), amountCents: 1000, ...replacement } });
const fixDraw = (s: ApiBase, id: number, replacement: Record<string, unknown>) =>
  post(s.app, `/drawings/${id}/correct`, { reason: 'fix', replacement: { clientRef: ref(), kind: 'cash', amountCents: 1000, book: 'telecom', ...replacement } });

describe('segment required / forbidden', () => {
  it('expense: Telecom without a segment is SEGMENT_REQUIRED, Shop with one is SEGMENT_NOT_ALLOWED, legacy is refused', async () => {
    const s = await setup();
    const base = { businessDate: today(), category: 'rent', amountCents: 500, description: 'x' };
    const a = await post(s.app, '/expenses', { ...base, book: 'telecom', clientRef: ref() });
    expect([a.status, err(a).code]).toEqual([400, 'SEGMENT_REQUIRED']);
    const b = await post(s.app, '/expenses', { ...base, book: 'shop', segment: 'dialog_cards', clientRef: ref() });
    expect([b.status, err(b).code]).toEqual([400, 'SEGMENT_NOT_ALLOWED']);
    const c = await post(s.app, '/expenses', { ...base, book: 'telecom', segment: 'legacy', clientRef: ref() });
    expect([c.status, err(c).code]).toEqual([409, 'SEGMENT_LEGACY_REFUSED']);
    expect(sql(s, 'SELECT COUNT(*) AS n FROM expenses')[0]!.n).toBe(0);
  });

  it('cash drawing: same rules; the segment is stored on the drawing and its cash entry', async () => {
    const s = await setup();
    const a = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), book: 'telecom', amountCents: 500, clientRef: ref() });
    expect([a.status, err(a).code]).toEqual([400, 'SEGMENT_REQUIRED']);
    const b = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), book: 'shop', segment: 'hutch_cards', amountCents: 500, clientRef: ref() });
    expect([b.status, err(b).code]).toEqual([400, 'SEGMENT_NOT_ALLOWED']);
    const ok = await drawCash(s, { book: 'telecom', segment: 'mobitel_cards', amountCents: 700 });
    expect(ok.status).toBe(201);
    expect(ok.body.item.segment).toBe('mobitel_cards');
    expect(sql(s, "SELECT segment, amount_cents FROM cash_entries WHERE ref_table = 'owner_drawings'")).toEqual([{ segment: 'mobitel_cards', amount_cents: -700 }]);
  });

  it('transfer: every Telecom side names its segment (field fromSegment / toSegment), a non-Telecom side refuses one', async () => {
    const s = await setup();
    const a = await post(s.app, '/cash-transfers', { businessDate: today(), fromBook: 'shop', toBook: 'telecom', amountCents: 100, clientRef: ref() });
    expect(err(a)).toMatchObject({ code: 'SEGMENT_REQUIRED', fields: { toSegment: expect.any(String) } });
    const b = await post(s.app, '/cash-transfers', { businessDate: today(), fromBook: 'telecom', toBook: 'shop', amountCents: 100, clientRef: ref() });
    expect(err(b)).toMatchObject({ code: 'SEGMENT_REQUIRED', fields: { fromSegment: expect.any(String) } });
    const c = await post(s.app, '/cash-transfers', { businessDate: today(), fromBook: 'shop', toBook: 'telecom', fromSegment: 'dialog_cards', toSegment: 'dialog_cards', amountCents: 100, clientRef: ref() });
    expect(err(c)).toMatchObject({ code: 'SEGMENT_NOT_ALLOWED', fields: { fromSegment: expect.any(String) } });
    expect(sql(s, 'SELECT COUNT(*) AS n FROM cash_transfers')[0]!.n).toBe(0);
  });
});

describe('per-segment balances, void, filters', () => {
  it('expenses and drawings move only their own segment; voids reverse in the same segment; Telecom total = sum of segments', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 100000, mobitel_cards: 50000 });
    const e = await expNew(s, { book: 'telecom', segment: 'mobitel_cards', amountCents: 3000 });
    const d = await drawCash(s, { book: 'telecom', segment: 'dialog_reloads', amountCents: 7000 });
    expect(e.body.item.segment).toBe('mobitel_cards');
    expect(seg.balance(s, 'mobitel_cards')).toBe(47000);
    expect(seg.balance(s, 'dialog_reloads')).toBe(93000);
    expect(seg.total(s)).toBe(seg.sumOfSegments(s));
    expect((await expVoid(s, e.body.item.id)).status).toBe(200);
    expect((await post(s.app, `/drawings/${d.body.item.id}/void`, { reason: 'x' })).status).toBe(200);
    expect(seg.balance(s, 'mobitel_cards')).toBe(50000);
    expect(seg.balance(s, 'dialog_reloads')).toBe(100000);
    expect(sql(s, "SELECT COUNT(*) AS n FROM cash_entries WHERE ref_table IN ('expenses','owner_drawings') AND reverses_entry_id IS NOT NULL AND segment IN ('mobitel_cards','dialog_reloads')")[0]!.n).toBe(2);
    expect(seg.total(s)).toBe(seg.sumOfSegments(s));
  });

  it('lists carry the segment and filter by ?segment=', async () => {
    const s = await setup();
    await expNew(s, { book: 'telecom', segment: 'airtel_reloads', amountCents: 100 });
    await expNew(s, { book: 'telecom', segment: 'hutch_cards', amountCents: 200 });
    await expNew(s, { book: 'shop', amountCents: 300 });
    const l = (await get(s.app, '/expenses?segment=airtel_reloads')).body;
    expect(l.items.map((i: any) => [i.segment, i.amountCents])).toEqual([['airtel_reloads', 100]]);
    expect(l.totals.amountCents).toBe(100);
    expect((await get(s.app, '/expenses')).body.items.map((i: any) => i.segment).sort()).toEqual(['airtel_reloads', 'hutch_cards', null].sort());
    await drawCash(s, { book: 'telecom', segment: 'hutch_cards', amountCents: 50 });
    expect((await get(s.app, '/drawings?segment=hutch_cards')).body.items).toHaveLength(1);
    await tr(s, 'telecom', 'telecom', 10, { fromSegment: 'hutch_cards', toSegment: 'airtel_cards' });
    expect((await get(s.app, '/cash-transfers?segment=airtel_cards')).body.items).toHaveLength(1);
    expect((await get(s.app, '/cash-transfers?segment=dialog_cards')).body.items).toHaveLength(0);
  });
});

describe('Telecom to Telecom transfers', () => {
  it('moves money between two segments: both legs carry their segment, Telecom total unchanged, void reverses both', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 100000, mobitel_cards: 20000 });
    const totalBefore = seg.total(s);
    const r = await tr(s, 'telecom', 'telecom', 30000, { fromSegment: 'dialog_reloads', toSegment: 'mobitel_cards' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ fromBook: 'telecom', toBook: 'telecom', fromSegment: 'dialog_reloads', toSegment: 'mobitel_cards' });
    const legs = legsOf(s, r.body.item.id);
    expect(legs.map((l) => [l.type, l.segment, l.amount_cents])).toEqual([['transfer_out', 'dialog_reloads', -30000], ['transfer_in', 'mobitel_cards', 30000]]);
    expect(seg.balance(s, 'dialog_reloads')).toBe(70000);
    expect(seg.balance(s, 'mobitel_cards')).toBe(50000);
    expect(seg.total(s)).toBe(totalBefore);
    const v = await trVoid(s, r.body.item.id);
    expect(v.status).toBe(200);
    expect(seg.balance(s, 'dialog_reloads')).toBe(100000);
    expect(seg.balance(s, 'mobitel_cards')).toBe(20000);
    expect(legsOf(s, r.body.item.id)).toHaveLength(4);
    expect(seg.total(s)).toBe(seg.sumOfSegments(s));
  });

  it('the same segment on both sides is refused (SAME_SEGMENT) and writes nothing', async () => {
    const s = await setup();
    const r = await tr(s, 'telecom', 'telecom', 100, { fromSegment: 'hutch_reloads', toSegment: 'hutch_reloads' });
    expect([r.status, err(r).code]).toEqual([400, 'SAME_SEGMENT']);
    expect(sql(s, 'SELECT COUNT(*) AS n FROM cash_transfers')[0]!.n).toBe(0);
  });

  it('Shop to a Telecom segment and back credit and debit only that segment', async () => {
    const s = await setup();
    await post(s.app, '/cashbooks/shop/opening', { businessDate: today(), amountCents: 90000, clientRef: ref() });
    const r = await tr(s, 'shop', 'telecom', 40000, { toSegment: 'airtel_cards' });
    expect(r.status).toBe(201);
    expect(seg.balance(s, 'airtel_cards')).toBe(40000);
    expect((await trVoid(s, r.body.item.id)).status).toBe(200);
    expect(seg.balance(s, 'airtel_cards')).toBe(0);
  });
});

describe('closed days are per segment', () => {
  it('a closed day of Dialog Reloads blocks only Dialog Reloads for expenses and drawings', async () => {
    const s = await setup();
    await seg.closeOk(s, 'dialog_reloads', today());
    const blocked = await expNew(s, { book: 'telecom', segment: 'dialog_reloads' });
    expect([blocked.status, err(blocked).code]).toEqual([409, 'DAY_CLOSED']);
    expect(err(blocked).message).toContain('Dialog Reloads');
    expect((await expNew(s, { book: 'telecom', segment: 'mobitel_reloads' })).status).toBe(201);
    expect((await drawCash(s, { book: 'telecom', segment: 'dialog_reloads' })).status).toBe(409);
    expect((await drawCash(s, { book: 'telecom', segment: 'mobitel_cards' })).status).toBe(201);
  });

  it('a transfer is refused when EITHER side segment is closed, for create and for void; reopening lets it through', async () => {
    const s = await setup();
    const ok = await tr(s, 'telecom', 'telecom', 100, { fromSegment: 'dialog_reloads', toSegment: 'hutch_cards' });
    expect(ok.status).toBe(201);
    const closedTo = await seg.closeOk(s, 'hutch_cards', today());
    const a = await tr(s, 'telecom', 'telecom', 100, { fromSegment: 'dialog_reloads', toSegment: 'hutch_cards' });
    expect([a.status, err(a).code]).toEqual([409, 'DAY_CLOSED']);
    expect(err(a).message).toContain('Hutch Cards');
    expect((await trVoid(s, ok.body.item.id)).status).toBe(409);
    // an unrelated pair of segments is unaffected
    expect((await tr(s, 'telecom', 'telecom', 100, { fromSegment: 'dialog_reloads', toSegment: 'airtel_cards' })).status).toBe(201);
    expect((await post(s.app, `/daily-closings/${closedTo.id}/reopen`, { reason: 'fix' })).status).toBe(200);
    expect((await trVoid(s, ok.body.item.id)).status).toBe(200);
  });
});

describe('negative cash warnings per scope', () => {
  it('an expense warns about its own segment, not the Telecom total', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 1000000 });
    const r = await expNew(s, { book: 'telecom', segment: 'hutch_cards', amountCents: 500 });
    expect(r.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', segment: 'hutch_cards', balanceCents: -500 })]);
    const d = await drawCash(s, { book: 'telecom', segment: 'dialog_reloads', amountCents: 100 });
    expect(d.body.warnings).toEqual([]);
  });

  it('a transfer warns about the SOURCE scope only', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 1000 });
    const r = await tr(s, 'telecom', 'telecom', 5000, { fromSegment: 'dialog_reloads', toSegment: 'mobitel_reloads' });
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([expect.objectContaining({ segment: 'dialog_reloads', balanceCents: -4000 })]);
  });
});

describe('corrections keep or take the segment', () => {
  it('an expense correction keeps the original segment by default and takes a supplied one', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 100000, mobitel_cards: 100000 });
    const o = (await expNew(s, { book: 'telecom', segment: 'mobitel_cards', amountCents: 2000 })).body.item;
    const k = await fixExp(s, o.id, { amountCents: 2500 });
    expect(k.status).toBe(201);
    expect(k.body.replacement.segment).toBe('mobitel_cards');
    expect(seg.balance(s, 'mobitel_cards')).toBe(97500);
    const m = await fixExp(s, k.body.replacement.id, { segment: 'dialog_reloads', amountCents: 2500 });
    expect(m.status).toBe(201);
    expect(m.body.replacement.segment).toBe('dialog_reloads');
    expect(seg.balance(s, 'mobitel_cards')).toBe(100000);
    expect(seg.balance(s, 'dialog_reloads')).toBe(97500);
    expect(seg.total(s)).toBe(seg.sumOfSegments(s));
  });

  it('a cash drawing correction keeps the segment; changing the book to Shop drops it', async () => {
    const s = await setup();
    const o = (await drawCash(s, { book: 'telecom', segment: 'airtel_reloads', amountCents: 400 })).body.item;
    const k = await fixDraw(s, o.id, { amountCents: 450 });
    expect(k.body.replacement).toMatchObject({ segment: 'airtel_reloads', amountCents: 450 });
    const sh = await fixDraw(s, k.body.replacement.id, { book: 'shop' });
    expect(sh.status).toBe(201);
    expect(sh.body.replacement.segment).toBeNull();
  });

  it('a transfer correction keeps both segments by default; a Telecom side whose original had none must name one', async () => {
    const s = await setup();
    const o = (await tr(s, 'telecom', 'telecom', 1000, { fromSegment: 'dialog_reloads', toSegment: 'mobitel_reloads' })).body.item;
    const k = await fixTr(s, o.id, { fromBook: 'telecom', toBook: 'telecom', amountCents: 1200 });
    expect(k.status).toBe(201);
    expect(k.body.replacement).toMatchObject({ fromSegment: 'dialog_reloads', toSegment: 'mobitel_reloads', amountCents: 1200 });
    const t = await fixTr(s, k.body.replacement.id, { fromBook: 'telecom', toBook: 'telecom', toSegment: 'hutch_reloads' });
    expect(t.body.replacement).toMatchObject({ fromSegment: 'dialog_reloads', toSegment: 'hutch_reloads' });
    const same = await fixTr(s, t.body.replacement.id, { fromBook: 'telecom', toBook: 'telecom', toSegment: 'dialog_reloads' });
    expect([same.status, err(same).code]).toEqual([400, 'SAME_SEGMENT']);
    expect(sql(s, "SELECT status FROM cash_transfers WHERE id = ?", t.body.replacement.id)[0]!.status).toBe('posted');
  });

  it('a legacy original can be corrected only with a real segment supplied', async () => {
    const s = await setup();
    const conn = s.ctx.database.conn;
    // a pre-segment expense, written the way the migration left it: segment legacy on the record and its cash entry
    const names = (conn.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('expenses','cash_entries') AND sql LIKE '%legacy%'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const n of names) conn.exec(`DROP TRIGGER "${n}"`);
    conn.prepare("INSERT INTO expenses (business_date, book, segment, category, amount_cents, description, notes, client_ref) VALUES (?, 'telecom', 'legacy', 'other', 900, 'old', '', ?)").run(today(), ref());
    const id = Number((conn.prepare('SELECT MAX(id) AS i FROM expenses').get() as { i: number }).i);
    conn.prepare("INSERT INTO cash_entries (book, segment, business_date, type, amount_cents, ref_table, ref_id) VALUES ('telecom', 'legacy', ?, 'expense', -900, 'expenses', ?)").run(today(), id);
    const before = seg.balance(s, 'legacy');
    const noSeg = await fixExp(s, id, { amountCents: 900 });
    expect([noSeg.status, err(noSeg).code]).toEqual([400, 'SEGMENT_REQUIRED']);
    expect(sql(s, 'SELECT status FROM expenses WHERE id = ?', id)[0]!.status).toBe('posted');
    const withLegacy = await fixExp(s, id, { segment: 'legacy', amountCents: 900 });
    expect([withLegacy.status, err(withLegacy).code]).toEqual([409, 'SEGMENT_LEGACY_REFUSED']);
    const real = await fixExp(s, id, { segment: 'dialog_reloads', amountCents: 900 });
    expect(real.status).toBe(201);
    expect(seg.balance(s, 'legacy')).toBe(before + 900); // the void reversed in legacy, the replacement is in dialog_reloads
    expect(seg.balance(s, 'dialog_reloads')).toBe(-900);
  });
});
