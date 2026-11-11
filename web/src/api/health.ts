/**
 * API hook for the server health check.
 *
 * Used by the Dashboard (pages/Dashboard.tsx) to show whether the shop server and its database are OK.
 * Endpoint: GET /health.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { Health } from '../types/api';

/** How often (ms) the health status is re-checked while the Dashboard is open. */
const HEALTH_REFRESH_MS = 30_000;

/**
 * GET /health. Re-polled every 30 seconds so a server that stops is noticed.
 * `retry: false` makes a failure show up immediately instead of after the default retry delay: a health
 * check that hides problems for several seconds would defeat its purpose.
 */
export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: () => apiGet<Health>('/health'), refetchInterval: HEALTH_REFRESH_MS, retry: false });
