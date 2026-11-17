// Telecom-segment test helpers, layer 1 (BUSINESS_RULES 13D): constants, the default-segment rule and provider categories.
// Imports only catalog.ts (HTTP helpers), so every other helper file may import it without a cycle.
// Layer 2 (per-segment balances, closings, ledgers: the `seg.*` helpers) is in ./seg.ts.
//
// DEFAULT SEGMENTS (documented contract for every test of every package):
//  - Telecom CASH-TYPE writes that the entry chooses (opening balance, capital, cash drawing, expense, cash count, closing, transfer
//    side) take `segment` in the request body. The helpers (openNew, capNew, drawCash, expNew, countNew, closeNew, tr/trNew,
//    seedBooks) ADD `segment: DEFAULT_SEGMENT` ('dialog_reloads') for book 'telecom' unless the test passes its own `segment`
//    (transfers: `fromSegment` / `toSegment`). Shop and Ice Cream calls are unchanged.
//  - Telecom CARD flows (products, purchases, sales, stock losses, stocktakes) derive their segment from the product's category
//    provider: `cardProduct` / `mkTelecom` create products in a Dialog provider category => 'dialog_cards'.
//  - Reloads, EZCash and top-ups derive it from the provider (EZCash and wallet top-ups = 'dialog_reloads').

import type { FastifyInstance } from 'fastify';
import { get, post, put } from './catalog.ts';

export type ProviderName = 'Dialog' | 'Mobitel' | 'Hutch' | 'Airtel';
export type SegmentCode =
  | 'dialog_cards' | 'dialog_reloads' | 'mobitel_cards' | 'mobitel_reloads'
  | 'airtel_cards' | 'airtel_reloads' | 'hutch_cards' | 'hutch_reloads';

/** The eight segments in the server's display order. */
export const SEGMENTS: readonly SegmentCode[] = [
  'dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads',
];
export const PROVIDERS: readonly ProviderName[] = ['Dialog', 'Mobitel', 'Airtel', 'Hutch'];

/** Default segment of a Telecom cash-type entry that does not name one (see the header). */
export const DEFAULT_SEGMENT: SegmentCode = 'dialog_reloads';
/** Default segment of Telecom card flows (the provider of the default card category is Dialog). */
export const DEFAULT_CARD_SEGMENT: SegmentCode = 'dialog_cards';

/** Segment code of a provider and kind: `segmentOf('Dialog', 'reloads')` = 'dialog_reloads'. */
export const segmentOf = (provider: ProviderName, kind: 'cards' | 'reloads'): SegmentCode => `${provider.toLowerCase()}_${kind}` as SegmentCode;
/** Provider name of a segment code. */
export const providerOfSegment = (segment: string): ProviderName =>
  ({ dialog: 'Dialog', mobitel: 'Mobitel', airtel: 'Airtel', hutch: 'Hutch' } as const)[segment.split('_')[0] as 'dialog'];

/** Owner-facing label of a segment code (the server's SEGMENT_LABEL). */
export const segmentLabel = (segment: string): string =>
  segment === 'legacy' ? 'Telecom before segments' : segment.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/**
 * Request-body fragment for a Telecom entry-chosen record: `{ segment }` when `book` is Telecom and the test did not name one,
 * otherwise nothing. Spread it BEFORE the caller's overrides: `{ ...withSeg(book, over), ...over }`.
 */
export function withSeg(book: unknown, over: Record<string, unknown>, field = 'segment', fallback: SegmentCode = DEFAULT_SEGMENT): Record<string, unknown> {
  return book === 'telecom' && over[field] === undefined ? { [field]: fallback } : {};
}

/** Provider ids by name, read from the API. */
export async function providerIdByName(app: FastifyInstance): Promise<Record<ProviderName, number>> {
  const r = await get(app, '/reload-providers');
  return Object.fromEntries((r.body.items as Array<{ id: number; name: string }>).map((p) => [p.name, p.id])) as Record<ProviderName, number>;
}

/**
 * Finds or creates the Telecom category of a provider (default name "<Provider> Cards") linked to that provider, through the API.
 * Products created in it belong to `<provider>_cards`.
 *
 * @returns the category item (`{ id, name, providerId, providerName, ... }`).
 * @throws when the category exists with another provider or the API refuses.
 */
export async function makeProviderCategory(app: FastifyInstance, provider: ProviderName = 'Dialog', name = `${provider} Cards`): Promise<any> {
  const providerId = (await providerIdByName(app))[provider];
  const list = await get(app, '/categories?book=telecom');
  const found = (list.body.items as any[]).find((c) => String(c.name).toLowerCase() === name.toLowerCase());
  if (found) {
    if (found.providerId === providerId) return found;
    if (found.providerId === null) {
      const r = await put(app, `/categories/${found.id}`, { providerId });
      if (r.status !== 200) throw new Error(`category provider failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.item;
    }
    throw new Error(`category "${name}" already belongs to ${found.providerName}`);
  }
  const r = await post(app, '/categories', { name, book: 'telecom', providerId });
  if (r.status !== 201) throw new Error(`provider category failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
}
