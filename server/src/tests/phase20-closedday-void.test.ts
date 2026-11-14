// Hardening M1 (migration 019): the DATABASE refuses a raw void flip (status -> void) of a record dated on / before a closed day,
// for every voidable table. Records are made through the real API while everything is open (dated E and C), then the books are
// closed and the status flip is attempted with plain SQL inside a rolled-back SAVEPOINT. Same script as phase20-closedday-insert:
//   unrelated book closed -> accepted; own book closed on C -> E-dated BACKDATE_BEFORE_CLOSED_DAY, C-dated DAY_CLOSED;
//   reopened -> accepted; re-closed -> refused again.

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, ref } from './helpers/inventory.ts';
import { closeNew, reopenNew } from './helpers/phase8.ts';
import { stDraft } from './helpers/phase4.ts';
import { C, E, allOps, closeBooks, fixture, must } from './helpers/phase19cd.ts';
import type { Book, Fx } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const BACK = 'BACKDATE_BEFORE_CLOSED_DAY';
const DAY = 'DAY_CLOSED';
const BOOKS3: Book[] = ['shop', 'telecom', 'icecream'];

function probe(fx: Fx, fn: () => unknown): string {
  const c = fx.s.ctx.database.conn;
  c.exec('SAVEPOINT pr');
  try {
    // Migration 020 (M2) refuses a raw status flip that has no reversal rows. This file tests the CLOSED-DAY triggers of migration 019 in isolation, so
    // the reversal guards are lifted INSIDE this rolled-back savepoint only (DDL is transactional in SQLite); the guards have their own tests (phase20-reversal-*).
    for (const t of c.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%VOID_WITHOUT_REVERSAL%'").all() as unknown as { name: string }[]) c.exec(`DROP TRIGGER "${t.name}"`);
    fn();
    return 'ok';
  } catch (e) { return (e as Error).message; } finally { c.exec('ROLLBACK TO pr'); c.exec('RELEASE pr'); }
}

/** [table, registry operation that creates one posted record, books that must be closed for the flip to be refused] */
const CASES: Array<[string, string, Book[]]> = [
  ['expenses', 'expense (shop)', ['shop']],
  ['expenses', 'expense (telecom)', ['telecom']],
  ['capital_entries', 'capital (shop)', ['shop']],
  ['capital_entries', 'capital (icecream)', ['icecream']],
  ['cash_counts', 'cash count with adjustment (shop)', ['shop']],
  ['cash_counts', 'cash count with adjustment (telecom)', ['telecom']],
  ['cash_counts', 'cash count with adjustment (icecream)', ['icecream']],
  ['cash_transfers', 'transfer shop -> telecom', ['shop']],
  ['cash_transfers', 'transfer shop -> telecom', ['telecom']],
  ['cash_transfers', 'transfer icecream -> shop', ['icecream']],
  ['cash_transfers', 'transfer icecream -> shop', ['shop']],
  ['purchases', 'purchase (shop)', ['shop']],
  ['purchases', 'purchase (telecom)', ['telecom']],
  ['sales', 'sale (shop)', ['shop']],
  ['sales', 'sale (telecom)', ['telecom']],
  ['reload_sales', 'reload sale', ['telecom']],
  ['ezcash_sales', 'EZCash bill', ['telecom']],
  ['telecom_topups', 'wallet top-up', ['telecom']],
  ['print_sales', 'print sale', ['shop']],
  ['printing_supplies', 'printing supplies', ['shop']],
  ['owner_drawings', 'cash drawing (shop)', ['shop']],
  ['owner_drawings', 'cash drawing (icecream)', ['icecream']],
  ['owner_drawings', 'goods drawing (shop)', ['shop']],
  ['owner_drawings', 'goods drawing (telecom)', ['telecom']],
  ['stock_losses', 'stock loss (shop)', ['shop']],
  ['stock_losses', 'stock loss (telecom)', ['telecom']],
  ['stocktakes', 'stocktake complete (shop)', ['shop']],
  ['stocktakes', 'stocktake complete (telecom)', ['telecom']],
  ['opening_stock_batches', 'opening stock manual (shop)', ['shop']],
  ['opening_stock_batches', 'opening stock manual (telecom)', ['telecom']],
  ['opening_stock_batches', 'opening stock excel (shop)', ['shop']],
  ['icecream_days', 'ice cream daily entry (create)', ['icecream']],
  ['icecream_payments', 'ice cream payment (materials)', ['icecream']],
  ['icecream_fund_moves', 'ice cream fund move', ['icecream']],
  ['sales_returns', 'sale return (shop)', ['shop']],
  ['sales_returns', 'sale return (telecom)', ['telecom']],
  ['sales_returns', 'sale return damaged (shop)', ['shop']],
];

const VOID_SET = "status = 'void', voided_at = '2026-01-01T00:00:00.000Z', void_reason = 'raw'";
const lastId = (fx: Fx, t: string): number => Number((fx.s.ctx.database.conn.prepare(`SELECT MAX(id) AS m FROM ${t}`).get() as unknown as { m: number }).m);

describe('M1: raw void flip of a record dated E / C, per voidable table', () => {
  it.each(CASES.map((c) => [`${c[0]} <- ${c[1]} (own books: ${c[2].join('+')})`, c] as const))('%s', async (_n, [table, opKey, books]) => {
    const op = allOps().find((o) => o.key === opKey)!;
    expect(op, opKey).toBeTruthy();
    const s = await apiBase(await env.build());
    const fx = await fixture(s, { returns: op.returns ? 4 : 0 });
    const conn = s.ctx.database.conn;
    // records made through the API while everything is open (an Ice Cream daily entry must exist on both dates)
    must(await op.create(fx, E())); const idE = lastId(fx, table);
    must(await op.create(fx, C())); const idC = lastId(fx, table);
    const flip = (id: number) => probe(fx, () => conn.prepare(`UPDATE ${table} SET ${VOID_SET} WHERE id = ?`).run(id));
    const both = () => [flip(idE), flip(idC)];

    // the records dated E and C are posted and no book is closed: the flip itself is accepted by the database
    expect(both(), `${table}: flip while nothing is closed`).toEqual(['ok', 'ok']);

    // an unrelated book closed: unaffected
    const other = BOOKS3.find((b) => !op.books.includes(b))!;
    const oc = await closeBooks(s, [other], C());
    expect(both(), `${table}: ${other} closed`).toEqual(['ok', 'ok']);
    must(await reopenNew(s, oc[other].id, 'reopen test'));

    // own books closed on C
    const own = await closeBooks(s, books, C());
    const [e1, c1] = both();
    expect(e1, `${table} dated E`).toContain(BACK);
    expect(c1, `${table} dated C`).toContain(DAY);
    // reopen: accepted again
    for (const c of Object.values(own)) must(await reopenNew(s, c.id, 'raw flip test'));
    expect(both(), `${table}: after reopen`).toEqual(['ok', 'ok']);
    // re-close the same rows: refused again
    for (const b of books) expect((await closeNew(s, b, C())).status).toBe(201);
    const [e2, c2] = both();
    expect(e2, `${table} re-closed, dated E`).toContain(BACK);
    expect(c2, `${table} re-closed, dated C`).toContain(DAY);
  });
});

describe('M1: void flips with their own rules', () => {
  it('a zero-difference cash count: flipping its void is refused only on its exact closed day', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const conn = s.ctx.database.conn;
    const mk = (d: string) => Number(conn.prepare('INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, client_ref) VALUES (\'shop\', ?, 0, 0, 0, ?)').run(d, ref()).lastInsertRowid);
    const idE = mk(E()); const idC = mk(C());
    const cl = await closeBooks(s, ['shop'], C());
    const flip = (id: number) => probe(fx, () => conn.prepare(`UPDATE cash_counts SET ${VOID_SET} WHERE id = ?`).run(id));
    expect(flip(idE)).toBe('ok');
    expect(flip(idC)).toContain(DAY);
    must(await reopenNew(s, cl.shop.id, 'reopen test'));
    expect(flip(idC)).toBe('ok');
  });

  it('a DRAFT stocktake can be voided on a closed day (posted nothing); completing a draft dated on / before it is refused', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const conn = s.ctx.database.conn;
    const dE = await stDraft(s, [{ productId: fx.shopP.id, countedQty: 1 }], { businessDate: E(), book: 'shop' });
    const dC = await stDraft(s, [{ productId: fx.shopP.id, countedQty: 1 }], { businessDate: C(), book: 'shop' });
    const cl = await closeBooks(s, ['shop'], C());
    const voidDraft = (id: number) => probe(fx, () => conn.prepare(`UPDATE stocktakes SET ${VOID_SET} WHERE id = ?`).run(id));
    const complete = (id: number) => probe(fx, () => conn.prepare("UPDATE stocktakes SET status = 'completed', completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id));
    expect(voidDraft(dE.id)).toBe('ok');
    expect(voidDraft(dC.id)).toBe('ok');
    expect(complete(dE.id)).toContain(BACK);
    expect(complete(dC.id)).toContain(DAY);
    must(await reopenNew(s, cl.shop.id, 'reopen test'));
    expect(complete(dE.id)).toBe('ok');
    expect(complete(dC.id)).toBe('ok');
  });

  it('opening-stock void flip is judged by the books of the batch\'s own movements (a Shop + Telecom batch is refused when EITHER book is closed)', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const conn = s.ctx.database.conn;
    const { post } = await import('./helpers/catalog.ts');
    const mk = async (d: string) => must(await post(s.app, '/opening-stock', {
      businessDate: d, items: [{ productId: fx.osShop.id, qty: 1, unitCostCents: 1000 }, { productId: fx.osTel.id, qty: 1, unitCostCents: 1000 }], clientRef: ref(),
    })).body.item.id as number;
    const idE = await mk(E()); const idC = await mk(C());
    const flip = (id: number) => probe(fx, () => conn.prepare(`UPDATE opening_stock_batches SET ${VOID_SET} WHERE id = ?`).run(id));
    expect([flip(idE), flip(idC)]).toEqual(['ok', 'ok']);
    for (const book of ['shop', 'telecom'] as Book[]) {
      const cl = await closeBooks(s, [book], C());
      expect(flip(idE), `${book} closed`).toContain(BACK);
      expect(flip(idC), `${book} closed`).toContain(DAY);
      must(await reopenNew(s, cl[book].id, 'reopen test'));
    }
    const ic = await closeBooks(s, ['icecream'], C());
    expect([flip(idE), flip(idC)], 'Ice Cream closed: unrelated').toEqual(['ok', 'ok']);
    void ic;
  });

  it('a flip that is not a void (posted -> posted, other columns) is not judged', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    const conn = s.ctx.database.conn;
    const op = allOps().find((o) => o.key === 'expense (shop)')!;
    must(await op.create(fx, E()));
    const id = lastId(fx, 'expenses');
    await closeBooks(s, ['shop'], C());
    // notes is not an immutable column of expenses? either way the closed-day trigger must not fire for it
    const r = probe(fx, () => conn.prepare("UPDATE expenses SET status = 'posted' WHERE id = ?").run(id));
    expect(r).toBe('ok');
  });
});
