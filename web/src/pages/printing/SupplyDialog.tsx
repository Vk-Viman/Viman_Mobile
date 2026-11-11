/**
 * SupplyDialog: record a paper / toner purchase.
 * API: POST /printing-supplies via api/printing.ts. The amount is a cash-out of the Shop cash book with no profit
 * effect (R12). Rules reflected here (the server is authoritative): R-FD (date not in the future; backdating is
 * allowed and audited), R13 (a warning when the Shop book goes below zero, never a block).
 * Mount only while open so each opening has a fresh form and a fresh clientRef (duplicate-submission guard).
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreatePrintingSupply } from '../../api/printing';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';
import { rupeesToCents } from '../../lib/units';
import { MAX_NAME, MAX_SUPPLY_CENTS } from './shared';

/** The purchase form: date, what was bought, amount paid. */
export function SupplyDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePrintingSupply();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountC = rupeesToCents(amount);
  const descOk = description.trim().length >= 1 && description.trim().length <= MAX_NAME;
  const amountOk = amountC !== null && amountC >= 1 && amountC <= MAX_SUPPLY_CENTS;
  const canSubmit = Boolean(date) && descOk && amountOk && !create.isPending;

  const submit = () => {
    if (!canSubmit || amountC === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, amountCents: amountC, description: description.trim(), clientRef },
      {
        onSuccess: (r) => {
          toast.success('Supplies purchase recorded.');
          notifyCashWarnings(toast, r.warnings); // R13: the shared negative-cash warning
          onClose();
        },
      },
    );
  };

  const err = create.error;
  const handled = ['businessDate', 'description', 'amountCents'];

  return (
    <FormDialog
      title="Record paper / toner purchase"
      submitLabel="Save"
      canSubmit={canSubmit}
      loading={create.isPending}
      error={errorBanner(err, handled)}
      onSubmit={submit}
      onClose={onClose}
    >
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        This is cash paid out of the Shop cash book. It does not change your profit; it is used by the later supplies variance report.
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <TextField
        label="What was bought"
        placeholder="e.g. A4 paper, 5 reams"
        value={description}
        maxLength={MAX_NAME}
        onChange={(e) => setDescription(e.target.value)}
        autoComplete="off"
        error={fieldError(err, 'description') ?? (showErrors && !descOk ? 'Say what was bought.' : undefined)}
      />
      <MoneyInput
        label="Amount paid (Rs.)"
        value={amount}
        onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && !amountOk ? 'Enter an amount above zero, such as 2500 or 2500.50.' : undefined)}
      />
    </FormDialog>
  );
}
