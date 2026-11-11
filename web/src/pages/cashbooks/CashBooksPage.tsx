/**
 * CashBooksPage (route "/cash-books"): the three cash books (Shop, Telecom, Ice Cream) with their balances, ledgers, opening
 * balances, cash counts and daily closings.
 * Data: GET /cashbooks (balances, Ice Cream fund balances, warnings) and the per-book panel (pages/cashbooks/CashBookPanel.tsx).
 *
 * BUSINESS_RULES section 0/8: one physical drawer, three logical cash books; a book's closing balance = opening + in - out.
 * R13: a book (or fund) below zero is a warning banner here, never a block. R9: a closed day refuses new records until it is
 * reopened (audited). The selected book is kept in the URL (`?book=icecream`) so the browser Back button and bookmarks work.
 * The tabs are plain buttons (one tab per book) because the three books share this single route.
 */
import { AlertTriangle } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Spinner } from '../../components/Spinner';
import { useCashBooks } from '../../api/cashbooks';
import { useHealth } from '../../api/health';
import type { CashBook } from '../../types/cashbooks';
import { CashBookPanel } from './CashBookPanel';
import { CASHBOOKS, CASHBOOK_LABEL } from './shared';

/** Reads the `?book=` parameter, falling back to the Shop book for anything unknown. */
function selectedBook(raw: string | null): CashBook {
  return CASHBOOKS.find((b) => b === raw) ?? 'shop';
}

/** The cash books screen. */
export function CashBooksPage() {
  const [params, setParams] = useSearchParams();
  const book = selectedBook(params.get('book'));
  const summary = useCashBooks();
  const health = useHealth();
  const today = health.data?.today ?? '';

  return (
    <>
      <PageHeader title="Cash Books" subtitle="Shop, Telecom and Ice Cream cash: balances, ledgers, counts and daily closings" />

      {summary.isPending ? (
        <div className="flex justify-center py-12"><Spinner label="Loading the cash books" /></div>
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <>
          {summary.data.warnings.length > 0 && (
            <section aria-label="Cash book warnings" className="mb-4 space-y-2">
              {summary.data.warnings.map((w, i) => (
                <p key={`${w.code}-${w.fund ?? w.book}-${i}`} className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
                  <span>{w.message}</span>
                </p>
              ))}
            </section>
          )}

          <div role="tablist" aria-label="Cash books" className="mb-5 grid gap-3 sm:grid-cols-3">
            {summary.data.books.map((b) => (
              <button key={b.book} type="button" role="tab" aria-selected={b.book === book} onClick={() => setParams({ book: b.book })}
                className={`rounded-xl border p-4 text-left transition-colors ${b.book === book ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <span className="block text-sm font-medium text-slate-600">{CASHBOOK_LABEL[b.book]}</span>
                <span className="mt-1 block text-xl font-bold"><Money cents={b.balanceCents} /></span>
                <span className="mt-1 block text-xs text-slate-500">{b.lastClosedDate ? `Last closed day ${b.lastClosedDate}` : 'No day closed yet'}</span>
              </button>
            ))}
          </div>

          {today ? (
            <div role="tabpanel" aria-label={`${CASHBOOK_LABEL[book]} cash book`}>
              <CashBookPanel key={book} book={book} today={today} summary={summary.data.books.find((b) => b.book === book)} />
            </div>
          ) : (
            <div className="flex justify-center py-12"><Spinner label="Loading" /></div>
          )}
        </>
      )}
    </>
  );
}
