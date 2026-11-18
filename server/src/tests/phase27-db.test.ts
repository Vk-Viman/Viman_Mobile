// Sales discounts, DATABASE level (migrations 027 and 028): the new CHECKs, the immutable discount columns, the Telecom no-discount trigger, the
// compatibility default of the list price, no hard delete, and the closed-day / void protections of print_sales, all with RAW SQL on a freshly migrated
// database (no service involved). Every refusal is an error message (never a crash) and the refused statement writes nothing.
// Money in cents. Worked example used below: 4 chargers, list Rs 1,500.00, typed price Rs 1,400.00, Rs 75.00 per unit discount, Rs 10.00 whole-bill share:
//   gross at the typed price 560,000; per-unit discounts 4 x 7,500 = 30,000; bill share 1,000; revenue 560,000 - 30,000 - 1,000 = 529,000;
//   automatic price reduction 4 x (150,000 - 140,000) = 40,000.

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { freshDb, all, one, uniq } from './helpers/phase26db.ts';
import { sqlProduct } from './helpers/inventory.ts';
import { sqlSale, sqlSaleItem, sqlReturn, sqlReturnItem } from './helpers/phase5.ts';
import { sqlPrintSale, typeId } from './helpers/phase7.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const c of dbs.splice(0)) { try { c.close(); } catch { /* ignore */ } } });
const fresh = (): DatabaseSync => { const c = freshDb(); dbs.push(c); return c; };
const msg = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
const D = '2025-03-10';

type Row = Record<string, number | string | null>;
const LINE_DEFAULTS: Row = { line_no: 1, qty: 4, unit_price_cents: 140000, unit_cost_cents: 72000, cogs_cents: 288000, extra_cost_cents: 0, returned_qty: 0 };
/** Raw INSERT of a sale line naming EVERY discount column (the way the stage-2 services will write it). */
function item(c: DatabaseSync, saleId: number, productId: number, o: Row = {}): number {
  const book = String((c.prepare('SELECT book FROM sales WHERE id = ?').get(saleId) as { book: string }).book);
  const r: Row = {
    sale_id: saleId, line_type: book === 'shop' ? 'goods' : 'card', product_id: productId, description: 'Item', ...LINE_DEFAULTS,
    list_unit_price_cents: 150000, unit_discount_cents: 7500, line_discount_cents: 30000, price_reduction_cents: 40000, bill_discount_cents: 1000, revenue_cents: 529000,
    ...o,
  };
  const keys = Object.keys(r);
  return Number(c.prepare(`INSERT INTO sale_items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(r) as Array<string | number | null>)).lastInsertRowid);
}
const line = (c: DatabaseSync, id: number): Row => all(c, 'SELECT * FROM sale_items WHERE id = ?', id)[0] as Row;
const nItems = (c: DatabaseSync): number => Number(one(c, 'SELECT COUNT(*) FROM sale_items'));

/** A fresh database with a Shop sale, a Shop product, and one Telecom sale per card segment (with a card product of that provider). */
function world() {
  const c = fresh();
  const shopP = sqlProduct(c);
  const shopSale = sqlSale(c, { date: D, total: 0 });
  const tel: Record<string, { sale: number; product: number }> = {};
  for (const [seg, provider] of [['dialog_cards', 'Dialog'], ['mobitel_cards', 'Mobitel'], ['airtel_cards', 'Airtel'], ['hutch_cards', 'Hutch']] as const) {
    tel[seg] = { product: sqlProduct(c, { book: 'telecom', provider }), sale: sqlSale(c, { date: D, book: 'telecom', segment: seg, total: 0 }) };
  }
  return { c, shopP, shopSale, tel };
}

describe('sale_items: the new CHECKs accept the documented arithmetic and refuse everything else', () => {
  it('a Shop line with a price below the list price, a per-unit discount and a bill share is accepted and stored exactly', () => {
    const { c, shopP, shopSale } = world();
    const id = item(c, shopSale, shopP);
    expect(line(c, id)).toMatchObject({ qty: 4, unit_price_cents: 140000, list_unit_price_cents: 150000, unit_discount_cents: 7500, line_discount_cents: 30000, price_reduction_cents: 40000, bill_discount_cents: 1000, revenue_cents: 529000 });
  });

  it('accepted variants: list = price (no reduction), list below the price (ordinary higher price), a whole-bill discount only, a free line (revenue 0)', () => {
    const { c, shopP, shopSale } = world();
    let n = 1;
    const ok = (o: Row) => expect(msg(() => item(c, shopSale, shopP, { line_no: n++, ...o }))).toBe('');
    ok({ list_unit_price_cents: 140000, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 });
    ok({ list_unit_price_cents: 120000, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 });     // price above list
    ok({ list_unit_price_cents: 140000, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 7407, revenue_cents: 552593 });  // bill share only
    ok({ list_unit_price_cents: 140000, unit_discount_cents: 140000, line_discount_cents: 560000, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 0 });  // free
    ok({ list_unit_price_cents: 0, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 });          // list 0 is a real value
    expect(nItems(c)).toBe(5);
  });

  it('wrong arithmetic is refused: revenue, per-unit discount, line discount, price reduction, bill share', () => {
    const { c, shopP, shopSale } = world();
    let n = 1;
    const bad = (what: string, o: Row, re: RegExp) => expect(msg(() => item(c, shopSale, shopP, { line_no: n++, ...o })), what).toMatch(re);
    bad('revenue ignores the discounts (old rule)', { revenue_cents: 560000 }, /CHECK constraint failed/);
    bad('revenue one cent off', { revenue_cents: 529001 }, /CHECK constraint failed/);
    bad('revenue = gross - LD only (bill share forgotten)', { revenue_cents: 530000 }, /CHECK constraint failed/);
    bad('unit discount above the unit price', { unit_discount_cents: 140001, line_discount_cents: 560004, revenue_cents: -1000 - 4 + 0 }, /CHECK constraint failed/);
    bad('unit discount above the price with otherwise consistent numbers', { unit_discount_cents: 150000, line_discount_cents: 600000, bill_discount_cents: 0, price_reduction_cents: 40000, revenue_cents: -40000 }, /CHECK constraint failed/);
    bad('line discount is not unit x qty', { line_discount_cents: 29999, revenue_cents: 529001 }, /CHECK constraint failed/);
    bad('price reduction is not qty x (list - price)', { price_reduction_cents: 39999 }, /CHECK constraint failed/);
    bad('price reduction on a price ABOVE the list', { list_unit_price_cents: 120000, price_reduction_cents: 80000 }, /CHECK constraint failed/);
    bad('price reduction forgotten', { price_reduction_cents: 0 }, /CHECK constraint failed/);
    bad('negative unit discount', { unit_discount_cents: -1, line_discount_cents: -4, revenue_cents: 560003 - 1000 }, /CHECK constraint failed/);
    bad('negative bill share', { bill_discount_cents: -1, revenue_cents: 559001 - 30000 + 1000 - 1000 + 2 }, /CHECK constraint failed/);
    bad('discounts larger than the gross line (negative revenue)', { bill_discount_cents: 600000, revenue_cents: -70000 }, /CHECK constraint failed/);
    bad('list price below the not-supplied marker', { list_unit_price_cents: -2 }, /CHECK constraint failed/);
    bad('negative price reduction', { price_reduction_cents: -40000 }, /CHECK constraint failed/);
    expect(nItems(c)).toBe(0);
  });

  it('every old CHECK still holds: returned_qty bounds, line type, qty, UNIQUE (sale_id, line_no), non-negative costs', () => {
    const { c, shopP, shopSale } = world();
    item(c, shopSale, shopP);
    expect(msg(() => item(c, shopSale, shopP))).toMatch(/UNIQUE constraint failed: sale_items.sale_id, sale_items.line_no/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, returned_qty: 5 }))).toMatch(/CHECK constraint failed/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, returned_qty: -1 }))).toMatch(/CHECK constraint failed/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, line_type: 'service' }))).toMatch(/CHECK constraint failed|SALE_ITEM_BOOK_MISMATCH/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 0 }))).toMatch(/CHECK constraint failed/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, qty: 0, line_discount_cents: 0, price_reduction_cents: 0, revenue_cents: -1000 }))).toMatch(/CHECK constraint failed/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, unit_cost_cents: -1 }))).toMatch(/CHECK constraint failed/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, extra_cost_cents: -1 }))).toMatch(/CHECK constraint failed/);
    expect(msg(() => item(c, shopSale, shopP, { line_no: 2, cogs_cents: -1 }))).toMatch(/CHECK constraint failed/);
    expect(nItems(c)).toBe(1);
  });

  it('a Shop line of the wrong book, and the segment guard, still fire (the objects were re-created)', () => {
    const { c, shopSale, tel } = world();
    expect(msg(() => item(c, shopSale, tel.dialog_cards!.product, { list_unit_price_cents: 140000, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 }))).toMatch(/SALE_ITEM_BOOK_MISMATCH|SEGMENT_MISMATCH/);
    const t = tel.airtel_cards!;
    expect(msg(() => item(c, t.sale, tel.hutch_cards!.product, { list_unit_price_cents: 140000, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 }))).toMatch(/SEGMENT_MISMATCH/);
    expect(nItems(c)).toBe(0);
  });
});

describe('sale_items: compatibility of code that does not know the discount columns (the old INSERT)', () => {
  it('an INSERT without the new columns stores list = price and every discount 0 (the AFTER INSERT default), for Shop and for every Telecom segment', () => {
    const { c, shopP, shopSale, tel } = world();
    const a = sqlSaleItem(c, shopSale, shopP, { qty: 3, price: 123456, cost: 1, cogs: 3 });
    expect(line(c, a)).toMatchObject({ unit_price_cents: 123456, list_unit_price_cents: 123456, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 370368 });
    for (const [seg, t] of Object.entries(tel)) {
      const id = sqlSaleItem(c, t.sale, t.product, { qty: 2, price: 5000, cost: 1, cogs: 2 });
      expect(line(c, id), seg).toMatchObject({ list_unit_price_cents: 5000, unit_discount_cents: 0, price_reduction_cents: 0, revenue_cents: 10000 });
    }
    expect(Number(one(c, 'SELECT COUNT(*) FROM sale_items WHERE list_unit_price_cents < 0'))).toBe(0);   // the "not supplied" marker never stays stored
  });

  it('the marker -1 can never remain stored: an explicit -1 is replaced by the unit price; a real list price of 0 is kept', () => {
    const { c, shopP, shopSale } = world();
    const a = item(c, shopSale, shopP, { list_unit_price_cents: -1, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 });
    expect(line(c, a).list_unit_price_cents).toBe(140000);
    const b = item(c, shopSale, shopP, { line_no: 2, list_unit_price_cents: 0, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0, revenue_cents: 560000 });
    expect(line(c, b).list_unit_price_cents).toBe(0);
    // -1 together with a price reduction is refused (the reduction would not match list = price)
    expect(msg(() => item(c, shopSale, shopP, { line_no: 3, list_unit_price_cents: -1, price_reduction_cents: 40000 }))).toMatch(/CHECK constraint failed/);
    expect(Number(one(c, 'SELECT COUNT(*) FROM sale_items WHERE list_unit_price_cents < 0'))).toBe(0);
  });

  it('an old-style line still takes a return and the old returned_qty rules (nothing in the compatibility path changes the return triggers)', () => {
    const { c, shopP, shopSale } = world();
    const a = sqlSaleItem(c, shopSale, shopP, { qty: 3, price: 100000 });
    const r = sqlReturn(c, shopSale, { date: D, refund: 100000 });
    expect(msg(() => sqlReturnItem(c, r, a, 1, { revenue: 100000 }))).toBe('');
    c.prepare('UPDATE sale_items SET returned_qty = 1 WHERE id = ?').run(a);
    expect(msg(() => sqlReturnItem(c, r, a, 3, { revenue: 300000 }))).toMatch(/RETURN_EXCEEDS_SOLD/);
    expect(line(c, a).returned_qty).toBe(1);
  });
});

describe('sale_items: the discount columns are immutable after insert; no row can be deleted', () => {
  it.each([
    ['unit_discount_cents', 0], ['line_discount_cents', 0], ['price_reduction_cents', 0], ['bill_discount_cents', 0],
    ['list_unit_price_cents', 140000], ['list_unit_price_cents', 150001], ['list_unit_price_cents', -1],
    ['revenue_cents', 1], ['unit_price_cents', 1], ['qty', 1], ['cogs_cents', 1], ['unit_cost_cents', 1], ['description', 'x'],
  ])('UPDATE %s = %s is refused (SALE_ITEM_IMMUTABLE) and changes nothing', (col, value) => {
    const { c, shopP, shopSale } = world();
    const id = item(c, shopSale, shopP);
    const before = line(c, id);
    expect(msg(() => c.prepare(`UPDATE sale_items SET ${col} = ? WHERE id = ?`).run(value, id)), `${col}`).toMatch(/SALE_ITEM_IMMUTABLE|CHECK constraint failed/);
    expect(line(c, id)).toEqual(before);
  });

  it('a combined UPDATE that tries to move a discount into the bill share (revenue unchanged) is refused too', () => {
    const { c, shopP, shopSale } = world();
    const id = item(c, shopSale, shopP);
    const before = line(c, id);
    expect(msg(() => c.prepare('UPDATE sale_items SET unit_discount_cents = 0, line_discount_cents = 0, bill_discount_cents = 31000 WHERE id = ?').run(id))).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(line(c, id)).toEqual(before);
  });

  it('returned_qty may still rise (a return) and the extra cost stays immutable: the old behaviour of those columns is unchanged', () => {
    const { c, shopP, shopSale } = world();
    const id = item(c, shopSale, shopP);
    expect(msg(() => c.prepare('UPDATE sale_items SET returned_qty = 2 WHERE id = ?').run(id))).toBe('');
    expect(msg(() => c.prepare('UPDATE sale_items SET extra_cost_cents = 5 WHERE id = ?').run(id))).toMatch(/SALE_ITEM_IMMUTABLE/);
    expect(msg(() => c.prepare('UPDATE sale_items SET returned_qty = 0 WHERE id = ?').run(id))).toMatch(/SALE_ITEM_IMMUTABLE/);
  });

  it('deleting a discounted row (or any row) is refused', () => {
    const { c, shopP, shopSale } = world();
    const id = item(c, shopSale, shopP);
    expect(msg(() => c.prepare('DELETE FROM sale_items WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(msg(() => c.exec('DELETE FROM sale_items'))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(nItems(c)).toBe(1);
  });
});

describe('sale_items: Telecom lines (every card segment) refuse any discount and any list price other than the price', () => {
  const ZERO = { unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0 };
  const PLAIN: Row = { list_unit_price_cents: 140000, ...ZERO, revenue_cents: 560000 };

  it.each(['dialog_cards', 'mobitel_cards', 'airtel_cards', 'hutch_cards'])('%s: every non-zero discount column and every list <> price is refused with DISCOUNT_NOT_ALLOWED; plain lines are accepted', (seg) => {
    const { c, tel } = world();
    const t = tel[seg]!;
    const refused = (what: string, o: Row) => expect(msg(() => item(c, t.sale, t.product, { ...PLAIN, ...o })), `${seg}: ${what}`).toMatch(/DISCOUNT_NOT_ALLOWED/);
    refused('unit discount', { unit_discount_cents: 7500, line_discount_cents: 30000, revenue_cents: 530000 });
    refused('line discount only (inconsistent arithmetic too)', { line_discount_cents: 30000, revenue_cents: 530000 });
    refused('bill share', { bill_discount_cents: 1000, revenue_cents: 559000 });
    refused('price reduction', { list_unit_price_cents: 150000, price_reduction_cents: 40000 });
    refused('list above the price (no reduction recorded)', { list_unit_price_cents: 150000, price_reduction_cents: 0 });
    refused('list below the price', { list_unit_price_cents: 130000 });
    refused('list 0', { list_unit_price_cents: 0 });
    expect(nItems(c), `${seg}: nothing written`).toBe(0);
    expect(msg(() => item(c, t.sale, t.product, PLAIN))).toBe('');                       // the same line without any discount is accepted
  });

  it('a Telecom line is accepted when list = price with every discount 0 (explicit), or when the columns are omitted', () => {
    const { c, tel } = world();
    for (const [seg, t] of Object.entries(tel)) {
      expect(msg(() => item(c, t.sale, t.product, { ...PLAIN, line_no: 1 })), seg).toBe('');
      expect(msg(() => sqlSaleItem(c, t.sale, t.product, { lineNo: 2, qty: 1, price: 100, cost: 1, cogs: 1 })), seg).toBe('');
      expect(all(c, 'SELECT list_unit_price_cents l, unit_price_cents p, unit_discount_cents u, line_discount_cents ld, price_reduction_cents pr, bill_discount_cents b FROM sale_items WHERE sale_id = ? ORDER BY line_no', t.sale))
        .toEqual([{ l: 140000, p: 140000, u: 0, ld: 0, pr: 0, b: 0 }, { l: 100, p: 100, u: 0, ld: 0, pr: 0, b: 0 }]);
    }
  });

  it('the same discounted values are accepted on a Shop line (the trigger is about Telecom only), and nothing was written by the refused Telecom attempts', () => {
    const { c, shopP, shopSale, tel } = world();
    expect(msg(() => item(c, shopSale, shopP))).toBe('');
    for (const t of Object.values(tel)) expect(msg(() => item(c, t.sale, t.product))).toMatch(/DISCOUNT_NOT_ALLOWED/);
    expect(nItems(c)).toBe(1);
    expect(Number(one(c, "SELECT COUNT(*) FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.book = 'telecom'"))).toBe(0);
  });

  it('the Telecom trigger cannot be dodged by inserting the sale line first and the sale after (the sale must exist: foreign key) nor by a multi-row statement', () => {
    const { c, shopP, tel } = world();
    const t = tel.dialog_cards!;
    // a multi-row INSERT mixing a good and a discounted Telecom line writes neither
    const sql = `INSERT INTO sale_items (sale_id, line_no, line_type, product_id, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents,
        list_unit_price_cents, unit_discount_cents, line_discount_cents, price_reduction_cents, bill_discount_cents)
      VALUES (${t.sale}, 1, 'card', ${t.product}, 'a', 1, 100, 1, 100, 1, 100, 0, 0, 0, 0),
             (${t.sale}, 2, 'card', ${t.product}, 'b', 1, 100, 1, 90, 1, 100, 10, 10, 0, 0)`;
    expect(msg(() => c.exec(sql))).toMatch(/DISCOUNT_NOT_ALLOWED/);
    expect(nItems(c)).toBe(0);
    // a line of a sale that does not exist
    expect(msg(() => c.prepare(`INSERT INTO sale_items (sale_id, line_no, line_type, product_id, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents)
      VALUES (424242, 1, 'goods', ?, 'x', 1, 100, 1, 100, 1)`).run(shopP))).toMatch(/FOREIGN KEY|SALE_ITEM_BOOK_MISMATCH/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('print_sales: the new CHECKs accept the documented arithmetic and refuse everything else', () => {
  /** Raw INSERT of a print sale naming every discount column. Default: 100 photocopies, list 1,000, typed 800, Rs 2.00 per copy... see the worked figures per test. */
  function ps(c: DatabaseSync, o: Row = {}): number {
    const r: Row = {
      business_date: D, service_type_id: typeId(c, 'PC_BW_1S'), description: 'Photocopy', qty: 100, unit_price_cents: 1000, unit_cost_cents: 300, revenue_cents: 80000, cogs_cents: 30000,
      client_ref: uniq('ps'), list_unit_price_cents: 1000, unit_discount_cents: 200, line_discount_cents: 20000, price_reduction_cents: 0, bill_discount_cents: 0, ...o,
    };
    const keys = Object.keys(r);
    return Number(c.prepare(`INSERT INTO print_sales (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(r) as Array<string | number | null>)).lastInsertRowid);
  }
  const row = (c: DatabaseSync, id: number): Row => all(c, 'SELECT * FROM print_sales WHERE id = ?', id)[0] as Row;
  const nPs = (c: DatabaseSync): number => Number(one(c, 'SELECT COUNT(*) FROM print_sales'));

  it('100 copies at Rs 10.00 with Rs 2.00 per copy: revenue 80,000, cost 30,000 (example 7); the typed-price-below-list and whole-sale-discount variants (examples 8-10)', () => {
    const c = fresh();
    expect(row(c, ps(c))).toMatchObject({ revenue_cents: 80000, cogs_cents: 30000, list_unit_price_cents: 1000, unit_discount_cents: 200, line_discount_cents: 20000, price_reduction_cents: 0, bill_discount_cents: 0 });
    // example 8: 20 colour pages typed Rs 20.00 instead of Rs 25.00: PR 10,000, revenue 40,000; with Rs 4.00 per page: LD 8,000, revenue 32,000
    const clr = typeId(c, 'CLR_1S');
    expect(msg(() => ps(c, { service_type_id: clr, qty: 20, unit_price_cents: 2000, unit_cost_cents: 800, cogs_cents: 16000, list_unit_price_cents: 2500, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 10000, revenue_cents: 40000 }))).toBe('');
    expect(msg(() => ps(c, { service_type_id: clr, qty: 20, unit_price_cents: 2000, unit_cost_cents: 800, cogs_cents: 16000, list_unit_price_cents: 2500, unit_discount_cents: 400, line_discount_cents: 8000, price_reduction_cents: 10000, revenue_cents: 32000 }))).toBe('');
    // example 9: phone setup, 1 unit, Rs 1,000.00, whole-sale discount Rs 150.00 -> 85,000; a free sale (discount = whole price) is allowed too
    const custom = typeId(c, 'CUSTOM');
    expect(msg(() => ps(c, { service_type_id: custom, qty: 1, unit_price_cents: 100000, unit_cost_cents: 20000, cogs_cents: 20000, list_unit_price_cents: 100000, unit_discount_cents: 0, line_discount_cents: 0, bill_discount_cents: 15000, revenue_cents: 85000 }))).toBe('');
    expect(msg(() => ps(c, { service_type_id: custom, qty: 1, unit_price_cents: 100000, unit_cost_cents: 20000, cogs_cents: 20000, list_unit_price_cents: 100000, unit_discount_cents: 0, line_discount_cents: 0, bill_discount_cents: 100000, revenue_cents: 0 }))).toBe('');
    // example 10: 50 copies at Rs 10.00, Rs 1.00 per copy, whole-sale Rs 45.00 -> 40,500
    expect(msg(() => ps(c, { qty: 50, unit_price_cents: 1000, unit_cost_cents: 300, cogs_cents: 15000, list_unit_price_cents: 1000, unit_discount_cents: 100, line_discount_cents: 5000, bill_discount_cents: 4500, revenue_cents: 40500 }))).toBe('');
    expect(nPs(c)).toBe(6);
  });

  it('wrong arithmetic is refused: revenue, unit discount above the price, line discount, price reduction, negative values, negative revenue, cost', () => {
    const c = fresh();
    const bad = (what: string, o: Row) => expect(msg(() => ps(c, o)), what).toMatch(/CHECK constraint failed/);
    bad('revenue ignores the discount (old rule)', { revenue_cents: 100000 });
    bad('revenue one cent off', { revenue_cents: 80001 });
    bad('bill share forgotten', { bill_discount_cents: 500, revenue_cents: 80000 });
    bad('unit discount above the price', { unit_discount_cents: 1001, line_discount_cents: 100100, revenue_cents: -100 });
    bad('line discount is not unit x qty', { line_discount_cents: 19999, revenue_cents: 80001 });
    bad('price reduction missing', { list_unit_price_cents: 1200, price_reduction_cents: 0 });
    bad('price reduction on a price above the list', { list_unit_price_cents: 900, price_reduction_cents: 10000 });
    bad('negative unit discount', { unit_discount_cents: -1, line_discount_cents: -100, revenue_cents: 100100 });
    bad('negative bill share', { bill_discount_cents: -5, revenue_cents: 80005 });
    bad('discount larger than the gross amount', { bill_discount_cents: 90000, revenue_cents: -10000 });
    bad('list below the marker', { list_unit_price_cents: -2 });
    bad('cost no longer qty x unit cost', { cogs_cents: 29999 });
    bad('quantity 0', { qty: 0, unit_discount_cents: 0, line_discount_cents: 0, revenue_cents: 0, cogs_cents: 0 });
    bad('status void without a reason', { status: 'void' });
    bad('a real date only', { business_date: '2025-02-30' });
    expect(nPs(c)).toBe(0);
  });

  it('an INSERT without the new columns (code written before discounts) stores list = price and zero discounts', () => {
    const c = fresh();
    const id = sqlPrintSale(c, { qty: 7, price: 1234, cost: 400 });
    expect(row(c, id)).toMatchObject({ revenue_cents: 8638, cogs_cents: 2800, list_unit_price_cents: 1234, unit_discount_cents: 0, line_discount_cents: 0, price_reduction_cents: 0, bill_discount_cents: 0 });
    // the marker -1 is never left behind; list 0 is a real value; a reduction with the marker is refused
    const a = ps(c, { list_unit_price_cents: -1, unit_discount_cents: 0, line_discount_cents: 0, revenue_cents: 100000 });
    expect(row(c, a).list_unit_price_cents).toBe(1000);
    const b = ps(c, { list_unit_price_cents: 0, unit_discount_cents: 0, line_discount_cents: 0, revenue_cents: 100000 });
    expect(row(c, b).list_unit_price_cents).toBe(0);
    expect(msg(() => ps(c, { list_unit_price_cents: -1, price_reduction_cents: 5 }))).toMatch(/CHECK constraint failed/);
    expect(Number(one(c, 'SELECT COUNT(*) FROM print_sales WHERE list_unit_price_cents < 0'))).toBe(0);
  });

  it.each([
    ['unit_discount_cents', 0], ['line_discount_cents', 0], ['price_reduction_cents', 1], ['bill_discount_cents', 1],
    ['list_unit_price_cents', 1001], ['list_unit_price_cents', -1], ['revenue_cents', 1], ['cogs_cents', 1], ['qty', 1], ['unit_price_cents', 1], ['unit_cost_cents', 1],
    ['description', 'x'], ['notes', 'x'], ['client_ref', 'other'], ['service_type_id', 2],
  ])('UPDATE %s = %s is refused and changes nothing (the discount columns are immutable, the old columns still are)', (col, value) => {
    const c = fresh();
    const id = ps(c);
    const before = row(c, id);
    expect(msg(() => c.prepare(`UPDATE print_sales SET ${col} = ? WHERE id = ?`).run(value, id)), col).toMatch(/PRINT_SALE_IMMUTABLE|CHECK constraint failed/);
    expect(row(c, id)).toEqual(before);
  });

  it('deleting a print sale is refused; posted_at and business_date stay immutable', () => {
    const c = fresh();
    const id = ps(c);
    expect(msg(() => c.prepare('DELETE FROM print_sales WHERE id = ?').run(id))).toMatch(/RECORD_DELETE_FORBIDDEN/);
    expect(msg(() => c.prepare("UPDATE print_sales SET business_date = '2025-03-09' WHERE id = ?").run(id))).toMatch(/BUSINESS_DATE_IMMUTABLE/);
    expect(msg(() => c.prepare("UPDATE print_sales SET posted_at = '2025-03-09T00:00:00Z' WHERE id = ?").run(id))).toMatch(/POSTED_AT_IMMUTABLE/);
    expect(nPs(c)).toBe(1);
  });

  it('closed-day protection: a discounted print sale on a closed day, or before a closed day, is refused (DAY_CLOSED / BACKDATE_BEFORE_CLOSED_DAY); another day is fine', () => {
    const c = fresh();
    c.prepare("INSERT INTO daily_closings (book, business_date, expected_cents) VALUES ('shop', ?, 0)").run('2025-03-10');
    expect(msg(() => ps(c, { business_date: '2025-03-10' }))).toMatch(/DAY_CLOSED/);
    expect(msg(() => ps(c, { business_date: '2025-03-09' }))).toMatch(/BACKDATE_BEFORE_CLOSED_DAY/);
    expect(msg(() => sqlPrintSale(c, { date: '2025-03-10' }))).toMatch(/DAY_CLOSED/);   // the old INSERT path too
    expect(msg(() => ps(c, { business_date: '2025-03-11' }))).toBe('');
    expect(nPs(c)).toBe(1);
    // a closing of ANOTHER book does not block the Shop service
    const c2 = fresh();
    c2.prepare("INSERT INTO daily_closings (book, segment, business_date, expected_cents) VALUES ('telecom', 'dialog_reloads', '2025-03-10', 0)").run();
    expect(msg(() => ps(c2, { business_date: '2025-03-10' }))).toBe('');
  });

  it('future dates and inactive service types are refused', () => {
    const c = fresh();
    expect(msg(() => ps(c, { business_date: '2099-01-01' }))).toMatch(/FUTURE_DATE_NOT_ALLOWED/);
    c.prepare('UPDATE print_service_types SET active = 0 WHERE code = ?').run('PC_BW_1S');
    expect(msg(() => ps(c))).toMatch(/SERVICE_TYPE_INACTIVE/);
    expect(nPs(c)).toBe(0);
  });

  it('void protections: void needs the reversal of its cash entry; a voided row is final; a posted row cannot be re-labelled; a closed day blocks the void', () => {
    const c = fresh();
    const id = ps(c);
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id) VALUES ('shop', ?, 'sale_service', 80000, 'print_sales', ?)").run(D, id);
    const voidSql = `UPDATE print_sales SET status = 'void', voided_at = '2025-03-10T10:00:00Z', void_reason = 'duplicate' WHERE id = ${id}`;
    expect(msg(() => c.exec(voidSql))).toMatch(/VOID_WITHOUT_REVERSAL/);
    expect(row(c, id).status).toBe('posted');
    expect(msg(() => c.prepare("UPDATE print_sales SET void_reason = 'x' WHERE id = ?").run(id))).toMatch(/PRINT_SALE_IMMUTABLE|CHECK constraint failed/);
    // with the reversal row first, the void is accepted, keeps every discount value, and is then terminal
    const orig = Number(one(c, "SELECT id FROM cash_entries WHERE ref_table = 'print_sales' AND ref_id = ?", id));
    c.prepare("INSERT INTO cash_entries (book, business_date, type, amount_cents, ref_table, ref_id, reverses_entry_id) VALUES ('shop', ?, 'sale_service', -80000, 'print_sales', ?, ?)").run(D, id, orig);
    expect(msg(() => c.exec(voidSql))).toBe('');
    expect(row(c, id)).toMatchObject({ status: 'void', unit_discount_cents: 200, line_discount_cents: 20000, revenue_cents: 80000, list_unit_price_cents: 1000 });
    expect(msg(() => c.prepare("UPDATE print_sales SET status = 'posted', voided_at = NULL, void_reason = NULL WHERE id = ?").run(id))).toMatch(/PRINT_SALE_IMMUTABLE/);
    // a closed day blocks the void of a record on it
    const c2 = fresh();
    const id2 = ps(c2);
    c2.prepare("INSERT INTO daily_closings (book, business_date, expected_cents) VALUES ('shop', ?, 0)").run(D);
    expect(msg(() => c2.exec(`UPDATE print_sales SET status = 'void', voided_at = '2025-03-10T10:00:00Z', void_reason = 'late' WHERE id = ${id2}`))).toMatch(/DAY_CLOSED/);
    expect(row(c2, id2).status).toBe('posted');
  });

  it('the foreign key to the service type still holds, and print_sales stays a Shop-only table: no Telecom check is needed because it has no book column', () => {
    const c = fresh();
    expect(msg(() => ps(c, { service_type_id: 9999 }))).toMatch(/FOREIGN KEY constraint failed|SERVICE_TYPE_INACTIVE/);
    expect(all(c, 'PRAGMA table_info(print_sales)').map((r) => r.name)).not.toContain('book');
    expect(all(c, 'PRAGMA foreign_key_list(print_sales)').map((r) => r.table)).toEqual(['print_service_types']);
  });
});

describe('every refusal above is a plain SQL error message, and the integrity of the database is intact afterwards', () => {
  it('after a series of refused statements the database is still consistent', () => {
    const { c, shopP, shopSale, tel } = world();
    item(c, shopSale, shopP);
    for (const o of [{ revenue_cents: 1 }, { unit_discount_cents: 999999 }, { price_reduction_cents: 1 }] as Row[]) expect(msg(() => item(c, shopSale, shopP, { line_no: 2, ...o }))).not.toBe('');
    expect(msg(() => item(c, tel.dialog_cards!.sale, tel.dialog_cards!.product))).toMatch(/DISCOUNT_NOT_ALLOWED/);
    expect(all(c, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(all(c, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(nItems(c)).toBe(1);
  });
});
