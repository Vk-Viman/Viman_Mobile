import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';

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
