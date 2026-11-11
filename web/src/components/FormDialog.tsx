import { useEffect, useId, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button } from './Button';

interface Props {
  title: string;
  children: ReactNode;
  submitLabel: string;
  canSubmit: boolean;
  loading?: boolean;
  /** Banner for errors that do not belong to a single field. */
  error?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  /** Tailwind max-width class for the panel (default max-w-xl). */
  widthClass?: string;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal form: focus trapped, Esc closes, Enter submits (native form submit). Mount it only while open. */
export function FormDialog({ title, children, submitLabel, canSubmit, loading, error, onSubmit, onClose, widthClass = 'max-w-xl' }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const els = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (els.length === 0) return;
      const a = els[0] as HTMLElement;
      const z = els[els.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit && !loading) onSubmit();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`max-h-[calc(100vh-2rem)] w-full ${widthClass} overflow-y-auto rounded-xl bg-white p-6 shadow-xl`}>
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
        <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
          {children}
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit} loading={loading}>{submitLabel}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
