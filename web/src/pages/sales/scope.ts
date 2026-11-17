/**
 * Sale scopes on the POS (BUSINESS_RULES 13D, section 4): a cart is saved as ONE SALE PER SCOPE - Shop goods, and one sale per
 * Telecom provider's Cards segment. This file only mirrors the server's grouping so the cashier sees, before saving, which sales the
 * cart will become; the server derives the real segment from each product and stays authoritative.
 *
 * A card product's provider comes from its category (the server's category list carries `providerName`), so the grouping needs the
 * category list; until it has loaded, or for a category without a provider, a card line is grouped under "Telecom cards" (the server
 * refuses a provider-less card product with a clear message).
 */
import { useMemo } from 'react';
import { useCategories } from '../../api/catalog';
import { SEGMENT_LABEL, TELECOM_SEGMENTS, isTelecomSegment } from '../../lib/segments';
import type { StoredSegment } from '../../types/segments';
import type { CartLine } from './cart';

/** One group of the cart = one future sale. */
export interface LineScope {
  /** `shop`, `telecom:dialog_cards` ..., or `telecom:?` (provider unknown). */
  key: string;
  /** Owner-facing heading: "Shop", "Dialog Cards", "Telecom cards (no provider)". */
  label: string;
  /** The segment the sale will carry; null for Shop and for an unknown provider. */
  segment: StoredSegment | null;
  /** Sort position: Shop, then Dialog, Mobitel, Airtel, Hutch cards, then unknown. */
  order: number;
}

const SHOP: LineScope = { key: 'shop', label: 'Shop', segment: null, order: 0 };
const UNKNOWN: LineScope = { key: 'telecom:?', label: 'Telecom cards (no provider)', segment: null, order: 99 };

/** categoryId -> provider name ("Dialog") for the Telecom categories that have one. */
export function useProviderByCategory(): Record<number, string> {
  const cats = useCategories({ book: 'telecom' });
  return useMemo(() => {
    const out: Record<number, string> = {};
    for (const c of (cats.data?.items ?? []) as Array<{ id: number; providerName?: string | null }>) {
      if (c.providerName) out[c.id] = c.providerName;
    }
    return out;
  }, [cats.data]);
}

/** The scope a cart line will be sold in. */
export function scopeOfLine(l: Pick<CartLine, 'book' | 'categoryId'>, providerByCategory: Record<number, string>): LineScope {
  if (l.book !== 'telecom') return SHOP;
  const provider = providerByCategory[l.categoryId];
  const segment = provider ? `${provider.toLowerCase()}_cards` : '';
  if (!isTelecomSegment(segment)) return UNKNOWN;
  return { key: `telecom:${segment}`, label: SEGMENT_LABEL[segment], segment, order: 1 + TELECOM_SEGMENTS.indexOf(segment) };
}

/** The distinct scopes of the cart in the order the sales will be saved. */
export function cartScopes(lines: CartLine[], providerByCategory: Record<number, string>): LineScope[] {
  const seen = new Map<string, LineScope>();
  for (const l of lines) {
    const s = scopeOfLine(l, providerByCategory);
    seen.set(s.key, s);
  }
  return [...seen.values()].sort((a, b) => a.order - b.order);
}

/** Owner-facing name of a saved sale's scope: "Shop" or "Dialog Cards" ("Telecom before segments" for legacy). */
export function saleScopeLabel(sale: { book: 'shop' | 'telecom'; segment: StoredSegment | null }): string {
  return sale.segment ? SEGMENT_LABEL[sale.segment] : sale.book === 'shop' ? 'Shop' : 'Telecom';
}
