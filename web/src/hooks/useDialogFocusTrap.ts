/**
 * useDialogFocusTrap: the keyboard behaviour shared by every pop-up dialog (Modal, FormDialog, ConfirmDialog).
 *
 * This logic used to be copy-pasted into the three components; having one copy means a keyboard fix is made
 * once. A dialog should behave like a "room with the door shut" for keyboard users:
 *  1. when it opens, focus moves inside it (so typing goes to the dialog, not the page behind);
 *  2. Tab / Shift+Tab cycle inside the dialog and never escape to the page behind;
 *  3. Esc closes it;
 *  4. when it closes, focus returns to the button that opened it (so the user does not lose their place).
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Everything that can receive keyboard focus (disabled controls and tabindex="-1" are skipped). */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Options {
  /** Called when the user presses Esc. */
  onClose: () => void;
  /**
   * CSS selector of the element to focus when the dialog opens (first match inside the panel).
   * Each dialog picks what suits it: forms focus their first field, read-only dialogs their first button.
   */
  initialFocusSelector: string;
  /** Set to false while the dialog is not shown; the trap is then not installed. Default true. */
  active?: boolean;
  /**
   * True while ANOTHER dialog is open on top of this one: Esc and Tab are then left to that dialog so a single
   * key press never closes or traps two dialogs at once.
   */
  paused?: boolean;
}

/**
 * Installs the focus trap on the element behind `panel`.
 * @param panel Ref attached to the dialog's outer panel element.
 */
export function useDialogFocusTrap(panel: RefObject<HTMLElement | null>, opts: Options): void {
  const { active = true, initialFocusSelector } = opts;

  // Keep the latest callbacks/flags in refs. The effect below runs only when `active` changes, yet it must always
  // call the CURRENT onClose / paused value; reading through a ref avoids re-installing listeners on every render.
  const onCloseRef = useRef(opts.onClose);
  onCloseRef.current = opts.onClose;
  const pausedRef = useRef(opts.paused ?? false);
  pausedRef.current = opts.paused ?? false;

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(initialFocusSelector)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (pausedRef.current) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      // Wrap around at both ends: Tab on the last control goes to the first; Shift+Tab on the first goes to the last.
      const els = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (els.length === 0) return;
      const first = els[0] as HTMLElement;
      const last = els[els.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    // Capture phase (third argument true) so the dialog sees the key before any handler on the page behind it.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
    // `panel` and `initialFocusSelector` are stable for a dialog's lifetime; only open/close should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
