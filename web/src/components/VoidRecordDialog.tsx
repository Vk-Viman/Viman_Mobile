/**
 * VoidRecordDialog: the shared "cancel (void) this record" form.
 * Used to void purchases, stock losses, personal-use drawings and stocktakes. Voiding never deletes: the server
 * keeps the original and posts a reversal, so the audit trail stays complete; a reason is therefore mandatory.
 */
import { useRef, useState } from 'react';
import { FormDialog } from './FormDialog';
import { TextField } from './TextField';
import { errorBanner } from '../lib/errors';

/** Longest void reason the server accepts. */
const MAX_REASON_LENGTH = 200;
/** Word the owner must type to confirm an irreversible void. */
const CONFIRM_WORD = 'VOID';

interface VoidProps {
  title: string;
  /** Sentence explaining what the void will do. */
  intro: string;
  submitLabel: string;
  /** True while the void request is in flight. */
  pending: boolean;
  /** Require typing VOID (default true). */
  typedConfirm?: boolean;
  /** Runs the void mutation; the dialog supplies the callbacks. */
  run: (reason: string, cb: { onSuccess: () => void; onError: (e: Error) => void }) => void;
  /** Called after the server accepted the void (parent shows a toast and closes the dialog). */
  onDone: () => void;
  onClose: () => void;
}

/** Reason (1-200 characters) plus, by default, a typed VOID confirmation. Mount only while open. */
export function VoidRecordDialog({ title, intro, submitLabel, pending, typedConfirm = true, run, onDone, onClose }: VoidProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  // Synchronous double-click guard: state updates are asynchronous, so a rapid second click could slip through
  // before `pending` turns true. A ref changes instantly. It is released only if the server refuses the void.
  const busy = useRef(false);
  const r = reason.trim();
  const canSubmit = r.length >= 1 && r.length <= MAX_REASON_LENGTH && (!typedConfirm || typed === CONFIRM_WORD);

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
      <TextField label="Reason (required, up to 200 characters)" value={reason} maxLength={MAX_REASON_LENGTH} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      {typedConfirm && <TextField label="Type VOID to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}
    </FormDialog>
  );
}
