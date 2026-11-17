// Helpers for inventory / purchasing tests, in two layers:
// 1. Database level (memDb, sqlProduct, pool, movements, scalar, errOf): an in-memory migrated SQLite database and
//    raw SQL, used to test the stock engine (weighted average, R4) without HTTP.
// 2. API level (apiBase, mkProduct, buy, ...): create products/suppliers/purchases through the real endpoints.
// Tests read the pool and the movement ledger directly, so they can compare "the cache" with "the ledger"
// (BUSINESS_RULES section 3: SUM(movements) must equal qty_on_hand / stock_value_cents).

import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { migrate } from '../../db/migrate.ts';
import { catIds, get, post, put } from './catalog.ts';
import { makeProviderCategory, providerIdByName } from './segments.ts';
import type { ProviderName } from './segments.ts';

/**
 * In-memory migrated database (foreign keys on) for engine / SQL-level tests.
 * Why: engine tests need the real schema (CHECK constraints, seeded categories) but no files or HTTP.
 * @param track list the test keeps so afterEach can close every connection
 * @returns a fully migrated connection
 */
export function memDb(track: DatabaseSync[]): DatabaseSync {
  const c = new DatabaseSync(':memory:');
  c.exec('PRAGMA foreign_keys = ON');
  track.push(c);
  migrate(c);
  return c;
}

// Looks up a seeded category id by name (raw SQL helper for sqlProduct).
const catId = (c: DatabaseSync, name: string): number =>
  Number((c.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number | bigint }).id);

// Counter that gives every SQL-created product a unique default name (product names must be unique).
let seq = 0;
/**
 * Creates a product by raw SQL (stock by default; shop unless book='telecom').
 * Shop products go in the "Other" category, telecom ones in "Scratch Cards" (the book follows the category).
 * Prices are fixed (sell Rs 1,000, minimum Rs 500) because engine tests only care about stock and cost.
 * @param c database connection
 * @param p optional name, kind (stock/service), book and active flag
 * @returns the new product id
 */
export function sqlProduct(
  c: DatabaseSync, p: { name?: string; kind?: 'stock' | 'service'; book?: 'shop' | 'telecom'; active?: number; provider?: ProviderName } = {},
): number {
  const book = p.book ?? 'shop';
  // Telecom stock products need a provider category (migration 024, PRODUCT_NEEDS_PROVIDER): the default "Scratch Cards" category
  // is linked to Dialog while it still has no products, or the product goes into its own "<provider> Cards" category (`provider`).
  if (book === 'telecom' && p.provider !== undefined) return sqlCardProduct(c, p.provider, p);
  if (book === 'telecom') {
    c.exec(`UPDATE categories SET provider_id = (SELECT id FROM reload_providers WHERE name = 'Dialog')
             WHERE name = 'Scratch Cards' AND book = 'telecom' AND provider_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM products WHERE category_id = categories.id)`);
  }
  const cat = catId(c, book === 'shop' ? 'Other' : 'Scratch Cards');
  return Number(c.prepare(
    `INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents, active)
     VALUES (?, ?, ?, ?, 100000, 50000, ?)`,
  ).run(p.name ?? `SQLP${seq++}`, cat, p.kind ?? 'stock', book, p.active ?? 1).lastInsertRowid);
}

/**
 * Raw-SQL Telecom card product in the "<provider> Cards" category of a provider (created and linked by SQL when missing), i.e. a
 * product of the segment `<provider>_cards`.
 */
export function sqlCardProduct(
  c: DatabaseSync, provider: ProviderName, p: { name?: string; kind?: 'stock' | 'service'; active?: number } = {},
): number {
  const catName = `${provider} Cards`;
  const providerId = Number((c.prepare('SELECT id FROM reload_providers WHERE name = ?').get(provider) as { id: number | bigint }).id);
  let cat = (c.prepare("SELECT id FROM categories WHERE name = ? AND book = 'telecom'").get(catName) as { id: number | bigint } | undefined)?.id;
  if (cat === undefined) cat = c.prepare("INSERT INTO categories (name, book, provider_id) VALUES (?, 'telecom', ?)").run(catName, providerId).lastInsertRowid;
  return Number(c.prepare(
    `INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents, active)
     VALUES (?, ?, ?, 'telecom', 100000, 50000, ?)`,
  ).run(p.name ?? `SQLP${seq++}`, cat, p.kind ?? 'stock', p.active ?? 1).lastInsertRowid);
}

/**
 * Reads a product's stock cache: quantity on hand and stock value in cents (the pool the average is built from).
 * @param c database connection
 * @param id product id
 * @returns { qty, value } as plain numbers
 */
export function pool(c: DatabaseSync, id: number): { qty: number; value: number } {
  const r = c.prepare('SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?')
    .get(id) as unknown as { q: number | bigint; v: number | bigint };
  return { qty: Number(r.q), value: Number(r.v) };
}

/**
 * A stock_movements row in friendly form: qty = quantity change, value = value change in cents, unit = unit cost
 * snapshot (null for value-only adjustments), date = business date, refTable/refId = the document that caused it.
 */
export interface Mv {
  id: number; type: string; qty: number; value: number; unit: number | null; date: string;
  refTable: string | null; refId: number | null;
}
/**
 * Reads the stock ledger, oldest first.
 * @param c database connection
 * @param productId optional; omit to read every product's movements
 * @returns movements in id (posting) order - posting order matters for weighted-average costing
 */
export function movements(c: DatabaseSync, productId?: number): Mv[] {
  const rows = (productId === undefined
    ? c.prepare('SELECT * FROM stock_movements ORDER BY id').all()
    : c.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id').all(productId)) as unknown as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: Number(r.id), type: r.type, qty: Number(r.qty_delta), value: Number(r.value_delta_cents),
    unit: r.unit_cost_cents === null ? null : Number(r.unit_cost_cents), date: r.business_date,
    refTable: r.ref_table, refId: r.ref_id === null ? null : Number(r.ref_id),
  }));
}

/**
 * Runs a query that returns one row and gives back its first column as a number (e.g. a COUNT or SUM).
 * @param c database connection
 * @param sql the query text
 * @param params bound parameters
 */
export function scalar(c: DatabaseSync, sql: string, ...params: any[]): number {
  const r = c.prepare(sql).get(...params) as unknown as Record<string, number | bigint>;
  return Number(Object.values(r)[0]);
}

/**
 * Runs fn and returns the error it throws; fails the test if nothing is thrown.
 * Why: lets a test assert on code/statusCode/extra fields of an AppError without try/catch noise.
 */
export function errOf(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected throw');
}
/**
 * Like errOf but returns just the error message text.
 */
export const msgOf = (fn: () => unknown): string => (errOf(fn) as Error).message;

// The next helpers go through the real HTTP routes, so they also exercise validation and audit.
// ---------- API-level helpers ----------

/**
 * The common test context for API tests: the app, its database context and the seeded category ids by name.
 */
export interface ApiBase { app: FastifyInstance; ctx: AppContext; ids: Record<string, number> }

/**
 * Builds an ApiBase from a freshly built app (TestEnv.build) by fetching the category ids once.
 */
export async function apiBase(b: { app: FastifyInstance; ctx: AppContext }): Promise<ApiBase> {
  return { app: b.app, ctx: b.ctx, ids: await catIds(b.app) };
}

// Counter for unique default product/supplier names.
let pseq = 0;
/**
 * Creates a product through POST /products and returns the created item.
 * Defaults: Electronics category, stock item, sells for Rs 1,000.00 (100000 cents), minimum price Rs 500.00.
 * @param s the ApiBase
 * @param over fields to override (name, categoryId, kind, prices, reorderLevel ...)
 * @throws if the API does not answer 201, so a broken setup fails loudly instead of confusing later asserts
 */
export async function mkProduct(s: ApiBase, over: Record<string, unknown> = {}): Promise<any> {
  const r = await post(s.app, '/products', {
    name: `Item ${pseq++}`, categoryId: s.ids.Electronics, kind: 'stock', sellPriceCents: 100000, minPriceCents: 50000, ...over,
  });
  if (r.status !== 201) throw new Error(`product create failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}
/**
 * Creates a Telecom card product (book is derived from the category, 13D: the segment from the category's provider).
 * Defaults: the default "Scratch Cards" category, which is linked to Dialog on first use (allowed while it has no products), so
 * the product is in `dialog_cards`. `over.provider` ('Dialog' | 'Mobitel' | 'Airtel' | 'Hutch') puts it in that provider's own
 * "<Provider> Cards" category instead (see `cardProduct`); an explicit `over.categoryId` is used as given.
 */
export async function mkTelecom(s: ApiBase, over: Record<string, unknown> = {}): Promise<any> {
  const { provider, ...fields } = over as { provider?: ProviderName } & Record<string, unknown>;
  if (provider !== undefined) return cardProduct(s, { provider, ...fields });
  if (fields.categoryId === undefined || fields.categoryId === s.ids['Scratch Cards']) {
    const scratch = s.ids['Scratch Cards']!;
    const dialog = (await providerIdByName(s.app)).Dialog;
    const cat = (await get(s.app, '/categories?book=telecom')).body.items.find((c: any) => c.id === scratch);
    if (cat && cat.providerId === null) await put(s.app, `/categories/${scratch}`, { providerId: dialog }); // refused (locked) only if it already holds products
  }
  return mkProduct(s, { categoryId: s.ids['Scratch Cards'], ...fields });
}

/**
 * Creates a Telecom card product in the Cards category of a provider (default Dialog): the category "<Provider> Cards" is created
 * and linked to the provider through the API when missing (`makeProviderCategory`). The product belongs to `<provider>_cards`.
 * Other fields (name, prices, reorderLevel ...) are passed to POST /products; `categoryId` overrides the category.
 */
export async function cardProduct(s: ApiBase, over: Record<string, unknown> & { provider?: ProviderName } = {}): Promise<any> {
  const { provider = 'Dialog', ...fields } = over;
  const categoryId = fields.categoryId ?? (await makeProviderCategory(s.app, provider)).id;
  return mkProduct(s, { ...fields, categoryId });
}

/**
 * Creates a supplier through POST /suppliers and returns it (throws unless 201).
 */
export async function mkSupplier(s: ApiBase, name = `Sup ${pseq++}`): Promise<any> {
  const r = await post(s.app, '/suppliers', { name });
  if (r.status !== 201) throw new Error(`supplier create failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}

// Counter that keeps every generated clientRef unique within one test run.
let rseq = 0;
/**
 * Makes a unique clientRef. Why: clientRef is the duplicate-submission guard (BUSINESS_RULES section 12); a
 * new value means "a new business action", the same value twice means "the user double-clicked".
 */
export const ref = (): string => `ref-${Date.now()}-${rseq++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Today's business date as YYYY-MM-DD in Asia/Colombo (UTC+5:30), computed independently of the server code
 * (now + 330 minutes). Tests use it so "today" matches R-FD even between 18:30 and 24:00 UTC.
 */
export function today(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
/**
 * A past business date n days before today (Colombo). Used for backdated entries and R-RD ordering tests.
 */
export function daysAgo(n: number): string {
  return new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);
}
/**
 * A future business date n days after today; used to prove R-FD (future-dated entries are rejected).
 */
export function daysAhead(n: number): string {
  return daysAgo(-n);
}

/**
 * Posts a purchase through the API and returns the created purchase (throws unless 201).
 * @param s the ApiBase
 * @param items purchase lines: packs x packSize = units, lineTotalCents = exact cost of the whole line
 * @param over extra/overriding request fields (businessDate, supplierId, paidCents ...); by default dated today with a fresh clientRef
 */
export async function buy(
  s: ApiBase, items: Array<{ productId: number; packs: number; packSize: number; lineTotalCents: number }>,
  over: Record<string, unknown> = {},
): Promise<any> {
  const r = await post(s.app, '/purchases', { businessDate: today(), items, clientRef: ref(), ...over });
  if (r.status !== 201) throw new Error(`purchase failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
}

/**
 * Reads a product back through GET /products/:id so tests see qty/value exactly as the API reports them.
 */
export async function productOf(s: ApiBase, id: number): Promise<any> {
  return (await get(s.app, `/products/${id}`)).body.item;
}

/**
 * Reads cash_entries rows straight from the database (oldest first), with an optional SQL WHERE.
 * Why: cash is the owner's most sensitive number; tests check the exact ledger rows, not just a total.
 * @param where trusted SQL condition from the test, default every row
 */
export function cashRows(ctx: AppContext, where = '1=1'): Array<Record<string, any>> {
  return ctx.database.conn.prepare(`SELECT * FROM cash_entries WHERE ${where} ORDER BY id`).all() as unknown as Array<Record<string, any>>;
}
