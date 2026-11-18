// Telecom segments, package B (core): closing, reopening, ordering, drawer counts, opening balances, negative warnings and ledgers PER SEGMENT
// (BUSINESS_RULES 13D, sections 8 and 13). Only core writes are used (opening balance, capital, cash count, closing, void), so this file does not
// depend on the Telecom / sales / purchase services. Every Telecom write names its segment; a closed day in one segment never closes the others.

import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { capVoid, closeNew, countNew, countVoid, openNew, reopenNew } from './helpers/phase8.ts';
import { capNew } from './helpers/phase9.ts';
import { seg } from './helpers/seg.ts';
import { SEGMENTS } from './helpers/segments.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const err = (r: { body: any }): any => r.body.error;

const D1 = daysAgo(1);
const D2 = daysAgo(2);
const D3 = daysAgo(3);

describe('a closing is per segment: closing one never closes the others', () => {
  it('closing dialog_reloads stores its segment and ITS expected balance only; mobitel_cards stays open for the same day', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 100000, mobitel_cards: 50000, hutch_reloads: 7000 }, D3);
    const item = await seg.closeOk(s, 'dialog_reloads', D2);
    expect(item).toMatchObject({ book: 'telecom', segment: 'dialog_reloads', businessDate: D2, expectedCents: 100000, countedCents: null, overShortCents: 0, isClosed: true });
    // the other seven segments are open for that very day
    for (const other of SEGMENTS.filter((x) => x !== 'dialog_reloads')) expect(seg.isClosed(s, other, D2), other).toBe(false);
    expect((await capNew(s, { book: 'telecom', segment: 'mobitel_cards', businessDate: D2, amountCents: 1000 })).status).toBe(201);
    expect((await capNew(s, { book: 'telecom', segment: 'hutch_reloads', businessDate: D2, amountCents: 1000 })).status).toBe(201);
    // ... while the closed segment refuses, naming it
    const refused = await capNew(s, { book: 'telecom', segment: 'dialog_reloads', businessDate: D2, amountCents: 1000 });
    expect(refused.status).toBe(409);
    expect(err(refused)).toMatchObject({
      code: 'DAY_CLOSED', book: 'telecom', segment: 'dialog_reloads', businessDate: D2,
      message: 'That day is closed for the Telecom - Dialog Reloads cash book. Reopen it first (it will be recorded in the audit log).',
    });
  });

  it('the status endpoint answers per segment and a missing segment on Telecom is 400 SEGMENT_REQUIRED', async () => {
    const s = await setup();
    await seg.closeOk(s, 'airtel_cards', D2);
    expect((await seg.status(s, 'airtel_cards', D2)).body).toEqual({ isClosed: true });
    expect((await seg.status(s, 'airtel_reloads', D2)).body).toEqual({ isClosed: false });
    expect((await seg.status(s, 'airtel_cards', D1)).body).toEqual({ isClosed: false });
    const none = await get(s.app, `/daily-closings/status?book=telecom&businessDate=${D2}`);
    expect(none.status).toBe(400);
    expect(err(none).code).toBe('SEGMENT_REQUIRED');
  });

  it('the same day can be closed once per segment (eight closings) and each keeps its own row; closing the same segment twice is DAY_ALREADY_CLOSED naming it', async () => {
    const s = await setup();
    const items = await seg.closeAll(s, D2);
    expect(items.map((i) => i.segment)).toEqual([...SEGMENTS]);
    expect(new Set(items.map((i) => i.id)).size).toBe(8);
    const dup = await seg.close(s, 'hutch_cards', D2);
    expect(dup.status).toBe(409);
    expect(err(dup)).toMatchObject({ code: 'DAY_ALREADY_CLOSED', book: 'telecom', segment: 'hutch_cards', message: 'That day is already closed for the Telecom - Hutch Cards cash book.' });
    expect((await get(s.app, `/daily-closings?book=telecom&segment=mobitel_reloads&from=${D2}&to=${D2}`)).body.items).toHaveLength(1);
    expect((await get(s.app, `/daily-closings?book=telecom&from=${D2}&to=${D2}`)).body.items).toHaveLength(8);
  });

  it('Shop and Ice Cream closings are untouched by segments (no segment on the row, Telecom closings do not block them)', async () => {
    const s = await setup();
    await seg.closeAll(s, D2);
    const shop = await closeNew(s, 'shop', D2);
    expect(shop.status).toBe(201);
    expect(shop.body.item.segment).toBeNull();
    expect((await closeNew(s, 'icecream', D2)).body.item.segment).toBeNull();
  });
});

describe('reopen and re-close are per segment', () => {
  it('reopening dialog_cards lets only dialog_cards write again; the re-close updates the same row and blocks again', async () => {
    const s = await setup();
    const a = await seg.closeOk(s, 'dialog_cards', D2);
    const b = await seg.closeOk(s, 'mobitel_cards', D2);
    expect((await reopenNew(s, a.id, 'late card sale')).status).toBe(200);
    expect(seg.isClosed(s, 'dialog_cards', D2)).toBe(false);
    expect(seg.isClosed(s, 'mobitel_cards', D2)).toBe(true);
    expect((await seg.capital(s, 'dialog_cards', 500, { businessDate: D2 })).status).toBe(201);
    expect(err(await seg.capital(s, 'mobitel_cards', 500, { businessDate: D2 })).code).toBe('DAY_CLOSED');
    const again = await seg.close(s, 'dialog_cards', D2);
    expect(again.status).toBe(201);
    expect(again.body.item).toMatchObject({ id: a.id, segment: 'dialog_cards', expectedCents: 500, isClosed: true }); // the closing now includes the late entry
    expect(err(await seg.capital(s, 'dialog_cards', 500, { businessDate: D2 })).code).toBe('DAY_CLOSED');
    expect(b.isClosed).toBe(true);
  });

  it('reopen names the segment when the day is not closed', async () => {
    const s = await setup();
    const a = await seg.closeOk(s, 'hutch_reloads', D2);
    await reopenNew(s, a.id, 'oops');
    const again = await reopenNew(s, a.id, 'twice');
    expect(again.status).toBe(409);
    expect(err(again)).toMatchObject({ code: 'DAY_NOT_CLOSED', message: 'That day is not closed for the Telecom - Hutch Reloads cash book.' });
  });
});

describe('the closed-day ordering rule is per segment', () => {
  it('a segment closed at D1 refuses earlier dates (BACKDATE_BEFORE_CLOSED_DAY naming it); other segments accept the same earlier date', async () => {
    const s = await setup();
    await seg.closeOk(s, 'dialog_reloads', D1);
    const early = await seg.capital(s, 'dialog_reloads', 100, { businessDate: D3 });
    expect(early.status).toBe(409);
    expect(err(early)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book: 'telecom', segment: 'dialog_reloads', closedDate: D1, businessDate: D3 });
    expect(err(early).message).toContain('Telecom - Dialog Reloads');
    expect((await seg.capital(s, 'mobitel_reloads', 100, { businessDate: D3 })).status).toBe(201);
    expect((await seg.capital(s, 'dialog_cards', 100, { businessDate: D3 })).status).toBe(201);
    // a LATER date of the closed segment is fine
    expect((await seg.capital(s, 'dialog_reloads', 100, { businessDate: daysAgo(0) })).status).toBe(201);
  });

  it('DAY_CLOSED of the exact day wins over the ordering rule and a reopened segment no longer counts as closed', async () => {
    const s = await setup();
    const a = await seg.closeOk(s, 'airtel_reloads', D2);
    await seg.closeOk(s, 'airtel_reloads', D1);
    expect(err(await seg.capital(s, 'airtel_reloads', 1, { businessDate: D2 })).code).toBe('DAY_CLOSED');
    await reopenNew(s, a.id, 'fix it');
    // D2 reopened, D1 still closed: D2 is earlier than the closed D1 -> ordering rule
    expect(err(await seg.capital(s, 'airtel_reloads', 1, { businessDate: D2 })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
  });
});

describe('drawer count and over/short are posted in the counted segment', () => {
  it('the expected amount is that segment\'s ledger balance; a short posts ONE cash_adjustment in that segment and moves no other segment', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 100000, mobitel_cards: 50000 }, D3);
    expect((await get(s.app, `/cash-counts/expected?book=telecom&segment=mobitel_cards&businessDate=${D2}`)).body).toEqual({ expectedCents: 50000 });
    expect((await get(s.app, `/cash-counts/expected?book=telecom&segment=dialog_reloads&businessDate=${D2}`)).body).toEqual({ expectedCents: 100000 });
    const r = await seg.count(s, 'mobitel_cards', 49000, { businessDate: D2, note: 'note missing' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ book: 'telecom', segment: 'mobitel_cards', expectedCents: 50000, countedCents: 49000, differenceCents: -1000 });
    const entry = seg.rows(s, 'mobitel_cards').find((e) => e.type === 'cash_adjustment')!;
    expect(entry).toMatchObject({ amount_cents: -1000, segment: 'mobitel_cards', ref_table: 'cash_counts', ref_id: r.body.item.id, business_date: D2 });
    expect(seg.balance(s, 'mobitel_cards')).toBe(49000);
    expect(seg.balance(s, 'dialog_reloads')).toBe(100000);
    expect(seg.total(s)).toBe(149000);
  });

  it('an over (counted above expected) is income of that segment; a matching count posts nothing; the void reverses inside the segment', async () => {
    const s = await setup();
    await seg.seed(s, { hutch_cards: 10000 }, D3);
    const over = await seg.count(s, 'hutch_cards', 12500, { businessDate: D2, note: 'found in the till' });
    expect(over.body.item).toMatchObject({ segment: 'hutch_cards', expectedCents: 10000, differenceCents: 2500 });
    expect(seg.balance(s, 'hutch_cards')).toBe(12500);
    const same = await seg.count(s, 'hutch_cards', 12500, { businessDate: D1 });
    expect(same.body.item).toMatchObject({ differenceCents: 0, cashEntryId: null });
    const v = await countVoid(s, over.body.item.id);
    expect(v.status).toBe(200);
    expect(seg.balance(s, 'hutch_cards')).toBe(10000);
    const rows = seg.rows(s, 'hutch_cards').filter((e) => e.ref_table === 'cash_counts');
    expect(rows.map((e) => [e.amount_cents, e.segment, e.reverses_entry_id !== null])).toEqual([[2500, 'hutch_cards', false], [-2500, 'hutch_cards', true]]);
  });

  it('a count needs its segment (400 SEGMENT_REQUIRED), is refused for Shop with one (400 SEGMENT_NOT_ALLOWED) and for legacy (409)', async () => {
    const s = await setup();
    const none = await post(s.app, '/cash-counts', { businessDate: D2, book: 'telecom', countedCents: 0, clientRef: ref() });
    expect(none.status).toBe(400);
    expect(err(none)).toMatchObject({ code: 'SEGMENT_REQUIRED', fields: { segment: 'Choose a segment.' } });
    const shop = await post(s.app, '/cash-counts', { businessDate: D2, book: 'shop', segment: 'dialog_cards', countedCents: 0, clientRef: ref() });
    expect(err(shop).code).toBe('SEGMENT_NOT_ALLOWED');
    const legacy = await post(s.app, '/cash-counts', { businessDate: D2, book: 'telecom', segment: 'legacy', countedCents: 0, clientRef: ref() });
    expect(legacy.status).toBe(409);
    expect(err(legacy).code).toBe('SEGMENT_LEGACY_REFUSED');
    expect((await get(s.app, `/cash-counts/expected?book=telecom&businessDate=${D2}`)).status).toBe(400);
  });

  it('a count is judged against the closed day of ITS segment only, and a clientRef reused for another segment is a conflict', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 1000, mobitel_reloads: 1000 }, D3);
    await seg.closeOk(s, 'dialog_reloads', D2);
    expect(err(await seg.count(s, 'dialog_reloads', 0, { businessDate: D2, note: 'x' })).code).toBe('DAY_CLOSED');
    const cref = ref();
    const ok = await seg.count(s, 'mobitel_reloads', 0, { businessDate: D2, note: 'x', clientRef: cref });
    expect(ok.status).toBe(201);
    expect((await seg.count(s, 'mobitel_reloads', 0, { businessDate: D2, note: 'x', clientRef: cref })).status).toBe(200); // same request repeated: no second count
    const other = await seg.count(s, 'airtel_reloads', 0, { businessDate: D2, note: 'x', clientRef: cref });
    expect(other.status).toBe(409);
    expect(err(other).code).toBe('CLIENT_REF_CONFLICT');
  });

  it('closing WITH a count: expected is that segment\'s balance before the adjustment, the adjustment is posted in the segment, then the day closes', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_cards: 80000, dialog_reloads: 20000 }, D3);
    const r = await seg.close(s, 'dialog_cards', D2, { countedCents: 79000, note: 'short by ten' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ segment: 'dialog_cards', expectedCents: 80000, countedCents: 79000, overShortCents: -1000, isClosed: true });
    expect(r.body.count).toMatchObject({ segment: 'dialog_cards', differenceCents: -1000 });
    expect(seg.balance(s, 'dialog_cards')).toBe(79000);
    expect(seg.balance(s, 'dialog_reloads')).toBe(20000);
    expect(seg.isClosed(s, 'dialog_reloads', D2)).toBe(false);
    // the retry of the same close (same clientRef) returns the same closing without a second count
    const retry = await seg.close(s, 'dialog_cards', D2, { countedCents: 79000, note: 'short by ten', clientRef: r.body.count.clientRef });
    expect(retry.status).toBe(200);
    expect(retry.body.item.id).toBe(r.body.item.id);
  });
});

describe('opening balance: one per scope', () => {
  it('each segment has its own opening balance; a second one in the same segment is OPENING_BALANCE_EXISTS naming it; a void frees the slot', async () => {
    const s = await setup();
    const a = await seg.open(s, 'dialog_reloads', 10000, { businessDate: D3 });
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ book: 'telecom', segment: 'dialog_reloads', kind: 'opening_balance', amountCents: 10000 });
    expect((await seg.open(s, 'mobitel_reloads', 20000, { businessDate: D3 })).status).toBe(201);
    const dup = await seg.open(s, 'dialog_reloads', 5, { businessDate: D3 });
    expect(dup.status).toBe(409);
    expect(err(dup)).toMatchObject({ code: 'OPENING_BALANCE_EXISTS', existingId: a.body.item.id });
    expect(err(dup).message).toContain('Telecom - Dialog Reloads');
    expect((await capVoid(s, a.body.item.id)).status).toBe(200);
    expect((await seg.open(s, 'dialog_reloads', 11000, { businessDate: D3 })).status).toBe(201);
    // listing: all of Telecom, or one segment
    const all = (await get(s.app, '/cashbooks/telecom/opening')).body.items;
    expect(all).toHaveLength(3);
    const one = (await get(s.app, '/cashbooks/telecom/opening?segment=mobitel_reloads')).body.items;
    expect(one.map((i: any) => [i.segment, i.amountCents])).toEqual([['mobitel_reloads', 20000]]);
    // Shop is still one per book and refuses a segment
    expect((await openNew(s, 'shop', { businessDate: D3 })).status).toBe(201);
    expect(err(await openNew(s, 'shop', { businessDate: D3 })).code).toBe('OPENING_BALANCE_EXISTS');
    expect(err(await post(s.app, '/cashbooks/shop/opening', { businessDate: D2, amountCents: 5, segment: 'dialog_cards', clientRef: ref() })).code).toBe('SEGMENT_NOT_ALLOWED');
  });

  it('a Telecom opening balance without a segment is 400 SEGMENT_REQUIRED; legacy cannot be chosen (409); the same clientRef for another segment conflicts', async () => {
    const s = await setup();
    const none = await post(s.app, '/cashbooks/telecom/opening', { businessDate: D2, amountCents: 5, clientRef: ref() });
    expect(err(none).code).toBe('SEGMENT_REQUIRED');
    expect(err(await post(s.app, '/cashbooks/telecom/opening', { businessDate: D2, amountCents: 5, segment: 'legacy', clientRef: ref() })).code).toBe('SEGMENT_LEGACY_REFUSED');
    const cref = ref();
    expect((await seg.open(s, 'hutch_cards', 5, { clientRef: cref })).status).toBe(201);
    expect((await seg.open(s, 'hutch_cards', 5, { clientRef: cref })).status).toBe(200);
    expect(err(await seg.open(s, 'airtel_cards', 5, { clientRef: cref })).code).toBe('CLIENT_REF_CONFLICT');
  });

  it('capital goes into the chosen segment and is refused without one; the capital list filters by segment', async () => {
    const s = await setup();
    expect(err(await post(s.app, '/capital', { businessDate: D2, book: 'telecom', amountCents: 5, clientRef: ref() })).code).toBe('SEGMENT_REQUIRED');
    await seg.capital(s, 'dialog_cards', 700, { businessDate: D2 });
    await seg.capital(s, 'hutch_cards', 300, { businessDate: D2 });
    const list = (await get(s.app, '/capital?book=telecom&segment=hutch_cards')).body;
    expect(list.items.map((i: any) => [i.segment, i.amountCents])).toEqual([['hutch_cards', 300]]);
    expect(list.totals.amountCents).toBe(300);
    expect((await get(s.app, '/capital?book=telecom')).body.totals.amountCents).toBe(1000);
  });
});

describe('the negative-cash warning is given per segment', () => {
  it('voiding an opening balance after a count left a segment below zero warns for THAT segment only; other segments stay silent', async () => {
    const s = await setup();
    const open = await seg.open(s, 'mobitel_reloads', 1000, { businessDate: D3 });
    await seg.seed(s, { dialog_reloads: 500000 }, D3);
    await seg.count(s, 'mobitel_reloads', 0, { businessDate: D2, note: 'all gone' }); // short 1000 -> 0
    const v = await capVoid(s, open.body.item.id);
    expect(v.status).toBe(200);
    expect(v.body.warnings).toHaveLength(1);
    expect(v.body.warnings[0]).toMatchObject({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', segment: 'mobitel_reloads', balanceCents: -1000 });
    expect(v.body.warnings[0].message).toContain('Telecom - Mobitel Reloads');
    // the Telecom TOTAL is far above zero, so the old per-book warning would have stayed silent: the summary lists the segment warning
    expect(seg.total(s)).toBe(499000);
    const summary = (await get(s.app, '/cashbooks')).body;
    expect(summary.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', segment: 'mobitel_reloads', balanceCents: -1000 })]);
    // Shop warnings keep their old shape (no segment key)
    await openNew(s, 'shop', { businessDate: D3, amountCents: 100 });
    await post(s.app, '/cash-counts', { businessDate: D2, book: 'shop', countedCents: 0, note: 'x', clientRef: ref() });
    const sv = (await get(s.app, '/cashbooks')).body;
    expect(sv.warnings.filter((w: any) => w.book === 'shop')).toEqual([]); // 0 is not below zero
  });
});

describe('ledgers: per segment, the read-only total, and the summary', () => {
  it('a segment ledger shows only its rows with running balance; the total ledger shows every segment and equals the sum', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 1000, dialog_cards: 4000 }, D3);
    await seg.capital(s, 'dialog_reloads', 250, { businessDate: D2 });
    await seg.capital(s, 'dialog_cards', 50, { businessDate: D1 });
    const dr = (await seg.ledger(s, 'dialog_reloads')).body;
    expect(dr).toMatchObject({ book: 'telecom', segment: 'dialog_reloads', openingCents: 0, inCents: 1250, outCents: 0, closingCents: 1250, total: 2 });
    expect(dr.items.map((i: any) => [i.type, i.amountCents, i.runningBalanceCents, i.segment])).toEqual([
      ['opening_balance', 1000, 1000, 'dialog_reloads'], ['capital', 250, 1250, 'dialog_reloads'],
    ]);
    const total = (await seg.ledger(s)).body;
    expect(total).toMatchObject({ book: 'telecom', segment: null, closingCents: 5300, total: 4, closedDates: [] });
    // business date, then posting order; every row names its own segment; the running balance is the running sum over ALL segments
    expect(total.items.map((i: any) => [i.segment, i.amountCents, i.runningBalanceCents])).toEqual([
      ['dialog_reloads', 1000, 1000], ['dialog_cards', 4000, 5000], ['dialog_reloads', 250, 5250], ['dialog_cards', 50, 5300],
    ]);
    // the sum of the segment ledgers = the total ledger
    const sum = (await Promise.all(SEGMENTS.map(async (x) => (await seg.ledger(s, x)).body.closingCents))).reduce((a: number, b: number) => a + b, 0);
    expect(sum).toBe(total.closingCents);
    // periods: opening = everything of the segment before `from`
    const period = (await seg.ledger(s, 'dialog_reloads', `from=${D2}`)).body;
    expect(period).toMatchObject({ openingCents: 1000, inCents: 250, closingCents: 1250 });
  });

  it('a ledger of Shop with a segment is 400 SEGMENT_NOT_ALLOWED and an unknown segment is a validation error', async () => {
    const s = await setup();
    const shop = await get(s.app, '/cashbooks/shop?segment=dialog_cards');
    expect(shop.status).toBe(400);
    expect(err(shop).code).toBe('SEGMENT_NOT_ALLOWED');
    expect((await get(s.app, '/cashbooks/telecom?segment=dialog')).status).toBe(400);
  });

  it('GET /cashbooks: Telecom lists all eight segments with label, balance and last closed day; the total is their sum', async () => {
    const s = await setup();
    await seg.seed(s, { dialog_reloads: 100, mobitel_cards: 200, hutch_reloads: 300 }, D3);
    await seg.closeOk(s, 'mobitel_cards', D2);
    const t = await seg.summary(s);
    expect(t.segments.map((x: any) => x.segment)).toEqual([...SEGMENTS]);
    expect(Object.fromEntries(t.segments.map((x: any) => [x.segment, x.balanceCents]))).toMatchObject({ dialog_reloads: 100, mobitel_cards: 200, hutch_reloads: 300, airtel_cards: 0 });
    expect(t.segments.find((x: any) => x.segment === 'mobitel_cards')).toEqual({ segment: 'mobitel_cards', label: 'Mobitel Cards', balanceCents: 200, lastClosedDate: D2 });
    expect(t.segments.find((x: any) => x.segment === 'dialog_reloads').lastClosedDate).toBeNull();
    expect(t.balanceCents).toBe(600);
    expect(t.segments.reduce((a: number, x: any) => a + x.balanceCents, 0)).toBe(t.balanceCents);
    expect(t.lastClosedDate).toBe(D2); // the book's newest closed day in any segment
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
    // Shop and Ice Cream carry no segments
    const books = (await get(s.app, '/cashbooks')).body.books;
    expect(books.find((b: any) => b.book === 'shop').segments).toBeUndefined();
  });
});

describe('legacy: "Telecom before segments" is read-only but reopenable (frozen schema-23 database upgraded)', () => {
  /** An app on a copy of the frozen schema-23 world: every Telecom row is legacy, the legacy day 2025-09-13 is closed. */
  async function legacyWorld(): Promise<ApiBase> {
    const dataDir = env.newDir();
    copyFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.db'), join(dataDir, 'viman.db'));
    return apiBase(await env.build({ dataDir }));
  }

  it('the summary lists the legacy segment (only because it has entries) with the old balance; the eight segments start at 0; the total is unchanged', async () => {
    const s = await legacyWorld();
    const t = await seg.summary(s);
    expect(t.segments.map((x: any) => x.segment)).toEqual([...SEGMENTS, 'legacy']);
    const legacy = t.segments.find((x: any) => x.segment === 'legacy');
    expect(legacy).toMatchObject({ label: 'Telecom before segments', balanceCents: 9834466, lastClosedDate: '2025-09-13' });
    expect(t.segments.filter((x: any) => x.segment !== 'legacy').every((x: any) => x.balanceCents === 0)).toBe(true);
    expect(t.balanceCents).toBe(9834466);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
  });

  it('the legacy ledger and the total ledger agree; the legacy segment refuses every new record (409 SEGMENT_LEGACY_REFUSED)', async () => {
    const s = await legacyWorld();
    const l = (await seg.ledger(s, 'legacy', 'limit=200')).body;
    const total = (await seg.ledger(s, undefined, 'limit=200')).body;
    expect(l.closingCents).toBe(9834466);
    expect(total.closingCents).toBe(9834466);
    expect(l.items.every((i: any) => i.segment === 'legacy')).toBe(true);
    expect(l.total).toBe(total.total);
    for (const r of [
      await post(s.app, '/capital', { businessDate: daysAgo(0), book: 'telecom', segment: 'legacy', amountCents: 5, clientRef: ref() }),
      await post(s.app, '/cashbooks/telecom/opening', { businessDate: daysAgo(0), segment: 'legacy', amountCents: 5, clientRef: ref() }),
      await post(s.app, '/cash-counts', { businessDate: daysAgo(0), book: 'telecom', segment: 'legacy', countedCents: 0, clientRef: ref() }),
    ]) {
      expect(r.status).toBe(409);
      expect(err(r).code).toBe('SEGMENT_LEGACY_REFUSED');
    }
  });

  it('a legacy closing can be reopened and re-closed (without a count) but a NEW legacy closing is refused; new segments are not blocked by the legacy closed day', async () => {
    const s = await legacyWorld();
    const closing = (await get(s.app, '/daily-closings?book=telecom&segment=legacy')).body.items.find((c: any) => c.isClosed);
    expect(closing).toMatchObject({ segment: 'legacy', businessDate: '2025-09-13' });
    // the legacy closed day does not block the other segments on that date, nor earlier dates of them
    expect((await seg.capital(s, 'dialog_reloads', 100, { businessDate: '2025-09-13' })).status).toBe(201);
    expect((await seg.capital(s, 'dialog_reloads', 100, { businessDate: '2025-08-01' })).status).toBe(201);
    // no new legacy closing, no legacy closing with a count
    const fresh = await seg.close(s, 'legacy', '2025-09-12');
    expect(fresh.status).toBe(409);
    expect(err(fresh).code).toBe('SEGMENT_LEGACY_REFUSED');
    expect(err(await seg.close(s, 'legacy', '2025-09-13', { countedCents: 1, note: 'x' })).code).toBe('SEGMENT_LEGACY_REFUSED');
    // reopen then re-close: the same row, same legacy segment, figures refreshed
    expect((await reopenNew(s, closing.id, 'legacy follow-up')).status).toBe(200);
    expect(seg.isClosed(s, 'legacy', '2025-09-13')).toBe(false);
    const re = await seg.close(s, 'legacy', '2025-09-13');
    expect(re.status).toBe(201);
    expect(re.body.item).toMatchObject({ id: closing.id, segment: 'legacy', isClosed: true });
    expect(seg.isClosed(s, 'legacy', '2025-09-13')).toBe(true);
    expect(seg.sumOfSegments(s)).toBe(seg.total(s));
  });
});

describe('Telecom writes that name no segment are refused', () => {
  it('opening, capital, count and closing without a segment: 400 SEGMENT_REQUIRED with the field; Shop with a segment: 400 SEGMENT_NOT_ALLOWED; unknown codes: 400', async () => {
    const s = await setup();
    const base = { businessDate: D2, clientRef: ref() };
    const cases = [
      post(s.app, '/cashbooks/telecom/opening', { ...base, amountCents: 5 }),
      post(s.app, '/capital', { ...base, book: 'telecom', amountCents: 5 }),
      post(s.app, '/cash-counts', { ...base, book: 'telecom', countedCents: 0 }),
      seg.rawClose(s, { ...base, book: 'telecom' }),
    ];
    for (const r of await Promise.all(cases)) {
      expect(r.status).toBe(400);
      expect(err(r)).toMatchObject({ code: 'SEGMENT_REQUIRED', fields: { segment: 'Choose a segment.' } });
    }
    expect(err(await seg.rawClose(s, { ...base, book: 'shop', segment: 'hutch_cards' })).code).toBe('SEGMENT_NOT_ALLOWED');
    expect(err(await seg.rawClose(s, { ...base, book: 'icecream', segment: 'hutch_cards' })).code).toBe('SEGMENT_NOT_ALLOWED');
    expect((await seg.rawClose(s, { ...base, book: 'telecom', segment: 'dialog' })).status).toBe(400);
    expect(await countRows(s)).toEqual({ closings: 0, entries: 0 }); // nothing was written by any refusal
  });
});

function countRows(s: ApiBase): { closings: number; entries: number } {
  const n = (t: string): number => Number((s.ctx.database.conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as unknown as { n: number | bigint }).n);
  return { closings: n('daily_closings'), entries: n('cash_entries') };
}
