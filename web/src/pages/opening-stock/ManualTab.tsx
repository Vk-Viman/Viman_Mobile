/**
 * ManualTab: manual opening stock entry (route "/opening-stock").
 * Category-first selection per line: book, then category, then an existing product of that category.
 * The owner types a quantity and EITHER the cost of one unit OR the total value of the line, chooses
 * the date and saves one batch after a confirmation. History of batches (with void) is listed underneath.
 * API: GET /health (today), GET /categories, GET /products, POST /opening-stock (api/openingStock.ts).
 *
 * Rules reflected here (the server enforces all of them and is authoritative):
 *  - Section 3: line value = the exact total typed, or quantity x unit cost; the server stores exactly that. No
 *    cash entry, purchase or profit/loss is created.
 *  - R-FD: the date cannot be in the future (picker max = today). Backdating is allowed and audited.
 *  - One line per product (the picker hides products already chosen on another line).
 *  - Money is typed in rupees and converted to integer cents without floating point.
 */
import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CategoryProductPicker } from '../../components/CategoryProductPicker';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { BackdatedNotice } from '../../components/BackdatedNotice';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCreateOpeningStock } from '../../api/openingStock';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner } from '../../lib/errors';
import { formatLKR } from '../../lib/format';
import { BOOK_LABEL } from '../../lib/constants';
import { rupeesToCents } from '../../lib/units';
import { parseIntStrict } from '../purchases/helpers';
import type { Book, Product } from '../../types/api';
import type { OpeningStockCreate } from '../../types/openingStock';
import { BatchHistory } from './BatchHistory';
import { OpeningNotice } from './OpeningNotice';

/** What the owner types for the cost of a line: one unit's cost, or the total of the whole line. */
type Mode = 'unit' | 'total';
/** One editable line, kept as typed text; `key` is a local React key, never sent to the server. */
interface Line { key: number; book: Book | ''; categoryId: number | null; product: Product | null; qty: string; mode: Mode; amount: string }

/** Limits matching the server's validation. */
const MAX_QTY = 1_000_000_000;
const MAX_CENTS = 99_999_999_999;
const MAX_LINES = 1000;
const MAX_NOTES = 500;
const newLine = (key: number): Line => ({ key, book: '', categoryId: null, product: null, qty: '', mode: 'unit', amount: '' });

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

  const { today, date: effDate, setDate } = useBusinessDate();
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<ApiError | Error | null>(null);

  /** Products already chosen on the OTHER lines (one line per product): hidden from this line's list. */
  const takenBy = (key: number) => lines.filter((x) => x.key !== key && x.product).map((x) => (x.product as Product).id);
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // ---- Validation (quick feedback only; the server re-validates) ----
  const parsed = lines.map(lineNumbers);
  const lineValid = lines.map((l, i) => l.product !== null && (parsed[i] as ReturnType<typeof lineNumbers>).valueCents !== null);
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
          ? { productId: (l.product as Product).id, qty: n.qty as number, unitCostCents: n.cents as number }
          : { productId: (l.product as Product).id, qty: n.qty as number, totalValueCents: n.cents as number };
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
          <div>
            <TextField label="Date" type="date" value={effDate} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fe.businessDate}
              hint="Usually the day you start using the system. Not later than today." />
            <BackdatedNotice date={effDate} today={today} />
          </div>
          <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} error={fe.notes} autoComplete="off" />
        </div>
        <p className="text-xs text-slate-500">
          For each product choose the book, the category and the product, then enter the quantity and either the cost of ONE unit or the TOTAL cost of all the units. A total is stored exactly as typed.
        </p>

        <div className="space-y-3">
          {lines.map((l, i) => {
            const n = parsed[i] as ReturnType<typeof lineNumbers>;
            const n1 = i + 1;
            const amountField = l.mode === 'unit' ? 'unitCostCents' : 'totalValueCents';
            return (
              <div key={l.key} className="rounded-lg border border-slate-200 p-3" role="group" aria-label={`Line ${n1}`}>
                <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
                  <SelectField
                    label="Book"
                    value={l.book}
                    onChange={(e) => update(l.key, { book: e.target.value as Book | '', categoryId: null, product: null })}
                  >
                    <option value="">Choose Shop or Telecom…</option>
                    <option value="shop">{BOOK_LABEL.shop}</option>
                    <option value="telecom">{BOOK_LABEL.telecom}</option>
                  </SelectField>
                  {l.book === '' ? (
                    <p className="self-end pb-2 text-sm text-slate-600">Choose the book first, then a category and a product.</p>
                  ) : (
                    <CategoryProductPicker
                      book={l.book}
                      requireCategory
                      value={l.product}
                      onChange={(p) => update(l.key, { product: p })}
                      categoryId={l.categoryId}
                      onCategoryChange={(id) => update(l.key, { categoryId: id })}
                      excludeProductIds={takenBy(l.key)}
                    />
                  )}
                </div>
                {fe[`items.${i}.productId`] && <p className="mt-1 text-sm text-red-600">{fe[`items.${i}.productId`]}</p>}
                <div className="mt-3 grid grid-cols-2 items-start gap-3 sm:grid-cols-[7rem_11rem_9rem_1fr_auto]">
                  <TextField label="Quantity" inputMode="numeric" className="[&_input]:text-right" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })}
                    error={fe[`items.${i}.qty`] ?? (l.qty !== '' && !n.qtyOk ? 'Whole number ≥ 1' : undefined)} autoComplete="off" />
                  <SelectField label="Cost entered as" value={l.mode} onChange={(e) => update(l.key, { mode: e.target.value as Mode })}>
                    <option value="unit">Cost of one unit</option>
                    <option value="total">Total of the line</option>
                  </SelectField>
                  <TextField label="Amount (Rs.)" inputMode="decimal" placeholder="0.00" className="[&_input]:text-right" value={l.amount} onChange={(e) => update(l.key, { amount: e.target.value })}
                    error={fe[`items.${i}.${amountField}`] ?? (l.amount !== '' && !n.amountOk ? 'Invalid amount' : undefined)} autoComplete="off" />
                  <div className="text-right text-sm">
                    <div className="mb-1 font-medium text-slate-700">Line value</div>
                    <div className="num whitespace-nowrap py-2">{n.valueCents !== null ? formatLKR(n.valueCents) : '—'}</div>
                  </div>
                  <div className="pt-6">
                    <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Remove line ${n1}`} disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" disabled={lines.length >= MAX_LINES} onClick={() => setLines((ls) => [...ls, newLine(nextKey.current++)])}>
              <Plus size={16} aria-hidden="true" /> Add line
            </Button>
            <p className="font-semibold">Total stock value: <Money cents={grand} /></p>
          </div>
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
