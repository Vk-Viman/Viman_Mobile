/**
 * ConfirmDialog: an "Are you sure?" pop-up for risky actions (voiding, restoring a backup...).
 * Optionally requires the user to type a word (e.g. RESTORE) before the confirm button works, as a guard against
 * accidental clicks on irreversible actions.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { inputClass } from './TextField';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

interface Props {
  /** Whether the dialog is shown. Unlike FormDialog it stays mounted and renders nothing when false. */
  open: boolean;
  title: string;
  /** Explanation of what will happen. */
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
  /** True while the action's request is in flight. */
  loading?: boolean;
  /** When set, the user must type this exact text to enable the confirm button. */
  requireText?: string;
  /** Error banner (e.g. the server refused the action). */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Renders the confirmation pop-up while `open`. Focus is trapped inside; Esc cancels; Enter confirms when allowed.
 * Uses role="alertdialog" so screen readers treat it as an urgent question.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', danger, loading, requireText, error, onConfirm, onClose }: Props) {
  // What the user has typed into the "type X to confirm" box.
  const [typed, setTyped] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inputId = useId();

  // Clear the typed text on every opening so an earlier confirmation cannot be reused for a different action.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  // Focus first goes to the typing box when there is one (otherwise the first button).
  useDialogFocusTrap(panel, { onClose, active: open, initialFocusSelector: 'input, button' });

  if (!open) return null;
  // Exact, case-sensitive match on purpose: it must be a deliberate action.
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
