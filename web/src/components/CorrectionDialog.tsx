/**
 * CorrectionDialog: the ONE shared "Correct this entry" dialog used by every screen that supports corrections.
 *
 * Workflow (PROPOSAL_TRANSACTION_CORRECTION.md section 1; API in api/corrections.ts):
 *  1. explanation: the original is never edited; it is voided and a corrected entry is created; both stay in history;
 *  2. correct-check: the server answers "yes" or the plain-language refusal of the existing void (closed day, has returns...);
 *  3. the corrected details (a thin adapter per screen supplies the fields as `children` and `build`), pre-filled from the original;
 *     the business date defaults to the original's date and cannot be in the future (R-FD);
 *  4. a required correction reason (1-200 characters);
 *  5. Preview: correct-preview (a dry run that saves nothing) shows what will be created, with the comparison table for sales;
 *  6. Save correction: correct, with ONE replacement clientRef generated when the dialog opens (idempotency: a double click or a
 *     retry after a network error can never create two replacements);
 *  7. the server's warnings (negative cash...) are shown as amber toasts, exactly as on the normal screens;
 *  8. on success every cached query is refreshed and the dialog shows both records.
 * The server is authoritative for every rule; nothing is calculated here. Mount only while open (fresh state and fresh clientRef).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Button } from './Button';
import { SaleComparisonTable } from './SaleComparisonTable';
import { Spinner } from './Spinner';
import { TextField } from './TextField';
import { useToast } from './Toast';
import { BackdatedNotice } from './BackdatedNotice';
import { CORRECTION_RESOURCE, MAX_CORRECTION_REASON, useCorrect, useCorrectCheck, useCorrectionPreview } from '../api/corrections';
import type { CorrectionApplied, CorrectionBody, CorrectionEntity, CorrectionPreview, CorrectionWarning } from '../api/corrections';
import { useBusinessDate } from '../hooks/useBusinessDate';
import { useClientRef } from '../hooks/useClientRef';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';
import { errorBanner, fieldError } from '../lib/errors';

/** One "label: value" line describing a record. */
export type DescribeLine = [label: string, value: ReactNode];

/** The sentence the owner approved. */
export const CORRECTION_EXPLANATION =
  'Editing does not change the original. The original will be voided (cancelled by reversal entries) and a corrected entry will be created. Both stay visible in history.';

interface Props<R> {
  entity: CorrectionEntity;
  /** Singular name of the record for titles, e.g. "expense". */
  noun: string;
  original: R;
  originalId: number;
  /** The original's business date: the default date of the replacement. */
  originalDate: string;
  /** Lines describing a record of this type (used for the original, the preview and the result). */
  describe: (record: R) => DescribeLine[];
  /** The corrected details (the adapter's fields, without the date and the reason, which the dialog supplies). */
  children: ReactNode;
  /**
   * Builds the replacement body (the type's normal create body, clientRef included) from the adapter's form state, or returns null
   * when something is invalid (the adapter then shows its own field messages).
   */
  build: (ctx: { businessDate: string; clientRef: string }) => Record<string, unknown> | null;
  /** Lets the adapter take over a special refusal of the preview (Ice Cream split confirmation). Return true when handled. */
  onPreviewError?: (e: unknown) => boolean;
  /** Show the amber "backdated" notice next to the date (inventory transactions). */
  inventory?: boolean;
  widthClass?: string;
  onClose: () => void;
}

/** A small card listing one record's lines. */
function RecordCard({ title, tone, lines }: { title: string; tone: 'red' | 'green'; lines: DescribeLine[] }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === 'red' ? 'border-red-200 bg-red-50/40' : 'border-brand-200 bg-brand-50/40'}`}>
      <h3 className="mb-2 text-sm font-semibold text-slate-900">{title}</h3>
      <dl className="space-y-1 text-sm">
        {lines.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-32 shrink-0 text-slate-500">{k}</dt>
            <dd className="min-w-0 break-words text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Amber list of the server's warnings. */
function Warnings({ list }: { list: CorrectionWarning[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Warnings">
      {list.map((w, i) => (
        <li key={`${w.code ?? 'w'}-${i}`} className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

type Stage = 'edit' | 'preview' | 'done';

/** The dialog. `R` is the record type of the screen (Expense, Sale, ...). */
export function CorrectionDialog<R>({
  entity, noun, original, originalId, originalDate, describe, children, build, onPreviewError, inventory, widthClass = 'max-w-2xl', onClose,
}: Props<R>) {
  const toast = useToast();
  const resource = CORRECTION_RESOURCE[entity];
  const check = useCorrectCheck(resource, originalId);
  const previewMut = useCorrectionPreview<R>(resource, originalId);
  const correctMut = useCorrect<R>(resource, originalId);
  const clientRef = useClientRef(); // the replacement's idempotency key: one per dialog session
  const { today } = useBusinessDate();

  const [stage, setStage] = useState<Stage>('edit');
  const [date, setDate] = useState(originalDate);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState<{ body: CorrectionBody; preview: CorrectionPreview<R> } | null>(null);
  const [done, setDone] = useState<CorrectionApplied<R> | null>(null);
  // Synchronous double-click guard (state updates are asynchronous); released only when the server refuses.
  const busy = useRef(false);

  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useDialogFocusTrap(panel, { onClose, initialFocusSelector: 'h2' });
  // Move focus to the heading whenever the step changes, so keyboard and screen-reader users land at the top of the new step.
  const ready = check.isSuccess && check.data.eligible;
  useEffect(() => { heading.current?.focus(); }, [stage, ready]);

  const r = reason.trim();
  const reasonOk = r.length >= 1 && r.length <= MAX_CORRECTION_REASON;
  const canPreview = ready && reasonOk && Boolean(date) && !previewMut.isPending;

  const runPreview = (e: FormEvent) => {
    e.preventDefault();
    if (!canPreview || busy.current) return;
    setErr(null);
    const replacement = build({ businessDate: date, clientRef });
    if (!replacement) { setErr(new Error('Please complete the fields marked in red before the preview.')); return; }
    const body: CorrectionBody = { reason: r, replacement };
    previewMut.mutate(body, {
      onSuccess: (p) => { setSaved({ body, preview: p }); setStage('preview'); },
      onError: (e2) => { if (!onPreviewError?.(e2)) setErr(e2); },
    });
  };

  const save = () => {
    if (!saved || busy.current) return;
    busy.current = true;
    setErr(null);
    correctMut.mutate(saved.body, {
      onSuccess: (res) => {
        toast.success(`Correction saved: ${noun} #${originalId} was voided and #${idOf(res.replacement)} created.`);
        for (const w of res.warnings ?? []) toast.warning(w.message);
        setDone(res);
        setStage('done');
      },
      onError: (e2) => { busy.current = false; setErr(e2); },
    });
  };

  const checkFailed = check.isError;
  const refused = !done && check.isSuccess && !check.data.eligible ? check.data : null; // after saving the original is void: never show that stale refusal
  const banner = errorBanner(err);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`max-h-[calc(100vh-2rem)] w-full ${widthClass} overflow-y-auto rounded-xl bg-white p-4 shadow-xl sm:p-6`}>
        <h2 id={titleId} ref={heading} tabIndex={-1} className="text-lg font-semibold text-slate-900 outline-none">
          {stage === 'done' ? 'Correction saved' : stage === 'preview' ? `Review the correction of ${noun} #${originalId}` : `Correct this entry: ${noun} #${originalId}`}
        </h2>

        {stage === 'edit' && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
            <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span>{CORRECTION_EXPLANATION}</span>
          </p>
        )}

        {/* ---- step 1: eligibility ---- */}
        {check.isPending && <div className="flex justify-center py-8"><Spinner label="Checking whether this entry can be corrected" /></div>}
        {checkFailed && (
          <div className="mt-4 space-y-4">
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorBanner(check.error)}</p>
            <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
          </div>
        )}
        {refused && (
          <div className="mt-4 space-y-4">
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span><strong>This entry cannot be corrected.</strong> {refused.eligible ? '' : refused.message}</span>
            </p>
            <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
          </div>
        )}

        {/* ---- step 2: the corrected details ---- */}
        {ready && stage === 'edit' && (
          <form onSubmit={runPreview} className="mt-4 space-y-4" noValidate>
            <p className="flex items-center gap-2 text-sm text-green-800"><CheckCircle2 size={16} aria-hidden="true" /> This entry can be corrected.</p>
            <RecordCard title={`Original ${noun} #${originalId} (will be voided)`} tone="red" lines={describe(original)} />
            <div>
              <TextField label="Date of the corrected entry" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)}
                error={fieldError(err, 'businessDate')} hint={date !== originalDate ? undefined : 'Same date as the original. Change it only if the date was wrong.'} />
              {inventory && <BackdatedNotice date={date} today={today} />}
            </div>
            {children}
            <TextField label="Correction reason (required, up to 200 characters)" value={reason} maxLength={MAX_CORRECTION_REASON} autoComplete="off"
              placeholder="e.g. Wrong amount typed" onChange={(e) => setReason(e.target.value)} />
            {banner && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{banner}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose} disabled={previewMut.isPending}>Cancel</Button>
              <Button type="submit" disabled={!canPreview} loading={previewMut.isPending}>Preview</Button>
            </div>
          </form>
        )}

        {/* ---- step 3: preview ---- */}
        {stage === 'preview' && saved && (
          <div className="mt-4 space-y-4">
            <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              Nothing has been saved yet. When you press <strong>Save correction</strong> the original is voided and the corrected entry below is created, in one step.
              If anything is refused, nothing changes.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <RecordCard title={`Original #${originalId}: will be voided`} tone="red" lines={describe(saved.preview.original)} />
              <RecordCard title="Corrected entry: will be created" tone="green" lines={describe(saved.preview.replacement)} />
            </div>
            {date !== originalDate && (
              <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                The corrected entry is dated <strong>{date}</strong>, not {originalDate}. It will count in the period of {date}.
              </p>
            )}
            {saved.preview.comparison && <SaleComparisonTable c={saved.preview.comparison} />}
            <Warnings list={saved.preview.warnings ?? []} />
            <p className="text-sm text-slate-600">Correction reason: <span className="font-medium text-slate-900">{saved.body.reason}</span></p>
            {banner && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{banner}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => { setErr(null); setStage('edit'); }} disabled={correctMut.isPending}>Back</Button>
              <Button onClick={save} loading={correctMut.isPending}>Save correction</Button>
            </div>
          </div>
        )}

        {/* ---- step 4: result ---- */}
        {stage === 'done' && done && (
          <div className="mt-4 space-y-4">
            <p className="flex items-start gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-900">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>The original was voided and the corrected entry was created. Both stay visible in history.</span>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <RecordCard title={`Original #${originalId}: now void`} tone="red" lines={describe(done.original)} />
              <RecordCard title={`Corrected entry #${idOf(done.replacement)}`} tone="green" lines={describe(done.replacement)} />
            </div>
            {done.comparison && <SaleComparisonTable c={done.comparison} />}
            <Warnings list={done.warnings ?? []} />
            <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The id of a returned record (every record type has a numeric `id`). */
function idOf(record: unknown): string {
  const id = (record as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? String(id) : '?';
}
