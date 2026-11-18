/**
 * Types of the Telecom segments (BUSINESS_RULES 13D): Telecom is one cash book split into 4 providers x 2 kinds = 8 segments, plus the
 * read-only `legacy` segment ("Telecom before segments") that holds every record from before the split. Mirrors the server's
 * `services/segments.ts`. A record names its segment exactly when its book is Telecom (like an Ice Cream fund).
 * (Not to be confused with the dashboard / P&L "segment" = Shop | Telecom | Ice Cream, which keeps its own types.)
 */

/** The eight Telecom segments. */
export type TelecomSegment =
  | 'dialog_cards' | 'dialog_reloads' | 'mobitel_cards' | 'mobitel_reloads'
  | 'airtel_cards' | 'airtel_reloads' | 'hutch_cards' | 'hutch_reloads';
/** What the server stores and returns: a segment, or `legacy` for records from before the segments (never selectable for new records). */
export type StoredSegment = TelecomSegment | 'legacy';
/** The four fixed providers (lower case, as in the segment codes). */
export type SegmentProvider = 'dialog' | 'mobitel' | 'airtel' | 'hutch';
/** The two kinds of business inside a provider. */
export type SegmentKind = 'cards' | 'reloads';

/** One Telecom segment on the Cash Books summary (GET /cashbooks, Telecom `segments[]`). */
export interface SegmentSummary { segment: StoredSegment; label: string; balanceCents: number; lastClosedDate: string | null }
