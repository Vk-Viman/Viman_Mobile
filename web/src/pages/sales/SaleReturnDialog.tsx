/**
 * SaleReturnDialog: form to take items back from a customer for one sale (full or partial).
 * Opened from SaleDetailDialog. API: POST /sales/:id/returns (api/sales.ts).
 *
 * Rules reflected here (the server enforces them and is authoritative):
 *  - Return date window: sale date <= return date <= today (R-RD and R-FD). The date picker's min/max are only a
 *    convenience; RETURN_BEFORE_ORIGINAL_DATE / FUTURE_DATE_NOT_ALLOWED are shown under the date field.
 *  - Per line, quantity <= sold - already returned (RETURN_EXCEEDS_SOLD is shown under that line's quantity).
 *  - Resalable items go back into stock at their original cost. Damaged items are not restocked; they are
 *    recorded once as a stock loss at cost. The refund equals the selling price of the returned units; the server
 *    calculates it (including rounding), so no amount is computed here.
 *  - `clientRef` is created once per opening so a retried Save cannot post the return twice.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCreateSaleReturn } from '../../api/sales';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner } from '../../lib/errors';
import type { Sale, SaleItem } from '../../types/api';
import { parseIntStrict } from '../purchases/helpers';

/** Longest return note we let the owner type (the contract gives no limit; kept in line with other notes). */
const MAX_NOTE = 200;

/** @param sale the sale being returned against. Mount only while open (fresh form and clientRef each time). */
export function SaleReturnDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const toast = useToast();
  const ret = useCreateSaleReturn();
  const clientRef = useClientRef();
  const { today, date: effDate, picked: date, setDate } = useBusinessDate();
  const [note, setNote] = useState('');
  // Per sale line (keyed by line id): quantity text and condition. Empty quantity = not returning that line.
  const [qty, setQty] = useState<Record<number, string>>({});
  const [resalable, setResalable] = useState<Record<number, boolean>>({});
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const remaining = (it: SaleItem) => it.qty - it.returnedQty;
  const chosen = sale.items
    .map((it) => ({ it, n: parseIntStrict(qty[it.id] ?? '') }))
    .filter((x) => (qty[x.it.id] ?? '').trim() !== '');
  const qtyValid = (x: { it: SaleItem; n: number | null }) => x.n !== null && x.n >= 1 && x.n <= remaining(x.it);
  // R-RD + R-FD window. (YYYY-MM-DD strings compare correctly as text.)
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && effDate >= sale.businessDate && (!today || effDate <= today);
  const canSubmit = Boolean(today) && dateOk && chosen.length > 0 && chosen.every(qtyValid) && note.length <= MAX_NOTE;

  const fe = err instanceof ApiError ? err.fields : {};
  // The server numbers items by their position among the lines actually submitted, so map line ids to that.
  const idxOf = new Map(chosen.map((x, i) => [x.it.id, i]));
  const handled = new Set(['businessDate', ...chosen.map((_, i) => `items.${i}.qty`)]);
  const hasUnshown = Object.keys(fe).some((k) => !handled.has(k));
  const dateOnly = err instanceof ApiError && (err.code === 'RETURN_BEFORE_ORIGINAL_DATE' || err.code === 'FUTURE_DATE_NOT_ALLOWED') && !hasUnshown;
  const qtyOnly = err instanceof ApiError && err.code === 'RETURN_EXCEEDS_SOLD' && !hasUnshown;
  // Date / quantity errors appear under their field; everything else (SALE_VOID, 404, ...) as a banner.
  const banner = dateOnly || qtyOnly ? null : errorBanner(err, [...handled]);

  const submit = () => {
    if (!canSubmit) return;
    setErr(null);
    ret.mutate(
      {
        id: sale.id,
        body: {
          businessDate: effDate,
          items: chosen.map((x) => ({ saleItemId: x.it.id, qty: x.n as number, resalable: resalable[x.it.id] ?? true })),
          ...(note.trim() ? { note: note.trim() } : {}),
          clientRef,
        },
      },
      { onSuccess: (r) => { toast.success('Return saved.'); notifyCashWarnings(toast, r.warnings); onClose(); }, onError: (e) => setErr(e) },
    );
  };

  return (
    <FormDialog title={`Return items — sale #${sale.id}`} submitLabel="Save return" canSubmit={canSubmit} loading={ret.isPending} error={banner} onSubmit={submit} onClose={onClose} widthClass="max-w-2xl">
      <p className="text-sm text-slate-600">
        Resalable items go back into stock at their original cost. Damaged items are not restocked; they are recorded once as a stock loss at cost.
        The refund equals the selling price of the returned units.
      </p>
      <TextField
        label="Return date"
        type="date"
        value={effDate}
        min={sale.businessDate}
        max={today || undefined}
        onChange={(e) => setDate(e.target.value)}
        hint={`Between ${sale.businessDate} (sale date) and today.`}
        error={fe.businessDate ?? (date && !dateOk ? 'Pick a date from the sale date up to today.' : undefined)}
      />
      <div className="space-y-4">
        {sale.items.map((it) => {
          const rem = remaining(it);
          const raw = qty[it.id] ?? '';
          const n = parseIntStrict(raw);
          const idx = idxOf.get(it.id);
          const serverErr = idx !== undefined ? fe[`items.${idx}.qty`] : undefined;
          return (
            <div key={it.id} className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <TextField
                label={`${it.productName} — qty to return (up to ${rem})`}
                inputMode="numeric"
                disabled={rem === 0}
                value={raw}
                onChange={(e) => setQty((u) => ({ ...u, [it.id]: e.target.value }))}
                placeholder="0"
                hint={rem === 0 ? 'Everything on this line has already been returned.' : `Sold ${it.qty}, already returned ${it.returnedQty}.`}
                error={serverErr ?? (raw.trim() !== '' && (n === null || n < 1 || n > rem) ? `Enter a whole number from 1 to ${rem}.` : undefined)}
                autoComplete="off"
              />
              <SelectField
                label={`${it.productName} — condition`}
                disabled={rem === 0}
                value={(resalable[it.id] ?? true) ? 'resalable' : 'damaged'}
                onChange={(e) => setResalable((r) => ({ ...r, [it.id]: e.target.value === 'resalable' }))}
              >
                <option value="resalable">Resalable</option>
                <option value="damaged">Damaged</option>
              </SelectField>
            </div>
          );
        })}
      </div>
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </FormDialog>
  );
}
