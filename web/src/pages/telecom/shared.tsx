/**
 * Small display pieces shared by the three Telecom tabs: the date cell with its "Backdated" flag, the status cell
 * with the void reason, a percent label for rates, and the common amount-text parsing used by the entry forms.
 * Display and input parsing only: the server calculates and validates every figure.
 */
import { Badge } from '../../components/Badge';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { bpToPercent, rupeesToCents } from '../../lib/units';
import type { PostedStatus } from '../../types/api';
import { MAX_TELECOM_CENTS } from './commission';

/** Business date plus an amber "Backdated" badge when the entry was dated before the day it was saved (section 12). */
export function DateCell({ date, backdated }: { date: string; backdated: boolean }) {
  return <span className="inline-flex flex-wrap items-center gap-2">{date}{backdated && <Badge tone="amber">Backdated</Badge>}</span>;
}

/** "Posted" / "Void" badge, with the void reason underneath for cancelled entries. */
export function StatusCell({ status, reason }: { status: PostedStatus; reason: string | null }) {
  return (
    <span>
      <PostedStatusBadge status={status} />
      {status === 'void' && reason && <span className="mt-1 block text-xs text-slate-500">{reason}</span>}
    </span>
  );
}

/** 600 -> "6%", 80 -> "0.8%". */
export const rateLabel = (bp: number): string => `${bpToPercent(bp)}%`;

/**
 * Parses a rupee amount typed by the owner into whole cents within the server's range (1 .. 10^12 cents),
 * or null when it is empty, malformed, zero or too large. `allowEmpty` makes an empty box mean 0 (optional extra).
 */
export function parseAmount(text: string, allowEmpty = false): number | null {
  if (text.trim() === '') return allowEmpty ? 0 : null;
  const c = rupeesToCents(text);
  if (c === null || c > MAX_TELECOM_CENTS) return null;
  if (!allowEmpty && c < 1) return null;
  return c;
}

/** Longest note the server accepts. */
export const MAX_NOTE = 500;
