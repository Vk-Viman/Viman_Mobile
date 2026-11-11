/**
 * API hooks for Telecom: reload providers and their rates, reload sales, EZCash entries, top-ups and the summary.
 *
 * Used by the Telecom screens (pages/telecom/*).
 * Endpoints: /reload-providers, /reload-sales, /ezcash-sales, /telecom/topups, /telecom/summary (API_CONTRACTS.md).
 * The server calculates commission and totals in integer cents; these hooks only fetch and send.
 * Every write refreshes ALL telecom caches (lists, summary, providers) and the audit log, because one save changes
 * the list, the totals and the summary header at once.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { qs } from './queryString';
import type {
  EzCashSaleCreate, EzCashSaleList, EzCashSaleOne, EzCashSaleQuery, ProviderList, ProviderOne, ProviderUpdate,
  ReloadSaleCreate, ReloadSaleList, ReloadSaleOne, ReloadSaleQuery, TelecomSummary, TelecomSummaryQuery, TopupCreate,
  TopupList, TopupOne, TopupQuery,
} from '../types/telecom';

/** Root of every telecom query key, so one invalidation refreshes the whole section. */
export const TELECOM_KEY = ['telecom'] as const;

function invalidateTelecom(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: TELECOM_KEY });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

// ---- Providers ----

/** GET /reload-providers: the four providers with their effective commission rates. */
export const useReloadProviders = () =>
  useQuery({ queryKey: [...TELECOM_KEY, 'providers'], queryFn: () => apiGet<ProviderList>('/reload-providers') });

/** PUT /reload-providers/:id: change a provider's own rate (null = shop default) or switch it on/off. */
export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ProviderUpdate }) => apiPut<ProviderOne>(`/reload-providers/${id}`, body),
    onSuccess: () => invalidateTelecom(qc),
  });
}

// ---- Reload sales ----

/** GET /reload-sales (history, filtered and paged by `query`). */
export const useReloadSales = (query: ReloadSaleQuery = {}) =>
  useQuery({
    queryKey: [...TELECOM_KEY, 'reload-sales', query],
    queryFn: () => apiGet<ReloadSaleList>(`/reload-sales${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /reload-sales: record a day's reload collection for one provider. */
export function useCreateReloadSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReloadSaleCreate) => apiPost<ReloadSaleOne>('/reload-sales', body),
    onSuccess: () => invalidateTelecom(qc),
  });
}

/** POST /reload-sales/:id/void: cancel an entry (reason required); the server posts a reversal. */
export function useVoidReloadSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<ReloadSaleOne>(`/reload-sales/${id}/void`, { reason }),
    onSuccess: () => invalidateTelecom(qc),
  });
}

// ---- EZCash ----

/** GET /ezcash-sales (history). */
export const useEzCashSales = (query: EzCashSaleQuery = {}) =>
  useQuery({
    queryKey: [...TELECOM_KEY, 'ezcash-sales', query],
    queryFn: () => apiGet<EzCashSaleList>(`/ezcash-sales${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /ezcash-sales: record EZCash bills collected (provider is Dialog automatically). */
export function useCreateEzCashSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EzCashSaleCreate) => apiPost<EzCashSaleOne>('/ezcash-sales', body),
    onSuccess: () => invalidateTelecom(qc),
  });
}

/** POST /ezcash-sales/:id/void. */
export function useVoidEzCashSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<EzCashSaleOne>(`/ezcash-sales/${id}/void`, { reason }),
    onSuccess: () => invalidateTelecom(qc),
  });
}

// ---- Top-ups ----

/** GET /telecom/topups (history). */
export const useTopups = (query: TopupQuery = {}) =>
  useQuery({
    queryKey: [...TELECOM_KEY, 'topups', query],
    queryFn: () => apiGet<TopupList>(`/telecom/topups${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /telecom/topups: record cash paid out to a provider or to the EZCash wallet. */
export function useCreateTopup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TopupCreate) => apiPost<TopupOne>('/telecom/topups', body),
    onSuccess: () => invalidateTelecom(qc),
  });
}

/** POST /telecom/topups/:id/void. */
export function useVoidTopup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<TopupOne>(`/telecom/topups/${id}/void`, { reason }),
    onSuccess: () => invalidateTelecom(qc),
  });
}

// ---- Summary ----

/** GET /telecom/summary: posted telecom figures for the period (revenue = commission only). */
export const useTelecomSummary = (query: TelecomSummaryQuery = {}) =>
  useQuery({
    queryKey: [...TELECOM_KEY, 'summary', query],
    queryFn: () => apiGet<TelecomSummary>(`/telecom/summary${qs(query)}`),
    placeholderData: (prev) => prev,
  });
