/**
 * CashCountDialog: "Count cash" for one cash book (Cash Books screen).
 * API: POST /cash-counts (api/cashbooks.ts), expected amount from GET /cash-counts/expected.
 * The owner counts the drawer; the server compares it with what the books expect at the END of the chosen day. A difference
 * is posted as "cash over / short" in that book (C4, R6) and needs a note; for Ice Cream the owner picks the fund (default Profit).
 *
 * Rules reflected here (the server is authoritative): R-FD (date not in the future, backdating audited); R9 (a closed day is
 * refused: reopen it first); R13 (a short may leave the book below zero: a warning, never a block); `clientRef` per opening.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateCashCount } from '../../api/cashbooks';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import type { CashBook, IceFund } from '../../types/cashbooks';
import { CountFields } from './CountFields';
import { CASHBOOK_LABEL, DEFAULT_OVER_SHORT_FUND } from './shared';

/** The count form. Mount only while open (fresh form, fresh clientRef). */
export function CashCountDialog({ book, onClose }: { book: CashBook; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateCashCount();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [fund, setFund] = useState<IceFund>(DEFAULT_OVER_SHORT_FUND);
  const [showErrors, setShowErrors] = useState(false);

  const countedCents = parseMoney(counted, 0);
  const canSubmit = Boolean(date) && countedCents !== null && !create.isPending;

  const submit = () => {
    if (!canSubmit || countedCents === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, book, countedCents, note: note.trim() || undefined, ...(book === 'icecream' ? { fund } : {}), clientRef },
      {
        onSuccess: (r) => {
          toast.success(r.item.differenceCents === 0 ? 'Count saved: it matches the books.' : 'Count saved: the difference was posted as cash over / short.');
          notifyCashWarnings(toast, r.warnings);
          onClose();
        },
      },
    );
  };

  const err = create.error;
  return (
    <FormDialog title={`Count cash - ${CASHBOOK_LABEL[book]}`} submitLabel="Save count" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'countedCents', 'note', 'fund'])} onSubmit={submit} onClose={onClose}>
      <TextField label="Day counted" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <CountFields book={book} date={date} counted={counted} onCounted={setCounted} countedCents={countedCents} note={note} onNote={setNote}
        fund={fund} onFund={setFund} showErrors={showErrors}
        fieldErrors={{ countedCents: fieldError(err, 'countedCents'), note: fieldError(err, 'note'), fund: fieldError(err, 'fund') }} />
    </FormDialog>
  );
}
