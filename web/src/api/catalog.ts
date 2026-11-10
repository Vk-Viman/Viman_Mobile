import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from './client';
import type {
  Book, CategoryCreate, CategoryItem, CategoryList, CategoryUpdate,
  ProductCreate, ProductItem, ProductList, ProductQuery, ProductUpdate,
  SupplierCreate, SupplierItem, SupplierList, SupplierQuery, SupplierUpdate,
} from '../types/api';

/** Build a query string: omit undefined/null/empty values; booleans as true/false. */
function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const catalogKeys = {
  categories: ['catalog', 'categories'] as const,
  products: ['catalog', 'products'] as const,
  suppliers: ['catalog', 'suppliers'] as const,
};

// ---- Categories ----
export interface CategoryQuery { active?: boolean; book?: Book }

export const useCategories = (query: CategoryQuery = {}) =>
  useQuery({
    queryKey: [...catalogKeys.categories, 'list', query],
    queryFn: () => apiGet<CategoryList>(`/categories${qs(query)}`),
  });

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CategoryCreate) => apiPost<CategoryItem>('/categories', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.categories });
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: CategoryUpdate }) => apiPut<CategoryItem>(`/categories/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.categories });
      void qc.invalidateQueries({ queryKey: catalogKeys.products });
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}

// ---- Products ----
export const useProducts = (query: ProductQuery = {}) =>
  useQuery({
    queryKey: [...catalogKeys.products, 'list', query],
    queryFn: () => apiGet<ProductList>(`/products${qs(query)}`),
    placeholderData: (prev) => prev,
  });

export const useProduct = (id: number | null) =>
  useQuery({
    queryKey: [...catalogKeys.products, 'detail', id],
    queryFn: () => apiGet<ProductItem>(`/products/${id}`),
    enabled: id !== null,
  });

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProductCreate) => apiPost<ProductItem>('/products', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.products });
      void qc.invalidateQueries({ queryKey: catalogKeys.categories }); // productCount
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ProductUpdate }) => apiPut<ProductItem>(`/products/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.products });
      void qc.invalidateQueries({ queryKey: catalogKeys.categories });
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}

// ---- Suppliers ----
export const useSuppliers = (query: SupplierQuery = {}) =>
  useQuery({
    queryKey: [...catalogKeys.suppliers, 'list', query],
    queryFn: () => apiGet<SupplierList>(`/suppliers${qs(query)}`),
    placeholderData: (prev) => prev,
  });

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SupplierCreate) => apiPost<SupplierItem>('/suppliers', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.suppliers });
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: SupplierUpdate }) => apiPut<SupplierItem>(`/suppliers/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.suppliers });
      void qc.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}
