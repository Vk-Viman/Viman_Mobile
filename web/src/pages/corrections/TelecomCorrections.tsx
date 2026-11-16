/**
 * TelecomCorrections: adapters for reload entries and EZCash entries (shared CorrectionDialog, API_CONTRACTS.md "Correction
 * contract, Phase 2"). The replacement is the normal create body (POST /reload-sales, /ezcash-sales), pre-filled from the original.
 *
 * Owner rule: the ORIGINAL commission rate is kept on the corrected entry. The dialog shows that rate and the original commission,
 * and offers an UNTICKED box "Recalculate commission at today's rate"; ticking it sends `recalculateCommission: true` at the top
 * level of the request (never inside `replacement`). For a reload the server also uses the new provider's current rate when the
 * provider is changed. Nothing is calculated here: the preview's `comparison` (rates and commissions) comes from the server.
 */
import { useState } from 'react';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useReloadProviders } from '../../api/telecom';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { centsToRupees } from '../../lib/units';
import type { EzCashSale, ReloadSale } from '../../types/telecom';
import { MAX_NOTE, parseAmount, rateLabel } from '../telecom/shared';

/** The original rate line and the unticked "recalculate" box, shared by both adapters. */
function RateBox({ bp, commissionCents, recalc, onRecalc, providerChanged = false }: {
  bp: number; commissionCents: number; recalc: boolean; onRecalc: (v: boolean) => void; providerChanged?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p>
        Original commission rate: <strong className="num">{rateLabel(bp)}</strong>, commission <Money cents={commissionCents} className="font-semibold" />.
        {' '}The corrected entry keeps this rate unless you tick the box below.
      </p>
      <label className="flex items-start gap-2">
        <input type="checkbox" className={CHECKBOX_CLASS} checked={recalc} onChange={(e) => onRecalc(e.target.checked)} />
        <span>Recalculate commission at today&apos;s rate</span>
      </label>
      {providerChanged && !recalc && (
        <p className="text-xs text-amber-800">You chose a different provider: the server uses that provider&apos;s current rate for it.</p>
      )}
    </div>
  );
}

/** Correct a reload entry. */
export function ReloadCorrection({ original, onClose }: { original: ReloadSale; onClose: () => void }) {
  const providers = useReloadProviders();
  const [providerId, setProviderId] = useState(String(original.providerId));
  const [sales, setSales] = useState(centsToRupees(original.salesCents));
  const [extra, setExtra] = useState(original.extraCents > 0 ? centsToRupees(original.extraCents) : '');
  const [notes, setNotes] = useState(original.notes ?? '');
  const [recalc, setRecalc] = useState(false);
  const [show, setShow] = useState(false);

  // The original's provider stays selectable even if it was switched off since.
  const options = (providers.data?.items ?? []).filter((p) => p.active || String(p.id) === String(original.providerId));
  const salesCents = parseAmount(sales);
  const extraCents = parseAmount(extra, true);
  const providerOk = options.some((p) => String(p.id) === providerId);

  const describe = (r: ReloadSale): DescribeLine[] => [
    ['Date', r.businessDate], ['Provider', r.providerName], ['Collected', <Money key="s" cents={r.salesCents} />],
    ['Commission rate', rateLabel(r.commissionBp)], ['Extra commission', <Money key="e" cents={r.extraCents} />],
    ['Commission', <Money key="c" cents={r.commissionCents} className="font-semibold" />], ['Notes', r.notes || '—'],
  ];

  return (
    <CorrectionDialog<ReloadSale> entity="reload_sales" noun="reload entry" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} bodyExtras={{ recalculateCommission: recalc }} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (salesCents === null || extraCents === null || !providerOk || notes.length > MAX_NOTE) { setShow(true); return null; }
        return { businessDate, providerId: Number(providerId), salesCents, extraCents: extraCents || undefined, notes: notes.trim() || undefined, clientRef };
      }}>
      <SelectField label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} error={show && !providerOk ? 'Choose a provider.' : undefined}>
        {options.length === 0 && <option value={providerId}>{original.providerName}</option>}
        {options.map((p) => <option key={p.id} value={String(p.id)}>{p.name}{p.active ? '' : ' (off)'}</option>)}
      </SelectField>
      <MoneyInput label="Reload sales collected (Rs.)" value={sales} onChange={setSales} error={show && salesCents === null ? 'Enter an amount of Rs. 0.01 or more.' : undefined} />
      <MoneyInput label="Extra commission (Rs., optional)" value={extra} onChange={setExtra} error={extra !== '' && extraCents === null ? 'Enter an amount, or leave empty.' : undefined} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
      <RateBox bp={original.commissionBp} commissionCents={original.commissionCents} recalc={recalc} onRecalc={setRecalc} providerChanged={providerId !== String(original.providerId)} />
    </CorrectionDialog>
  );
}

/** Correct an EZCash entry (always Dialog). */
export function EzCashCorrection({ original, onClose }: { original: EzCashSale; onClose: () => void }) {
  const [bills, setBills] = useState(centsToRupees(original.billTotalCents));
  const [notes, setNotes] = useState(original.notes ?? '');
  const [recalc, setRecalc] = useState(false);
  const [show, setShow] = useState(false);
  const billCents = parseAmount(bills);

  const describe = (r: EzCashSale): DescribeLine[] => [
    ['Date', r.businessDate], ['Bills collected', <Money key="b" cents={r.billTotalCents} />], ['Commission rate', rateLabel(r.commissionBp)],
    ['Commission', <Money key="c" cents={r.commissionCents} className="font-semibold" />], ['Notes', r.notes || '—'],
  ];

  return (
    <CorrectionDialog<EzCashSale> entity="ezcash_sales" noun="EZCash entry" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} bodyExtras={{ recalculateCommission: recalc }} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (billCents === null || notes.length > MAX_NOTE) { setShow(true); return null; }
        return { businessDate, billTotalCents: billCents, notes: notes.trim() || undefined, clientRef };
      }}>
      <MoneyInput label="Bill total collected (Rs.)" value={bills} onChange={setBills} error={show && billCents === null ? 'Enter an amount of Rs. 0.01 or more.' : undefined} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
      <RateBox bp={original.commissionBp} commissionCents={original.commissionCents} recalc={recalc} onRecalc={setRecalc} />
    </CorrectionDialog>
  );
}
