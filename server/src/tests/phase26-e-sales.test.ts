// Telecom segments, package E (Sales): one sale per scope, per-segment cash, closed-day atomicity, idempotent replay, returns / voids /
// void-of-return keep the segment, corrections stay in the original scope, a legacy product cannot be sold (BUSINESS_RULES 13D, section 4).
// API-level on a real temp database. Card stock is put in by raw SQL ('opening' movement) so the tests do not depend on the Telecom
// purchase flow (package F). Every figure is hand-calculated in the comment above the test; money is in cents.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, cardProduct, mkProduct, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { seg } from './helpers/seg.ts';
import { cl, returnNew, sellNew } from './helpers/phase5.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
type Any = Record<string, any>;

/** Raw 'opening' stock: `qty` units worth `value` cents (so the average is value / qty). */
function stock(s: ApiBase, productId: number, qty: number, value: number): void {
  s.ctx.database.conn.prepare(
    `INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, unit_cost_cents, reason)
     VALUES (?, '2025-01-01', 'opening', ?, ?, ?, 'test')`,
  ).run(productId, qty, value, Math.round(value / qty));
}
const rows = (s: ApiBase, sql: string, ...p: Array<string | number>): Any[] => s.ctx.database.conn.prepare(sql).all(...p) as unknown as Any[];
const count = (s: ApiBase, table: string): number => Number((s.ctx.database.conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Any).n);

/** Shop product S (5,000 per unit), Dialog card D (5,000), Airtel card A (5,000), each 10 units / 50,000; minimum price 0. */
async function world(s: ApiBase): Promise<{ S: any; D: any; A: any; M: any }> {
  const S = await mkProduct(s, { minPriceCents: 0 });
  const D = await cardProduct(s, { provider: 'Dialog', minPriceCents: 0 });
  const A = await cardProduct(s, { provider: 'Airtel', minPriceCents: 0 });
  const M = await cardProduct(s, { provider: 'Mobitel', minPriceCents: 0 });
  for (const p of [S, D, A, M]) stock(s, p.id, 10, 50000);
  return { S, D, A, M };
}
const cashOf = (s: ApiBase, saleId: number): Any[] =>
  rows(s, "SELECT type, book, segment, amount_cents AS amt, reverses_entry_id AS rev FROM cash_entries WHERE ref_table = 'sales' AND ref_id = ? ORDER BY id", saleId);

describe('POS cart split by scope', () => {
  // S 2 x 30,000 = 60,000 (cogs 2 x 5,000 = 10,000); D 3 x 10,000 = 30,000 (cogs 15,000); A 1 x 20,000 = 20,000 (cogs 5,000).
  it('a mixed Shop + Dialog + Airtel cart makes 3 sales (Shop, Dialog, Airtel) with exactly the right cash per scope', async () => {
    const s = await setup();
    const { S, D, A } = await world(s);
    // the cart order is deliberately Airtel, Shop, Dialog: the sales still come Shop, Dialog Cards, Airtel Cards
    const r = await sellNew(s, [cl(A.id, 1, 20000), cl(S.id, 2, 30000), cl(D.id, 3, 10000)]);
    expect(r.status).toBe(201);
    const sales = r.body.sales;
    expect(sales.map((x: any) => [x.book, x.segment, x.totalCents, x.cogsCents])).toEqual([
      ['shop', null, 60000, 10000], ['telecom', 'dialog_cards', 30000, 15000], ['telecom', 'airtel_cards', 20000, 5000],
    ]);
    expect(cashOf(s, sales[0].id)).toEqual([{ type: 'sale_goods', book: 'shop', segment: null, amt: 60000, rev: null }]);
    expect(cashOf(s, sales[1].id)).toEqual([{ type: 'card_sale', book: 'telecom', segment: 'dialog_cards', amt: 30000, rev: null }]);
    expect(cashOf(s, sales[2].id)).toEqual([{ type: 'card_sale', book: 'telecom', segment: 'airtel_cards', amt: 20000, rev: null }]);
    expect(rows(s, 'SELECT segment FROM sales ORDER BY id').map((x) => x.segment)).toEqual([null, 'dialog_cards', 'airtel_cards']);
    // Telecom total = sum of the segments = 50,000; only the two cards segments moved
    expect(seg.balance(s, 'dialog_cards')).toBe(30000);
    expect(seg.balance(s, 'airtel_cards')).toBe(20000);
    expect(seg.total(s)).toBe(50000);
    expect(seg.sumOfSegments(s)).toBe(50000);
    // the history shows the segment and filters by it
    const list = await get(s.app, '/sales?segment=airtel_cards');
    expect(list.body.items.map((x: any) => x.id)).toEqual([sales[2].id]);
    expect(list.body.totals.revenueCents).toBe(20000);
    expect((await get(s.app, '/sales/' + sales[1].id)).body.item.segment).toBe('dialog_cards');
    expect((await get(s.app, '/sales?segment=nope')).status).toBe(400);
  });

  it('two Dialog lines and one Mobitel line: the Dialog lines share ONE sale, Mobitel has its own', async () => {
    const s = await setup();
    const { D, M } = await world(s);
    const r = await sellNew(s, [cl(D.id, 1, 7000), cl(M.id, 2, 8000), cl(D.id, 2, 7000)]);
    expect(r.status).toBe(201);
    expect(r.body.sales.map((x: any) => [x.segment, x.totalCents, x.items.map((i: any) => i.lineNo)])).toEqual([
      ['dialog_cards', 21000, [1, 2]], ['mobitel_cards', 16000, [1]],
    ]);
  });

  it('replay with the same clientRef returns ALL the sales (200), writes nothing more', async () => {
    const s = await setup();
    const { S, D, A } = await world(s);
    const clientRef = ref();
    const body = [cl(S.id, 1, 30000), cl(D.id, 1, 10000), cl(A.id, 1, 20000)];
    const first = await sellNew(s, body, { clientRef });
    expect(first.status).toBe(201);
    const cashBefore = count(s, 'cash_entries'), movBefore = count(s, 'stock_movements'), auditBefore = count(s, 'audit_logs');
    const again = await sellNew(s, body, { clientRef });
    expect(again.status).toBe(200);
    expect(again.body.sales.map((x: any) => x.id)).toEqual(first.body.sales.map((x: any) => x.id));
    expect(again.body.sales.map((x: any) => x.segment)).toEqual([null, 'dialog_cards', 'airtel_cards']);
    expect(again.body.warnings).toEqual([]);
    expect([count(s, 'cash_entries'), count(s, 'stock_movements'), count(s, 'audit_logs')]).toEqual([cashBefore, movBefore, auditBefore]);
    expect(count(s, 'sales')).toBe(3);
  });
});

describe('closed day per segment', () => {
  it('a closed Airtel Cards day refuses the whole cart that touches it (nothing saved); Shop + Dialog still sell', async () => {
    const s = await setup();
    const { S, D, A } = await world(s);
    await seg.closeOk(s, 'airtel_cards', today());
    const bad = await sellNew(s, [cl(S.id, 1, 30000), cl(D.id, 1, 10000), cl(A.id, 1, 20000)]);
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('DAY_CLOSED');
    expect(bad.body.error.message).toContain('Airtel Cards');
    expect(bad.body.error.message).not.toContain('Dialog');
    expect(count(s, 'sales')).toBe(0);
    expect(count(s, 'sale_items')).toBe(0);
    expect(rows(s, "SELECT * FROM cash_entries WHERE type IN ('sale_goods','card_sale')")).toEqual([]);
    expect(rows(s, "SELECT * FROM stock_movements WHERE type = 'sale'")).toEqual([]);
    const ok = await sellNew(s, [cl(S.id, 1, 30000), cl(D.id, 1, 10000)]);
    expect(ok.status).toBe(201);
    expect(ok.body.sales.map((x: any) => x.segment)).toEqual([null, 'dialog_cards']);
  });
});

describe('returns, voids and void of a return keep the sale scope', () => {
  // Dialog sale: 3 x 10,000 = 30,000, cogs 15,000. Return 2 (resalable): refund 20,000, stock back 10,000.
  // Return 1 damaged: refund 10,000, loss 5,000 in dialog_cards. Void the damaged return: +10,000 in dialog_cards.
  it('refund, damaged loss and return reversal are all dialog_cards; Airtel is untouched', async () => {
    const s = await setup();
    const { S, D, A } = await world(s);
    const sold = await sellNew(s, [cl(S.id, 1, 30000), cl(D.id, 3, 10000), cl(A.id, 1, 20000)]);
    const dialog = sold.body.sales[1];
    const item = dialog.items[0];
    const r1 = await returnNew(s, dialog.id, [{ saleItemId: item.id, qty: 2, resalable: true }]);
    expect(r1.status).toBe(201);
    const r2 = await returnNew(s, dialog.id, [{ saleItemId: item.id, qty: 1, resalable: false }]);
    expect(r2.status).toBe(201);
    const refunds = rows(s, "SELECT type, segment, amount_cents AS amt FROM cash_entries WHERE type = 'card_refund' ORDER BY id");
    expect(refunds).toEqual([{ type: 'card_refund', segment: 'dialog_cards', amt: -20000 }, { type: 'card_refund', segment: 'dialog_cards', amt: -10000 }]);
    expect(rows(s, 'SELECT book, segment, cost_cents AS c, source FROM stock_losses')).toEqual([{ book: 'telecom', segment: 'dialog_cards', c: 5000, source: 'damaged_return' }]);
    expect(seg.balance(s, 'dialog_cards')).toBe(0);      // 30,000 - 20,000 - 10,000
    expect(seg.balance(s, 'airtel_cards')).toBe(20000);
    // void the newest return (the damaged one): refund comes back in dialog_cards; the loss row is voided by the database
    const v = await post(s.app, `/sales/${dialog.id}/returns/${r2.body.item.id}/void`, { reason: 'mistake' });
    expect(v.status).toBe(200);
    const rev = rows(s, "SELECT segment, amount_cents AS amt, reverses_entry_id AS rev FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? ORDER BY id", r2.body.item.id);
    expect(rev.map((x) => [x.segment, x.amt, x.rev !== null])).toEqual([['dialog_cards', -10000, false], ['dialog_cards', 10000, true]]);
    expect(seg.balance(s, 'dialog_cards')).toBe(10000);
    expect(seg.total(s)).toBe(30000);
    expect(seg.sumOfSegments(s)).toBe(30000);
  });

  it('void of a sale reverses its cash in the sale segment; a closed OTHER segment does not matter', async () => {
    const s = await setup();
    const { D, A } = await world(s);
    const sold = await sellNew(s, [cl(D.id, 1, 10000), cl(A.id, 1, 20000)]);
    await seg.closeOk(s, 'dialog_cards', today());
    const blocked = await post(s.app, `/sales/${sold.body.sales[0].id}/void`, { reason: 'x' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Dialog Cards');
    const v = await post(s.app, `/sales/${sold.body.sales[1].id}/void`, { reason: 'x' });
    expect(v.status).toBe(200);
    expect(cashOf(s, sold.body.sales[1].id).map((x) => [x.segment, x.amt])).toEqual([['airtel_cards', 20000], ['airtel_cards', -20000]]);
    expect(seg.balance(s, 'dialog_cards')).toBe(10000);
    expect(seg.balance(s, 'airtel_cards')).toBe(0);
  });
});

describe('corrections stay in the original scope', () => {
  it('a Dialog sale can be corrected into Dialog cards only; Airtel or a Dialog+Airtel body is 400 VALIDATION_ERROR', async () => {
    const s = await setup();
    const { S, D, A } = await world(s);
    const sold = await sellNew(s, [cl(S.id, 1, 30000), cl(D.id, 2, 10000)]);
    const dialog = sold.body.sales[1];
    const one = (items: unknown[]) => post(s.app, `/sales/${dialog.id}/correct`, { reason: 'wrong card', replacement: { items, clientRef: ref() } });
    for (const items of [[cl(A.id, 1, 20000)], [cl(D.id, 1, 10000), cl(A.id, 1, 20000)], [cl(S.id, 1, 30000)]]) {
      const bad = await one(items);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      expect(bad.body.error.fields.items).toContain('Dialog Cards');
    }
    expect(count(s, 'sales')).toBe(2);                 // nothing was saved, the original is still posted
    expect((await get(s.app, `/sales/${dialog.id}`)).body.item.status).toBe('posted');
    const good = await one([cl(D.id, 1, 12000)]);
    expect(good.status).toBe(201);
    expect(good.body.replacement.segment).toBe('dialog_cards');
    expect(seg.balance(s, 'dialog_cards')).toBe(12000); // 20,000 - 20,000 void + 12,000
  });
});

describe('legacy products', () => {
  it('a provider-less (legacy) card product cannot be sold: friendly 409, nothing saved', async () => {
    const s = await setup();
    const { S } = await world(s);
    const c = s.ctx.database.conn;
    const plain = Number((c.prepare("INSERT INTO categories (name, book) VALUES ('Old cards', 'telecom')").run()).lastInsertRowid);
    const old = await cardProduct(s, { provider: 'Hutch', minPriceCents: 0 });
    c.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(plain, old.id);
    stock(s, old.id, 5, 25000);
    const r = await sellNew(s, [cl(S.id, 1, 30000), cl(old.id, 1, 10000)]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SEGMENT_LEGACY_REFUSED');
    expect(Object.keys(r.body.error.fields)).toEqual(['items.1.productId']);
    expect(count(s, 'sales')).toBe(0);
    expect(count(s, 'stock_movements')).toBe(4 + 1);   // only the five raw opening rows
  });

  it('a return and a void of a legacy sale keep `legacy`', async () => {
    const s = await setup();
    await world(s);
    const c = s.ctx.database.conn;
    // a legacy sale as the migration left it: Telecom sale, `legacy` segment, its cash entry and a product of a provider-less category
    const plain = Number((c.prepare("INSERT INTO categories (name, book) VALUES ('Old cards', 'telecom')").run()).lastInsertRowid);
    const p = await cardProduct(s, { provider: 'Hutch', minPriceCents: 0 });
    c.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(plain, p.id);
    stock(s, p.id, 5, 25000);
    // The migration backfill is the only way a legacy row appears (INSERT of `legacy` is refused): drop the two INSERT guards for the
    // set-up, then put them back byte-identically.
    const guards = c.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('trg_sales_segment_insert', 'trg_cash_entries_segment_insert')").all() as unknown as Array<{ name: string; sql: string }>;
    expect(guards).toHaveLength(2);
    for (const g of guards) c.exec(`DROP TRIGGER ${g.name}`);
    const sid = Number(c.prepare("INSERT INTO sales (business_date, book, segment, total_cents, client_ref) VALUES (?, 'telecom', 'legacy', 10000, 'legacy-1')").run(today()).lastInsertRowid);
    c.prepare(`INSERT INTO sale_items (sale_id, line_no, line_type, product_id, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents)
               VALUES (?, 1, 'card', ?, 'old', 2, 5000, 5000, 10000, 10000)`).run(sid, p.id);
    c.prepare("INSERT INTO cash_entries (book, segment, business_date, type, amount_cents, ref_table, ref_id) VALUES ('telecom', 'legacy', ?, 'card_sale', 10000, 'sales', ?)").run(today(), sid);
    for (const g of guards) c.exec(g.sql);
    const item = (await get(s.app, `/sales/${sid}`)).body.item;
    expect(item.segment).toBe('legacy');
    const ret = await returnNew(s, sid, [{ saleItemId: item.items[0].id, qty: 1, resalable: false }]);
    expect(ret.status).toBe(201);
    expect(rows(s, "SELECT segment FROM cash_entries WHERE type = 'card_refund'")).toEqual([{ segment: 'legacy' }]);
    expect(rows(s, 'SELECT segment FROM stock_losses')).toEqual([{ segment: 'legacy' }]);
    const vr = await post(s.app, `/sales/${sid}/returns/${ret.body.item.id}/void`, { reason: 'x' });
    expect(vr.status).toBe(200);
    const v = await post(s.app, `/sales/${sid}/void`, { reason: 'x' });
    expect(v.status).toBe(200);
    expect(seg.balance(s, 'legacy')).toBe(0);
    expect(rows(s, "SELECT DISTINCT segment FROM cash_entries WHERE book = 'telecom'")).toEqual([{ segment: 'legacy' }]);
  });
});
