/**
 * SegmentStrip: the Telecom segments under the Telecom book tab (BUSINESS_RULES 13D). Telecom is one book split into 4 providers x
 * Cards / Reloads: a grid of eight tiles (a column per provider, Cards above Reloads), each with its own balance and last closed day,
 * plus "All Telecom" (the read-only total of the eight; nothing can be recorded there) and "Telecom before segments" (the read-only
 * history from before the split) only when it has entries. Choosing a tile selects the segment the panel below works on
 * (`?book=telecom&segment=dialog_reloads`); every write panel (opening balance, count, close day) then takes that segment.
 * Data: `segments[]` of GET /cashbooks; the server calculates every figure.
 */
import { Money } from '../../components/Money';
import { SEGMENT_KINDS, SEGMENT_LABEL, SEGMENT_PROVIDERS } from '../../lib/segments';
import type { SegmentSummary, StoredSegment, TelecomSegment } from '../../types/segments';

interface Props {
  /** `segments[]` of the Telecom line of GET /cashbooks. */
  segments: SegmentSummary[];
  /** The selected segment; null = "All Telecom" (the read-only total). */
  selected: StoredSegment | null;
  /** Telecom total (the sum of the segments), shown on the "All Telecom" tile. */
  totalCents: number;
  onSelect: (segment: StoredSegment | null) => void;
}

const BASE = 'rounded-lg border p-3 text-left transition-colors';
const ON = 'border-brand-600 bg-brand-50 ring-1 ring-brand-600';
const OFF = 'border-slate-200 bg-white hover:bg-slate-50';

/** One tile: label, balance and last closed day. */
function Tile({ label, cents, closed, footer, active, onClick, muted = false }: {
  label: string; cents: number; closed?: string | null; footer?: string; active: boolean; onClick: () => void; muted?: boolean;
}) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`${BASE} ${active ? ON : OFF}`}>
      <span className={`block text-xs font-semibold uppercase tracking-wide ${muted ? 'text-slate-500' : 'text-slate-600'}`}>{label}</span>
      <span className="mt-1 block text-lg font-bold"><Money cents={cents} /></span>
      <span className="mt-0.5 block text-xs text-slate-500">{footer ?? (closed ? `Closed to ${closed}` : 'No day closed yet')}</span>
    </button>
  );
}

/** The segment tiles of the Telecom book. */
export function SegmentStrip({ segments, selected, totalCents, onSelect }: Props) {
  const by = new Map(segments.map((s) => [s.segment, s]));
  const legacy = by.get('legacy');
  return (
    <section aria-label="Telecom segments" className="mb-5 space-y-3">
      <div role="tablist" aria-label="Telecom segments" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SEGMENT_KINDS.flatMap((k) => SEGMENT_PROVIDERS.map((p) => {
          const code = `${p.code}_${k.code}` as TelecomSegment;
          const s = by.get(code);
          return (
            <Tile key={code} label={SEGMENT_LABEL[code]} cents={s?.balanceCents ?? 0} closed={s?.lastClosedDate ?? null}
              active={selected === code} onClick={() => onSelect(code)} />
          );
        }))}
      </div>
      <div role="tablist" aria-label="Telecom totals" className="grid gap-3 sm:grid-cols-2">
        <Tile label="All Telecom (total, read-only)" cents={totalCents} footer="Sum of all segments" active={selected === null} onClick={() => onSelect(null)} muted />
        {legacy && (
          <Tile label={`${SEGMENT_LABEL.legacy} (read-only)`} cents={legacy.balanceCents} closed={legacy.lastClosedDate}
            active={selected === 'legacy'} onClick={() => onSelect('legacy')} muted />
        )}
      </div>
    </section>
  );
}
