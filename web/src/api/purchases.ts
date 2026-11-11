import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import { catalogKeys } from './catalog';
import type {
  InventoryReconciliation, MovementList, MovementQuery, PurchaseCreate, PurchaseList, PurchaseOne, PurchaseQuery,
  PurchaseReturnCreate, PurchaseReturnResult, PurchaseVoidBody,
} from '../types/api';

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const purchaseKeys = {
  all: ['purchases'] as const,
  movements: ['stock-movements'] as const,
  reconciliation: ['inventory', 'reconciliation'] as const,
};

function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: purchaseKeys.all });
  void qc.invalidateQueries({ queryKey: catalogKeys.products });
  void qc.invalidateQueries({ queryKey: purchaseKeys.movements });
  void qc.invalidateQueries({ queryKey: purchaseKeys.reconciliation });
  void qc.invalidateQueries({ queryKey: ['audit-logs'] });
}

export const usePurchases = (query: PurchaseQuery = {}) =>
  useQuery({
    queryKey: [...purchaseKeys.all, 'list', query],
    queryFn: () => apiGet<PurchaseList>(`/purchases${qs(query)}`),
    placeholderData: (prev) => prev,
  });

export const usePurchase = (id: number | null) =>
  useQuery({
    queryKey: [...purchaseKeys.all, 'detail', id],
    queryFn: () => apiGet<PurchaseOne>(`/purchases/${id}`),
    enabled: id !== null,
  });

export function useCreatePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PurchaseCreate) => apiPost<PurchaseOne>('/purchases', body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useVoidPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: PurchaseVoidBody }) => apiPost<PurchaseOne>(`/purchases/${id}/void`, body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useCreatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: PurchaseReturnCreate }) =>
      apiPost<PurchaseReturnResult>(`/purchases/${id}/returns`, body),
    onSuccess: () => invalidateAll(qc),
  });
}

export const useProductMovements = (productId: number | null, query: MovementQuery = {}) =>
  useQuery({
    queryKey: [...purchaseKeys.movements, productId, query],
    queryFn: () => apiGet<MovementList>(`/products/${productId}/movements${qs(query)}`),
    enabled: productId !== null,
    placeholderData: (prev) => prev,
  });

export const useInventoryReconciliation = (enabled = true) =>
  useQuery({
    queryKey: purchaseKeys.reconciliation,
    queryFn: () => apiGet<InventoryReconciliation>('/inventory/reconciliation'),
    enabled,
  });
