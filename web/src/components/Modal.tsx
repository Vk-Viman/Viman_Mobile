/**
 * Modal: a read-only pop-up window (details view with a close "X"), e.g. purchase details or stock movements.
 * For pop-ups with a form use FormDialog; for yes/no questions use ConfirmDialog.
 */
import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

interface Props {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Set while another dialog is open on top, so Esc / Tab are left to that dialog. */
  paused?: boolean;
  /** Tailwind max-width class for the panel (default max-w-3xl). */
  widthClass?: string;
}

/**
 * Read-only modal (no form): focus trapped, Esc closes. Mount only while open.
 * "Mount only while open" is why there is no `open` prop: the parent renders `{selected && <Modal .../>}`, so the
 * dialog's state and data fetching start fresh each time and nothing runs while it is hidden.
 */
export function Modal({ title, children, onClose, paused = false, widthClass = 'max-w-3xl' }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // First focus goes to the close button, so keyboard users can dismiss immediately.
  useDialogFocusTrap(panel, { onClose, paused, initialFocusSelector: 'button' });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`max-h-[calc(100vh-2rem)] w-full ${widthClass} overflow-y-auto rounded-xl bg-white p-6 shadow-xl`}>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
