/**
 * CountFields: the drawer-count part shared by the "Count cash" and "Close day" dialogs.
 * Shows what the books expect at the END of the chosen day (GET /cash-counts/expected), takes the counted amount, previews
 * the difference (counted - expected, C4) and asks for the note (required when the count differs) and, for Ice Cream, the
 * fund the over/short belongs to (default Profit, C4; the owner may choose another and it is audited). Preview only: the
 * server recalculates expected and difference when it saves.
 */
import { MoneyInput } from '../../components/MoneyInput';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useExpectedCash } from '../../api/cashbooks';
import { MAX_NOTE } from '../../lib/amounts';
import type { CashBook, IceFund } from '../../types/cashbooks';
import { FUNDS, FUND_LABEL, countDifference } from './shared';

interface Props {
  book: CashBook;
  date: string;
  counted: string;
  onCounted: (v: string) => void;
  /** The counted amount in cents, or null while the box is empty / invalid. */
  countedCents: number | null;
  note: string;
  onNote: (v: string) => void;
  fund: IceFund;
  onFund: (v: IceFund) => void;
  /** Field messages from the server (`fields`), by name. */
  fieldErrors: { countedCents?: string; note?: string; fund?: string };
  /** Show the "required" messages (after the first submit attempt). */
  showErrors: boolean;
}

/** Expected amount, counted input, over/short preview, note and (Ice Cream) fund. */
export function CountFields({ book, date, counted, onCounted, countedCents, note, onNote, fund, onFund, fieldErrors, showErrors }: Props) {
  const expected = useExpectedCash(book, date);
  const diff = expected.data && countedCents !== null ? countDifference(expected.data.expectedCents, countedCents) : null;
  const differs = diff !== null && diff !== 0;
  return (
    <>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
        The books say the drawer should hold{' '}
        {expected.data ? <Money cents={expected.data.expectedCents} className="font-semibold" /> : <span className="text-slate-500">…</span>}{' '}
        at the end of {date || 'the chosen day'}.
      </p>
      <MoneyInput label="Counted in the drawer (Rs.)" value={counted} onChange={onCounted}
        error={fieldErrors.countedCents ?? (showErrors && countedCents === null ? 'Enter what you counted (0 if the drawer is empty).' : undefined)} />
      {diff !== null && (
        <p role="status" className={`rounded-lg p-3 text-sm ${diff === 0 ? 'bg-brand-50 text-brand-800' : 'bg-amber-50 text-amber-900'}`}>
          {diff === 0 ? 'The count matches the books.' : diff > 0 ? <>Cash over by <Money cents={diff} className="font-semibold" />.</> : <>Cash short by <Money cents={-diff} className="font-semibold" />.</>}
        </p>
      )}
      {(differs || note !== '' || fieldErrors.note) && (
        <TextField label={differs ? 'Why is it different? (required)' : 'Note (optional)'} value={note} maxLength={MAX_NOTE} autoComplete="off"
          onChange={(e) => onNote(e.target.value)}
          error={fieldErrors.note ?? (showErrors && differs && note.trim() === '' ? 'Write a short note to explain the difference.' : undefined)} />
      )}
      {book === 'icecream' && differs && (
        <SelectField label="Ice Cream fund for the over / short" value={fund} onChange={(e) => onFund(e.target.value as IceFund)} error={fieldErrors.fund}
          hint="Profit is the usual choice. The choice is recorded in the audit log.">
          {FUNDS.map((f) => <option key={f} value={f}>{FUND_LABEL[f]}</option>)}
        </SelectField>
      )}
    </>
  );
}
