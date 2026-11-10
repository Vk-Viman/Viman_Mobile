import { Loader2 } from 'lucide-react';

export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-slate-500">
      <Loader2 size={size} className="animate-spin" aria-hidden="true" />
      <span className={label ? 'text-sm' : 'sr-only'}>{label ?? 'Loading'}</span>
    </span>
  );
}
