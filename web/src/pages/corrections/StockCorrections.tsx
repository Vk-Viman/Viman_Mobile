/**
 * StockCorrections: adapters for purchases and goods personal use (shared CorrectionDialog, API_CONTRACTS.md "Correction contract,
 * Phase 2"). Each replacement body is the normal create body of its type, pre-filled from the original:
 *  - purchase: POST /purchases (packs x pack size and line total per line, as on the New purchase form); the book of the bill cannot
 *    change (a purchase belongs to ONE book), so a different product must be of the same book;
 *  - goods drawing: POST /drawings with kind "goods" (product and quantity, as on Stock > Personal use); the kind never changes.
 * The server decides everything (HAS_RETURNS, INSUFFICIENT_STOCK when part of the goods was already sold, closed days...).
 */
import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useSuppliers } from '../../api/catalog';
import { MAX_NOTE } from '../../lib/amounts';
import { BOOK_LABEL } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { Product, Purchase } from '../../types/api';
import type { OwnerDrawing } from '../../types/transfers';
import { centsPerUnit, parseIntStrict } from '../purchases/helpers';
import { PickCategoryProduct } from '../stock/PickCategoryProduct';

/** Limits matching the server's validation (same as the New purchase form). */
const MAX_INT = 1_000_000;
const MAX_CENTS = 99_999_999_999;
const MAX_LINES = 100;
const MAX_BILL_NO = 40;
const MAX_NOTES = 500;
const MAX_GOODS_QTY = 1_000_000_000;

/** One editable purchase line. `picked` is set when the owner chose another product than the original line's. */
interface Line {
  key: number;
  productId: number | null;
  name: string;
  changing: boolean;
  picked: Product | null;
  packs: string;
  packSize: string;
  total: string;
}

/** Lines of a purchase record as "name: units (packs x size) for Rs.". */
function describePurchase(p: Purchase): DescribeLine[] {
  return [
    ['Date', p.businessDate],
    ['Book', BOOK_LABEL[p.book]],
    ['Supplier', p.supplierName ?? '—'],
    ['Bill no', p.billNo || '—'],
    ['Items', (
      <ul key="items" className="space-y-0.5">
        {p.items.map((i) => (
          <li key={i.id}>{i.productName}: {i.units} unit(s) ({i.packs} x {i.packSize}) for <Money cents={i.lineTotalCents} /></li>
        ))}
      </ul>
    )],
    ['Total paid', <Money key="t" cents={p.totalCents} className="font-semibold" />],
    ['Notes', p.notes || '—'],
  ];
}

/** Correct a stock purchase. */
export function PurchaseCorrection({ original, onClose }: { original: Purchase; onClose: () => void }) {
  const suppliers = useSuppliers({});
  const nextKey = useRef(original.items.length + 1);
  const [lines, setLines] = useState<Line[]>(() => original.items.map((i, n) => ({
    key: n + 1, productId: i.productId, name: i.productName, changing: false, picked: null,
    packs: String(i.packs), packSize: String(i.packSize), total: centsToRupees(i.lineTotalCents),
  })));
  const [supplierId, setSupplierId] = useState(original.supplierId === null ? '' : String(original.supplierId));
  const [billNo, setBillNo] = useState(original.billNo ?? '');
  const [notes, setNotes] = useState(original.notes ?? '');
  const [show, setShow] = useState(false);

  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const productOf = (l: Line): number | null => (l.changing ? (l.picked && l.picked.book === original.book ? l.picked.id : null) : l.productId);
  const nums = (l: Line) => {
    const packs = parseIntStrict(l.packs);
    const size = parseIntStrict(l.packSize);
    const cents = l.total.trim() === '' ? null : rupeesToCents(l.total);
    const packsOk = packs !== null && packs >= 1 && packs <= MAX_INT;
    const sizeOk = size !== null && size >= 1 && size <= MAX_INT;
    const totalOk = cents !== null && cents <= MAX_CENTS;
    return { packs, size, cents, packsOk, sizeOk, totalOk, units: packsOk && sizeOk ? (packs as number) * (size as number) : null };
  };
  const lineOk = (l: Line) => { const n = nums(l); return productOf(l) !== null && n.packsOk && n.sizeOk && n.totalOk; };
  const allOk = lines.length >= 1 && lines.every(lineOk) && billNo.length <= MAX_BILL_NO && notes.length <= MAX_NOTES;
  const grand = lines.reduce((s, l) => { const n = nums(l); return s + (n.totalOk && n.cents !== null ? n.cents : 0); }, 0);
  // The original's supplier stays selectable even if it was switched off since.
  const supplierOptions = (suppliers.data?.items ?? []).filter((s) => s.active || String(s.id) === supplierId);

  const productNames = (p: Purchase): Record<number, string> => Object.fromEntries(p.items.map((i) => [i.productId, i.productName]));

  return (
    <CorrectionDialog<Purchase> entity="purchases" noun="purchase" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describePurchase} productNames={productNames} inventory widthClass="max-w-4xl" onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (!allOk) { setShow(true); return null; }
        return {
          businessDate,
          items: lines.map((l) => { const n = nums(l); return { productId: productOf(l) as number, packs: n.packs as number, packSize: n.size as number, lineTotalCents: n.cents as number }; }),
          ...(supplierId ? { supplierId: Number(supplierId) } : {}),
          ...(billNo.trim() ? { billNo: billNo.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          clientRef,
        };
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Supplier (optional)" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">No supplier</option>
          {supplierOptions.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </SelectField>
        <TextField label="Bill no" value={billNo} maxLength={MAX_BILL_NO} onChange={(e) => setBillNo(e.target.value)} autoComplete="off" />
      </div>
      <TextField label="Notes" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />

      <section aria-label="Purchase lines" className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Corrected lines ({BOOK_LABEL[original.book]} book)</h3>
        <p className="text-xs text-slate-500">A purchase belongs to one book, so every product must be a {BOOK_LABEL[original.book]} product. Example: 1 box x 10 pieces for Rs. 1,320 = 10 units at Rs. 132.00 each.</p>
        {lines.map((l, i) => {
          const n = nums(l);
          const n1 = i + 1;
          const wrongBook = l.changing && l.picked !== null && l.picked.book !== original.book;
          return (
            <div key={l.key} className="rounded-lg border border-slate-200 p-3" role="group" aria-label={`Line ${n1}`}>
              {l.changing ? (
                <div className="space-y-3">
                  <PickCategoryProduct value={l.picked} onChange={(p) => set(l.key, { picked: p })}
                    error={wrongBook ? `Choose a ${BOOK_LABEL[original.book]} product.` : show && !l.picked ? 'Choose a product.' : undefined} />
                  {l.productId !== null && (
                    <Button variant="secondary" onClick={() => set(l.key, { changing: false, picked: null })}>Keep {l.name}</Button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>Product: <strong>{l.name}</strong></span>
                  <Button variant="secondary" onClick={() => set(l.key, { changing: true })}>Choose a different product</Button>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 items-start gap-3 sm:grid-cols-[6rem_7rem_9rem_1fr_1fr_auto]">
                <TextField label="Packs" inputMode="numeric" className="[&_input]:text-right" value={l.packs} onChange={(e) => set(l.key, { packs: e.target.value })}
                  error={show && !n.packsOk ? 'Whole number, 1 or more' : undefined} autoComplete="off" />
                <TextField label="Pack size" inputMode="numeric" className="[&_input]:text-right" value={l.packSize} onChange={(e) => set(l.key, { packSize: e.target.value })}
                  error={show && !n.sizeOk ? 'Whole number, 1 or more' : undefined} autoComplete="off" />
                <TextField label="Line total (Rs.)" inputMode="decimal" placeholder="0.00" className="[&_input]:text-right" value={l.total} onChange={(e) => set(l.key, { total: e.target.value })}
                  error={show && !n.totalOk ? 'Invalid amount' : undefined} autoComplete="off" />
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
          <Button variant="secondary" disabled={lines.length >= MAX_LINES}
            onClick={() => setLines((ls) => [...ls, { key: nextKey.current++, productId: null, name: '', changing: true, picked: null, packs: '1', packSize: '1', total: '' }])}>
            <Plus size={16} aria-hidden="true" /> Add line
          </Button>
          <p className="font-semibold">Corrected total paid: <Money cents={grand} /></p>
        </div>
      </section>
    </CorrectionDialog>
  );
}

/** Correct a goods drawing (goods taken for personal use; the replacement stays a goods drawing). */
export function GoodsDrawingCorrection({ original, onClose }: { original: OwnerDrawing; onClose: () => void }) {
  const [picked, setPicked] = useState<Product | null>(null);
  const [change, setChange] = useState(false);
  const [qty, setQty] = useState(String(original.qty ?? ''));
  const [note, setNote] = useState(original.note ?? '');
  const [show, setShow] = useState(false);
  const q = parseIntStrict(qty);
  const qtyOk = q !== null && q >= 1 && q <= MAX_GOODS_QTY;
  const productId = change ? (picked?.id ?? null) : original.productId;
  const describe = (d: OwnerDrawing): DescribeLine[] => [
    ['Date', d.businessDate], ['Product', d.productName ?? 'Goods'], ['Quantity', String(d.qty ?? '—')],
    ['Cost', <Money key="c" cents={d.amountCents} />], ['Note', d.note || '—'],
  ];
  return (
    <CorrectionDialog<OwnerDrawing> entity="owner_drawings" noun="goods drawing" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} inventory onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (!qtyOk || productId === null || note.length > MAX_NOTE) { setShow(true); return null; }
        return { kind: 'goods', businessDate, productId, qty: q, note: note.trim() || undefined, clientRef };
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
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
      <p className="text-xs text-slate-500">The goods are valued at the product's weighted-average cost when you save, so the cost can differ from the original.</p>
    </CorrectionDialog>
  );
}
