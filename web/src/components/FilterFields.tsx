/**
 * Filter-bar building blocks repeated on many list screens: date range, Book drop-down, Posted/Void drop-down.
 * Each returns plain form fields (no wrapper), so the screen's own grid decides the layout.
 * An empty string always means "no filter" (the API helper `qs` then leaves the parameter out).
 */
import { SelectField } from './SelectField';
import { TextField } from './TextField';
import type { Book, PostedStatus } from '../types/api';

interface DateRangeFieldsProps {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}

/**
 * "From date" and "To date" pickers. Each limits the other (from cannot be after to) so an impossible range
 * cannot be chosen. These are REPORT/QUERY dates, so no future-date limit applies (R-FD covers transactions only).
 */
export function DateRangeFields({ from, to, onFrom, onTo }: DateRangeFieldsProps) {
  return (
    <>
      <TextField label="From date" type="date" value={from} max={to || undefined} onChange={(e) => onFrom(e.target.value)} />
      <TextField label="To date" type="date" value={to} min={from || undefined} onChange={(e) => onTo(e.target.value)} />
    </>
  );
}

/** Book drop-down with an "All" choice. */
export function BookFilterSelect({ value, onChange }: { value: '' | Book; onChange: (v: '' | Book) => void }) {
  return (
    <SelectField label="Book" value={value} onChange={(e) => onChange(e.target.value as '' | Book)}>
      <option value="">All</option>
      <option value="shop">Shop</option>
      <option value="telecom">Telecom</option>
    </SelectField>
  );
}

/** Status drop-down (All / Posted / Void) for documents that can be voided. */
export function PostedStatusFilterSelect({ value, onChange }: { value: '' | PostedStatus; onChange: (v: '' | PostedStatus) => void }) {
  return (
    <SelectField label="Status" value={value} onChange={(e) => onChange(e.target.value as '' | PostedStatus)}>
      <option value="">All</option>
      <option value="posted">Posted</option>
      <option value="void">Void</option>
    </SelectField>
  );
}
