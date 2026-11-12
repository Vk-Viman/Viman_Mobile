/**
 * StockOutDialog: one form for the two ways stock leaves the shelf without a sale:
 *  - mode "loss": damaged / lost / expired stock written off   (POST /stock-losses)
 *  - mode "use":  goods the owner takes for personal use       (POST /drawings, kind "goods")
 * The product is chosen category-first (PickCategoryProduct; inactive products stay selectable, per BUSINESS_RULES §13A decision 6).
 * Opened from Stock > Stock losses and Stock > Personal use. API hooks: api/stock.ts.
 *
 * Rules reflected here (the server enforces them and is authoritative):
 *  - R-FD: the date cannot be in the future (picker max = today); backdating is allowed and audited.
 *  - Quantity is a whole number of at least 1 and cannot exceed stock on hand; the server values the removal at
 *    the product's average cost, so no price is entered here.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateDrawing, useCreateStockLoss } from '../../api/stock';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner, fieldError } from '../../lib/errors';
import { parseIntStrict } from '../purchases/helpers';
import { PickCategoryProduct } from './PickCategoryProduct';
import type { Product, StockLossReason } from '../../types/api';

/** Largest quantity accepted (matches the server's limit). */
const MAX_QTY = 1_000_000_000;
const MAX_NOTE = 500;

/**
 * Record a stock loss (mode "loss") or personal use / goods drawing (mode "use").
 * Mount only while open so each opening has a fresh form and a fresh clientRef.
 */
export function StockOutDialog({ mode, onClose }: { mode: 'loss' | 'use'; onClose: () => void }) {
  const toast = useToast();
  const createLoss = useCreateStockLoss();
  const createUse = useCreateDrawing();
  // Both mutations are always created (hooks cannot be conditional); `mut` is the one in use for this mode.
  const mut = mode === 'loss' ? createLoss : createUse;
  // Generated once per opening so a retried Save is recognised by the server and cannot post the entry twice.
  const clientRef = useClientRef();

  const { today, date: effDate, setDate } = useBusinessDate();
  // Category-first selection (PickCategoryProduct): the chosen product is cleared whenever the category changes.
  const [selected, setSelected] = useState<Product | null>(null);
  const productId = selected ? String(selected.id) : '';
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<StockLossReason>('damaged');
  const [note, setNote] = useState('');
  // Field errors for empty required fields appear only after a Save attempt, not while the form is still blank.
  const [showErrors, setShowErrors] = useState(false);

  const qtyN = parseIntStrict(qty);
  const qtyOk = qtyN !== null && qtyN >= 1 && qtyN <= MAX_QTY;
  const canSubmit = Boolean(effDate) && productId !== '' && qtyOk && note.length <= MAX_NOTE && !mut.isPending;

  const submit = () => {
    if (!canSubmit || qtyN === null) { setShowErrors(true); return; }
    const done = { onSuccess: () => { toast.success(mode === 'loss' ? 'Stock loss recorded.' : 'Personal use recorded.'); onClose(); } };
    if (mode === 'loss') {
      createLoss.mutate(
        { businessDate: effDate, productId: Number(productId), qty: qtyN, reason, note: note.trim() || undefined, clientRef },
        done,
      );
    } else {
      createUse.mutate(
        { kind: 'goods', businessDate: effDate, productId: Number(productId), qty: qtyN, note: note.trim() || undefined, clientRef },
        done,
      );
    }
  };

  const err = mut.error;
  // Server fields shown under their own inputs; anything else goes into the banner.
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
      <PickCategoryProduct value={selected} onChange={setSelected} error={fieldError(err, 'productId') ?? (showErrors && !productId ? 'Choose a product.' : undefined)} />
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
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" error={fieldError(err, 'note')} />
    </FormDialog>
  );
}
