/**
 * ReloadDialog: "Record reloads" form (Telecom > Reloads). One entry = one provider's reload collection for a day.
 * API: POST /reload-sales (api/telecom.ts), providers from GET /reload-providers.
 *
 * Rules reflected here (the server enforces them and is authoritative):
 *  - The FULL amount collected goes into the Telecom cash book; only the commission (+ extra) is revenue (section 5).
 *  - Commission = round(sales x rate / 10000) + extra, previewed live with the same integer formula as the server.
 *  - R-FD: the date cannot be in the future (picker max = today); backdating is allowed and audited.
 *  - A switched-off provider cannot be chosen. `clientRef` is created once per opening so a retried Save is not doubled.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateReloadSale, useReloadProviders } from '../../api/telecom';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner, fieldError } from '../../lib/errors';
import { reloadCommissionPreview } from './commission';
import { MAX_NOTE, parseAmount, rateLabel } from './shared';

/** Record a reload entry. Mount only while open so each opening has a fresh form and a fresh clientRef. */
export function ReloadDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateReloadSale();
  const providers = useReloadProviders();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [providerId, setProviderId] = useState('');
  const [sales, setSales] = useState('');
  const [extra, setExtra] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const active = (providers.data?.items ?? []).filter((p) => p.active);
  const provider = active.find((p) => String(p.id) === providerId);

  const salesCents = parseAmount(sales);
  const extraCents = parseAmount(extra, true);
  const canSubmit = Boolean(date) && provider !== undefined && salesCents !== null && extraCents !== null && notes.length <= MAX_NOTE && !create.isPending;

  const submit = () => {
    if (!canSubmit || !provider || salesCents === null || extraCents === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, providerId: provider.id, salesCents, extraCents: extraCents || undefined, notes: notes.trim() || undefined, clientRef },
      { onSuccess: () => { toast.success('Reload entry recorded.'); onClose(); } },
    );
  };

  const err = create.error;
  const handled = ['businessDate', 'providerId', 'salesCents', 'extraCents', 'notes'];
  const commission = provider && salesCents !== null && extraCents !== null ? reloadCommissionPreview(salesCents, provider.commissionBp, extraCents) : null;

  return (
    <FormDialog title="Record reloads" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, handled)} onSubmit={submit} onClose={onClose}>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <SelectField label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}
        error={fieldError(err, 'providerId') ?? (showErrors && !provider ? 'Choose a provider.' : undefined)}
        hint={provider ? `Commission rate ${rateLabel(provider.commissionBp)}` : 'Switched-off providers are not listed.'}>
        <option value="">Select a provider</option>
        {active.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
      </SelectField>
      <MoneyInput label="Reload sales collected (Rs.)" value={sales} onChange={setSales}
        error={fieldError(err, 'salesCents') ?? (showErrors && salesCents === null ? 'Enter an amount of Rs. 0.01 or more.' : undefined)} />
      <MoneyInput label="Extra commission (Rs., optional)" value={extra} onChange={setExtra}
        error={fieldError(err, 'extraCents') ?? (extra !== '' && extraCents === null ? 'Enter an amount, or leave empty.' : undefined)} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(err, 'notes')} />
      {commission !== null && salesCents !== null && provider && (
        <div className="rounded-lg bg-brand-50 p-3 text-sm text-slate-800" aria-live="polite">
          <p>Commission: <Money cents={commission} className="font-semibold" /> <span className="text-slate-500">({rateLabel(provider.commissionBp)} of the sales{extraCents ? ' + extra' : ''})</span></p>
          <p className="mt-1">Into the Telecom cash book: <Money cents={salesCents} className="font-semibold" /></p>
          <p className="mt-1 text-xs text-slate-500">Only the commission counts as income. The server confirms the final figure when you save.</p>
        </div>
      )}
    </FormDialog>
  );
}
