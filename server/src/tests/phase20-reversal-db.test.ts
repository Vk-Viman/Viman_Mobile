// PHASE 20 - migration 020 (hardening M2, M3, M4, L2): the DATABASE guards void status, stock reversals and duplicate return effects.
// Raw SQL on a real world built through the API (every probe runs inside a rolled-back SAVEPOINT unless stated):
//   * on EVERY voidable table a raw `status = 'void'` flip without the reversal rows is refused (VOID_WITHOUT_REVERSAL); with the reversal rows
//     written first (the order every void service uses) it is accepted; afterwards un-void / any other change is refused;
//   * a second reversal (cash, fund or stock row), a reversal that does not mirror its original, and any new row on a void record are refused;
//   * INSERT OR REPLACE cannot overwrite an append-only row; schema_migrations cannot be rewritten;
//   * records without ledger rows (a draft stocktake) are exempt.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { cl, rl, returnOk, sellOk } from './helpers/phase5.ts';
import { drawNew, lossNew, stComplete, stDraft } from './helpers/phase4.ts';
import { ez, rel, topWallet } from './helpers/phase6.ts';
import { psNew, supNew } from './helpers/phase7.ts';
import { capNew, drawCash, tr } from './helpers/phase9.ts';
import { countNew, expNew } from './helpers/phase8.ts';
import { dayOk, moveOk, payOk, rs } from './helpers/phase10.ts';
import { must } from './helpers/phase14.ts';
import { post } from './helpers/catalog.ts';
import { n1, probe, rows, statusTables } from './helpers/phase19h.ts';
import type { DatabaseSync } from 'node:sqlite';

const env = new TestEnv();
const D = '2025-09-10';
const VOIDED_AT = '2025-09-20T00:00:00.000Z';

let s: ApiBase;
let conn: DatabaseSync;
/** table -> id of one POSTED record with ledger effects */
const rec: Record<string, number> = {};
let draftStocktake = 0;

const maxId = (t: string): number => n1(s.ctx, `SELECT MAX(id) FROM "${t}"`);
const stocked = async (units: number, value: number): Promise<number> => {
  const p = await mkProduct(s, { sellPriceCents: 100000, minPriceCents: 0 });
  await buy(s, [{ productId: p.id, packs: 1, packSize: units, lineTotalCents: value }], { businessDate: '2025-09-01' });
  return p.id;
};

beforeAll(async () => {
  s = await apiBase(await env.build());
  conn = s.ctx.database.conn;
  const d = { businessDate: D };
  // sales and returns (one product each, so a reversal can never be blocked by later use of the stock)
  const p1 = await stocked(10, 1000);
  rec.sales = (await sellOk(s, [cl(p1, 2, 500)], d)).sales[0].id;
  const p2 = await stocked(10, 1000);
  const s2 = (await sellOk(s, [cl(p2, 4, 500)], d)).sales[0];
  rec.sales_returns = (await returnOk(s, s2.id, [rl(s2.items[0].id, 2, true)], d)).item.id;
  const p2b = await stocked(10, 1000);
  const s3 = (await sellOk(s, [cl(p2b, 4, 500)], d)).sales[0];
  rec.damaged_return = (await returnOk(s, s3.id, [rl(s3.items[0].id, 1, false)], d)).item.id;
  const p3 = await stocked(10, 1000);
  rec.purchases = (await buy(s, [{ productId: p3, packs: 1, packSize: 5, lineTotalCents: 500 }], d)).id;
  const p4 = await stocked(10, 1000);
  rec.stock_losses = (await must(await lossNew(s, p4, 2, { ...d, reason: 'damaged' }), 'loss')).item.id;
  const p5 = await stocked(10, 1000);
  const st = await stDraft(s, [{ productId: p5, countedQty: 12 }], { ...d, book: 'shop' });
  await must(await stComplete(s, st.id), 'stocktake');
  rec.stocktakes = st.id;
  const p5b = await stocked(10, 1000);
  draftStocktake = (await stDraft(s, [{ productId: p5b, countedQty: 9 }], { ...d, book: 'shop' })).id;
  const p6 = await stocked(10, 1000);
  rec.owner_drawings = (await must(await drawNew(s, p6, 1, d), 'goods drawing')).item.id;
  rec.cash_drawing = (await must(await drawCash(s, { ...d, book: 'shop', amountCents: rs(500) }), 'cash drawing')).item.id;
  const p7 = await mkProduct(s, { sellPriceCents: 100000, minPriceCents: 0 });
  await must(await post(s.app, '/opening-stock', { ...d, items: [{ productId: p7.id, qty: 5, totalValueCents: rs(500) }], clientRef: ref() }), 'opening stock');
  rec.opening_stock_batches = maxId('opening_stock_batches');
  rec.expenses = (await must(await expNew(s, { ...d, book: 'telecom', category: 'repairs', amountCents: rs(111) }), 'expense')).item.id;
  rec.capital_entries = (await must(await capNew(s, { ...d, book: 'telecom', amountCents: rs(700) }), 'capital')).item.id;
  rec.cash_counts = (await must(await countNew(s, 'telecom', 1000, { ...d, note: 'count' }), 'count')).item.id;
  await must(await rel(s, 1, rs(1000), d), 'reload'); rec.reload_sales = maxId('reload_sales');
  await must(await ez(s, rs(5000), d), 'ezcash'); rec.ezcash_sales = maxId('ezcash_sales');
  await must(await topWallet(s, rs(1000), d), 'topup'); rec.telecom_topups = maxId('telecom_topups');
  await must(await psNew(s, { ...d, qty: 10 }, 'BW_1S'), 'print'); rec.print_sales = maxId('print_sales');
  await must(await supNew(s, { ...d, amountCents: rs(300), description: 'Ink' }), 'supply'); rec.printing_supplies = maxId('printing_supplies');
  await must(await tr(s, 'shop', 'telecom', rs(1000), d), 'transfer'); rec.cash_transfers = maxId('cash_transfers');
  await must(await tr(s, 'shop', 'icecream', rs(400), { ...d, toFund: 'profit' }), 'transfer ice'); rec.cash_transfers_ice = maxId('cash_transfers');
  await dayOk(s, { businessDate: '2025-09-09', salesCents: rs(30000), costAllocCents: rs(6000), electricityAllocCents: rs(1000) });
  await dayOk(s, { ...d, salesCents: rs(2500), costAllocCents: rs(2000), electricityAllocCents: rs(500) });
  rec.icecream_days = n1(s.ctx, "SELECT id FROM icecream_days WHERE business_date = ? AND status = 'posted'", D);
  await payOk(s, 'materials', rs(150), { fund: 'cost', ...d }); rec.icecream_payments = maxId('icecream_payments');
  await moveOk(s, 'cost', 'electricity', rs(100), d); rec.icecream_fund_moves = maxId('icecream_fund_moves');
}, 120000);

afterAll(async () => { await env.cleanup(); });

/** The 19 voidable tables of the database (read from the schema so a new one cannot be forgotten). */
const TABLES = [
  'sales', 'sales_returns', 'purchases', 'stock_losses', 'stocktakes', 'owner_drawings', 'opening_stock_batches', 'expenses', 'capital_entries',
  'cash_counts', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales', 'printing_supplies', 'cash_transfers', 'icecream_days',
  'icecream_payments', 'icecream_fund_moves',
];
const recId = (t: string): number => rec[t] as number;

/** Writes the reversal rows of one record the way the void services do: stock (newest first), cash, then the Ice Cream fund rows. */
function reverseRaw(table: string, id: number): void {
  const c = conn;
  for (const o of c.prepare(`SELECT * FROM stock_movements o WHERE ref_table = ? AND ref_id = ? AND reverses_movement_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id) ORDER BY id DESC`).all(table, id) as any[]) {
    if (o.type === 'adjustment' && o.qty_delta === 0) continue;
    c.prepare(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason, reverses_movement_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'raw reversal', ?)`)
      .run(o.product_id, o.business_date, o.type, -o.qty_delta, -o.value_delta_cents, o.unit_cost_cents, table, id, o.id);
  }
  for (const o of c.prepare(`SELECT * FROM cash_entries o WHERE ref_table = ? AND ref_id = ? AND reverses_entry_id IS NULL AND amount_cents <> 0
      AND NOT EXISTS (SELECT 1 FROM cash_entries r WHERE r.reverses_entry_id = o.id) ORDER BY id DESC`).all(table, id) as any[]) {
    c.prepare(`INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, transfer_id, reverses_entry_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'raw reversal')`)
      .run(o.book, o.business_date, o.type, -o.amount_cents, o.fund, table, id, o.transfer_id, o.id);
  }
  for (const o of c.prepare(`SELECT * FROM icecream_fund_entries o WHERE ref_table = ? AND ref_id = ? AND reverses_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM icecream_fund_entries r WHERE r.reverses_entry_id = o.id) ORDER BY id DESC`).all(table, id) as any[]) {
    c.prepare(`INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind, ref_table, ref_id, reverses_entry_id, note)
      VALUES (?, ?, ?, 'reversal', ?, ?, ?, 'raw reversal')`).run(o.business_date, o.fund, -o.amount_cents, table, id, o.id);
  }
}

const flipSql = (t: string, id: number): string => `UPDATE ${t} SET status = 'void', voided_at = '${VOIDED_AT}', void_reason = 'raw' WHERE id = ${id}`;
const tableOf = (key: string): string => (key === 'damaged_return' ? 'sales_returns' : key === 'cash_drawing' ? 'owner_drawings' : key === 'cash_transfers_ice' ? 'cash_transfers' : key);

/** Runs `fn` inside a savepoint that is always rolled back; returns what fn returned. */
function inSavepoint<T>(fn: () => T): T {
  conn.exec('SAVEPOINT p20');
  try { return fn(); } finally { conn.exec('ROLLBACK TO p20'); conn.exec('RELEASE p20'); }
}
const msg = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as Error).message; } };

describe('the world has a posted record with ledger effects of every voidable table', () => {
  it('lists exactly the status tables of the schema and each has a record', () => {
    expect(statusTables(s.ctx).filter((t) => t !== 'purchase_returns').sort()).toEqual([...TABLES].sort());
    for (const t of TABLES) expect(recId(t), t).toBeGreaterThan(0);
    for (const t of TABLES) expect(Object.keys(rec).includes(t), t).toBe(true);
    // each table has the VOID_WITHOUT_REVERSAL trigger
    for (const t of TABLES) {
      expect(rows(s.ctx, `SELECT name FROM sqlite_master WHERE type='trigger' AND name = 'trg_${t}_void_requires_reversal' AND tbl_name = '${t}'`).length, t).toBe(1);
    }
  });
});

describe('M2: a raw posted -> void flip needs the reversal rows first, on every table', () => {
  const keys = ['sales', 'sales_returns', 'damaged_return', 'purchases', 'stock_losses', 'stocktakes', 'owner_drawings', 'cash_drawing', 'opening_stock_batches',
    'expenses', 'capital_entries', 'cash_counts', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'print_sales', 'printing_supplies', 'cash_transfers',
    'cash_transfers_ice', 'icecream_days', 'icecream_payments', 'icecream_fund_moves'];

  it.each(keys)('%s', (key) => {
    const t = tableOf(key);
    const id = recId(key);
    const ledger = n1(s.ctx, `SELECT (SELECT COUNT(*) FROM cash_entries WHERE ref_table = '${t}' AND ref_id = ${id}) + (SELECT COUNT(*) FROM stock_movements WHERE ref_table = '${t}' AND ref_id = ${id})
      + (SELECT COUNT(*) FROM icecream_fund_entries WHERE ref_table = '${t}' AND ref_id = ${id})`);
    if (key !== 'damaged_return') expect(ledger, `${key} must have ledger rows`).toBeGreaterThan(0);
    // 1. without the reversal rows: refused (a damaged return has a refund entry, so it is refused too)
    expect(probe(s.ctx, flipSql(t, id)), `${key}: flip without reversals`).toMatch(/VOID_WITHOUT_REVERSAL/);
    // 3. with all reversals first: accepted; then terminal
    inSavepoint(() => {
      reverseRaw(t, id);
      conn.exec(flipSql(t, id));
      expect(n1(s.ctx, `SELECT COUNT(*) FROM ${t} WHERE id = ${id} AND status = 'void'`)).toBe(1);
      // net effect zero (stock value may be capped for returns/purchases only if the pool was short: not here)
      expect(n1(s.ctx, `SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE ref_table = '${t}' AND ref_id = ${id}`)).toBe(0);
      expect(n1(s.ctx, `SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE ref_table = '${t}' AND ref_id = ${id}`)).toBe(0);
      expect(n1(s.ctx, `SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries WHERE ref_table = '${t}' AND ref_id = ${id}`)).toBe(0);
      // void is terminal: un-void, a second flip and any edit of the void data are refused
      expect(msg(() => conn.exec(`UPDATE ${t} SET status = 'posted', voided_at = NULL, void_reason = NULL WHERE id = ${id}`)), `${key}: un-void`).not.toBeNull();
      expect(msg(() => conn.exec(flipSql(t, id).replace("'raw'", "'raw2'"))), `${key}: second flip with other data`).not.toBeNull();
      expect(msg(() => conn.exec(`UPDATE ${t} SET void_reason = 'changed' WHERE id = ${id}`)), `${key}: edit void data`).not.toBeNull();
      expect(msg(() => conn.exec(`UPDATE ${t} SET status = 'cancelled' WHERE id = ${id}`)), `${key}: other status`).not.toBeNull();
      // nothing can be attached to the void record any more, and the reversals cannot be repeated
      if (['stock_losses', 'stocktakes', 'opening_stock_batches'].includes(t)) {
        const pid = n1(s.ctx, 'SELECT MIN(id) FROM products');
        expect(msg(() => conn.exec(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (${pid}, '${D}', 'adjustment', 1, 1, '${t}', ${id}, 'x')`)), `${key}: new movement`)
          .toMatch(/RECORD_VOID/);
      } else {
        expect(msg(() => conn.exec(`INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', '${D}', 'capital', -1, '${t}', ${id})`)), `${key}: new cash row`)
          .toMatch(/RECORD_VOID|UNIQUE|DAY_CLOSED/);
      }
      expect(msg(() => reverseRaw(t, id))).toBeNull(); // nothing left to reverse: no-op
    });
    // everything was rolled back
    expect(n1(s.ctx, `SELECT COUNT(*) FROM ${t} WHERE id = ${id} AND status <> 'void'`)).toBe(1);
  });

  it('a flip with only SOME of the reversals is refused (purchase: stock reversed, cash not; transfer: one leg)', () => {
    inSavepoint(() => {
      const o = conn.prepare("SELECT * FROM stock_movements WHERE ref_table = 'purchases' AND ref_id = ? AND reverses_movement_id IS NULL").get(recId('purchases')) as any;
      conn.prepare(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason, reverses_movement_id)
        VALUES (?, ?, 'purchase_void', ?, ?, 'purchases', ?, 'x', ?)`).run(o.product_id, o.business_date, -o.qty_delta, -o.value_delta_cents, recId('purchases'), o.id);
      expect(msg(() => conn.exec(flipSql('purchases', recId('purchases'))))).toMatch(/VOID_WITHOUT_REVERSAL/);
    });
    inSavepoint(() => {
      const legs = conn.prepare("SELECT * FROM cash_entries WHERE ref_table = 'cash_transfers' AND ref_id = ? AND reverses_entry_id IS NULL ORDER BY id").all(recId('cash_transfers')) as any[];
      expect(legs.length).toBe(2);
      const o = legs[0];
      conn.prepare(`INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, transfer_id, reverses_entry_id) VALUES (?, ?, ?, ?, ?, 'cash_transfers', ?, ?, ?)`)
        .run(o.book, o.business_date, o.type, -o.amount_cents, o.fund, recId('cash_transfers'), o.transfer_id, o.id);
      expect(msg(() => conn.exec(flipSql('cash_transfers', recId('cash_transfers'))))).toMatch(/VOID_WITHOUT_REVERSAL/);
    });
    inSavepoint(() => {
      // Ice Cream: cash reversed, fund rows not
      const o = conn.prepare("SELECT * FROM cash_entries WHERE ref_table = 'icecream_payments' AND ref_id = ? AND reverses_entry_id IS NULL").get(recId('icecream_payments')) as any;
      conn.prepare(`INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, reverses_entry_id) VALUES (?, ?, ?, ?, ?, 'icecream_payments', ?, ?)`)
        .run(o.book, o.business_date, o.type, -o.amount_cents, o.fund, recId('icecream_payments'), o.id);
      expect(msg(() => conn.exec(flipSql('icecream_payments', recId('icecream_payments'))))).toMatch(/VOID_WITHOUT_REVERSAL/);
    });
  });

  it('records without ledger rows are exempt: a draft stocktake can be voided raw', () => {
    inSavepoint(() => {
      expect(msg(() => conn.exec(flipSql('stocktakes', draftStocktake)))).toBeNull();
      expect(n1(s.ctx, `SELECT COUNT(*) FROM stocktakes WHERE id = ${draftStocktake} AND status = 'void'`)).toBe(1);
    });
  });

  it('a zero-difference cash count (no cash entry) is exempt', () => {
    inSavepoint(() => {
      conn.prepare(`INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, client_ref) VALUES ('shop', '${D}', 0, 0, 0, 'zero-count')`).run();
      const id = n1(s.ctx, "SELECT id FROM cash_counts WHERE client_ref = 'zero-count'");
      expect(msg(() => conn.exec(flipSql('cash_counts', id)))).toBeNull();
    });
  });
});

describe('reversal rows must mirror their original and exist once (all types)', () => {
  const cashOrig = (): any => conn.prepare("SELECT * FROM cash_entries WHERE ref_table = 'expenses' AND ref_id = ? AND reverses_entry_id IS NULL").get(recId('expenses'));
  const rev = (o: any, over: Record<string, unknown> = {}): string => {
    const v = { book: o.book, date: o.business_date, type: o.type, amt: -o.amount_cents, fund: o.fund, ref: "'expenses'", rid: recId('expenses'), link: o.id, ...over };
    return `INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, reverses_entry_id)
      VALUES ('${v.book}', '${v.date}', '${v.type}', ${v.amt}, ${v.fund === null ? 'NULL' : `'${v.fund}'`}, ${v.ref}, ${v.rid}, ${v.link})`;
  };

  it('cash: wrong amount, book, fund or date, reversing a reversal or a missing entry are refused; the exact mirror is accepted once', () => {
    const o = cashOrig();
    expect(probe(s.ctx, rev(o, { amt: -o.amount_cents + 1 }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, rev(o, { book: 'shop' }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, rev(o, { date: '2025-09-09' }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, rev(o, { amt: o.amount_cents }))).toMatch(/REVERSAL_MISMATCH/); // same sign
    expect(probe(s.ctx, rev(o, { link: 999999 }))).toMatch(/FOREIGN KEY/);
    expect(probe(s.ctx, `INSERT INTO cash_entries (book, business_date, type, amount_cents, fund, reverses_entry_id) VALUES ('icecream', '${D}', 'capital', 500, 'cost', ${o.id})`)).toMatch(/REVERSAL_MISMATCH/);
    inSavepoint(() => {
      conn.exec(rev(o));
      expect(msg(() => conn.exec(rev(o)))).toMatch(/UNIQUE constraint failed/);               // second reversal of the same entry
      expect(msg(() => conn.exec(rev(o, { amt: -o.amount_cents + 1 })))).not.toBeNull();
      const second = n1(s.ctx, 'SELECT MAX(id) FROM cash_entries');
      expect(msg(() => conn.exec(rev({ ...o, id: second, amount_cents: -o.amount_cents, book: o.book })))).not.toBeNull(); // reversing the reversal
    });
  });

  it('Ice Cream fund rows: wrong fund / amount / date / reference and a second reversal are refused', () => {
    const o = conn.prepare("SELECT * FROM icecream_fund_entries WHERE ref_table = 'icecream_payments' AND ref_id = ? AND reverses_entry_id IS NULL").get(recId('icecream_payments')) as any;
    const ins = (over: Record<string, unknown> = {}) => {
      const v = { fund: o.fund, amt: -o.amount_cents, date: o.business_date, rid: o.ref_id, ...over };
      return `INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind, ref_table, ref_id, reverses_entry_id) VALUES ('${v.date}', '${v.fund}', ${v.amt}, 'reversal', 'icecream_payments', ${v.rid}, ${o.id})`;
    };
    expect(probe(s.ctx, ins({ fund: o.fund === 'cost' ? 'profit' : 'cost' }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ amt: -o.amount_cents + 1 }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ date: '2025-09-09' }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ rid: o.ref_id + 1 }))).toMatch(/REVERSAL_MISMATCH/);
    inSavepoint(() => {
      conn.exec(ins());
      expect(msg(() => conn.exec(ins()))).toMatch(/UNIQUE constraint failed/);
    });
  });

  it('stock: a linked reversal must mirror product, record, date and quantity, and may not return more value than the original; a second one is refused', () => {
    const o = conn.prepare("SELECT * FROM stock_movements WHERE ref_table = 'stock_losses' AND ref_id = ?").get(recId('stock_losses')) as any;
    const other = conn.prepare("SELECT product_id FROM stock_movements WHERE product_id <> ? LIMIT 1").get(o.product_id) as any;
    const ins = (over: Record<string, unknown> = {}) => {
      const v = { pid: o.product_id, date: o.business_date, type: o.type, qty: -o.qty_delta, val: -o.value_delta_cents, rt: "'stock_losses'", rid: recId('stock_losses'), link: o.id, ...over };
      return `INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason, reverses_movement_id)
        VALUES (${v.pid}, '${v.date}', '${v.type}', ${v.qty}, ${v.val}, ${v.rt}, ${v.rid}, 'x', ${v.link})`;
    };
    expect(o.qty_delta).toBe(-2);
    expect(probe(s.ctx, ins({ pid: other.product_id }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ date: '2025-09-09' }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ qty: 1, val: 100 }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ val: -o.value_delta_cents + 1 }))).toMatch(/REVERSAL_MISMATCH/);      // returns MORE value than was removed
    expect(probe(s.ctx, ins({ val: -o.value_delta_cents * 2 }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ rid: recId('stock_losses') + 1 }))).toMatch(/REVERSAL_MISMATCH/);
    expect(probe(s.ctx, ins({ link: 999999 }))).toMatch(/FOREIGN KEY/);
    inSavepoint(() => {
      conn.exec(ins());
      expect(msg(() => conn.exec(ins()))).toMatch(/UNIQUE constraint failed/);
      const r1 = n1(s.ctx, 'SELECT MAX(id) FROM stock_movements');
      expect(msg(() => conn.exec(ins({ link: r1, qty: o.qty_delta, val: o.value_delta_cents })))).toMatch(/REVERSAL_MISMATCH/); // reversing a reversal
      // an unlinked row on the record is just a new original: it needs its own reversal before the record can be voided
      conn.exec(ins({ link: 'NULL' }));
      expect(msg(() => conn.exec(flipSql('stock_losses', recId('stock_losses'))))).toMatch(/VOID_WITHOUT_REVERSAL/);
    });
  });

  it('a movement may not be attached to a void record (also not "reversal-shaped" rows linked to old originals)', () => {
    inSavepoint(() => {
      reverseRaw('sales', recId('sales'));
      conn.exec(flipSql('sales', recId('sales')));
      const o = conn.prepare("SELECT * FROM stock_movements WHERE ref_table = 'sales' AND ref_id = ? AND reverses_movement_id IS NULL").get(recId('sales')) as any;
      expect(msg(() => conn.exec(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (${o.product_id}, '${D}', 'sale', 1, 10, 'sales', ${recId('sales')}, 'x')`))).toMatch(/RECORD_VOID/);
      expect(msg(() => conn.exec(`INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id, reason) VALUES (${o.product_id}, '${D}', 'sale', -1, -10, 'sales', ${recId('sales')}, 'x')`))).toMatch(/RECORD_VOID/);
    });
  });
});

describe('L2: INSERT OR REPLACE cannot overwrite an append-only row; the migration history is guarded', () => {
  it('audit_logs, cash_entries, stock_movements, icecream_fund_entries and external_backup_log refuse a replaced id and keep the old row', () => {
    const before = (t: string) => JSON.stringify(rows(s.ctx, `SELECT * FROM ${t} WHERE id = 1`), (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    conn.exec("INSERT INTO external_backup_log (source_name, status, error) VALUES ('a.db', 'failed', 'x')");
    const cases: Array<[string, string]> = [
      ['audit_logs', "INSERT OR REPLACE INTO audit_logs (id, entity, action) VALUES (1, 'x', 'y')"],
      ['cash_entries', "INSERT OR REPLACE INTO cash_entries (id, book, business_date, type, amount_cents) VALUES (1, 'shop', '2025-09-10', 'capital', 1)"],
      ['stock_movements', `INSERT OR REPLACE INTO stock_movements (id, product_id, business_date, type, qty_delta, value_delta_cents) VALUES (1, ${n1(s.ctx, 'SELECT MIN(id) FROM products')}, '2025-09-10', 'opening', 1, 1)`],
      ['icecream_fund_entries', "INSERT OR REPLACE INTO icecream_fund_entries (id, business_date, fund, amount_cents, kind) VALUES (1, '2025-09-10', 'cost', 1, 'capital')"],
      ['external_backup_log', "INSERT OR REPLACE INTO external_backup_log (id, source_name, status, error) VALUES (1, 'b.db', 'failed', 'y')"],
    ];
    for (const [t, sql] of cases) {
      const snap = before(t);
      expect(snap, `${t} row 1 exists`).not.toBe('[]');
      expect(msg(() => conn.exec(sql)), `${t}: REPLACE accepted`).toMatch(/append-only|APPEND_ONLY/);
      expect(msg(() => conn.exec(sql.replace('INSERT OR REPLACE', 'REPLACE INTO').replace('REPLACE INTO INTO', 'REPLACE INTO'))), `${t}: REPLACE INTO accepted`).not.toBeNull();
      expect(before(t), `${t}: the row changed`).toBe(snap);
    }
    // control: the protection IS the no_replace trigger - without it the very same statement overwrites the row (recursive_triggers is off)
    inSavepoint(() => {
      conn.exec('DROP TRIGGER trg_cash_entries_no_replace');
      conn.exec("INSERT OR REPLACE INTO cash_entries (id, book, business_date, type, amount_cents) VALUES (1, 'shop', '2025-09-10', 'capital', 777)");
      expect(n1(s.ctx, 'SELECT amount_cents FROM cash_entries WHERE id = 1')).toBe(777);
    });
    // a REPLACE that would delete an older REVERSAL through the unique link is refused the same way
    inSavepoint(() => {
      const o = conn.prepare("SELECT * FROM cash_entries WHERE ref_table = 'expenses' AND ref_id = ? AND reverses_entry_id IS NULL").get(recId('expenses')) as any;
      const ins = (verb: string) => `${verb} INTO cash_entries (book, business_date, type, amount_cents, fund, ref_table, ref_id, reverses_entry_id) VALUES ('${o.book}', '${o.business_date}', '${o.type}', ${-o.amount_cents}, NULL, 'expenses', ${recId('expenses')}, ${o.id})`;
      conn.exec(ins('INSERT'));
      const first = n1(s.ctx, 'SELECT MAX(id) FROM cash_entries');
      expect(msg(() => conn.exec(ins('INSERT OR REPLACE')))).toMatch(/UNIQUE/);
      expect(n1(s.ctx, `SELECT COUNT(*) FROM cash_entries WHERE id = ${first}`)).toBe(1);
    });
  });

  it('schema_migrations: UPDATE, DELETE and REPLACE are refused, a new version can still be appended', () => {
    expect(probe(s.ctx, "UPDATE schema_migrations SET checksum = 'x' WHERE version = 5")).toMatch(/append-only/);
    expect(probe(s.ctx, 'DELETE FROM schema_migrations WHERE version = 5')).toMatch(/append-only/);
    expect(probe(s.ctx, "INSERT OR REPLACE INTO schema_migrations (version, name, checksum) VALUES (5, 'x', 'y')")).toMatch(/append-only/);
    expect(probe(s.ctx, "INSERT INTO schema_migrations (version, name, checksum) VALUES (5, 'x', 'y')")).not.toBeNull();
    expect(probe(s.ctx, "INSERT INTO schema_migrations (version, name, checksum) VALUES (4242, '4242_x.sql', 'y')")).toBeNull();
  });
});
