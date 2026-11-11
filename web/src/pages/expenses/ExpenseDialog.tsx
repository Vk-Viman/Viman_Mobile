/**
 * ExpenseDialog: "Add expense" form (Expenses screen). An expense is money paid OUT of the Shop or the Telecom cash book.
 * API: POST /expenses (api/expenses.ts), categories from GET /expenses/categories.
 *
 * Rules reflected here (the server is authoritative): Shop or Telecom only (Ice Cream costs are recorded under Ice Cream,
 * section 7); there is NO Electricity category - the whole shop's electricity is paid from the Ice Cream book (E1-E4), which
 * is explained in the form; R-FD (date not in the future, backdating allowed and audited); R9 (a closed day is refused with
 * a message that says to reopen it); R13 (a warning, not a block, when the book goes below zero); `clientRef` per opening.
 * Mount only while open so each opening has a fresh form and a fresh clientRef (duplicate-submission guard).
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateExpense, useExpenseCategories } from '../../api/expenses';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner, fieldError } from '../../lib/errors';

/** Longest description the server accepts. */
const MAX_DESCRIPTION = 200;
/** The sentence the owner approved for the electricity rule (E2). */
export const ELECTRICITY_NOTE = 'Electricity is paid from the Ice Cream book.';

/** The add-expense form: date, book, category, amount, what it was for. */
export function ExpenseDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreateExpense();
  const categories = useExpenseCategories();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [book, setBook] = useState<'shop' | 'telecom'>('shop');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const amountCents = parseMoney(amount);
  const descOk = description.trim().length >= 1 && description.trim().length <= MAX_DESCRIPTION;
  const canSubmit = Boolean(date) && category !== '' && amountCents !== null && descOk && notes.length <= MAX_NOTE && !create.isPending;

  const submit = () => {
    if (!canSubmit || amountCents === null) { setShowErrors(true); return; }
    create.mutate(
      { businessDate: date, book, category, amountCents, description: description.trim(), notes: notes.trim() || undefined, clientRef },
      {
        onSuccess: (r) => {
          toast.success('Expense recorded.');
          notifyCashWarnings(toast, r.warnings); // R13: the shared negative-cash warning
          onClose();
        },
      },
    );
  };

  const err = create.error;
  return (
    <FormDialog title="Add expense" submitLabel="Save" canSubmit={canSubmit} loading={create.isPending}
      error={errorBanner(err, ['businessDate', 'book', 'category', 'amountCents', 'description', 'notes'])} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        An expense is money paid out of the cash book you choose and counts as a cost of that book. {ELECTRICITY_NOTE}
      </p>
      <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <fieldset>
        <legend className="mb-1 block text-sm font-medium text-slate-700">Paid from</legend>
        <div className="flex gap-2" role="radiogroup" aria-label="Paid from">
          {(['shop', 'telecom'] as const).map((b) => (
            <label key={b} className={`flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-lg border px-3 text-sm font-medium ${book === b ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              <input type="radio" name="expense-book" value={b} checked={book === b} onChange={() => setBook(b)} className="sr-only" />
              {b === 'shop' ? 'Shop' : 'Telecom'}
            </label>
          ))}
        </div>
        {fieldError(err, 'book') && <p className="mt-1 text-sm text-red-600">{fieldError(err, 'book')}</p>}
      </fieldset>
      <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)}
        error={fieldError(err, 'category') ?? (showErrors && category === '' ? 'Choose a category.' : undefined)}>
        <option value="">Select a category</option>
        {(categories.data?.items ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </SelectField>
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount}
        error={fieldError(err, 'amountCents') ?? (showErrors && amountCents === null ? 'Enter an amount above zero, such as 2500 or 2500.50.' : undefined)} />
      <TextField label="What was it for?" placeholder="e.g. November shop rent" value={description} maxLength={MAX_DESCRIPTION} autoComplete="off"
        onChange={(e) => setDescription(e.target.value)}
        error={fieldError(err, 'description') ?? (showErrors && !descOk ? 'Say what the money was for.' : undefined)} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(err, 'notes')} />
    </FormDialog>
  );
}
