// Phase 19 audit, part C: DATABASE protection of closed days (CHARACTERIZATION tests: they pass today and pin down which table is protected
// by a trigger and which one only by the service layer; a gap is a finding, not a failure). Raw SQL, bypassing every service.
//
// World: Shop, Telecom and Ice Cream are all closed on C; E (earlier) and L (later) are open. Every probe runs inside a SAVEPOINT that is rolled back.
//   PROTECTED by a trigger (migrations 012/014/016): cash_entries (all books) INSERT; icecream_days / icecream_payments / icecream_fund_moves INSERT;
//     icecream_days and icecream_fund_moves status posted -> void.
//   NOT protected by the database (service layer only): every other table, INSERT and status -> void: icecream_fund_entries, icecream_sales,
//     stock_movements, stock_losses, stocktakes, owner_drawings, opening_stock_batches, sales, sales_returns, purchases, purchase_returns, expenses,
//     capital_entries, cash_counts, reload_sales, ezcash_sales, telecom_topups, print_sales, printing_supplies, cash_transfers, import_runs;
//     void flips of icecream_payments and of all cash-bearing headers (their reversal CASH row IS refused by the cash_entries trigger).

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import { sqlPrintSale, sqlSupply } from './helpers/phase7.ts';
import { sqlReturn, sqlSale } from './helpers/phase5.ts';
import { closeNew, reopenNew } from './helpers/phase8.ts';
import { ALL_BOOKS, C, E, L, M, OLD, allOps, closeBooks, fixture, must } from './helpers/phase19cd.ts';
import type { Book, Fx } from './helpers/phase19cd.ts';
import { assertDayOpen } from '../services/day-closing.ts';
import { AppError } from '../lib/errors.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

type Out = 'ok' | 'DAY_CLOSED' | 'BACKDATE_BEFORE_CLOSED_DAY' | string;

/** Runs `fn` in a savepoint, always rolls back, and returns 'ok' or the abort message of the database. */
function probe(fx: Fx, fn: () => unknown): Out {
  const conn = fx.s.ctx.database.conn;
  conn.exec('SAVEPOINT pr');
  try { fn(); return 'ok'; } catch (e) { return (e as Error).message; } finally { conn.exec('ROLLBACK TO pr'); conn.exec('RELEASE pr'); }
}

/** The tables that have a status flip (void) and the registry operation that creates a posted record in them. */
const VOIDABLE: Record<string, string> = {
  expenses: 'expense (shop)', capital_entries: 'capital (shop)', cash_counts: 'cash count with adjustment (shop)', cash_transfers: 'transfer shop -> telecom',
  purchases: 'purchase (shop)', sales: 'sale (shop)', reload_sales: 'reload sale', ezcash_sales: 'EZCash bill', telecom_topups: 'wallet top-up',
  print_sales: 'print sale', printing_supplies: 'printing supplies', owner_drawings: 'cash drawing (shop)', stock_losses: 'stock loss (shop)',
  stocktakes: 'stocktake complete (shop)', opening_stock_batches: 'opening stock manual (shop)', icecream_days: 'ice cream daily entry (create)',
  icecream_payments: 'ice cream payment (materials)', icecream_fund_moves: 'ice cream fund move',
};

interface World { fx: Fx; recs: Record<string, { E: number; C: number }>; saleId: number; purchaseId: number; closings: Record<string, any> }

/** Builds the world: records dated E and C of every voidable kind (made through the API while everything is open), then all books closed on C. */
async function world(): Promise<World> {
  const s = await apiBase(await env.build());
  const fx = await fixture(s);
  const conn = s.ctx.database.conn;
  const recs: World['recs'] = {};
  const lastId = (t: string): number => Number((conn.prepare(`SELECT MAX(id) AS m FROM ${t}`).get() as unknown as { m: number }).m);
  for (const [t, key] of Object.entries(VOIDABLE)) {
    const op = allOps().find((o) => o.key === key)!;
    must(await op.create(fx, E()));
    const e = lastId(t);
    must(await op.create(fx, C()));
    recs[t] = { E: e, C: lastId(t) };
  }
  const saleId = sqlSale(conn, { date: OLD(), book: 'shop' });
  const purchaseId = Number(conn.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 0, ?)").run(OLD(), ref()).lastInsertRowid);
  const closings = await closeBooks(s, ALL_BOOKS, C());
  return { fx, recs, saleId, purchaseId, closings };
}

type Ins = (w: World, d: string) => unknown;
const run = (w: World, sql: string, ...p: any[]) => w.fx.s.ctx.database.conn.prepare(sql).run(...p);
const conn = (w: World) => w.fx.s.ctx.database.conn;

/** [table, insert, protectedByDatabase] */
const INSERTS: Array<[string, Ins, boolean]> = [
  ['cash_entries (shop)', (w, d) => run(w, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('shop', ?, 'capital', 100)", d), true],
  ['cash_entries (telecom)', (w, d) => run(w, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('telecom', ?, 'capital', 100)", d), true],
  ['cash_entries (icecream)', (w, d) => run(w, "INSERT INTO cash_entries (book, business_date, type, amount_cents, fund) VALUES ('icecream', ?, 'capital', 100, 'cost')", d), true],
  ['icecream_days', (w, d) => run(w, 'INSERT INTO icecream_days (business_date, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents, client_ref) VALUES (?, 0, 0, 0, 0, ?)', d, ref()), true],
  ['icecream_payments', (w, d) => run(w, "INSERT INTO icecream_payments (business_date, kind, fund, amount_cents, description, client_ref) VALUES (?, 'materials', 'cost', 100, 'x', ?)", d, ref()), true],
  ['icecream_fund_moves', (w, d) => run(w, "INSERT INTO icecream_fund_moves (business_date, from_fund, to_fund, amount_cents, profit_effect_cents, client_ref) VALUES (?, 'cost', 'electricity', 100, 0, ?)", d, ref()), true],
  ['icecream_fund_entries', (w, d) => run(w, "INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind) VALUES (?, 'cost', 100, 'opening_balance')", d), false],
  ['stock_movements', (w, d) => run(w, "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'adjustment', 0, 1)", w.fx.shopP.id, d), false],
  ['stock_losses', (w, d) => run(w, "INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, client_ref) VALUES (?, ?, 'shop', 1, 10, 'lost', ?)", d, w.fx.shopP.id, ref()), false],
  ['stocktakes', (w, d) => run(w, "INSERT INTO stocktakes (business_date, book, client_ref) VALUES (?, 'shop', ?)", d, ref()), false],
  ['owner_drawings (cash)', (w, d) => run(w, "INSERT INTO owner_drawings (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'shop', 'cash', 100, ?)", d, ref()), false],
  ['opening_stock_batches', (w, d) => run(w, "INSERT INTO opening_stock_batches (business_date, source, row_count, total_value_cents, client_ref) VALUES (?, 'manual', 0, 0, ?)", d, ref()), false],
  ['sales', (w, d) => sqlSale(conn(w), { date: d }), false],
  ['sales_returns', (w, d) => sqlReturn(conn(w), w.saleId, { date: d }), false],
  ['purchases', (w, d) => run(w, "INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 0, ?)", d, ref()), false],
  ['purchase_returns', (w, d) => run(w, 'INSERT INTO purchase_returns (purchase_id, business_date, refund_cents, client_ref) VALUES (?, ?, 0, ?)', w.purchaseId, d, ref()), false],
  ['expenses', (w, d) => run(w, "INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'shop', 'rent', 100, 'x', ?)", d, ref()), false],
  ['capital_entries', (w, d) => run(w, "INSERT INTO capital_entries (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'shop', 'capital', 100, ?)", d, ref()), false],
  ['cash_counts', (w, d) => run(w, "INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, client_ref) VALUES ('shop', ?, 0, 0, 0, ?)", d, ref()), false],
  ['reload_sales', (w, d) => run(w, 'INSERT INTO reload_sales (business_date, provider_id, sales_cents, commission_bp, commission_cents, client_ref) VALUES (?, ?, 1000, 600, 60, ?)', d, w.fx.prov.Dialog, ref()), false],
  ['ezcash_sales', (w, d) => run(w, 'INSERT INTO ezcash_sales (business_date, provider_id, bill_total_cents, commission_bp, commission_cents, client_ref) VALUES (?, ?, 1000, 80, 8, ?)', d, w.fx.prov.Dialog, ref()), false],
  ['telecom_topups', (w, d) => run(w, "INSERT INTO telecom_topups (business_date, kind, amount_cents, client_ref) VALUES (?, 'wallet_topup', 100, ?)", d, ref()), false],
  ['print_sales', (w, d) => sqlPrintSale(conn(w), { date: d }), false],
  ['printing_supplies', (w, d) => sqlSupply(conn(w), { date: d }), false],
  ['cash_transfers', (w, d) => run(w, "INSERT INTO cash_transfers (business_date, from_book, to_book, amount_cents, client_ref) VALUES (?, 'shop', 'telecom', 100, ?)", d, ref()), false],
  ['import_runs', (w, d) => run(w, "INSERT INTO import_runs (kind, file_name, file_sha256, business_date, mode, status, rows_total, rows_ok, rows_failed) VALUES ('opening_stock', 'f.xlsx', ?, ?, 'preview', 'previewed', 0, 0, 0)", 'a'.repeat(64), d), false],
];

describe('database protection: raw INSERT dated before / on the latest closed day (all books closed on C)', () => {
  it.each(INSERTS)('%s', async (name, ins, protectedByDb) => {
    const w = await world();
    const e = probe(w.fx, () => ins(w, E()));
    const c = probe(w.fx, () => ins(w, C()));
    const l = probe(w.fx, () => ins(w, L()));
    expect(l, `${name} dated L (later than every closed day) must be accepted`).toBe('ok');
    if (protectedByDb) {
      expect(c, `${name} on the closed day`).toContain('DAY_CLOSED');
      expect(e, `${name} before the closed day`).toContain('BACKDATE_BEFORE_CLOSED_DAY');
    } else {
      // GAP (finding D-1, Medium): the database accepts a row dated on / before a closed day; only the service layer refuses it.
      expect([e, c], `${name}: service-layer-only protection`).toEqual(['ok', 'ok']);
    }
  });
});

describe('database protection: raw void flip (status posted -> void) of a record dated E / C', () => {
  const PROTECTED = new Set(['icecream_days', 'icecream_fund_moves']);
  it.each(Object.keys(VOIDABLE))('%s', async (t) => {
    const w = await world();
    const flip = (id: number) => probe(w.fx, () => run(w, `UPDATE ${t} SET status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'raw' WHERE id = ?`, id));
    const e = flip(w.recs[t]!.E);
    const c = flip(w.recs[t]!.C);
    // Migration 020 (M2): a record that has cash / stock / fund rows can no longer be flipped without its reversal rows at all
    // (VOID_WITHOUT_REVERSAL answers before the closed-day triggers); a record without ledger rows still meets the rules below.
    const ledger = (id: number) => Number((conn(w).prepare(`SELECT (SELECT COUNT(*) FROM cash_entries WHERE ref_table = '${t}' AND ref_id = ?)
      + (SELECT COUNT(*) FROM stock_movements WHERE ref_table = '${t}' AND ref_id = ?)
      + (SELECT COUNT(*) FROM icecream_fund_entries WHERE ref_table = '${t}' AND ref_id = ?) AS n`).get(id, id, id) as any).n);
    if (ledger(w.recs[t]!.E) > 0 && ledger(w.recs[t]!.C) > 0) {
      expect(e).toContain('VOID_WITHOUT_REVERSAL');
      expect(c).toContain('VOID_WITHOUT_REVERSAL');
    } else if (PROTECTED.has(t)) {
      expect(e).toContain('BACKDATE_BEFORE_CLOSED_DAY');
      expect(c).toContain('DAY_CLOSED');
    } else {
      // GAP (finding D-2, Medium): the flag flips; only the reversal CASH row (separate insert) is refused by trg_cash_entries_day_closed.
      expect([e, c]).toEqual(['ok', 'ok']);
    }
  });
});

describe('database protection: reversal rows, other books, reopen / re-close', () => {
  it('a raw reversal cash row copying a closed date is refused exactly like any cash row', async () => {
    const w = await world();
    // (migration 020: a row that claims to reverse another must mirror its amount, book, fund AND date, so each probe reverses an original
    // dated like the reversal; the original dated L is written first, L being open)
    run(w, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('shop', ?, 'capital', 500)", L());
    const origOn = (d: string) => conn(w).prepare("SELECT id, type, amount_cents FROM cash_entries WHERE book = 'shop' AND business_date = ? AND reverses_entry_id IS NULL AND amount_cents <> 0 AND NOT EXISTS (SELECT 1 FROM cash_entries r WHERE r.reverses_entry_id = cash_entries.id) LIMIT 1").get(d) as unknown as { id: number; type: string; amount_cents: number };
    expect(origOn(E())).toBeTruthy();
    expect(origOn(C())).toBeTruthy();
    const rev = (d: string) => { const o = origOn(d); return probe(w.fx, () => run(w, `INSERT INTO cash_entries (book, business_date, type, amount_cents, reverses_entry_id) VALUES ('shop', ?, '${o.type}', ?, ?)`, d, -o.amount_cents, o.id)); };
    expect(rev(E())).toContain('BACKDATE_BEFORE_CLOSED_DAY');
    expect(rev(C())).toContain('DAY_CLOSED');
    expect(rev(L())).toBe('ok');
  });

  it('only the closed book is protected: with Shop closed, raw Telecom and Ice Cream rows dated E and C are accepted', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    await closeBooks(s, ['shop'], C());
    const w = { fx } as World;
    const ins = (book: Book, d: string) => probe(fx, () => run(w, `INSERT INTO cash_entries (book, business_date, type, amount_cents${book === 'icecream' ? ', fund' : ''}) VALUES ('${book}', ?, 'capital', 100${book === 'icecream' ? ", 'cost'" : ''})`, d));
    for (const d of [E(), C(), L()]) { expect(ins('telecom', d)).toBe('ok'); expect(ins('icecream', d)).toBe('ok'); }
    expect(ins('shop', E())).toContain('BACKDATE_BEFORE_CLOSED_DAY');
    expect(ins('shop', C())).toContain('DAY_CLOSED');
    expect(ins('shop', L())).toBe('ok');
  });

  it('reopening lifts the trigger (E and C accepted); re-closing the same row brings it back; M < C reopened leaves C as the latest closed day', async () => {
    const w = await world();
    const sOf = w.fx.s;
    const ins = (d: string) => probe(w.fx, () => run(w, "INSERT INTO cash_entries (book, business_date, type, amount_cents) VALUES ('shop', ?, 'capital', 100)", d));
    expect(ins(E())).toContain('BACKDATE_BEFORE_CLOSED_DAY');
    const mClosing = must(await closeNew(sOf, 'shop', M())).body.item; // M closed out of order (C is already closed)
    expect(ins(M())).toContain('DAY_CLOSED');
    must(await reopenNew(sOf, w.closings.shop.id, 'raw test'));       // C reopened: the latest closed day is M now
    expect(ins(C())).toBe('ok');
    expect(ins(daysAgo(5))).toContain('BACKDATE_BEFORE_CLOSED_DAY');  // earlier than M
    must(await reopenNew(sOf, mClosing.id, 'raw test'));
    expect(ins(E())).toBe('ok');
    expect(ins(M())).toBe('ok');
    must(await closeNew(sOf, 'shop', C()));                            // the SAME row is re-closed
    expect(ins(E())).toContain('BACKDATE_BEFORE_CLOSED_DAY');
    expect(ins(C())).toContain('DAY_CLOSED');
  });
});

describe('server check vs database trigger: they must give the same verdict for every book and date', () => {
  it('assertDayOpen (service) and the cash_entries / Ice Cream record triggers agree on a grid of dates under several closing states', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const w = { fx } as World;
    const connection = s.ctx.database.conn;
    const dates = Array.from({ length: 9 }, (_, i) => daysAgo(8 - i)); // 8 days ago ... today
    const verdictService = (book: Book, d: string): Out => {
      try { assertDayOpen(connection, [book], d); return 'ok'; } catch (e) { return (e as AppError).code; }
    };
    const verdictDb = (book: Book, d: string): Out => {
      const r = probe(fx, () => run(w, `INSERT INTO cash_entries (book, business_date, type, amount_cents${book === 'icecream' ? ', fund' : ''}) VALUES ('${book}', ?, 'capital', 1${book === 'icecream' ? ", 'cost'" : ''})`, d));
      return r === 'ok' ? 'ok' : r.includes('BACKDATE') ? 'BACKDATE_BEFORE_CLOSED_DAY' : r.includes('DAY_CLOSED') ? 'DAY_CLOSED' : `OTHER:${r}`;
    };
    const verdictIceRecords = (d: string): Out[] => {
      const t = [
        () => run(w, 'INSERT INTO icecream_days (business_date, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents, client_ref) VALUES (?, 0, 0, 0, 0, ?)', d, ref()),
        () => run(w, "INSERT INTO icecream_payments (business_date, kind, fund, amount_cents, description, client_ref) VALUES (?, 'materials', 'cost', 100, 'x', ?)", d, ref()),
        () => run(w, "INSERT INTO icecream_fund_moves (business_date, from_fund, to_fund, amount_cents, profit_effect_cents, client_ref) VALUES (?, 'cost', 'electricity', 100, 0, ?)", d, ref()),
      ];
      return t.map((f) => { const r = probe(fx, f); return r === 'ok' ? 'ok' : r.includes('BACKDATE') ? 'BACKDATE_BEFORE_CLOSED_DAY' : r.includes('DAY_CLOSED') ? 'DAY_CLOSED' : `OTHER:${r}`; });
    };
    const compare = (label: string) => {
      for (const book of ALL_BOOKS) {
        for (const d of dates) {
          const a = verdictService(book, d);
          expect(verdictDb(book, d), `${label}: ${book} ${d} service=${a}`).toBe(a);
          if (book === 'icecream') for (const v of verdictIceRecords(d)) expect(v, `${label}: ice record ${d}`).toBe(a);
        }
      }
    };
    compare('nothing closed');
    const sh = await closeBooks(s, ['shop'], daysAgo(5));
    const sh2 = await closeBooks(s, ['shop'], daysAgo(3));
    const te = await closeBooks(s, ['telecom'], daysAgo(1));
    const ic = await closeBooks(s, ['icecream'], today0());
    compare('shop {5,3} telecom {1} icecream {today}');
    must(await reopenNew(s, sh2.shop.id, 'agree test'));
    compare('shop {5} telecom {1} icecream {today}');
    must(await reopenNew(s, te.telecom.id, 'agree test'));
    must(await reopenNew(s, ic.icecream.id, 'agree test'));
    compare('shop {5} only');
    must(await reopenNew(s, sh.shop.id, 'agree test'));
    compare('all reopened');
    must(await closeNew(s, 'shop', daysAgo(5)));
    must(await closeNew(s, 'shop', daysAgo(3)));
    compare('shop {5,3} again');
  });
});

function today0(): string { return daysAgo(0); }
