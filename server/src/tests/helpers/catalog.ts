// Shared HTTP/database helpers for API-level tests (catalog, suppliers and every later phase).
// They call the app in-process with Fastify's inject (no network port), so tests run fast and need no server.
// Also holds the exact key lists of the API contract (CATEGORY_KEYS, PRODUCT_KEYS, SUPPLIER_KEYS) so tests can
// fail when a response gains or loses a field, and a trigger helper to prove "audit and data are written together".

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';

/**
 * Every API route lives under this prefix (API_CONTRACTS.md).
 */
export const BASE = '/api/v1';

/**
 * What a test sees of a response: the HTTP status and the parsed JSON body (or raw text if not JSON).
 */
export interface Res { status: number; body: any }

/**
 * Sends one JSON request to the in-process app and returns { status, body }.
 * Why: one place decides how payloads are sent and how bodies are parsed, so tests stay short.
 * @param app the Fastify app under test
 * @param method HTTP verb
 * @param url path after /api/v1, e.g. '/products'
 * @param payload optional JSON body (omitted entirely when undefined)
 */
export async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<Res> {
  const res = await app.inject({ method, url: `${BASE}${url}`, ...(payload === undefined ? {} : { payload: payload as object }) });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/**
 * Shorthand for call(app, 'GET', url).
 */
export const get = (app: FastifyInstance, url: string) => call(app, 'GET', url);
/**
 * Shorthand for call(app, 'POST', url, payload).
 */
export const post = (app: FastifyInstance, url: string, p?: unknown) => call(app, 'POST', url, p);
/**
 * Shorthand for call(app, 'PUT', url, payload).
 */
export const put = (app: FastifyInstance, url: string, p?: unknown) => call(app, 'PUT', url, p);

/**
 * Raw request with an arbitrary body string (for malformed/empty JSON).
 * Why: it bypasses JSON.stringify so the body reaches the server exactly as written, letting tests prove that
 * broken input gets a clean 400 and never reaches the database.
 */
export async function raw(app: FastifyInstance, method: 'POST' | 'PUT', url: string, body: string): Promise<Res> {
  const res = await app.inject({ method, url: `${BASE}${url}`, payload: body, headers: { 'content-type': 'application/json' } });
  let b: any = null;
  try { b = res.json(); } catch { b = res.body; }
  return { status: res.statusCode, body: b };
}

/**
 * One audit_logs row with its before/after JSON already parsed (BUSINESS_RULES section 12).
 */
export interface AuditRow { id: number; entity: string; entityId: string | null; action: string; before: any; after: any }

/**
 * Reads the audit log straight from the database, oldest first.
 * Why: the audit trail is a business rule (every edit/void/restore leaves before/after JSON), and the API only
 * exposes it indirectly, so tests look at the table itself.
 * @param ctx the app context (gives access to the database connection)
 * @param entity optional filter, e.g. 'products'; omit to get all entries
 * @returns rows in id order with before/after parsed from JSON (null when the column is NULL)
 */
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

/**
 * Counts the rows of a table. Tests use it to prove a failed request wrote nothing (no half-saved records).
 * @param ctx the app context
 * @param table a trusted table name from the test itself (it is placed in the SQL text)
 * @returns the row count as a plain number
 */
export function count(ctx: AppContext, table: string): number {
  return Number((ctx.database.conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number | bigint }).n);
}

/**
 * Looks up the seeded default categories by name through the API.
 * Why: category ids are assigned by the database, so tests ask for them instead of hard-coding numbers.
 * @returns a map such as { Electronics: 3, 'Scratch Cards': 9 }
 */
export async function catIds(app: FastifyInstance): Promise<Record<string, number>> {
  const r = await get(app, '/categories');
  const out: Record<string, number> = {};
  for (const c of r.body.items) out[c.name] = c.id;
  return out;
}

/**
 * Exact, sorted field list of a category in API responses (contract check: no field may appear or vanish silently).
 */
export const CATEGORY_KEYS = ['active', 'book', 'createdAt', 'id', 'isDefault', 'name', 'productCount', 'updatedAt'];
/**
 * Exact, sorted field list of a product in API responses, including the computed stock fields.
 */
export const PRODUCT_KEYS = [
  'active', 'avgUnitCostCents', 'book', 'categoryId', 'categoryName', 'code', 'createdAt', 'description', 'id', 'kind',
  'lowStock', 'minPriceCents', 'name', 'qtyOnHand', 'reorderLevel', 'sellPriceCents', 'stockValueCents', 'updatedAt',
];
/**
 * Exact, sorted field list of a supplier in API responses.
 */
export const SUPPLIER_KEYS = ['active', 'createdAt', 'id', 'name', 'notes', 'phone', 'updatedAt'];

/**
 * Installs a trigger that makes any audit insert for `entity` abort, to prove the write rolls back with it.
 * Why: a business change and its audit entry must be saved in ONE transaction (section 12); if the audit write
 * fails, the product/sale/etc. change must disappear too. Tests use this to force that failure.
 * @param ctx the app context
 * @param entity the audit entity name to break, e.g. 'products'
 */
export function breakAudit(ctx: AppContext, entity: string): void {
  ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs
    WHEN NEW.entity = '${entity}' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
}
