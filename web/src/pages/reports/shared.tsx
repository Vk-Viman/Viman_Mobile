/**
 * Shared pieces of every Reports tab: the period/granularity picker (kept in the URL so a report can be
 * bookmarked and Back works), the "Download Excel" link and a generic table renderer for the common
 * `ReportTable` shape returned by every report endpoint (server `lib/report-table.ts`).
 * No API calls of its own. Owned by the orchestrator; report tabs import it and must not edit it.
 */
import { Download } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useHealth } from '../../api/health';
import { formatLKR } from '../../lib/format';

/** Column display kinds, mirrored from the server. */
export type ColumnKind = 'text' | 'money' | 'int' | 'percent' | 'date';
export interface ReportColumn { key: string; label: string; kind: ColumnKind }
export type ReportCell = string | number | null;
/** The shape every report endpoint embeds as `table` (or returns in `tables`). */
export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportCell>>;
  totals?: Record<string, ReportCell>;
  notes?: string[];
}
export type Granularity = 'day' | 'month';

/** The period the owner picked. `ready` is false until the server's today (Asia/Colombo) is known. */
export interface ReportPeriod { from: string; to: string; granularity: Granularity; ready: boolean }

/** Reads/writes `from`, `to`, `granularity` in the URL; defaults to the first of this month .. today, by day. */
export function useReportPeriod(): { period: ReportPeriod; set: (patch: Partial<Omit<ReportPeriod, 'ready'>>) => void } {
  const [params, setParams] = useSearchParams();
  const today = useHealth().data?.today ?? '';
  const from = params.get('from') ?? (today ? `${today.slice(0, 8)}01` : '');
  const to = params.get('to') ?? today;
  const granularity: Granularity = params.get('granularity') === 'month' ? 'month' : 'day';
  const set = (patch: Partial<Omit<ReportPeriod, 'ready'>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, String(v));
    setParams(next, { replace: true });
  };
  return { period: { from, to, granularity, ready: Boolean(from && to) }, set };
}

/** Query string for a report request (`format` optional). */
export function periodQuery(p: ReportPeriod, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ from: p.from, to: p.to, granularity: p.granularity, ...extra });
  return `?${q.toString()}`;
}

const inputClass = 'rounded-lg border border-slate-300 px-3 py-2 text-sm';

/** Date range + day/month switch + Excel download for `path` (relative to /api/v1, e.g. "/reports/pnl/shop"). */
export function ReportToolbar({ period, set, downloadPath, showGranularity = true }: {
  period: ReportPeriod; set: ReturnType<typeof useReportPeriod>['set']; downloadPath?: string; showGranularity?: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="text-sm text-slate-600">From
        <input type="date" className={`${inputClass} mt-1 block`} value={period.from} onChange={(e) => set({ from: e.target.value })} />
      </label>
      <label className="text-sm text-slate-600">To
        <input type="date" className={`${inputClass} mt-1 block`} value={period.to} onChange={(e) => set({ to: e.target.value })} />
      </label>
      {showGranularity && (
        <label className="text-sm text-slate-600">Rows
          <select className={`${inputClass} mt-1 block`} value={period.granularity} onChange={(e) => set({ granularity: e.target.value as Granularity })}>
            <option value="day">By day</option>
            <option value="month">By month</option>
          </select>
        </label>
      )}
      {downloadPath && period.ready && (
        <a className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
           href={`/api/v1${downloadPath}${periodQuery(period, { format: 'xlsx' })}`} download>
          <Download size={16} aria-hidden="true" /> Download Excel
        </a>
      )}
    </div>
  );
}

function cell(kind: ColumnKind, v: ReportCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (kind === 'money') return formatLKR(v);
  if (kind === 'percent') return `${(v / 100).toFixed(2)} %`;
  return v.toLocaleString('en-US');
}

/** Renders a `ReportTable`: scrolls sideways on narrow screens; money right-aligned; totals row in bold. */
export function ReportTableView({ table }: { table: ReportTable }) {
  const right = (k: ColumnKind) => (k === 'text' || k === 'date' ? 'text-left' : 'text-right tabular-nums');
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <caption className="sr-only">{table.title}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            {table.columns.map((c) => <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${right(c.kind)}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100">
              {table.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${right(c.kind)}`}>{cell(c.kind, r[c.key] ?? null)}</td>)}
            </tr>
          ))}
          {table.totals && (
            <tr className="bg-slate-50 font-semibold">
              {table.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${right(c.kind)}`}>{cell(c.kind, table.totals![c.key] ?? null)}</td>)}
            </tr>
          )}
        </tbody>
      </table>
      {table.notes?.map((n, i) => <p key={i} className="mt-2 text-xs text-slate-500">{n}</p>)}
    </div>
  );
}
