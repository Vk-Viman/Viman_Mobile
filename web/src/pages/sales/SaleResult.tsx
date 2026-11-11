/**
 * SaleResult: the panel shown after a successful "Save sale" on the POS.
 * Where: Sales > POS (replaces the cart until the cashier presses "New sale").
 * Data: the `POST /sales` response (api/sales.ts): one sale per book plus the server's non-blocking warnings
 * (R13: PRICE_BELOW_MINIMUM, PRICE_BELOW_COST, ZERO_COST). Each warning names the cart line it refers to via
 * `lineIndex`, which we resolve against the cart snapshot that was submitted.
 */
import { CheckCircle2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { Money } from '../../components/Money';
import { BookBadge } from '../../components/StatusBadges';
import type { Sale, Warning } from '../../types/api';
import type { CartLine } from './cart';

interface Props {
  sales: Sale[];
  warnings: Warning[];
  /** The cart lines as submitted (same order the server numbered `lineIndex` by). */
  submitted: CartLine[];
  onNewSale: () => void;
}

/** Summary of what was saved, the warnings (if any) and the "New sale" button. */
export function SaleResult({ sales, warnings, submitted, onNewSale }: Props) {
  return (
    <div className="space-y-4">
      <div role="status" className="flex items-start gap-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-800">
        <CheckCircle2 size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>Sale saved. {sales.length > 1 ? 'The mixed cart was saved as one Shop sale and one Telecom sale.' : ''}</span>
      </div>

      <ul className="space-y-2">
        {sales.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <span className="flex items-center gap-2">
              <span className="font-medium">Sale #{s.id}</span>
              <BookBadge book={s.book} />
              <span className="text-slate-500">{s.items.length} item{s.items.length === 1 ? '' : 's'}</span>
            </span>
            <Money cents={s.totalCents} className="font-semibold" />
          </li>
        ))}
      </ul>

      {warnings.length > 0 && (
        <section aria-label="Warnings" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <h3 className="font-semibold">Please check</h3>
          <p className="text-xs">The sale was saved. These are warnings only; fix the product prices or costs if they are wrong.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {warnings.map((w, i) => (
              <li key={`${w.code}-${w.lineIndex}-${i}`}>
                <span className="font-medium">{submitted[w.lineIndex]?.name ?? `Line ${w.lineIndex + 1}`}:</span> {w.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Button onClick={onNewSale}>New sale</Button>
    </div>
  );
}
