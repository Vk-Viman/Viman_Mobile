/**
 * Small display pieces shared by the two stocktake count-sheet views (editable draft and read-only).
 * Used by StocktakeDraftSheet.tsx and StocktakeSheet.tsx. No API calls.
 */
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { BookBadge } from '../../components/StatusBadges';
import type { Stocktake } from '../../types/api';
import { STATUS_LABEL, STATUS_TONE } from './shared';

/** A signed difference in units: 0 grey, gain green with "+", loss red with "-". */
export function Diff({ n }: { n: number }) {
  if (n === 0) return <span className="num text-slate-600">0</span>;
  return <span className={`num font-medium ${n > 0 ? 'text-brand-700' : 'text-red-700'}`}>{n > 0 ? `+${n}` : n}</span>;
}

/** Top of a count sheet: back link, "Stocktake #id - date" title and badges (book, status, backdated). */
export function SheetHeader({ st }: { st: Stocktake }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Link to="/stock/stocktake" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> All stocktakes
      </Link>
      <h2 className="text-lg font-semibold text-slate-900">Stocktake #{st.id} — {st.businessDate}</h2>
      <BookBadge book={st.book} />
      <Badge tone={STATUS_TONE[st.status]}>{STATUS_LABEL[st.status]}</Badge>
      {st.backdated && <Badge tone="amber">Backdated</Badge>}
    </div>
  );
}
