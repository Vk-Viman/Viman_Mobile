/**
 * Badge: a small coloured pill for statuses such as "Active", "Voided" or "Low stock".
 * Purely presentational; used inside tables and headers across the app.
 */
import type { ReactNode } from 'react';

/** Colour meaning: neutral = informational, brand = good/active, amber = warning, red = problem/cancelled. */
type Tone = 'neutral' | 'brand' | 'amber' | 'red';
const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  brand: 'bg-brand-100 text-brand-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
};

/** Renders `children` as a rounded pill coloured by `tone` (default neutral). */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
