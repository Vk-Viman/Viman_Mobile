/**
 * Helpers shared by the Stock screens (losses, personal use, stocktake).
 * Generic pieces live elsewhere: components/Pager.tsx, components/VoidRecordDialog.tsx, lib/errors.ts.
 */
import { useMemo } from 'react';
import { useProducts } from '../../api/catalog';
import type { Product, StockLossReason, StocktakeStatus } from '../../types/api';

/** Owner-friendly names of the stock-loss reasons. */
export const REASON_LABEL: Record<StockLossReason, string> = { damaged: 'Damaged', lost: 'Lost', expired: 'Expired', other: 'Other' };

/** Badge colour and text for each stocktake status (draft = still counting, completed = stock corrected, void = cancelled). */
export const STATUS_TONE: Record<StocktakeStatus, 'amber' | 'brand' | 'red'> = { draft: 'amber', completed: 'brand', void: 'red' };
export const STATUS_LABEL: Record<StocktakeStatus, string> = { draft: 'Draft', completed: 'Completed', void: 'Void' };

/** How many products the product pickers load at once (the search box narrows the list further). */
const PRODUCT_PICKER_LIMIT = 500;

/**
 * Products that can appear in stock screens' pickers: GET /products matching the (already debounced) search
 * text, keeping only stock items. Services hold no stock, so they can never be lost, counted or drawn.
 * @param searchText debounced text from the "Find product" box ('' = no filter).
 */
export function useStockProductChoices(searchText: string): Product[] {
  const products = useProducts({ q: searchText || undefined, limit: PRODUCT_PICKER_LIMIT });
  return useMemo(() => (products.data?.items ?? []).filter((p) => p.kind === 'stock'), [products.data]);
}
