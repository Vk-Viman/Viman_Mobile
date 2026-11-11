/**
 * TextField: a labelled text box with optional hint and error text.
 * The base of all form inputs (MoneyInput and PercentInput wrap it). Wires label, hint and error to the input
 * for screen readers.
 */
import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

/** Shared class string for text boxes and drop-downs (red border when `error` is set). */
export const inputClass = (error?: string) =>
  `block min-h-10 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 disabled:bg-slate-100 disabled:text-slate-500 ${
    error ? 'border-red-500' : 'border-slate-300'
  }`;

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Validation message; turns the border red and is announced by screen readers (aria-invalid). */
  error?: string;
  /** Small helper text under the box (hidden while an error is shown). */
  hint?: string;
  /** Hide the label visually but keep it for screen readers (used in filter bars). */
  hideLabel?: boolean;
}

/**
 * Renders label + <input>. Every normal input attribute (value, onChange, type, maxLength...) passes through.
 * `useId` gives each instance a unique id so the <label htmlFor> and aria-describedby links are always correct,
 * even when the same form appears twice on a page.
 */
export function TextField({ label, error, hint, hideLabel, className = '', ...rest }: Props) {
  const id = useId();
  const descId = `${id}-d`;
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'mb-1 block text-sm font-medium text-slate-700'}>
        {label}
      </label>
      <input
        id={id}
        className={inputClass(error)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? descId : undefined}
        {...rest}
      />
      {error ? (
        <p id={descId} className="mt-1 text-sm text-red-600">{error}</p>
      ) : hint ? (
        <p id={descId} className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}
