/**
 * API hooks for purchases (buying stock from suppliers), purchase voids/returns, and the stock-movement ledger.
 *
 * Used by the Purchases screen (pages/purchases/*) and the stock screens.
 * Endpoints: /purchases, /purchases/:id/void, /purchases/:id/returns, /products/:id/movements,
 * /inventory/reconciliation (see API_CONTRACTS.md; business rules R1, R4, R-FD, R-RD in BUSINESS_RULES.md).
 *
 * All money in requests and responses is integer cents; the server computes every total, cost and stock effect.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { catalogKeys } from './catalog';
import { qs } from './queryString';
import type {
  InventoryReconciliation, MovementList, MovementQuery, PurchaseCreate, PurchaseList, PurchaseOne, PurchaseQuery,
  PurchaseReturnCreate, PurchaseReturnResult, PurchaseVoidBody,
} from '../types/api';

/** Root query keys for purchase-related caches (also imported by stock.ts to refresh them after stock changes). */
export const purchaseKeys = {
  all: ['purchases'] as const,
  movements: ['stock-movements'] as const,
  reconciliation: ['inventory', 'reconciliation'] as const,
};

/**
 * Refreshes everything a purchase / void / return can change: the purchase lists, product quantities and
 * costs, the stock-movement ledger, the inventory reconciliation check and the audit log.
 * One shared function so no write can forget one of them.
 */
function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: purchaseKeys.all });
  void qc.invalidateQueries({ queryKey: catalogKeys.products });
  void qc.invalidateQueries({ queryKey: purchaseKeys.movements });
  void qc.invalidateQueries({ queryKey: purchaseKeys.reconciliation });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

/** GET /purchases (date range / supplier / status filters in `query`). */
export const usePurchases = (query: PurchaseQuery = {}) =>
  useQuery({
    queryKey: [...purchaseKeys.all, 'list', query],
    queryFn: () => apiGet<PurchaseList>(`/purchases${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** GET /purchases/:id (full purchase with lines and returns). Disabled while `id` is null. */
export const usePurchase = (id: number | null) =>
  useQuery({
    queryKey: [...purchaseKeys.all, 'detail', id],
    queryFn: () => apiGet<PurchaseOne>(`/purchases/${id}`),
    enabled: id !== null,
  });

/** POST /purchases: record a new purchase. Invalidates purchases, products, movements, reconciliation, audit. */
export function useCreatePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PurchaseCreate) => apiPost<PurchaseOne>('/purchases', body),
    onSuccess: () => invalidateAll(qc),
  });
}

/** POST /purchases/:id/void: cancel a whole purchase (needs a reason). Same invalidation as creating one. */
export function useVoidPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: PurchaseVoidBody }) => apiPost<PurchaseOne>(`/purchases/${id}/void`, body),
    onSuccess: () => invalidateAll(qc),
  });
}

/** POST /purchases/:id/returns: return goods to the supplier (full or partial). Same invalidation as creating one. */
export function useCreatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: PurchaseReturnCreate }) =>
      apiPost<PurchaseReturnResult>(`/purchases/${id}/returns`, body),
    onSuccess: () => invalidateAll(qc),
  });
}

/** GET /products/:id/movements: the stock ledger (every quantity change) of one product. Disabled while no product. */
export const useProductMovements = (productId: number | null, query: MovementQuery = {}) =>
  useQuery({
    queryKey: [...purchaseKeys.movements, productId, query],
    queryFn: () => apiGet<MovementList>(`/products/${productId}/movements${qs(query)}`),
    enabled: productId !== null,
    placeholderData: (prev) => prev,
  });

/**
 * GET /inventory/reconciliation: server-side check that stock quantities and values add up to the ledger.
 * @param enabled set false to skip the request (e.g. until the user opens the section that shows it).
 */
export const useInventoryReconciliation = (enabled = true) =>
  useQuery({
    queryKey: purchaseKeys.reconciliation,
    queryFn: () => apiGet<InventoryReconciliation>('/inventory/reconciliation'),
    enabled,
  });
