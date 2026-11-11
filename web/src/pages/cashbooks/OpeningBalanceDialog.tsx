/**
 * OpeningBalanceDialog: "Set opening balance" for one cash book (Cash Books screen).
 * API: POST /cashbooks/:book/opening (api/cashbooks.ts). The opening balance is the cash the book held when you started using
 * the system: money IN, never revenue (sections 0, 8, 9). The Ice Cream book is divided into funds (Cost / Electricity / Profit):
 * the owner names the destination fund and each fund has its own opening balance, which can never become profit (10.4).
 *
 * Rules reflected here (the server is authoritative): one posted opening balance per book (per fund for Ice Cream) - a wrong one
 * is voided and entered again (`OPENING_BALANCE_EXISTS` is shown as the server words it); R-FD (date not in the future; the
 * go-live date is in the past, which is allowed and audited); R9 (a closed day is refused); `clientRef` per opening.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useSetOpeningBalance } from '../../api/cashbooks';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import type { CapitalEntry, CashBook, IceFund } from '../../types/cashbooks';
import { CASHBOOK_LABEL, FUNDS, FUND_LABEL } from './shared';

interface Props {
  book: CashBook;
  /** The opening balances already entered (voided ones are ignored): used to offer only free funds for Ice Cream. */
  existing: CapitalEntry[];
  onClose: () => void;
}

/** The form: date, amount, (Ice Cream: fund), note. Mount only while open (fresh form, fresh clientRef). */
export function OpeningBalanceDialog({ book, existing, onClose }: Props) {
  const toast = useToast();
  const set = useSetOpeningBalance(book);
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const taken = new Set(existing.filter((e) => e.status === 'posted').map((e) => e.fund));
  const freeFunds = FUNDS.filter((f) => !taken.has(f));
  const [fund, setFund] = useState<IceFund>(freeFunds[0] ?? 'cost');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const canSubmit = Boolean(date) && amountCents !== null && note.length <= MAX_NOTE && !set.isPending;

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    set.mutate(
      { businessDate: date, amountCents, ...(book === 'icecream' ? { fund } : {}), note: note.trim() || undefined, clientRef },
      { onSuccess: (r) => { toast.success('Opening balance saved.'); notifyCashWarnings(toast, r.warnings); onClose(); } },
    );
  };

  const err = set.error;
  return (
    <FormDialog title={`Set opening balance - ${CASHBOOK_LABEL[book]}`} submitLabel="Save" canSubmit={canSubmit} loading={set.isPending}
      error={errorBanner(err, ['businessDate', 'amountCents', 'fund', 'note'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        The money the {CASHBOOK_LABEL[book]} book held when you started. It is not income. Use the date you started, which can be in the past.
        {book === 'icecream' && ' Each fund has its own opening balance.'}
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      {book === 'icecream' && (
        <SelectField label="Fund" value={fund} onChange={(e) => setFund(e.target.value as IceFund)} error={fieldError(err, 'fund')}
          hint="Funds that already have an opening balance are marked; void that one first to change it.">
          {FUNDS.map((f) => <option key={f} value={f}>{FUND_LABEL[f]}{taken.has(f) ? ' (already set)' : ''}</option>)}
        </SelectField>
      )}
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 25000 or 25000.50.' : undefined)} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
