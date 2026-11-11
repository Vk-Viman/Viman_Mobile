/**
 * API hooks for sales: the POS (create sale), sales history, voids and sales returns.
 *
 * Used by the Sales screens (pages/sales/*).
 * Endpoints: /sales, /sales/:id, /sales/:id/void, /sales/:id/returns (see API_CONTRACTS.md "Phase 5";
 * business rules §4, R5/C5, R13, R-FD, R-RD in BUSINESS_RULES.md).
 *
 * Money is integer cents everywhere. The server is authoritative for totals, COGS, profit and refunds; the web
 * only sends quantities and unit prices (and, since C13, a unit cost only when the cashier raised it above the
 * automatic cost; the server enforces cost >= automatic and returns extra/charged cost fields).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { catalogKeys } from './catalog';
import { purchaseKeys } from './purchases';
import { stockKeys } from './stock';
import { qs } from './queryString';
import type {
  SaleCreate, SaleCreateResult, SaleList, SaleOne, SaleQuery, SaleReturnCreate, SaleReturnResult, SaleVoidBody,
} from '../types/api';

/** Root query key of every sales cache (list and detail). */
export const salesKeys = { all: ['sales'] as const };

/**
 * Refreshes everything a sale / void / return can change: sales lists, product quantities, valuation, the movement
 * ledger, stock losses (damaged returns write one), the reconciliation check and the audit log.
 * One shared function so no write can forget one of them.
 */
function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: salesKeys.all });
  void qc.invalidateQueries({ queryKey: catalogKeys.products });
  void qc.invalidateQueries({ queryKey: stockKeys.valuation });
  void qc.invalidateQueries({ queryKey: purchaseKeys.movements });
  void qc.invalidateQueries({ queryKey: stockKeys.losses });
  void qc.invalidateQueries({ queryKey: purchaseKeys.reconciliation });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

/** GET /sales (filters and paging in `query`); the response also carries totals over all matching posted sales. */
export const useSales = (query: SaleQuery = {}) =>
  useQuery({
    queryKey: [...salesKeys.all, 'list', query],
    queryFn: () => apiGet<SaleList>(`/sales${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** GET /sales/:id (one sale with lines and returns). Disabled while `id` is null. */
export const useSale = (id: number | null) =>
  useQuery({
    queryKey: [...salesKeys.all, 'detail', id],
    queryFn: () => apiGet<SaleOne>(`/sales/${id}`),
    enabled: id !== null,
  });

/** POST /sales: save a cart (one sale per book). Returns the sales plus non-blocking warnings. */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaleCreate) => apiPost<SaleCreateResult>('/sales', body),
    onSuccess: () => invalidateAll(qc),
  });
}

/** POST /sales/:id/void: cancel a whole sale (needs a reason). Same invalidation as creating one. */
export function useVoidSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: SaleVoidBody }) => apiPost<SaleOne>(`/sales/${id}/void`, body),
    onSuccess: () => invalidateAll(qc),
  });
}

/** POST /sales/:id/returns: take items back from a customer (resalable or damaged). Same invalidation. */
export function useCreateSaleReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: SaleReturnCreate }) =>
      apiPost<SaleReturnResult>(`/sales/${id}/returns`, body),
    onSuccess: () => invalidateAll(qc),
  });
}
