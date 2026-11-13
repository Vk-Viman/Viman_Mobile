// Hardening M1 (migration 019): the DATABASE refuses a raw INSERT dated on / before a closed day for EVERY business-date table.
// Every probe is plain SQL on the live connection (bypassing all services) inside a SAVEPOINT that is always rolled back.
// For each protected row kind the same five-step script runs on a freshly built world:
//   1. nothing closed                                  -> E, C and L are accepted
//   2. only an UNRELATED book closed on C              -> E, C and L are accepted (other books unaffected)
//   3. the row's own book(s) closed on C               -> E aborts BACKDATE_BEFORE_CLOSED_DAY, C aborts DAY_CLOSED, L accepted
//   4. that closing reopened                           -> E and C accepted (a reopened day does not count)
//   5. the SAME closing closed again                   -> E and C refuse again
// Dates: E (6 days ago) < C (3 days ago, the closed day) < L (yesterday); OLD (12 days ago) holds seeded history.

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, ref } from './helpers/inventory.ts';
import { sqlPrintSale, sqlSupply } from './helpers/phase7.ts';
import { sqlReturn, sqlSale } from './helpers/phase5.ts';
import { closeNew, reopenNew } from './helpers/phase8.ts';
import { dayNew } from './helpers/phase10.ts';
import { C, E, L, OLD, closeBooks, fixture, must } from './helpers/phase19cd.ts';
import type { Book, Fx } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

interface World {
  fx: Fx;
  saleShop: number; saleTel: number; purchaseShop: number; purchaseTel: number;
  /** Ice Cream daily entries (made through the API while everything is open), by business date. */
  iceDay: Record<string, number>;
  telP: any;
}
const conn = (w: World) => w.fx.s.ctx.database.conn;
const run = (w: World, sql: string, ...p: any[]) => conn(w).prepare(sql).run(...p);

async function world(): Promise<World> {
  const s = await apiBase(await env.build());
  const fx = await fixture(s);
  const c = s.ctx.database.conn;
  const purchase = (book: string) => Number(c.prepare("INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, ?, 0, ?)").run(OLD(), book, ref()).lastInsertRowid);
  const iceDay: Record<string, number> = {};
  for (const d of [E(), C(), L()]) iceDay[d] = Number((must(await dayNew(s, { businessDate: d })).body.day as any).id);
  return {
    fx, telP: fx.telP, iceDay,
    saleShop: sqlSale(c, { date: OLD(), book: 'shop' }), saleTel: sqlSale(c, { date: OLD(), book: 'telecom' }),
    purchaseShop: purchase('shop'), purchaseTel: purchase('telecom'),
  };
}

/** Runs `fn` in a savepoint, always rolls back; 'ok' or the database's abort message. */
function probe(w: World, fn: () => unknown): string {
  const c = conn(w);
  c.exec('SAVEPOINT pr');
  try { fn(); return 'ok'; } catch (e) { return (e as Error).message; } finally { c.exec('ROLLBACK TO pr'); c.exec('RELEASE pr'); }
}
const BACK = 'BACKDATE_BEFORE_CLOSED_DAY';
const DAY = 'DAY_CLOSED';
type Ins = (w: World, d: string) => unknown;

interface Kind {
  name: string;
  /** Books that must be closed for the row to be refused (the row touches all of them; closing ONE of them is enough, see `any`). */
  books: Book[];
  ins: Ins;
}
const ICE = { fund: 'cost' };
const otherBook = (books: Book[]): Book => (['icecream', 'telecom', 'shop'] as Book[]).find((b) => !books.includes(b))!;

const KINDS: Kind[] = [
  // ----- documents with a book column
  { name: 'sales (shop)', books: ['shop'], ins: (w, d) => sqlSale(conn(w), { date: d, book: 'shop' }) },
  { name: 'sales (telecom)', books: ['telecom'], ins: (w, d) => sqlSale(conn(w), { date: d, book: 'telecom' }) },
  { name: 'sales_returns (shop sale)', books: ['shop'], ins: (w, d) => sqlReturn(conn(w), w.saleShop, { date: d }) },
  { name: 'sales_returns (telecom sale)', books: ['telecom'], ins: (w, d) => sqlReturn(conn(w), w.saleTel, { date: d }) },
  { name: 'purchases (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'shop', 0, ?)", d, ref()) },
  { name: 'purchases (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO purchases (business_date, book, total_cents, client_ref) VALUES (?, 'telecom', 0, ?)", d, ref()) },
  { name: 'purchase_returns (shop purchase)', books: ['shop'], ins: (w, d) => run(w, 'INSERT INTO purchase_returns (purchase_id, business_date, refund_cents, client_ref) VALUES (?, ?, 0, ?)', w.purchaseShop, d, ref()) },
  { name: 'purchase_returns (telecom purchase)', books: ['telecom'], ins: (w, d) => run(w, 'INSERT INTO purchase_returns (purchase_id, business_date, refund_cents, client_ref) VALUES (?, ?, 0, ?)', w.purchaseTel, d, ref()) },
  { name: 'expenses (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'shop', 'rent', 100, 'x', ?)", d, ref()) },
  { name: 'expenses (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO expenses (business_date, book, category, amount_cents, description, client_ref) VALUES (?, 'telecom', 'rent', 100, 'x', ?)", d, ref()) },
  { name: 'capital_entries (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO capital_entries (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'shop', 'capital', 100, ?)", d, ref()) },
  { name: 'capital_entries (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO capital_entries (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'telecom', 'capital', 100, ?)", d, ref()) },
  { name: 'capital_entries (icecream)', books: ['icecream'], ins: (w, d) => run(w, "INSERT INTO capital_entries (business_date, book, fund, kind, amount_cents, client_ref) VALUES (?, 'icecream', 'cost', 'opening_balance', 100, ?)", d, ref()) },
  { name: 'owner_drawings cash (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO owner_drawings (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'shop', 'cash', 100, ?)", d, ref()) },
  { name: 'owner_drawings cash (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO owner_drawings (business_date, book, kind, amount_cents, client_ref) VALUES (?, 'telecom', 'cash', 100, ?)", d, ref()) },
  { name: 'owner_drawings cash (icecream)', books: ['icecream'], ins: (w, d) => run(w, "INSERT INTO owner_drawings (business_date, book, fund, kind, amount_cents, client_ref) VALUES (?, 'icecream', 'profit', 'cash', 100, ?)", d, ref()) },
  { name: 'owner_drawings goods (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO owner_drawings (business_date, book, kind, amount_cents, product_id, qty, client_ref) VALUES (?, 'shop', 'goods', 10, ?, 1, ?)", d, w.fx.shopP.id, ref()) },
  { name: 'owner_drawings goods (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO owner_drawings (business_date, book, kind, amount_cents, product_id, qty, client_ref) VALUES (?, 'telecom', 'goods', 10, ?, 1, ?)", d, w.telP.id, ref()) },
  // ----- stock
  { name: 'stock_movements (shop product)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'adjustment', 0, 1)", w.fx.shopP.id, d) },
  { name: 'stock_movements (telecom product)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'adjustment', 0, 1)", w.telP.id, d) },
  { name: 'stock_movements reversal-style row (qty 1 value 10, type sale_void)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents) VALUES (?, ?, 'sale_void', 1, 10)", w.fx.shopP.id, d) },
  { name: 'stock_losses (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, client_ref) VALUES (?, ?, 'shop', 1, 10, 'lost', ?)", d, w.fx.shopP.id, ref()) },
  { name: 'stock_losses (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, client_ref) VALUES (?, ?, 'telecom', 1, 10, 'lost', ?)", d, w.telP.id, ref()) },
  { name: 'stocktakes completed (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO stocktakes (business_date, book, status, completed_at, client_ref) VALUES (?, 'shop', 'completed', '2026-01-01T00:00:00.000Z', ?)", d, ref()) },
  { name: 'stocktakes completed (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO stocktakes (business_date, book, status, completed_at, client_ref) VALUES (?, 'telecom', 'completed', '2026-01-01T00:00:00.000Z', ?)", d, ref()) },
  // ----- cash counts: a count with a difference follows the full rule
  { name: 'cash_counts with difference (shop)', books: ['shop'], ins: (w, d) => run(w, "INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, note, client_ref) VALUES ('shop', ?, 0, 100, 100, 'x', ?)", d, ref()) },
  { name: 'cash_counts with difference (telecom)', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, note, client_ref) VALUES ('telecom', ?, 0, 100, 100, 'x', ?)", d, ref()) },
  { name: 'cash_counts with difference (icecream)', books: ['icecream'], ins: (w, d) => run(w, "INSERT INTO cash_counts (book, fund, business_date, expected_cents, counted_cents, difference_cents, note, client_ref) VALUES ('icecream', 'cost', ?, 0, 100, 100, 'x', ?)", d, ref()) },
  // ----- telecom and printing
  { name: 'reload_sales', books: ['telecom'], ins: (w, d) => run(w, 'INSERT INTO reload_sales (business_date, provider_id, sales_cents, commission_bp, commission_cents, client_ref) VALUES (?, ?, 1000, 600, 60, ?)', d, w.fx.prov.Dialog, ref()) },
  { name: 'ezcash_sales', books: ['telecom'], ins: (w, d) => run(w, 'INSERT INTO ezcash_sales (business_date, provider_id, bill_total_cents, commission_bp, commission_cents, client_ref) VALUES (?, ?, 1000, 80, 8, ?)', d, w.fx.prov.Dialog, ref()) },
  { name: 'telecom_topups', books: ['telecom'], ins: (w, d) => run(w, "INSERT INTO telecom_topups (business_date, kind, amount_cents, client_ref) VALUES (?, 'wallet_topup', 100, ?)", d, ref()) },
  { name: 'print_sales', books: ['shop'], ins: (w, d) => sqlPrintSale(conn(w), { date: d }) },
  { name: 'printing_supplies', books: ['shop'], ins: (w, d) => sqlSupply(conn(w), { date: d }) },
  // ----- Ice Cream
  { name: 'icecream_fund_entries', books: ['icecream'], ins: (w, d) => run(w, "INSERT INTO icecream_fund_entries (business_date, fund, amount_cents, kind) VALUES (?, 'cost', 100, 'opening_balance')", d) },
  { name: 'icecream_sales (a line of the daily entry of that date)', books: ['icecream'],
    ins: (w, d) => run(w, "INSERT INTO icecream_sales (icecream_day_id, item_name, qty, unit_price_cents, line_total_cents) VALUES (?, 'cone', 1, 100, 100)", w.iceDay[d]) },
];

const BOOKS3: Book[] = ['shop', 'telecom', 'icecream'];
void ICE;

describe('M1: raw INSERT on every protected table (single-book rows)', () => {
  it.each(KINDS.map((k) => [k.name, k] as const))('%s', async (_name, k) => {
    const w = await world();
    const s = w.fx.s;
    const at = (d: string) => probe(w, () => k.ins(w, d));
    const open = () => { expect([at(E()), at(C()), at(L())], `${k.name}: accepted while nothing is closed`).toEqual(['ok', 'ok', 'ok']); };
    open();
    // 2. an unrelated book closed on C: unaffected
    const other = otherBook(k.books);
    const oc = await closeBooks(s, [other], C());
    expect([at(E()), at(C()), at(L())], `${k.name}: ${other} closed does not touch it`).toEqual(['ok', 'ok', 'ok']);
    // the sibling books that the row does not touch stay free too (closing every other book)
    const rest = BOOKS3.filter((b) => !k.books.includes(b) && b !== other);
    const rc = await closeBooks(s, rest, C());
    expect([at(E()), at(C()), at(L())], `${k.name}: all books but its own closed`).toEqual(['ok', 'ok', 'ok']);
    // 3. its own book closed on C
    const own = await closeBooks(s, k.books, C());
    expect(at(E()), `${k.name} before the closed day`).toContain(BACK);
    expect(at(C()), `${k.name} on the closed day`).toContain(DAY);
    expect(at(L()), `${k.name} after the closed day`).toBe('ok');
    // 4. reopened: accepted again
    for (const c of Object.values(own)) must(await reopenNew(s, c.id, 'raw insert test'));
    expect([at(E()), at(C()), at(L())], `${k.name}: after reopen`).toEqual(['ok', 'ok', 'ok']);
    // 5. re-closed (the same closing rows): refused again
    for (const b of k.books) expect((await closeNew(s, b, C())).status).toBe(201);
    expect(at(E()), `${k.name}: re-closed, before`).toContain(BACK);
    expect(at(C()), `${k.name}: re-closed, on the day`).toContain(DAY);
    expect(at(L())).toBe('ok');
    void oc; void rc;
  });
});

describe('M1: cash_transfers touch BOTH books (every direction)', () => {
  const ins = (w: World, d: string, from: Book, to: Book) => run(w,
    'INSERT INTO cash_transfers (business_date, from_book, to_book, from_fund, to_fund, amount_cents, client_ref) VALUES (?, ?, ?, ?, ?, 100, ?)',
    d, from, to, from === 'icecream' ? 'cost' : null, to === 'icecream' ? 'cost' : null, ref());
  const pairs: Array<[Book, Book]> = [];
  for (const a of BOOKS3) for (const b of BOOKS3) if (a !== b) pairs.push([a, b]);

  it.each(pairs.map((p) => [`${p[0]} -> ${p[1]}`, p] as const))('%s: refused when either book is closed, accepted when the third is the only one closed', async (_n, [from, to]) => {
    const w = await world();
    const s = w.fx.s;
    const at = (d: string) => probe(w, () => ins(w, d, from, to));
    const third = BOOKS3.find((b) => b !== from && b !== to)!;
    expect([at(E()), at(C()), at(L())]).toEqual(['ok', 'ok', 'ok']);
    const t = await closeBooks(s, [third], C());
    expect([at(E()), at(C()), at(L())], 'only the unrelated third book closed').toEqual(['ok', 'ok', 'ok']);
    must(await reopenNew(s, t[third].id, 'reopen test'));
    // the FROM book alone
    const f = await closeBooks(s, [from], C());
    expect(at(E())).toContain(BACK); expect(at(C())).toContain(DAY); expect(at(L())).toBe('ok');
    must(await reopenNew(s, f[from].id, 'reopen test'));
    expect([at(E()), at(C()), at(L())], 'reopened').toEqual(['ok', 'ok', 'ok']);
    // the TO book alone
    const g = await closeBooks(s, [to], C());
    expect(at(E())).toContain(BACK); expect(at(C())).toContain(DAY); expect(at(L())).toBe('ok');
    must(await reopenNew(s, g[to].id, 'reopen test'));
    // both closed: re-close both (same rows)
    expect((await closeNew(s, from, C())).status).toBe(201);
    expect((await closeNew(s, to, C())).status).toBe(201);
    expect(at(E())).toContain(BACK); expect(at(C())).toContain(DAY); expect(at(L())).toBe('ok');
  });

  it('precedence: DAY_CLOSED of one book beats BACKDATE_BEFORE_CLOSED_DAY of the other (shop closed on C, telecom closed on L)', async () => {
    const w = await world();
    const s = w.fx.s;
    await closeBooks(s, ['shop'], C());
    await closeBooks(s, ['telecom'], L());
    const at = (d: string, a: Book, b: Book) => probe(w, () => ins(w, d, a, b));
    expect(at(C(), 'shop', 'telecom')).toContain(DAY);   // shop: exact; telecom: earlier than L
    expect(at(C(), 'telecom', 'shop')).toContain(DAY);
    expect(at(E(), 'shop', 'telecom')).toContain(BACK);  // both only "earlier than"
    expect(at(L(), 'shop', 'telecom')).toContain(DAY);   // telecom exact on L
    expect(at(C(), 'shop', 'icecream')).toContain(DAY);
    expect(at(C(), 'telecom', 'icecream')).toContain(BACK);
  });
});

describe('M1: cash counts without a difference post nothing: only their exact day is protected (section 8)', () => {
  const zero = (w: World, book: Book, d: string) => run(w, 'INSERT INTO cash_counts (book, business_date, expected_cents, counted_cents, difference_cents, client_ref) VALUES (?, ?, 0, 0, 0, ?)', book, d, ref());
  it.each(BOOKS3.map((b) => [b] as const))('%s: zero-difference count: E accepted, C refused DAY_CLOSED, L accepted; reopen lifts it; non-zero stays fully protected', async (book) => {
    const w = await world();
    const s = w.fx.s;
    const cl = await closeBooks(s, [book], C());
    expect(probe(w, () => zero(w, book, E())), 'before the closed day').toBe('ok');
    expect(probe(w, () => zero(w, book, C())), 'on the closed day').toContain(DAY);
    expect(probe(w, () => zero(w, book, L()))).toBe('ok');
    const nz = (d: string) => probe(w, () => run(w, "INSERT INTO cash_counts (book, fund, business_date, expected_cents, counted_cents, difference_cents, note, client_ref) VALUES (?, ?, ?, 0, 5, 5, 'x', ?)", book, book === 'icecream' ? 'cost' : null, d, ref()));
    expect(nz(E())).toContain(BACK);
    expect(nz(C())).toContain(DAY);
    must(await reopenNew(s, cl[book].id, 'reopen test'));
    expect(probe(w, () => zero(w, book, C()))).toBe('ok');
    expect(nz(E())).toBe('ok');
  });
});

describe('M1: opening_stock_batches (header with its lines as stock movements)', () => {
  const header = (w: World, d: string) => run(w, "INSERT INTO opening_stock_batches (business_date, source, row_count, total_value_cents, client_ref) VALUES (?, 'manual', 0, 0, ?)", d, ref());
  it('header: refused when BOTH product books are blocked (it could not carry any line); each line is judged by its product book', async () => {
    const w = await world();
    const s = w.fx.s;
    const mv = (p: any, d: string) => probe(w, () => run(w, "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, ref_table, ref_id) VALUES (?, ?, 'opening', 1, 100, 'opening_stock_batches', 1)", p.id, d));
    const at = (d: string) => probe(w, () => header(w, d));
    expect([at(E()), at(C()), at(L())]).toEqual(['ok', 'ok', 'ok']);
    const sh = await closeBooks(s, ['shop'], C());
    // Shop only: a batch header may still be for Telecom products; the Shop line itself is refused by the movement trigger
    expect([at(E()), at(C()), at(L())]).toEqual(['ok', 'ok', 'ok']);
    expect(mv(w.fx.shopP, E())).toContain(BACK);
    expect(mv(w.fx.shopP, C())).toContain(DAY);
    expect(mv(w.telP, E())).toBe('ok');
    expect(mv(w.telP, C())).toBe('ok');
    const te = await closeBooks(s, ['telecom'], C());
    expect(at(E())).toContain(BACK);
    expect(at(C())).toContain(DAY);
    expect(at(L())).toBe('ok');
    expect(mv(w.telP, E())).toContain(BACK);
    must(await reopenNew(s, te.telecom.id, 'reopen test'));
    expect([at(E()), at(C()), at(L())], 'only Shop closed again').toEqual(['ok', 'ok', 'ok']);
    must(await reopenNew(s, sh.shop.id, 'reopen test'));
    expect([at(E()), at(C())]).toEqual(['ok', 'ok']);
    expect((await closeNew(s, 'shop', C())).status).toBe(201);
    expect((await closeNew(s, 'telecom', C())).status).toBe(201);
    expect(at(E())).toContain(BACK);
    expect(at(C())).toContain(DAY);
  });
});

describe('M1: non-posting rows stay allowed on a closed day', () => {
  it('a DRAFT stocktake, import_runs / import_issues audit rows and catalog rows are accepted on and before a closed day', async () => {
    const w = await world();
    const s = w.fx.s;
    await closeBooks(s, BOOKS3, C());
    for (const d of [E(), C()]) {
      for (const book of ['shop', 'telecom']) {
        expect(probe(w, () => run(w, 'INSERT INTO stocktakes (business_date, book, client_ref) VALUES (?, ?, ?)', d, book, ref())), `draft stocktake ${book} ${d}`).toBe('ok');
      }
      expect(probe(w, () => {
        const id = Number(run(w, "INSERT INTO import_runs (kind, file_name, file_sha256, business_date, mode, status, rows_total, rows_ok, rows_failed) VALUES ('opening_stock', 'f.xlsx', ?, ?, 'commit', 'rejected', 1, 0, 1)", 'b'.repeat(64), d).lastInsertRowid);
        run(w, "INSERT INTO import_issues (import_run_id, row_no, code, message) VALUES (?, 1, 'X', 'rejected')", id);
      }), `import audit ${d}`).toBe('ok');
      expect(probe(w, () => run(w, "INSERT INTO audit_logs (entity, action, business_date) VALUES ('x', 'create', ?)", d))).toBe('ok');
    }
  });

  it('through the API: a draft stocktake can still be created on a closed day, but not completed', async () => {
    const w = await world();
    const s = w.fx.s;
    await closeBooks(s, ['shop'], C());
    const { post } = await import('./helpers/catalog.ts');
    const r = await post(s.app, '/stocktakes', { businessDate: C(), book: 'shop', items: [{ productId: w.fx.shopP.id, countedQty: 1 }], clientRef: ref() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const done = await post(s.app, `/stocktakes/${r.body.item.id}/complete`, {});
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe(DAY);
  });
});
