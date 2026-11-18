// Raw-SQL helpers for the Telecom-segment DATABASE tests (phase26-segment-db / phase26-segment-closedday / phase26-segment-migration).
// They never go through a service: every row is inserted with plain SQL so each trigger of migrations 024-026 is exercised on its own.
// (Package B owns helpers/*; this is a new file of package A and is not used by any other test.)

import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../db/migrate.ts';

export const SEGMENTS = ['dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads'] as const;
export const CARDS = SEGMENTS.filter((s) => s.endsWith('_cards'));
export const RELOADS = SEGMENTS.filter((s) => s.endsWith('_reloads'));

/** A new in-memory database with every migration applied (foreign keys ON, as in the program). */
export function freshDb(): DatabaseSync {
  const c = new DatabaseSync(':memory:');
  migrate(c);
  return c;
}

export const D = '2025-03-10';
let seq = 0;
export const uniq = (p = 'r'): string => `${p}-${++seq}`;

type Row = Record<string, string | number | null>;

/** INSERT INTO table (...) VALUES (...) from an object; returns the new rowid. */
export function ins(c: DatabaseSync, table: string, row: Row): number {
  const cols = Object.keys(row);
  const r = c.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as Array<string | number | null>));
  return Number(r.lastInsertRowid);
}

/** The error message of a statement that must fail ('' when it did NOT fail). */
export function err(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

export const all = (c: DatabaseSync, sql: string, ...p: Array<string | number | null>): Array<Record<string, any>> => c.prepare(sql).all(...p) as unknown as Array<Record<string, any>>;
export const one = (c: DatabaseSync, sql: string, ...p: Array<string | number | null>): any => Object.values(all(c, sql, ...p)[0] ?? {})[0];

export const providerId = (c: DatabaseSync, name: 'Dialog' | 'Mobitel' | 'Hutch' | 'Airtel'): number => Number(one(c, 'SELECT id FROM reload_providers WHERE name = ?', name));
export const providerOf = (segment: string): 'Dialog' | 'Mobitel' | 'Hutch' | 'Airtel' =>
  ({ dialog: 'Dialog', mobitel: 'Mobitel', airtel: 'Airtel', hutch: 'Hutch' } as const)[segment.split('_')[0] as 'dialog'] ?? 'Dialog';

export function category(c: DatabaseSync, name: string, book: 'shop' | 'telecom', provider: 'Dialog' | 'Mobitel' | 'Hutch' | 'Airtel' | null = null): number {
  return ins(c, 'categories', { name, book, provider_id: provider ? providerId(c, provider) : null });
}

/** A stock product; for Telecom the category must carry a provider (migration 024). */
export function product(c: DatabaseSync, o: { name?: string; categoryId: number; book: 'shop' | 'telecom'; kind?: 'stock' | 'service' }): number {
  return ins(c, 'products', { name: o.name ?? uniq('p'), category_id: o.categoryId, kind: o.kind ?? 'stock', book: o.book, sell_price_cents: 1000, min_price_cents: 100 });
}

/** Puts stock into a product with an 'opening' movement (so the product has history). */
export function addStock(c: DatabaseSync, productId: number, qty = 10, value = 5000, date = '2025-01-01'): number {
  return ins(c, 'stock_movements', { product_id: productId, business_date: date, type: 'opening', qty_delta: qty, value_delta_cents: value, unit_cost_cents: Math.round(value / qty), reason: 'test' });
}

/** A Telecom card product of a provider (its own provider category). */
export function cardProduct(c: DatabaseSync, provider: 'Dialog' | 'Mobitel' | 'Hutch' | 'Airtel', stock = true): number {
  const cat = category(c, uniq(`${provider}-crds`), 'telecom', provider);
  const p = product(c, { categoryId: cat, book: 'telecom' });
  if (stock) addStock(c, p);
  return p;
}
export function shopProduct(c: DatabaseSync, stock = true): number {
  const cat = category(c, uniq('shopcat'), 'shop');
  const p = product(c, { categoryId: cat, book: 'shop' });
  if (stock) addStock(c, p);
  return p;
}

// ---- one constructor per table: complete valid rows (overrides win) ----------------------------------------------------------------
export type Maker = (c: DatabaseSync, o?: Row) => number;
const withDefaults = (table: string, base: (c: DatabaseSync, o: Row) => Row): Maker => (c, o = {}) => ins(c, table, { ...base(c, o), ...o });

export const MAKE: Record<string, Maker> = {
  cash_entries: withDefaults('cash_entries', () => ({ book: 'shop', business_date: D, type: 'cash_adjustment', amount_cents: 100 })),
  cash_counts: withDefaults('cash_counts', () => ({ book: 'shop', business_date: D, expected_cents: 0, counted_cents: 0, difference_cents: 0, client_ref: uniq() })),
  capital_entries: withDefaults('capital_entries', () => ({ book: 'shop', business_date: D, kind: 'capital', amount_cents: 100, client_ref: uniq() })),
  owner_drawings: withDefaults('owner_drawings', () => ({ book: 'shop', business_date: D, kind: 'cash', amount_cents: 100, client_ref: uniq() })),
  expenses: withDefaults('expenses', () => ({ book: 'shop', business_date: D, category: 'other', amount_cents: 100, description: 'x', client_ref: uniq() })),
  purchases: withDefaults('purchases', () => ({ book: 'shop', business_date: D, total_cents: 100, client_ref: uniq() })),
  stock_losses: withDefaults('stock_losses', (c, o) => ({ book: 'shop', business_date: D, product_id: o.product_id ?? shopProduct(c), qty: 1, cost_cents: 100, reason: 'lost', client_ref: uniq() })),
  stocktakes: withDefaults('stocktakes', () => ({ book: 'shop', business_date: D, status: 'draft', client_ref: uniq() })),
  reload_sales: withDefaults('reload_sales', (c) => ({ business_date: D, provider_id: providerId(c, 'Dialog'), sales_cents: 10000, commission_bp: 600, extra_cents: 0, commission_cents: 600, client_ref: uniq() })),
  ezcash_sales: withDefaults('ezcash_sales', (c) => ({ business_date: D, provider_id: providerId(c, 'Dialog'), bill_total_cents: 10000, commission_bp: 80, commission_cents: 80, client_ref: uniq() })),
  telecom_topups: withDefaults('telecom_topups', () => ({ business_date: D, kind: 'wallet_topup', amount_cents: 100, client_ref: uniq() })),
  sales: withDefaults('sales', () => ({ book: 'shop', business_date: D, total_cents: 100, client_ref: uniq() })),
  cash_transfers: withDefaults('cash_transfers', () => ({ business_date: D, from_book: 'shop', to_book: 'icecream', to_fund: 'cost', amount_cents: 100, client_ref: uniq() })),
  daily_closings: withDefaults('daily_closings', () => ({ book: 'shop', business_date: D, expected_cents: 0 })),
};

/** The valid segment for a Telecom row of each table (the domain of its column). */
export const TELECOM_SEGMENT_OF: Record<string, string> = {
  cash_entries: 'dialog_reloads', cash_counts: 'dialog_reloads', capital_entries: 'dialog_reloads', owner_drawings: 'dialog_reloads',
  expenses: 'dialog_reloads', daily_closings: 'dialog_reloads',
  purchases: 'dialog_cards', stock_losses: 'dialog_cards', stocktakes: 'dialog_cards', sales: 'dialog_cards',
  reload_sales: 'dialog_reloads', ezcash_sales: 'dialog_reloads', telecom_topups: 'dialog_reloads',
};
/** Tables with a `book` column whose rows may belong to Telecom. */
export const BOOK_TABLES = ['cash_entries', 'cash_counts', 'capital_entries', 'owner_drawings', 'expenses', 'purchases', 'stock_losses', 'stocktakes', 'sales', 'daily_closings'] as const;
/** Tables that are Telecom-only and have no book column. */
export const TELECOM_ONLY_TABLES = ['reload_sales', 'ezcash_sales', 'telecom_topups'] as const;
/** The row overrides that make a Telecom row of the table (book + product/provider/fund details where the other triggers need them). */
export function telecomRow(c: DatabaseSync, table: string, segment: string | null): Row {
  const o: Row = { segment };
  if ((BOOK_TABLES as readonly string[]).includes(table)) o.book = 'telecom';
  if (table === 'stock_losses') o.product_id = cardProduct(c, providerOf(segment ?? 'dialog_cards'));
  if (table === 'reload_sales' || table === 'telecom_topups') {
    if (table === 'reload_sales') o.provider_id = providerId(c, providerOf(segment ?? 'dialog_reloads'));
  }
  return o;
}
