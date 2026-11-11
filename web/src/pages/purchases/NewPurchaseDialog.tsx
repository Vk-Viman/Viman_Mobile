/**
 * NewPurchaseDialog: the "New purchase" form (opened from the Purchases screen): date, optional supplier, bill no,
 * notes and one or more product lines (packs x pack size, line total).
 * API: GET /health (today's date), GET /suppliers, GET /products, POST /purchases (api/purchases.ts).
 *
 * Rules reflected here (the server enforces all of them and is authoritative):
 *  - R-FD: the date cannot be in the future (picker max = today). Backdating is allowed and audited.
 *  - A purchase belongs to ONE book: Shop and Telecom items must be on separate bills, so once a product is
 *    chosen, other lines only offer products of the same book.
 *  - Money is typed in rupees and converted to integer cents; the per-unit cost shown is a preview only.
 */
import { useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { FormDialog } from '../../components/FormDialog';
import { Button } from '../../components/Button';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useProducts, useSuppliers } from '../../api/catalog';
import { useCreatePurchase } from '../../api/purchases';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { errorBanner } from '../../lib/errors';
import { useDebounced } from '../../hooks/useDebounced';
import { formatLKR } from '../../lib/format';
import { BOOK_LABEL } from '../../lib/constants';
import { rupeesToCents } from '../../lib/units';
import { centsPerUnit, parseIntStrict } from './helpers';
import type { Product, PurchaseCreate } from '../../types/api';

/** One editable purchase line. Everything is kept as typed text; `key` is a local React key, never sent to the server. */
interface Line { key: number; productId: string; packs: string; packSize: string; total: string }

/** Limits matching the server's validation. */
const MAX_INT = 1_000_000;
const MAX_CENTS = 99_999_999_999;
const MAX_LINES = 100;
const MAX_BILL_NO = 40;
const MAX_NOTES = 500;
/** How many products the picker loads at once (the filter box narrows the list further). */
const PRODUCT_PICKER_LIMIT = 200;
const newLine = (key: number): Line => ({ key, productId: '', packs: '1', packSize: '1', total: '' });

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
  // Every product seen so far, by id. A selected product must stay selectable even after the filter box
  // narrows the list so that it is no longer returned by the server.
  const known = useRef(new Map<number, Product>());

  const { today, date: effDate, setDate } = useBusinessDate();
  const [supplierId, setSupplierId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState<ApiError | Error | null>(null);

  // Debounced product filter: the box updates instantly, the server is queried once typing pauses.
  const q = useDebounced(search.trim());
  const suppliers = useSuppliers({ active: true });
  const products = useProducts({ active: true, q: q || undefined, limit: PRODUCT_PICKER_LIMIT });
  for (const p of products.data?.items ?? []) known.current.set(p.id, p);

  // Services hold no stock, so only stock items can be purchased.
  const stockProducts = useMemo(
    () => (products.data?.items ?? []).filter((p) => p.kind === 'stock'),
    [products.data],
  );

  // The bill's book is decided by the first product picked; afterwards other lines only offer that book.
  const firstChosen = lines.map((l) => (l.productId ? known.current.get(Number(l.productId)) : undefined)).find(Boolean);
  const book = firstChosen?.book;

  /** Products offered on one line: same book as the bill, plus the line's own selection even if filtered out. */
  const optionsFor = (l: Line): Product[] => {
    let list = book ? stockProducts.filter((p) => p.book === book) : stockProducts;
    const sel = l.productId ? known.current.get(Number(l.productId)) : undefined;
    if (sel && !list.some((p) => p.id === sel.id)) list = [sel, ...list];
    return list;
  };

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // ---- Validation (quick feedback only; the server re-validates) ----
  const parsed = lines.map(lineNumbers);
  const lineValid = lines.map((l, i) => {
    const n = parsed[i] as ReturnType<typeof lineNumbers>;
    return l.productId !== '' && n.packsOk && n.sizeOk && n.totalOk;
  });
  // Total paid = sum of the line totals. Integer-cent addition is exact; this is display only, the server recomputes it.
  const grand = parsed.reduce((s, n) => s + (n.totalOk && n.cents !== null ? n.cents : 0), 0);
  // R-FD: not after today. Backdating is fine. (YYYY-MM-DD strings compare correctly as text.)
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && (!today || effDate <= today);
  const canSubmit = lines.length >= 1 && lineValid.every(Boolean) && dateOk && billNo.length <= MAX_BILL_NO && notes.length <= MAX_NOTES && Boolean(today);

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
        return { productId: Number(l.productId), packs: n.packs as number, packSize: n.packSize as number, lineTotalCents: n.cents as number };
      }),
      clientRef,
    };
    if (supplierId) body.supplierId = Number(supplierId);
    if (billNo.trim()) body.billNo = billNo.trim();
    if (notes.trim()) body.notes = notes.trim();
    setErr(null);
    create.mutate(body, {
      onSuccess: () => { toast.success('Purchase saved.'); onClose(); },
      onError: (e) => setErr(e),
    });
  };

  return (
    <FormDialog
      title="New purchase"
      submitLabel="Save purchase"
      canSubmit={canSubmit}
      loading={create.isPending}
      error={banner}
      onSubmit={submit}
      onClose={onClose}
      widthClass="max-w-5xl"
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

      <div>
        <TextField label="Filter products" placeholder="Type to narrow the product lists below" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
        <p className="mt-1 text-xs text-slate-500">
          Shop and Telecom items must be on separate bills.{book ? ` This bill is for the ${BOOK_LABEL[book]} book.` : ''}
        </p>
        <p className="mt-1 text-xs text-slate-500">Example: 1 box × 10 pieces for Rs. 1,320 → 10 units at Rs. 132.00 each.</p>
      </div>

      {/* Product lines: units = packs x pack size; unit cost = line total / units (preview) */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-2 py-2 text-left">Product</th>
              <th scope="col" className="px-2 py-2 text-right">Packs</th>
              <th scope="col" className="px-2 py-2 text-right">Pack size</th>
              <th scope="col" className="px-2 py-2 text-right">Line total (Rs.)</th>
              <th scope="col" className="px-2 py-2 text-right">Units</th>
              <th scope="col" className="px-2 py-2 text-right">Unit cost</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const n = parsed[i] as ReturnType<typeof lineNumbers>;
              const n1 = i + 1;
              return (
                <tr key={l.key} className="border-b border-slate-100 align-top">
                  <td className="min-w-48 px-2 py-2">
                    <SelectField hideLabel label={`Line ${n1} product`} value={l.productId} onChange={(e) => update(l.key, { productId: e.target.value })} error={fe[`items.${i}.productId`]}>
                      <option value="">Select product…</option>
                      {optionsFor(l).map((p) => <option key={p.id} value={String(p.id)}>{p.name} ({BOOK_LABEL[p.book]})</option>)}
                    </SelectField>
                  </td>
                  <td className="w-24 px-2 py-2">
                    <TextField hideLabel label={`Line ${n1} packs`} inputMode="numeric" className="[&_input]:text-right" value={l.packs} onChange={(e) => update(l.key, { packs: e.target.value })}
                      error={fe[`items.${i}.packs`] ?? (l.packs !== '' && !n.packsOk ? 'Whole number ≥ 1' : undefined)} autoComplete="off" />
                  </td>
                  <td className="w-28 px-2 py-2">
                    <TextField hideLabel label={`Line ${n1} pack size (units per pack)`} inputMode="numeric" className="[&_input]:text-right" value={l.packSize} onChange={(e) => update(l.key, { packSize: e.target.value })}
                      error={fe[`items.${i}.packSize`] ?? (l.packSize !== '' && !n.sizeOk ? 'Whole number ≥ 1' : undefined)} autoComplete="off" />
                  </td>
                  <td className="w-36 px-2 py-2">
                    <TextField hideLabel label={`Line ${n1} total in rupees`} inputMode="decimal" placeholder="0.00" className="[&_input]:text-right" value={l.total} onChange={(e) => update(l.key, { total: e.target.value })}
                      error={fe[`items.${i}.lineTotalCents`] ?? (l.total !== '' && !n.totalOk ? 'Invalid amount' : undefined)} autoComplete="off" />
                  </td>
                  <td className="num px-2 py-4 text-right">{n.units ?? '—'}</td>
                  <td className="num whitespace-nowrap px-2 py-4 text-right">
                    {n.units !== null && n.totalOk && n.cents !== null ? formatLKR(centsPerUnit(n.cents, n.units)) : '—'}
                  </td>
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
              <td colSpan={4} className="px-2 py-3 text-right font-semibold">
                Total paid: <Money cents={grand} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-slate-500">Unit cost is shown for information only; the server calculates the stored values.</p>
    </FormDialog>
  );
}
