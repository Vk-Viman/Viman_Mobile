/**
 * services/segments.ts - the Telecom segments (BUSINESS_RULES 13D): the one place that knows the eight codes, their labels,
 * how a record gets its segment and how the segment errors look. Shared by every package that writes or reads Telecom money.
 *
 * Layer: service helper (pure, except `segmentOfProduct` which reads the view `v_product_segment`).
 *
 * Model: Telecom is ONE cash book (`book = 'telecom'`) split into eight segments (provider x kind) plus the read-only
 * `legacy` segment that holds every row recorded before the segments existed. The `segment` column is named exactly when
 * the book is Telecom (it works like `fund` for Ice Cream). A scope = book + segment (+ fund for Ice Cream) is the unit that
 * has its own balance, ledger, opening balance, drawer count and closed days.
 *
 * Compat rule (until package J): a bare `'telecom'` passed to a book-only signature that needs ONE scope (assertDayOpen,
 * insertCashEntry, closing lookups, negative-cash warnings ...) throws `TELECOM_SEGMENT_REQUIRED` at run time.
 */
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../lib/errors.ts';
import type { CashBook } from '../repositories/cash-entries.repo.ts';

/** The eight Telecom segments: provider x kind. */
export type TelecomSegment =
  | 'dialog_cards' | 'dialog_reloads' | 'mobitel_cards' | 'mobitel_reloads'
  | 'airtel_cards' | 'airtel_reloads' | 'hutch_cards' | 'hutch_reloads';
/** What the database stores: a segment, or `legacy` for rows from before the segments (never allowed on a new row). */
export type StoredSegment = TelecomSegment | 'legacy';

/** The eight segments in display order (provider by provider, Cards then Reloads). */
export const TELECOM_SEGMENTS: readonly TelecomSegment[] = [
  'dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads',
  'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads',
];

/** Owner-facing names. `legacy` is the read-only "Telecom before segments". */
export const SEGMENT_LABEL: Record<StoredSegment, string> = {
  dialog_cards: 'Dialog Cards', dialog_reloads: 'Dialog Reloads', mobitel_cards: 'Mobitel Cards', mobitel_reloads: 'Mobitel Reloads',
  airtel_cards: 'Airtel Cards', airtel_reloads: 'Airtel Reloads', hutch_cards: 'Hutch Cards', hutch_reloads: 'Hutch Reloads',
  legacy: 'Telecom before segments',
};

/** The four fixed providers, lower case, as used in segment codes. */
export const SEGMENT_PROVIDERS = ['dialog', 'mobitel', 'airtel', 'hutch'] as const;

/** JSON-schema fragments for request bodies / queries (every route that takes a segment uses these). */
export const SEGMENT_SCHEMA = { type: 'string', enum: [...TELECOM_SEGMENTS] } as const;
/** Same, plus `legacy` (accepted by the schema so the SERVICE can answer with the precise SEGMENT_LEGACY_REFUSED). */
export const STORED_SEGMENT_SCHEMA = { type: 'string', enum: [...TELECOM_SEGMENTS, 'legacy'] } as const;

/** True for the four Cards segments. */
export function isCardsSegment(segment: StoredSegment): boolean { return segment.endsWith('_cards'); }

/** True when `value` is one of the eight segment codes (not `legacy`). */
export function isTelecomSegment(value: unknown): value is TelecomSegment {
  return typeof value === 'string' && (TELECOM_SEGMENTS as readonly string[]).includes(value);
}
/** True for the eight codes and `legacy`. */
export function isStoredSegment(value: unknown): value is StoredSegment { return value === 'legacy' || isTelecomSegment(value); }

// ---------- scopes ----------

/** One cash scope: a whole book (Shop, Ice Cream) or one Telecom segment. Ice Cream funds are a separate axis. */
export interface CashScope { book: CashBook; segment: StoredSegment | null }
/** A READ scope: on Telecom, no segment = the whole Telecom total. */
export interface ScopeQuery { book: CashBook; segment?: StoredSegment | undefined }

const BOOK_ORDER: Record<CashBook, number> = { shop: 0, telecom: 1, icecream: 2 };
const SEGMENT_ORDER: Record<string, number> = Object.fromEntries([...TELECOM_SEGMENTS, 'legacy'].map((s, i) => [s, i]));

/** Stable text key of a scope: `shop`, `icecream` or `telecom:dialog_reloads`. */
export function scopeKey(scope: CashScope | ScopeQuery): string {
  return scope.segment ? `${scope.book}:${scope.segment}` : scope.book;
}

/** Owner-facing name of a scope: "Shop", "Ice Cream", "Telecom - Dialog Reloads" (and "Telecom" for the whole book). */
export function scopeLabel(scope: CashScope | ScopeQuery): string {
  const book = scope.book === 'shop' ? 'Shop' : scope.book === 'icecream' ? 'Ice Cream' : 'Telecom';
  return scope.segment ? `${book} - ${SEGMENT_LABEL[scope.segment]}` : book;
}

/** The compat error: a Telecom write/probe that did not name its segment. */
export function telecomSegmentRequired(): AppError {
  return new AppError(400, 'TELECOM_SEGMENT_REQUIRED',
    'A Telecom operation must name its segment (for example Dialog Reloads). This operation was not updated for Telecom segments.',
    { segment: 'Choose a Telecom segment.' });
}

/** Normalises one scope item; a bare `'telecom'` (or a Telecom scope without a segment) is the compat error. */
export function toScope(item: CashBook | CashScope): CashScope {
  if (typeof item === 'string') {
    if (item === 'telecom') throw telecomSegmentRequired();
    return { book: item, segment: null };
  }
  if (item.book === 'telecom') {
    if (!item.segment) throw telecomSegmentRequired();
    return { book: 'telecom', segment: item.segment };
  }
  return { book: item.book, segment: null };
}

/** A READ scope from a book name (whole book) or a scope query; never throws. */
export function toScopeQuery(item: CashBook | ScopeQuery | CashScope): ScopeQuery {
  if (typeof item === 'string') return { book: item };
  return item.segment ? { book: item.book, segment: item.segment } : { book: item.book };
}

/**
 * Distinct scopes of the items (duplicates removed), sorted shop, telecom (segment display order, legacy last), icecream.
 * @throws AppError 400 TELECOM_SEGMENT_REQUIRED for a bare 'telecom'.
 */
export function scopesOf(items: Iterable<CashBook | CashScope>): CashScope[] {
  const seen = new Map<string, CashScope>();
  for (const item of items) {
    const scope = toScope(item);
    seen.set(scopeKey(scope), scope);
  }
  return [...seen.values()].sort((a, b) =>
    BOOK_ORDER[a.book] - BOOK_ORDER[b.book] || (SEGMENT_ORDER[a.segment ?? ''] ?? -1) - (SEGMENT_ORDER[b.segment ?? ''] ?? -1));
}

// ---------- deriving a segment ----------

/**
 * The segment of a provider's reload or card business: `Dialog` + 'reloads' -> `dialog_reloads`. EZCash and wallet top-ups are
 * Dialog Reloads (the caller passes the Dialog provider row).
 * @throws Error when the provider is not one of the four fixed providers (a bug, not a user error).
 */
export function segmentForProvider(provider: { name: string }, kind: 'cards' | 'reloads'): TelecomSegment {
  const lower = provider.name.toLowerCase();
  const segment = `${lower}_${kind}`;
  if (!isTelecomSegment(segment)) throw new Error(`Unknown Telecom provider "${provider.name}"`);
  return segment;
}

/**
 * The segment of a product: for a Telecom stock product, its category's provider + `_cards` (or `legacy` while the category has
 * no provider); `null` for Shop products and unknown ids. Reads the view `v_product_segment` (migration 024).
 */
export function segmentOfProduct(conn: DatabaseSync, productId: number): StoredSegment | null {
  const r = conn.prepare('SELECT segment FROM v_product_segment WHERE product_id = ?').get(productId) as unknown as { segment: StoredSegment | null } | undefined;
  return r?.segment ?? null;
}

/**
 * The segment an entry-chosen record (expense, capital, drawing, count, closing ...) stores: Telecom REQUIRES one of the eight
 * codes, the other books FORBID one.
 *
 * @param opts.allowLegacy Only the re-close of an existing legacy closing passes true.
 * @returns the segment for Telecom, null for Shop / Ice Cream.
 * @throws AppError 400 SEGMENT_REQUIRED / SEGMENT_NOT_ALLOWED, 409 SEGMENT_LEGACY_REFUSED.
 */
export function resolveEntrySegment(
  book: CashBook, supplied: string | null | undefined, opts: { allowLegacy?: boolean; field?: string } = {},
): StoredSegment | null {
  const field = opts.field ?? 'segment';
  if (book !== 'telecom') {
    if (supplied !== undefined && supplied !== null) throw segmentNotAllowedError(field);
    return null;
  }
  if (supplied === undefined || supplied === null) throw segmentRequiredError(field);
  if (supplied === 'legacy') {
    if (opts.allowLegacy) return 'legacy';
    throw segmentLegacyRefusedError(field);
  }
  if (!isTelecomSegment(supplied)) throw segmentRequiredError(field);
  return supplied;
}

// ---------- errors ----------

/** 400 SEGMENT_REQUIRED: a Telecom record without a segment. */
export function segmentRequiredError(field = 'segment'): AppError {
  return new AppError(400, 'SEGMENT_REQUIRED', 'Choose a Telecom segment (provider and Cards or Reloads).', { [field]: 'Choose a segment.' });
}
/** 400 SEGMENT_NOT_ALLOWED: a segment on a Shop or Ice Cream record. */
export function segmentNotAllowedError(field = 'segment'): AppError {
  return new AppError(400, 'SEGMENT_NOT_ALLOWED', 'Only the Telecom book has segments.', { [field]: 'Segments exist only for the Telecom book.' });
}
/** 409 SEGMENT_LEGACY_REFUSED: new business cannot be recorded in "Telecom before segments". */
export function segmentLegacyRefusedError(field = 'segment'): AppError {
  return new AppError(409, 'SEGMENT_LEGACY_REFUSED',
    'Telecom before segments is read-only: new records cannot be recorded there. Choose one of the eight segments.', { [field]: 'Choose one of the eight segments.' });
}
/** 409 SEGMENT_READ_ONLY: a stored segment can never be changed. */
export function segmentReadOnlyError(): AppError {
  return new AppError(409, 'SEGMENT_READ_ONLY', 'The segment of a saved record cannot be changed.');
}
/** 400 SEGMENT_MISMATCH: a record's segment disagrees with the record it belongs to. */
export function segmentMismatchError(): AppError {
  return new AppError(400, 'SEGMENT_MISMATCH', 'The segment does not match the record it belongs to (provider, product, sale or purchase).');
}
/** 400 MIXED_SEGMENTS: one purchase / stocktake with cards of several providers. */
export function mixedSegmentsError(): AppError {
  return new AppError(400, 'MIXED_SEGMENTS', 'This document contains cards of more than one provider. Split it by provider (one document per provider).');
}

/**
 * Turns the raw aborts of the segment triggers (migrations 024-026) into API errors, so a rule the service did not check first
 * ends in a clean 400/409 and never a 500. Returns normally when the error is not a segment abort.
 */
export function mapSegmentAbort(err: unknown): void {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('SEGMENT_LEGACY_REFUSED')) throw segmentLegacyRefusedError();
  if (msg.includes('SEGMENT_REQUIRED')) throw segmentRequiredError();
  if (msg.includes('SEGMENT_NOT_ALLOWED')) throw segmentNotAllowedError();
  if (msg.includes('SEGMENT_READ_ONLY')) throw segmentReadOnlyError();
  if (msg.includes('SEGMENT_MISMATCH')) throw segmentMismatchError();
  // The mirror triggers (reversal and transfer leg) now compare the segment too; they were never mapped, so a refusal was a 500.
  if (msg.includes('REVERSAL_MISMATCH')) {
    throw new AppError(409, 'REVERSAL_MISMATCH', 'A reversal must mirror the entry it cancels (same amount, book, segment, fund and date).');
  }
  if (msg.includes('TRANSFER_LEG_MISMATCH')) {
    throw new AppError(409, 'TRANSFER_LEG_MISMATCH', 'A transfer leg must match its transfer (type, book, segment and fund).');
  }
  if (msg.includes('CATEGORY_PROVIDER_NOT_ALLOWED')) {
    throw new AppError(400, 'CATEGORY_PROVIDER_NOT_ALLOWED', 'Only a Telecom category can be linked to a provider.', { providerId: 'Only Telecom categories have a provider.' });
  }
  if (msg.includes('CATEGORY_PROVIDER_LOCKED')) {
    throw new AppError(409, 'CATEGORY_PROVIDER_LOCKED', 'The provider of a category that already has products cannot be changed.', { providerId: 'Locked: this category has products.' });
  }
  if (msg.includes('PRODUCT_NEEDS_PROVIDER')) {
    throw new AppError(400, 'PRODUCT_NEEDS_PROVIDER', 'A Telecom card product needs a category that is linked to a provider. Choose or create a provider category first.', { categoryId: 'Choose a category linked to a provider.' });
  }
  if (msg.includes('PRODUCT_SEGMENT_LOCKED')) {
    throw new AppError(409, 'PRODUCT_SEGMENT_LOCKED', 'This product already has stock history, so it cannot move to a category of another provider.', { categoryId: 'Choose a category of the same provider.' });
  }
}
