// Telecom-segment test helpers, layer 2: the `seg.*` helpers for per-segment balances, openings, counts, closings and ledgers
// (BUSINESS_RULES 13D). Layer 1 (constants, default-segment rule, provider categories) is ./segments.ts.
// Every `seg.<action>(s, segment, ...)` helper names the segment explicitly; the plain builders in phase8/phase9 default to
// 'dialog_reloads' for Telecom cash-type entries. Raw responses are returned unless the name ends in `Ok` (throws unless 201).

import type { AppContext } from '../../app.ts';
import { get, post } from './catalog.ts';
import { ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { closeNew, countNew, expNew, openNew, reopenNew } from './phase8.ts';
import { capNew, drawCash } from './phase9.ts';
import { SEGMENTS } from './segments.ts';
import type { SegmentCode } from './segments.ts';

type Ctx = { ctx: AppContext };
type Any = Record<string, unknown>;

function scalar(s: Ctx, sql: string, ...p: Array<string | number>): number {
  const r = s.ctx.database.conn.prepare(sql).get(...p) as unknown as Record<string, number | bigint>;
  return Number(Object.values(r)[0]);
}
function rows(s: Ctx, sql: string, ...p: Array<string | number>): Array<Record<string, any>> {
  return s.ctx.database.conn.prepare(sql).all(...p) as unknown as Array<Record<string, any>>;
}

export const seg = {
  // ---------- balances (straight from the ledger) ----------
  /** Balance of one Telecom segment (sum of its cash rows; `legacy` allowed). */
  balance: (s: Ctx, segment: SegmentCode | 'legacy'): number =>
    scalar(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'telecom' AND segment = ?", segment),
  /** Balance of every segment (the eight, plus `legacy`). */
  balances(s: Ctx): Record<SegmentCode | 'legacy', number> {
    const out = Object.fromEntries([...SEGMENTS, 'legacy'].map((c) => [c, 0])) as Record<SegmentCode | 'legacy', number>;
    for (const r of rows(s, "SELECT segment, COALESCE(SUM(amount_cents),0) AS t FROM cash_entries WHERE book = 'telecom' GROUP BY segment")) {
      out[r.segment as SegmentCode | 'legacy'] = Number(r.t);
    }
    return out;
  },
  /** The whole Telecom book balance. */
  total: (s: Ctx): number => scalar(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'telecom'"),
  /** Sum of the nine segment balances (must equal `total`: the Telecom-total invariant). */
  sumOfSegments(s: Ctx): number { return Object.values(seg.balances(s)).reduce((a, b) => a + b, 0); },
  /** Cash rows of one segment, oldest first. */
  rows: (s: Ctx, segment: SegmentCode | 'legacy'): Array<Record<string, any>> =>
    rows(s, "SELECT * FROM cash_entries WHERE book = 'telecom' AND segment = ? ORDER BY id", segment),

  // ---------- writes that name the segment ----------
  open: (s: ApiBase, segment: SegmentCode, amountCents: number, over: Any = {}) => openNew(s, 'telecom', { segment, amountCents, ...over }),
  /** Opening balances for several segments: `seg.seed(s, { dialog_reloads: 100000, mobitel_cards: 50000 }, date)`; throws on a refusal. */
  async seed(s: ApiBase, amounts: Partial<Record<SegmentCode, number>>, date = today()): Promise<void> {
    for (const [segment, amountCents] of Object.entries(amounts) as Array<[SegmentCode, number]>) {
      const r = await seg.open(s, segment, amountCents, { businessDate: date });
      if (r.status !== 201) throw new Error(`seg.seed ${segment} failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
  },
  capital: (s: ApiBase, segment: SegmentCode, amountCents: number, over: Any = {}) => capNew(s, { book: 'telecom', segment, amountCents, ...over }),
  drawing: (s: ApiBase, segment: SegmentCode, amountCents: number, over: Any = {}) => drawCash(s, { book: 'telecom', segment, amountCents, ...over }),
  expense: (s: ApiBase, segment: SegmentCode, over: Any = {}) => expNew(s, { book: 'telecom', category: 'internet', segment, ...over }),
  count: (s: ApiBase, segment: SegmentCode, countedCents: number, over: Any = {}) => countNew(s, 'telecom', countedCents, { segment, ...over }),

  // ---------- closing and reopening ----------
  close: (s: ApiBase, segment: SegmentCode | 'legacy', businessDate = today(), over: Any = {}) => closeNew(s, 'telecom', businessDate, { segment, ...over }),
  /** Closes a segment's day and returns the closing item (throws unless 201). */
  async closeOk(s: ApiBase, segment: SegmentCode, businessDate = today(), over: Any = {}): Promise<any> {
    const r = await seg.close(s, segment, businessDate, over);
    if (r.status !== 201) throw new Error(`seg.close ${segment} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.item;
  },
  /** Closes the day for all eight segments (the old "close the Telecom book" meaning); returns the eight closing items. */
  async closeAll(s: ApiBase, businessDate = today(), over: Any = {}): Promise<any[]> {
    const items: any[] = [];
    for (const segment of SEGMENTS) items.push(await seg.closeOk(s, segment, businessDate, { ...over, clientRef: ref() }));
    return items;
  },
  /** Reopens closings (by item) of the given list; returns the raw responses. */
  async reopenAll(s: ApiBase, items: any[], reason = 'fix a mistake'): Promise<any[]> {
    const out: any[] = [];
    for (const it of items) out.push(await reopenNew(s, it.id, reason));
    return out;
  },
  /** True when the segment's day is closed right now (read from the table, not the API). */
  isClosed: (s: Ctx, segment: SegmentCode | 'legacy', businessDate: string): boolean =>
    scalar(s, `SELECT COUNT(*) FROM daily_closings WHERE book = 'telecom' AND segment = ? AND business_date = ?
               AND (reopened_at IS NULL OR closed_at > reopened_at)`, segment, businessDate) > 0,
  /** The latest date closed for a segment, or null. */
  lastClosed(s: Ctx, segment: SegmentCode | 'legacy'): string | null {
    const r = rows(s, `SELECT MAX(business_date) AS d FROM daily_closings WHERE book = 'telecom' AND segment = ?
                       AND (reopened_at IS NULL OR closed_at > reopened_at)`, segment)[0];
    return (r?.d as string | null) ?? null;
  },

  // ---------- reads through the API ----------
  /** The ledger of a segment (`segment` undefined = the whole-Telecom total ledger). */
  ledger: (s: ApiBase, segment?: SegmentCode | 'legacy', qs = '') =>
    get(s.app, `/cashbooks/telecom${segment || qs ? '?' : ''}${[segment ? `segment=${segment}` : '', qs.replace(/^\?/, '')].filter(Boolean).join('&')}`),
  /** GET /cashbooks Telecom summary: the Telecom entry with its `segments[]`. */
  async summary(s: ApiBase): Promise<any> { return ((await get(s.app, '/cashbooks')).body.books as any[]).find((b) => b.book === 'telecom'); },
  /** Telecom day status of a segment through the API. */
  status: (s: ApiBase, segment: SegmentCode, businessDate: string) =>
    get(s.app, `/daily-closings/status?book=telecom&segment=${segment}&businessDate=${businessDate}`),
  /** Raw POST of a closing without the helper defaults (to test that a missing segment is refused). */
  rawClose: (s: ApiBase, body: Any) => post(s.app, '/daily-closings', { clientRef: ref(), ...body }),
};
