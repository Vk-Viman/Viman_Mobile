import { TextField } from './TextField';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hideLabel?: boolean;
  className?: string;
}

/** Rupee input (up to 2 decimals). Holds a string; convert with rupeesToCents(). */
export function MoneyInput({ label, value, onChange, error, hideLabel, className }: Props) {
  return (
    <TextField
      label={label}
      hideLabel={hideLabel}
      className={className}
      error={error}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0.00"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
