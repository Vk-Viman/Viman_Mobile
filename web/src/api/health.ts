import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { Health } from '../types/api';

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: () => apiGet<Health>('/health'), refetchInterval: 30_000, retry: false });
