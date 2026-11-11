/**
 * ManualTab: manual opening stock entry (route "/opening-stock").
 * The owner picks products, types a quantity and EITHER the cost of one unit OR the total value of the line, chooses
 * the date and saves one batch after a confirmation. History of batches (with void) is listed underneath.
 * API: GET /health (today), GET /products, POST /opening-stock (api/openingStock.ts).
 *
 * Rules reflected here (the server enforces all of them and is authoritative):
 *  - Section 3: line value = the exact total typed, or quantity x unit cost; the server stores exactly that. No
 *    cash entry, purchase or profit/loss is created.
 *  - R-FD: the date cannot be in the future (picker max = today). Backdating is allowed and audited.
 *  - One line per product (the picker hides products already chosen on another line).
 *  - Money is typed in rupees and converted to integer cents without floating point.
 */
import { useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useProducts } from '../../api/catalog';
import { ApiError } from '../../api/client';
import { useCreateOpeningStock } from '../../api/openingStock';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { useDebounced } from '../../hooks/useDebounced';
import { errorBanner } from '../../lib/errors';
import { formatLKR } from '../../lib/format';
import { BOOK_LABEL } from '../../lib/constants';
import { rupeesToCents } from '../../lib/units';
import { parseIntStrict } from '../purchases/helpers';
import type { Product } from '../../types/api';
import type { OpeningStockCreate } from '../../types/openingStock';
import { BatchHistory } from './BatchHistory';
import { OpeningNotice } from './OpeningNotice';

/** What the owner types for the cost of a line: one unit's cost, or the total of the whole line. */
type Mode = 'unit' | 'total';
/** One editable line, kept as typed text; `key` is a local React key, never sent to the server. */
interface Line { key: number; productId: string; qty: string; mode: Mode; amount: string }

/** Limits matching the server's validation. */
const MAX_QTY = 1_000_000_000;
const MAX_CENTS = 99_999_999_999;
const MAX_LINES = 1000;
const MAX_NOTES = 500;
/** How many products the picker loads at once (the filter box narrows the list further). */
const PRODUCT_PICKER_LIMIT = 200;
const newLine = (key: number): Line => ({ key, productId: '', qty: '', mode: 'unit', amount: '' });

/**
 * The checked numbers of one line: quantity, the typed amount in cents, and the exact line value in cents
 * (qty x unit cost, or the typed total). The product is formed with BigInt so it is exact even for huge inputs;
 * `valueCents` is null when anything is missing or out of range.
 */
function lineNumbers(l: Line) {
  const qty = parseIntStrict(l.qty);
  const qtyOk = qty !== null && qty >= 1 && qty <= MAX_QTY;
  const cents = l.amount.trim() === '' ? null : rupeesToCents(l.amount);
  const amountOk = cents !== null && cents <= MAX_CENTS;
  let valueCents: number | null = null;
  if (qtyOk && amountOk) {
    const v = l.mode === 'unit' ? BigInt(qty as number) * BigInt(cents as number) : BigInt(cents as number);
    if (v <= BigInt(MAX_CENTS)) valueCents = Number(v);
  }
  return { qty, qtyOk, cents, amountOk, valueCents };
}

/** The entry form. It is keyed by the parent, so each saved batch starts a fresh form and a fresh clientRef. */
function ManualForm({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const create = useCreateOpeningStock();
  // Generated once per form so a retried Save is recognised by the server and cannot post the batch twice.
  const clientRef = useClientRef();
  const nextKey = useRef(2);
  // Every product seen so far, by id, so a chosen product stays selectable after the filter narrows the list.
  const known = useRef(new Map<number, Product>());

  const { today, date: effDate, setDate } = useBusinessDate();
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const q = useDebounced(search.trim());
  const products = useProducts({ active: true, q: q || undefined, limit: PRODUCT_PICKER_LIMIT });
  for (const p of products.data?.items ?? []) known.current.set(p.id, p);
  // Services hold no stock, so only stock products are offered.
  const stockProducts = useMemo(() => (products.data?.items ?? []).filter((p) => p.kind === 'stock'), [products.data]);

  /** Products offered on one line: not chosen on another line, plus the line's own selection even if filtered out. */
  const optionsFor = (l: Line): Product[] => {
    const taken = new Set(lines.filter((x) => x.key !== l.key && x.productId).map((x) => x.productId));
    const list = stockProducts.filter((p) => !taken.has(String(p.id)));
    const sel = l.productId ? known.current.get(Number(l.productId)) : undefined;
    return sel && !list.some((p) => p.id === sel.id) ? [sel, ...list] : list;
  };
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // ---- Validation (quick feedback only; the server re-validates) ----
  const parsed = lines.map(lineNumbers);
  const lineValid = lines.map((l, i) => l.productId !== '' && (parsed[i] as ReturnType<typeof lineNumbers>).valueCents !== null);
  // Total = sum of the exact line values; integer addition, display only (the server recomputes it).
  const grand = parsed.reduce((s, n) => s + (n.valueCents ?? 0), 0);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && (!today || effDate <= today);
  const canSubmit = lineValid.every(Boolean) && dateOk && notes.length <= MAX_NOTES && Boolean(today);

  // Server field errors: those with a visible input are shown there; the rest go into the banner.
  const fe = err instanceof ApiError ? err.fields : {};
  const shown = new Set(['businessDate', 'notes']);
  lines.forEach((_, i) => ['productId', 'qty', 'unitCostCents', 'totalValueCents'].forEach((f) => shown.add(`items.${i}.${f}`)));
  const hasUnshown = Object.keys(fe).some((k) => !shown.has(k));
  const fieldOnly = err instanceof ApiError && (err.code === 'VALIDATION_ERROR' || err.code === 'FUTURE_DATE_NOT_ALLOWED') && !hasUnshown;
  const banner = fieldOnly ? null : errorBanner(err, [...shown]);

  const submit = () => {
    if (!canSubmit) return;
    // Ids as numbers, amounts as integer cents; each line carries exactly one of unit cost / total.
    const body: OpeningStockCreate = {
      businessDate: effDate,
      items: lines.map((l, i) => {
        const n = parsed[i] as ReturnType<typeof lineNumbers>;
        return l.mode === 'unit'
          ? { productId: Number(l.productId), qty: n.qty as number, unitCostCents: n.cents as number }
          : { productId: Number(l.productId), qty: n.qty as number, totalValueCents: n.cents as number };
      }),
      clientRef,
    };
    if (notes.trim()) body.notes = notes.trim();
    setErr(null);
    create.mutate(body, {
      onSuccess: () => { toast.success('Opening stock saved.'); setConfirming(false); onSaved(); },
      onError: (e) => setErr(e),
    });
  };

  return (
    <Card title="New opening stock batch">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) setConfirming(true); }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Date" type="date" value={effDate} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fe.businessDate}
            hint="Usually the day you start using the system. Not later than today." />
          <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} error={fe.notes} autoComplete="off" />
        </div>
        <div>
          <TextField label="Filter products" placeholder="Type to narrow the product lists below" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          <p className="mt-1 text-xs text-slate-500">
            For each product enter the quantity and either the cost of ONE unit or the TOTAL cost of all the units. A total is stored exactly as typed.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-2 py-2 text-left">Product</th>
                <th scope="col" className="px-2 py-2 text-right">Quantity</th>
                <th scope="col" className="px-2 py-2 text-left">Cost entered as</th>
                <th scope="col" className="px-2 py-2 text-right">Amount (Rs.)</th>
                <th scope="col" className="px-2 py-2 text-right">Line value</th>
                <th scope="col" className="px-2 py-2"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const n = parsed[i] as ReturnType<typeof lineNumbers>;
                const n1 = i + 1;
                const amountField = l.mode === 'unit' ? 'unitCostCents' : 'totalValueCents';
                return (
                  <tr key={l.key} className="border-b border-slate-100 align-top">
                    <td className="min-w-48 px-2 py-2">
                      <SelectField hideLabel label={`Line ${n1} product`} value={l.productId} onChange={(e) => update(l.key, { productId: e.target.value })} error={fe[`items.${i}.productId`]}>
                        <option value="">Select product…</option>
                        {optionsFor(l).map((p) => <option key={p.id} value={String(p.id)}>{p.name}{p.code ? ` [${p.code}]` : ''} ({BOOK_LABEL[p.book]})</option>)}
                      </SelectField>
                    </td>
                    <td className="w-28 px-2 py-2">
                      <TextField hideLabel label={`Line ${n1} quantity`} inputMode="numeric" className="[&_input]:text-right" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })}
                        error={fe[`items.${i}.qty`] ?? (l.qty !== '' && !n.qtyOk ? 'Whole number ≥ 1' : undefined)} autoComplete="off" />
                    </td>
                    <td className="w-40 px-2 py-2">
                      <SelectField hideLabel label={`Line ${n1} cost entered as`} value={l.mode} onChange={(e) => update(l.key, { mode: e.target.value as Mode })}>
                        <option value="unit">Cost of one unit</option>
                        <option value="total">Total of the line</option>
                      </SelectField>
                    </td>
                    <td className="w-40 px-2 py-2">
                      <TextField hideLabel label={`Line ${n1} amount in rupees`} inputMode="decimal" placeholder="0.00" className="[&_input]:text-right" value={l.amount} onChange={(e) => update(l.key, { amount: e.target.value })}
                        error={fe[`items.${i}.${amountField}`] ?? (l.amount !== '' && !n.amountOk ? 'Invalid amount' : undefined)} autoComplete="off" />
                    </td>
                    <td className="num whitespace-nowrap px-2 py-4 text-right">{n.valueCents !== null ? formatLKR(n.valueCents) : '—'}</td>
                    <td className="px-2 py-2">
                      <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Remove line ${n1}`} disabled={lines.length === 1}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        <Trash2 size={16} aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="px-2 py-3">
                  <Button variant="secondary" disabled={lines.length >= MAX_LINES} onClick={() => setLines((ls) => [...ls, newLine(nextKey.current++)])}>
                    <Plus size={16} aria-hidden="true" /> Add line
                  </Button>
                </td>
                <td colSpan={3} className="px-2 py-3 text-right font-semibold">Total stock value: <Money cents={grand} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="text-xs text-slate-500">Line values shown are for information; the server calculates and stores the final figures.</p>

        {banner && !confirming && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{banner}</p>}
        <div className="flex justify-end">
          <Button type="submit" disabled={!canSubmit}>Review and save</Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirming}
        title="Save opening stock?"
        confirmLabel="Save opening stock"
        loading={create.isPending}
        error={banner}
        onConfirm={submit}
        onClose={() => { if (!create.isPending) { setConfirming(false); setErr(null); } }}
      >
        <p>
          {lines.length} product{lines.length === 1 ? '' : 's'} with a total value of <Money cents={grand} className="font-semibold" />, dated {effDate}.
        </p>
        <p>This adds stock only. No purchase and no cash payment is recorded. It can be voided later only while that stock has not been used.</p>
      </ConfirmDialog>
    </Card>
  );
}

/** The Manual entry tab: warning, entry form, and the batch history. */
export function ManualTab() {
  // Changing the key remounts the form: empty lines and a new clientRef for the next batch.
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      <OpeningNotice />
      <ManualForm key={formKey} onSaved={() => setFormKey((k) => k + 1)} />
      <BatchHistory />
    </>
  );
}
