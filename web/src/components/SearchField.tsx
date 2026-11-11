/**
 * SearchField: a text box with a magnifier icon, used in list filter bars (products, purchases).
 */
import { Search } from 'lucide-react';
import { TextField } from './TextField';

interface SearchFieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  /** Extra classes for the wrapper, e.g. a grid column span. */
  className?: string;
}

/**
 * The icon is absolutely positioned over the left padding of the input and ignores mouse clicks
 * (pointer-events-none) so clicking it still focuses the text box. Debouncing is the caller's job (useDebounced).
 */
export function SearchField({ label, placeholder, value, onChange, className }: SearchFieldProps) {
  return (
    <div className={['relative', className].filter(Boolean).join(' ')}>
      <TextField
        label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        className="[&_input]:pl-9"
      />
      <Search size={16} className="pointer-events-none absolute bottom-3 left-3 text-slate-400" aria-hidden="true" />
    </div>
  );
}
