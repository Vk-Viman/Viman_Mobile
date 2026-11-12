// Helpers for the Phase 12 tests (dashboard and Excel export pack).
// (1) readers that call the real routes (`dash`, `pack`); (2) a table-by-table snapshot of the whole database so a test can prove the
// dashboard is READ-ONLY (no row of any table changes, no audit row); (3) the zero/shape checks several test files share.
// The scripted world itself is `buildFinWorld` of helpers/phase11fin.ts (March-April 2025, built only through the real API); every
// expected dashboard figure in the Phase 12 tests is worked out BY HAND from that script, never read from dashboard or report code.

import ExcelJS from 'exceljs';
import type { AppContext } from '../../app.ts';
import { get } from './catalog.ts';
import type { ApiBase } from './inventory.ts';

/** GET /dashboard (optionally with `asOf`). Raw response. */
export const dash = (s: ApiBase, asOf?: string) => get(s.app, asOf === undefined ? '/dashboard' : `/dashboard?asOf=${asOf}`);

/** GET /reports/export-pack and open the workbook with ExcelJS (wb is null unless the answer is 200). */
export async function pack(s: ApiBase, qs: string): Promise<{ status: number; type: string; disposition: string; wb: ExcelJS.Workbook | null; body: any }> {
  const res = await s.app.inject({ method: 'GET', url: `/api/v1/reports/export-pack?${qs}` });
  if (res.statusCode !== 200) return { status: res.statusCode, type: String(res.headers['content-type']), disposition: '', wb: null, body: res.json() };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
  return { status: 200, type: String(res.headers['content-type']), disposition: String(res.headers['content-disposition']), wb, body: null };
}

/**
 * Every table of the database as a JSON string (rows in primary-key order), keyed by table name. Two equal snapshots prove that
 * nothing was inserted, updated or deleted in between - including `audit_logs`.
 */
export function dbSnapshot(ctx: AppContext): Record<string, string> {
  const conn = ctx.database.conn;
  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>;
  const out: Record<string, string> = {};
  for (const t of tables) {
    out[t.name] = JSON.stringify(conn.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all(), (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  }
  return out;
}

/** One zero tile: no sales, no profit, nothing per segment. */
export const ZERO_LINE = { salesCents: 0, profitCents: 0 };
export const ZERO_TILE = { ...ZERO_LINE, bySegment: { shop: ZERO_LINE, telecom: ZERO_LINE, icecream: ZERO_LINE } };

/** Builds a tile from the three segment lines (combined = their sum, written out by hand in each test). */
export const tileOf = (shop: [number, number], telecom: [number, number], icecream: [number, number], combined: [number, number]) => ({
  salesCents: combined[0], profitCents: combined[1],
  bySegment: {
    shop: { salesCents: shop[0], profitCents: shop[1] },
    telecom: { salesCents: telecom[0], profitCents: telecom[1] },
    icecream: { salesCents: icecream[0], profitCents: icecream[1] },
  },
});

/** `n` consecutive dates ending on `last` (oldest first), using plain UTC arithmetic. */
export function datesEndingOn(last: string, n: number): string[] {
  const [y, m, d] = last.split('-').map(Number);
  const end = Date.UTC(y!, m! - 1, d!);
  return Array.from({ length: n }, (_v, i) => new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}
