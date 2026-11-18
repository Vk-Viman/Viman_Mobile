// Telecom segments: the PER-SEGMENT closed-day matrix (migration 026), raw SQL, no service.
// Every table that carries a closed-day trigger x INSERT and (where the table has one) the void / complete flip x
//   (a) every OTHER scope closed (Shop, Ice Cream, the other seven Telecom segments) -> allowed
//   (b) the same scope closed on an EARLIER date -> allowed
//   (c) the same scope closed on a LATER date -> BACKDATE_BEFORE_CLOSED_DAY
//   (d) the same scope closed on the SAME date -> DAY_CLOSED
//   (e) the closing reopened -> allowed again
// plus the special tables (cash transfers: either side; returns: the original's scope; stock movements: the product's scope; opening stock:
// header only when Shop and all four Cards segments are blocked, void judged by the scopes of its movements) and the unchanged zero-difference rule of cash counts.
// print_sales / printing_supplies / icecream_* keep their (segment-less) triggers and are covered by phase19/20 tests.

import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  BOOK_TABLES, CARDS, D, MAKE, RELOADS, SEGMENTS, TELECOM_ONLY_TABLES, all, cardProduct, err, freshDb, ins, one, providerId, providerOf, shopProduct, uniq,
} from './helpers/phase26db.ts';

type Book = 'shop' | 'telecom' | 'icecream';
interface Scope { book: Book; segment: string | null }
const sc = (book: Book, segment: string | null = null): Scope => ({ book, segment });
const SHOP = sc('shop');
const ICE = sc('icecream');
const TEL = SEGMENTS.map((s) => sc('telecom', s));
const ALL = [SHOP, ICE, ...TEL];
const same = (a: Scope, b: Scope): boolean => a.book === b.book && a.segment === b.segment;
const label = (s: Scope): string => (s.book === 'telecom' ? `telecom/${s.segment}` : s.book);

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const c of dbs.splice(0)) { try { c.close(); } catch { /* ignore */ } } });

// dates around D = 2025-03-10 (all in the past, so the future-date rule never interferes)
const EARLY = '2025-03-05';   // a closing before D
const LATE = '2025-03-20';    // a closing after D
const BEFORE = '2025-02-18';  // an insert date before EARLY

const close = (c: DatabaseSync, s: Scope, date: string): number =>
  MAKE.daily_closings!(c, { book: s.book, segment: s.segment, business_date: date });
const reopenAll = (c: DatabaseSync, s: Scope) => {
  c.prepare("UPDATE daily_closings SET reopened_at = closed_at, reopen_reason = 'matrix reopen' WHERE book = ? AND segment IS ? AND (reopened_at IS NULL OR closed_at > reopened_at)").run(s.book, s.segment);
};

interface Case {
  table: string;
  S: Scope;
  /** scopes that must NOT be closed in the "others closed" step (the counterparty of a two-sided record) */
  exclude?: Scope[];
  kind: 'insert' | 'flip';
  /** runs once, before any closing exists (parents, products) */
  prepare?: (c: DatabaseSync) => any;
  /** creates the row (insert cases: the statement under test; flip cases: the row to flip later) */
  make: (c: DatabaseSync, date: string, ctx: any) => number;
  flip?: (c: DatabaseSync, id: number) => void;
  name?: string;
}

const VOID = (table: string) => (c: DatabaseSync, id: number) => {
  c.prepare(`UPDATE ${table} SET status = 'void', voided_at = '2025-03-25T00:00:00.000Z', void_reason = 'matrix' WHERE id = ?`).run(id);
};

function rowFor(table: string, S: Scope, date: string, ctx: any): Record<string, string | number | null> {
  const r: Record<string, string | number | null> = { business_date: date };
  if ((BOOK_TABLES as readonly string[]).includes(table)) { r.book = S.book; r.segment = S.segment; if (S.book === 'icecream' && table !== 'daily_closings') r.fund = 'cost'; }
  else r.segment = S.segment;
  if (table === 'cash_counts') { r.expected_cents = 0; r.counted_cents = 1; r.difference_cents = 1; r.note = 'x'; }
  if (table === 'stock_losses') r.product_id = ctx.product;
  if (table === 'reload_sales') r.provider_id = providerId(ctx.c, providerOf(S.segment!));
  if (table === 'telecom_topups') { r.kind = 'provider_topup'; r.provider_id = providerId(ctx.c, providerOf(S.segment!)); }
  return r;
}

function plainCases(table: string, scopes: Scope[], withFlip: boolean): Case[] {
  const out: Case[] = [];
  for (const S of scopes) {
    const prepare = table === 'stock_losses' ? (c: DatabaseSync) => ({ c, product: S.book === 'shop' ? shopProduct(c) : cardProduct(c, providerOf(S.segment!)) }) : (c: DatabaseSync) => ({ c });
    const make = (c: DatabaseSync, date: string, ctx: any) => MAKE[table]!(c, rowFor(table, S, date, ctx));
    out.push({ table, S, kind: 'insert', prepare, make });
    if (withFlip) out.push({ table, S, kind: 'flip', prepare, make, flip: VOID(table) });
  }
  return out;
}

const CASES: Case[] = [
  ...plainCases('cash_entries', [SHOP, ICE, ...TEL], false),
  ...plainCases('cash_counts', [SHOP, ICE, ...TEL], true),
  ...plainCases('capital_entries', [SHOP, ICE, ...TEL], true),
  ...plainCases('owner_drawings', [SHOP, ICE, ...TEL], true),
  ...plainCases('expenses', [SHOP, ...TEL], true),
  ...plainCases('purchases', [SHOP, ...TEL.filter((s) => s.segment!.endsWith('_cards'))], true),
  ...plainCases('sales', [SHOP, ...TEL.filter((s) => s.segment!.endsWith('_cards'))], true),
  ...plainCases('stock_losses', [SHOP, ...TEL.filter((s) => s.segment!.endsWith('_cards'))], true),
  ...plainCases('reload_sales', TEL.filter((s) => s.segment!.endsWith('_reloads')), true),
  ...plainCases('ezcash_sales', [sc('telecom', 'dialog_reloads')], true),
  ...plainCases('telecom_topups', TEL.filter((s) => s.segment!.endsWith('_reloads')), true),
];

// ---- stocktakes: insert as completed, draft -> completed, completed -> void
for (const S of [SHOP, ...TEL.filter((s) => s.segment!.endsWith('_cards'))]) {
  const row = (date: string, status: string) => ({ business_date: date, book: S.book, segment: S.segment, status, completed_at: status === 'draft' ? null : '2025-03-01T00:00:00.000Z' });
  CASES.push({ table: 'stocktakes', S, kind: 'insert', name: 'stocktakes (insert completed)', make: (c, date) => MAKE.stocktakes!(c, row(date, 'completed')) });
  CASES.push({
    table: 'stocktakes', S, kind: 'flip', name: 'stocktakes (complete)', make: (c, date) => MAKE.stocktakes!(c, row(date, 'draft')),
    flip: (c, id) => { c.prepare("UPDATE stocktakes SET status = 'completed', completed_at = '2025-03-25T00:00:00.000Z' WHERE id = ?").run(id); },
  });
  CASES.push({
    table: 'stocktakes', S, kind: 'flip', name: 'stocktakes (void)', make: (c, date) => MAKE.stocktakes!(c, row(date, 'completed')),
    flip: (c, id) => { c.prepare("UPDATE stocktakes SET status = 'void', voided_at = '2025-03-25T00:00:00.000Z', void_reason = 'matrix' WHERE id = ?").run(id); },
  });
}

// ---- cash transfers: either side counts (a closed day of the counterparty is excluded in step (a))
const T = (c: DatabaseSync, date: string, o: Record<string, string | number | null>) => MAKE.cash_transfers!(c, { business_date: date, ...o });
for (const S of TEL) {
  CASES.push({ table: 'cash_transfers', S, exclude: [ICE], kind: 'insert', name: 'cash_transfers (from segment)', make: (c, d) => T(c, d, { from_book: 'telecom', from_segment: S.segment, to_book: 'icecream', to_fund: 'cost' }) });
  CASES.push({ table: 'cash_transfers', S, exclude: [ICE], kind: 'flip', name: 'cash_transfers (from segment)', make: (c, d) => T(c, d, { from_book: 'telecom', from_segment: S.segment, to_book: 'icecream', to_fund: 'cost' }), flip: VOID('cash_transfers') });
  CASES.push({ table: 'cash_transfers', S, exclude: [SHOP], kind: 'insert', name: 'cash_transfers (to segment)', make: (c, d) => T(c, d, { from_book: 'shop', to_book: 'telecom', to_segment: S.segment, to_fund: null }) });
  CASES.push({ table: 'cash_transfers', S, exclude: [SHOP], kind: 'flip', name: 'cash_transfers (to segment)', make: (c, d) => T(c, d, { from_book: 'shop', to_book: 'telecom', to_segment: S.segment, to_fund: null }), flip: VOID('cash_transfers') });
}
{
  const A = sc('telecom', 'dialog_reloads');
  const B = sc('telecom', 'mobitel_cards');
  for (const [S, O] of [[A, B], [B, A]] as Array<[Scope, Scope]>) {
    const mk = (c: DatabaseSync, d: string) => T(c, d, { from_book: 'telecom', from_segment: A.segment, to_book: 'telecom', to_segment: B.segment, to_fund: null });
    CASES.push({ table: 'cash_transfers', S, exclude: [O], kind: 'insert', name: `cash_transfers (telecom to telecom, judged by ${label(S)})`, make: mk });
    CASES.push({ table: 'cash_transfers', S, exclude: [O], kind: 'flip', name: `cash_transfers (telecom to telecom, judged by ${label(S)})`, make: mk, flip: VOID('cash_transfers') });
  }
  CASES.push({ table: 'cash_transfers', S: SHOP, exclude: [ICE], kind: 'insert', name: 'cash_transfers (shop side)', make: (c, d) => T(c, d, { from_book: 'shop', to_book: 'icecream', to_fund: 'cost' }) });
  CASES.push({ table: 'cash_transfers', S: ICE, exclude: [SHOP], kind: 'insert', name: 'cash_transfers (ice cream side)', make: (c, d) => T(c, d, { from_book: 'shop', to_book: 'icecream', to_fund: 'cost' }) });
  CASES.push({ table: 'cash_transfers', S: SHOP, exclude: [ICE], kind: 'flip', name: 'cash_transfers (shop side)', make: (c, d) => T(c, d, { from_book: 'shop', to_book: 'icecream', to_fund: 'cost' }), flip: VOID('cash_transfers') });
}

// ---- returns: the scope of the ORIGINAL sale / purchase; stock movements: the scope of the product (view)
for (const S of [SHOP, ...TEL.filter((s) => s.segment!.endsWith('_cards'))]) {
  CASES.push({
    table: 'sales_returns', S, kind: 'insert', prepare: (c) => ({ sale: MAKE.sales!(c, { book: S.book, segment: S.segment, business_date: '2025-01-01' }) }),
    make: (c, date, ctx) => ins(c, 'sales_returns', { sale_id: ctx.sale, business_date: date, refund_cents: 1, cogs_reversed_cents: 0, client_ref: uniq() }),
  });
  CASES.push({
    table: 'sales_returns', S, kind: 'flip', prepare: (c) => ({ sale: MAKE.sales!(c, { book: S.book, segment: S.segment, business_date: '2025-01-01' }) }),
    make: (c, date, ctx) => ins(c, 'sales_returns', { sale_id: ctx.sale, business_date: date, refund_cents: 1, cogs_reversed_cents: 0, client_ref: uniq() }),
    flip: VOID('sales_returns'),
  });
  CASES.push({
    table: 'purchase_returns', S, kind: 'insert', prepare: (c) => ({ pur: MAKE.purchases!(c, { book: S.book, segment: S.segment, business_date: '2025-01-01' }) }),
    make: (c, date, ctx) => ins(c, 'purchase_returns', { purchase_id: ctx.pur, business_date: date, refund_cents: 1, client_ref: uniq() }),
  });
  CASES.push({
    table: 'stock_movements', S, kind: 'insert', prepare: (c) => ({ p: S.book === 'shop' ? shopProduct(c) : cardProduct(c, providerOf(S.segment!)) }),
    make: (c, date, ctx) => ins(c, 'stock_movements', { product_id: ctx.p, business_date: date, type: 'adjustment', qty_delta: 0, value_delta_cents: 1 }),
  });
}

const insertOf = (cs: Case, c: DatabaseSync, date: string, ctx: any): string => err(() => cs.make(c, date, ctx));

function runInsertMatrix(cs: Case): void {
  const c = freshDb();
  dbs.push(c);
  const ctx = cs.prepare?.(c);
  const others = ALL.filter((o) => !same(o, cs.S) && !(cs.exclude ?? []).some((x) => same(x, o)));
  // (a) every other scope closed (on a LATER date, so only a scope mix-up could block): allowed
  for (const o of others) close(c, o, LATE);
  expect(insertOf(cs, c, D, ctx), `${cs.table} ${label(cs.S)}: other scopes closed must not block`).toBe('');
  // (b) the same scope closed EARLIER: a later-dated row is allowed, an earlier-dated one is a backdate
  close(c, cs.S, EARLY);
  expect(insertOf(cs, c, D, ctx), `${cs.table} ${label(cs.S)}: closed earlier, row later`).toBe('');
  expect(insertOf(cs, c, BEFORE, ctx), `${cs.table} ${label(cs.S)}: row before the closed day`).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
  // (c) the same scope closed LATER than the row
  close(c, cs.S, LATE);
  expect(insertOf(cs, c, D, ctx), `${cs.table} ${label(cs.S)}: closed later`).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
  // (d) the same scope closed on the row's own date
  close(c, cs.S, D);
  expect(insertOf(cs, c, D, ctx), `${cs.table} ${label(cs.S)}: closed the same day`).toMatch(/DAY_CLOSED/);
  expect(insertOf(cs, c, LATE, ctx), `${cs.table} ${label(cs.S)}: the closing day itself`).toMatch(/DAY_CLOSED/);
  // (e) reopened: allowed again
  reopenAll(c, cs.S);
  expect(insertOf(cs, c, D, ctx), `${cs.table} ${label(cs.S)}: reopened`).toBe('');
  expect(insertOf(cs, c, BEFORE, ctx), `${cs.table} ${label(cs.S)}: reopened, earlier`).toBe('');
}

function runFlipMatrix(cs: Case): void {
  const c = freshDb();
  dbs.push(c);
  const ctx = cs.prepare?.(c);
  const ids = [0, 1, 2, 3, 4].map(() => cs.make(c, D, ctx)); // rows exist BEFORE any closing
  const others = ALL.filter((o) => !same(o, cs.S) && !(cs.exclude ?? []).some((x) => same(x, o)));
  const flip = (id: number): string => err(() => cs.flip!(c, id));
  for (const o of others) close(c, o, LATE);
  expect(flip(ids[0]!), `${cs.table} ${label(cs.S)}: other scopes closed must not block the flip`).toBe('');
  close(c, cs.S, EARLY);
  expect(flip(ids[1]!), `${cs.table} ${label(cs.S)}: closed earlier than the row`).toBe('');
  close(c, cs.S, LATE);
  expect(flip(ids[2]!), `${cs.table} ${label(cs.S)}: closed later than the row`).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
  close(c, cs.S, D);
  expect(flip(ids[2]!), `${cs.table} ${label(cs.S)}: closed the same day`).toMatch(/DAY_CLOSED/);
  reopenAll(c, cs.S);
  expect(flip(ids[2]!), `${cs.table} ${label(cs.S)}: reopened`).toBe('');
  expect(flip(ids[3]!), `${cs.table} ${label(cs.S)}: reopened (2)`).toBe('');
}

describe('per-segment closed-day matrix: INSERT', () => {
  for (const cs of CASES.filter((x) => x.kind === 'insert')) {
    it(`${cs.name ?? cs.table} @ ${label(cs.S)}${cs.exclude ? ` (counterparty ${cs.exclude.map(label).join(',')})` : ''}`, () => runInsertMatrix(cs), 20000);
  }
});

describe('per-segment closed-day matrix: void / complete flips', () => {
  for (const cs of CASES.filter((x) => x.kind === 'flip')) {
    it(`${cs.name ?? cs.table} @ ${label(cs.S)}${cs.exclude ? ` (counterparty ${cs.exclude.map(label).join(',')})` : ''}`, () => runFlipMatrix(cs), 20000);
  }
});

describe('coverage of the matrix itself', () => {
  it('every table with a closed-day trigger of 026 is exercised', () => {
    const c = freshDb();
    dbs.push(c);
    const tables = new Set(all(c, "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg\\_%\\_day\\_closed%' ESCAPE '\\' AND sql LIKE '%d.segment IS%'").map((r) => String(r.tbl_name)));
    const covered = new Set([...CASES.map((x) => x.table), 'opening_stock_batches']);
    expect([...tables].sort()).toEqual([...covered].sort());
    expect(tables.size).toBe(17); // 15 tables with an insert trigger + stocktakes + opening_stock_batches are counted once each: 17 tables, 32 triggers
    expect(all(c, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg\\_%\\_day\\_closed%' ESCAPE '\\' AND sql LIKE '%d.segment IS%'").length).toBe(32);
    void TELECOM_ONLY_TABLES; void CARDS; void RELOADS;
  });
});

describe('cash counts: the unchanged zero-difference rule', () => {
  it('a count that matches (difference 0) is blocked only ON a closed day, never by a later closing; per segment', () => {
    const c = freshDb();
    dbs.push(c);
    const S = sc('telecom', 'dialog_reloads');
    const count = (date: string, o: Record<string, string | number | null> = {}) => err(() => MAKE.cash_counts!(c, { business_date: date, book: 'telecom', segment: S.segment, ...o }));
    close(c, S, LATE);
    expect(count(D)).toBe('');                                   // zero difference, closed later: allowed (as before the migration)
    expect(count(D, { expected_cents: 0, counted_cents: 1, difference_cents: 1, note: 'x' })).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(count(LATE)).toMatch(/DAY_CLOSED/);
    expect(count(LATE, { segment: 'mobitel_reloads' })).toBe(''); // another segment is open on that day
  });
});

describe('opening stock: header refused only when Shop and all four Cards segments are blocked; the void flip is judged by its movements', () => {
  const CARD_SCOPES = [SHOP, ...CARDS.map((s) => sc('telecom', s))];
  const header = (c: DatabaseSync, date: string): string => err(() => ins(c, 'opening_stock_batches', { business_date: date, source: 'manual', row_count: 1, total_value_cents: 1, client_ref: uniq() }));

  it('INSERT: all five (Shop + four Cards) closed -> refused; any one open, or only Reloads / Ice Cream closed -> allowed', () => {
    const c = freshDb();
    dbs.push(c);
    for (const o of [ICE, ...RELOADS.map((s) => sc('telecom', s))]) close(c, o, LATE);        // never count
    expect(header(c, D)).toBe('');
    for (const missing of CARD_SCOPES) {
      const cc = freshDb();
      dbs.push(cc);
      for (const o of CARD_SCOPES.filter((x) => !same(x, missing))) close(cc, o, LATE);
      expect(header(cc, D), `all but ${label(missing)} closed`).toBe('');
    }
    for (const o of CARD_SCOPES) close(c, o, LATE);
    expect(header(c, D)).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    for (const o of CARD_SCOPES) close(c, o, D);
    expect(header(c, D)).toMatch(/DAY_CLOSED/);
    for (const o of CARD_SCOPES) reopenAll(c, o);
    expect(header(c, D)).toBe('');
  });

  for (const S of [SHOP, ...CARDS.map((s) => sc('telecom', s))]) {
    it(`void flip of a batch with a movement in ${label(S)}: refused only when THAT scope is closed`, () => {
      const c = freshDb();
      dbs.push(c);
      const p = S.book === 'shop' ? shopProduct(c, false) : cardProduct(c, providerOf(S.segment!), false);
      const mkBatch = () => {
        const b = ins(c, 'opening_stock_batches', { business_date: D, source: 'manual', row_count: 1, total_value_cents: 1, client_ref: uniq() });
        const m = ins(c, 'stock_movements', { product_id: p, business_date: D, type: 'opening', qty_delta: 1, value_delta_cents: 1, ref_table: 'opening_stock_batches', ref_id: b });
        // the reversal movement a real void posts first (the void trigger of 020 insists on it); it is created BEFORE any closing exists
        ins(c, 'stock_movements', { product_id: p, business_date: D, type: 'opening', qty_delta: -1, value_delta_cents: -1, ref_table: 'opening_stock_batches', ref_id: b, reverses_movement_id: m });
        return b;
      };
      const batches = [mkBatch(), mkBatch(), mkBatch()];
      const voidIt = (id: number) => err(() => c.prepare("UPDATE opening_stock_batches SET status = 'void', voided_at = '2025-03-25T00:00:00.000Z', void_reason = 'matrix' WHERE id = ?").run(id));
      for (const o of ALL.filter((x) => !same(x, S))) close(c, o, LATE);
      expect(voidIt(batches[0]!), 'other scopes closed').toBe('');
      close(c, S, LATE);
      expect(voidIt(batches[1]!)).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
      close(c, S, D);
      expect(voidIt(batches[1]!)).toMatch(/DAY_CLOSED/);
      reopenAll(c, S);
      expect(voidIt(batches[1]!)).toBe('');
      expect(one(c, "SELECT COUNT(*) FROM opening_stock_batches WHERE status = 'void'")).toBe(2);
    });
  }
});

describe('what stays the same', () => {
  it('Shop and Ice Cream are judged by their own closings only; a Telecom closing never touches them and vice versa', () => {
    const c = freshDb();
    dbs.push(c);
    for (const s of TEL) close(c, s, LATE);
    expect(err(() => MAKE.expenses!(c, { book: 'shop', business_date: D }))).toBe('');
    expect(err(() => MAKE.cash_entries!(c, { book: 'icecream', fund: 'cost', business_date: D }))).toBe('');
    close(c, SHOP, LATE);
    expect(err(() => MAKE.expenses!(c, { book: 'shop', business_date: D }))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(err(() => MAKE.expenses!(c, { book: 'telecom', segment: 'airtel_cards', business_date: D }))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    const c2 = freshDb();
    dbs.push(c2);
    close(c2, SHOP, LATE);
    for (const s of SEGMENTS) expect(err(() => MAKE.expenses!(c2, { book: 'telecom', segment: s, business_date: D })), s).toBe('');
    // the error codes are the old ones
    expect(one(c2, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%DAY_CLOSED%' AND sql LIKE '%BACKDATE_BEFORE_CLOSED_DAY%'")).toBeGreaterThanOrEqual(32);
  });
});
