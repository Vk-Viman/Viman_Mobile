/**
 * MoveDialog: "Move money between funds" form (Ice Cream Fund moves tab), with a live PREVIEW and the plain-language
 * SPLIT CONFIRMATION (D4).
 * API: POST /icecream/fund-moves/preview (no write), POST /icecream/fund-moves (api/icecream.ts).
 *
 * Rules reflected here (the server is authoritative, BUSINESS_RULES 10.2-10.4, D1, D4, R9, R-FD):
 *  - a move changes how the Ice Cream cash is split between the Cost, Electricity and Profit funds; it moves NO cash in or out of the
 *    book (10.2). A fund may go below zero: that is a warning, never a block;
 *  - Cost/Electricity -> Profit is a RELEASE: only the unspent part of the daily allocation (the profit-eligible amount) becomes profit;
 *    opening balance, capital and money already spent can never become profit (10.4). The form shows the split as soon as the amounts
 *    are valid;
 *  - Profit -> Cost/Electricity lowers the recognized profit by the FULL amount (D1); Cost <-> Electricity leaves profit unchanged;
 *  - when a release is larger than the profit-eligible amount, the move is NOT posted until the owner confirms the split in a plain
 *    explanation (D4); the confirmation carries the profit-eligible amount the owner saw. If the figures change before the server
 *    saves it (409 SPLIT_CONFIRMATION_REQUIRED), the preview is refreshed and the owner is asked again;
 *  - a closed day (R9) is refused with the server's message; the date picker stops at today (R-FD); `clientRef` per opening.
 * Mount only while open so each opening has a fresh form and a fresh clientRef.
 */
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FormDialog } from '../../components/FormDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateMove, useMovePreview } from '../../api/icecream';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { errorBanner, fieldError } from '../../lib/errors';
import type { IceFund } from '../../types/cashbooks';
import type { MovePreview } from '../../types/icecream';
import { FUND_LABEL, FundSelect, notifyIceWarnings } from './shared';

/** The numbers of a preview, in words the owner understands. */
function PreviewFigures({ p }: { p: MovePreview }) {
  return (
    <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      {p.kind === 'release' && (
        <>
          <dt className="text-slate-600">Counts as profit</dt>
          <dd><Money cents={p.profitEligibleCents} className="font-semibold" /></dd>
          <dt className="text-slate-600">Cash only (not profit)</dt>
          <dd><Money cents={p.cashOnlyCents} className="font-semibold" /></dd>
        </>
      )}
      {p.kind === 'relabel' && (
        <>
          <dt className="text-slate-600">Cost charge moved between the lines</dt>
          <dd><Money cents={p.chargeRelabelCents} className="font-semibold" /></dd>
        </>
      )}
      <dt className="text-slate-600">Effect on recognized profit</dt>
      <dd><Money cents={p.profitEffectCents} className="font-semibold" /></dd>
    </dl>
  );
}

/** The move form: funds, amount, date, note, preview, and the split confirmation step. */
export function MoveDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateMove();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [from, setFrom] = useState<IceFund>('cost');
  const [to, setTo] = useState<IceFund>('profit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [changed, setChanged] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const sameFund = from === to;
  const preview = useMovePreview(!sameFund && amountCents !== null ? { fromFund: from, toFund: to, amountCents } : null);
  // Never act on a preview that belongs to older inputs (the query keeps the previous answer on screen while the new one loads).
  const p = preview.data && !preview.isPlaceholderData && !preview.isFetching ? preview.data : null;
  const canSubmit = Boolean(date) && !sameFund && amountCents !== null && p !== null && note.length <= MAX_NOTE && !create.isPending;

  const done = (r: { warnings: Parameters<typeof notifyIceWarnings>[1] }) => {
    toast.success('Fund move recorded.');
    notifyIceWarnings(toast, r.warnings);
    onClose();
  };

  /** Posts the move; `confirmed` carries the profit-eligible amount the owner saw (D4). */
  const post = (confirmedProfitEligibleCents: number | undefined) => {
    if (amountCents === null) return;
    create.mutate(
      {
        businessDate: date, fromFund: from, toFund: to, amountCents, note: note.trim() || undefined, clientRef,
        ...(confirmedProfitEligibleCents === undefined ? {} : { confirmSplit: true, confirmedProfitEligibleCents }),
      },
      {
        onSuccess: done,
        onError: (e) => {
          // The server re-checks the split when it saves. If it changed since the owner looked, show the new split and ask again.
          if (e instanceof ApiError && e.code === 'SPLIT_CONFIRMATION_REQUIRED') {
            setChanged(true);
            setStep('confirm');
            void preview.refetch();
          }
        },
      },
    );
  };

  const submit = () => {
    if (!canSubmit || amountCents === null || p === null) { setShowErrors(true); return; }
    if (p.needsConfirmation) { setChanged(false); setStep('confirm'); return; } // D4: explain first, post only after confirmation
    post(undefined);
  };

  if (step === 'confirm') {
    const split = p;
    return (
      <ConfirmDialog open title="Part of this will not count as profit" confirmLabel={split ? 'Confirm and move the cash' : 'Checking...'}
        loading={create.isPending || preview.isFetching} onClose={() => setStep('edit')}
        error={create.error && !(create.error instanceof ApiError && create.error.code === 'SPLIT_CONFIRMATION_REQUIRED') ? errorBanner(create.error) : null}
        onConfirm={() => { if (split && split.needsConfirmation) post(split.profitEligibleCents); else if (split) post(undefined); }}>
        {changed && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">The figures changed since you looked. Please read them again before you confirm.</p>}
        {split ? (
          <>
            <p>
              You are moving <Money cents={amountCents ?? 0} className="font-semibold" /> from the {FUND_LABEL[from]} fund to the {FUND_LABEL[to]} fund.
            </p>
            <p>{split.explanation}</p>
            <PreviewFigures p={split} />
            <p className="text-slate-600">If you confirm, the cash moves now. Only the amount that counts as profit is added to the recognized profit.</p>
          </>
        ) : <p>Checking the figures with the server...</p>}
      </ConfirmDialog>
    );
  }

  const err = create.error;
  return (
    <FormDialog title="Move money between funds" submitLabel="Move money" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'fromFund', 'toFund', 'amountCents', 'note'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        A move only changes how the Ice Cream cash is set aside between the three funds. No cash enters or leaves the book. Moving unspent Cost or Electricity money
        into Profit is how the owner takes profit; money from the opening balance, capital or already spent never counts as profit.
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FundSelect label="From fund" value={from} onChange={setFrom} error={fieldError(err, 'fromFund')} />
        <FundSelect label="To fund" value={to} onChange={setTo} error={fieldError(err, 'toFund') ?? (sameFund ? 'Choose two different funds.' : undefined)} />
      </div>
      <MoneyInput label="Amount to move (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 2500 or 2500.50.' : undefined)} />

      <div className="rounded-lg border border-slate-200 p-3 text-sm" aria-live="polite">
        <p className="font-medium text-slate-900">What will happen</p>
        {sameFund || amountCents === null ? (
          <p className="mt-1 text-slate-500">Choose two funds and an amount to see what this move does.</p>
        ) : preview.isError ? (
          <p className="mt-1 text-red-700">{errorBanner(preview.error)}</p>
        ) : !p ? (
          <p className="mt-1 text-slate-500">Checking...</p>
        ) : (
          <>
            <p className="mt-1 text-slate-700">{p.explanation}</p>
            <PreviewFigures p={p} />
            {p.needsConfirmation && <p className="mt-2 rounded bg-amber-50 p-2 text-amber-900">You will be asked to confirm this split before the move is saved.</p>}
            {p.warnings.map((w) => <p key={w.code + (w.fund ?? '')} className="mt-2 rounded bg-amber-50 p-2 text-amber-900">{w.message}</p>)}
          </>
        )}
      </div>

      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
