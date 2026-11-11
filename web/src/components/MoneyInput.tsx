/**
 * MoneyInput: a text box for typing a rupee amount.
 * Used in every form that takes money (prices, costs, payments). The conversion to integer cents happens in the
 * form, with rupeesToCents() from lib/units.ts, at submit time.
 */
import { TextField } from './TextField';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hideLabel?: boolean;
  className?: string;
}

/**
 * Rupee input (up to 2 decimals). Holds a string; convert with rupeesToCents().
 * The value is kept as TEXT (not a number) so the owner can type "12." or "0.5" freely mid-edit; the text is
 * only turned into integer cents once, when the form is validated. inputMode="decimal" brings up a numeric
 * keypad on touch devices.
 */
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
