/**
 * repositories/categories.repo.ts - SQL for the `categories` table (product groups).
 *
 * Layer: repository. No business rules: the service (`catalog.service.ts`) decides what may change; the
 * database triggers of migration 003 are the backstop (default categories locked, book fixed once a category
 * has products). Each category belongs to exactly one book, shop or telecom (BUSINESS_RULES section 1).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC } from './sql-helpers.ts';

/** The two stock-holding cash books. */
export type Book = 'shop' | 'telecom';

/** A category plus how many products use it (`productCount`, computed by a sub-query). */
export interface CategoryRow {
  id: number; name: string; book: Book; isDefault: boolean; active: boolean;
  productCount: number; createdAt: string; updatedAt: string;
}

interface Raw {
  id: number | bigint; name: string; book: Book; is_default: number | bigint; active: number | bigint;
  product_count: number | bigint; created_at: string; updated_at: string;
}

const SELECT = `SELECT c.id, c.name, c.book, c.is_default, c.active,
  (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
  c.created_at, c.updated_at FROM categories c`;

function map(r: Raw): CategoryRow {
  return {
    id: Number(r.id), name: r.name, book: r.book,
    isDefault: Number(r.is_default) === 1, active: Number(r.active) === 1,
    productCount: Number(r.product_count), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Lists categories, optionally filtered; shop categories first, then telecom, each A-Z (case-insensitive). */
export function listCategories(conn: DatabaseSync, q: { active?: boolean; book?: Book }): CategoryRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.active !== undefined) { where.push('c.active = ?'); params.push(q.active ? 1 : 0); }
  if (q.book !== undefined) { where.push('c.book = ?'); params.push(q.book); }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE c.book WHEN 'shop' THEN 0 ELSE 1 END, c.name COLLATE NOCASE, c.id`;
  return (conn.prepare(sql).all(...params) as unknown as Raw[]).map(map);
}

/** One category by id, or undefined. */
export function getCategory(conn: DatabaseSync, id: number): CategoryRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE c.id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** One category by name (the column is NOCASE, so "pen" finds "Pen"), or undefined. */
export function findCategoryByName(conn: DatabaseSync, name: string): CategoryRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE c.name = ?`).get(name) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Inserts a (non-default, active) category and returns its id. */
export function insertCategory(conn: DatabaseSync, c: { name: string; book: Book }): number {
  const res = conn.prepare('INSERT INTO categories (name, book) VALUES (?, ?)').run(c.name, c.book);
  return Number(res.lastInsertRowid);
}

/** Updates only the fields present in `patch` and stamps `updated_at`; an empty patch does nothing. */
export function updateCategory(
  conn: DatabaseSync, id: number, patch: { name?: string; book?: Book; active?: boolean },
): void {
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.book !== undefined) { sets.push('book = ?'); params.push(patch.book); }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push(`updated_at = ${SQL_NOW_UTC}`);
  conn.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}
