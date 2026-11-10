import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';

export const BASE = '/api/v1';

export interface Res { status: number; body: any }

export async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<Res> {
  const res = await app.inject({ method, url: `${BASE}${url}`, ...(payload === undefined ? {} : { payload: payload as object }) });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

export const get = (app: FastifyInstance, url: string) => call(app, 'GET', url);
export const post = (app: FastifyInstance, url: string, p?: unknown) => call(app, 'POST', url, p);
export const put = (app: FastifyInstance, url: string, p?: unknown) => call(app, 'PUT', url, p);

/** Raw request with an arbitrary body string (for malformed/empty JSON). */
export async function raw(app: FastifyInstance, method: 'POST' | 'PUT', url: string, body: string): Promise<Res> {
  const res = await app.inject({ method, url: `${BASE}${url}`, payload: body, headers: { 'content-type': 'application/json' } });
  let b: any = null;
  try { b = res.json(); } catch { b = res.body; }
  return { status: res.statusCode, body: b };
}

export interface AuditRow { id: number; entity: string; entityId: string | null; action: string; before: any; after: any }

export function auditRows(ctx: AppContext, entity?: string): AuditRow[] {
  const sql = `SELECT id, entity, entity_id, action, before_json, after_json FROM audit_logs
    ${entity ? 'WHERE entity = ?' : ''} ORDER BY id`;
  const st = ctx.database.conn.prepare(sql);
  const rows = (entity ? st.all(entity) : st.all()) as unknown as {
    id: number; entity: string; entity_id: string | null; action: string; before_json: string | null; after_json: string | null;
  }[];
  return rows.map((r) => ({
    id: Number(r.id), entity: r.entity, entityId: r.entity_id, action: r.action,
    before: r.before_json === null ? null : JSON.parse(r.before_json),
    after: r.after_json === null ? null : JSON.parse(r.after_json),
  }));
}

export function count(ctx: AppContext, table: string): number {
  return Number((ctx.database.conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number | bigint }).n);
}

export async function catIds(app: FastifyInstance): Promise<Record<string, number>> {
  const r = await get(app, '/categories');
  const out: Record<string, number> = {};
  for (const c of r.body.items) out[c.name] = c.id;
  return out;
}

export const CATEGORY_KEYS = ['active', 'book', 'createdAt', 'id', 'isDefault', 'name', 'productCount', 'updatedAt'];
export const PRODUCT_KEYS = [
  'active', 'avgUnitCostCents', 'book', 'categoryId', 'categoryName', 'code', 'createdAt', 'description', 'id', 'kind',
  'lowStock', 'minPriceCents', 'name', 'qtyOnHand', 'reorderLevel', 'sellPriceCents', 'stockValueCents', 'updatedAt',
];
export const SUPPLIER_KEYS = ['active', 'createdAt', 'id', 'name', 'notes', 'phone', 'updatedAt'];

/** Installs a trigger that makes any audit insert for `entity` abort, to prove the write rolls back with it. */
export function breakAudit(ctx: AppContext, entity: string): void {
  ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs
    WHEN NEW.entity = '${entity}' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
}
