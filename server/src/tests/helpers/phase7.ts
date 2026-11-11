// Helpers for Phase 7 tests: print service types, print sales and printing supplies (BUSINESS_RULES sections 2, 6; R12).
// Two groups: (1) SQL-level builders that insert rows straight into an in-memory database (for trigger/CHECK tests);
// (2) thin API request builders so each test reads as a business action (psNew, supNew, voidPs ...).

import type { DatabaseSync } from 'node:sqlite';
import { get, post, put } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';

/** The seven seeded service types (code -> [price cents, standard cost cents]) = settings.printDefaults DEFAULTS. */
export const SEEDED: Record<string, [number, number]> = {
  BW_1S: [1500, 650], BW_2S: [2500, 900], CLR_1S: [2000, 650], CLR_2S: [3000, 900],
  PC_BW_1S: [1000, 650], PC_BW_2S: [1500, 900], CUSTOM: [4000, 650],
};

/** Exact, sorted field list of a print sale in API responses. */
export const SALE_KEYS = ['backdated', 'businessDate', 'clientRef', 'cogsCents', 'description', 'grossProfitCents', 'id', 'notes', 'postedAt',
  'qty', 'revenueCents', 'serviceTypeCode', 'serviceTypeId', 'status', 'unitCostCents', 'unitPriceCents', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a supplies purchase in API responses. */
export const SUPPLY_KEYS = ['amountCents', 'backdated', 'businessDate', 'clientRef', 'description', 'id', 'postedAt', 'status', 'voidReason', 'voidedAt'];
/** Exact, sorted field list of a service type in API responses. */
export const TYPE_KEYS = ['active', 'code', 'costCents', 'id', 'name', 'priceCents', 'sortOrder'];

// ---------- SQL level ----------

/** Id of a seeded/created service type by code (raw SQL). */
export const typeId = (c: DatabaseSync, code: string): number =>
  Number((c.prepare('SELECT id FROM print_service_types WHERE code = ?').get(code) as unknown as { id: number | bigint }).id);

/**
 * Inserts a print sale by raw SQL. Defaults: BW_1S, 3 pages @ 1500 price / 650 cost, dated today; revenue and
 * cogs are derived from qty and the unit amounts unless overridden (so a test can break exactly one thing).
 */
export function sqlPrintSale(c: DatabaseSync, o: {
  date?: string; type?: number; qty?: number; price?: number; cost?: number; revenue?: number; cogs?: number;
  desc?: string; ref?: string;
} = {}): number {
  const qty = o.qty ?? 3;
  const price = o.price ?? 1500;
  const cost = o.cost ?? 650;
  return Number(c.prepare(
    `INSERT INTO print_sales (business_date, service_type_id, description, qty, unit_price_cents, unit_cost_cents,
       revenue_cents, cogs_cents, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.date ?? today(), o.type ?? typeId(c, 'BW_1S'), o.desc ?? 'B/W print', qty, price, cost,
    o.revenue ?? qty * price, o.cogs ?? qty * cost, o.ref ?? ref()).lastInsertRowid);
}

/** Inserts a supplies purchase by raw SQL (default Rs 1,000.00 dated today). */
export function sqlSupply(c: DatabaseSync, o: { date?: string; amount?: number; desc?: string; ref?: string } = {}): number {
  return Number(c.prepare('INSERT INTO printing_supplies (business_date, amount_cents, description, client_ref) VALUES (?, ?, ?, ?)')
    .run(o.date ?? today(), o.amount ?? 100000, o.desc ?? 'A4 paper', o.ref ?? ref()).lastInsertRowid);
}

// ---------- API level ----------

/** Service types through the API (`?active=` optional). */
export const typesGet = (s: ApiBase, q = '') => get(s.app, `/print-service-types${q}`);
/** Id of a seeded type by code, through the API. */
export async function typeIdOf(s: ApiBase, code: string): Promise<number> {
  const r = await typesGet(s);
  return (r.body.items as Array<{ id: number; code: string }>).find((t) => t.code === code)!.id;
}
/** Adds a service type (raw response). */
export const typeNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/print-service-types', { code: 'POSTER_A3', name: 'Poster A3', priceCents: 15000, costCents: 4000, ...over });
/** Edits a service type; unspecified fields keep the given defaults. */
export const typePut = (s: ApiBase, id: number, body: Record<string, unknown>) => put(s.app, `/print-service-types/${id}`, body);

/** Records a print sale of `qty` pages of the seeded type `code` (default BW_1S x 3), dated today. Raw response. */
export async function psNew(s: ApiBase, over: Record<string, unknown> = {}, code = 'BW_1S') {
  const serviceTypeId = over.serviceTypeId ?? await typeIdOf(s, code);
  return post(s.app, '/print-sales', { businessDate: today(), serviceTypeId, qty: 3, clientRef: ref(), ...over });
}
/** Voids a print sale (R1). */
export const psVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/print-sales/${id}/void`, { reason });

/** Records a paper/toner purchase (default Rs 1,000.00 of A4 paper, today). Raw response. */
export const supNew = (s: ApiBase, over: Record<string, unknown> = {}) =>
  post(s.app, '/printing-supplies', { businessDate: today(), amountCents: 100000, description: 'A4 paper', clientRef: ref(), ...over });
/** Voids a supplies purchase (R1). */
export const supVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/printing-supplies/${id}/void`, { reason });

/** Shop cash book balance straight from the ledger (sum of every row). */
export const shopBalance = (s: ApiBase): number =>
  Number((s.ctx.database.conn.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM cash_entries WHERE book = 'shop'").get() as unknown as { t: number | bigint }).t);
