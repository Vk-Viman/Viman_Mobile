import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import { catalogKeys } from './catalog';
import { purchaseKeys } from './purchases';
import type {
  DrawingCreate, DrawingList, DrawingOne, DrawingQuery, StockLossCreate, StockLossList, StockLossOne, StockLossQuery,
  StocktakeCreate, StocktakeList, StocktakeOne, StocktakeQuery, StocktakeUpdate, Valuation, ValuationQuery,
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

export const stockKeys = {
  valuation: ['inventory', 'valuation'] as const,
  stocktakes: ['stocktakes'] as const,
  losses: ['stock-losses'] as const,
  drawings: ['drawings'] as const,
};

function invalidateStock(qc: QueryClient, list: readonly string[]) {
  void qc.invalidateQueries({ queryKey: list });
  void qc.invalidateQueries({ queryKey: stockKeys.valuation });
  void qc.invalidateQueries({ queryKey: catalogKeys.products });
  void qc.invalidateQueries({ queryKey: purchaseKeys.movements });
  void qc.invalidateQueries({ queryKey: purchaseKeys.reconciliation });
  void qc.invalidateQueries({ queryKey: ['audit-logs'] });
}

export const useValuation = (query: ValuationQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.valuation, query],
    queryFn: () => apiGet<Valuation>(`/inventory/valuation${qs(query)}`),
    placeholderData: (prev) => prev,
  });

// ---- Stocktakes ----
export const useStocktakes = (query: StocktakeQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.stocktakes, 'list', query],
    queryFn: () => apiGet<StocktakeList>(`/stocktakes${qs(query)}`),
    placeholderData: (prev) => prev,
  });

export const useStocktake = (id: number | null) =>
  useQuery({
    queryKey: [...stockKeys.stocktakes, 'detail', id],
    queryFn: () => apiGet<StocktakeOne>(`/stocktakes/${id}`),
    enabled: id !== null,
  });

export function useCreateStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StocktakeCreate) => apiPost<StocktakeOne>('/stocktakes', body),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

export function useUpdateStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: StocktakeUpdate }) => apiPut<StocktakeOne>(`/stocktakes/${id}`, body),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

export function useCompleteStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiPost<StocktakeOne>(`/stocktakes/${id}/complete`, {}),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

export function useVoidStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<StocktakeOne>(`/stocktakes/${id}/void`, { reason }),
    onSuccess: () => invalidateStock(qc, stockKeys.stocktakes),
  });
}

// ---- Stock losses ----
export const useStockLosses = (query: StockLossQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.losses, 'list', query],
    queryFn: () => apiGet<StockLossList>(`/stock-losses${qs(query)}`),
    placeholderData: (prev) => prev,
  });

export function useCreateStockLoss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StockLossCreate) => apiPost<StockLossOne>('/stock-losses', body),
    onSuccess: () => invalidateStock(qc, stockKeys.losses),
  });
}

export function useVoidStockLoss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<StockLossOne>(`/stock-losses/${id}/void`, { reason }),
    onSuccess: () => invalidateStock(qc, stockKeys.losses),
  });
}

// ---- Personal use (goods drawings) ----
export const useDrawings = (query: DrawingQuery = {}) =>
  useQuery({
    queryKey: [...stockKeys.drawings, 'list', query],
    queryFn: () => apiGet<DrawingList>(`/drawings${qs(query)}`),
    placeholderData: (prev) => prev,
  });

export function useCreateDrawing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DrawingCreate) => apiPost<DrawingOne>('/drawings', body),
    onSuccess: () => invalidateStock(qc, stockKeys.drawings),
  });
}

export function useVoidDrawing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<DrawingOne>(`/drawings/${id}/void`, { reason }),
    onSuccess: () => invalidateStock(qc, stockKeys.drawings),
  });
}
