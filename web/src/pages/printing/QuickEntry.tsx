/**
 * QuickEntry: the fast "record a print sale" panel at the top of Services > Print & service sales.
 *
 * One tap on a service button (B/W, colour, photocopy ...) selects it and fills in its price; the cashier types the
 * number of pages, may change the price for this one sale (e.g. a custom job), and saves.
 * API: POST /print-sales (api/printing.ts). The server snapshots the standard cost (R12), works out revenue and
 * puts the revenue into the shop cash book; the figures under "Preview" only show the owner what to expect.
 *
 * Rules reflected here (the server enforces them and is authoritative):
 *  - R-FD: the date cannot be in the future (picker max = today); backdating is allowed and audited.
 *  - R13: a price below the standard cost is a warning, never a block.
 *  - Duplicate protection: a `clientRef` is created when the panel mounts; the parent re-mounts it (new key) after a
 *    successful save, so the next sale gets a fresh reference while a retried Save of the same sale does not post twice.
 */
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Money } from '../../components/Money';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreatePrintSale } from '../../api/printing';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner, fieldError } from '../../lib/errors';
import { formatLKR } from '../../lib/format';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { PrintSale, PrintServiceType, PrintWarning } from '../../types/printing';
import { parseIntStrict } from '../purchases/helpers';
import { MAX_NOTE, MAX_QTY, MAX_UNIT_CENTS } from './shared';

interface Props {
  /** Active service types (the buttons). */
  types: PrintServiceType[];
  /** Called after the server saved the sale; the parent shows the result and re-mounts this panel. */
  onSaved: (sale: PrintSale, warnings: PrintWarning[]) => void;
}

/** The quick-entry form. Mount with a new `key` for every new sale. */
export function QuickEntry({ types, onSaved }: Props) {
  const toast = useToast();
  const create = useCreatePrintSale();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();

  const [typeId, setTypeId] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const type = types.find((t) => t.id === typeId);
  const qtyN = parseIntStrict(qty);
  const qtyOk = qtyN !== null && qtyN >= 1 && qtyN <= MAX_QTY;
  const priceC = rupeesToCents(price);
  const priceOk = priceC !== null && priceC <= MAX_UNIT_CENTS;
  const canSubmit = Boolean(date) && type !== undefined && qtyOk && priceOk && notes.length <= MAX_NOTE && !create.isPending;

  const choose = (t: PrintServiceType) => {
    setTypeId(t.id);
    setPrice(centsToRupees(t.priceCents)); // the standard price; the cashier may change it for this sale
  };

  const submit = () => {
    if (!canSubmit || !type || qtyN === null || priceC === null) { setShowErrors(true); return; }
    create.mutate(
      {
        businessDate: date, serviceTypeId: type.id, qty: qtyN, clientRef, notes: notes.trim() || undefined,
        // Sent only when the cashier changed the price; otherwise the server uses the type's current price.
        unitPriceCents: priceC === type.priceCents ? undefined : priceC,
      },
      {
        onSuccess: (r) => {
          toast.success(`Recorded ${r.item.qty} × ${r.item.description}.`);
          onSaved(r.item, r.warnings);
        },
      },
    );
  };

  // Preview only (whole-number multiplication): the saved figures come from the server.
  const preview = type && qtyOk && priceOk && qtyN !== null && priceC !== null
    ? { revenue: qtyN * priceC, cost: qtyN * type.costCents }
    : null;
  const below = type !== undefined && priceOk && priceC !== null && priceC < type.costCents;
  const err = create.error;
  const handled = ['businessDate', 'serviceTypeId', 'qty', 'unitPriceCents', 'notes'];

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">1. Choose the service</p>
        {types.length === 0 ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">No service is switched on. Turn one on in the Service types tab.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={t.id === typeId}
                onClick={() => choose(t)}
                className={`flex min-h-16 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left transition-colors ${
                  t.id === typeId ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-600' : 'border-slate-300 bg-white hover:bg-slate-50'
                }`}
              >
                <span className="text-sm font-semibold text-slate-900">{t.name}</span>
                <span className="num text-xs text-slate-600">{formatLKR(t.priceCents)} per page</span>
              </button>
            ))}
          </div>
        )}
        {showErrors && !type && <p className="mt-1 text-sm text-red-600">Choose a service.</p>}
        {fieldError(err, 'serviceTypeId') && <p className="mt-1 text-sm text-red-600">{fieldError(err, 'serviceTypeId')}</p>}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">2. Pages and price</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label="Pages (quantity)"
            inputMode="numeric"
            autoComplete="off"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            error={fieldError(err, 'qty') ?? (showErrors && !qtyOk ? 'Enter a whole number, 1 or more.' : undefined)}
          />
          <TextField
            label="Price per page (Rs.)"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint={type ? 'Filled in from the price list; change it for this sale if needed.' : undefined}
            error={fieldError(err, 'unitPriceCents') ?? (showErrors && type && !priceOk ? 'Enter an amount such as 15 or 15.50.' : undefined)}
          />
          <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
          <TextField label="Note (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(err, 'notes')} />
        </div>
      </div>

      {preview && type && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700" aria-live="polite">
          <p className="font-medium text-slate-900">Preview</p>
          <p>
            Customer pays <Money cents={preview.revenue} className="font-semibold" /> · standard cost <Money cents={preview.cost} /> · gross profit{' '}
            <Money cents={preview.revenue - preview.cost} />
          </p>
          {below && (
            <p className="mt-1 text-amber-800">
              This price is below the standard cost of {formatLKR(type.costCents)} per page, so the sale makes a loss. You can still save it.
            </p>
          )}
        </div>
      )}

      {errorBanner(err, handled) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorBanner(err, handled)}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit} loading={create.isPending}>Record sale</Button>
      </div>
    </form>
  );
}
