/**
 * NewPurchaseDialog: the "New purchase" form (opened from the Purchases screen): business book, date, optional
 * supplier, bill no, notes and one or more product lines (packs x pack size, line total).
 * Category-first: 1 choose the book (Shop/Telecom), 2 per line choose a category of that book, 3 choose an existing
 * product of that category (or "New product" to create it right here), 4 enter packs, pack size and line total.
 * API: GET /health (today's date), GET /suppliers, GET /categories, GET /products, POST /products (new product),
 * POST /purchases (api/purchases.ts).
 *
 * Rules reflected here (the server enforces all of them and is authoritative):
 *  - R-FD: the date cannot be in the future (picker max = today). Backdating is allowed and audited.
 *  - A purchase belongs to ONE book: Shop and Telecom items must be on separate bills, so the book is chosen first
 *    and every line only offers products of that book; changing the book with lines filled in asks first and clears them.
 *  - Money is typed in rupees and converted to integer cents; the per-unit cost shown is a preview only.
 */
import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CategoryProductPicker } from '../../components/CategoryProductPicker';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FormDialog } from '../../components/FormDialog';
import { Button } from '../../components/Button';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useSuppliers } from '../../api/catalog';
import { useCreatePurchase } from '../../api/purchases';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { errorBanner } from '../../lib/errors';
import { formatLKR } from '../../lib/format';
import { BOOK_LABEL } from '../../lib/constants';
import { rupeesToCents } from '../../lib/units';
import { ProductDialog } from '../products/ProductDialog';
import { centsPerUnit, parseIntStrict } from './helpers';
import type { Book, Product, PurchaseCreate } from '../../types/api';

/**
 * One editable purchase line: the chosen category and product, then packs / pack size / line total kept as typed
 * text. `key` is a local React key, never sent to the server.
 */
interface Line { key: number; categoryId: number | null; product: Product | null; packs: string; packSize: string; total: string }

/** Limits matching the server's validation. */
const MAX_INT = 1_000_000;
const MAX_CENTS = 99_999_999_999;
const MAX_LINES = 100;
const MAX_BILL_NO = 40;
const MAX_NOTES = 500;
const newLine = (key: number): Line => ({ key, categoryId: null, product: null, packs: '1', packSize: '1', total: '' });

/**
 * Parses and checks the typed numbers of one line. `units` (= packs x pack size, an exact integer product) is
 * null until both are valid. Amounts become integer cents via rupeesToCents (no floating point).
 */
function lineNumbers(l: Line) {
  const packs = parseIntStrict(l.packs);
  const packSize = parseIntStrict(l.packSize);
  const cents = l.total.trim() === '' ? null : rupeesToCents(l.total);
  const packsOk = packs !== null && packs >= 1 && packs <= MAX_INT;
  const sizeOk = packSize !== null && packSize >= 1 && packSize <= MAX_INT;
  const totalOk = cents !== null && cents <= MAX_CENTS;
  return { packs, packSize, cents, packsOk, sizeOk, totalOk, units: packsOk && sizeOk ? (packs as number) * (packSize as number) : null };
}

/** The new-purchase form. Mount only while open: each opening gets a fresh form and a fresh clientRef. */
export function NewPurchaseDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePurchase();
  // Generated once per opening so a retried Save is recognised by the server and cannot post the purchase twice.
  const clientRef = useClientRef();
  // Counter for the next line's local key (a ref: changing it must not re-render).
  const nextKey = useRef(2);

  const { today, date: effDate, setDate } = useBusinessDate();
  // The bill's book: chosen first, before any line. '' = not chosen yet.
  const [book, setBook] = useState<Book | ''>('');
  const [pendingBook, setPendingBook] = useState<Book | '' | null>(null); // a book change waiting for confirmation
  const [supplierId, setSupplierId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  // The line a "New product" dialog was opened from, and the category that was chosen there.
  const [creating, setCreating] = useState<{ key: number; categoryId: number | null } | null>(null);
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const suppliers = useSuppliers({ active: true });

  const changeBook = (b: Book | '') => {
    if (b === book) return;
    // A purchase must never mix books: with products already chosen, ask first, then clear the lines.
    if (lines.some((l) => l.product !== null)) setPendingBook(b);
    else { setBook(b); setLines([newLine(nextKey.current++)]); }
  };

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // ---- Validation (quick feedback only; the server re-validates) ----
  const parsed = lines.map(lineNumbers);
  const lineValid = lines.map((l, i) => {
    const n = parsed[i] as ReturnType<typeof lineNumbers>;
    return l.product !== null && n.packsOk && n.sizeOk && n.totalOk;
  });
  // Total paid = sum of the line totals. Integer-cent addition is exact; this is display only, the server recomputes it.
  const grand = parsed.reduce((s, n) => s + (n.totalOk && n.cents !== null ? n.cents : 0), 0);
  // R-FD: not after today. Backdating is fine. (YYYY-MM-DD strings compare correctly as text.)
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && (!today || effDate <= today);
  const canSubmit = book !== '' && lines.length >= 1 && lineValid.every(Boolean) && dateOk && billNo.length <= MAX_BILL_NO && notes.length <= MAX_NOTES && Boolean(today);

  // Server field errors: those with a visible input are shown there; the rest are collected into the banner.
  const fe = err instanceof ApiError ? err.fields : {};
  const shown = new Set(['businessDate', 'supplierId', 'billNo', 'notes']);
  lines.forEach((_, i) => ['productId', 'packs', 'packSize', 'lineTotalCents'].forEach((f) => shown.add(`items.${i}.${f}`)));
  const hasUnshown = Object.keys(fe).some((k) => !shown.has(k));
  // A plain validation / future-date error is already visible under its field, so no banner is needed.
  const fieldOnly = err instanceof ApiError && (err.code === 'VALIDATION_ERROR' || err.code === 'FUTURE_DATE_NOT_ALLOWED') && !hasUnshown;
  const banner = fieldOnly ? null : errorBanner(err, [...shown]);

  const submit = () => {
    if (!canSubmit) return;
    // Build the request: ids as numbers, amounts as integer cents. Optional fields are sent only when filled in.
    const body: PurchaseCreate = {
      businessDate: effDate,
      items: lines.map((l, i) => {
        const n = parsed[i] as ReturnType<typeof lineNumbers>;
        return { productId: (l.product as Product).id, packs: n.packs as number, packSize: n.packSize as number, lineTotalCents: n.cents as number };
      }),
      clientRef,
    };
    if (supplierId) body.supplierId = Number(supplierId);
    if (billNo.trim()) body.billNo = billNo.trim();
    if (notes.trim()) body.notes = notes.trim();
    setErr(null);
    create.mutate(body, {
      onSuccess: (r) => { toast.success('Purchase saved.'); notifyCashWarnings(toast, r.warnings); onClose(); },
      onError: (e) => setErr(e),
    });
  };

  return (
    <>
      <FormDialog
        title="New purchase"
        submitLabel="Save purchase"
        canSubmit={canSubmit}
        loading={create.isPending}
        error={banner}
        onSubmit={submit}
        onClose={onClose}
        widthClass="max-w-5xl"
        paused={creating !== null || pendingBook !== null}
      >
        {/* Bill header: date (max = today), supplier, bill number, notes */}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Date" type="date" value={effDate} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fe.businessDate} />
          <SelectField label="Supplier (optional)" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} error={fe.supplierId}>
            <option value="">No supplier</option>
            {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </SelectField>
          <TextField label="Bill no" value={billNo} maxLength={MAX_BILL_NO} onChange={(e) => setBillNo(e.target.value)} error={fe.billNo} autoComplete="off" />
          <TextField label="Notes" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} error={fe.notes} autoComplete="off" />
        </div>

        {/* Step 1: the business book. Every line below only offers products of this book. */}
        <div>
          <SelectField label="Business book *" value={book} onChange={(e) => changeBook(e.target.value as Book | '')}>
            <option value="">Choose Shop or Telecom…</option>
            <option value="shop">{BOOK_LABEL.shop}</option>
            <option value="telecom">{BOOK_LABEL.telecom}</option>
          </SelectField>
          <p className="mt-1 text-xs text-slate-500">
            Shop and Telecom items must be on separate bills (split into two bills).
            {book ? ` This bill is for the ${BOOK_LABEL[book]} book.` : ' Choose the book first; then pick a category and a product for each line.'}
          </p>
          <p className="mt-1 text-xs text-slate-500">Example: 1 box × 10 pieces for Rs. 1,320 → 10 units at Rs. 132.00 each.</p>
        </div>

        {/* Product lines: category, product, then units = packs x pack size; unit cost = line total / units (preview) */}
        {book === '' ? (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Choose the business book above to add product lines.</p>
        ) : (
          <div className="space-y-3">
            {lines.map((l, i) => {
              const n = parsed[i] as ReturnType<typeof lineNumbers>;
              const n1 = i + 1;
              return (
                <div key={l.key} className="rounded-lg border border-slate-200 p-3" role="group" aria-label={`Line ${n1}`}>
                  <CategoryProductPicker
                    book={book}
                    requireCategory
                    value={l.product}
                    onChange={(p) => update(l.key, { product: p })}
                    categoryId={l.categoryId}
                    onCategoryChange={(id) => update(l.key, { categoryId: id })}
                    onCreateProduct={(ctx) => setCreating({ key: l.key, categoryId: ctx.categoryId })}
                  />
                  {fe[`items.${i}.productId`] && <p className="mt-1 text-sm text-red-600">{fe[`items.${i}.productId`]}</p>}
                  <div className="mt-3 grid grid-cols-2 items-start gap-3 sm:grid-cols-[6rem_7rem_9rem_1fr_1fr_auto]">
                    <TextField label="Packs" inputMode="numeric" className="[&_input]:text-right" value={l.packs} onChange={(e) => update(l.key, { packs: e.target.value })}
                      error={fe[`items.${i}.packs`] ?? (l.packs !== '' && !n.packsOk ? 'Whole number ≥ 1' : undefined)} autoComplete="off" />
                    <TextField label="Pack size" inputMode="numeric" className="[&_input]:text-right" value={l.packSize} onChange={(e) => update(l.key, { packSize: e.target.value })}
                      error={fe[`items.${i}.packSize`] ?? (l.packSize !== '' && !n.sizeOk ? 'Whole number ≥ 1' : undefined)} autoComplete="off" />
                    <TextField label="Line total (Rs.)" inputMode="decimal" placeholder="0.00" className="[&_input]:text-right" value={l.total} onChange={(e) => update(l.key, { total: e.target.value })}
                      error={fe[`items.${i}.lineTotalCents`] ?? (l.total !== '' && !n.totalOk ? 'Invalid amount' : undefined)} autoComplete="off" />
                    <div className="text-right text-sm">
                      <div className="mb-1 font-medium text-slate-700">Units</div>
                      <div className="num py-2">{n.units ?? '—'}</div>
                    </div>
                    <div className="text-right text-sm">
                      <div className="mb-1 font-medium text-slate-700">Unit cost</div>
                      <div className="num whitespace-nowrap py-2">{n.units !== null && n.totalOk && n.cents !== null ? formatLKR(centsPerUnit(n.cents, n.units)) : '—'}</div>
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
              <p className="font-semibold">Total paid: <Money cents={grand} /></p>
            </div>
          </div>
        )}
        <p className="text-xs text-slate-500">Unit cost is shown for information only; the server calculates the stored values.</p>
      </FormDialog>

      <ConfirmDialog
        open={pendingBook !== null}
        title="Change the business book?"
        confirmLabel="Change book and clear lines"
        danger
        onConfirm={() => { setBook(pendingBook ?? ''); setLines([newLine(nextKey.current++)]); setPendingBook(null); }}
        onClose={() => setPendingBook(null)}
      >
        <p>A purchase belongs to one book only. Changing it removes the product lines you have filled in so far.</p>
      </ConfirmDialog>

      {creating && book !== '' && (
        <ProductDialog
          defaultBook={book}
          lockBook
          defaultCategoryId={creating.categoryId ?? undefined}
          // The new (or already existing) product is selected for the line it was started from, in its own category.
          onCreated={(p) => update(creating.key, { product: p, categoryId: p.categoryId })}
          onUseExisting={(p) => update(creating.key, { product: p, categoryId: p.categoryId })}
          onClose={() => {
            setCreating(null);
            // The product dialog hands focus back to the product box, which would re-open its list on top of the
            // new selection; let the focus settle, then close that list again by leaving the box.
            setTimeout(() => { const a = document.activeElement; if (a instanceof HTMLInputElement && a.getAttribute('role') === 'combobox') a.blur(); }, 0);
          }}
        />
      )}
    </>
  );
}
