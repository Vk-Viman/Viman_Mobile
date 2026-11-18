// Telecom segments, DATABASE level (migrations 024-026): every INSERT-rule, immutability, mirror, transfer-link, category-provider, product
// and consistency trigger exercised with RAW SQL on a freshly migrated database (no service involved), plus the legacy cases on the
// upgraded frozen schema-23 fixture and the EXPLAIN QUERY PLAN of the closed-day probe.

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { migrate } from '../db/migrate.ts';
import {
  BOOK_TABLES, CARDS, D, MAKE, RELOADS, SEGMENTS, TELECOM_ONLY_TABLES, TELECOM_SEGMENT_OF, addStock, all, cardProduct, category, err, freshDb, ins, one,
  product, providerId, shopProduct, telecomRow, uniq,
} from './helpers/phase26db.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const dbs: DatabaseSync[] = [];
const fresh = (): DatabaseSync => { const c = freshDb(); dbs.push(c); return c; };
afterEach(() => { for (const c of dbs.splice(0)) { try { c.close(); } catch { /* ignore */ } } });

const ALL_TABLES = [...BOOK_TABLES, ...TELECOM_ONLY_TABLES] as string[];
/** Tables whose domain is Cards only / Reloads only / all eight. */
const DOMAIN: Record<string, readonly string[]> = Object.fromEntries(ALL_TABLES.map((t) => [
  t, ['purchases', 'stock_losses', 'stocktakes', 'sales'].includes(t) ? CARDS : (TELECOM_ONLY_TABLES as readonly string[]).includes(t) ? RELOADS : SEGMENTS]));
const OTHER_DOMAIN: Record<string, readonly string[]> = Object.fromEntries(ALL_TABLES.map((t) => [t, SEGMENTS.filter((s) => !DOMAIN[t]!.includes(s))]));

describe('INSERT rules: a Telecom row needs a segment, other books forbid one, legacy is refused', () => {
  for (const t of BOOK_TABLES) {
    it(`${t}: telecom without segment -> SEGMENT_REQUIRED; shop with segment -> SEGMENT_NOT_ALLOWED; legacy -> SEGMENT_LEGACY_REFUSED; valid rows accepted`, () => {
      const c = fresh();
      expect(err(() => MAKE[t]!(c, telecomRow(c, t, null)))).toMatch(/SEGMENT_REQUIRED/);
      expect(err(() => MAKE[t]!(c, { segment: DOMAIN[t]![0]! }))).toMatch(/SEGMENT_NOT_ALLOWED/);
      expect(err(() => MAKE[t]!(c, telecomRow(c, t, 'legacy')))).toMatch(/SEGMENT_LEGACY_REFUSED/);
      // valid: every segment of the domain; shop with NULL
      for (const seg of DOMAIN[t]!) expect(err(() => MAKE[t]!(c, telecomRow(c, t, seg))), `${t} ${seg}`).toBe('');
      expect(err(() => MAKE[t]!(c))).toBe('');
      expect(one(c, `SELECT COUNT(*) FROM ${t} WHERE segment IS NOT NULL`)).toBe(DOMAIN[t]!.length);
    });
  }

  for (const t of TELECOM_ONLY_TABLES) {
    it(`${t}: no book column; a segment is always required and legacy is refused`, () => {
      const c = fresh();
      expect(err(() => MAKE[t]!(c, { segment: null }))).toMatch(/SEGMENT_REQUIRED/);
      expect(err(() => MAKE[t]!(c, { segment: 'legacy' }))).toMatch(/SEGMENT_LEGACY_REFUSED/);
      expect(err(() => MAKE[t]!(c, { segment: 'dialog_reloads' }))).toBe('');
    });
  }

  it('Ice Cream rows (a book with funds) forbid a segment too, in every table that can hold them', () => {
    const c = fresh();
    for (const t of ['cash_entries', 'cash_counts', 'capital_entries', 'owner_drawings', 'daily_closings']) {
      const base: Record<string, string | number | null> = { book: 'icecream', fund: 'cost' };
      if (t === 'cash_counts') { base.expected_cents = 0; base.counted_cents = 1; base.difference_cents = 1; base.note = 'x'; }
      if (t === 'daily_closings') delete base.fund;
      expect(err(() => MAKE[t]!(c, { ...base, segment: 'dialog_reloads' })), t).toMatch(/SEGMENT_NOT_ALLOWED/);
    }
  });
});

describe('column domains (CHECK): cards tables take only *_cards, reload tables only *_reloads, others all eight', () => {
  for (const t of ALL_TABLES) {
    it(`${t}: a segment outside its domain or unknown text is refused`, () => {
      const c = fresh();
      for (const seg of OTHER_DOMAIN[t]!) expect(err(() => MAKE[t]!(c, telecomRow(c, t, seg))), `${t} ${seg}`).toMatch(/CHECK constraint failed|SEGMENT_MISMATCH/);
      for (const bad of ['dialog', 'DIALOG_CARDS', 'cards', '', 'legacy ']) expect(err(() => MAKE[t]!(c, telecomRow(c, t, bad))), `${t} '${bad}'`).not.toBe('');
    });
  }
});

describe('the segment never changes (BEFORE UPDATE OF segment)', () => {
  for (const t of ALL_TABLES) {
    it(`${t}: UPDATE segment is refused (even to the same domain); an update that leaves it alone passes`, () => {
      const c = fresh();
      const id = MAKE[t]!(c, telecomRow(c, t, DOMAIN[t]![0]!));
      const other = DOMAIN[t]![1]!;
      const m = err(() => c.prepare(`UPDATE ${t} SET segment = ? WHERE id = ?`).run(other, id));
      // cash_entries is also append-only (its own trigger may speak first)
      expect(m).toMatch(t === 'cash_entries' ? /SEGMENT_READ_ONLY|append-only/ : /SEGMENT_READ_ONLY/);
      expect(err(() => c.prepare(`UPDATE ${t} SET segment = NULL WHERE id = ?`).run(id))).toMatch(t === 'cash_entries' ? /SEGMENT_READ_ONLY|append-only/ : /SEGMENT_READ_ONLY/);
      expect(one(c, `SELECT segment FROM ${t} WHERE id = ?`, id)).toBe(DOMAIN[t]![0]!);
      // a shop row may not gain one either
      const sid = MAKE[t]!(c, (TELECOM_ONLY_TABLES as readonly string[]).includes(t) ? telecomRow(c, t, DOMAIN[t]![0]!) : {});
      if (!(TELECOM_ONLY_TABLES as readonly string[]).includes(t)) {
        expect(err(() => c.prepare(`UPDATE ${t} SET segment = ? WHERE id = ?`).run(DOMAIN[t]![0]!, sid))).toMatch(t === 'cash_entries' ? /SEGMENT_READ_ONLY|append-only/ : /SEGMENT_READ_ONLY/);
        expect(one(c, `SELECT segment FROM ${t} WHERE id = ?`, sid)).toBeNull();
      }
    });
  }
});

describe('cash transfers: segment on each Telecom side, transfers between two Telecom segments, legs carry their side\'s segment', () => {
  const T = (c: DatabaseSync, o: Record<string, string | number | null>) => ins(c, 'cash_transfers', { business_date: D, amount_cents: 100, client_ref: uniq(), ...o });

  it('INSERT rules per side', () => {
    const c = fresh();
    expect(err(() => T(c, { from_book: 'telecom', to_book: 'shop' }))).toMatch(/SEGMENT_REQUIRED/);
    expect(err(() => T(c, { from_book: 'shop', to_book: 'telecom' }))).toMatch(/SEGMENT_REQUIRED/);
    expect(err(() => T(c, { from_book: 'shop', to_book: 'icecream', to_fund: 'cost', from_segment: 'dialog_cards' }))).toMatch(/SEGMENT_NOT_ALLOWED/);
    expect(err(() => T(c, { from_book: 'shop', to_book: 'icecream', to_fund: 'cost', to_segment: 'dialog_cards' }))).toMatch(/SEGMENT_NOT_ALLOWED/);
    expect(err(() => T(c, { from_book: 'telecom', from_segment: 'legacy', to_book: 'shop' }))).toMatch(/SEGMENT_LEGACY_REFUSED/);
    expect(err(() => T(c, { from_book: 'shop', to_book: 'telecom', to_segment: 'legacy' }))).toMatch(/SEGMENT_LEGACY_REFUSED/);
    expect(err(() => T(c, { from_book: 'telecom', from_segment: 'bogus', to_book: 'shop' }))).toMatch(/CHECK constraint failed/);
    expect(err(() => T(c, { from_book: 'telecom', from_segment: 'dialog_cards', to_book: 'shop' }))).toBe('');
    expect(err(() => T(c, { from_book: 'icecream', from_fund: 'cost', to_book: 'telecom', to_segment: 'hutch_reloads' }))).toBe('');
  });

  it('between two Telecom segments is allowed, between the same segment (or the same non-Telecom book) is refused', () => {
    const c = fresh();
    expect(err(() => T(c, { from_book: 'telecom', from_segment: 'dialog_reloads', to_book: 'telecom', to_segment: 'mobitel_cards' }))).toBe('');
    expect(err(() => T(c, { from_book: 'telecom', from_segment: 'dialog_reloads', to_book: 'telecom', to_segment: 'dialog_reloads' }))).toMatch(/CHECK constraint failed/);
    expect(err(() => T(c, { from_book: 'shop', to_book: 'shop' }))).toMatch(/CHECK constraint failed/);
    expect(err(() => T(c, { from_book: 'icecream', from_fund: 'cost', to_book: 'icecream', to_fund: 'profit' }))).toMatch(/CHECK constraint failed/);
  });

  it('immutable segments; the transfer-link trigger compares the segment of each leg', () => {
    const c = fresh();
    const id = T(c, { from_book: 'telecom', from_segment: 'dialog_reloads', to_book: 'telecom', to_segment: 'mobitel_cards' });
    expect(err(() => c.prepare('UPDATE cash_transfers SET from_segment = ? WHERE id = ?').run('hutch_cards', id))).toMatch(/SEGMENT_READ_ONLY/);
    expect(err(() => c.prepare('UPDATE cash_transfers SET to_segment = ? WHERE id = ?').run('hutch_cards', id))).toMatch(/SEGMENT_READ_ONLY/);
    const leg = (type: string, segment: string, amount: number) => ins(c, 'cash_entries', { book: 'telecom', segment, business_date: D, type, amount_cents: amount, ref_table: 'cash_transfers', ref_id: id, transfer_id: id });
    expect(err(() => leg('transfer_out', 'mobitel_cards', -100))).toMatch(/TRANSFER_LEG_MISMATCH/);   // the out leg belongs to dialog_reloads
    expect(err(() => leg('transfer_out', 'dialog_cards', -100))).toMatch(/TRANSFER_LEG_MISMATCH/);
    expect(err(() => leg('transfer_in', 'dialog_reloads', 100))).toMatch(/TRANSFER_LEG_MISMATCH/);    // the in leg belongs to mobitel_cards
    expect(err(() => leg('transfer_out', 'dialog_reloads', -100))).toBe('');
    expect(err(() => leg('transfer_in', 'mobitel_cards', 100))).toBe('');
    // the Shop side carries no segment
    const id2 = T(c, { from_book: 'telecom', from_segment: 'airtel_reloads', to_book: 'shop' });
    expect(err(() => ins(c, 'cash_entries', { book: 'shop', business_date: D, type: 'transfer_in', amount_cents: 100, ref_table: 'cash_transfers', ref_id: id2, transfer_id: id2, segment: 'airtel_reloads' }))).not.toBe('');
    expect(err(() => ins(c, 'cash_entries', { book: 'shop', business_date: D, type: 'transfer_in', amount_cents: 100, ref_table: 'cash_transfers', ref_id: id2, transfer_id: id2 }))).toBe('');
  });
});

describe('reversal mirror (cash entries): a reversal carries the segment of the entry it reverses', () => {
  it('same predicate as before plus the segment', () => {
    const c = fresh();
    const orig = ins(c, 'cash_entries', { book: 'telecom', segment: 'dialog_reloads', business_date: D, type: 'cash_adjustment', amount_cents: 500 });
    const rev = (segment: string | null, o: Record<string, string | number | null> = {}) =>
      ins(c, 'cash_entries', { book: 'telecom', segment, business_date: D, type: 'cash_adjustment', amount_cents: -500, reverses_entry_id: orig, ...o });
    expect(err(() => rev('mobitel_reloads'))).toMatch(/REVERSAL_MISMATCH/);
    expect(err(() => rev('dialog_cards'))).toMatch(/REVERSAL_MISMATCH/);
    expect(err(() => rev(null))).toMatch(/SEGMENT_REQUIRED|REVERSAL_MISMATCH/); // refused either way: a reversal without a segment is no mirror
    expect(err(() => rev('dialog_reloads', { business_date: '2025-03-11' }))).toMatch(/REVERSAL_MISMATCH/); // the old predicates still apply
    expect(err(() => rev('dialog_reloads', { amount_cents: -499 }))).toMatch(/REVERSAL_MISMATCH/);
    expect(err(() => rev('dialog_reloads'))).toBe('');
    expect(err(() => rev('dialog_reloads'))).toMatch(/UNIQUE|REVERSAL/); // one reversal per entry, unchanged
  });
});

describe('a non-reversal cash entry carries the segment of the record that owns it (026)', () => {
  const OWNERS: Array<{ table: string; type: string; make: (c: DatabaseSync, seg: string) => number; amount: number }> = [
    { table: 'expenses', type: 'expense', make: (c, s) => MAKE.expenses!(c, { book: 'telecom', segment: s }), amount: -100 },
    { table: 'capital_entries', type: 'capital', make: (c, s) => MAKE.capital_entries!(c, { book: 'telecom', segment: s }), amount: 100 },
    { table: 'owner_drawings', type: 'drawing_cash', make: (c, s) => MAKE.owner_drawings!(c, { book: 'telecom', segment: s }), amount: -100 },
    { table: 'cash_counts', type: 'cash_adjustment', make: (c, s) => MAKE.cash_counts!(c, { book: 'telecom', segment: s }), amount: 100 },
    { table: 'reload_sales', type: 'reload_collection', make: (c, s) => MAKE.reload_sales!(c, { segment: s, provider_id: providerId(c, 'Mobitel') }), amount: 10000 },
    { table: 'ezcash_sales', type: 'ezcash_collection', make: (c, s) => MAKE.ezcash_sales!(c, { segment: s }), amount: 10000 },
    { table: 'telecom_topups', type: 'wallet_topup', make: (c, s) => MAKE.telecom_topups!(c, { segment: s }), amount: -100 },
    { table: 'purchases', type: 'purchase_payment', make: (c, s) => MAKE.purchases!(c, { book: 'telecom', segment: s }), amount: -100 },
    { table: 'sales', type: 'card_sale', make: (c, s) => MAKE.sales!(c, { book: 'telecom', segment: s }), amount: 100 },
  ];
  for (const o of OWNERS) {
    const own = (o.table === 'reload_sales' ? 'mobitel_reloads' : o.table === 'ezcash_sales' || o.table === 'telecom_topups' ? 'dialog_reloads' : o.table === 'purchases' || o.table === 'sales' ? 'airtel_cards' : 'hutch_reloads');
    const other = SEGMENTS.find((s) => s !== own && (DOMAIN[o.table]!.includes(s)) && s.endsWith(own.endsWith('cards') ? 'cards' : 'reloads'))!;
    it(`${o.table}: the entry must carry '${own}', not '${other}'`, () => {
      const c = fresh();
      const id = o.make(c, own);
      const entry = (segment: string) => ins(c, 'cash_entries', { book: 'telecom', segment, business_date: D, type: o.type, amount_cents: o.amount, ref_table: o.table, ref_id: id });
      expect(err(() => entry(other))).toMatch(/SEGMENT_MISMATCH/);
      expect(err(() => entry(own))).toBe('');
    });
  }

  it('a return\'s refund entry is judged by the sale\'s segment (header of the return has none)', () => {
    const c = fresh();
    const sale = MAKE.sales!(c, { book: 'telecom', segment: 'mobitel_cards' });
    const ret = ins(c, 'sales_returns', { sale_id: sale, business_date: D, refund_cents: 100, cogs_reversed_cents: 0, client_ref: uniq() });
    const entry = (segment: string) => ins(c, 'cash_entries', { book: 'telecom', segment, business_date: D, type: 'card_refund', amount_cents: -100, ref_table: 'sales_returns', ref_id: ret });
    expect(err(() => entry('dialog_cards'))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => entry('mobitel_cards'))).toBe('');
    const pur = MAKE.purchases!(c, { book: 'telecom', segment: 'hutch_cards' });
    const pret = ins(c, 'purchase_returns', { purchase_id: pur, business_date: D, refund_cents: 100, client_ref: uniq() });
    const pentry = (segment: string) => ins(c, 'cash_entries', { book: 'telecom', segment, business_date: D, type: 'purchase_refund', amount_cents: 100, ref_table: 'purchase_returns', ref_id: pret });
    expect(err(() => pentry('airtel_cards'))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => pentry('hutch_cards'))).toBe('');
  });
});

describe('reload / EZCash / top-up rows carry the segment derived from their provider (026)', () => {
  const provs = ['Dialog', 'Mobitel', 'Hutch', 'Airtel'] as const;
  it('reload sales: provider + _reloads, nothing else', () => {
    const c = fresh();
    for (const p of provs) {
      const own = `${p.toLowerCase()}_reloads`;
      for (const seg of RELOADS) {
        const m = err(() => MAKE.reload_sales!(c, { provider_id: providerId(c, p), segment: seg }));
        if (seg === own) expect(m, `${p} ${seg}`).toBe(''); else expect(m, `${p} ${seg}`).toMatch(/SEGMENT_MISMATCH/);
      }
    }
  });
  it('EZCash: Dialog Reloads only', () => {
    const c = fresh();
    for (const seg of RELOADS) {
      const m = err(() => MAKE.ezcash_sales!(c, { segment: seg }));
      if (seg === 'dialog_reloads') expect(m).toBe(''); else expect(m).toMatch(/SEGMENT_MISMATCH/);
    }
  });
  it('top-ups: a wallet top-up is Dialog Reloads; a provider top-up is its provider\'s Reloads', () => {
    const c = fresh();
    for (const seg of RELOADS) {
      const w = err(() => MAKE.telecom_topups!(c, { kind: 'wallet_topup', segment: seg }));
      if (seg === 'dialog_reloads') expect(w).toBe(''); else expect(w).toMatch(/SEGMENT_MISMATCH/);
      for (const p of provs) {
        const m = err(() => MAKE.telecom_topups!(c, { kind: 'provider_topup', provider_id: providerId(c, p), segment: seg }));
        if (seg === `${p.toLowerCase()}_reloads`) expect(m, `${p} ${seg}`).toBe(''); else expect(m, `${p} ${seg}`).toMatch(/SEGMENT_MISMATCH/);
      }
    }
  });
});

describe('category provider, v_product_segment and the product triggers (024)', () => {
  it('a provider only on a Telecom category (INSERT and UPDATE)', () => {
    const c = fresh();
    expect(err(() => category(c, 'S1', 'shop', 'Dialog'))).toMatch(/CATEGORY_PROVIDER_NOT_ALLOWED/);
    const shopCat = category(c, 'S2', 'shop');
    expect(err(() => c.prepare('UPDATE categories SET provider_id = ? WHERE id = ?').run(providerId(c, 'Dialog'), shopCat))).toMatch(/CATEGORY_PROVIDER_NOT_ALLOWED/);
    const telCat = category(c, 'T1', 'telecom');
    expect(err(() => c.prepare('UPDATE categories SET provider_id = ? WHERE id = ?').run(providerId(c, 'Hutch'), telCat))).toBe('');
    expect(one(c, 'SELECT provider_id FROM categories WHERE id = ?', telCat)).toBe(providerId(c, 'Hutch'));
    expect(err(() => c.prepare('UPDATE categories SET provider_id = NULL WHERE id = ?').run(telCat))).toBe(''); // still no products: free to change
    expect(err(() => c.prepare('UPDATE categories SET provider_id = 999 WHERE id = ?').run(telCat))).toMatch(/FOREIGN KEY/);
  });

  it('the default "Scratch Cards" category may be given a provider while it has no products, and is then locked once it has products', () => {
    const c = fresh();
    const sc = Number(one(c, "SELECT id FROM categories WHERE name = 'Scratch Cards'"));
    expect(err(() => c.prepare('UPDATE categories SET provider_id = ? WHERE id = ?').run(providerId(c, 'Dialog'), sc))).toBe('');
    product(c, { categoryId: sc, book: 'telecom' });
    expect(err(() => c.prepare('UPDATE categories SET provider_id = ? WHERE id = ?').run(providerId(c, 'Mobitel'), sc))).toMatch(/CATEGORY_PROVIDER_LOCKED/);
    expect(err(() => c.prepare('UPDATE categories SET provider_id = NULL WHERE id = ?').run(sc))).toMatch(/CATEGORY_PROVIDER_LOCKED/);
    expect(err(() => c.prepare('UPDATE categories SET provider_id = ? WHERE id = ?').run(providerId(c, 'Dialog'), sc))).toBe(''); // unchanged value: no change, no refusal
    expect(err(() => c.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(sc))).toBe('');
  });

  it('a new Telecom stock product needs a provider category; Shop products and service products are unaffected', () => {
    const c = fresh();
    const noProv = category(c, 'NoProv', 'telecom');
    expect(err(() => product(c, { categoryId: noProv, book: 'telecom' }))).toMatch(/PRODUCT_NEEDS_PROVIDER/);
    expect(err(() => product(c, { categoryId: noProv, book: 'telecom', kind: 'service' }))).toBe('');
    expect(err(() => product(c, { categoryId: category(c, 'P1', 'telecom', 'Airtel'), book: 'telecom' }))).toBe('');
    expect(err(() => product(c, { categoryId: category(c, 'ShopCat', 'shop'), book: 'shop' }))).toBe('');
    // a book mismatch keeps its own error
    expect(err(() => product(c, { categoryId: category(c, 'ShopCat2', 'shop'), book: 'telecom' }))).toMatch(/PRODUCT_BOOK_MISMATCH/);
  });

  it('v_product_segment: provider + _cards, legacy without provider, NULL outside Telecom', () => {
    const c = fresh();
    const legacyCat = category(c, 'Old', 'telecom');
    const legacy = ins(c, 'products', { name: 'old', category_id: legacyCat, kind: 'service', book: 'telecom', sell_price_cents: 1, min_price_cents: 1 });
    const seg = (p: number) => all(c, 'SELECT book, segment FROM v_product_segment WHERE product_id = ?', p)[0]!;
    for (const p of ['Dialog', 'Mobitel', 'Hutch', 'Airtel'] as const) expect(seg(cardProduct(c, p))).toEqual({ book: 'telecom', segment: `${p.toLowerCase()}_cards` });
    expect(seg(legacy)).toEqual({ book: 'telecom', segment: 'legacy' });
    expect(seg(shopProduct(c))).toEqual({ book: 'shop', segment: null });
    expect(one(c, 'SELECT COUNT(*) FROM v_product_segment')).toBe(one(c, 'SELECT COUNT(*) FROM products'));
  });

  it('a Telecom product with stock movements cannot move to a category of another provider; without history, or within a provider, it can', () => {
    const c = fresh();
    const dialogA = category(c, 'DA', 'telecom', 'Dialog');
    const dialogB = category(c, 'DB', 'telecom', 'Dialog');
    const airtel = category(c, 'AIR', 'telecom', 'Airtel');
    const noProv = category(c, 'NP', 'telecom');
    const withHistory = product(c, { categoryId: dialogA, book: 'telecom' });
    addStock(c, withHistory);
    const fresh1 = product(c, { categoryId: dialogA, book: 'telecom' });
    const move = (p: number, cat: number) => err(() => c.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(cat, p));
    expect(move(withHistory, airtel)).toMatch(/PRODUCT_SEGMENT_LOCKED/);
    expect(move(withHistory, noProv)).toMatch(/PRODUCT_SEGMENT_LOCKED/);
    expect(move(withHistory, dialogB)).toBe('');                 // same provider: same segment
    expect(move(fresh1, airtel)).toBe('');                       // no movements yet
    expect(one(c, 'SELECT category_id FROM products WHERE id = ?', fresh1)).toBe(airtel);
  });
});

describe('lines and stock losses carry the segment of their product (026)', () => {
  it('sale items: the product\'s segment must equal the sale\'s', () => {
    const c = fresh();
    const dialog = cardProduct(c, 'Dialog');
    const mobitel = cardProduct(c, 'Mobitel');
    const sale = MAKE.sales!(c, { book: 'telecom', segment: 'dialog_cards' });
    const item = (productId: number) => ins(c, 'sale_items', { sale_id: sale, line_no: Number(one(c, 'SELECT COUNT(*) + 1 FROM sale_items WHERE sale_id = ?', sale)), line_type: 'card', product_id: productId, description: 'x', qty: 1, unit_price_cents: 100, unit_cost_cents: 50, revenue_cents: 100, cogs_cents: 50 });
    expect(err(() => item(mobitel))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => item(dialog))).toBe('');
    // a Shop sale and a Shop product still match (NULL = NULL)
    const shop = MAKE.sales!(c);
    expect(err(() => ins(c, 'sale_items', { sale_id: shop, line_no: 1, line_type: 'goods', product_id: shopProduct(c), description: 'x', qty: 1, unit_price_cents: 100, unit_cost_cents: 50, revenue_cents: 100, cogs_cents: 50 }))).toBe('');
  });

  it('purchase items, stocktake items, stock losses and goods drawings', () => {
    const c = fresh();
    const dialog = cardProduct(c, 'Dialog');
    const mobitel = cardProduct(c, 'Mobitel');
    const pur = MAKE.purchases!(c, { book: 'telecom', segment: 'dialog_cards' });
    const pi = (p: number) => ins(c, 'purchase_items', { purchase_id: pur, product_id: p, packs: 1, pack_size: 1, units: 1, line_total_cents: 100 });
    expect(err(() => pi(mobitel))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => pi(dialog))).toBe('');

    const st = MAKE.stocktakes!(c, { book: 'telecom', segment: 'dialog_cards' });
    const si = (p: number) => ins(c, 'stocktake_items', { stocktake_id: st, product_id: p, counted_qty: 1 });
    expect(err(() => si(mobitel))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => si(dialog))).toBe('');

    const loss = (p: number, seg: string) => MAKE.stock_losses!(c, { book: 'telecom', product_id: p, segment: seg });
    expect(err(() => loss(mobitel, 'dialog_cards'))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => loss(dialog, 'mobitel_cards'))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => loss(dialog, 'dialog_cards'))).toBe('');

    const draw = (p: number, seg: string) => MAKE.owner_drawings!(c, { book: 'telecom', kind: 'goods', product_id: p, qty: 1, amount_cents: 0, segment: seg });
    expect(err(() => draw(mobitel, 'dialog_cards'))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => draw(dialog, 'dialog_cards'))).toBe('');
  });
});

describe('opening balance: one posted opening balance per scope (book + segment [+ fund])', () => {
  it('per segment for Telecom, per book for Shop, per fund for Ice Cream; a void frees the scope', () => {
    const c = fresh();
    const ob = (o: Record<string, string | number | null>) => MAKE.capital_entries!(c, { kind: 'opening_balance', ...o });
    expect(err(() => ob({ book: 'telecom', segment: 'dialog_reloads' }))).toBe('');
    expect(err(() => ob({ book: 'telecom', segment: 'dialog_reloads' }))).toMatch(/UNIQUE/);
    for (const s of SEGMENTS.filter((x) => x !== 'dialog_reloads')) expect(err(() => ob({ book: 'telecom', segment: s })), s).toBe('');
    expect(err(() => ob({ book: 'shop' }))).toBe('');
    expect(err(() => ob({ book: 'shop' }))).toMatch(/UNIQUE/);
    expect(err(() => ob({ book: 'icecream', fund: 'cost' }))).toBe('');
    expect(err(() => ob({ book: 'icecream', fund: 'cost' }))).toMatch(/UNIQUE/);
    expect(err(() => ob({ book: 'icecream', fund: 'profit' }))).toBe('');
    const id = Number(one(c, "SELECT id FROM capital_entries WHERE book = 'shop' AND kind = 'opening_balance'"));
    c.prepare("UPDATE capital_entries SET status = 'void', voided_at = '2025-03-11T00:00:00Z', void_reason = 'x' WHERE id = ?").run(id);
    expect(err(() => ob({ book: 'shop' }))).toBe('');
  });
});

describe('daily_closings: one closing per scope and day; legacy cannot be created; the segment is immutable; reopen still works', () => {
  it('unique per (book, segment, day); a different segment, book or day is fine', () => {
    const c = fresh();
    const cl = (o: Record<string, string | number | null>) => MAKE.daily_closings!(c, o);
    expect(err(() => cl({ book: 'telecom', segment: 'dialog_reloads' }))).toBe('');
    expect(err(() => cl({ book: 'telecom', segment: 'dialog_reloads' }))).toMatch(/UNIQUE/);
    expect(err(() => cl({ book: 'telecom', segment: 'dialog_cards' }))).toBe('');
    expect(err(() => cl({ book: 'telecom', segment: 'dialog_reloads', business_date: '2025-03-11' }))).toBe('');
    expect(err(() => cl({ book: 'shop' }))).toBe('');
    expect(err(() => cl({ book: 'shop' }))).toMatch(/UNIQUE/);
    expect(err(() => cl({ book: 'icecream' }))).toBe('');
    expect(err(() => cl({ book: 'icecream' }))).toMatch(/UNIQUE/);
    expect(err(() => cl({ book: 'telecom', segment: 'legacy' }))).toMatch(/SEGMENT_LEGACY_REFUSED/);
  });

  it('reopen and re-close (the 019 rules) work per segment row', () => {
    const c = fresh();
    const id = MAKE.daily_closings!(c, { book: 'telecom', segment: 'airtel_cards' });
    const closedAt = String(one(c, 'SELECT closed_at FROM daily_closings WHERE id = ?', id));
    c.prepare("UPDATE daily_closings SET reopened_at = ?, reopen_reason = 'late sale' WHERE id = ?").run(closedAt, id);
    c.prepare("UPDATE daily_closings SET closed_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    expect(one(c, 'SELECT segment FROM daily_closings WHERE id = ?', id)).toBe('airtel_cards');
    expect(err(() => c.prepare("UPDATE daily_closings SET segment = 'airtel_reloads' WHERE id = ?").run(id))).toMatch(/SEGMENT_READ_ONLY|DAILY_CLOSING_IMMUTABLE/);
  });
});

describe('legacy rows (frozen schema-23 database upgraded): follow-ups of legacy records stay legacy, fresh legacy rows are refused', () => {
  const upgraded = (): DatabaseSync => {
    const dir = env.newDir();
    const file = join(dir, 'legacy.db');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.db'), file);
    const c = new DatabaseSync(file);
    dbs.push(c);
    migrate(c);
    // reopen the legacy closing so the old days accept follow-up entries
    c.exec("UPDATE daily_closings SET reopened_at = closed_at, reopen_reason = 'test reopen' WHERE book = 'telecom'");
    return c;
  };

  it('a reversal of a legacy entry is allowed (and stays legacy); any other legacy cash entry is refused; reversing into another segment is refused', () => {
    const c = upgraded();
    const orig = all(c, "SELECT * FROM cash_entries WHERE book = 'telecom' AND segment = 'legacy' AND reverses_entry_id IS NULL AND ref_table = 'expenses' AND id NOT IN (SELECT reverses_entry_id FROM cash_entries WHERE reverses_entry_id IS NOT NULL) ORDER BY id")[0]!;
    expect(orig, 'the fixture has a Telecom expense entry').toBeTruthy();
    const rev = (segment: string | null) => ins(c, 'cash_entries', { book: 'telecom', segment, business_date: orig.business_date, type: orig.type, amount_cents: -Number(orig.amount_cents), reverses_entry_id: orig.id, ref_table: orig.ref_table, ref_id: orig.ref_id });
    expect(err(() => rev('dialog_reloads'))).toMatch(/REVERSAL_MISMATCH/);
    expect(err(() => rev(null))).toMatch(/SEGMENT_REQUIRED|REVERSAL_MISMATCH/);
    expect(err(() => rev('legacy'))).toBe('');
    // a brand new legacy entry (no legacy original) is refused
    expect(err(() => ins(c, 'cash_entries', { book: 'telecom', segment: 'legacy', business_date: D, type: 'cash_adjustment', amount_cents: 1 }))).toMatch(/SEGMENT_LEGACY_REFUSED/);
    // a reversal of a NON-legacy original cannot claim legacy
    const live = ins(c, 'cash_entries', { book: 'telecom', segment: 'dialog_reloads', business_date: '2025-09-14', type: 'cash_adjustment', amount_cents: 5 });
    expect(err(() => ins(c, 'cash_entries', { book: 'telecom', segment: 'legacy', business_date: '2025-09-14', type: 'cash_adjustment', amount_cents: -5, reverses_entry_id: live }))).toMatch(/SEGMENT_LEGACY_REFUSED|REVERSAL_MISMATCH/);
  });

  it('a return of a legacy sale (refund entry, damaged-return loss) stays legacy; no other record kind can be legacy', () => {
    const c = upgraded();
    const sale = all(c, "SELECT s.id, s.business_date FROM sales s WHERE s.book = 'telecom' AND s.segment = 'legacy' AND s.status = 'posted' ORDER BY s.id")[0]!;
    const ret = ins(c, 'sales_returns', { sale_id: sale.id, business_date: '2025-09-14', refund_cents: 100, cogs_reversed_cents: 0, client_ref: uniq() });
    const refund = (segment: string) => ins(c, 'cash_entries', { book: 'telecom', segment, business_date: '2025-09-14', type: 'card_refund', amount_cents: -100, ref_table: 'sales_returns', ref_id: ret });
    expect(err(() => refund('dialog_cards'))).toMatch(/SEGMENT_MISMATCH/);
    expect(err(() => refund('legacy'))).toBe('');
    // damaged-return loss of the legacy sale: legacy allowed only with source damaged_return + link
    const prod = Number(one(c, 'SELECT product_id FROM sale_items WHERE sale_id = ? LIMIT 1', Number(sale.id)));
    const loss = (o: Record<string, string | number | null>) => ins(c, 'stock_losses', { business_date: '2025-09-14', product_id: prod, book: 'telecom', segment: 'legacy', qty: 1, cost_cents: 10, reason: 'damaged', client_ref: uniq(), ...o });
    expect(err(() => loss({}))).toMatch(/SEGMENT_LEGACY_REFUSED/);
    expect(err(() => loss({ source: 'damaged_return', sales_return_id: ret }))).toBe('');
    for (const t of ['expenses', 'capital_entries', 'owner_drawings', 'cash_counts', 'purchases', 'stocktakes', 'sales', 'daily_closings'])
      expect(err(() => MAKE[t]!(c, telecomRow(c, t, 'legacy'))), t).toMatch(/SEGMENT_LEGACY_REFUSED/);
  });

  it('a legacy record can be voided (status flip): its reversal entries stay legacy', () => {
    const c = upgraded();
    const sale = all(c, "SELECT id FROM sales WHERE book = 'telecom' AND segment = 'legacy' AND status = 'posted' AND id NOT IN (SELECT sale_id FROM sales_returns) ORDER BY id")[0]!;
    const entries = all(c, "SELECT * FROM cash_entries WHERE ref_table = 'sales' AND ref_id = ? AND reverses_entry_id IS NULL", Number(sale.id));
    for (const e of entries) ins(c, 'cash_entries', { book: 'telecom', segment: 'legacy', business_date: e.business_date, type: e.type, amount_cents: -Number(e.amount_cents), reverses_entry_id: e.id, ref_table: 'sales', ref_id: sale.id });
    const rev = all(c, 'SELECT segment FROM cash_entries WHERE ref_table = ? AND ref_id = ? AND reverses_entry_id IS NOT NULL', 'sales', Number(sale.id));
    expect(rev.length).toBe(entries.length);
    expect(rev.every((r) => r.segment === 'legacy')).toBe(true);
  });
});

describe('legacy products (frozen fixture): they keep their stock but cannot change segment', () => {
  it('a provider-less Telecom product with history is legacy: it cannot be moved into a provider category and no new product can join its category', () => {
    const dir = env.newDir();
    const file = join(dir, 'legacy.db');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.db'), file);
    const c = new DatabaseSync(file);
    dbs.push(c);
    migrate(c);
    const p = all(c, "SELECT p.id, p.category_id FROM products p WHERE p.book = 'telecom' AND p.kind = 'stock' ORDER BY p.id")[0]!;
    expect(all(c, 'SELECT segment FROM v_product_segment WHERE product_id = ?', Number(p.id))[0]!.segment).toBe('legacy');
    const prov = category(c, 'Dialog cards', 'telecom', 'Dialog');
    expect(err(() => c.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(prov, Number(p.id)))).toMatch(/PRODUCT_SEGMENT_LOCKED/);
    expect(err(() => product(c, { categoryId: Number(p.category_id), book: 'telecom' }))).toMatch(/PRODUCT_NEEDS_PROVIDER/);
    // the category still has products: it can no longer get a provider
    expect(err(() => c.prepare('UPDATE categories SET provider_id = ? WHERE id = ?').run(providerId(c, 'Dialog'), Number(p.category_id)))).toMatch(/CATEGORY_PROVIDER_LOCKED/);
  });
});

describe('EXPLAIN QUERY PLAN: the closed-day probe is answered by the (book, segment, business_date) index', () => {
  const plan = (c: DatabaseSync, sql: string, ...p: Array<string | number | null>): string =>
    (c.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as unknown as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
  const PROBE = "SELECT 1 FROM daily_closings d WHERE d.book = ? AND d.segment IS ? AND d.business_date >= ? AND (d.reopened_at IS NULL OR d.closed_at > d.reopened_at)";

  it('a Telecom probe, a Shop probe (segment IS NULL) and the equality probe all SEARCH by index, never SCAN', () => {
    const c = fresh();
    for (const seg of [null, 'dialog_cards']) {
      const p = plan(c, PROBE, seg === null ? 'shop' : 'telecom', seg, D);
      expect(p, p).toMatch(/SEARCH d USING (COVERING )?INDEX idx_daily_closings_book_segment_date/);
      expect(p).not.toMatch(/SCAN/);
    }
    const eq = plan(c, "SELECT 1 FROM daily_closings d WHERE d.book = 'telecom' AND d.segment IS 'dialog_cards' AND d.business_date = '2025-01-01'");
    expect(eq).toMatch(/SEARCH d USING (COVERING )?INDEX/);
  });

  it('the probe inside a real closed-day trigger is indexed too (insert of an expense with closings present stays fast)', () => {
    const c = fresh();
    for (const s of SEGMENTS) MAKE.daily_closings!(c, { book: 'telecom', segment: s, business_date: '2025-01-01' });
    MAKE.daily_closings!(c, { book: 'shop', business_date: '2025-01-01' });
    const t0 = Date.now();
    c.exec('BEGIN');
    const st = c.prepare("INSERT INTO expenses (business_date, book, segment, category, amount_cents, description, client_ref) VALUES ('2025-06-01', 'telecom', ?, 'other', 1, 'x', ?)");
    for (let i = 0; i < 6000; i++) st.run(SEGMENTS[i % 8]!, `perf-${i}`);
    c.exec('COMMIT');
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(one(c, 'SELECT COUNT(*) FROM expenses')).toBe(6000);
  }, 30000);
});

describe('the new objects exist exactly once and the view is queryable', () => {
  it('migration version, view and indexes', () => {
    const c = fresh();
    expect(one(c, 'SELECT MAX(version) FROM schema_migrations')).toBeGreaterThanOrEqual(26);
    expect(one(c, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'view'")).toBe(1);
    for (const i of ['idx_categories_provider', 'idx_cash_entries_book_segment_date', 'ux_daily_closings_scope_date', 'idx_daily_closings_book_date', 'idx_daily_closings_book_segment_date', 'ux_sales_client_ref_scope', 'ux_capital_opening_balance'])
      expect(one(c, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?", i), i).toBe(1);
    // client_ref idempotency key is unique per scope: the same ref may exist once per segment (one cart, several sales) but not twice in one scope
    expect(err(() => MAKE.sales!(c, { book: 'telecom', segment: 'dialog_cards', client_ref: 'cart-1' }))).toBe('');
    expect(err(() => MAKE.sales!(c, { book: 'telecom', segment: 'mobitel_cards', client_ref: 'cart-1' }))).toBe('');
    expect(err(() => MAKE.sales!(c, { book: 'telecom', segment: 'dialog_cards', client_ref: 'cart-1' }))).toMatch(/UNIQUE/);
    expect(err(() => MAKE.sales!(c, { book: 'shop', client_ref: 'cart-1' }))).toBe('');
    expect(err(() => MAKE.sales!(c, { book: 'shop', client_ref: 'cart-1' }))).toMatch(/UNIQUE/);
  });
});
