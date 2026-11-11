/**
 * repositories/suppliers.repo.ts - SQL for the `suppliers` table (who the shop buys from).
 *
 * Layer: repository. No business rules: validation and duplicate-name handling live in `catalog.service.ts`.
 * Suppliers are never deleted (purchases refer to them); `active = 0` hides one from new purchases.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SQL_NOW_UTC, escapeLike } from './sql-helpers.ts';

export interface SupplierRow {
  id: number; name: string; phone: string; notes: string; active: boolean; createdAt: string; updatedAt: string;
}

interface Raw {
  id: number | bigint; name: string; phone: string; notes: string; active: number | bigint;
  created_at: string; updated_at: string;
}

const SELECT = 'SELECT id, name, phone, notes, active, created_at, updated_at FROM suppliers';

function map(r: Raw): SupplierRow {
  return {
    id: Number(r.id), name: r.name, phone: r.phone, notes: r.notes,
    active: Number(r.active) === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Lists suppliers A-Z; `q` searches name and phone. */
export function listSuppliers(conn: DatabaseSync, q: { q?: string; active?: boolean }): SupplierRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.q !== undefined && q.q !== '') {
    const like = `%${escapeLike(q.q)}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (q.active !== undefined) { where.push('active = ?'); params.push(q.active ? 1 : 0); }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE, id`;
  return (conn.prepare(sql).all(...params) as unknown as Raw[]).map(map);
}

/** One supplier by id, or undefined. */
export function getSupplier(conn: DatabaseSync, id: number): SupplierRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** One supplier by name (NOCASE unique), or undefined - used for duplicate-name checks. */
export function findSupplierByName(conn: DatabaseSync, name: string): SupplierRow | undefined {
  const r = conn.prepare(`${SELECT} WHERE name = ?`).get(name) as unknown as Raw | undefined;
  return r ? map(r) : undefined;
}

/** Inserts an active supplier and returns its id. */
export function insertSupplier(conn: DatabaseSync, s: { name: string; phone: string; notes: string }): number {
  const res = conn.prepare('INSERT INTO suppliers (name, phone, notes) VALUES (?, ?, ?)').run(s.name, s.phone, s.notes);
  return Number(res.lastInsertRowid);
}

/** Updates only the fields present in `patch` and stamps `updated_at`; an empty patch does nothing. */
export function updateSupplier(
  conn: DatabaseSync, id: number,
  patch: { name?: string; phone?: string; notes?: string; active?: boolean },
): void {
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.phone !== undefined) { sets.push('phone = ?'); params.push(patch.phone); }
  if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes); }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push(`updated_at = ${SQL_NOW_UTC}`);
  conn.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}
