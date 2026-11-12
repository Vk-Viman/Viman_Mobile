/**
 * CapitalDialog: "Add capital" form (Capital tab). Capital is the owner's own money put INTO a cash book (BUSINESS_RULES
 * sections 8 and 9): it is not income and never becomes profit; for Ice Cream it is never profit-eligible (10.4).
 * API: POST /capital (api/transfers.ts).
 *
 * Rules reflected here (the server is authoritative): the Ice Cream book needs the fund the money goes into (10.2);
 * amount at least Rs. 0.01; R-FD (date not in the future, backdating allowed and audited); R9 (a closed day is refused);
 * `clientRef` per opening. Mount only while open so each opening has a fresh form and clientRef (duplicate-submission guard).
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateCapital } from '../../api/transfers';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import type { CashBook, IceFund } from '../../types/cashbooks';
import { CASHBOOK_LABEL } from '../cashbooks/shared';
import { BookFundFields, fundFor } from './BookFundFields';

/** The form: date, book (and fund for Ice Cream), amount, note. */
export function CapitalDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateCapital();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [book, setBook] = useState<CashBook>('shop');
  const [fund, setFund] = useState<IceFund>('cost');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const canSubmit = Boolean(date) && amountCents !== null && note.length <= MAX_NOTE && !create.isPending;

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, book, ...fundFor(book, fund), amountCents, note: note.trim() || undefined, clientRef },
      { onSuccess: (r) => { toast.success('Capital recorded.'); notifyCashWarnings(toast, r.warnings); onClose(); } },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Add capital" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'book', 'fund', 'amountCents', 'note'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        Your own money put into the {CASHBOOK_LABEL[book]} cash book. It is not income and never counts as profit.
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <BookFundFields bookLabel="Put into" fundLabel="Into which fund?" book={book} fund={fund} onBook={setBook} onFund={setFund}
        bookError={fieldError(err, 'book')} fundError={fieldError(err, 'fund')} />
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 50000 or 50000.50.' : undefined)} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
