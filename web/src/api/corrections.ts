/**
 * API hooks and types for "Correct this entry" (API_CONTRACTS.md "Correction contract, Phase 1").
 *
 * A correction = the existing void of the original + the existing create of a replacement, in ONE server transaction, linked in the
 * append-only `corrections` table. Nothing is edited in place. Three endpoints exist per supported type, under the type's own route
 * prefix (`resource`, e.g. "/expenses"):
 *   GET  <resource>/:id/correct-check     can this record be corrected right now? (nothing saved)
 *   POST <resource>/:id/correct-preview   dry run of the whole correction (rolled back by the server; nothing saved)
 *   POST <resource>/:id/correct           the real thing (201; 200 when the same replacement clientRef was already applied)
 * and `GET /corrections?entity=&ids=` answers the links used by the "Corrected by #n" / "Corrects #n" badges in History.
 *
 * `replacement` is exactly the normal create body of the type (clientRef required: it is the idempotency key); businessDate is
 * optional on the server and defaults to the original's date, but the dialog always sends the date shown on screen.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';

/** Table names the server uses to identify the record type (the `entity` of a link). */
export type CorrectionEntity =
  | 'sales' | 'expenses' | 'cash_transfers' | 'capital_entries' | 'owner_drawings' | 'telecom_topups' | 'printing_supplies'
  | 'icecream_payments' | 'icecream_fund_moves' | 'stock_losses';

/** Route prefix (relative to /api/v1) of each supported type; the three correction endpoints hang under it. */
export const CORRECTION_RESOURCE: Record<CorrectionEntity, string> = {
  sales: '/sales',
  expenses: '/expenses',
  cash_transfers: '/cash-transfers',
  capital_entries: '/capital-entries',
  owner_drawings: '/drawings',
  telecom_topups: '/telecom/topups',
  printing_supplies: '/printing-supplies',
  icecream_payments: '/icecream/payments',
  icecream_fund_moves: '/icecream/fund-moves',
  stock_losses: '/stock-losses',
};

/** GET correct-check: either "yes" or the existing void's own plain-language refusal (or CORRECTION_NOT_SUPPORTED). */
export type CorrectCheck = { eligible: true } | { eligible: false; code: string; message: string };

/** One stored link between a voided original and its replacement. */
export interface CorrectionLink {
  id: number;
  entity: CorrectionEntity;
  originalId: number;
  replacementId: number;
  reason: string;
  createdAt: string;
}

/** A non-blocking warning of the void or the create (negative cash, price below cost...). Every kind has a readable `message`. */
export interface CorrectionWarning { code?: string; message: string }

/**
 * Sales only: the original against the replacement. Cost snapshots can differ when stock was bought or sold in between
 * (weighted-average costing), which is why the screen shows the difference.
 */
export interface SaleComparison {
  originalCogsCents: number;
  replacementCogsCents: number;
  cogsDifferenceCents: number;
  originalExtraCostCents: number;
  replacementExtraCostCents: number;
  extraCostDifferenceCents: number;
  originalRevenueCents: number;
  replacementRevenueCents: number;
  lines: Array<{ productId: number; originalUnitCostCents: number; replacementUnitCostCents: number }>;
}

/** Body of correct-preview and correct. `replacement` is the type's normal create body (+ clientRef). */
export interface CorrectionBody { reason: string; replacement: Record<string, unknown> }

/** Answer of correct-preview. `R` is the record type of the screen (Expense, Sale, ...). */
export interface CorrectionPreview<R> { original: R; replacement: R; warnings: CorrectionWarning[]; comparison?: SaleComparison }
/** Answer of correct. */
export interface CorrectionApplied<R> extends CorrectionPreview<R> { correction: CorrectionLink }

/** Longest correction reason the server accepts (same limit as a void reason). */
export const MAX_CORRECTION_REASON = 200;

/** Root key of the correction-link caches (History badges). */
export const CORRECTIONS_KEY = ['corrections'] as const;

/** GET <resource>/:id/correct-check. Never retried and never cached: the answer depends on the current state of the books. */
export const useCorrectCheck = (resource: string, id: number) =>
  useQuery({
    queryKey: ['correct-check', resource, id],
    queryFn: () => apiGet<CorrectCheck>(`${resource}/${id}/correct-check`),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

/** POST <resource>/:id/correct-preview: a dry run (nothing is saved). */
export const useCorrectionPreview = <R,>(resource: string, id: number) =>
  useMutation({
    mutationFn: (body: CorrectionBody) => apiPost<CorrectionPreview<R>>(`${resource}/${id}/correct-preview`, body),
  });

/**
 * POST <resource>/:id/correct: void the original and create the replacement.
 * A correction can touch cash, stock, Ice Cream funds, reports and the audit log, so every cached query is marked stale
 * (only the screens currently on display refetch; the rest reload when next opened).
 */
export function useCorrect<R>(resource: string, id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CorrectionBody) => apiPost<CorrectionApplied<R>>(`${resource}/${id}/correct`, body),
    onSuccess: () => { void qc.invalidateQueries(); },
  });
}

/**
 * GET /corrections?entity=&ids=: the links of every record in `ids` (as original or as replacement), in one batch per visible list.
 * Disabled for an empty list. The server accepts at most 200 ids, so only the first 200 are asked for.
 */
export const useCorrectionLinks = (entity: CorrectionEntity, ids: number[]) => {
  const list = ids.slice(0, 200);
  return useQuery({
    queryKey: [...CORRECTIONS_KEY, entity, list.join(',')],
    queryFn: () => apiGet<{ items: CorrectionLink[] }>(`/corrections?entity=${entity}&ids=${list.join(',')}`),
    enabled: list.length > 0,
    placeholderData: (prev) => prev,
    // The badges are decoration: a missing endpoint (older server) or a hiccup must never break a History screen.
    retry: false,
  });
};
