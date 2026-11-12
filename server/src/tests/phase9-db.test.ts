// Phase 9 database rules (migration 013: cash_transfers, the transfer-leg link on cash_entries, the cash-drawing amount guard) -
// raw SQL on in-memory SQLite. Protects the schema-level guarantees even if a service forgot a check:
//   8       a transfer has two DIFFERENT books (from <> to); amount 1..10^12; unique client_ref;
//   10.2    a fund is named exactly on the Ice Cream side(s) (CHECKs on both sides);
//   R1      a transfer is never edited and never deleted; the only change is posted -> void (with voided_at + void_reason), never back;
//   R-FD    no future date; business_date and posted_at never change; the date must be a real calendar day;
//   legs    a transfer_out / transfer_in ledger row must match its transfer (id, side, book, fund); no other row may carry a transfer id;
//   9       a CASH drawing must be at least 1 cent (goods drawings keep their old rule).

import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrations } from '../db/migrate.ts';
import { daysAgo, daysAhead, memDb, msgOf, scalar, sqlProduct } from './helpers/inventory.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns) { try { c.close(); } catch { /* ignore */ } } conns.length = 0; });

let seq = 0;
const uniq = (): string => `db9-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
const today = (): string => daysAgo(0);
const names = (c: DatabaseSync, type: string) =>
  (c.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as unknown as { name: string }[]).map((r) => r.name);

type Row = Record<string, string | number | null>;
function insert(c: DatabaseSync, table: string, defaults: Row, over: Row): number {
  const row = { ...defaults, ...over };
  const cols = Object.keys(row);
  return Number(c.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
/** A valid Shop -> Telecom transfer of 1,000 cents; any column can be overridden. */
const transfer = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'cash_transfers', { business_date: today(), from_book: 'shop', to_book: 'telecom', amount_cents: 1000, client_ref: uniq() }, o);
const leg = (c: DatabaseSync, o: Row = {}) =>
  insert(c, 'cash_entries', { book: 'shop', business_date: today(), type: 'transfer_out', amount_cents: -1000, transfer_id: null }, o);
const upd = (c: DatabaseSync, set: string, id: number, ...p: Array<string | number | null>) =>
  c.prepare(`UPDATE cash_transfers SET ${set} WHERE id = ?`).run(...p, id);

describe('migration 013', () => {
  it('fresh DB has cash_transfers with its triggers; migration file 013_cash_transfers.sql is loaded', () => {
    const c = memDb(conns);
    expect(loadMigrations().some((m) => m.name === '013_cash_transfers.sql')).toBe(true);
    expect(names(c, 'table')).toContain('cash_transfers');
    expect(names(c, 'trigger')).toEqual(expect.arrayContaining([
      'trg_cash_transfers_future_date', 'trg_cash_transfers_business_date_immutable', 'trg_cash_transfers_posted_at_immutable',
      'trg_cash_transfers_immutable', 'trg_cash_transfers_no_delete', 'trg_cash_entries_transfer_link', 'trg_owner_drawings_cash_amount',
    ]));
  });
});

describe('cash_transfers - constraints', () => {
  it('a valid transfer is stored as posted with a posting time', () => {
    const c = memDb(conns);
    const id = transfer(c);
    expect(c.prepare('SELECT status, voided_at, void_reason, posted_at, note FROM cash_transfers WHERE id = ?').get(id)).toMatchObject({ status: 'posted', voided_at: null, void_reason: null, note: '' });
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_transfers')).toBe(1);
  });

  it('from_book <> to_book: the same book on both sides is refused (every book)', () => {
    const c = memDb(conns);
    for (const book of ['shop', 'telecom']) expect(msgOf(() => transfer(c, { from_book: book, to_book: book })), book).toMatch(/CHECK constraint/);
    expect(msgOf(() => transfer(c, { from_book: 'icecream', to_book: 'icecream', from_fund: 'cost', to_fund: 'profit' }))).toMatch(/CHECK constraint/);
  });

  it('10.2: the fund is set exactly on the Ice Cream side(s) - both directions and both sides', () => {
    const c = memDb(conns);
    expect(msgOf(() => transfer(c, { from_book: 'icecream', to_book: 'shop' }))).toMatch(/CHECK constraint/); // fund missing on Ice Cream source
    expect(msgOf(() => transfer(c, { from_book: 'shop', to_book: 'icecream' }))).toMatch(/CHECK constraint/); // fund missing on Ice Cream destination
    expect(msgOf(() => transfer(c, { from_fund: 'cost' }))).toMatch(/CHECK constraint/); // fund on a Shop source
    expect(msgOf(() => transfer(c, { to_fund: 'profit' }))).toMatch(/CHECK constraint/); // fund on a Telecom destination
    expect(msgOf(() => transfer(c, { from_book: 'icecream', to_book: 'shop', from_fund: 'rent' }))).toMatch(/CHECK constraint/); // unknown fund
    expect(transfer(c, { from_book: 'icecream', to_book: 'shop', from_fund: 'cost' })).toBeGreaterThan(0);
    expect(transfer(c, { from_book: 'telecom', to_book: 'icecream', to_fund: 'electricity' })).toBeGreaterThan(0);
  });

  it('amount 1..10^12 (0, negatives and 10^12 + 1 refused; the bounds themselves accepted)', () => {
    const c = memDb(conns);
    for (const a of [0, -1, 1000000000001]) expect(msgOf(() => transfer(c, { amount_cents: a })), String(a)).toMatch(/CHECK constraint/);
    expect(transfer(c, { amount_cents: 1 })).toBeGreaterThan(0);
    expect(transfer(c, { amount_cents: 1000000000000 })).toBeGreaterThan(0);
  });

  it('unknown book values refused; client_ref is unique', () => {
    const c = memDb(conns);
    expect(msgOf(() => transfer(c, { from_book: 'bank' }))).toMatch(/CHECK constraint/);
    expect(msgOf(() => transfer(c, { to_book: 'bank' }))).toMatch(/CHECK constraint/);
    transfer(c, { client_ref: 'same-ref-9' });
    expect(msgOf(() => transfer(c, { client_ref: 'same-ref-9' }))).toMatch(/UNIQUE/);
  });

  it('R-FD: a future date is refused by the trigger; impossible and badly shaped dates by the CHECK; today and the past are fine', () => {
    const c = memDb(conns);
    expect(msgOf(() => transfer(c, { business_date: daysAhead(1) }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    for (const d of ['2020-13-01', '2026-02-30', '20260101', '2026-1-1', '']) expect(msgOf(() => transfer(c, { business_date: d })), d).toMatch(/CHECK constraint|INVALID|FUTURE_DATE_NOT_ALLOWED/); // SQLite runs BEFORE triggers before CHECKs, so a badly shaped date may report the trigger
    expect(transfer(c, { business_date: today() })).toBeGreaterThan(0);
    expect(transfer(c, { business_date: daysAgo(400) })).toBeGreaterThan(0);
  });

  it('status void needs voided_at AND void_reason; posted must have neither', () => {
    const c = memDb(conns);
    expect(msgOf(() => transfer(c, { status: 'void' }))).toMatch(/CHECK constraint/);
    expect(msgOf(() => transfer(c, { status: 'void', voided_at: '2026-01-01T00:00:00.000Z' }))).toMatch(/CHECK constraint/);
    expect(msgOf(() => transfer(c, { voided_at: '2026-01-01T00:00:00.000Z' }))).toMatch(/CHECK constraint/);
    expect(msgOf(() => transfer(c, { status: 'cancelled' }))).toMatch(/CHECK constraint/);
    expect(transfer(c, { status: 'void', voided_at: '2026-01-01T00:00:00.000Z', void_reason: 'x' })).toBeGreaterThan(0);
  });
});

describe('cash_transfers - R1 immutability and delete guards', () => {
  it.each([
    ['from_book', "from_book = 'icecream', from_fund = 'cost'", []],
    ['to_book', "to_book = 'icecream', to_fund = 'cost'", []],
    ['amount_cents', 'amount_cents = 5', []],
    ['note', "note = 'changed'", []],
    ['client_ref', "client_ref = 'other-ref-9'", []],
    ['id', 'id = 777', []],
  ])('%s cannot be edited', (_name, set) => {
    const c = memDb(conns);
    const id = transfer(c);
    expect(msgOf(() => upd(c, set as string, id))).toMatch(/CASH_TRANSFER_IMMUTABLE|CHECK constraint/);
    expect(scalar(c, 'SELECT amount_cents FROM cash_transfers WHERE id = ?', id)).toBe(1000);
  });

  it('funds cannot be edited either', () => {
    const c = memDb(conns);
    const id = transfer(c, { from_book: 'icecream', to_book: 'shop', from_fund: 'cost' });
    expect(msgOf(() => upd(c, "from_fund = 'profit'", id))).toMatch(/CASH_TRANSFER_IMMUTABLE/);
  });

  it('business_date and posted_at never change', () => {
    const c = memDb(conns);
    const id = transfer(c);
    expect(msgOf(() => upd(c, `business_date = '${daysAgo(1)}'`, id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msgOf(() => upd(c, "posted_at = '2020-01-01T00:00:00.000Z'", id))).toMatch(/POSTED_AT_IMMUTABLE/);
  });

  it('only posted -> void is allowed; void cannot be edited or re-opened; posted cannot get a reason without a void', () => {
    const c = memDb(conns);
    const id = transfer(c);
    expect(msgOf(() => upd(c, "void_reason = 'x'", id))).toMatch(/CASH_TRANSFER_IMMUTABLE|CHECK constraint/);
    upd(c, "status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'mistake'", id);
    expect(scalar(c, "SELECT COUNT(*) FROM cash_transfers WHERE status = 'void'")).toBe(1);
    expect(msgOf(() => upd(c, "status = 'posted', voided_at = NULL, void_reason = NULL", id))).toMatch(/CASH_TRANSFER_IMMUTABLE/);
    expect(msgOf(() => upd(c, "void_reason = 'other'", id))).toMatch(/CASH_TRANSFER_IMMUTABLE/);
    expect(msgOf(() => upd(c, "voided_at = '2027-01-01T00:00:00.000Z'", id))).toMatch(/CASH_TRANSFER_IMMUTABLE/);
  });

  it('a transfer cannot be deleted (RECORD_DELETE_FORBIDDEN), posted or void', () => {
    const c = memDb(conns);
    const a = transfer(c);
    const b = transfer(c, { status: 'void', voided_at: '2026-01-01T00:00:00.000Z', void_reason: 'x' });
    for (const id of [a, b]) expect(msgOf(() => c.prepare('DELETE FROM cash_transfers WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(msgOf(() => c.exec('DELETE FROM cash_transfers'))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_transfers')).toBe(2);
  });
});

describe('cash_entries - the transfer legs must match their transfer', () => {
  it('a correct pair is accepted: out of the source book, into the destination (with funds on the Ice Cream side)', () => {
    const c = memDb(conns);
    const t = transfer(c, { from_book: 'icecream', to_book: 'shop', from_fund: 'electricity' });
    expect(leg(c, { book: 'icecream', fund: 'electricity', type: 'transfer_out', amount_cents: -1000, transfer_id: t })).toBeGreaterThan(0);
    expect(leg(c, { book: 'shop', fund: null, type: 'transfer_in', amount_cents: 1000, transfer_id: t })).toBeGreaterThan(0);
    // a reversing leg (void) has the same shape and is accepted too
    expect(leg(c, { book: 'icecream', fund: 'electricity', type: 'transfer_out', amount_cents: 1000, transfer_id: t })).toBeGreaterThan(0);
  });

  it('transfer_out / transfer_in without a transfer id is refused', () => {
    const c = memDb(conns);
    expect(msgOf(() => leg(c, { type: 'transfer_out' }))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(msgOf(() => leg(c, { type: 'transfer_in', book: 'telecom', amount_cents: 1000 }))).toMatch(/TRANSFER_LEG_MISMATCH/);
  });

  it('a transfer id that does not exist is refused', () => {
    const c = memDb(conns);
    expect(msgOf(() => leg(c, { transfer_id: 424242 }))).toMatch(/TRANSFER_LEG_MISMATCH/);
  });

  it('the leg must sit in the right book for its side (out = source book, in = destination book)', () => {
    const c = memDb(conns);
    const t = transfer(c); // shop -> telecom
    expect(msgOf(() => leg(c, { book: 'telecom', type: 'transfer_out', transfer_id: t }))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(msgOf(() => leg(c, { book: 'shop', type: 'transfer_in', amount_cents: 1000, transfer_id: t }))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(msgOf(() => leg(c, { book: 'icecream', fund: 'cost', type: 'transfer_in', amount_cents: 1000, transfer_id: t }))).toMatch(/TRANSFER_LEG_MISMATCH/);
  });

  it('an Ice Cream leg must carry the fund its transfer names', () => {
    const c = memDb(conns);
    const t = transfer(c, { from_book: 'shop', to_book: 'icecream', to_fund: 'cost' });
    expect(msgOf(() => leg(c, { book: 'icecream', fund: 'profit', type: 'transfer_in', amount_cents: 1000, transfer_id: t }))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(leg(c, { book: 'icecream', fund: 'cost', type: 'transfer_in', amount_cents: 1000, transfer_id: t })).toBeGreaterThan(0);
  });

  it('no other kind of ledger row may carry a transfer id', () => {
    const c = memDb(conns);
    const t = transfer(c);
    expect(msgOf(() => leg(c, { type: 'expense', transfer_id: t }))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(msgOf(() => leg(c, { type: 'capital', amount_cents: 5, transfer_id: t }))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(leg(c, { type: 'expense', transfer_id: null })).toBeGreaterThan(0); // ordinary rows are unaffected
  });

  it('the ledger stays append-only: a transfer leg cannot be updated or deleted', () => {
    const c = memDb(conns);
    const t = transfer(c);
    const id = leg(c, { transfer_id: t });
    expect(msgOf(() => c.prepare('UPDATE cash_entries SET amount_cents = 5 WHERE id = ?').run(id))).toMatch(/append-only/);
    expect(msgOf(() => c.prepare('DELETE FROM cash_entries WHERE id = ?').run(id))).toBeTruthy();
  });
});

describe('owner_drawings - cash drawings need at least 1 cent', () => {
  const draw = (c: DatabaseSync, o: Row = {}) =>
    insert(c, 'owner_drawings', { business_date: today(), book: 'shop', kind: 'cash', amount_cents: 500, client_ref: uniq() }, o);

  it('a cash drawing of 0 or a negative amount is refused; over 10^12 refused; 1 and 10^12 accepted', () => {
    const c = memDb(conns);
    for (const a of [0, -1, 1000000000001]) expect(msgOf(() => draw(c, { amount_cents: a })), String(a)).toMatch(/CASH_DRAWING_AMOUNT|CHECK constraint/);
    expect(draw(c, { amount_cents: 1 })).toBeGreaterThan(0);
    expect(draw(c, { amount_cents: 1000000000000 })).toBeGreaterThan(0);
  });

  it('the Ice Cream cash drawing still needs its fund (existing CHECK) and a goods drawing of 0 is still allowed (worthless stock)', () => {
    const c = memDb(conns);
    expect(msgOf(() => draw(c, { book: 'icecream' }))).toMatch(/CHECK constraint/);
    expect(draw(c, { book: 'icecream', fund: 'cost' })).toBeGreaterThan(0);
    const p = sqlProduct(c);
    expect(draw(c, { kind: 'goods', amount_cents: 0, product_id: p, qty: 1 })).toBeGreaterThan(0);
  });
});
