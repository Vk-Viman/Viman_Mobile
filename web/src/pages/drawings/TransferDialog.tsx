/**
 * TransferDialog: "Transfer cash" form (Transfers tab). Moves money from one cash book to another, e.g. Telecom to Shop
 * (BUSINESS_RULES section 8): the server writes one transfer and two linked cash entries (out of one book, into the other).
 * API: POST /cash-transfers (api/transfers.ts).
 *
 * Rules reflected here (the server is authoritative): the two books must differ (`SAME_BOOK`); each Ice Cream side names its
 * fund (10.2); a transfer is never income, cost or profit (section 9), and money arriving in the Ice Cream Profit fund by
 * transfer is not profit-eligible (10.4); R-FD; R9 (BOTH books must have the day open - the server names the closed one);
 * R13 (a warning, not a block, when the source goes below zero); `clientRef` per opening (duplicate-submission guard).
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateTransfer } from '../../api/transfers';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import type { CashBook, IceFund } from '../../types/cashbooks';
import { CASHBOOKS } from '../cashbooks/shared';
import { BookFundFields } from './BookFundFields';

/** The form: date, from book (+fund), to book (+fund), amount, note. */
export function TransferDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateTransfer();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [fromBook, setFromBook] = useState<CashBook>('shop');
  const [toBook, setToBook] = useState<CashBook>('telecom');
  const [fromFund, setFromFund] = useState<IceFund>('profit');
  const [toFund, setToFund] = useState<IceFund>('cost');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const canSubmit = Boolean(date) && fromBook !== toBook && amountCents !== null && note.length <= MAX_NOTE && !create.isPending;

  // Choosing the book that the other side already uses moves the other side to the next free book, so the two never match.
  const chooseFrom = (b: CashBook) => {
    setFromBook(b);
    if (b === toBook) setToBook(CASHBOOKS.find((x) => x !== b) ?? 'telecom');
  };
  const chooseTo = (b: CashBook) => {
    setToBook(b);
    if (b === fromBook) setFromBook(CASHBOOKS.find((x) => x !== b) ?? 'shop');
  };

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    create.mutate(
      {
        businessDate: date, fromBook, toBook,
        ...(fromBook === 'icecream' ? { fromFund } : {}),
        ...(toBook === 'icecream' ? { toFund } : {}),
        amountCents, note: note.trim() || undefined, clientRef,
      },
      {
        onSuccess: (r) => {
          toast.success('Transfer recorded.');
          notifyCashWarnings(toast, r.warnings); // R13: the shared negative-balance warning
          onClose();
        },
      },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Transfer cash between books" submitLabel="Transfer" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'fromBook', 'toBook', 'fromFund', 'toFund', 'amountCents', 'note'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        Moves money from one cash book to another. It is not income or an expense in either book and does not change profit.
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-4">
          <BookFundFields bookLabel="From book" fundLabel="From fund" book={fromBook} fund={fromFund} onBook={chooseFrom} onFund={setFromFund}
            bookError={fieldError(err, 'fromBook')} fundError={fieldError(err, 'fromFund')} />
        </div>
        <div className="space-y-4">
          <BookFundFields bookLabel="To book" fundLabel="To fund" book={toBook} fund={toFund} onBook={chooseTo} onFund={setToFund} disabledBook={fromBook}
            bookError={fieldError(err, 'toBook')} fundError={fieldError(err, 'toFund')} />
        </div>
      </div>
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 5000 or 5000.50.' : undefined)} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
