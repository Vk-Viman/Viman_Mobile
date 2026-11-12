/**
 * PaymentDialog: "Add payment" form (Ice Cream Payments tab): materials, the shop's electricity bill or another cost.
 * API: POST /icecream/payments (api/icecream.ts).
 *
 * Rules reflected here (the server is authoritative, BUSINESS_RULES 10.2, 10.3, 10.4, E1-E4, R9, R-FD, R13):
 *  - every payment is money paid OUT of the Ice Cream book and names ONE fund, chosen by the owner each time; the form presets
 *    Cost for materials and Electricity for the bill, but the choice is free;
 *  - the whole shop's electricity bill is a payment of kind "Electricity bill": it settles the electricity already charged in the
 *    daily entries and is NEVER an expense (E1, E4). There is no Electricity category: the server refuses it
 *    (ELECTRICITY_NOT_ALLOWED) and the form says so;
 *  - how it counts is derived, not chosen: only an "Other cost" paid from the PROFIT fund is an expense (lowers recognized profit);
 *    everything else settles money already set aside (10.3). The form explains which case it is;
 *  - a fund or cash book below zero is a warning, never a block (R13); a closed day (R9) is refused with the server's message;
 *    the date picker stops at today (R-FD); `clientRef` per opening (duplicate-submission guard).
 * Mount only while open so each opening has a fresh form and a fresh clientRef.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreatePayment } from '../../api/icecream';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { parseMoney } from '../../lib/amounts';
import { errorBanner, fieldError } from '../../lib/errors';
import type { IceFund } from '../../types/cashbooks';
import type { PaymentKind } from '../../types/icecream';
import { ELECTRICITY_NOTE, FUND_LABEL, FundSelect, PAYMENT_KINDS, PAYMENT_KIND_LABEL, PRESET_FUND, notifyIceWarnings } from './shared';

const MAX_DESCRIPTION = 200;
const MAX_CATEGORY = 60;

/** One sentence saying how the payment will count (mirrors the derived `pnlTreatment`; the server decides). */
function treatmentText(kind: PaymentKind, fund: IceFund): string {
  if (kind === 'other_cost' && fund === 'profit') {
    return 'Paid from the Profit fund, so it counts as an ice cream expense and lowers the recognized profit.';
  }
  if (kind === 'other_cost') {
    return `Paid from the ${FUND_LABEL[fund]} fund: it uses up part of the money already set aside (the ${fund === 'cost' ? 'materials' : 'electricity'} allocation). It is not a separate expense.`;
  }
  return `This settles ${kind === 'materials' ? 'materials' : 'electricity'} already charged in the daily entries. It is not an expense and does not change the recognized profit.`;
}

/** The add-payment form. */
export function PaymentDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePayment();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [kind, setKind] = useState<PaymentKind>('materials');
  const [fund, setFund] = useState<IceFund>(PRESET_FUND.materials);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const descOk = description.trim().length >= 1 && description.trim().length <= MAX_DESCRIPTION;
  const electricityCategory = category.trim().toLowerCase() === 'electricity';
  const canSubmit = Boolean(date) && amountCents !== null && descOk && !electricityCategory && category.length <= MAX_CATEGORY && !create.isPending;

  const pickKind = (k: PaymentKind) => { setKind(k); setFund(PRESET_FUND[k]); };

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, kind, fund, amountCents, category: category.trim() || undefined, description: description.trim(), clientRef },
      {
        onSuccess: (r) => {
          toast.success('Payment recorded.');
          notifyIceWarnings(toast, r.warnings); // R13 / 10.2 / D3: warnings, never blocks
          onClose();
        },
      },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Add Ice Cream payment" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'kind', 'fund', 'amountCents', 'category', 'description'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{ELECTRICITY_NOTE}</p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <fieldset>
        <legend className="mb-1 block text-sm font-medium text-slate-700">What is it for?</legend>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="What is it for?">
          {PAYMENT_KINDS.map((k) => (
            <label key={k} className={`flex min-h-10 cursor-pointer items-center justify-center rounded-lg border px-3 text-sm font-medium ${kind === k ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              <input type="radio" name="payment-kind" value={k} checked={kind === k} onChange={() => pickKind(k)} className="sr-only" />
              {PAYMENT_KIND_LABEL[k]}
            </label>
          ))}
        </div>
        {fieldError(err, 'kind') && <p className="mt-1 text-sm text-red-600">{fieldError(err, 'kind')}</p>}
      </fieldset>
      <FundSelect label="Paid from" value={fund} onChange={setFund} error={fieldError(err, 'fund')} />
      <p className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700" aria-live="polite">{treatmentText(kind, fund)}</p>
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 2500 or 2500.50.' : undefined)} />
      <TextField label="What was it for?" placeholder={kind === 'electricity_bill' ? 'e.g. CEB bill for October' : kind === 'materials' ? 'e.g. Milk powder and sugar' : 'e.g. Paper cups'}
        value={description} maxLength={MAX_DESCRIPTION} autoComplete="off" onChange={(e) => setDescription(e.target.value)}
        error={fieldError(err, 'description') ?? (showErrors && !descOk ? 'Say what the money was for.' : undefined)} />
      <TextField label="Category (optional)" value={category} maxLength={MAX_CATEGORY} autoComplete="off" onChange={(e) => setCategory(e.target.value)}
        hint='There is no "Electricity" category: record the electricity bill with the "Electricity bill" choice above.'
        error={fieldError(err, 'category') ?? (electricityCategory ? 'Electricity is not a category. Choose "Electricity bill" above instead.' : undefined)} />
    </FormDialog>
  );
}
