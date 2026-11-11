/**
 * ReopenDayDialog: "Reopen day" for one closed day of a cash book (Cash Books screen).
 * API: POST /daily-closings/:id/reopen (api/cashbooks.ts). A reopen needs a reason of at least 3 characters and is recorded in
 * the audit log (R9, section 12). While the day is open, records dated that day are accepted again; corrections are made as
 * reversal + new records (R1) and the day should be closed again afterwards.
 */
import { useRef, useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useReopenDay } from '../../api/cashbooks';
import { errorBanner, fieldError } from '../../lib/errors';
import type { DailyClosing } from '../../types/cashbooks';
import { CASHBOOK_LABEL } from './shared';

/** Shortest and longest reopen reason the server accepts. */
const MIN_REASON = 3;
const MAX_REASON = 200;

/** The reopen form. Mount only while open. */
export function ReopenDayDialog({ closing, onClose }: { closing: DailyClosing; onClose: () => void }) {
  const toast = useToast();
  const reopen = useReopenDay();
  const [reason, setReason] = useState('');
  // Synchronous double-click guard (state updates are asynchronous); released only if the server refuses.
  const busy = useRef(false);
  const r = reason.trim();
  const canSubmit = r.length >= MIN_REASON && r.length <= MAX_REASON && !reopen.isPending;

  const submit = () => {
    if (!canSubmit || busy.current) return;
    busy.current = true;
    reopen.mutate({ id: closing.id, reason: r }, {
      onSuccess: () => { toast.success(`${closing.businessDate} is open again. Close it again when you have finished.`); onClose(); },
      onError: () => { busy.current = false; },
    });
  };

  const err = reopen.error;
  return (
    <FormDialog title={`Reopen ${closing.businessDate} - ${CASHBOOK_LABEL[closing.book]}`} submitLabel="Reopen day" canSubmit={canSubmit}
      loading={reopen.isPending} error={errorBanner(err, ['reason'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Reopening lets records dated {closing.businessDate} be added, voided or returned again in the {CASHBOOK_LABEL[closing.book]} book.
        The reopen and your reason are recorded in the audit log. Close the day again when you have finished.
      </p>
      <TextField label={`Reason (required, ${MIN_REASON}-${MAX_REASON} characters)`} value={reason} maxLength={MAX_REASON} autoComplete="off"
        onChange={(e) => setReason(e.target.value)} error={fieldError(err, 'reason')} />
    </FormDialog>
  );
}
