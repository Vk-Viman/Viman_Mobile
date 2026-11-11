// Helpers for Phase 6 tests: telecom reloads, EZCash and top-ups (BUSINESS_RULES section 5).
// Two groups: (1) request builders (rel/ez/top and their void calls) so each test reads as a business action;
// (2) read helpers that look at the ledger directly (telecom cash balance, ledger rows of one record, row counts).
// Money in tests is written in CENTS; the rupee value is given in a comment where it helps.

import type { AppContext } from '../../app.ts';
import { get, post, put } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { num, sql } from './phase4.ts';

/** Provider ids by name (Dialog, Mobitel, Hutch, Airtel), read once from the API. */
export async function providerIds(s: ApiBase): Promise<Record<string, number>> {
  const r = await get(s.app, '/reload-providers');
  return Object.fromEntries((r.body.items as Array<{ id: number; name: string }>).map((p) => [p.name, p.id]));
}

/** Records a reload entry (dated today, fresh clientRef unless overridden). Returns the raw response. */
export const rel = (s: ApiBase, providerId: number, salesCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/reload-sales', { businessDate: today(), providerId, salesCents, clientRef: ref(), ...over });

/** Records an EZCash bill collection. Returns the raw response. */
export const ez = (s: ApiBase, billTotalCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/ezcash-sales', { businessDate: today(), billTotalCents, clientRef: ref(), ...over });

/** Records a provider top-up (needs a provider). Returns the raw response. */
export const topProvider = (s: ApiBase, providerId: number, amountCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/telecom/topups', { businessDate: today(), kind: 'provider_topup', providerId, amountCents, clientRef: ref(), ...over });

/** Records a wallet top-up (no provider). Returns the raw response. */
export const topWallet = (s: ApiBase, amountCents: number, over: Record<string, unknown> = {}) =>
  post(s.app, '/telecom/topups', { businessDate: today(), kind: 'wallet_topup', amountCents, clientRef: ref(), ...over });

/** Voids a reload entry. */
export const relVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/reload-sales/${id}/void`, { reason });
/** Voids an EZCash entry. */
export const ezVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/ezcash-sales/${id}/void`, { reason });
/** Voids a top-up. */
export const topVoid = (s: ApiBase, id: number, reason = 'test void') => post(s.app, `/telecom/topups/${id}/void`, { reason });

/** Edits a provider (rate + active flag). */
export const putProvider = (s: ApiBase, id: number, body: unknown) => put(s.app, `/reload-providers/${id}`, body);

/** Telecom cash book balance = sum of every ledger row (section 8), straight from the database. */
export const telecomCash = (s: { ctx: AppContext }): number => num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'telecom'");

/** Cash ledger rows written for one business record, oldest first. */
export const cashOf = (s: { ctx: AppContext }, table: string, id: number): Array<Record<string, any>> =>
  sql(s, 'SELECT * FROM cash_entries WHERE ref_table = ? AND ref_id = ? ORDER BY id', table, id);

/** Row counts of every table a Phase 6 write may touch; equal snapshots before/after prove nothing was half-saved. */
const TABLES = ['reload_sales', 'ezcash_sales', 'telecom_topups', 'cash_entries', 'audit_logs'];
export const snap6 = (s: { ctx: AppContext }): Record<string, number> =>
  Object.fromEntries(TABLES.map((t) => [t, num(s, `SELECT COUNT(*) FROM ${t}`)]));

/** The exact audit_logs row (business_date, backdated and parsed after-JSON) of the latest entry for an entity. */
export function lastAudit(s: { ctx: AppContext }, entity: string, action?: string): Record<string, any> | undefined {
  const rows = sql(s, `SELECT * FROM audit_logs WHERE entity = ? ${action ? 'AND action = ?' : ''} ORDER BY id DESC LIMIT 1`,
    ...(action ? [entity, action] : [entity]));
  return rows[0];
}

/** Independent integer reference for round-half-up of sales * bp / 10000 (all values non-negative), via BigInt. */
export const refBase = (salesCents: number, bp: number): number => Number((BigInt(salesCents) * BigInt(bp) + 5000n) / 10000n);
