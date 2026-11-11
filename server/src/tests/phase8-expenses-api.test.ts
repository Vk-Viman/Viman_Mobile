// Phase 8 expenses API (BUSINESS_RULES sections 1, 2, 7, 12; R1, R9, R13, R-FD, E1-E5). Protects:
//   - an expense is cash OUT of its own book (Shop or Telecom) with the type `expense`, audited with business date + backdated flag;
//   - E2: electricity is refused in every spelling (400 ELECTRICITY_NOT_ALLOWED, the exact owner wording); Ice Cream cannot have expenses;
//     no row, cash entry or audit row is written by a refused request;
//   - R-FD future dates refused, backdating accepted and flagged; clientRef makes a repeat return the first expense (no 2nd cash entry);
//   - R1 void = reversing cash entry + status void, never an edit; totals/lists count posted rows only; second void 409;
//   - R13 a cash-out that leaves the book negative returns the shared warning object (saved anyway);
//   - one transaction: a failing audit or cash insert leaves nothing behind.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, err, num, sql } from './helpers/phase4.ts';
import { EXPENSE_KEYS, bookBal, cashOfRef, expNew, expVoid, openNew, snap8 } from './helpers/phase8.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const ELECTRICITY_MSG = 'Electricity is paid from the Ice Cream book.';

describe('POST /expenses - create', () => {
  it('201 with the exact shape; cash OUT of the shop book (type expense); audit with business date and backdated=false', async () => {
    const s = await setup();
    const r = await expNew(s, { amountCents: 50000, category: 'rent', description: '  Shop rent  ', notes: 'November' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['item', 'warnings']);
    const it = r.body.item;
    expect(Object.keys(it).sort()).toEqual(EXPENSE_KEYS);
    expect(it).toMatchObject({ book: 'shop', category: 'rent', amountCents: 50000, description: 'Shop rent', notes: 'November', status: 'posted',
      backdated: false, businessDate: today(), voidedAt: null, voidReason: null });
    const cash = cashOfRef(s, 'expenses', it.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'shop', type: 'expense', amount_cents: -50000, fund: null, reverses_entry_id: null, business_date: today() });
    expect(bookBal(s, 'shop')).toBe(-50000);
    expect(bookBal(s, 'telecom')).toBe(0);
    const a = auditRows(s.ctx, 'expense');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', before: null, entityId: String(it.id) });
    const row = sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'expense'")[0]!;
    expect(row).toMatchObject({ business_date: today(), backdated: 0 });
    expect((await get(s.app, `/expenses/${it.id}`)).body.item).toEqual(it);
  });

  it('a telecom expense is cash out of the TELECOM book only', async () => {
    const s = await setup();
    const r = await expNew(s, { book: 'telecom', category: 'internet', amountCents: 30000 });
    expect(r.status).toBe(201);
    expect(bookBal(s, 'telecom')).toBe(-30000);
    expect(bookBal(s, 'shop')).toBe(0);
    expect(cashOfRef(s, 'expenses', r.body.item.id)[0]).toMatchObject({ book: 'telecom', type: 'expense', amount_cents: -30000 });
  });

  it('every one of the nine categories is accepted, in both books', async () => {
    const s = await setup();
    const cats = ['water', 'rent', 'internet', 'transport', 'repairs', 'cleaning_supplies', 'packaging', 'stationery', 'other'];
    for (const book of ['shop', 'telecom']) {
      for (const category of cats) expect((await expNew(s, { book, category, amountCents: 100 })).status, `${book}/${category}`).toBe(201);
    }
    expect(num(s, 'SELECT COUNT(*) FROM expenses')).toBe(18);
    expect(bookBal(s, 'shop')).toBe(-900);
    expect(bookBal(s, 'telecom')).toBe(-900);
  });

  it('GET /expenses/categories lists the nine categories with labels and NO electricity (E2)', async () => {
    const s = await setup();
    const r = await get(s.app, '/expenses/categories');
    expect(r.status).toBe(200);
    expect(r.body.items.map((c: any) => c.value)).toEqual(['water', 'rent', 'internet', 'transport', 'repairs', 'cleaning_supplies', 'packaging', 'stationery', 'other']);
    expect(r.body.items.find((c: any) => c.value === 'cleaning_supplies').label).toBe('Cleaning supplies');
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain('electric');
  });

  it.each(['electricity', 'Electricity', ' ELECTRICITY ', 'eLeCtRiCiTy'])('E2: category %j is refused with the exact owner message and writes nothing', async (category) => {
    const s = await setup();
    const before = snap8(s);
    for (const book of ['shop', 'telecom']) {
      const r = await expNew(s, { category, book });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe('ELECTRICITY_NOT_ALLOWED');
      expect(err(r).message).toBe(ELECTRICITY_MSG);
      expect(err(r).fields).toEqual({ category: ELECTRICITY_MSG });
    }
    expect(snap8(s)).toEqual(before);
  });

  it('Ice Cream cannot have expenses: 400 USE_ICECREAM_PAYMENTS, nothing written', async () => {
    const s = await setup();
    const before = snap8(s);
    const r = await expNew(s, { book: 'icecream' });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe('USE_ICECREAM_PAYMENTS');
    expect(err(r).fields).toHaveProperty('book');
    expect(snap8(s)).toEqual(before);
  });

  it('validation: unknown category, bad amounts, blank description, unknown/extra properties, bad dates', async () => {
    const s = await setup();
    const before = snap8(s);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ category: 'snacks' }, 'category'], [{ category: '' }, 'category'], [{ amountCents: 0 }, 'amountCents'], [{ amountCents: -5 }, 'amountCents'],
      [{ amountCents: 1.5 }, 'amountCents'], [{ amountCents: '500' }, 'amountCents'], [{ amountCents: null }, 'amountCents'],
      [{ amountCents: 1_000_000_000_001 }, 'amountCents'], [{ description: '   ' }, 'description'], [{ description: 'x'.repeat(201) }, 'description'],
      [{ notes: 'x'.repeat(501) }, 'notes'], [{ postedAt: '2020-01-01T00:00:00Z' }, 'postedAt'], [{ businessDate: '2026-02-30' }, 'businessDate'],
      [{ businessDate: '11/11/2026' }, 'businessDate'], [{ book: 'warehouse' }, 'book'], [{ clientRef: 'short' }, 'clientRef'],
    ];
    for (const [over, field] of cases) {
      const r = await expNew(s, over);
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(err(r).code, JSON.stringify(over)).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields), JSON.stringify(over)).toContain(field);
    }
    expect(snap8(s)).toEqual(before);
  });

  it('R-FD: a future date is 400 FUTURE_DATE_NOT_ALLOWED (exact message); today and earlier are accepted; backdated is flagged in the audit', async () => {
    const s = await setup();
    const f = await expNew(s, { businessDate: daysAhead(1) });
    expect(f.status).toBe(400);
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    expect(num(s, 'SELECT COUNT(*) FROM expenses')).toBe(0);
    expect((await expNew(s, { businessDate: today() })).status).toBe(201);
    const back = await expNew(s, { businessDate: daysAgo(3) });
    expect(back.status).toBe(201);
    expect(back.body.item).toMatchObject({ backdated: true, businessDate: daysAgo(3) });
    const rows = sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'expense' ORDER BY id");
    expect(rows.map((r) => [r.business_date, r.backdated])).toEqual([[today(), 0], [daysAgo(3), 1]]);
  });

  it('duplicate submission: the same clientRef returns the first expense (200), no second expense, cash entry or audit row', async () => {
    const s = await setup();
    const clientRef = ref();
    const a = await expNew(s, { clientRef });
    const b = await expNew(s, { clientRef });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.item).toEqual(a.body.item);
    expect(b.body.warnings).toEqual([]);
    expect(num(s, 'SELECT COUNT(*) FROM expenses')).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'expense'")).toBe(1);
    expect(auditRows(s.ctx, 'expense')).toHaveLength(1);
    expect(bookBal(s, 'shop')).toBe(-50000);
  });

  it('R13: saved anyway with the shared warning when the book goes negative; no warning once cash covers it', async () => {
    const s = await setup();
    const neg = await expNew(s, { amountCents: 50000 });
    expect(neg.status).toBe(201);
    expect(neg.body.warnings).toEqual([{
      code: 'NEGATIVE_CASH_BALANCE', book: 'shop', balanceCents: -50000,
      message: 'The Shop cash book is now below zero (-Rs. 500.00). Check that the opening balance and sales are recorded.',
    }]);
    await openNew(s, 'shop', { amountCents: 1000000 }); // balance -50,000 + 1,000,000 = 950,000
    const ok = await expNew(s, { amountCents: 100000 });
    expect(ok.body.warnings).toEqual([]);
    expect(bookBal(s, 'shop')).toBe(850000);
    // exact boundary: spending everything that is left leaves exactly 0 -> no warning
    expect((await expNew(s, { amountCents: 850000 })).body.warnings).toEqual([]);
    expect(bookBal(s, 'shop')).toBe(0);
    // telecom is judged on its own book
    const t = await expNew(s, { book: 'telecom', amountCents: 100 });
    expect(t.body.warnings).toEqual([{
      code: 'NEGATIVE_CASH_BALANCE', book: 'telecom', balanceCents: -100,
      message: 'The Telecom cash book is now below zero (-Rs. 1.00). Check that the opening balance and sales are recorded.',
    }]);
  });
});

describe('POST /expenses/:id/void - R1', () => {
  it('writes a reversing cash entry (same type, +amount, same date, points back), marks the expense void, audits it', async () => {
    const s = await setup();
    const e = (await expNew(s, { amountCents: 50000, businessDate: daysAgo(2) })).body.item;
    const r = await expVoid(s, e.id, 'entered twice');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'void', voidReason: 'entered twice' });
    expect(r.body.item.voidedAt).toEqual(expect.any(String));
    const cash = cashOfRef(s, 'expenses', e.id);
    expect(cash.map((c) => c.amount_cents)).toEqual([-50000, 50000]);
    expect(cash[1]).toMatchObject({ type: 'expense', book: 'shop', business_date: daysAgo(2), reverses_entry_id: cash[0]!.id });
    expect(bookBal(s, 'shop')).toBe(0);
    const a = auditRows(s.ctx, 'expense').map((x) => x.action);
    expect(a).toEqual(['create', 'void']);
    // the void's audit row carries the ORIGINAL business date, flagged backdated (judged against today)
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'expense' AND action = 'void'")[0]).toMatchObject({ business_date: daysAgo(2), backdated: 1 });
  });

  it('a second void is 409 ALREADY_VOID; an unknown id is 404; a blank reason is 400; nothing extra is written', async () => {
    const s = await setup();
    const e = (await expNew(s)).body.item;
    expect((await expVoid(s, e.id)).status).toBe(200);
    const before = snap8(s);
    const again = await expVoid(s, e.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect((await expVoid(s, 9999)).status).toBe(404);
    expect((await post(s.app, `/expenses/${e.id}/void`, { reason: '   ' })).status).toBe(400);
    expect(snap8(s)).toEqual(before);
  });
});

describe('GET /expenses - list, filters, totals', () => {
  it('totals count POSTED expenses only; filters by book, category, dates and status; newest first; paged', async () => {
    const s = await setup();
    const a = (await expNew(s, { book: 'shop', category: 'rent', amountCents: 50000, businessDate: daysAgo(3) })).body.item;
    const b = (await expNew(s, { book: 'shop', category: 'water', amountCents: 20000, businessDate: daysAgo(2) })).body.item;
    const c = (await expNew(s, { book: 'telecom', category: 'internet', amountCents: 30000, businessDate: daysAgo(1) })).body.item;
    let r = await get(s.app, '/expenses');
    expect(r.body.total).toBe(3);
    expect(r.body.totals).toEqual({ amountCents: 100000 });
    expect(r.body.items.map((i: any) => i.id)).toEqual([c.id, b.id, a.id]); // newest business date first
    expect((await get(s.app, '/expenses?book=shop')).body.totals).toEqual({ amountCents: 70000 });
    expect((await get(s.app, '/expenses?book=telecom')).body.totals).toEqual({ amountCents: 30000 });
    expect((await get(s.app, '/expenses?category=water')).body.totals).toEqual({ amountCents: 20000 });
    expect((await get(s.app, `/expenses?from=${daysAgo(2)}&to=${daysAgo(1)}`)).body.totals).toEqual({ amountCents: 50000 });
    await expVoid(s, b.id);
    r = await get(s.app, '/expenses');
    expect(r.body.total).toBe(3); // voided rows are shown...
    expect(r.body.totals).toEqual({ amountCents: 80000 }); // ...but not summed
    expect((await get(s.app, '/expenses?status=void')).body.items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await get(s.app, '/expenses?status=posted')).body.total).toBe(2);
    const p1 = await get(s.app, '/expenses?limit=2&offset=0');
    const p2 = await get(s.app, '/expenses?limit=2&offset=2');
    expect([...p1.body.items, ...p2.body.items].map((i: any) => i.id)).toEqual([c.id, b.id, a.id]);
    expect(p1.body.total).toBe(3);
    expect((await get(s.app, '/expenses?book=icecream')).status).toBe(400);
    expect((await get(s.app, '/expenses?limit=0')).status).toBe(400);
    expect((await get(s.app, '/expenses?from=2026-13-01')).status).toBe(400);
    expect((await get(s.app, '/expenses/9999')).status).toBe(404);
  });
});

describe('rollback: one transaction per expense write', () => {
  it('a failing audit insert leaves no expense and no cash entry', async () => {
    quiet();
    const s = await setup();
    const before = snap8(s);
    breakAudit(s.ctx, 'expense');
    const r = await expNew(s);
    expect(r.status).toBe(500);
    expect(snap8(s)).toEqual(before);
  });

  it('a failing cash insert leaves no expense and no audit row; the same clientRef works once the fault is gone', async () => {
    quiet();
    const s = await setup();
    const before = snap8(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries WHEN NEW.type = 'expense' BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    const clientRef = ref();
    expect((await expNew(s, { clientRef })).status).toBe(500);
    expect(snap8(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_cash');
    expect((await expNew(s, { clientRef })).status).toBe(201);
  });

  it('a failing audit on VOID leaves the expense posted and no reversal entry', async () => {
    quiet();
    const s = await setup();
    const e = (await expNew(s)).body.item;
    const before = snap8(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await expVoid(s, e.id)).status).toBe(500);
    expect(snap8(s)).toEqual(before);
    expect((await get(s.app, `/expenses/${e.id}`)).body.item.status).toBe('posted');
  });
});
