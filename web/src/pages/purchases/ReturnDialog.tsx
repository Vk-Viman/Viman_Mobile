import { useRef, useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useHealth } from '../../api/health';
import { useCreatePurchaseReturn } from '../../api/purchases';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { BOOK_LABEL } from '../products/shared';
import { parseIntStrict } from './helpers';
import type { Purchase } from '../../types/api';

export function ReturnDialog({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const health = useHealth();
  const toast = useToast();
  const ret = useCreatePurchaseReturn();
  const clientRef = useRef(crypto.randomUUID());
  const today = health.data?.today ?? '';
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [units, setUnits] = useState<Record<number, string>>({});
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const effDate = date || today;
  const remaining = (it: Purchase['items'][number]) => it.units - it.returnedUnits;
  const chosen = purchase.items
    .map((it) => ({ it, n: parseIntStrict(units[it.id] ?? '') }))
    .filter((x) => (units[x.it.id] ?? '').trim() !== '');
  const unitsValid = (x: { it: Purchase['items'][number]; n: number | null }) => x.n !== null && x.n >= 1 && x.n <= remaining(x.it);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && effDate >= purchase.businessDate && (!today || effDate <= today);
  const canSubmit = Boolean(today) && dateOk && chosen.length > 0 && chosen.every(unitsValid) && note.length <= 200;

  const fe = err instanceof ApiError ? err.fields : {};
  // Server item index = position among the lines actually submitted.
  const idxOf = new Map(chosen.map((x, i) => [x.it.id, i]));
  const handled = new Set(['businessDate', ...chosen.map((_, i) => `items.${i}.units`)]);
  const unshown = Object.entries(fe).filter(([k]) => !handled.has(k));
  let banner: string | null = null;
  if (err) {
    // Date errors are shown under the date field; everything else (incl. exceeded / insufficient stock) as a banner.
    const dateOnly = err instanceof ApiError && (err.code === 'RETURN_BEFORE_ORIGINAL_DATE' || err.code === 'FUTURE_DATE_NOT_ALLOWED') && unshown.length === 0;
    if (!dateOnly) banner = [err.message, ...unshown.map(([, m]) => m).filter((m) => m !== err.message)].join(' ');
  }

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
          clientRef: clientRef.current,
        },
      },
      { onSuccess: () => { toast.success('Return saved.'); onClose(); }, onError: (e) => setErr(e) },
    );
  };

  return (
    <FormDialog title={`Return items — purchase #${purchase.id}`} submitLabel="Save return" canSubmit={canSubmit} loading={ret.isPending} error={banner} onSubmit={submit} onClose={onClose}>
      <p className="text-sm text-slate-600">
        The refund equals the purchase cost of the returned units and is paid back into the {BOOK_LABEL[purchase.book]} cash book.
      </p>
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
      <TextField label="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </FormDialog>
  );
}
