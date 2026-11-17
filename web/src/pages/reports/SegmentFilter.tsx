/**
 * SegmentFilter: the optional Telecom segment filter of the reports (BUSINESS_RULES 13D): "All Telecom segments" or one of the eight segments
 * (and "Telecom before segments" for the records from before the split). The choice is sent to the server as `?segment=`.
 */
import { SelectField } from '../../components/SelectField';
import { SEGMENT_LABEL, TELECOM_SEGMENTS } from '../../lib/segments';
import type { StoredSegment } from '../../types/segments';

/** The values the filter offers (empty = no filter). */
export const SEGMENT_FILTER_VALUES: readonly (StoredSegment | '')[] = ['', ...TELECOM_SEGMENTS, 'legacy'];

/** The drop-down. */
export function SegmentFilter({ value, onChange, label = 'Telecom segment' }: { value: StoredSegment | ''; onChange: (v: StoredSegment | '') => void; label?: string }) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value as StoredSegment | '')}>
      <option value="">All Telecom segments</option>
      {TELECOM_SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>)}
      <option value="legacy">{SEGMENT_LABEL.legacy}</option>
    </SelectField>
  );
}
