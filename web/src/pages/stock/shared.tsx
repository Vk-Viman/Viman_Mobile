import { useRef, useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { ApiError } from '../../api/client';

/** Banner text for an error: the message plus any field messages that differ from it. */
export function errorBanner(err: unknown, skipFields: string[] = []): string | null {
  if (!err) return null;
  if (err instanceof ApiError) {
    const extra = Object.entries(err.fields)
      .filter(([k, m]) => m !== err.message && !skipFields.includes(k))
      .map(([, m]) => m);
    return [err.message, ...extra].join(' ');
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function fieldError(err: unknown, name: string): string | undefined {
  return err instanceof ApiError ? err.fields[name] : undefined;
}

export const REASON_LABEL = { damaged: 'Damaged', lost: 'Lost', expired: 'Expired', other: 'Other' } as const;

export function Pager({ page, total, limit, noun, onPage }: { page: number; total: number; limit: number; noun: string; onPage: (p: number) => void }) {
  const first = total === 0 ? 0 : page * limit + 1;
  const last = Math.min(total, (page + 1) * limit);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
      <span>{total === 0 ? `0 ${noun}` : `Showing ${first}–${last} of ${total} ${noun}`}</span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>Previous</Button>
        <Button variant="secondary" disabled={last >= total} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

interface VoidProps {
  title: string;
  intro: string;
  submitLabel: string;
  pending: boolean;
  /** Require typing VOID (default true). */
  typedConfirm?: boolean;
  /** Runs the void mutation; the dialog supplies the callbacks. */
  run: (reason: string, cb: { onSuccess: () => void; onError: (e: Error) => void }) => void;
  onDone: () => void;
  onClose: () => void;
}

/** Reason (1-200) + typed VOID confirmation. */
export function VoidRecordDialog({ title, intro, submitLabel, pending, typedConfirm = true, run, onDone, onClose }: VoidProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const busy = useRef(false);
  const r = reason.trim();
  const canSubmit = r.length >= 1 && r.length <= 200 && (!typedConfirm || typed === 'VOID');

  const submit = () => {
    if (!canSubmit || busy.current) return;
    busy.current = true;
    setErr(null);
    run(r, {
      onSuccess: onDone,
      onError: (e) => { busy.current = false; setErr(e); },
    });
  };

  return (
    <FormDialog title={title} submitLabel={submitLabel} canSubmit={canSubmit} loading={pending} error={errorBanner(err)} onSubmit={submit} onClose={onClose}>
      <p className="text-sm text-slate-700">{intro}</p>
      <TextField label="Reason (required, up to 200 characters)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      {typedConfirm && <TextField label="Type VOID to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}
    </FormDialog>
  );
}
