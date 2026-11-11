import { useMemo, useRef, useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useProducts } from '../../api/catalog';
import { useHealth } from '../../api/health';
import { useCreateDrawing, useCreateStockLoss } from '../../api/stock';
import { parseIntStrict } from '../purchases/helpers';
import { BOOK_LABEL, useDebounced } from '../products/shared';
import { errorBanner, fieldError } from './shared';
import type { StockLossReason } from '../../types/api';

const MAX_QTY = 1_000_000_000;

/** Record a stock loss (mode "loss") or personal use / goods drawing (mode "use"). */
export function StockOutDialog({ mode, onClose }: { mode: 'loss' | 'use'; onClose: () => void }) {
  const health = useHealth();
  const toast = useToast();
  const createLoss = useCreateStockLoss();
  const createUse = useCreateDrawing();
  const mut = mode === 'loss' ? createLoss : createUse;
  const clientRef = useRef(crypto.randomUUID());

  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<StockLossReason>('damaged');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const today = health.data?.today ?? '';
  const effDate = date || today;
  const q = useDebounced(search.trim(), 300);
  const products = useProducts({ q: q || undefined, limit: 500 });
  const stockProducts = useMemo(() => (products.data?.items ?? []).filter((p) => p.kind === 'stock'), [products.data]);
  const selected = stockProducts.find((p) => String(p.id) === productId);

  const qtyN = parseIntStrict(qty);
  const qtyOk = qtyN !== null && qtyN >= 1 && qtyN <= MAX_QTY;
  const canSubmit = Boolean(effDate) && productId !== '' && qtyOk && note.length <= 500 && !mut.isPending;

  const submit = () => {
    if (!canSubmit || qtyN === null) { setShowErrors(true); return; }
    const done = { onSuccess: () => { toast.success(mode === 'loss' ? 'Stock loss recorded.' : 'Personal use recorded.'); onClose(); } };
    if (mode === 'loss') {
      createLoss.mutate(
        { businessDate: effDate, productId: Number(productId), qty: qtyN, reason, note: note.trim() || undefined, clientRef: clientRef.current },
        done,
      );
    } else {
      createUse.mutate(
        { kind: 'goods', businessDate: effDate, productId: Number(productId), qty: qtyN, note: note.trim() || undefined, clientRef: clientRef.current },
        done,
      );
    }
  };

  const err = mut.error;
  const handled = ['businessDate', 'productId', 'qty', 'reason', 'note'];

  return (
    <FormDialog
      title={mode === 'loss' ? 'Record stock loss' : 'Record personal use'}
      submitLabel="Save"
      canSubmit={canSubmit}
      loading={mut.isPending}
      error={errorBanner(err, handled)}
      onSubmit={submit}
      onClose={onClose}
    >
      {mode === 'use' && (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          Stock taken for your own use is recorded at cost as an owner drawing. It is not a sale and not a stock loss.
        </p>
      )}
      <TextField label="Date" type="date" value={effDate} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      <TextField label="Find product" placeholder="Type a name or code" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
      <SelectField
        label="Product"
        value={productId}
        onChange={(e) => setProductId(e.target.value)}
        error={fieldError(err, 'productId') ?? (showErrors && !productId ? 'Choose a product.' : undefined)}
        hint={selected ? `${BOOK_LABEL[selected.book]} book — ${selected.qtyOnHand} in stock now` : undefined}
      >
        <option value="">Select a product</option>
        {stockProducts.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}{p.code ? ` (${p.code})` : ''} — {p.qtyOnHand} in stock{p.active ? '' : ' (inactive)'}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Quantity"
        inputMode="numeric"
        autoComplete="off"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        error={fieldError(err, 'qty') ?? (showErrors && !qtyOk ? 'Enter a whole number, 1 or more.' : undefined)}
      />
      {mode === 'loss' && (
        <SelectField label="Reason" value={reason} onChange={(e) => setReason(e.target.value as StockLossReason)} error={fieldError(err, 'reason')}>
          <option value="damaged">Damaged</option>
          <option value="lost">Lost</option>
          <option value="expired">Expired</option>
          <option value="other">Other</option>
        </SelectField>
      )}
      <TextField label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
