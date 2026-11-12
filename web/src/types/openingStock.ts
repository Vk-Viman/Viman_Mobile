/**
 * Types for the Opening Stock screens (Phase 13): manual batches and the Excel import.
 *
 * They mirror the server's responses (API_CONTRACTS.md "Phase 13"). All money is integer cents; the server
 * calculates every value, the screens only display it. Kept in its own file so the shared `types/api.ts`
 * (owned by the orchestrator) is not touched by this phase.
 */
import type { PostedStatus } from './api';

/** Where a batch came from. */
export type OpeningSource = 'manual' | 'excel';

/** One line of a batch; `unitCostCents` is the rounded value / quantity (display only). */
export interface OpeningLine {
  productId: number;
  productCode: string | null;
  productName: string;
  qty: number;
  valueCents: number;
  unitCostCents: number;
}

/** A batch header (as listed). */
export interface OpeningBatch {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  source: OpeningSource;
  fileName: string | null;
  rowCount: number;
  totalValueCents: number;
  status: PostedStatus;
  notes: string;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
}

/** A batch with its lines (GET /opening-stock/:id and the create / import answers). */
export interface OpeningBatchDetail extends OpeningBatch {
  items: OpeningLine[];
}

/** One line of POST /opening-stock: exactly one of `unitCostCents` / `totalValueCents`. */
export interface OpeningStockLineCreate {
  productId: number;
  qty: number;
  unitCostCents?: number;
  totalValueCents?: number;
}

/** Body of POST /opening-stock. */
export interface OpeningStockCreate {
  businessDate: string;
  items: OpeningStockLineCreate[];
  notes?: string;
  clientRef: string;
}

/** Filters of GET /opening-stock. */
export interface OpeningStockQuery {
  from?: string;
  to?: string;
  status?: PostedStatus;
  limit?: number;
  offset?: number;
}

/** GET /opening-stock answer; `totals` sums the posted batches that match the filters. */
export interface OpeningStockList {
  items: OpeningBatch[];
  total: number;
  totals: { valueCents: number; lines: number };
}

/** The row problems the importer reports. */
export type ImportIssueCode =
  | 'MISSING_SKU' | 'UNKNOWN_SKU' | 'INACTIVE_PRODUCT' | 'BAD_QTY' | 'BAD_COST'
  | 'DUPLICATE_SKU_IN_FILE' | 'FUTURE_DATE_NOT_ALLOWED';

/** One row of the import preview. */
export interface ImportRow {
  rowNo: number;
  sku: string;
  productId: number | null;
  productName: string;
  /** Category and book of the product (null for an unknown SKU). */
  categoryName: string | null;
  book: 'shop' | 'telecom' | null;
  qty: number | null;
  unitCostCents: number | null;
  totalValueCents: number | null;
  status: 'ok' | 'error';
  issues: Array<{ code: ImportIssueCode; message: string }>;
}

/** Counts above the preview table. */
export interface ImportSummary {
  total: number;
  ok: number;
  failed: number;
  totalValueCents: number;
}

/** POST /excel/opening-stock/preview answer (nothing was saved to stock). */
export interface ImportPreview {
  importRunId: number;
  rows: ImportRow[];
  summary: ImportSummary;
  fileSha256: string;
  /** True when this exact file was already imported and not voided (the import would be refused). */
  alreadyCommitted: boolean;
}

/** POST /excel/opening-stock/import answer. */
export interface ImportResult {
  batch: OpeningBatchDetail;
  importRunId: number;
  summary: ImportSummary;
}
