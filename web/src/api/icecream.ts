/**
 * API hooks for Ice Cream (Phase 10): daily entries, payments, fund moves, funds summary and the fund ledger.
 *
 * Used by the Ice Cream screens (pages/icecream/*). Endpoints: /icecream/days(/:date, /:date/void), /icecream/payments(/:id/void),
 * /icecream/fund-moves(/preview, /:id/void), /icecream/funds(/entries) (API_CONTRACTS.md "Wave 3 contracts - Phase 10").
 * Every Ice Cream write moves the fund balances and the Ice Cream cash book, so each write refreshes ALL Ice Cream data, the
 * cash books and the audit log. The server calculates every figure and enforces every rule (E1-E5, D1-D4, R9, R-FD).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { CASHBOOKS_KEY } from './cashbooks';
import { qs } from './queryString';
import type {
  DayCreate, DayList, DayQuery, DayReplace, DayWriteResult, FundLedger, FundLedgerQuery, FundsQuery, FundsSummary, IceDay, IceMove,
  IcePayment, MoveCreate, MoveList, MovePreview, MovePreviewBody, MoveQuery, MoveWriteResult, PaymentCreate, PaymentList, PaymentQuery,
  PaymentWriteResult, WriteExtras,
} from '../types/icecream';

/** Root of every Ice Cream query key, so one invalidation refreshes the whole screen. */
export const ICECREAM_KEY = ['icecream'] as const;

function invalidateIceCream(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ICECREAM_KEY });
  void qc.invalidateQueries({ queryKey: CASHBOOKS_KEY });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

// ---- funds ----

/** GET /icecream/funds: fund balances, Charged / Settled / Unspent, recognized profit, excess cost and the period-flow lines. */
export const useFunds = (query: FundsQuery = {}) =>
  useQuery({
    queryKey: [...ICECREAM_KEY, 'funds', query], queryFn: () => apiGet<FundsSummary>(`/icecream/funds${qs(query)}`),
    placeholderData: (prev) => prev, staleTime: 0,
  });

/** GET /icecream/funds/entries: the complete fund ledger (reversals included), paged. */
export const useFundLedger = (query: FundLedgerQuery = {}) =>
  useQuery({
    queryKey: [...ICECREAM_KEY, 'ledger', query], queryFn: () => apiGet<FundLedger>(`/icecream/funds/entries${qs(query)}`),
    placeholderData: (prev) => prev, staleTime: 0,
  });

// ---- daily entries ----

/** GET /icecream/days: daily entries (posted and void), newest first, with totals of the posted ones. */
export const useDays = (query: DayQuery = {}) =>
  useQuery({
    queryKey: [...ICECREAM_KEY, 'days', query], queryFn: () => apiGet<DayList>(`/icecream/days${qs(query)}`),
    placeholderData: (prev) => prev, staleTime: 0,
  });

/** POST /icecream/days: a new daily entry (the server computes the profit share). */
export function useCreateDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DayCreate) => apiPost<DayWriteResult>('/icecream/days', body),
    onSuccess: () => invalidateIceCream(qc),
  });
}

/** PUT /icecream/days/:date: void-and-replace the posted entry of a date (one transaction on the server). */
export function useReplaceDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ date, body }: { date: string; body: DayReplace }) => apiPut<DayWriteResult>(`/icecream/days/${date}`, body),
    onSuccess: () => invalidateIceCream(qc),
  });
}

/** POST /icecream/days/:date/void: cancel the posted entry of a date (reason required). */
export function useVoidDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ date, reason }: { date: string; reason: string }) => apiPost<WriteExtras & { day: IceDay }>(`/icecream/days/${date}/void`, { reason }),
    onSuccess: () => invalidateIceCream(qc),
  });
}

// ---- payments ----

/** GET /icecream/payments: payment history, filtered and paged, with the total of the posted ones. */
export const usePayments = (query: PaymentQuery = {}) =>
  useQuery({
    queryKey: [...ICECREAM_KEY, 'payments', query], queryFn: () => apiGet<PaymentList>(`/icecream/payments${qs(query)}`),
    placeholderData: (prev) => prev, staleTime: 0,
  });

/** POST /icecream/payments: materials, the electricity bill or another cost, paid from the chosen fund. */
export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PaymentCreate) => apiPost<PaymentWriteResult>('/icecream/payments', body),
    onSuccess: () => invalidateIceCream(qc),
  });
}

/** POST /icecream/payments/:id/void: cancel a payment (reason required); the server posts reversals. */
export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<WriteExtras & { payment: IcePayment }>(`/icecream/payments/${id}/void`, { reason }),
    onSuccess: () => invalidateIceCream(qc),
  });
}

// ---- fund moves ----

/** GET /icecream/fund-moves: move history, filtered and paged. */
export const useMoves = (query: MoveQuery = {}) =>
  useQuery({
    queryKey: [...ICECREAM_KEY, 'moves', query], queryFn: () => apiGet<MoveList>(`/icecream/fund-moves${qs(query)}`),
    placeholderData: (prev) => prev, staleTime: 0,
  });

/**
 * POST /icecream/fund-moves/preview: what a move would do (profit-eligible / cash-only split, re-label, explanation). Writes nothing.
 * Asked only for a complete, valid request (`body` null = not ready). It is a POST used as a read, so it never refetches by itself
 * on focus; the saved-data keys are invalidated by the writes, which keeps the preview in step with the books.
 */
export const useMovePreview = (body: MovePreviewBody | null) =>
  useQuery({
    queryKey: [...ICECREAM_KEY, 'preview', body],
    queryFn: () => apiPost<MovePreview>('/icecream/fund-moves/preview', body),
    enabled: body !== null,
    staleTime: 0,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

/** POST /icecream/fund-moves: post a move (D4: a split above the profit-eligible limit must carry the owner's confirmation). */
export function useCreateMove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MoveCreate) => apiPost<MoveWriteResult>('/icecream/fund-moves', body),
    onSuccess: () => invalidateIceCream(qc),
  });
}

/** POST /icecream/fund-moves/:id/void: cancel a move (reason required); the server may refuse with VOID_BREAKS_RELEASE (D2). */
export function useVoidMove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<WriteExtras & { move: IceMove }>(`/icecream/fund-moves/${id}/void`, { reason }),
    onSuccess: () => invalidateIceCream(qc),
  });
}
