/**
 * ReturnDialog: form to return goods from one purchase to the supplier (full or partial).
 * Opened from PurchaseDetailDialog. API: POST /purchases/:id/returns (api/purchases.ts).
 *
 * Rules reflected here (the server enforces them and is authoritative):
 *  - Return date window: purchase date <= return date <= today (R-RD and R-FD). Backdated returns are allowed
 *    and audited. The date picker's min/max are only a convenience.
 *  - Units returned per line cannot exceed bought minus already returned.
 *  - The refund equals the original purchase cost of the returned units; the server calculates it.
 */
import { useState } from 'react';
import { BackdatedNotice } from '../../components/BackdatedNotice';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useCreatePurchaseReturn } from '../../api/purchases';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner } from '../../lib/errors';
import { BOOK_LABEL } from '../../lib/constants';
import { parseIntStrict } from './helpers';
import type { Purchase } from '../../types/api';

/** Longest return note the server accepts. */
const MAX_NOTE = 200;

/** @param purchase the purchase being returned against. Mount only while open (fresh form and clientRef each time). */
export function ReturnDialog({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const toast = useToast();
  const ret = useCreatePurchaseReturn();
  // Generated once per opening so a retried Save is recognised by the server and cannot post the return twice.
  const clientRef = useClientRef();
  const { today, date: effDate, picked: date, setDate } = useBusinessDate();
  const [note, setNote] = useState('');
  // Units to return per purchase line, keyed by the line's id, held as typed text.
  const [units, setUnits] = useState<Record<number, string>>({});
  const [err, setErr] = useState<ApiError | Error | null>(null);

  /** Units of a line that can still be returned. */
  const remaining = (it: Purchase['items'][number]) => it.units - it.returnedUnits;
  // Lines the owner filled in (empty boxes mean "not returning this line").
  const chosen = purchase.items
    .map((it) => ({ it, n: parseIntStrict(units[it.id] ?? '') }))
    .filter((x) => (units[x.it.id] ?? '').trim() !== '');
  const unitsValid = (x: { it: Purchase['items'][number]; n: number | null }) => x.n !== null && x.n >= 1 && x.n <= remaining(x.it);
  // R-RD + R-FD window. (YYYY-MM-DD strings compare correctly as text.)
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && effDate >= purchase.businessDate && (!today || effDate <= today);
  const canSubmit = Boolean(today) && dateOk && chosen.length > 0 && chosen.every(unitsValid) && note.length <= MAX_NOTE;

  const fe = err instanceof ApiError ? err.fields : {};
  // The server numbers items by their position among the lines actually submitted, so map our line ids to it.
  const idxOf = new Map(chosen.map((x, i) => [x.it.id, i]));
  const handled = new Set(['businessDate', ...chosen.map((_, i) => `items.${i}.units`)]);
  const hasUnshown = Object.keys(fe).some((k) => !handled.has(k));
  // Date errors are shown under the date field; everything else (incl. exceeded / insufficient stock) as a banner.
  const dateOnly = err instanceof ApiError && (err.code === 'RETURN_BEFORE_ORIGINAL_DATE' || err.code === 'FUTURE_DATE_NOT_ALLOWED') && !hasUnshown;
  const banner = dateOnly ? null : errorBanner(err, [...handled]);

  const submit = () => {
    if (!canSubmit) return;
    setErr(null);
    ret.mutate(
      {
        id: purchase.id,
        body: {
          businessDate: effDate,
          items: chosen.map((x) => ({ purchaseItemId: x.it.id, units: x.n as number })),
          ...(note.trim() ? { note: note.trim() } : {}),
          clientRef,
        },
      },
      { onSuccess: (r) => { toast.success('Return saved.'); notifyCashWarnings(toast, r.warnings); onClose(); }, onError: (e) => setErr(e) },
    );
  };

  return (
    <FormDialog title={`Return items — purchase #${purchase.id}`} submitLabel="Save return" canSubmit={canSubmit} loading={ret.isPending} error={banner} onSubmit={submit} onClose={onClose}>
      <p className="text-sm text-slate-600">
        The refund equals the purchase cost of the returned units and is paid back into the {BOOK_LABEL[purchase.book]} cash book.
      </p>
      <div>
      <TextField
        label="Return date"
        type="date"
        value={effDate}
        min={purchase.businessDate}
        max={today || undefined}
        onChange={(e) => setDate(e.target.value)}
        hint={`Between ${purchase.businessDate} (purchase date) and today.`}
        error={fe.businessDate ?? (date && !dateOk ? 'Pick a date from the purchase date up to today.' : undefined)}
      />
      <BackdatedNotice date={effDate} today={today} />
      </div>
      <div className="space-y-3">
        {purchase.items.map((it) => {
          const rem = remaining(it);
          const raw = units[it.id] ?? '';
          const n = parseIntStrict(raw);
          const idx = idxOf.get(it.id);
          const serverErr = idx !== undefined ? fe[`items.${idx}.units`] : undefined;
          return (
            <TextField
              key={it.id}
              label={`${it.productName} — units to return (up to ${rem})`}
              inputMode="numeric"
              disabled={rem === 0}
              value={raw}
              onChange={(e) => setUnits((u) => ({ ...u, [it.id]: e.target.value }))}
              placeholder="0"
              hint={rem === 0 ? 'Everything on this line has already been returned.' : `Bought ${it.units}, already returned ${it.returnedUnits}.`}
              error={serverErr ?? (raw.trim() !== '' && (n === null || n < 1 || n > rem) ? `Enter a whole number from 1 to ${rem}.` : undefined)}
              autoComplete="off"
            />
          );
        })}
      </div>
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </FormDialog>
  );
}
