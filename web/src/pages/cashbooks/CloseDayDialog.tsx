/**
 * CloseDayDialog: "Close day" for one cash book (Cash Books screen).
 * API: POST /daily-closings (api/cashbooks.ts). Closing locks ONE book for ONE business date: afterwards every record dated that
 * day in that book (create, void, return) is refused until the day is reopened (R9). The owner may count the drawer first: the
 * count and its over/short adjustment are posted, then the day is closed (BUSINESS_RULES section 8).
 *
 * Rules reflected here (the server is authoritative): a day can only be closed once (DAY_ALREADY_CLOSED); R-FD (a future day
 * cannot be closed); a differing count needs a note (and, for Ice Cream, a fund); `clientRef` per opening.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCloseDay } from '../../api/cashbooks';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import { scopeLabel } from '../../lib/segments';
import type { CashBook, IceFund } from '../../types/cashbooks';
import type { StoredSegment } from '../../types/segments';
import { CountFields } from './CountFields';
import { DEFAULT_OVER_SHORT_FUND } from './shared';

/**
 * The close-day form. Mount only while open (fresh form, fresh clientRef). Telecom closes ONE segment (13D: the others stay open).
 * "Telecom before segments" can only be closed AGAIN after a reopen, and without a count (it takes no new records).
 */
export function CloseDayDialog({ book, segment, onClose }: { book: CashBook; segment: StoredSegment | null; onClose: () => void }) {
  const toast = useToast();
  const close = useCloseDay();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const label = scopeLabel(book, segment);
  const isLegacy = segment === 'legacy';
  const [withCount, setWithCount] = useState(!isLegacy);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [fund, setFund] = useState<IceFund>(DEFAULT_OVER_SHORT_FUND);
  const [showErrors, setShowErrors] = useState(false);

  const countedCents = parseMoney(counted, 0);
  const canSubmit = Boolean(date) && (!withCount || countedCents !== null) && !close.isPending;

  const submit = () => {
    if (!canSubmit) { setShowErrors(true); return; }
    close.mutate(
      {
        book, ...(segment ? { segment } : {}), businessDate: date, clientRef,
        ...(withCount && !isLegacy && countedCents !== null ? { countedCents, ...(book === 'icecream' ? { fund } : {}) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { onSuccess: (r) => { toast.success(`${date} is now closed for the ${label} book.`); notifyCashWarnings(toast, r.warnings); onClose(); } },
    );
  };

  const err = close.error;
  return (
    <FormDialog title={`${isLegacy ? 'Close again' : 'Close day'} - ${label}`} submitLabel="Close day" canSubmit={canSubmit} loading={close.isPending}
      error={errorBanner(err, ['businessDate', 'countedCents', 'note', 'fund'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        Closing locks this day in the {label} book: nothing dated that day can be added, voided or returned until you reopen it
        (the reopen is recorded in the audit log).
        {book === 'telecom' && !isLegacy && ' The other Telecom segments stay open for that day.'}
        {isLegacy && ' Only a day that you reopened can be closed again; there is no drawer count for this old history.'}
      </p>
      <TextField label="Day to close" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      {!isLegacy && (
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={withCount} onChange={(e) => setWithCount(e.target.checked)} />
          Count the drawer before closing
        </label>
      )}
      {withCount && !isLegacy ? (
        <CountFields book={book} segment={segment} date={date} counted={counted} onCounted={setCounted} countedCents={countedCents} note={note} onNote={setNote}
          fund={fund} onFund={setFund} showErrors={showErrors}
          fieldErrors={{ countedCents: fieldError(err, 'countedCents'), note: fieldError(err, 'note'), fund: fieldError(err, 'fund') }} />
      ) : (
        <TextField label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
      )}
    </FormDialog>
  );
}
