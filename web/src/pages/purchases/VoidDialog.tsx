import { useRef, useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useVoidPurchase } from '../../api/purchases';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { BOOK_LABEL } from '../products/shared';
import type { Purchase } from '../../types/api';

export function VoidDialog({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const toast = useToast();
  const voidMut = useVoidPurchase();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<ApiError | Error | null>(null);
  const busy = useRef(false);

  const r = reason.trim();
  const canSubmit = r.length >= 1 && r.length <= 200 && typed === 'VOID';

  const submit = () => {
    if (!canSubmit || busy.current) return;
    busy.current = true;
    setErr(null);
    voidMut.mutate(
      { id: purchase.id, body: { reason: r } },
      {
        onSuccess: () => { toast.success('Purchase voided.'); onClose(); },
        onError: (e) => { busy.current = false; setErr(e); },
      },
    );
  };

  const extra = err instanceof ApiError ? Object.values(err.fields).filter((m) => m !== err.message) : [];
  const banner = err ? [err.message, ...extra].join(' ') : null;

  return (
    <FormDialog title={`Void purchase #${purchase.id}`} submitLabel="Void purchase" canSubmit={canSubmit} loading={voidMut.isPending} error={banner} onSubmit={submit} onClose={onClose}>
      <p className="text-sm text-slate-700">
        This removes the stock that was bought and puts the money back into the {BOOK_LABEL[purchase.book]} cash book. It cannot be undone.
      </p>
      <TextField label="Reason (required, up to 200 characters)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      <TextField label="Type VOID to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
    </FormDialog>
  );
}
