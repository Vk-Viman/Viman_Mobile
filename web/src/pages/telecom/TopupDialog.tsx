/**
 * TopupDialog: "Record top-up" form (Telecom > Top-ups). Cash the owner paid out to refill a provider's reload
 * balance (provider top-up, a provider is required) or the EZCash wallet (wallet top-up, no provider).
 * API: POST /telecom/topups (api/telecom.ts), providers from GET /reload-providers.
 *
 * Rules reflected here (the server is authoritative): a top-up is a cash OUT of the Telecom book and never an expense
 * or income (section 2); no float or balance is tracked (R14); R-FD (no future dates); `clientRef` per opening.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateTopup, useReloadProviders } from '../../api/telecom';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner, fieldError } from '../../lib/errors';
import type { TopupKind } from '../../types/telecom';
import { MAX_NOTE, parseAmount } from './shared';

/** Record a top-up. Mount only while open (fresh form, fresh clientRef). */
export function TopupDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateTopup();
  const providers = useReloadProviders();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [kind, setKind] = useState<TopupKind>('provider_topup');
  const [providerId, setProviderId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const active = (providers.data?.items ?? []).filter((p) => p.active);
  const amountCents = parseAmount(amount);
  const providerOk = kind === 'wallet_topup' || active.some((p) => String(p.id) === providerId);
  const canSubmit = Boolean(date) && amountCents !== null && providerOk && notes.length <= MAX_NOTE && !create.isPending;

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    create.mutate(
      {
        businessDate: date, kind, providerId: kind === 'provider_topup' ? Number(providerId) : undefined, amountCents,
        notes: notes.trim() || undefined, clientRef,
      },
      { onSuccess: () => { toast.success('Top-up recorded.'); onClose(); } },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Record top-up" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'providerId', 'amountCents', 'notes'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        A top-up is cash paid out of the Telecom cash book. It is not an expense and not income.
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <SelectField label="Top-up for" value={kind} onChange={(e) => setKind(e.target.value as TopupKind)}>
        <option value="provider_topup">A reload provider</option>
        <option value="wallet_topup">The EZCash wallet</option>
      </SelectField>
      {kind === 'provider_topup' && (
        <SelectField label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}
          error={fieldError(err, 'providerId') ?? (showErrors && !providerOk ? 'Choose a provider.' : undefined)}
          hint="Switched-off providers are not listed.">
          <option value="">Select a provider</option>
          {active.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </SelectField>
      )}
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount of Rs. 0.01 or more.' : undefined)} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(err, 'notes')} />
    </FormDialog>
  );
}
