import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { inputClass } from './TextField';

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** When set, the user must type this exact text to enable the confirm button. */
  requireText?: string;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', danger, loading, requireText, error, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inputId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setTyped('');
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input, button');
    first?.focus();
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
  }, [open]);

  if (!open) return null;
  const canConfirm = !requireText || typed === requireText;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div ref={panel} role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700">{children}</div>
        <form
          onSubmit={(e) => { e.preventDefault(); if (canConfirm && !loading) onConfirm(); }}
          className="mt-4"
        >
          {requireText && (
            <div className="mb-4">
              <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-slate-700">
                Type <strong>{requireText}</strong> to confirm
              </label>
              <input
                id={inputId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={inputClass()}
              />
            </div>
          )}
          {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
            <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!canConfirm} loading={loading}>{confirmLabel}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
