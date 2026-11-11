/**
 * CartTable: the cart of the POS (right half). One row per product: quantity, unit price (editable), line total.
 * Where: Sales > POS. No API calls; it edits the cart state owned by PosTab.
 * Rules shown here (all advisory, the server decides):
 *  - quantity is a whole number >= 1; a hint shows stock on hand and an inline warning appears above it
 *    (the server may still refuse with INSUFFICIENT_STOCK);
 *  - unit price is typed in rupees and converted to integer cents (lib/units.ts); a price below the product's
 *    minimum price shows a warning but never blocks the sale (R13);
 *  - line totals and per-book subtotals are integer sums (cart.ts).
 */
import { Trash2 } from 'lucide-react';
import { Money } from '../../components/Money';
import { BookBadge } from '../../components/StatusBadges';
import { TextField } from '../../components/TextField';
import { BOOK_LABEL } from '../../lib/constants';
import type { Book } from '../../types/api';
import { bookSubtotalCents, linePriceCents, lineQty, lineTotalCents } from './cart';
import type { CartLine } from './cart';

interface Props {
  lines: CartLine[];
  /** Merge `patch` into the line at `index`. */
  onChange: (index: number, patch: Partial<Pick<CartLine, 'qty' | 'price'>>) => void;
  onRemove: (index: number) => void;
  /** Server messages per line index (e.g. INSUFFICIENT_STOCK from `fields["items.N.qty"]`); those rows are highlighted. */
  lineErrors: Record<number, string>;
  /** Disables editing while the sale is being saved. */
  disabled?: boolean;
}

const BOOKS: Book[] = ['shop', 'telecom'];

/** Cart rows plus the per-book subtotals and the grand total. */
export function CartTable({ lines, onChange, onRemove, lineErrors, disabled }: Props) {
  const grand = BOOKS.reduce((sum, b) => sum + bookSubtotalCents(lines, b), 0);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-2 py-2 text-left">Product</th>
              <th scope="col" className="px-2 py-2 text-right">Qty</th>
              <th scope="col" className="px-2 py-2 text-right">Unit price (Rs.)</th>
              <th scope="col" className="px-2 py-2 text-right">Line total</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const qty = lineQty(l);
              const price = linePriceCents(l);
              const total = lineTotalCents(l);
              const serverErr = lineErrors[i];
              const overStock = qty !== null && qty > l.onHand;
              const belowMin = price !== null && l.minPriceCents > 0 && price < l.minPriceCents;
              return (
                <tr key={l.productId} className={`border-b border-slate-100 align-top ${serverErr ? 'bg-red-50' : ''}`}>
                  <td className="px-2 py-2">
                    <div className="font-medium text-slate-900">{l.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      {l.code && <span>{l.code}</span>}
                      <BookBadge book={l.book} />
                    </div>
                    {serverErr && <p role="alert" className="mt-1 text-xs font-medium text-red-700">{serverErr}</p>}
                  </td>
                  <td className="w-28 px-2 py-2 text-right">
                    <TextField
                      label={`Quantity of ${l.name}`}
                      hideLabel
                      inputMode="numeric"
                      value={l.qty}
                      disabled={disabled}
                      onChange={(e) => onChange(i, { qty: e.target.value })}
                      error={l.qty.trim() !== '' && qty === null ? 'Whole number, 1 or more.' : undefined}
                      hint={`In stock: ${l.onHand}`}
                      className="[&_input]:text-right"
                    />
                    {overStock && <p className="mt-1 text-xs text-amber-700">Only {l.onHand} in stock. The server will decide.</p>}
                  </td>
                  <td className="w-36 px-2 py-2 text-right">
                    <TextField
                      label={`Unit price of ${l.name} in rupees`}
                      hideLabel
                      inputMode="decimal"
                      value={l.price}
                      disabled={disabled}
                      onChange={(e) => onChange(i, { price: e.target.value })}
                      error={price === null ? 'Enter an amount like 1250.50.' : undefined}
                      className="[&_input]:text-right [&_input]:tabular-nums"
                    />
                    {belowMin && <p className="mt-1 text-xs text-amber-700">Below the minimum price (<Money cents={l.minPriceCents} />). You can still sell.</p>}
                  </td>
                  <td className="px-2 py-2 text-right">{total === null ? '—' : <Money cents={total} className="font-medium" />}</td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${l.name}`}
                      disabled={disabled}
                      onClick={() => onRemove(i)}
                      className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-red-700 disabled:opacity-40"
                    >
                      <Trash2 size={18} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto max-w-xs space-y-1 text-sm">
        {BOOKS.map((b) => {
          const present = lines.some((l) => l.book === b);
          if (!present) return null;
          return (
            <div key={b} className="flex justify-between gap-4">
              <dt className="text-slate-600">{BOOK_LABEL[b]} subtotal</dt>
              <dd><Money cents={bookSubtotalCents(lines, b)} /></dd>
            </div>
          );
        })}
        <div className="flex justify-between gap-4 border-t border-slate-200 pt-1 text-base font-semibold">
          <dt>Total</dt>
          <dd><Money cents={grand} /></dd>
        </div>
      </dl>
    </div>
  );
}
