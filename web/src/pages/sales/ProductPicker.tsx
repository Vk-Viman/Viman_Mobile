/**
 * ProductPicker: the left half of the POS. A search box (name or code) and the list of matching sellable products.
 * Where: Sales > POS. API: GET /products?q=&active=true&limit= (api/catalog.ts).
 * Rules: only `kind = "stock"` products are listed (services arrive in a later phase and the server answers
 * PRODUCT_NOT_SELLABLE_YET for them); stock on hand and price are shown as read from the server.
 * Keyboard: Enter in the search box adds the first match (a barcode scanner that "types" a code and presses Enter
 * works the same way); clicking a row's name adds one unit.
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { SearchField } from '../../components/SearchField';
import { Spinner } from '../../components/Spinner';
import { BookBadge } from '../../components/StatusBadges';
import { useProducts } from '../../api/catalog';
import { useDebounced } from '../../hooks/useDebounced';
import type { Product } from '../../types/api';

/** How many matches to fetch for the picker; a cashier narrows by typing rather than paging. */
const PICKER_LIMIT = 30;

/** @param onAdd called with the chosen product (one unit is added; the cart increments an existing line). */
export function ProductPicker({ onAdd }: { onAdd: (p: Product) => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  // Enter pressed before the debounced search caught up: remember it and add once the fresh results arrive.
  const [enterPending, setEnterPending] = useState(false);
  const list = useProducts({ q: q || undefined, active: true, limit: PICKER_LIMIT });

  // The server cannot filter by kind, so services are dropped here; the server still rejects them if one slips through.
  const items = (list.data?.items ?? []).filter((p) => p.kind === 'stock');
  // "Settled" = the results on screen belong to exactly what is typed.
  const settled = text.trim() === q && !list.isFetching && list.data !== undefined;

  const add = (p: Product) => {
    onAdd(p);
    setText('');
  };

  useEffect(() => {
    if (enterPending && settled) {
      setEnterPending(false);
      const first = items[0];
      if (first) add(first);
    }
    // `add` and `items` change every render; the effect must react only to the search settling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterPending, settled]);

  return (
    <Card title="Products">
      <SearchField
        label="Find product"
        placeholder="Type a name or code, press Enter to add"
        value={text}
        onChange={setText}
        autoFocus
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (settled && items[0]) add(items[0]);
          else if (text.trim()) setEnterPending(true);
        }}
      />
      <div className="mt-3">
        {list.isPending ? (
          <div className="flex justify-center py-8"><Spinner label="Loading products" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No products found" hint="Try another name or code. Only active stock products can be sold here." />
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-2 py-2 text-left">Code</th>
                  <th scope="col" className="px-2 py-2 text-left">Name</th>
                  <th scope="col" className="px-2 py-2 text-left">Book</th>
                  <th scope="col" className="px-2 py-2 text-right">In stock</th>
                  <th scope="col" className="px-2 py-2 text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p, i) => (
                  <tr key={p.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => add(p)}>
                    <td className="px-2 py-2 text-slate-600">{p.code ?? '—'}</td>
                    <td className="px-2 py-2">
                      {/* A real button so keyboard users can add with Tab + Enter/Space, not only by mouse. */}
                      <button
                        type="button"
                        className="text-left font-medium text-brand-700 underline-offset-2 hover:underline"
                        onClick={(e) => { e.stopPropagation(); add(p); }}
                      >
                        {p.name}
                      </button>
                      {i === 0 && q && <span className="ml-2 text-xs text-slate-400">(Enter adds this)</span>}
                    </td>
                    <td className="px-2 py-2"><BookBadge book={p.book} /></td>
                    <td className="num px-2 py-2 text-right">
                      {p.qtyOnHand <= 0 ? <Badge tone="red">Out of stock</Badge> : p.qtyOnHand}
                    </td>
                    <td className="px-2 py-2 text-right"><Money cents={p.sellPriceCents} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
