/**
 * Shows the shared non-blocking cash warnings (R13) that a cash-out write returns next to its success message.
 *
 * Every screen that can take money out of a cash book (purchases, expenses, printing supplies, top-ups, refunds, cash counts)
 * gets the same `warnings: CashWarning[]` array from the server (services/cash-warnings.ts). One helper turns it into amber
 * toasts so the owner sees the same wording everywhere. The record is ALREADY saved: a warning is advice ("the Shop cash book
 * is now below zero - check that the opening balance and sales are recorded"), never an error.
 */
import type { CashWarning } from '../types/cashbooks';

/** The part of the toast API this needs (keeps the helper testable without React). */
interface WarningToast { warning: (message: string) => void }

/** One amber toast per warning, using the server's own plain-English message. Does nothing for an empty or missing list. */
export function notifyCashWarnings(toast: WarningToast, warnings: CashWarning[] | undefined): void {
  for (const w of warnings ?? []) toast.warning(w.message);
}
