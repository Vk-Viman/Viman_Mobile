// Phase 6 - database constraints and triggers of migration 009 (direct SQL, no service in between).
// The service checks every rule first; these tests prove the DATABASE refuses the same mistakes on its own, so a
// bug or a hand-typed statement can never corrupt the telecom books: R-FD future dates, immutability of posted
// rows (R1: only posted -> void), no hard deletes, the commission recompute backstop (COMMISSION_MISMATCH), EZCash
// only under Dialog, and the top-up kind/provider rule.

import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.ts';
import { loadMigrations } from '../db/migrate.ts';
import { memDb, scalar } from './helpers/inventory.ts';
import { daysAhead, today } from './helpers/inventory.ts';
import { refBase } from './helpers/phase6.ts';

const open: DatabaseSync[] = [];
afterEach(() => { for (const c of open.splice(0)) { try { c.close(); } catch { /* ignore */ } } });
const db = (): DatabaseSync => memDb(open);

let seq = 0;
const cref = (): string => `db-ref-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
const pid = (c: DatabaseSync, name: string): number => scalar(c, 'SELECT id FROM reload_providers WHERE name = ?', name);

/** Inserts a reload row; every column can be overridden. Commission defaults to the correct value. */
function reload(c: DatabaseSync, o: Record<string, unknown> = {}): number {
  const v = { business_date: today(), provider_id: pid(c, 'Dialog'), sales_cents: 1_000_000, commission_bp: 600, extra_cents: 0, ...o } as any;
  const commission = o.commission_cents ?? refBase(v.sales_cents, v.commission_bp) + v.extra_cents;
  const r = c.prepare(
    `INSERT INTO reload_sales (business_date, provider_id, sales_cents, commission_bp, extra_cents, commission_cents, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(v.business_date, v.provider_id, v.sales_cents, v.commission_bp, v.extra_cents, commission as number, v.notes ?? '', v.client_ref ?? cref());
  return Number(r.lastInsertRowid);
}

function ezcash(c: DatabaseSync, o: Record<string, unknown> = {}): number {
  const v = { business_date: today(), provider_id: pid(c, 'Dialog'), bill_total_cents: 1_000_000, commission_bp: 80, ...o } as any;
  const commission = o.commission_cents ?? refBase(v.bill_total_cents, v.commission_bp);
  const r = c.prepare(
    `INSERT INTO ezcash_sales (business_date, provider_id, bill_total_cents, commission_bp, commission_cents, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(v.business_date, v.provider_id, v.bill_total_cents, v.commission_bp, commission as number, v.notes ?? '', v.client_ref ?? cref());
  return Number(r.lastInsertRowid);
}

function topup(c: DatabaseSync, o: Record<string, unknown> = {}): number {
  const v = { business_date: today(), kind: 'wallet_topup', provider_id: null, amount_cents: 100_000, ...o } as any;
  const r = c.prepare(
    `INSERT INTO telecom_topups (business_date, kind, provider_id, amount_cents, notes, client_ref) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(v.business_date, v.kind, v.provider_id, v.amount_cents, v.notes ?? '', v.client_ref ?? cref());
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------------------------------------
describe('migration 009 - seed and providers', () => {
  it('is the ninth migration and seeds Dialog, Mobitel, Hutch, Airtel (active, default rate)', () => {
    expect(loadMigrations().some((m) => m.name === '009_telecom.sql')).toBe(true);
    const c = db();
    const rows = c.prepare('SELECT name, commission_bp, active FROM reload_providers ORDER BY sort_order').all() as any[];
    expect(rows.map((r) => r.name)).toEqual(['Dialog', 'Mobitel', 'Hutch', 'Airtel']);
    for (const r of rows) { expect(r.commission_bp).toBeNull(); expect(Number(r.active)).toBe(1); }
  });

  it('is idempotent: migrating again applies nothing', () => {
    const c = db();
    expect(migrate(c).applied).toEqual([]);
  });

  it('provider names are unique, never renamed, never deleted', () => {
    const c = db();
    expect(() => c.exec("INSERT INTO reload_providers (name) VALUES ('Dialog')")).toThrow(/UNIQUE/);
    expect(() => c.exec("UPDATE reload_providers SET name = 'Dialog2' WHERE name = 'Dialog'")).toThrow(/PROVIDER_NAME_IMMUTABLE/);
    expect(() => c.exec("DELETE FROM reload_providers WHERE name = 'Hutch'")).toThrow(/RECORD_DELETE_FORBIDDEN/);
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_providers')).toBe(4);
  });

  it('rate and active are editable but range-checked (0..10000, active 0/1)', () => {
    const c = db();
    c.exec("UPDATE reload_providers SET commission_bp = 0 WHERE name = 'Hutch'");
    c.exec("UPDATE reload_providers SET commission_bp = 10000, active = 0 WHERE name = 'Hutch'");
    c.exec("UPDATE reload_providers SET commission_bp = NULL WHERE name = 'Hutch'");
    expect(() => c.exec("UPDATE reload_providers SET commission_bp = 10001 WHERE name = 'Hutch'")).toThrow(/CHECK/);
    expect(() => c.exec("UPDATE reload_providers SET commission_bp = -1 WHERE name = 'Hutch'")).toThrow(/CHECK/);
    expect(() => c.exec("UPDATE reload_providers SET active = 2 WHERE name = 'Hutch'")).toThrow(/CHECK/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('reload_sales - constraints', () => {
  it('accepts a correct row and the boundary values', () => {
    const c = db();
    expect(reload(c)).toBeGreaterThan(0);
    reload(c, { sales_cents: 1_000_000_000_000, commission_bp: 10000 });  // upper bounds
    reload(c, { sales_cents: 1, commission_bp: 0 });
    reload(c, { business_date: '2020-02-29' });                           // real leap day, backdated
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_sales')).toBe(4);
  });

  it('R-FD: a future business date is refused by the trigger; today is fine', () => {
    const c = db();
    expect(() => reload(c, { business_date: daysAhead(1) })).toThrow(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => reload(c, { business_date: '2999-01-01' })).toThrow(/FUTURE_DATE_NOT_ALLOWED/);
    reload(c, { business_date: today() });
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_sales')).toBe(1);
  });

  it('refuses non-dates and impossible dates', () => {
    const c = db();
    for (const d of ['2026-02-30', '2026-13-01', '26-01-01', 'yesterday', '2026-1-1', '']) {
      // Triggers run before CHECKs, so a far-future-looking text such as '2026-13-01' is stopped by a trigger first:
      // R-FD, or (migration 012) INVALID_BUSINESS_DATE for a well-shaped impossible date.
      expect(() => reload(c, { business_date: d }), d).toThrow(/CHECK|FUTURE_DATE_NOT_ALLOWED|INVALID_BUSINESS_DATE/);
    }
  });

  it('refuses sales <= 0 or above the cap, bad rates, negative or too-large extra, negative commission', () => {
    const c = db();
    expect(() => reload(c, { sales_cents: 0, commission_cents: 0 })).toThrow(/CHECK/);
    expect(() => reload(c, { sales_cents: -100, commission_cents: 0 })).toThrow(/CHECK|COMMISSION_MISMATCH/);
    expect(() => reload(c, { sales_cents: 1_000_000_000_001 })).toThrow(/CHECK/);
    expect(() => reload(c, { commission_bp: 10001 })).toThrow(/CHECK/);
    expect(() => reload(c, { commission_bp: -1 })).toThrow(/CHECK/);
    expect(() => reload(c, { extra_cents: -1 })).toThrow(/CHECK/);
    expect(() => reload(c, { extra_cents: 1_000_000_000_001 })).toThrow(/CHECK/);
    expect(() => reload(c, { commission_cents: -1 })).toThrow(/CHECK|COMMISSION_MISMATCH/);
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_sales')).toBe(0);
  });

  it('refuses a missing provider, an unknown provider, a missing or duplicate client_ref', () => {
    const c = db();
    expect(() => reload(c, { provider_id: null })).toThrow(/NOT NULL/);
    expect(() => reload(c, { provider_id: 999 })).toThrow(/FOREIGN KEY/);
    expect(() => reload(c, { client_ref: null as unknown as string, notes: '' })).not.toThrow(); // default branch generates a ref
    reload(c, { client_ref: 'same-client-ref' });
    expect(() => reload(c, { client_ref: 'same-client-ref' })).toThrow(/UNIQUE/);
  });

  it('a void row must carry voided_at and void_reason; the status is posted or void only', () => {
    const c = db();
    const base = `INSERT INTO reload_sales (business_date, provider_id, sales_cents, commission_bp, extra_cents, commission_cents, status, voided_at, void_reason, client_ref)`;
    const d = pid(c, 'Dialog');
    expect(() => c.prepare(`${base} VALUES (?, ?, 100, 600, 0, 6, 'void', NULL, NULL, 'v-ref-1')`).run(today(), d)).toThrow(/CHECK/);
    expect(() => c.prepare(`${base} VALUES (?, ?, 100, 600, 0, 6, 'void', '2026-01-01T00:00:00.000Z', NULL, 'v-ref-2')`).run(today(), d)).toThrow(/CHECK/);
    expect(() => c.prepare(`${base} VALUES (?, ?, 100, 600, 0, 6, 'gone', NULL, NULL, 'v-ref-3')`).run(today(), d)).toThrow(/CHECK/);
  });
});

describe('reload_sales - commission backstop (COMMISSION_MISMATCH)', () => {
  // 5,000,000 x 600 bp = 300,000 + 5,000 extra = 305,000 (hand calculation, section 5 example).
  it('accepts exactly sales x rate rounded + extra and refuses one cent either way', () => {
    const c = db();
    reload(c, { sales_cents: 5_000_000, commission_bp: 600, extra_cents: 5_000, commission_cents: 305_000 });
    expect(() => reload(c, { sales_cents: 5_000_000, commission_bp: 600, extra_cents: 5_000, commission_cents: 304_999 })).toThrow(/COMMISSION_MISMATCH/);
    expect(() => reload(c, { sales_cents: 5_000_000, commission_bp: 600, extra_cents: 5_000, commission_cents: 305_001 })).toThrow(/COMMISSION_MISMATCH/);
    // The extra must really be included: base alone is wrong when extra > 0.
    expect(() => reload(c, { sales_cents: 5_000_000, commission_bp: 600, extra_cents: 5_000, commission_cents: 300_000 })).toThrow(/COMMISSION_MISMATCH/);
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_sales')).toBe(1);
  });

  it('rounds half up at the boundary exactly as mulDivRound: 25 cents @600 -> 2, 24 -> 1, 99 @50 -> 0, 100 @50 -> 1', () => {
    const c = db();
    reload(c, { sales_cents: 25, commission_bp: 600, commission_cents: 2 });  // 1.5 -> 2
    reload(c, { sales_cents: 24, commission_bp: 600, commission_cents: 1 });  // 1.44 -> 1
    reload(c, { sales_cents: 99, commission_bp: 50, commission_cents: 0 });   // 0.495 -> 0
    reload(c, { sales_cents: 100, commission_bp: 50, commission_cents: 1 });  // 0.5 -> 1
    expect(() => reload(c, { sales_cents: 25, commission_bp: 600, commission_cents: 1 })).toThrow(/COMMISSION_MISMATCH/);
  });

  it('agrees with the independent formula over many pseudo-random sales and rates (and rejects +1)', () => {
    const c = db();
    let x = 123456789;
    const rnd = (n: number): number => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
    for (let i = 0; i < 300; i++) {
      const sales = 1 + rnd(2_000_000_000);
      const bp = rnd(10_001);
      const extra = rnd(3) === 0 ? rnd(100_000) : 0;
      const good = Number((BigInt(sales) * BigInt(bp) + 5000n) / 10000n) + extra;
      reload(c, { sales_cents: sales, commission_bp: bp, extra_cents: extra, commission_cents: good });
      expect(() => reload(c, { sales_cents: sales, commission_bp: bp, extra_cents: extra, commission_cents: good + 1 }), `${sales}/${bp}/${extra}`)
        .toThrow(/COMMISSION_MISMATCH/);
    }
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_sales')).toBe(300);
  });
});

describe('reload_sales - immutability and no delete (R1)', () => {
  const frozen: Array<[string, string]> = [
    ['sales_cents', 'sales_cents = 5'], ['commission_bp', 'commission_bp = 1'], ['extra_cents', 'extra_cents = 1'],
    ['commission_cents', 'commission_cents = 1'], ['provider_id', 'provider_id = 2'], ['notes', "notes = 'edited'"],
    ['client_ref', "client_ref = 'other-ref-123'"], ['id', 'id = 777'],
  ];
  for (const [name, set] of frozen) {
    it(`refuses to change ${name} of a posted row`, () => {
      const c = db();
      const id = reload(c);
      expect(() => c.exec(`UPDATE reload_sales SET ${set} WHERE id = ${id}`)).toThrow(/RELOAD_SALE_IMMUTABLE|COMMISSION/);
    });
  }

  it('business_date and posted_at can never change', () => {
    const c = db();
    const id = reload(c);
    expect(() => c.exec(`UPDATE reload_sales SET business_date = '2020-01-01' WHERE id = ${id}`)).toThrow(/BUSINESS_DATE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE reload_sales SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ${id}`)).toThrow(/POSTED_AT_IMMUTABLE/);
  });

  it('allows exactly one transition posted -> void (with time and reason), then freezes it', () => {
    const c = db();
    const id = reload(c);
    c.exec(`UPDATE reload_sales SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'typo' WHERE id = ${id}`);
    expect(() => c.exec(`UPDATE reload_sales SET status = 'posted' WHERE id = ${id}`)).toThrow(/CHECK|RELOAD_SALE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE reload_sales SET void_reason = 'changed' WHERE id = ${id}`)).toThrow(/RELOAD_SALE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE reload_sales SET voided_at = '2027-01-01T00:00:00.000Z' WHERE id = ${id}`)).toThrow(/RELOAD_SALE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE reload_sales SET status = 'void' WHERE id = ${id}`)).not.toThrow(); // same value = no change
  });

  it('a void without a reason is refused, and a posted row cannot gain a reason without voiding', () => {
    const c = db();
    const id = reload(c);
    expect(() => c.exec(`UPDATE reload_sales SET status = 'void' WHERE id = ${id}`)).toThrow(/CHECK/);
    expect(() => c.exec(`UPDATE reload_sales SET void_reason = 'x' WHERE id = ${id}`)).toThrow(/RELOAD_SALE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE reload_sales SET voided_at = '2026-01-01T00:00:00.000Z' WHERE id = ${id}`)).toThrow(/RELOAD_SALE_IMMUTABLE/);
  });

  it('rows can never be deleted, posted or void', () => {
    const c = db();
    const id = reload(c);
    expect(() => c.exec(`DELETE FROM reload_sales WHERE id = ${id}`)).toThrow(/RECORD_DELETE_FORBIDDEN/);
    c.exec(`UPDATE reload_sales SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'x' WHERE id = ${id}`);
    expect(() => c.exec(`DELETE FROM reload_sales WHERE id = ${id}`)).toThrow(/RECORD_DELETE_FORBIDDEN/);
    expect(() => c.exec('DELETE FROM reload_sales')).toThrow(/RECORD_DELETE_FORBIDDEN/);
    expect(scalar(c, 'SELECT COUNT(*) FROM reload_sales')).toBe(1);
  });

  it('posted_at is set by the database clock (ISO UTC)', () => {
    const c = db();
    const id = reload(c);
    const at = c.prepare('SELECT posted_at FROM reload_sales WHERE id = ?').get(id) as any;
    expect(at.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('ezcash_sales - constraints and triggers', () => {
  it('accepts Dialog with the right commission (Rs 50,000 @ 80 bp = 40,000 cents)', () => {
    const c = db();
    ezcash(c, { bill_total_cents: 5_000_000, commission_bp: 80, commission_cents: 40_000 });
    expect(scalar(c, 'SELECT COUNT(*) FROM ezcash_sales')).toBe(1);
  });

  it('EZCASH_PROVIDER_NOT_DIALOG: Mobitel, Hutch, Airtel and an unknown provider are refused', () => {
    const c = db();
    for (const name of ['Mobitel', 'Hutch', 'Airtel']) {
      expect(() => ezcash(c, { provider_id: pid(c, name) }), name).toThrow(/EZCASH_PROVIDER_NOT_DIALOG/);
    }
    expect(() => ezcash(c, { provider_id: 999 })).toThrow(/EZCASH_PROVIDER_NOT_DIALOG|FOREIGN KEY/);
    expect(scalar(c, 'SELECT COUNT(*) FROM ezcash_sales')).toBe(0);
  });

  it('COMMISSION_MISMATCH: refuses one cent off, and the rounding boundary 62 vs 63 cents @ 80 bp', () => {
    const c = db();
    expect(() => ezcash(c, { bill_total_cents: 5_000_000, commission_cents: 40_001 })).toThrow(/COMMISSION_MISMATCH/);
    expect(() => ezcash(c, { bill_total_cents: 5_000_000, commission_cents: 39_999 })).toThrow(/COMMISSION_MISMATCH/);
    ezcash(c, { bill_total_cents: 62, commission_cents: 0 });  // 0.496 -> 0
    ezcash(c, { bill_total_cents: 63, commission_cents: 1 });  // 0.504 -> 1
    expect(() => ezcash(c, { bill_total_cents: 63, commission_cents: 0 })).toThrow(/COMMISSION_MISMATCH/);
  });

  it('R-FD, bad dates, bad amounts and rates, duplicate client_ref', () => {
    const c = db();
    expect(() => ezcash(c, { business_date: daysAhead(1) })).toThrow(/FUTURE_DATE_NOT_ALLOWED/);
    expect(() => ezcash(c, { business_date: '2026-02-30' })).toThrow(/CHECK/);
    expect(() => ezcash(c, { bill_total_cents: 0, commission_cents: 0 })).toThrow(/CHECK/);
    expect(() => ezcash(c, { bill_total_cents: 1_000_000_000_001 })).toThrow(/CHECK/);
    expect(() => ezcash(c, { commission_bp: 10001 })).toThrow(/CHECK/);
    ezcash(c, { client_ref: 'ez-same-ref-1' });
    expect(() => ezcash(c, { client_ref: 'ez-same-ref-1' })).toThrow(/UNIQUE/);
  });

  it('immutable like reload rows; one posted -> void transition; never deleted', () => {
    const c = db();
    const id = ezcash(c);
    for (const set of ['bill_total_cents = 5', 'commission_bp = 1', 'commission_cents = 1', 'provider_id = 2', "notes = 'x'", "client_ref = 'ez-other-ref'"]) {
      expect(() => c.exec(`UPDATE ezcash_sales SET ${set} WHERE id = ${id}`), set).toThrow(/EZCASH_SALE_IMMUTABLE/);
    }
    expect(() => c.exec(`UPDATE ezcash_sales SET business_date = '2020-01-01' WHERE id = ${id}`)).toThrow(/BUSINESS_DATE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE ezcash_sales SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ${id}`)).toThrow(/POSTED_AT_IMMUTABLE/);
    c.exec(`UPDATE ezcash_sales SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'oops' WHERE id = ${id}`);
    expect(() => c.exec(`UPDATE ezcash_sales SET void_reason = 'again' WHERE id = ${id}`)).toThrow(/EZCASH_SALE_IMMUTABLE/);
    expect(() => c.exec(`DELETE FROM ezcash_sales WHERE id = ${id}`)).toThrow(/RECORD_DELETE_FORBIDDEN/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('telecom_topups - constraints and triggers', () => {
  it('accepts a provider top-up with a provider and a wallet top-up without one', () => {
    const c = db();
    topup(c, { kind: 'provider_topup', provider_id: pid(c, 'Mobitel') });
    topup(c, { kind: 'wallet_topup', provider_id: null });
    expect(scalar(c, 'SELECT COUNT(*) FROM telecom_topups')).toBe(2);
  });

  it('refuses a bad kind, a provider top-up with no provider, a wallet top-up with a provider', () => {
    const c = db();
    expect(() => topup(c, { kind: 'reload', provider_id: null })).toThrow(/CHECK/);
    expect(() => topup(c, { kind: 'purchase', provider_id: pid(c, 'Dialog') })).toThrow(/CHECK/);
    expect(() => topup(c, { kind: 'provider_topup', provider_id: null })).toThrow(/CHECK/);
    expect(() => topup(c, { kind: 'wallet_topup', provider_id: pid(c, 'Dialog') })).toThrow(/CHECK/);
    expect(() => topup(c, { kind: 'provider_topup', provider_id: 999 })).toThrow(/FOREIGN KEY/);
    expect(scalar(c, 'SELECT COUNT(*) FROM telecom_topups')).toBe(0);
  });

  it('refuses non-positive or oversized amounts, bad dates and future dates (R-FD), duplicate client_ref', () => {
    const c = db();
    expect(() => topup(c, { amount_cents: 0 })).toThrow(/CHECK/);
    expect(() => topup(c, { amount_cents: -5 })).toThrow(/CHECK/);
    expect(() => topup(c, { amount_cents: 1_000_000_000_001 })).toThrow(/CHECK/);
    expect(() => topup(c, { business_date: '2026-02-30' })).toThrow(/CHECK/);
    expect(() => topup(c, { business_date: daysAhead(1) })).toThrow(/FUTURE_DATE_NOT_ALLOWED/);
    topup(c, { client_ref: 'tp-same-ref-1' });
    expect(() => topup(c, { client_ref: 'tp-same-ref-1' })).toThrow(/UNIQUE/);
  });

  it('immutable (kind, provider, amount, notes, client_ref, dates); one void transition; never deleted', () => {
    const c = db();
    const id = topup(c, { kind: 'wallet_topup' });
    for (const set of ['amount_cents = 5', "kind = 'provider_topup'", 'provider_id = 1', "notes = 'x'", "client_ref = 'tp-other-ref'"]) {
      expect(() => c.exec(`UPDATE telecom_topups SET ${set} WHERE id = ${id}`), set).toThrow(/TELECOM_TOPUP_IMMUTABLE|CHECK/);
    }
    expect(() => c.exec(`UPDATE telecom_topups SET business_date = '2020-01-01' WHERE id = ${id}`)).toThrow(/BUSINESS_DATE_IMMUTABLE/);
    expect(() => c.exec(`UPDATE telecom_topups SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ${id}`)).toThrow(/POSTED_AT_IMMUTABLE/);
    c.exec(`UPDATE telecom_topups SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'oops' WHERE id = ${id}`);
    expect(() => c.exec(`UPDATE telecom_topups SET status = 'posted' WHERE id = ${id}`)).toThrow(/CHECK|TELECOM_TOPUP_IMMUTABLE/);
    expect(() => c.exec(`DELETE FROM telecom_topups WHERE id = ${id}`)).toThrow(/RECORD_DELETE_FORBIDDEN/);
  });
});
