/**
 * API hooks for the product catalog: categories, products and suppliers.
 *
 * Used by Products (pages/products/*), Purchases and Stock screens whenever they need a product/supplier list.
 * Endpoints: /categories, /products, /suppliers (see API_CONTRACTS.md).
 *
 * Conventions for every hook in the web/src/api folder:
 *  - A "use..." query hook = one GET; its query key starts with a shared root (see `catalogKeys`) followed by the
 *    filters, so changing a filter gives a separate cache entry while one root-key invalidation refreshes them all.
 *  - A "useCreate/Update..." mutation hook = one POST/PUT; on success it invalidates (marks stale, so they reload)
 *    every cached list that the change could affect. The server is authoritative; the UI never patches numbers
 *    locally.
 *  - `placeholderData: (prev) => prev` keeps the previous list on screen while a new filter loads, so tables do
 *    not flash empty between keystrokes.
 *  - Every write is audited on the server, so each mutation also invalidates the audit-log list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { qs } from './queryString';
import type {
  Book, CategoryCreate, CategoryItem, CategoryList, CategoryUpdate,
  ProductCreate, ProductItem, ProductList, ProductQuery, ProductUpdate,
  SupplierCreate, SupplierItem, SupplierList, SupplierQuery, SupplierUpdate,
} from '../types/api';

/**
 * Root query keys of the catalog caches. Other modules (purchases, stock) import these to invalidate product
 * data after they change stock quantities, because product lists show quantity on hand.
 */
export const catalogKeys = {
  categories: ['catalog', 'categories'] as const,
  products: ['catalog', 'products'] as const,
  suppliers: ['catalog', 'suppliers'] as const,
};

// ---- Categories ----

/** Optional filters for the category list: active-only and/or one accounting book. */
export interface CategoryQuery { active?: boolean; book?: Book }

/** GET /categories (filtered by `query`). */
export const useCategories = (query: CategoryQuery = {}) =>
  useQuery({
    queryKey: [...catalogKeys.categories, 'list', query],
    queryFn: () => apiGet<CategoryList>(`/categories${qs(query)}`),
  });

/** POST /categories. Invalidates: category lists (new row) and the audit log. */
export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CategoryCreate) => apiPost<CategoryItem>('/categories', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.categories });
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}

/**
 * PUT /categories/:id. Invalidates: category lists, product lists (products display their category name, which
 * may have been renamed or deactivated) and the audit log.
 */
export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: CategoryUpdate }) => apiPut<CategoryItem>(`/categories/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.categories });
      void qc.invalidateQueries({ queryKey: catalogKeys.products });
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}

// ---- Products ----

/** GET /products (search / category / active filters in `query`). */
export const useProducts = (query: ProductQuery = {}) =>
  useQuery({
    queryKey: [...catalogKeys.products, 'list', query],
    queryFn: () => apiGet<ProductList>(`/products${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** Filters of the category-first product list used by CategoryProductPicker. */
export interface ProductsByCategoryQuery {
  /** Business book; keeps products of the other book out even when no category is chosen. */
  book?: Book;
  /** Chosen category (null/undefined = all categories of `book`). */
  categoryId?: number | null;
  /** Search text (name or code), already debounced by the caller. */
  q?: string;
  /** Stock items only (default true); false also lists services. */
  stockOnly?: boolean;
  limit?: number;
  /** False = no request (e.g. a required category is not chosen yet). */
  enabled?: boolean;
}

/**
 * GET /products for the picker: ACTIVE products only (inactive ones must never be offered for new documents),
 * optionally of one category / book, `kind=stock` by default, searched server-side so 200+ products stay usable.
 */
export const useProductsByCategory = ({ book, categoryId, q, stockOnly = true, limit = 50, enabled = true }: ProductsByCategoryQuery) => {
  const query: ProductQuery = {
    active: true,
    book,
    categoryId: categoryId ?? undefined,
    kind: stockOnly ? 'stock' : undefined,
    q: q || undefined,
    limit,
  };
  return useQuery({
    queryKey: [...catalogKeys.products, 'by-category', query],
    queryFn: () => apiGet<ProductList>(`/products${qs(query)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
};

/** GET /products/:id. Disabled (no request) while `id` is null, i.e. while no product is selected. */
export const useProduct = (id: number | null) =>
  useQuery({
    queryKey: [...catalogKeys.products, 'detail', id],
    queryFn: () => apiGet<ProductItem>(`/products/${id}`),
    enabled: id !== null,
  });

/** POST /products. Invalidates: product lists, category lists (each category shows a product count), audit log. */
export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProductCreate) => apiPost<ProductItem>('/products', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.products });
      void qc.invalidateQueries({ queryKey: catalogKeys.categories }); // productCount
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}

/** PUT /products/:id. Invalidates: product lists, category lists (counts change when a product moves), audit log. */
export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ProductUpdate }) => apiPut<ProductItem>(`/products/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.products });
      void qc.invalidateQueries({ queryKey: catalogKeys.categories });
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}

// ---- Suppliers ----

/** GET /suppliers (search / active filters in `query`). */
export const useSuppliers = (query: SupplierQuery = {}) =>
  useQuery({
    queryKey: [...catalogKeys.suppliers, 'list', query],
    queryFn: () => apiGet<SupplierList>(`/suppliers${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /suppliers. Invalidates: supplier lists and the audit log. */
export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SupplierCreate) => apiPost<SupplierItem>('/suppliers', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.suppliers });
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}

/** PUT /suppliers/:id. Invalidates: supplier lists and the audit log. */
export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: SupplierUpdate }) => apiPut<SupplierItem>(`/suppliers/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.suppliers });
      void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
    },
  });
}
