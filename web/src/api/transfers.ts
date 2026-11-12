/**
 * API hooks for Phase 9: cash transfers between books, cash drawings and capital.
 *
 * Used by the Drawings screen (pages/drawings/*). Endpoints: /cash-transfers(/:id/void), /drawings (cash kind; both kinds are
 * listed), /drawings/:id/void, /capital, /capital-entries/:id/void (API_CONTRACTS.md "Wave 3 contracts - Phase 9").
 * Every one of these moves money in the cash books, so each write refreshes the cash book caches and the audit log. Drawings
 * share the `['drawings']` cache root with the Stock > Personal use screen, so a drawing recorded on either screen refreshes both.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { CASHBOOKS_KEY } from './cashbooks';
import { qs } from './queryString';
import type { CapitalEntryResult } from '../types/cashbooks';
import type {
  CapitalCreate, CapitalList, CapitalQuery, CapitalVoidResult, CashDrawingCreate, CashDrawingResult, CashDrawingVoided, OwnerDrawingList,
  OwnerDrawingQuery, TransferCreate, TransferList, TransferQuery, TransferResult,
} from '../types/transfers';

/** Cache roots, so one invalidation refreshes a whole tab. */
export const DRAWINGS_KEY = ['drawings'] as const;
export const CAPITAL_KEY = ['capital'] as const;
export const TRANSFERS_KEY = ['cash-transfers'] as const;

/** Refreshes the cash books, the audit log and the given record cache (money moved, so every book figure may differ). */
function invalidateMoney(qc: QueryClient, root: readonly string[]) {
  void qc.invalidateQueries({ queryKey: root });
  void qc.invalidateQueries({ queryKey: CASHBOOKS_KEY });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

// ---- Drawings ----

/** GET /drawings: cash and goods drawings together (filter with `kind`), with totals split into goods and cash. */
export const useOwnerDrawings = (query: OwnerDrawingQuery = {}) =>
  useQuery({
    queryKey: [...DRAWINGS_KEY, 'owner-list', query],
    queryFn: () => apiGet<OwnerDrawingList>(`/drawings${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /drawings (kind "cash"): take money out of a book; the answer carries the negative-balance warnings (R13). */
export function useCreateCashDrawing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CashDrawingCreate) => apiPost<CashDrawingResult>('/drawings', body),
    onSuccess: () => invalidateMoney(qc, DRAWINGS_KEY),
  });
}

/** POST /drawings/:id/void: cancel a cash drawing (reason required); the server posts a reversing cash entry. */
export function useVoidCashDrawing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<CashDrawingVoided>(`/drawings/${id}/void`, { reason }),
    onSuccess: () => invalidateMoney(qc, DRAWINGS_KEY),
  });
}

// ---- Capital ----

/** GET /capital: capital and opening balances (filter with `kind`), with the total of the posted ones. */
export const useCapital = (query: CapitalQuery = {}) =>
  useQuery({
    queryKey: [...CAPITAL_KEY, 'list', query],
    queryFn: () => apiGet<CapitalList>(`/capital${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /capital: the owner puts money into a book (Ice Cream: into a fund). Never revenue or profit. */
export function useCreateCapital() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CapitalCreate) => apiPost<CapitalEntryResult>('/capital', body),
    onSuccess: () => invalidateMoney(qc, CAPITAL_KEY),
  });
}

/** POST /capital-entries/:id/void: cancel a capital entry or opening balance (reason required); may return a negative-balance warning. */
export function useVoidCapital() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<CapitalVoidResult>(`/capital-entries/${id}/void`, { reason }),
    onSuccess: () => invalidateMoney(qc, CAPITAL_KEY),
  });
}

// ---- Transfers ----

/** GET /cash-transfers: transfers (history), `book` matches either side; totals count posted transfers only. */
export const useTransfers = (query: TransferQuery = {}) =>
  useQuery({
    queryKey: [...TRANSFERS_KEY, 'list', query],
    queryFn: () => apiGet<TransferList>(`/cash-transfers${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /cash-transfers: move money from one book to another (two linked cash entries); the answer carries the warnings (R13). */
export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TransferCreate) => apiPost<TransferResult>('/cash-transfers', body),
    onSuccess: () => invalidateMoney(qc, TRANSFERS_KEY),
  });
}

/** POST /cash-transfers/:id/void: cancel a transfer (reason required); the server reverses both legs. */
export function useVoidTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<TransferResult>(`/cash-transfers/${id}/void`, { reason }),
    onSuccess: () => invalidateMoney(qc, TRANSFERS_KEY),
  });
}
