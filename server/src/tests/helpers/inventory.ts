import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { migrate } from '../../db/migrate.ts';
import { catIds, get, post } from './catalog.ts';

/** In-memory migrated database (foreign keys on) for engine / SQL-level tests. */
export function memDb(track: DatabaseSync[]): DatabaseSync {
  const c = new DatabaseSync(':memory:');
  c.exec('PRAGMA foreign_keys = ON');
  track.push(c);
  migrate(c);
  return c;
}

const catId = (c: DatabaseSync, name: string): number =>
  Number((c.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number | bigint }).id);

let seq = 0;
/** Creates a product by raw SQL (stock by default; shop unless book='telecom'). */
export function sqlProduct(
  c: DatabaseSync, p: { name?: string; kind?: 'stock' | 'service'; book?: 'shop' | 'telecom'; active?: number } = {},
): number {
  const book = p.book ?? 'shop';
  const cat = catId(c, book === 'shop' ? 'Other' : 'Scratch Cards');
  return Number(c.prepare(
    `INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents, active)
     VALUES (?, ?, ?, ?, 100000, 50000, ?)`,
  ).run(p.name ?? `SQLP${seq++}`, cat, p.kind ?? 'stock', book, p.active ?? 1).lastInsertRowid);
}

export function pool(c: DatabaseSync, id: number): { qty: number; value: number } {
  const r = c.prepare('SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?')
    .get(id) as unknown as { q: number | bigint; v: number | bigint };
  return { qty: Number(r.q), value: Number(r.v) };
}

export interface Mv {
  id: number; type: string; qty: number; value: number; unit: number | null; date: string;
  refTable: string | null; refId: number | null;
}
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

export function scalar(c: DatabaseSync, sql: string, ...params: any[]): number {
  const r = c.prepare(sql).get(...params) as unknown as Record<string, number | bigint>;
  return Number(Object.values(r)[0]);
}

export function errOf(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected throw');
}
export const msgOf = (fn: () => unknown): string => (errOf(fn) as Error).message;

// ---------- API-level helpers ----------

export interface ApiBase { app: FastifyInstance; ctx: AppContext; ids: Record<string, number> }

export async function apiBase(b: { app: FastifyInstance; ctx: AppContext }): Promise<ApiBase> {
  return { app: b.app, ctx: b.ctx, ids: await catIds(b.app) };
}

let pseq = 0;
export async function mkProduct(s: ApiBase, over: Record<string, unknown> = {}): Promise<any> {
  const r = await post(s.app, '/products', {
    name: `Item ${pseq++}`, categoryId: s.ids.Electronics, kind: 'stock', sellPriceCents: 100000, minPriceCents: 50000, ...over,
  });
  if (r.status !== 201) throw new Error(`product create failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}
export const mkTelecom = (s: ApiBase, over: Record<string, unknown> = {}) =>
  mkProduct(s, { categoryId: s.ids['Scratch Cards'], ...over });

export async function mkSupplier(s: ApiBase, name = `Sup ${pseq++}`): Promise<any> {
  const r = await post(s.app, '/suppliers', { name });
  if (r.status !== 201) throw new Error(`supplier create failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}

let rseq = 0;
export const ref = (): string => `ref-${Date.now()}-${rseq++}-${Math.random().toString(36).slice(2, 8)}`;

export function today(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
export function daysAgo(n: number): string {
  return new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);
}
export function daysAhead(n: number): string {
  return daysAgo(-n);
}

export async function buy(
  s: ApiBase, items: Array<{ productId: number; packs: number; packSize: number; lineTotalCents: number }>,
  over: Record<string, unknown> = {},
): Promise<any> {
  const r = await post(s.app, '/purchases', { businessDate: today(), items, clientRef: ref(), ...over });
  if (r.status !== 201) throw new Error(`purchase failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
}

export async function productOf(s: ApiBase, id: number): Promise<any> {
  return (await get(s.app, `/products/${id}`)).body.item;
}

export function cashRows(ctx: AppContext, where = '1=1'): Array<Record<string, any>> {
  return ctx.database.conn.prepare(`SELECT * FROM cash_entries WHERE ${where} ORDER BY id`).all() as unknown as Array<Record<string, any>>;
}
