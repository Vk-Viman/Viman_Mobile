/**
 * CategoryBookChoice: the "Shop or Telecom?" required choice used by the category dialog and the product dialog.
 * WHY radios with no pre-selected value: a default could be accepted by accident and put a Shop product or category
 * into the Telecom book (or the reverse), so the owner must tap one deliberately.
 */
import { useId } from 'react';
import { BOOK_LABEL } from '../../lib/constants';
import type { Book } from '../../types/api';

interface Props {
  /** Group label shown above the options. */
  label: string;
  /** The chosen book, or '' while nothing is chosen yet. */
  value: Book | '';
  onChange: (book: Book) => void;
  /** Read-only display (the book is fixed, e.g. when editing). */
  disabled?: boolean;
  /** Validation or server message. */
  error?: string;
  /** Small helper text under the options (hidden while an error is shown). */
  hint?: string;
}

const BOOKS: Book[] = ['shop', 'telecom'];

/** Two large, touch-friendly radio buttons: Shop / Telecom. */
export function CategoryBookChoice({ label, value, onChange, disabled, error, hint }: Props) {
  const id = useId();
  const name = `${id}-book`;
  const descId = `${id}-d`;
  return (
    <fieldset aria-describedby={error || hint ? descId : undefined} aria-invalid={error ? true : undefined}>
      <legend className="mb-1 block text-sm font-medium text-slate-700">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {BOOKS.map((b) => (
          <label
            key={b}
            className={[
              'flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium',
              value === b ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700',
              disabled ? 'cursor-not-allowed opacity-70' : 'hover:bg-slate-50',
            ].join(' ')}
          >
            <input
              type="radio"
              name={name}
              value={b}
              checked={value === b}
              disabled={disabled}
              onChange={() => onChange(b)}
              className="h-4 w-4 border-slate-300 text-brand-600"
            />
            {BOOK_LABEL[b]}
          </label>
        ))}
      </div>
      {error ? (
        <p id={descId} className="mt-1 text-sm text-red-600">{error}</p>
      ) : hint ? (
        <p id={descId} className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </fieldset>
  );
}
