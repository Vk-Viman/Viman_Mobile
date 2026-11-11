/**
 * PercentInput: a text box for typing a percentage such as a commission rate.
 * Used in Settings > Rates. The form converts the text to integer basis points with percentToBp() (lib/units.ts).
 */
import { TextField } from './TextField';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  className?: string;
}

/**
 * Percent input (up to 2 decimals). Holds a string; convert with percentToBp().
 * Kept as text for the same reason as MoneyInput: free typing now, exact integer conversion at submit.
 */
export function PercentInput({ label, value, onChange, error, hint, className }: Props) {
  return (
    <TextField
      label={label}
      className={className}
      error={error}
      hint={hint}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
