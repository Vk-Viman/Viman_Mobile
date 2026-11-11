/**
 * ErrorState: the block shown in place of a table/card when loading its data failed.
 * Announced to screen readers immediately (role="alert").
 */
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';

/**
 * @param error   Whatever the query reported; an ApiError/Error contributes its readable message,
 *                anything else falls back to a generic sentence.
 * @param onRetry Optional; when given a "Try again" button is shown (usually the query's `refetch`).
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <AlertTriangle size={32} className="text-red-500" aria-hidden="true" />
      <p className="font-medium text-slate-800">Could not load this</p>
      <p className="max-w-md text-sm text-slate-600">{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
