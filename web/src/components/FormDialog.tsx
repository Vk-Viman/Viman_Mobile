/**
 * FormDialog: a pop-up window containing a form with Cancel / Submit buttons.
 * Used by every "Add ..." / "Edit ..." / "Void ..." form in the app (products, categories, purchases, stock...).
 */
import { useId, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button } from './Button';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

interface Props {
  title: string;
  /** The form fields. */
  children: ReactNode;
  submitLabel: string;
  /** False disables the submit button (e.g. required fields still empty). The server re-validates anyway. */
  canSubmit: boolean;
  /** True while the save request is in flight: spinner on the submit button, Cancel disabled. */
  loading?: boolean;
  /** Banner for errors that do not belong to a single field. */
  error?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  /** Tailwind max-width class for the panel (default max-w-xl). */
  widthClass?: string;
  /** True while ANOTHER dialog is open on top of this one (e.g. a product dialog opened from the purchase form). */
  paused?: boolean;
}

/**
 * Modal form: focus trapped, Esc closes, Enter submits (native form submit). Mount it only while open.
 * Mounting only while open means each opening starts with fresh form state (parents keep their own state inside
 * the dialog component), so a half-filled form from last time never reappears.
 * `noValidate` turns off the browser's own pop-up validation bubbles: the app shows its own field messages,
 * and the server remains the final authority on what is valid.
 */
export function FormDialog({ title, children, submitLabel, canSubmit, loading, error, onSubmit, onClose, widthClass = 'max-w-xl', paused }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // First focus goes to the first editable field so the owner can start typing straight away.
  useDialogFocusTrap(panel, {
    onClose,
    paused,
    initialFocusSelector: 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Guard against Enter-key submits while the button is disabled or a request is already running.
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
