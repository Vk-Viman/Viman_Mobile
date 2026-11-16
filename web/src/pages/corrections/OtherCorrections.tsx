/**
 * OtherCorrections: thin adapters for top-ups, printing supplies, Ice Cream payments, Ice Cream fund moves and stock losses
 * (shared CorrectionDialog). Each replacement body is the normal create body of its type, pre-filled from the original.
 */
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useReloadProviders } from '../../api/telecom';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { CHECKBOX_CLASS, BOOK_LABEL } from '../../lib/constants';
import { centsToRupees } from '../../lib/units';
import type { Product, StockLoss, StockLossReason } from '../../types/api';
import type { IceFund } from '../../types/cashbooks';
import type { IceMove, IcePayment, PaymentKind } from '../../types/icecream';
import type { PrintingSupply } from '../../types/printing';
import type { Topup, TopupKind } from '../../types/telecom';
import { FundSelect, FUND_LABEL, MOVE_KIND_LABEL, PAYMENT_KINDS, PAYMENT_KIND_LABEL } from '../icecream/shared';
import { PickCategoryProduct } from '../stock/PickCategoryProduct';
import { REASON_LABEL } from '../stock/shared';

const AMOUNT_ERR = 'Enter an amount above zero, such as 2500 or 2500.50.';

/** Correct a telecom top-up. */
export function TopupCorrection({ original, onClose }: { original: Topup; onClose: () => void }) {
  const providers = useReloadProviders();
  const [kind, setKind] = useState<TopupKind>(original.kind);
  const [providerId, setProviderId] = useState(original.providerId === null ? '' : String(original.providerId));
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [notes, setNotes] = useState(original.notes ?? '');
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);
  // The original's provider stays selectable even if it was switched off since.
  const options = (providers.data?.items ?? []).filter((p) => p.active || String(p.id) === providerId);
  const providerOk = kind === 'wallet_topup' || options.some((p) => String(p.id) === providerId);
  const describe = (t: Topup): DescribeLine[] => [
    ['Date', t.businessDate], ['For', t.kind === 'wallet_topup' ? 'EZCash wallet' : (t.providerName ?? 'Provider')],
    ['Paid out', <Money key="a" cents={t.amountCents} />], ['Notes', t.notes || '—'],
  ];
  return (
    <CorrectionDialog<Topup> entity="telecom_topups" noun="top-up" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (cents === null || !providerOk || notes.length > MAX_NOTE) { setShow(true); return null; }
        return { businessDate, kind, providerId: kind === 'provider_topup' ? Number(providerId) : undefined, amountCents: cents, notes: notes.trim() || undefined, clientRef };
      }}>
      <SelectField label="Top-up for" value={kind} onChange={(e) => setKind(e.target.value as TopupKind)}>
        <option value="provider_topup">A reload provider</option>
        <option value="wallet_topup">The EZCash wallet</option>
      </SelectField>
      {kind === 'provider_topup' && (
        <SelectField label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} error={show && !providerOk ? 'Choose a provider.' : undefined}>
          <option value="">Select a provider</option>
          {options.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </SelectField>
      )}
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? AMOUNT_ERR : undefined} />
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}

/** Correct a printing supplies purchase. */
export function SupplyCorrection({ original, onClose }: { original: PrintingSupply; onClose: () => void }) {
  const [description, setDescription] = useState(original.description);
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);
  const descOk = description.trim().length >= 1 && description.trim().length <= 200;
  const describe = (s: PrintingSupply): DescribeLine[] => [['Date', s.businessDate], ['What was bought', s.description], ['Amount paid', <Money key="a" cents={s.amountCents} />]];
  return (
    <CorrectionDialog<PrintingSupply> entity="printing_supplies" noun="supplies purchase" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (cents === null || !descOk) { setShow(true); return null; }
        return { businessDate, amountCents: cents, description: description.trim(), clientRef };
      }}>
      <TextField label="What was bought" value={description} maxLength={200} autoComplete="off" onChange={(e) => setDescription(e.target.value)}
        error={show && !descOk ? 'Say what was bought.' : undefined} />
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? AMOUNT_ERR : undefined} />
    </CorrectionDialog>
  );
}

/** Correct an Ice Cream payment. */
export function PaymentCorrection({ original, onClose }: { original: IcePayment; onClose: () => void }) {
  const [kind, setKind] = useState<PaymentKind>(original.kind);
  const [fund, setFund] = useState<IceFund>(original.fund);
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [category, setCategory] = useState(original.category ?? '');
  const [description, setDescription] = useState(original.description);
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);
  const descOk = description.trim().length >= 1 && description.trim().length <= 200;
  const electricityCategory = category.trim().toLowerCase() === 'electricity';
  const describe = (p: IcePayment): DescribeLine[] => [
    ['Date', p.businessDate], ['Kind', PAYMENT_KIND_LABEL[p.kind]], ['Paid from', `${FUND_LABEL[p.fund]} fund`],
    ['Amount', <Money key="a" cents={p.amountCents} />], ['What for', p.description], ['Category', p.category || '—'],
  ];
  return (
    <CorrectionDialog<IcePayment> entity="icecream_payments" noun="Ice Cream payment" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (cents === null || !descOk || electricityCategory || category.length > 60) { setShow(true); return null; }
        return { businessDate, kind, fund, amountCents: cents, category: category.trim() || undefined, description: description.trim(), clientRef };
      }}>
      <SelectField label="What is it for?" value={kind} onChange={(e) => setKind(e.target.value as PaymentKind)}>
        {PAYMENT_KINDS.map((k) => <option key={k} value={k}>{PAYMENT_KIND_LABEL[k]}</option>)}
      </SelectField>
      <FundSelect label="Paid from" value={fund} onChange={setFund} />
      <MoneyInput label="Amount paid (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? AMOUNT_ERR : undefined} />
      <TextField label="What was it for?" value={description} maxLength={200} autoComplete="off" onChange={(e) => setDescription(e.target.value)}
        error={show && !descOk ? 'Say what the money was for.' : undefined} />
      <TextField label="Category (optional)" value={category} maxLength={60} autoComplete="off" onChange={(e) => setCategory(e.target.value)}
        hint='There is no "Electricity" category: use the "Electricity bill" kind.'
        error={electricityCategory ? 'Electricity is not a category. Choose "Electricity bill" above instead.' : undefined} />
    </CorrectionDialog>
  );
}

/** What the server answered when a release needs the owner's confirmation of the split (D4). */
interface Split { profitEligibleCents: number; cashOnlyCents: number; explanation: string }

/** Correct an Ice Cream fund move, including the plain-language split confirmation (D4) when the server asks for it. */
export function MoveCorrection({ original, onClose }: { original: IceMove; onClose: () => void }) {
  const [from, setFrom] = useState<IceFund>(original.fromFund);
  const [to, setTo] = useState<IceFund>(original.toFund);
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [note, setNote] = useState(original.note ?? '');
  const [split, setSplit] = useState<Split | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);
  const same = from === to;
  const describe = (m: IceMove): DescribeLine[] => [
    ['Date', m.businessDate], ['Move', `${FUND_LABEL[m.fromFund]} to ${FUND_LABEL[m.toFund]} (${MOVE_KIND_LABEL[m.kind]})`],
    ['Amount', <Money key="a" cents={m.amountCents} />], ['Counts as profit', <Money key="p" cents={m.profitEffectCents} />],
    ...(m.cashOnlyCents > 0 ? [['Cash only (not profit)', <Money key="c" cents={m.cashOnlyCents} />] as DescribeLine] : []),
    ['Note', m.note || '—'],
  ];
  const changeInputs = <T,>(set: (v: T) => void) => (v: T) => { set(v); setSplit(null); setConfirmed(false); };

  return (
    <CorrectionDialog<IceMove> entity="icecream_fund_moves" noun="fund move" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      onPreviewError={(e) => {
        if (e instanceof ApiError && e.code === 'SPLIT_CONFIRMATION_REQUIRED') {
          const x = e.extra as Partial<Split>;
          setSplit({ profitEligibleCents: x.profitEligibleCents ?? 0, cashOnlyCents: x.cashOnlyCents ?? 0, explanation: x.explanation ?? e.message });
          setConfirmed(false);
          return true;
        }
        return false;
      }}
      build={({ businessDate, clientRef }) => {
        if (cents === null || same || note.length > MAX_NOTE) { setShow(true); return null; }
        if (split && !confirmed) return null;
        return {
          businessDate, fromFund: from, toFund: to, amountCents: cents, note: note.trim() || undefined, clientRef,
          ...(split ? { confirmSplit: true, confirmedProfitEligibleCents: split.profitEligibleCents } : {}),
        };
      }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FundSelect label="From fund" value={from} onChange={changeInputs(setFrom)} />
        <FundSelect label="To fund" value={to} onChange={changeInputs(setTo)} error={same ? 'Choose two different funds.' : undefined} />
      </div>
      <MoneyInput label="Amount to move (Rs.)" value={amount} onChange={changeInputs(setAmount)} error={show && cents === null ? AMOUNT_ERR : undefined} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
      {split && (
        <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Part of this will not count as profit</p>
          <p>{split.explanation}</p>
          <p>Counts as profit: <Money cents={split.profitEligibleCents} className="font-semibold" />. Cash only (not profit): <Money cents={split.cashOnlyCents} className="font-semibold" />.</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" className={CHECKBOX_CLASS} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I have read this and confirm the split.</span>
          </label>
        </div>
      )}
    </CorrectionDialog>
  );
}

/** Correct a manual stock loss (a loss created by a damaged sales return is not correctable and never gets this dialog). */
export function StockLossCorrection({ original, onClose }: { original: StockLoss; onClose: () => void }) {
  const [picked, setPicked] = useState<Product | null>(null);
  const [change, setChange] = useState(false);
  const [qty, setQty] = useState(String(original.qty));
  const [reason, setReason] = useState<StockLossReason>(original.reason);
  const [note, setNote] = useState(original.note ?? '');
  const [show, setShow] = useState(false);
  const q = /^\d+$/.test(qty.trim()) ? Number(qty) : null;
  const qtyOk = q !== null && q >= 1 && q <= 1_000_000_000;
  const productId = change ? (picked?.id ?? null) : original.productId;
  const describe = (l: StockLoss): DescribeLine[] => [
    ['Date', l.businessDate], ['Product', `${l.productName} (${BOOK_LABEL[l.book]})`], ['Quantity', String(l.qty)],
    ['Cost', <Money key="c" cents={l.costCents} />], ['Reason', REASON_LABEL[l.reason]], ['Note', l.note || '—'],
  ];
  return (
    <CorrectionDialog<StockLoss> entity="stock_losses" noun="stock loss" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} inventory onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (!qtyOk || productId === null || note.length > 500) { setShow(true); return null; }
        return { businessDate, productId, qty: q, reason, note: note.trim() || undefined, clientRef };
      }}>
      {change ? (
        <>
          <PickCategoryProduct value={picked} onChange={setPicked} error={show && !picked ? 'Choose a product.' : undefined} />
          <Button variant="secondary" onClick={() => { setChange(false); setPicked(null); }}>Keep {original.productName}</Button>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
          <span>Product: <strong>{original.productName}</strong></span>
          <Button variant="secondary" onClick={() => setChange(true)}>Choose a different product</Button>
        </div>
      )}
      <TextField label="Quantity" inputMode="numeric" autoComplete="off" value={qty} onChange={(e) => setQty(e.target.value)}
        error={show && !qtyOk ? 'Enter a whole number, 1 or more.' : undefined} />
      <SelectField label="Reason" value={reason} onChange={(e) => setReason(e.target.value as StockLossReason)}>
        <option value="damaged">Damaged</option>
        <option value="lost">Lost</option>
        <option value="expired">Expired</option>
        <option value="other">Other</option>
      </SelectField>
      <TextField label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}
