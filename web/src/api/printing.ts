/**
 * API hooks for Printing: service types (price list), print sales and printing supplies.
 *
 * Used by the Printing screens (pages/printing/*).
 * Endpoints: /print-service-types, /print-sales, /printing-supplies (see API_CONTRACTS.md, Phase 7).
 * Every amount (revenue, standard cost, profit, totals) is calculated by the server in integer cents.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { qs } from './queryString';
import type {
  PrintSaleCreate, PrintSaleList, PrintSaleOne, PrintSaleQuery, PrintSaleVoidOne, PrintServiceTypeCreate,
  PrintServiceTypeList, PrintServiceTypeOne, PrintServiceTypeUpdate, PrintingSupplyCreate, PrintingSupplyList,
  PrintingSupplyOne, PrintingSupplyQuery, PrintingSupplyVoidOne,
} from '../types/printing';

/** Root query keys of the printing caches. */
export const printingKeys = {
  types: ['print-service-types'] as const,
  sales: ['print-sales'] as const,
  supplies: ['printing-supplies'] as const,
};

/** Refreshes a screen's own list and the audit log (every write adds audit rows on the server). */
function invalidate(qc: QueryClient, key: readonly string[]) {
  void qc.invalidateQueries({ queryKey: key });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

// ---- Service types ----

/** GET /print-service-types (`activeOnly` = only the types that can be sold). */
export const usePrintServiceTypes = (activeOnly = false) =>
  useQuery({
    queryKey: [...printingKeys.types, activeOnly ? 'active' : 'all'],
    queryFn: () => apiGet<PrintServiceTypeList>(`/print-service-types${qs({ active: activeOnly ? true : undefined })}`),
  });

/** POST /print-service-types: add a service type to the price list. */
export function useCreatePrintServiceType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PrintServiceTypeCreate) => apiPost<PrintServiceTypeOne>('/print-service-types', body),
    onSuccess: () => invalidate(qc, printingKeys.types),
  });
}

/** PUT /print-service-types/:id: change name, price, standard cost or active flag (past sales never change). */
export function useUpdatePrintServiceType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: PrintServiceTypeUpdate }) =>
      apiPut<PrintServiceTypeOne>(`/print-service-types/${id}`, body),
    onSuccess: () => invalidate(qc, printingKeys.types),
  });
}

// ---- Print sales ----

/** GET /print-sales (history + totals of the posted sales matching `query`). */
export const usePrintSales = (query: PrintSaleQuery = {}) =>
  useQuery({
    queryKey: [...printingKeys.sales, 'list', query],
    queryFn: () => apiGet<PrintSaleList>(`/print-sales${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /print-sales: record a print sale (shop cash goes up by the revenue). */
export function useCreatePrintSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PrintSaleCreate) => apiPost<PrintSaleOne>('/print-sales', body),
    onSuccess: () => invalidate(qc, printingKeys.sales),
  });
}

/** POST /print-sales/:id/void: cancel a print sale (needs a reason); the server posts a reversing cash entry. */
export function useVoidPrintSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<PrintSaleVoidOne>(`/print-sales/${id}/void`, { reason }),
    onSuccess: () => invalidate(qc, printingKeys.sales),
  });
}

// ---- Printing supplies ----

/** GET /printing-supplies (paper / toner purchases + total of the posted ones matching `query`). */
export const usePrintingSupplies = (query: PrintingSupplyQuery = {}) =>
  useQuery({
    queryKey: [...printingKeys.supplies, 'list', query],
    queryFn: () => apiGet<PrintingSupplyList>(`/printing-supplies${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /printing-supplies: record a paper / toner purchase (shop cash goes down; no profit effect). */
export function useCreatePrintingSupply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PrintingSupplyCreate) => apiPost<PrintingSupplyOne>('/printing-supplies', body),
    onSuccess: () => invalidate(qc, printingKeys.supplies),
  });
}

/** POST /printing-supplies/:id/void: cancel a supplies purchase (needs a reason); the money returns to the shop cash book. */
export function useVoidPrintingSupply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      apiPost<PrintingSupplyVoidOne>(`/printing-supplies/${id}/void`, { reason }),
    onSuccess: () => invalidate(qc, printingKeys.supplies),
  });
}
