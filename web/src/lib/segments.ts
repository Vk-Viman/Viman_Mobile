/**
 * Names, labels and small pure helpers for the Telecom segments (BUSINESS_RULES 13D), shared by every screen that records or shows
 * Telecom money. Display and input convenience only: the server decides and validates every segment.
 */
import type { SegmentKind, SegmentProvider, StoredSegment, TelecomSegment } from '../types/segments';

/** The four providers in display order, with their owner-facing names. */
export const SEGMENT_PROVIDERS: ReadonlyArray<{ code: SegmentProvider; label: string }> = [
  { code: 'dialog', label: 'Dialog' }, { code: 'mobitel', label: 'Mobitel' }, { code: 'airtel', label: 'Airtel' }, { code: 'hutch', label: 'Hutch' },
];
/** The two kinds in display order. */
export const SEGMENT_KINDS: ReadonlyArray<{ code: SegmentKind; label: string }> = [{ code: 'cards', label: 'Cards' }, { code: 'reloads', label: 'Reloads' }];

/** The eight segments, provider by provider (Cards then Reloads) - the server's display order. */
export const TELECOM_SEGMENTS: readonly TelecomSegment[] = SEGMENT_PROVIDERS.flatMap((p) => SEGMENT_KINDS.map((k) => `${p.code}_${k.code}` as TelecomSegment));

/** Owner-facing label of a segment: "Dialog Reloads"; `legacy` is "Telecom before segments". */
export const SEGMENT_LABEL: Record<StoredSegment, string> = {
  dialog_cards: 'Dialog Cards', dialog_reloads: 'Dialog Reloads', mobitel_cards: 'Mobitel Cards', mobitel_reloads: 'Mobitel Reloads',
  airtel_cards: 'Airtel Cards', airtel_reloads: 'Airtel Reloads', hutch_cards: 'Hutch Cards', hutch_reloads: 'Hutch Reloads',
  legacy: 'Telecom before segments',
};

/** True for one of the eight selectable segments (not `legacy`). */
export function isTelecomSegment(value: unknown): value is TelecomSegment {
  return typeof value === 'string' && (TELECOM_SEGMENTS as readonly string[]).includes(value);
}
/** True for the eight segments and `legacy`. */
export function isStoredSegment(value: unknown): value is StoredSegment {
  return value === 'legacy' || isTelecomSegment(value);
}

/** Builds a segment from its two choices, or `null` while either is missing. */
export function segmentOf(provider: SegmentProvider | '', kind: SegmentKind | ''): TelecomSegment | null {
  return provider && kind ? (`${provider}_${kind}` as TelecomSegment) : null;
}
/** The provider of a segment (`legacy` has none). */
export function providerOf(segment: StoredSegment): SegmentProvider | null {
  return segment === 'legacy' ? null : (segment.split('_')[0] as SegmentProvider);
}
/** The kind of a segment (`legacy` has none). */
export function kindOf(segment: StoredSegment): SegmentKind | null {
  return segment === 'legacy' ? null : (segment.split('_')[1] as SegmentKind);
}

/** Reads a `?segment=` URL parameter: a known segment (or legacy), otherwise null. */
export function parseSegmentParam(raw: string | null): StoredSegment | null {
  return isStoredSegment(raw) ? raw : null;
}

/** "Shop", "Ice Cream", "Telecom" or "Telecom - Dialog Reloads": the name the server uses in its messages. */
export function scopeLabel(book: 'shop' | 'telecom' | 'icecream', segment: StoredSegment | null | undefined): string {
  const name = book === 'shop' ? 'Shop' : book === 'icecream' ? 'Ice Cream' : 'Telecom';
  return segment ? `${name} - ${SEGMENT_LABEL[segment]}` : name;
}
