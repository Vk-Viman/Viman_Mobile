/**
 * Segment colours and names used by every dashboard tile and chart, so Shop, Telecom and Ice Cream look the same everywhere.
 * Colours are fixed hex values (charts need real colours, not CSS classes). They stay distinguishable without colour too:
 * every chart has a legend with the names and an accessible table alternative.
 */
import type { Segment } from '../../types/dashboard';

/** Display order of the segments. */
export const SEGMENTS: readonly Segment[] = ['shop', 'telecom', 'icecream'];

/** Owner-facing names. */
export const SEGMENT_LABEL: Record<Segment, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };

/** One colour per segment (blue, amber, violet: clearly different, none of them red or green so they never read as profit/loss). */
export const SEGMENT_COLOR: Record<Segment, string> = { shop: '#2563eb', telecom: '#d97706', icecream: '#7c3aed' };

/** Colour of the combined total (the app's brand teal) and of loss values (red), plus a neutral for sales. */
export const COMBINED_COLOR = '#0f766e';
export const LOSS_COLOR = '#b91c1c';
export const SALES_COLOR = '#94a3b8';

/** Compact rupee text for chart axes: 123456789 cents -> "1.2M". Display only (the server sends the real figures). */
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export function compactRupees(cents: number): string {
  return compact.format(cents / 100);
}
