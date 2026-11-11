/**
 * API hooks for opening stock (go-live starting stock): manual batches, batch history, void, and the Excel import.
 *
 * Used by the Opening Stock screen (pages/opening-stock/*).
 * Endpoints: /opening-stock, /opening-stock/:id, /opening-stock/:id/void, /excel/opening-stock-template,
 * /excel/opening-stock/preview, /excel/opening-stock/import (see API_CONTRACTS.md "Phase 13").
 * Rules (BUSINESS_RULES section 3, R1, R-FD): opening stock adds quantity and exact value to a product, creates no
 * cash entry or purchase, and a void reverses it. The server calculates every value; money is integer cents.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPostForm } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { catalogKeys } from './catalog';
import { purchaseKeys } from './purchases';
import { qs } from './queryString';
import { stockKeys } from './stock';
import type {
  ImportPreview, ImportResult, OpeningBatchDetail, OpeningStockCreate, OpeningStockList, OpeningStockQuery,
} from '../types/openingStock';

/** Root query key of the opening stock caches. */
export const openingKeys = { all: ['opening-stock'] as const };

/** Where the browser downloads the Excel template from (a plain link; the server sends it as an attachment). */
export const OPENING_TEMPLATE_URL = '/api/v1/excel/opening-stock-template';

/**
 * Refreshes everything an opening stock write can change: the batch list, product quantities and values, the
 * valuation report, the movement ledger, the reconciliation check and the audit log.
 */
function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: openingKeys.all });
  void qc.invalidateQueries({ queryKey: catalogKeys.products });
  void qc.invalidateQueries({ queryKey: stockKeys.valuation });
  void qc.invalidateQueries({ queryKey: purchaseKeys.movements });
  void qc.invalidateQueries({ queryKey: purchaseKeys.reconciliation });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

/** GET /opening-stock (date range / status filters in `query`). */
export const useOpeningBatches = (query: OpeningStockQuery = {}) =>
  useQuery({
    queryKey: [...openingKeys.all, 'list', query],
    queryFn: () => apiGet<OpeningStockList>(`/opening-stock${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** GET /opening-stock/:id (a batch with its lines). Disabled while `id` is null. */
export const useOpeningBatch = (id: number | null) =>
  useQuery({
    queryKey: [...openingKeys.all, 'detail', id],
    queryFn: () => apiGet<{ item: OpeningBatchDetail }>(`/opening-stock/${id}`),
    enabled: id !== null,
  });

/** POST /opening-stock: save a manual batch. Invalidates every stock cache. */
export function useCreateOpeningStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OpeningStockCreate) => apiPost<{ item: OpeningBatchDetail }>('/opening-stock', body),
    onSuccess: () => invalidateAll(qc),
  });
}

/** POST /opening-stock/:id/void: reverse a whole batch (needs a reason; refused when the stock was already used). */
export function useVoidOpeningBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      apiPost<{ item: OpeningBatchDetail }>(`/opening-stock/${id}/void`, { reason }),
    onSuccess: () => invalidateAll(qc),
  });
}

/** Builds the multipart form of an upload. The date is optional (the server then uses today). */
function uploadForm(file: File, businessDate: string, clientRef?: string): FormData {
  const form = new FormData();
  form.append('file', file);
  if (businessDate) form.append('businessDate', businessDate);
  if (clientRef) form.append('clientRef', clientRef);
  return form;
}

/** POST /excel/opening-stock/preview: checks the file row by row. Nothing is saved to stock. */
export function usePreviewOpeningImport() {
  return useMutation({
    mutationFn: ({ file, businessDate }: { file: File; businessDate: string }) =>
      apiPostForm<ImportPreview>('/excel/opening-stock/preview', uploadForm(file, businessDate)),
  });
}

/** POST /excel/opening-stock/import: all-or-nothing import of the file as one batch. */
export function useImportOpeningStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, businessDate, clientRef }: { file: File; businessDate: string; clientRef: string }) =>
      apiPostForm<ImportResult>('/excel/opening-stock/import', uploadForm(file, businessDate, clientRef)),
    onSuccess: () => invalidateAll(qc),
  });
}
