/**
 * ExpenseCorrection: thin adapter that plugs the Expense fields into the shared CorrectionDialog (components/CorrectionDialog.tsx).
 * Replacement body = the normal POST /expenses body. Pre-filled from the original.
 */
import { useState } from 'react';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { SegmentSelect } from '../../components/SegmentSelect';
import { TextField } from '../../components/TextField';
import { useExpenseCategories } from '../../api/expenses';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { BOOK_LABEL } from '../../lib/constants';
import { centsToRupees } from '../../lib/units';
import type { Expense } from '../../types/cashbooks';
import { SEGMENT_LABEL, isTelecomSegment } from '../../lib/segments';
import type { TelecomSegment } from '../../types/segments';

const MAX_DESCRIPTION = 200;

export function ExpenseCorrection({ original, onClose }: { original: Expense; onClose: () => void }) {
  const categories = useExpenseCategories();
  const labelOf = (v: string) => categories.data?.items.find((c) => c.value === v)?.label ?? v;
  const [book, setBook] = useState<'shop' | 'telecom'>(original.book as 'shop' | 'telecom');
  // 13D: starts on the original segment (legacy starts empty: a real segment must be chosen)
  const [segment, setSegment] = useState<TelecomSegment | ''>(isTelecomSegment(original.segment) ? original.segment : '');
  const [category, setCategory] = useState(original.category);
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [description, setDescription] = useState(original.description);
  const [notes, setNotes] = useState(original.notes ?? '');
  const [show, setShow] = useState(false);

  const cents = parseMoney(amount);
  const descOk = description.trim().length >= 1 && description.trim().length <= MAX_DESCRIPTION;

  const describe = (e: Expense): DescribeLine[] => [
    ['Date', e.businessDate], ['Book', e.segment ? `${BOOK_LABEL[e.book as 'shop' | 'telecom']} - ${SEGMENT_LABEL[e.segment]}` : BOOK_LABEL[e.book as 'shop' | 'telecom']], ['Category', labelOf(e.category)],
    ['Amount', <Money key="a" cents={e.amountCents} />], ['What for', e.description], ['Notes', e.notes || '—'],
  ];

  return (
    <CorrectionDialog<Expense> entity="expenses" noun="expense" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (cents === null || !descOk || !category || (book === 'telecom' && segment === '') || notes.length > MAX_NOTE) { setShow(true); return null; }
        return { businessDate, book, ...(book === 'telecom' && segment ? { segment } : {}), category, amountCents: cents, description: description.trim(), notes: notes.trim() || undefined, clientRef };
      }}>
      <fieldset>
        <legend className="mb-1 block text-sm font-medium text-slate-700">Paid from</legend>
        <div className="flex gap-2" role="radiogroup" aria-label="Paid from">
          {(['shop', 'telecom'] as const).map((b) => (
            <label key={b} className={`flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-lg border px-3 text-sm font-medium ${book === b ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              <input type="radio" name="corr-expense-book" value={b} checked={book === b} onChange={() => setBook(b)} className="sr-only" />
              {BOOK_LABEL[b]}
            </label>
          ))}
        </div>
      </fieldset>
      {book === 'telecom' && <SegmentSelect value={segment} onChange={setSegment} error={show && segment === '' ? 'Choose the Telecom segment.' : undefined} />}
      <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)} error={show && !category ? 'Choose a category.' : undefined}>
        <option value="">Select a category</option>
        {(categories.data?.items ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </SelectField>
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? 'Enter an amount above zero, such as 2500 or 2500.50.' : undefined} />
      <TextField label="What was it for?" value={description} maxLength={MAX_DESCRIPTION} autoComplete="off" onChange={(e) => setDescription(e.target.value)}
        error={show && !descOk ? 'Say what the money was for.' : undefined} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}
