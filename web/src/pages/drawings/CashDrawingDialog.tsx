/**
 * CashDrawingDialog: "Record cash drawing" form (Drawings tab). A cash drawing is money the owner takes OUT of a cash book for
 * personal use (BUSINESS_RULES section 9): it is not an expense and never changes profit.
 * API: POST /drawings with kind "cash" (api/transfers.ts).
 *
 * Rules reflected here (the server is authoritative): the Ice Cream book needs a fund (10.2); amount at least Rs. 0.01;
 * R-FD (date not in the future, backdating allowed and audited); R9 (a closed day is refused with a message that says to
 * reopen it); R13 (a warning, not a block, when the book or fund goes below zero); `clientRef` per opening.
 * Mount only while open so each opening has a fresh form and a fresh clientRef (duplicate-submission guard).
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateCashDrawing } from '../../api/transfers';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import type { CashBook, IceFund } from '../../types/cashbooks';
import { CASHBOOK_LABEL } from '../cashbooks/shared';
import { BookFundFields, fundFor } from './BookFundFields';

/** The form: date, book (and fund for Ice Cream), amount, note. */
export function CashDrawingDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateCashDrawing();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [book, setBook] = useState<CashBook>('shop');
  const [fund, setFund] = useState<IceFund>('profit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const canSubmit = Boolean(date) && amountCents !== null && note.length <= MAX_NOTE && !create.isPending;

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    create.mutate(
      { kind: 'cash', businessDate: date, book, ...fundFor(book, fund), amountCents, note: note.trim() || undefined, clientRef },
      {
        onSuccess: (r) => {
          toast.success('Cash drawing recorded.');
          notifyCashWarnings(toast, r.warnings); // R13: the shared negative-balance warning
          onClose();
        },
      },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Record cash drawing" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'book', 'fund', 'amountCents', 'note'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        Money you take out of the {CASHBOOK_LABEL[book]} cash book for yourself. It is not a business expense and does not change profit.
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <BookFundFields bookLabel="Taken from" book={book} fund={fund} onBook={setBook} onFund={setFund}
        bookError={fieldError(err, 'book')} fundError={fieldError(err, 'fund')} />
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 2500 or 2500.50.' : undefined)} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
