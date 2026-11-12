/**
 * Small display pieces shared by the three financial report tabs (profit and loss, cash books, Ice Cream):
 * a URL-backed choice switch, summary tiles, the warning banner and the "excess cost" block of BUSINESS_RULES 10.5 / 10.6.
 * Display only - every figure arrives from the server already calculated; nothing is added up here.
 */
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Card } from '../../components/Card';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { formatLKR } from '../../lib/format';
import type { FinWarning } from '../../types/reportsFinancial';

/** Reads/writes one choice (e.g. the segment or the book) in the URL so the view can be bookmarked and Back works. */
export function useUrlChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const set = (v: T) => { const next = new URLSearchParams(params); next.set(key, v); setParams(next, { replace: true }); };
  return [value, set];
}

/** A row of exclusive choice buttons (Shop / Telecom / Ice Cream ...). */
export function FinSwitch<T extends string>({ label, options, value, onChange }: {
  label: string; options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="mb-4 inline-flex overflow-hidden rounded-lg border border-slate-300 bg-white">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
          className={`px-4 py-2 text-sm font-medium ${o.value === value ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One summary tile: a caption, an amount and an optional hint line. `emphasis` marks the headline figure. */
export function FinTile({ label, cents, hint, emphasis = false }: { label: string; cents: number; hint?: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${emphasis ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold"><Money cents={cents} /></p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Tiles in a responsive grid. */
export function FinTiles({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

/** The warnings of a report (negative balance, excess cost outstanding) in plain language. */
export function FinWarnings({ warnings }: { warnings: FinWarning[] | undefined }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div role="alert" className="mb-4 space-y-2">
      {warnings.map((w, i) => (
        <p key={`${w.code}-${i}`} className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{w.message}</span>
        </p>
      ))}
    </div>
  );
}

/** "-Rs. 50.00 (earlier excess now covered)" for a negative change; a plain amount otherwise (BUSINESS_RULES 10.6). */
export function excessChangeText(cents: number): string {
  return cents < 0 ? `${formatLKR(cents)} (earlier excess now covered)` : formatLKR(cents);
}

/**
 * The three period-flow lines of 10.5 / 10.6, always side by side: Recognized profit, Excess cost not yet charged and
 * Profit after excess cost, plus the outstanding excess (a balance at the end date, never added up). Shown by the Ice Cream
 * and Combined views whenever there is excess cost in the period or outstanding at its end.
 */
export function ExcessCostBlock({ recognizedLabel, recognizedCents, excessCents, afterCents, outstandingCents, asOf }: {
  recognizedLabel: string; recognizedCents: number; excessCents: number; afterCents: number; outstandingCents: number; asOf: string;
}) {
  if (excessCents === 0 && outstandingCents === 0) return null;
  return (
    <Card title="Excess cost" className="mb-4">
      <p className="mb-3 text-sm text-slate-600">
        More was actually spent than was set aside in the daily allocations. The official profit is not reduced automatically; the lines below show the effect side by side.
      </p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{recognizedLabel}</dt><dd className="mt-1 font-semibold"><Money cents={recognizedCents} /></dd></div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Excess cost not yet charged</dt>
          <dd className={`mt-1 font-semibold ${excessCents < 0 ? 'text-brand-700' : ''}`}>{excessChangeText(excessCents)}</dd>
        </div>
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Profit after excess cost</dt><dd className="mt-1 font-semibold"><Money cents={afterCents} /></dd></div>
      </dl>
      {outstandingCents > 0 && (
        <p className="mt-3 text-sm text-amber-800">{formatLKR(outstandingCents)} excess cost outstanding as of {asOf} (a balance at that date; it is not added up across rows).</p>
      )}
    </Card>
  );
}

/** Loading / error / content wrapper for a report query. */
export function FinState<T>({ query, children }: {
  query: { data: T | undefined; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <div className="py-10 text-center"><Spinner label="Loading report" /></div>;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}
