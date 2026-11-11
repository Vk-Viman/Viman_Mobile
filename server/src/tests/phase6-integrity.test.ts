// Phase 6 - integrity of the telecom books: all-or-nothing writes, duplicate submissions, date rules and audit
// flags, voids by reversal (R1), cash-book reconciliation and a seeded randomized run against an independent model.
// Rules protected: section 5 (collections in, commission = revenue, top-ups out), section 12 (one transaction per
// write: business row + cash entry + audit row; clientRef idempotency; R-FD; backdated flag), R1 (void = reversal row
// with reverses_entry_id, never an edit), R14 (no float tracking - the cash book is just the sum of its ledger).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post, put } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, FUTURE_MSG, num, sql } from './helpers/phase4.ts';
import {
  cashOf, ez, ezVoid, lastAudit, providerIds, putProvider, refBase, rel, relVoid, snap6, telecomCash, topProvider, topVoid, topWallet,
} from './helpers/phase6.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase & { P: Record<string, number> }> => {
  const s = await apiBase(await env.build());
  return { ...s, P: await providerIds(s) };
};
// Silences the expected server error log lines while tests deliberately force failures.
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

// ---------------------------------------------------------------------------------------------
describe('all-or-nothing writes (one transaction: business row + cash entry + audit row)', () => {
  it('a failing audit write rolls back the reload row and its cash entry', async () => {
    quiet();
    const s = await setup();
    breakAudit(s.ctx, 'reload_sale');
    const before = snap6(s);
    const r = await rel(s, s.P.Dialog!, 100_000);
    expect(r.status).toBe(500);
    expect(err(r).code).toBe('INTERNAL_ERROR');
    expect(snap6(s)).toEqual(before);
    expect(telecomCash(s)).toBe(0);
  });

  it('a failing cash entry rolls back the business row and the audit row (reload, EZCash and top-up)', async () => {
    quiet();
    const s = await setup();
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    const before = snap6(s);
    expect((await rel(s, s.P.Dialog!, 100_000)).status).toBe(500);
    expect((await ez(s, 100_000)).status).toBe(500);
    expect((await topWallet(s, 100_000)).status).toBe(500);
    expect((await topProvider(s, s.P.Dialog!, 100_000)).status).toBe(500);
    expect(snap6(s)).toEqual(before);
    expect(num(s, 'SELECT COUNT(*) FROM reload_sales')).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM ezcash_sales')).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM telecom_topups')).toBe(0);
  });

  it('a failing audit write rolls back EZCash and top-up rows too', async () => {
    quiet();
    const s = await setup();
    breakAudit(s.ctx, 'ezcash_sale');
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit2 BEFORE INSERT ON audit_logs WHEN NEW.entity = 'telecom_topup' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    const before = snap6(s);
    expect((await ez(s, 100_000)).status).toBe(500);
    expect((await topWallet(s, 100_000)).status).toBe(500);
    expect(snap6(s)).toEqual(before);
  });

  it('a failed void leaves the entry posted and writes no reversal entry (all three record kinds)', async () => {
    quiet();
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 100_000);
    const b = await ez(s, 100_000);
    const c = await topWallet(s, 100_000);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_void BEFORE INSERT ON audit_logs WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'void boom'); END`);
    const before = snap6(s);
    expect((await relVoid(s, a.body.item.id)).status).toBe(500);
    expect((await ezVoid(s, b.body.item.id)).status).toBe(500);
    expect((await topVoid(s, c.body.item.id)).status).toBe(500);
    expect(snap6(s)).toEqual(before);
    expect(num(s, "SELECT COUNT(*) FROM reload_sales WHERE status = 'void'")).toBe(0);
    expect(num(s, "SELECT COUNT(*) FROM ezcash_sales WHERE status = 'void'")).toBe(0);
    expect(num(s, "SELECT COUNT(*) FROM telecom_topups WHERE status = 'void'")).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries WHERE reverses_entry_id IS NOT NULL')).toBe(0);
  });

  it('a failed provider update changes nothing', async () => {
    quiet();
    const s = await setup();
    breakAudit(s.ctx, 'reload_provider');
    const r = await putProvider(s, s.P.Dialog!, { commissionBp: 123, active: false });
    expect(r.status).toBe(500);
    expect((await get(s.app, '/reload-providers')).body.items[0]).toMatchObject({ commissionBp: 600, ownCommissionBp: null, active: true });
  });

  it('a rejected request (validation, inactive provider, future date) writes nothing at all', async () => {
    const s = await setup();
    await putProvider(s, s.P.Hutch!, { commissionBp: null, active: false });
    const before = snap6(s);
    await rel(s, s.P.Hutch!, 100_000);
    await rel(s, s.P.Dialog!, 0);
    await rel(s, s.P.Dialog!, 100_000, { businessDate: daysAhead(1) });
    await ez(s, 100_000, { businessDate: daysAhead(1) });
    await topWallet(s, 100_000, { businessDate: daysAhead(1) });
    await topProvider(s, s.P.Hutch!, 100_000);
    expect(snap6(s)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
describe('duplicate submission (clientRef)', () => {
  it('five identical requests sent at once create exactly one record, one cash entry and one audit row', async () => {
    const s = await setup();
    const clientRef = 'concurrent-ref-0001';
    const res = await Promise.all(Array.from({ length: 5 }, () => rel(s, s.P.Dialog!, 250_000, { clientRef })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(res.map((r) => r.body.item.id)).size).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM reload_sales')).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE ref_table = 'reload_sales'")).toBe(1);
    expect(auditRows(s.ctx, 'reload_sale')).toHaveLength(1);
    expect(telecomCash(s)).toBe(250_000);
  });

  it('the same holds for EZCash and top-ups', async () => {
    const s = await setup();
    const a = await Promise.all(Array.from({ length: 4 }, () => ez(s, 100_000, { clientRef: 'concurrent-ez-0001' })));
    const b = await Promise.all(Array.from({ length: 4 }, () => topWallet(s, 100_000, { clientRef: 'concurrent-tp-0001' })));
    expect(a.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(b.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(num(s, 'SELECT COUNT(*) FROM ezcash_sales')).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM telecom_topups')).toBe(1);
    expect(telecomCash(s)).toBe(0); // +100,000 EZCash - 100,000 wallet top-up
  });

  it('a client reference is shared across kinds only by accident: the same text in two tables is two records', async () => {
    const s = await setup();
    expect((await rel(s, s.P.Dialog!, 1_000, { clientRef: 'shared-ref-text-1' })).status).toBe(201);
    expect((await ez(s, 1_000, { clientRef: 'shared-ref-text-1' })).status).toBe(201);
    expect((await topWallet(s, 1_000, { clientRef: 'shared-ref-text-1' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------
describe('dates (R-FD) and the backdated flag', () => {
  it('rejects tomorrow, a month ahead and next year on every endpoint with the exact message', async () => {
    const s = await setup();
    for (const d of [daysAhead(1), daysAhead(31), daysAhead(366)]) {
      for (const r of [await rel(s, s.P.Dialog!, 1_000, { businessDate: d }), await ez(s, 1_000, { businessDate: d }), await topWallet(s, 1_000, { businessDate: d })]) {
        expect(r.status, d).toBe(400);
        expect(err(r)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
      }
    }
    expect(snap6(s)).toEqual({ reload_sales: 0, ezcash_sales: 0, telecom_topups: 0, cash_entries: 0, audit_logs: 0 });
  });

  it('accepts today and a real leap day in the past; rejects impossible calendar days as validation errors', async () => {
    const s = await setup();
    expect((await rel(s, s.P.Dialog!, 1_000, { businessDate: today() })).status).toBe(201);
    expect((await rel(s, s.P.Dialog!, 1_000, { businessDate: '2024-02-29' })).status).toBe(201);
    for (const d of ['2023-02-29', '2026-04-31', '2026-00-10', '2026-12-32']) {
      const r = await rel(s, s.P.Dialog!, 1_000, { businessDate: d });
      expect(r.status, d).toBe(400);
      expect(err(r).code, d).toBe('VALIDATION_ERROR');
      expect(err(r).fields.businessDate, d).toBeTruthy();
    }
  });

  it('today is NOT backdated; an earlier date is, in the item and in the audit entry (create and void)', async () => {
    const s = await setup();
    const t = await ez(s, 100_000, { businessDate: today() });
    expect(t.body.item.backdated).toBe(false);
    expect(lastAudit(s, 'ezcash_sale', 'create')).toMatchObject({ business_date: today(), backdated: 0 });
    const p = await topWallet(s, 100_000, { businessDate: daysAgo(1) });
    expect(p.body.item.backdated).toBe(true);
    expect(lastAudit(s, 'telecom_topup', 'create')).toMatchObject({ business_date: daysAgo(1), backdated: 1 });
    // The void of a backdated record is itself backdated (its business date is before the day of the void).
    await topVoid(s, p.body.item.id);
    expect(lastAudit(s, 'telecom_topup', 'void')).toMatchObject({ business_date: daysAgo(1), backdated: 1 });
    // Voiding a same-day record is not backdated.
    await ezVoid(s, t.body.item.id);
    expect(lastAudit(s, 'ezcash_sale', 'void')).toMatchObject({ business_date: today(), backdated: 0 });
  });

  it('the audit entry stores the before/after snapshots and the posting time is set by the server', async () => {
    const s = await setup();
    const r = await rel(s, s.P.Mobitel!, 100_000, { businessDate: daysAgo(2) });
    await relVoid(s, r.body.item.id, 'wrong provider');
    const a = auditRows(s.ctx, 'reload_sale');
    expect(a.map((x) => x.action)).toEqual(['create', 'void']);
    expect(a[0]!.before).toBeNull();
    expect(a[0]!.after).toMatchObject({ id: r.body.item.id, status: 'posted', salesCents: 100_000 });
    expect(a[1]!.before).toMatchObject({ status: 'posted' });
    expect(a[1]!.after).toMatchObject({ status: 'void', voidReason: 'wrong provider' });
    // posted_at cannot be supplied: an extra property is rejected rather than ignored.
    const sneaky = await post(s.app, '/reload-sales', { businessDate: today(), providerId: s.P.Dialog, salesCents: 100, clientRef: ref(), postedAt: '2020-01-01T00:00:00.000Z' });
    expect(sneaky.status).toBe(400);
  });

  it('a backdated entry keeps its business date in the cash book (reports follow the business date)', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 100_000, { businessDate: daysAgo(4) });
    const b = await ez(s, 50_000, { businessDate: daysAgo(3) });
    const c = await topProvider(s, s.P.Dialog!, 20_000, { businessDate: daysAgo(2) });
    expect(cashOf(s, 'reload_sales', a.body.item.id)[0]!.business_date).toBe(daysAgo(4));
    expect(cashOf(s, 'ezcash_sales', b.body.item.id)[0]!.business_date).toBe(daysAgo(3));
    expect(cashOf(s, 'telecom_topups', c.body.item.id)[0]!.business_date).toBe(daysAgo(2));
  });
});

// ---------------------------------------------------------------------------------------------
describe('void = reversal (R1)', () => {
  it('voiding every kind brings the Telecom cash balance back to zero; the original rows are never edited or removed', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 5_000_000, { extraCents: 5_000 });
    const b = await ez(s, 2_000_000);
    const c = await topProvider(s, s.P.Mobitel!, 1_000_000);
    const d = await topWallet(s, 500_000);
    expect(telecomCash(s)).toBe(5_000_000 + 2_000_000 - 1_000_000 - 500_000);
    const originalIds = sql(s, 'SELECT id FROM cash_entries ORDER BY id').map((r) => r.id);
    expect(originalIds).toHaveLength(4);
    for (const r of [await relVoid(s, a.body.item.id), await ezVoid(s, b.body.item.id), await topVoid(s, c.body.item.id), await topVoid(s, d.body.item.id)]) {
      expect(r.status).toBe(200);
    }
    expect(telecomCash(s)).toBe(0);
    const all = sql(s, 'SELECT * FROM cash_entries ORDER BY id');
    expect(all).toHaveLength(8);
    // The first four rows are untouched; each reversal points at its original, with the negated amount.
    for (let i = 0; i < 4; i++) {
      const orig = all[i]!;
      const rev = all.find((x) => x.reverses_entry_id === orig.id)!;
      expect(rev, `reversal of ${orig.id}`).toBeTruthy();
      expect(rev.amount_cents).toBe(-orig.amount_cents);
      expect(rev.type).toBe(orig.type);
      expect(rev.book).toBe('telecom');
      expect(rev.business_date).toBe(orig.business_date);
      expect(rev.ref_table).toBe(orig.ref_table);
      expect(rev.ref_id).toBe(orig.ref_id);
      expect(rev.id).toBeGreaterThan(orig.id);
    }
    // Business rows stay, as void.
    expect(num(s, "SELECT COUNT(*) FROM reload_sales WHERE status = 'void'")).toBe(1);
    expect(num(s, "SELECT COUNT(*) FROM telecom_topups WHERE status = 'void'")).toBe(2);
  });

  it('voiding twice is 409 ALREADY_VOID and adds no second reversal', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 100_000);
    expect((await relVoid(s, a.body.item.id)).status).toBe(200);
    const before = snap6(s);
    const again = await relVoid(s, a.body.item.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
    expect(snap6(s)).toEqual(before);
    expect(telecomCash(s)).toBe(0);
  });

  it('a voided entry leaves every total and the summary, and its commission is no longer revenue', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 1_000_000); // 60,000
    await rel(s, s.P.Dialog!, 1_000_000);           // 60,000
    await relVoid(s, a.body.item.id);
    const sum = await get(s.app, '/telecom/summary');
    expect(sum.body.totals).toMatchObject({ reloadSalesCents: 1_000_000, reloadCommissionCents: 60_000, commissionRevenueCents: 60_000 });
    expect((await get(s.app, '/reload-sales')).body.totals).toMatchObject({ salesCents: 1_000_000, commissionCents: 60_000 });
  });

  it('voiding a collection that was already spent may make the balance negative: a warning elsewhere, never a block (R13)', async () => {
    const s = await setup();
    const a = await rel(s, s.P.Dialog!, 100_000);
    await topWallet(s, 100_000);
    expect((await relVoid(s, a.body.item.id)).status).toBe(200);
    expect(telecomCash(s)).toBe(-100_000);
  });

  it('voiding a top-up puts the cash back (+), voiding a collection takes it out (-)', async () => {
    const s = await setup();
    const c = await topWallet(s, 300_000);
    expect(telecomCash(s)).toBe(-300_000);
    await topVoid(s, c.body.item.id);
    expect(cashOf(s, 'telecom_topups', c.body.item.id).map((x) => x.amount_cents)).toEqual([-300_000, 300_000]);
    expect(telecomCash(s)).toBe(0);
  });

  it('the cash ledger itself stays append-only: no update or delete of a telecom entry', async () => {
    const s = await setup();
    await rel(s, s.P.Dialog!, 100_000);
    expect(() => s.ctx.database.conn.exec("UPDATE cash_entries SET amount_cents = 1 WHERE type = 'reload_collection'")).toThrow(/append-only/);
    expect(() => s.ctx.database.conn.exec("DELETE FROM cash_entries WHERE type = 'reload_collection'")).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('cash-book reconciliation (section 8, R14)', () => {
  it('Telecom cash balance = SUM of its entries = collections - top-ups; commission is not in the cash book', async () => {
    const s = await setup();
    await rel(s, s.P.Dialog!, 4_000_000, { extraCents: 500 });  // collected 4,000,000 (commission 240,500 is revenue, not cash)
    await rel(s, s.P.Hutch!, 1_000_000);
    await ez(s, 3_000_000);                                       // collected 3,000,000
    await topProvider(s, s.P.Dialog!, 2_500_000);                 // out
    await topWallet(s, 1_200_000);                                // out
    const collections = 4_000_000 + 1_000_000 + 3_000_000;
    const topups = 2_500_000 + 1_200_000;
    const sum = num(s, "SELECT SUM(amount_cents) FROM cash_entries WHERE book = 'telecom'");
    expect(sum).toBe(collections - topups);
    expect(telecomCash(s)).toBe(4_300_000);
    // Entry types: only the four telecom types appear, all in the telecom book, none for commission.
    const types = sql(s, 'SELECT DISTINCT type FROM cash_entries ORDER BY type').map((r) => r.type);
    expect(types).toEqual(['ezcash_collection', 'provider_topup', 'reload_collection', 'wallet_topup']);
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE book <> 'telecom' OR fund IS NOT NULL")).toBe(0);
    // Revenue (commission) is reported by the summary and is NOT the cash balance.
    const sm = (await get(s.app, '/telecom/summary')).body.totals;
    expect(sm.commissionRevenueCents).toBe(240_500 + 60_000 + 24_000);
    expect(sm.commissionRevenueCents).not.toBe(telecomCash(s));
  });

  it('every business row has exactly one live cash entry whose sign and amount match its kind', async () => {
    const s = await setup();
    const r1 = await rel(s, s.P.Dialog!, 123_456, { extraCents: 7 });
    const e1 = await ez(s, 654_321);
    const t1 = await topProvider(s, s.P.Airtel!, 99_999);
    const t2 = await topWallet(s, 11_111);
    expect(cashOf(s, 'reload_sales', r1.body.item.id).map((x) => x.amount_cents)).toEqual([123_456]);
    expect(cashOf(s, 'ezcash_sales', e1.body.item.id).map((x) => x.amount_cents)).toEqual([654_321]);
    expect(cashOf(s, 'telecom_topups', t1.body.item.id).map((x) => x.amount_cents)).toEqual([-99_999]);
    expect(cashOf(s, 'telecom_topups', t2.body.item.id).map((x) => x.amount_cents)).toEqual([-11_111]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('randomized run against an independent model', () => {
  // A tiny seeded generator (LCG) keeps the run reproducible: the same 200 operations every time.
  function rng(seed: number): (n: number) => number {
    let x = seed;
    return (n) => { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor((x / 2147483648) * n); };
  }

  interface Rec {
    kind: 'reload' | 'ezcash' | 'topup'; id: number; ref: string; providerId: number | null; amount: number; commission: number;
    extra: number; topKind?: 'provider_topup' | 'wallet_topup'; date: string; voided: boolean;
  }

  it('200 random operations (create, void, rate changes, switch off/on, repeats) match the model exactly', async () => {
    const s = await setup();
    const next = rng(20261111);
    const names = ['Dialog', 'Mobitel', 'Hutch', 'Airtel'];
    // ----- the model (computed independently of the server code) -----
    const own: Record<string, number | null> = { Dialog: null, Mobitel: null, Hutch: null, Airtel: null };
    const active: Record<string, boolean> = { Dialog: true, Mobitel: true, Hutch: true, Airtel: true };
    let defaultReload = 600;
    let defaultEz = 80;
    const recs: Rec[] = [];
    const pick = <T,>(a: T[]): T => a[next(a.length)]!;
    const date = (): string => daysAgo(next(10));

    for (let i = 0; i < 200; i++) {
      const op = next(100);
      if (op < 40) { // reload
        const name = pick(names);
        const sales = 1 + next(20_000_000);
        const extra = next(4) === 0 ? next(5_000) : 0;
        const d = date();
        const clientRef = `rnd-reload-${i}-${next(1e6)}`;
        const r = await rel(s, s.P[name]!, sales, { extraCents: extra, businessDate: d, clientRef });
        if (!active[name]) { expect(r.status, `op ${i}`).toBe(409); expect(err(r).code).toBe('PROVIDER_INACTIVE'); continue; }
        const bp = own[name] ?? defaultReload;
        const commission = refBase(sales, bp) + extra;
        expect(r.status, `op ${i}`).toBe(201);
        expect(r.body.item).toMatchObject({ commissionBp: bp, commissionCents: commission, salesCents: sales, extraCents: extra });
        recs.push({ kind: 'reload', id: r.body.item.id, ref: clientRef, providerId: s.P[name]!, amount: sales, commission, extra, date: d, voided: false });
      } else if (op < 55) { // ezcash
        const bill = 1 + next(30_000_000);
        const d = date();
        const clientRef = `rnd-ezcash-${i}-${next(1e6)}`;
        const r = await ez(s, bill, { businessDate: d, clientRef });
        const commission = refBase(bill, defaultEz);
        expect(r.status, `op ${i}`).toBe(201);
        expect(r.body.item).toMatchObject({ commissionBp: defaultEz, commissionCents: commission });
        recs.push({ kind: 'ezcash', id: r.body.item.id, ref: clientRef, providerId: s.P.Dialog!, amount: bill, commission, extra: 0, date: d, voided: false });
      } else if (op < 70) { // provider top-up
        const name = pick(names);
        const amount = 1 + next(10_000_000);
        const d = date();
        const clientRef = `rnd-topprov-${i}-${next(1e6)}`;
        const r = await topProvider(s, s.P[name]!, amount, { businessDate: d, clientRef });
        if (!active[name]) { expect(r.status, `op ${i}`).toBe(409); continue; }
        expect(r.status, `op ${i}`).toBe(201);
        recs.push({ kind: 'topup', topKind: 'provider_topup', id: r.body.item.id, ref: clientRef, providerId: s.P[name]!, amount, commission: 0, extra: 0, date: d, voided: false });
      } else if (op < 78) { // wallet top-up
        const amount = 1 + next(5_000_000);
        const d = date();
        const clientRef = `rnd-topwal-${i}-${next(1e6)}`;
        const r = await topWallet(s, amount, { businessDate: d, clientRef });
        expect(r.status, `op ${i}`).toBe(201);
        recs.push({ kind: 'topup', topKind: 'wallet_topup', id: r.body.item.id, ref: clientRef, providerId: null, amount, commission: 0, extra: 0, date: d, voided: false });
      } else if (op < 92) { // void a random record (live or already void)
        if (recs.length === 0) continue;
        const rec = pick(recs);
        const r = rec.kind === 'reload' ? await relVoid(s, rec.id) : rec.kind === 'ezcash' ? await ezVoid(s, rec.id) : await topVoid(s, rec.id);
        if (rec.voided) { expect(r.status, `op ${i}`).toBe(409); } else { expect(r.status, `op ${i}`).toBe(200); rec.voided = true; }
      } else if (op < 96) { // provider own rate change (or back to default)
        const name = pick(names);
        const bp = next(3) === 0 ? null : next(1501);
        const r = await putProvider(s, s.P[name]!, { commissionBp: bp, active: active[name] });
        expect(r.status).toBe(200);
        own[name] = bp;
      } else if (op < 97) { // shop default rates
        defaultReload = next(1201);
        defaultEz = next(301);
        expect((await put(s.app, '/settings', { rates: { reloadCommissionBp: defaultReload, ezcashCommissionBp: defaultEz } })).status).toBe(200);
      } else if (op < 98) { // switch a provider off or on
        const name = pick(names);
        active[name] = !active[name];
        expect((await putProvider(s, s.P[name]!, { commissionBp: own[name]!, active: active[name] })).status).toBe(200);
      } else if (recs.length > 0) { // repeat an old submission: 200 and the original, nothing new
        const rec = pick(recs);
        const before = snap6(s);
        const body = rec.kind === 'reload' ? await rel(s, rec.providerId!, 5, { clientRef: rec.ref })
          : rec.kind === 'ezcash' ? await ez(s, 5, { clientRef: rec.ref })
            : rec.topKind === 'wallet_topup' ? await topWallet(s, 5, { clientRef: rec.ref }) : await topProvider(s, rec.providerId!, 5, { clientRef: rec.ref });
        expect(body.status, `op ${i}`).toBe(200);
        expect(body.body.item.id).toBe(rec.id);
        expect(snap6(s)).toEqual(before);
      }
    }
    expect(recs.length).toBeGreaterThan(80); // the run really exercised the system

    // ----- compare with the system -----
    const live = (k: Rec['kind']) => recs.filter((r) => r.kind === k && !r.voided);
    const sum = (a: Rec[], f: (r: Rec) => number): number => a.reduce((t, r) => t + f(r), 0);
    const reloads = live('reload');
    const ezs = live('ezcash');
    const tops = live('topup');

    expect((await get(s.app, '/reload-sales')).body.totals).toEqual({
      salesCents: sum(reloads, (r) => r.amount), commissionCents: sum(reloads, (r) => r.commission), extraCents: sum(reloads, (r) => r.extra),
    });
    expect((await get(s.app, '/ezcash-sales')).body.totals).toEqual({ billTotalCents: sum(ezs, (r) => r.amount), commissionCents: sum(ezs, (r) => r.commission) });
    const provTop = sum(tops.filter((t) => t.topKind === 'provider_topup'), (r) => r.amount);
    const walTop = sum(tops.filter((t) => t.topKind === 'wallet_topup'), (r) => r.amount);
    expect((await get(s.app, '/telecom/topups')).body.totals).toEqual({ providerTopupCents: provTop, walletTopupCents: walTop, totalCents: provTop + walTop });

    // Summary per provider and in total.
    const summary = (await get(s.app, '/telecom/summary')).body;
    for (const name of names) {
      const id = s.P[name]!;
      const row = summary.providers.find((p: any) => p.name === name);
      const rl = reloads.filter((r) => r.providerId === id);
      const ex = ezs.filter((r) => r.providerId === id);
      expect(row, name).toMatchObject({
        reloadSalesCents: sum(rl, (r) => r.amount), reloadCommissionCents: sum(rl, (r) => r.commission),
        ezcashBillCents: sum(ex, (r) => r.amount), ezcashCommissionCents: sum(ex, (r) => r.commission),
        topupsCents: sum(tops.filter((t) => t.topKind === 'provider_topup' && t.providerId === id), (r) => r.amount),
        commissionRevenueCents: sum(rl, (r) => r.commission) + sum(ex, (r) => r.commission),
      });
    }
    expect(summary.totals.commissionRevenueCents).toBe(sum(reloads, (r) => r.commission) + sum(ezs, (r) => r.commission));
    expect(summary.totals.topupsCents).toBe(provTop + walTop);

    // Cash book: collections - top-ups of LIVE records; also = SUM of ledger rows including reversals.
    const expectedCash = sum(reloads, (r) => r.amount) + sum(ezs, (r) => r.amount) - provTop - walTop;
    expect(telecomCash(s)).toBe(expectedCash);

    // Ledger shape: one original per record, one reversal per voided record, each reversal links to its original.
    const voided = recs.filter((r) => r.voided).length;
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(recs.length + voided);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries WHERE reverses_entry_id IS NOT NULL')).toBe(voided);
    expect(num(s, `SELECT COUNT(*) FROM cash_entries r JOIN cash_entries o ON o.id = r.reverses_entry_id
      WHERE r.amount_cents = -o.amount_cents AND r.ref_table = o.ref_table AND r.ref_id = o.ref_id AND r.business_date = o.business_date`)).toBe(voided);
    // One create audit per record, one void audit per voided record.
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE action = 'create' AND entity IN ('reload_sale','ezcash_sale','telecom_topup')")).toBe(recs.length);
    expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE action = 'void' AND entity IN ('reload_sale','ezcash_sale','telecom_topup')")).toBe(voided);
    // Date filter agrees with the model for one day.
    const day = daysAgo(3);
    const dayModel = sum(reloads.filter((r) => r.date === day), (r) => r.commission);
    expect((await get(s.app, `/reload-sales?from=${day}&to=${day}`)).body.totals.commissionCents).toBe(dayModel);
  }, 120_000);
});
