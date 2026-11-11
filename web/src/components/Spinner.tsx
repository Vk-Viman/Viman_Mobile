/**
 * Spinner: the rotating "loading" indicator, used while data loads and inside buttons that are busy.
 */
import { Loader2 } from 'lucide-react';

/**
 * @param size  icon size in pixels.
 * @param label optional visible text next to the icon; without it the word "Loading" is available to screen
 *              readers only (role="status" announces it politely).
 */
export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-slate-500">
      <Loader2 size={size} className="animate-spin" aria-hidden="true" />
      <span className={label ? 'text-sm' : 'sr-only'}>{label ?? 'Loading'}</span>
    </span>
  );
}
