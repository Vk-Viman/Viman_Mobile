import { useId } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { inputClass } from './TextField';

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string;
  hint?: string;
  hideLabel?: boolean;
  children: ReactNode;
}

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
