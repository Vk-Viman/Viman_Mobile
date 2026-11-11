/**
 * API hooks for Expenses (Shop and Telecom operating expenses, Phase 8).
 *
 * Used by the Expenses screen (pages/expenses/*). Endpoints: /expenses, /expenses/categories, /expenses/:id/void
 * (API_CONTRACTS.md "Wave 2 contract - Phase 8"). An expense is a cash OUT of its book, so every write also refreshes
 * the cash book caches and the audit log. The server validates everything (E2: no electricity category).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { CASHBOOKS_KEY } from './cashbooks';
import { qs } from './queryString';
import type { ExpenseCategoryList, ExpenseCreate, ExpenseCreated, ExpenseList, ExpenseOne, ExpenseQuery } from '../types/cashbooks';

/** Root of every expenses query key, so one invalidation refreshes the whole screen. */
export const EXPENSES_KEY = ['expenses'] as const;

function invalidateExpenses(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: EXPENSES_KEY });
  void qc.invalidateQueries({ queryKey: CASHBOOKS_KEY });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

/** GET /expenses/categories: the nine categories (no electricity) with their labels. Rarely changes, so cached for the session. */
export const useExpenseCategories = () =>
  useQuery({ queryKey: [...EXPENSES_KEY, 'categories'], queryFn: () => apiGet<ExpenseCategoryList>('/expenses/categories'), staleTime: Infinity });

/** GET /expenses (history, filtered and paged by `query`). */
export const useExpenses = (query: ExpenseQuery = {}) =>
  useQuery({
    queryKey: [...EXPENSES_KEY, 'list', query],
    queryFn: () => apiGet<ExpenseList>(`/expenses${qs(query)}`),
    placeholderData: (prev) => prev,
  });

/** POST /expenses: record an expense; the answer carries the negative-cash warnings (R13). */
export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExpenseCreate) => apiPost<ExpenseCreated>('/expenses', body),
    onSuccess: () => invalidateExpenses(qc),
  });
}

/** POST /expenses/:id/void: cancel an expense (reason required); the server posts a reversal. */
export function useVoidExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<ExpenseOne>(`/expenses/${id}/void`, { reason }),
    onSuccess: () => invalidateExpenses(qc),
  });
}
