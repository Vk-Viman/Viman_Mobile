/**
 * API hooks for stock control: valuation, stocktakes (physical counts), stock losses and personal-use drawings.
 *
 * Used by the Stock screens (pages/stock/*).
 * Endpoints: /inventory/valuation, /stocktakes, /stock-losses, /drawings (see API_CONTRACTS.md).
 * Every quantity/value effect (movements, cost, valuation) is calculated by the server in integer cents.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { catalogKeys } from './catalog';
import { purchaseKeys } from './purchases';
import { qs } from './queryString';
import type {
  DrawingCreate, DrawingList, DrawingOne, DrawingQuery, StockLossCreate, StockLossList, StockLossOne, StockLossQuery,
  StocktakeCreate, StocktakeList, StocktakeOne, StocktakeQuery, StocktakeUpdate, Valuation, ValuationQuery,
} from '../types/api';

/** Root query keys of the stock caches. */
export const stockKeys = {
  valuation: ['inventory', 'valuation'] as const,
  stocktakes: ['stocktakes'] as const,
  losses: ['stock-losses'] as const,
  drawings: ['drawings'] as const,
};

/**
 * Refreshes everything a stock write can change: the screen's own list (`list`), the valuation report, product
 * quantities, the movement ledger, the reconciliation check and the audit log.
 */
function invalidateStock(qc: QueryClient, list: readonly string[]) {
  void qc.invalidateQueries({ queryKey: list });
  void qc.invalidateQueries({ queryKey: stockKeys.valuation });
  void qc.invalidateQueries({ queryKey: catalogKeys.products });
  void qc.invalidateQueries({ queryKey: purchaseKeys.movements });
  void qc.invalidateQueries({ queryKey: purchaseKeys.reconciliation });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

/** GET /inventory/valuation: stock value report as of a date (filters in `query`). */
export const useValuation = (query: ValuationQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.valuation, query],
    queryFn: () => apiGet<Valuation>(`/inventory/valuation${qs(query)}`),
    placeholderData: (prev) => prev,
  });

// ---- Stocktakes ----

/** GET /stocktakes (list, filtered by `query`). */
export const useStocktakes = (query: StocktakeQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.stocktakes, 'list', query],
    queryFn: () => apiGet<StocktakeList>(`/stocktakes${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** GET /stocktakes/:id (one count sheet with its lines). Disabled while `id` is null. */
export const useStocktake = (id: number | null) =>
  useQuery({
    queryKey: [...stockKeys.stocktakes, 'detail', id],
    queryFn: () => apiGet<StocktakeOne>(`/stocktakes/${id}`),
    enabled: id !== null,
  });

/** POST /stocktakes: start a new count sheet (draft). */
export function useCreateStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StocktakeCreate) => apiPost<StocktakeOne>('/stocktakes', body),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

/** PUT /stocktakes/:id: save the counted quantities / notes of a draft sheet. */
export function useUpdateStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: StocktakeUpdate }) => apiPut<StocktakeOne>(`/stocktakes/${id}`, body),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

/** POST /stocktakes/:id/complete: finish the count; the server posts the stock adjustments. */
export function useCompleteStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiPost<StocktakeOne>(`/stocktakes/${id}/complete`, {}),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

/** POST /stocktakes/:id/void: cancel a stocktake (needs a reason); the server reverses its adjustments. */
export function useVoidStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<StocktakeOne>(`/stocktakes/${id}/void`, { reason }),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

// ---- Stock losses ----

/** GET /stock-losses (damaged / lost / expired stock written off). */
export const useStockLosses = (query: StockLossQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.losses, 'list', query],
    queryFn: () => apiGet<StockLossList>(`/stock-losses${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /stock-losses: write off stock. Reduces quantity at cost, so valuation and movements are refreshed. */
export function useCreateStockLoss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StockLossCreate) => apiPost<StockLossOne>('/stock-losses', body),
    onSuccess: () => invalidateStock(qc, stockKeys.losses),
  });
}

/** POST /stock-losses/:id/void: undo a write-off (needs a reason). */
export function useVoidStockLoss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<StockLossOne>(`/stock-losses/${id}/void`, { reason }),
    onSuccess: () => invalidateStock(qc, stockKeys.losses),
  });
}

// ---- Personal use (goods drawings) ----

/** GET /drawings (goods the owner took for personal use). */
export const useDrawings = (query: DrawingQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.drawings, 'list', query],
    queryFn: () => apiGet<DrawingList>(`/drawings${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /drawings: record goods taken for personal use (stock goes down at cost). */
export function useCreateDrawing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DrawingCreate) => apiPost<DrawingOne>('/drawings', body),
    onSuccess: () => invalidateStock(qc, stockKeys.drawings),
  });
}

/** POST /drawings/:id/void: undo a personal-use drawing (needs a reason). */
export function useVoidDrawing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<DrawingOne>(`/drawings/${id}/void`, { reason }),
    onSuccess: () => invalidateStock(qc, stockKeys.drawings),
  });
}
