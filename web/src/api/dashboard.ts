/**
 * API hooks of the dashboard (Phase 12): the one-call dashboard answer and the Excel export pack link.
 * Endpoints: GET /dashboard?asOf=, GET /reports/export-pack?from&to (API_CONTRACTS.md "Phase 12 contract").
 *
 * The dashboard describes money that changes whenever any screen saves, so it is never treated as fresh (`staleTime: 0`) and
 * is re-read when the owner returns to the browser tab (`refetchOnWindowFocus`, switched on here although the app default is off:
 * an owner who records a sale in another tab expects the home screen to be current when they come back). The previous answer
 * stays on screen while a new one loads, so the page never flashes empty.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { Dashboard } from '../types/dashboard';

/** Root of the dashboard query key (other code may invalidate it after a save). */
export const DASHBOARD_KEY = ['dashboard'] as const;

/** GET /dashboard for a business date (`asOf` omitted = today in the shop's time zone, chosen by the server). */
export const useDashboard = (asOf?: string) =>
  useQuery({
    queryKey: [...DASHBOARD_KEY, asOf ?? 'today'],
    queryFn: () => apiGet<Dashboard>(`/dashboard${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`),
    refetchOnWindowFocus: true, staleTime: 0, placeholderData: (prev) => prev,
  });

/** The download address of the Excel export pack for a range (a plain link: the browser saves the file). */
export const exportPackUrl = (from: string, to: string): string =>
  `/api/v1/reports/export-pack?${new URLSearchParams({ from, to }).toString()}`;
