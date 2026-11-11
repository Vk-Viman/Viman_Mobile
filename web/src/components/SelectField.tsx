/**
 * SelectField: a labelled drop-down list (native <select>) with optional hint and error text.
 * Same look and accessibility wiring as TextField; options are passed as <option> children.
 */
import { useId } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { inputClass } from './TextField';

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  /** Validation message; turns the border red and is announced by screen readers. */
  error?: string;
  /** Small helper text under the box (hidden while an error is shown). */
  hint?: string;
  /** Hide the label visually but keep it for screen readers (used in filter bars). */
  hideLabel?: boolean;
  children: ReactNode;
}

/** Renders label + <select>. The id is generated per instance, so labels/errors always point at the right box. */
export function SelectField({ label, error, hint, hideLabel, className = '', children, ...rest }: Props) {
  const id = useId();
  const descId = `${id}-d`;
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'mb-1 block text-sm font-medium text-slate-700'}>{label}</label>
      <select
        id={id}
        className={inputClass(error)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? descId : undefined}
        {...rest}
      >
        {children}
      </select>
      {error ? (
        <p id={descId} className="mt-1 text-sm text-red-600">{error}</p>
      ) : hint ? (
        <p id={descId} className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}
