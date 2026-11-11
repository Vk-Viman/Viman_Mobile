/**
 * Pager: the "Showing 1-50 of 120 products  [Previous] [Next]" bar under paged lists.
 * Paging is done by the server (limit/offset); this component only displays the position and changes the page number.
 */
import { Button } from './Button';

interface PagerProps {
  /** Zero-based page number. */
  page: number;
  /** Total matching rows reported by the server (not just this page). */
  total: number;
  /** Rows per page (the same value sent to the server as `limit`). */
  limit: number;
  /** Plural noun used in the text, e.g. "products". */
  noun: string;
  onPage: (p: number) => void;
}

/** Renders the position text and Previous/Next buttons (disabled at the first/last page). */
export function Pager({ page, total, limit, noun, onPage }: PagerProps) {
  const first = total === 0 ? 0 : page * limit + 1;
  const last = Math.min(total, (page + 1) * limit);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
      <span>{total === 0 ? `0 ${noun}` : `Showing ${first}–${last} of ${total} ${noun}`}</span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>Previous</Button>
        <Button variant="secondary" disabled={last >= total} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
