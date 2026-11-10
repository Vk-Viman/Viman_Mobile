import { useEffect, useState } from 'react';
import type { Book } from '../../types/api';

export const BOOK_LABEL: Record<Book, string> = { shop: 'Shop', telecom: 'Telecom' };

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const CHECKBOX_CLASS = 'h-4 w-4 rounded border-slate-300 text-brand-600';
