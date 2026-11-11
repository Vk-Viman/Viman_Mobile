/**
 * POS tab (route "/sales"): the point of sale. Search products on the left, build the cart on the right, save.
 * API: POST /sales (api/sales.ts), plus product search (ProductPicker) and today's sales (TodaySales).
 *
 * Rules reflected here (the server enforces them and is authoritative):
 *  - Money is integer cents; totals shown are integer sums, the server recomputes COGS, profit and everything else.
 *  - A mixed cart (Shop goods + Telecom scratch cards) is saved as one Shop sale and one Telecom sale.
 *  - Sale date: default today (from GET /health), `max = today` (R-FD); backdating is allowed and audited.
 *  - C13: each line shows the automatic cost per unit (editable upward only). `unitCostCents` is sent ONLY for lines
 *    whose cost the cashier changed; otherwise it is omitted so the server uses its exact automatic cost.
 *    COST_BELOW_AUTOMATIC is shown under that line's cost input.
 *  - Below-minimum / below-cost prices only WARN (R13); the server's warnings are listed after saving.
 *  - IDEMPOTENCY: one `clientRef` per sale-in-progress. It is created when the sale starts and replaced only after a
 *    successful save ("New sale" remounts the session below with a fresh one). So if the network drops after the
 *    server saved and the cashier presses Save again, the server returns the same sale instead of a duplicate.
 */
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../api/client';
import { useCreateSale } from '../../api/sales';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner } from '../../lib/errors';
import type { Product, Sale, Warning } from '../../types/api';
import { CartTable } from './CartTable';
import { cartIsValid, costToSend, lineFromProduct, linePriceCents, lineQty, MAX_CART_LINES } from './cart';
import type { CartLine } from './cart';
import { ProductPicker } from './ProductPicker';
import { SaleResult } from './SaleResult';
import { TodaySales } from './TodaySales';

/** Longest sale note the server accepts. */
const MAX_NOTES = 500;

/**
 * The route component. It only owns a counter used as the `key` of the session below: bumping it throws the whole
 * session away (cart, result, clientRef) and starts a clean one. That is how "New sale" gets a NEW clientRef.
 */
export function PosTab() {
  const [saleNo, setSaleNo] = useState(0);
  return <PosSession key={saleNo} onNewSale={() => setSaleNo((n) => n + 1)} />;
}

/** One sale in progress: cart, date, notes, save, and (after saving) the result panel. */
function PosSession({ onNewSale }: { onNewSale: () => void }) {
  const clientRef = useClientRef();
  const create = useCreateSale();
  const { today, date: effDate, picked: pickedDate, setDate } = useBusinessDate();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<ApiError | Error | null>(null);
  const [result, setResult] = useState<{ sales: Sale[]; warnings: Warning[]; submitted: CartLine[] } | null>(null);

  /** Adds one unit of a product: a new line, or +1 on the existing line of the same product. */
  const addProduct = (p: Product) => {
    setErr(null);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.productId === p.id);
      if (i < 0) return prev.length >= MAX_CART_LINES ? prev : [...prev, lineFromProduct(p)];
      const next = [...prev];
      const cur = next[i] as CartLine;
      const n = lineQty(cur);
      next[i] = { ...cur, qty: String((n ?? 0) + 1) };
      return next;
    });
  };
  const changeLine = (i: number, patch: Partial<Pick<CartLine, 'qty' | 'price' | 'cost'>>) => {
    setErr(null);
    setLines((prev) => prev.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  };
  const removeLine = (i: number) => {
    setErr(null);
    setLines((prev) => prev.filter((_, k) => k !== i));
  };

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && (!today || effDate <= today);
  const canSave = Boolean(today) && dateOk && cartIsValid(lines) && notes.length <= MAX_NOTES && !create.isPending;

  // ---- Server errors: per-line messages (items.N.*) are shown on their row, the date under the date field ----
  const fe = err instanceof ApiError ? err.fields : {};
  const lineErrors: Record<number, string> = {};
  const costErrors: Record<number, string> = {};
  for (const [k, m] of Object.entries(fe)) {
    const hit = /^items\.(\d+)\.(\w+)$/.exec(k);
    if (!hit) continue;
    // The cost message belongs under the cost input; every other line message highlights the row.
    (hit[2] === 'unitCostCents' ? costErrors : lineErrors)[Number(hit[1])] = m;
  }
  const handled = Object.keys(fe).filter((k) => k === 'businessDate' || k.startsWith('items.'));
  // A future-date error is already shown under the date picker (the server message, unchanged); do not repeat it.
  const dateOnly = err instanceof ApiError && err.code === 'FUTURE_DATE_NOT_ALLOWED';
  const banner = dateOnly ? null : errorBanner(err, handled);

  const save = () => {
    if (!canSave) return;
    setErr(null);
    const submitted = lines;
    create.mutate(
      {
        businessDate: effDate,
        // Cart order is kept: the server numbers lines, warnings and errors by this position.
        items: submitted.map((l) => {
          const unitCostCents = costToSend(l);
          return {
            productId: l.productId,
            qty: lineQty(l) as number,
            unitPriceCents: linePriceCents(l) as number,
            ...(unitCostCents !== undefined ? { unitCostCents } : {}),
          };
        }),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        clientRef,
      },
      {
        onSuccess: (r) => setResult({ sales: r.sales, warnings: r.warnings, submitted }),
        onError: (e) => setErr(e),
      },
    );
  };

  if (result) {
    return (
      <div className="space-y-5">
        <Card title="Sale complete">
          <SaleResult sales={result.sales} warnings={result.warnings} submitted={result.submitted} onNewSale={onNewSale} />
        </Card>
        {today && <TodaySales today={today} />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <ProductPicker onAdd={addProduct} />
        </div>
        <div className="lg:col-span-3">
          <Card title="Cart">
            {lines.length === 0 ? (
              <EmptyState title="The cart is empty" hint="Search for a product and press Enter, or click it in the list." />
            ) : (
              <CartTable lines={lines} onChange={changeLine} onRemove={removeLine} lineErrors={lineErrors} costErrors={costErrors} disabled={create.isPending} />
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <TextField
                label="Sale date"
                type="date"
                value={effDate}
                max={today || undefined}
                onChange={(e) => { setErr(null); setDate(e.target.value); }}
                hint="Today unless you are entering an earlier sale."
                error={fe.businessDate ?? (pickedDate && !dateOk ? 'Pick today or an earlier date.' : undefined)}
              />
              <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
            </div>

            <p className="mt-3 text-xs text-slate-500">Mixed carts are saved as one Shop sale and one Telecom sale. Payment is cash.</p>
            {banner && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{banner}</p>}
            <div className="mt-4 flex justify-end">
              <Button onClick={save} disabled={!canSave} loading={create.isPending}>Save sale</Button>
            </div>
          </Card>
        </div>
      </div>
      {today && <TodaySales today={today} />}
    </div>
  );
}
