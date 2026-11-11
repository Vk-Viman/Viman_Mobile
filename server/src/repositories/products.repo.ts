/**
 * repositories/products.repo.ts - SQL for the `products` table (everything the shop sells).
 *
 * Layer: repository. A product is either a `stock` item (counted) or a `service` (printing etc.). The table
 * also holds the STOCK CACHE: `qty_on_hand` and `stock_value_cents` (BUSINESS_RULES section 3). Those two
 * columns are never written here - the database trigger `trg_stock_movements_cache` updates them whenever a
 * stock movement is inserted, so "sum of movements = cache" always holds. Business rules (price checks,
 * duplicate names, category book) live in `catalog.service.ts`; migration 003 triggers are the backstop.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC, escapeLike } from './sql-helpers.ts';

export type Book = 'shop' | 'telecom';
export type Kind = 'stock' | 'service';

/** A product with its category name and current stock cache. */
export interface ProductRow {
  id: number; code: string | null; name: string; description: string;
  categoryId: number; categoryName: string; kind: Kind; book: Book;
  sellPriceCents: number; minPriceCents: number; reorderLevel: number; active: boolean;
  qtyOnHand: number; stockValueCents: number; createdAt: string; updatedAt: string;
}

/** Filters and paging for `listProducts`. `q` searches name and code. */
export interface ProductQuery {
  q?: string; book?: Book; categoryId?: number; lowStock?: boolean; active?: boolean;
  limit: number; offset: number;
}

interface Raw {
  id: number | bigint; code: string | null; name: string; description: string;
  category_id: number | bigint; category_name: string; kind: Kind; book: Book;
  sell_price_cents: number | bigint; min_price_cents: number | bigint; reorder_level: number | bigint;
  active: number | bigint; qty_on_hand: number | bigint; stock_value_cents: number | bigint;
  created_at: string; updated_at: string;
}

const SELECT = `SELECT p.id, p.code, p.name, p.description, p.category_id, c.name AS category_name,
  p.kind, p.book, p.sell_price_cents, p.min_price_cents, p.reorder_level, p.active,
  p.qty_on_hand, p.stock_value_cents, p.created_at, p.updated_at
  FROM products p JOIN categories c ON c.id = p.category_id`;

function map(r: Raw): ProductRow {
  return {
    id: Number(r.id), code: r.code, name: r.name, description: r.description,
    categoryId: Number(r.category_id), categoryName: r.category_name, kind: r.kind, book: r.book,
    sellPriceCents: Number(r.sell_price_cents), minPriceCents: Number(r.min_price_cents),
    reorderLevel: Number(r.reorder_level), active: Number(r.active) === 1,
    qtyOnHand: Number(r.qty_on_hand), stockValueCents: Number(r.stock_value_cents),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Lists products A-Z with the total number of matches (before paging). */
export function listProducts(conn: DatabaseSync, q: ProductQuery): { items: ProductRow[]; total: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.q !== undefined && q.q !== '') {
    const like = `%${escapeLike(q.q)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (q.book !== undefined) { where.push('p.book = ?'); params.push(q.book); }
  if (q.categoryId !== undefined) { where.push('p.category_id = ?'); params.push(q.categoryId); }
  if (q.active !== undefined) { where.push('p.active = ?'); params.push(q.active ? 1 : 0); }
  if (q.lowStock === true) {
    // Low stock = an active stock product with a reorder level set and quantity at or below it.
    where.push("(p.kind = 'stock' AND p.active = 1 AND p.reorder_level > 0 AND p.qty_on_hand <= p.reorder_level)");
  }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((conn.prepare(`SELECT COUNT(*) AS n FROM products p${w}`).get(...params) as unknown as { n: number | bigint }).n);
  const rows = conn.prepare(`${SELECT}${w} ORDER BY p.name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as Raw[];
  return { items: rows.map(map), total };
}

/** One product by id, or undefined. */
export function getProduct(conn: DatabaseSync, id: number): ProductRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE p.id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** One product by name (NOCASE unique), or undefined - used for duplicate-name checks. */
export function findProductByName(conn: DatabaseSync, name: string): ProductRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE p.name = ?`).get(name) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** One product by code (NOCASE unique), or undefined - used for duplicate-code checks. */
export function findProductByCode(conn: DatabaseSync, code: string): ProductRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE p.code = ?`).get(code) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Inserts a product with zero stock and returns its id. Stock arrives only through stock movements. */
export function insertProduct(conn: DatabaseSync, p: {
  code: string | null; name: string; description: string; categoryId: number; kind: Kind; book: Book;
  sellPriceCents: number; minPriceCents: number; reorderLevel: number;
}): number {
  const res = conn.prepare(
    `INSERT INTO products (code, name, description, category_id, kind, book, sell_price_cents, min_price_cents, reorder_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.code, p.name, p.description, p.categoryId, p.kind, p.book, p.sellPriceCents, p.minPriceCents, p.reorderLevel);
  return Number(res.lastInsertRowid);
}

/**
 * Updates only the fields present in `patch` and stamps `updated_at`; an empty patch does nothing.
 * Note: there is no way to set kind or the stock columns here, by design (triggers would refuse it anyway).
 */
export function updateProduct(conn: DatabaseSync, id: number, patch: {
  code?: string | null; name?: string; description?: string; categoryId?: number; book?: Book;
  sellPriceCents?: number; minPriceCents?: number; reorderLevel?: number; active?: boolean;
}): void {
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (col: string, v: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(v); };
  if (patch.code !== undefined) add('code', patch.code);
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.categoryId !== undefined) add('category_id', patch.categoryId);
  if (patch.book !== undefined) add('book', patch.book);
  if (patch.sellPriceCents !== undefined) add('sell_price_cents', patch.sellPriceCents);
  if (patch.minPriceCents !== undefined) add('min_price_cents', patch.minPriceCents);
  if (patch.reorderLevel !== undefined) add('reorder_level', patch.reorderLevel);
  if (patch.active !== undefined) add('active', patch.active ? 1 : 0);
  if (sets.length === 0) return;
  sets.push(`updated_at = ${SQL_NOW_UTC}`);
  conn.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}
