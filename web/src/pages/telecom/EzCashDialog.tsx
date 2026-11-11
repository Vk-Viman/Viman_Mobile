/**
 * EzCashDialog: "Record EZCash bills" form (Telecom > EZCash). One entry = bills collected for Dialog EZCash.
 * API: POST /ezcash-sales (api/telecom.ts); the EZCash rate comes from GET /settings (Settings > Rates).
 *
 * Rules reflected here (the server is authoritative): the provider is Dialog automatically; the FULL bill total goes
 * into the Telecom cash book and the commission (round(total x rate / 10000)) is the only revenue (section 5);
 * R-FD (no future dates, picker max = today); `clientRef` per opening prevents a double save.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateEzCashSale } from '../../api/telecom';
import { useSettings } from '../../api/settings';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner, fieldError } from '../../lib/errors';
import { rateCommissionPreview } from './commission';
import { MAX_NOTE, parseAmount, rateLabel } from './shared';

/** Record an EZCash entry. Mount only while open (fresh form, fresh clientRef). */
export function EzCashDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateEzCashSale();
  const settings = useSettings();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [bills, setBills] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const billCents = parseAmount(bills);
  const canSubmit = Boolean(date) && billCents !== null && notes.length <= MAX_NOTE && !create.isPending;
  const rateBp = settings.data?.rates.ezcashCommissionBp;

  const submit = () => {
    if (!canSubmit || billCents === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, billTotalCents: billCents, notes: notes.trim() || undefined, clientRef },
      { onSuccess: () => { toast.success('EZCash entry recorded.'); onClose(); } },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Record EZCash bills" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'billTotalCents', 'notes'])} onSubmit={submit} onClose={onClose}>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <MoneyInput label="Bill total collected (Rs.)" value={bills} onChange={setBills}
        error={fieldError(err, 'billTotalCents') ?? (showErrors && billCents === null ? 'Enter an amount of Rs. 0.01 or more.' : undefined)} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(err, 'notes')} />
      {billCents !== null && rateBp !== undefined && (
        <div className="rounded-lg bg-brand-50 p-3 text-sm text-slate-800" aria-live="polite">
          <p>Commission: <Money cents={rateCommissionPreview(billCents, rateBp)} className="font-semibold" /> <span className="text-slate-500">({rateLabel(rateBp)} of the bills)</span></p>
          <p className="mt-1">Into the Telecom cash book: <Money cents={billCents} className="font-semibold" /></p>
          <p className="mt-1 text-xs text-slate-500">Only the commission counts as income. The server confirms the final figure when you save.</p>
        </div>
      )}
    </FormDialog>
  );
}
