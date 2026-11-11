/**
 * API hooks for the cash books (Phase 8): balances, ledger, opening balances, cash counts and daily closings.
 *
 * Used by the Cash Books screen (pages/cashbooks/*). Endpoints: /cashbooks, /cashbooks/:book(/opening), /capital-entries/:id/void,
 * /cash-counts(/expected), /daily-closings(/status, /:id/reopen) (API_CONTRACTS.md "Wave 2 contract - Phase 8").
 * The cash books change whenever ANY screen saves money (purchases, sales, telecom ...), so these queries are never treated
 * as fresh (`staleTime: 0`): opening the screen always shows the live ledger. Every write here refreshes all cash book data,
 * and the expense lists, because a count or a void moves the same numbers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import { AUDIT_LOGS_KEY } from './auditLogs';
import { qs } from './queryString';
import type {
  CapitalEntryList, CapitalEntryResult, CashBook, CashBookLedger, CashBookList, CashCountCreate, CashCountResult, DailyClosingCreate,
  DailyClosingList, DailyClosingOne, DailyClosingResult, ExpectedCash, LedgerQuery, OpeningBalanceCreate,
} from '../types/cashbooks';

/** Root of every cash book query key, so one invalidation refreshes the whole screen. */
export const CASHBOOKS_KEY = ['cashbooks'] as const;

function invalidateCashbooks(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: CASHBOOKS_KEY });
  void qc.invalidateQueries({ queryKey: ['expenses'] });
  void qc.invalidateQueries({ queryKey: AUDIT_LOGS_KEY });
}

/** GET /cashbooks: balances of the three books, the Ice Cream fund balances and the integrity / negative-cash warnings. */
export const useCashBooks = () =>
  useQuery({ queryKey: [...CASHBOOKS_KEY, 'summary'], queryFn: () => apiGet<CashBookList>('/cashbooks'), staleTime: 0 });

/** GET /cashbooks/:book: the ledger of a period with opening / in / out / closing and running balances (paged). */
export const useCashBookLedger = (book: CashBook, query: LedgerQuery = {}) =>
  useQuery({
    queryKey: [...CASHBOOKS_KEY, 'ledger', book, query],
    queryFn: () => apiGet<CashBookLedger>(`/cashbooks/${book}${qs(query)}`),
    placeholderData: (prev) => prev,
    staleTime: 0,
  });

/** GET /cashbooks/:book/opening: the opening balances entered for a book (voided ones included). */
export const useOpeningBalances = (book: CashBook) =>
  useQuery({
    queryKey: [...CASHBOOKS_KEY, 'opening', book], queryFn: () => apiGet<CapitalEntryList>(`/cashbooks/${book}/opening`), staleTime: 0,
  });

/** POST /cashbooks/:book/opening: set the opening balance (Ice Cream: per fund). */
export function useSetOpeningBalance(book: CashBook) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OpeningBalanceCreate) => apiPost<CapitalEntryResult>(`/cashbooks/${book}/opening`, body),
    onSuccess: () => invalidateCashbooks(qc),
  });
}

/** POST /capital-entries/:id/void: cancel an opening balance (reason required); the server posts a reversal. */
export function useVoidCapitalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<CapitalEntryResult>(`/capital-entries/${id}/void`, { reason }),
    onSuccess: () => invalidateCashbooks(qc),
  });
}

/** GET /cash-counts/expected: what the drawer should hold at the end of `businessDate` (only asked when a date is chosen). */
export const useExpectedCash = (book: CashBook, businessDate: string) =>
  useQuery({
    queryKey: [...CASHBOOKS_KEY, 'expected', book, businessDate],
    queryFn: () => apiGet<ExpectedCash>(`/cash-counts/expected${qs({ book, businessDate })}`),
    enabled: businessDate !== '',
    staleTime: 0,
  });

/** POST /cash-counts: record a drawer count; a difference becomes cash over/short (note required). */
export function useCreateCashCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CashCountCreate) => apiPost<CashCountResult>('/cash-counts', body),
    onSuccess: () => invalidateCashbooks(qc),
  });
}

/** GET /daily-closings: closings of a book (each with `isClosed`) in an optional period, newest first. */
export const useDailyClosings = (query: { book: CashBook; from?: string; to?: string }) =>
  useQuery({
    queryKey: [...CASHBOOKS_KEY, 'closings', query],
    queryFn: () => apiGet<DailyClosingList>(`/daily-closings${qs(query)}`),
    placeholderData: (prev) => prev,
    staleTime: 0,
  });

/** POST /daily-closings: close a day (optionally with the drawer count first). */
export function useCloseDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DailyClosingCreate) => apiPost<DailyClosingResult>('/daily-closings', body),
    onSuccess: () => invalidateCashbooks(qc),
  });
}

/** POST /daily-closings/:id/reopen: reopen a closed day (reason of at least 3 characters; audited). */
export function useReopenDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiPost<DailyClosingOne>(`/daily-closings/${id}/reopen`, { reason }),
    onSuccess: () => invalidateCashbooks(qc),
  });
}
