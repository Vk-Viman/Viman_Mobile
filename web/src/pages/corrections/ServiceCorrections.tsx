/**
 * ServiceCorrections: adapter for print / service sales (shared CorrectionDialog, API_CONTRACTS.md "Correction contract, Phase 2").
 * The replacement is the normal POST /print-sales body (service, pages, price per page, note), pre-filled from the original.
 * The price per page is always sent (pre-filled with the original's price; choosing another service fills that service's price),
 * so a corrected sale keeps the price the owner sees. The standard cost is the server's (the service type's cost when saved).
 */
import { useState } from 'react';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { usePrintServiceTypes } from '../../api/printing';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { PrintSale } from '../../types/printing';
import { parseIntStrict } from '../purchases/helpers';
import { MAX_NOTE, MAX_QTY, MAX_UNIT_CENTS } from '../printing/shared';

/** Correct a print / service sale. */
export function PrintSaleCorrection({ original, onClose }: { original: PrintSale; onClose: () => void }) {
  const types = usePrintServiceTypes(false);
  const [typeId, setTypeId] = useState(String(original.serviceTypeId));
  const [qty, setQty] = useState(String(original.qty));
  const [price, setPrice] = useState(centsToRupees(original.unitPriceCents));
  const [notes, setNotes] = useState(original.notes ?? '');
  const [show, setShow] = useState(false);

  // The original's service stays selectable even if it was switched off since.
  const options = (types.data?.items ?? []).filter((t) => t.active || String(t.id) === typeId || t.id === original.serviceTypeId);
  const qtyN = parseIntStrict(qty);
  const qtyOk = qtyN !== null && qtyN >= 1 && qtyN <= MAX_QTY;
  const priceC = rupeesToCents(price);
  const priceOk = priceC !== null && priceC <= MAX_UNIT_CENTS;

  const choose = (id: string) => {
    setTypeId(id);
    const t = options.find((x) => String(x.id) === id);
    if (t && id !== String(original.serviceTypeId)) setPrice(centsToRupees(t.priceCents)); // another service: its own price list price
    else if (id === String(original.serviceTypeId)) setPrice(centsToRupees(original.unitPriceCents));
  };

  const describe = (s: PrintSale): DescribeLine[] => [
    ['Date', s.businessDate], ['Service', s.description], ['Pages', String(s.qty)], ['Price / page', <Money key="p" cents={s.unitPriceCents} />],
    ['Revenue', <Money key="r" cents={s.revenueCents} className="font-semibold" />], ['Standard cost', <Money key="c" cents={s.cogsCents} />],
    ['Gross profit', <Money key="g" cents={s.grossProfitCents} />], ['Notes', s.notes || '—'],
  ];

  return (
    <CorrectionDialog<PrintSale> entity="print_sales" noun="print sale" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (!qtyOk || !priceOk || priceC === null || qtyN === null || !options.some((t) => String(t.id) === typeId) || notes.length > MAX_NOTE) { setShow(true); return null; }
        return { businessDate, serviceTypeId: Number(typeId), qty: qtyN, unitPriceCents: priceC, notes: notes.trim() || undefined, clientRef };
      }}>
      <SelectField label="Service" value={typeId} onChange={(e) => choose(e.target.value)} disabled={types.isPending}>
        {options.length === 0 && <option value={typeId}>{original.description}</option>}
        {options.map((t) => <option key={t.id} value={String(t.id)}>{t.name}{t.active ? '' : ' (off)'}</option>)}
      </SelectField>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Pages (quantity)" inputMode="numeric" autoComplete="off" value={qty} onChange={(e) => setQty(e.target.value)}
          error={show && !qtyOk ? 'Enter a whole number, 1 or more.' : undefined} />
        <TextField label="Price per page (Rs.)" inputMode="decimal" autoComplete="off" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)}
          error={show && !priceOk ? 'Enter an amount such as 15 or 15.50.' : undefined} />
      </div>
      <TextField label="Note (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}
