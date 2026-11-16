/**
 * SaleCorrection: adapter for correcting a sale (shared CorrectionDialog). Only sales WITHOUT posted returns can be corrected
 * (the server's check says so). The replacement is the normal POS body restricted to the original sale's book: the owner edits the
 * quantity, unit price and cost per unit of each existing line, or removes a line (at least one must stay). Adding products is
 * not offered: enter a new sale for that.
 * Cost rule (C13): `unitCostCents` is sent only for a line whose cost the owner changed (or that already carried an extra cost);
 * an untouched line lets the server cost it at the weighted average of the moment (the preview shows the difference).
 */
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { TextField } from '../../components/TextField';
import { BOOK_LABEL } from '../../lib/constants';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { Sale } from '../../types/api';
import { MAX_UNIT_PRICE_CENTS, MAX_LINE_QTY } from '../sales/cart';
import { parseIntStrict } from '../purchases/helpers';

interface Line {
  key: number;
  productId: number;
  name: string;
  qty: string;
  price: string;
  cost: string;
  /** Cost text shown when the dialog opened. */
  initialCost: string;
  /** The original line carried an extra cost, so its charged cost must be sent again. */
  hadExtra: boolean;
}

/** Charged cost per unit of an original line, in cents (the automatic cost when there was no extra cost). */
function chargedUnitCost(qty: number, unitCostCents: number, extraCostCents: number): number {
  return extraCostCents > 0 ? Math.ceil((unitCostCents * qty + extraCostCents) / qty) : unitCostCents;
}

/** Plain list of a sale's lines and figures for the original / preview / result cards. */
function describeSale(s: Sale): DescribeLine[] {
  return [
    ['Date', s.businessDate],
    ['Book', BOOK_LABEL[s.book]],
    ['Items', (
      <ul key="items" className="space-y-0.5">
        {s.items.map((i) => (
          <li key={i.id}>{i.productName}: {i.qty} x <Money cents={i.unitPriceCents} /> (cost <Money cents={i.chargedCostCents} />)</li>
        ))}
      </ul>
    )],
    ['Total', <Money key="t" cents={s.totalCents} className="font-semibold" />],
    ['Cost', <Money key="c" cents={s.chargedCostCents} />],
    ['Profit', <Money key="p" cents={s.grossProfitCents} />],
    ['Notes', s.notes || '—'],
  ];
}

export function SaleCorrection({ original, onClose }: { original: Sale; onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>(() => original.items.map((i) => {
    const cost = centsToRupees(chargedUnitCost(i.qty, i.unitCostCents, i.extraCostCents));
    return { key: i.id, productId: i.productId, name: i.productName, qty: String(i.qty), price: centsToRupees(i.unitPriceCents), cost, initialCost: cost, hadExtra: i.extraCostCents > 0 };
  }));
  const [notes, setNotes] = useState(original.notes ?? '');
  const [show, setShow] = useState(false);

  const set = (key: number, patch: Partial<Line>) => setLines((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const qtyOf = (l: Line) => { const n = parseIntStrict(l.qty); return n !== null && n >= 1 && n <= MAX_LINE_QTY ? n : null; };
  const priceOf = (l: Line) => { const c = rupeesToCents(l.price); return c !== null && c <= MAX_UNIT_PRICE_CENTS ? c : null; };
  const costOf = (l: Line) => { const c = rupeesToCents(l.cost); return c !== null && c <= MAX_UNIT_PRICE_CENTS ? c : null; };
  const costBlank = (l: Line) => l.cost.trim() === '';
  const lineOk = (l: Line) => qtyOf(l) !== null && priceOf(l) !== null && (costBlank(l) || costOf(l) !== null);
  const allOk = lines.length > 0 && lines.every(lineOk) && notes.length <= 500;
  const total = lines.reduce((s, l) => s + (qtyOf(l) ?? 0) * (priceOf(l) ?? 0), 0);

  return (
    <CorrectionDialog<Sale> entity="sales" noun="sale" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describeSale} inventory widthClass="max-w-4xl" onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (!allOk) { setShow(true); return null; }
        return {
          businessDate,
          items: lines.map((l) => {
            const c = costOf(l);
            const sendCost = c !== null && (l.hadExtra || l.cost !== l.initialCost);
            return { productId: l.productId, qty: qtyOf(l) as number, unitPriceCents: priceOf(l) as number, ...(sendCost ? { unitCostCents: c } : {}) };
          }),
          notes: notes.trim() || undefined,
          clientRef,
        };
      }}>
      <section aria-label="Sale lines" className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Items ({BOOK_LABEL[original.book]} book)</h3>
        <ul className="space-y-3">
          {lines.map((l) => (
            <li key={l.key} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">{l.name}</span>
                <button type="button" onClick={() => setLines((x) => x.filter((y) => y.key !== l.key))} disabled={lines.length <= 1}
                  aria-label={`Remove ${l.name} from the corrected sale`} title={lines.length <= 1 ? 'A sale needs at least one line' : 'Remove line'}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40">
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField label="Quantity" inputMode="numeric" autoComplete="off" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })}
                  error={show && qtyOf(l) === null ? 'Whole number, 1 or more.' : undefined} />
                <TextField label="Unit price (Rs.)" inputMode="decimal" autoComplete="off" value={l.price} onChange={(e) => set(l.key, { price: e.target.value })}
                  error={show && priceOf(l) === null ? 'Enter an amount like 1250.50.' : undefined} />
                <TextField label="Cost per unit (Rs.)" inputMode="decimal" autoComplete="off" value={l.cost} onChange={(e) => set(l.key, { cost: e.target.value })}
                  hint="Leave unchanged to use the automatic cost. It can only be raised."
                  error={show && !costBlank(l) && costOf(l) === null ? 'Enter an amount like 187.50.' : undefined} />
              </div>
            </li>
          ))}
        </ul>
        <p className="text-sm text-slate-700">Corrected total: <Money cents={total} className="font-semibold" /></p>
      </section>
      <TextField label="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}
