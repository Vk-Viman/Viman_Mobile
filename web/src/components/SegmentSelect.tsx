/**
 * SegmentSelect: the provider x kind picker for a Telecom record (BUSINESS_RULES 13D): two linked drop-downs, "Provider" (Dialog,
 * Mobitel, Airtel, Hutch) and "Kind" (Cards, Reloads). The value is the combined segment code, or '' while either choice is missing.
 * The read-only "Telecom before segments" (`legacy`) is never offered: new records cannot be recorded there.
 * Used wherever an entry chooses its segment (expenses, capital, drawings, transfers, counts ...); the server still validates.
 */
import { useEffect, useId, useState } from 'react';
import { inputClass } from './TextField';
import { SEGMENT_KINDS, SEGMENT_PROVIDERS, providerOf, kindOf, segmentOf } from '../lib/segments';
import type { SegmentKind, SegmentProvider, StoredSegment, TelecomSegment } from '../types/segments';

interface Props {
  /** The chosen segment, or '' while none is chosen. */
  value: TelecomSegment | '';
  onChange: (segment: TelecomSegment | '') => void;
  /** Group label (default "Telecom segment"). */
  label?: string;
  /** Validation message (e.g. the server's `fields.segment`); turns the borders red. */
  error?: string;
  /** Small helper text under the pickers (hidden while an error is shown). */
  hint?: string;
  /** Offer only these kinds (e.g. reloads-only records); the Kind box is then fixed when there is just one. */
  kinds?: readonly SegmentKind[];
  disabled?: boolean;
}

/** Splits a stored segment into the two choices; `legacy` and '' give empty choices. */
function split(value: StoredSegment | ''): { provider: SegmentProvider | ''; kind: SegmentKind | '' } {
  if (value === '' || value === 'legacy') return { provider: '', kind: '' };
  return { provider: providerOf(value) ?? '', kind: kindOf(value) ?? '' };
}

/** Two drop-downs (provider, kind) that report one segment code. */
export function SegmentSelect({ value, onChange, label = 'Telecom segment', error, hint, kinds, disabled }: Props) {
  const id = useId();
  const descId = `${id}-d`;
  const kindOptions = SEGMENT_KINDS.filter((k) => !kinds || kinds.includes(k.code));
  const [choice, setChoice] = useState(() => split(value));
  // A value that arrives from outside (a reset, a default) replaces the local choices; an incomplete pair stays local.
  useEffect(() => { if (value !== '') setChoice(split(value)); }, [value]);
  const onlyKind = kindOptions.length === 1 ? kindOptions[0]!.code : null;
  const kind: SegmentKind | '' = choice.kind || onlyKind || '';

  const pick = (provider: SegmentProvider | '', k: SegmentKind | '') => {
    setChoice({ provider, kind: k });
    onChange(segmentOf(provider, k) ?? '');
  };

  return (
    <fieldset disabled={disabled} aria-describedby={error || hint ? descId : undefined} className="min-w-0">
      <legend className="mb-1 block text-sm font-medium text-slate-700">{label}</legend>
      <div className="grid grid-cols-2 gap-3">
        <select aria-label={`${label}: provider`} className={inputClass(error)} aria-invalid={error ? true : undefined} value={choice.provider}
          onChange={(e) => pick(e.target.value as SegmentProvider | '', kind)}>
          <option value="">Provider…</option>
          {SEGMENT_PROVIDERS.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
        </select>
        <select aria-label={`${label}: kind`} className={inputClass(error)} aria-invalid={error ? true : undefined} value={kind}
          onChange={(e) => pick(choice.provider, e.target.value as SegmentKind | '')}>
          <option value="">Kind…</option>
          {kindOptions.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
        </select>
      </div>
      {error ? (
        <p id={descId} className="mt-1 text-sm text-red-600">{error}</p>
      ) : hint ? (
        <p id={descId} className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </fieldset>
  );
}
